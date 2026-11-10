import { mkdtempSync, spawn } from './fixtures.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runtimeEnvironment } from '../src/environment.js'
import { mcpBootstrap } from '../src/bootstrap.js'
import { GeliosBridge } from '../scripts/bridge.js'
import { environments } from '../scripts/update.js'
import { runtimeSocket, stopRuntime } from '../src/runtime.js'
import { appServerFolder, snapshotRunning, slowShellEnv } from './support/app-server.js'
import { cleanup, exited, until } from './support/wait.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const options = { transcriptionKeyEnv: 'AUDIO_SLOT', marketplaceAuthEnv: 'MARKET_SLOT' }
const privateEnv = { TELEGRAM_BOT_TOKEN: `123456789:${'z'.repeat(32)}`, AUDIO_SLOT: 'fixture-audio-private', MARKET_SLOT: 'fixture-market-private' }
function assertFiltered(env) {
  for (const [name, value] of Object.entries(privateEnv)) {
    assert.equal(env[name], undefined, name)
    assert.equal(JSON.stringify(env).includes(value), false, name + ' by value')
  }
  assert.equal(env.ARBITRARY_SERVICE_SETTING, 'ordinary-setting-value')
  assert.equal(env.UNRELATED_API_KEY, 'ordinary-named-key')
}

test('runtime inheritance withholds only selected bridge credentials and their value aliases', () => {
  const source = { ...privateEnv, ARBITRARY_SERVICE_SETTING: 'ordinary-setting-value', UNRELATED_API_KEY: 'ordinary-named-key',
    GH_TOKEN: 'separate-runtime-git-key', GITHUB_TOKEN: 'another-runtime-git-key',
    BOT_ALIAS: privateEnv.TELEGRAM_BOT_TOKEN, EMBEDDED: 'prefix/' + privateEnv.AUDIO_SLOT + '/suffix',
    [privateEnv.MARKET_SLOT]: 'credential in name', ORDINARY_MULTILINE: 'first\nsecond' }
  const result = runtimeEnvironment(source, options)
  assertFiltered(result.env)
  assert.equal(result.env.GH_TOKEN, source.GH_TOKEN)
  assert.equal(result.env.GITHUB_TOKEN, source.GITHUB_TOKEN)
  assert.equal(result.env.ORDINARY_MULTILINE, 'first\nsecond')
  assert.deepEqual(new Set(result.secrets), new Set(Object.values(privateEnv)))
  assert.deepEqual(source.BOT_ALIAS, privateEnv.TELEGRAM_BOT_TOKEN, 'input is not mutated')
  const fallback = runtimeEnvironment({ ...source, GH_ALIAS: 'prefix/' + source.GH_TOKEN }, { transcriptionKeyEnv: 'AUDIO_SLOT' })
  assert.equal(fallback.env.GH_TOKEN, undefined); assert.equal(fallback.env.GITHUB_TOKEN, undefined); assert.equal(fallback.env.GH_ALIAS, undefined)
  assert.equal(fallback.env.MARKET_SLOT, privateEnv.MARKET_SLOT, 'unselected slot is ordinary')
  assert.throws(() => runtimeEnvironment({ TELEGRAM_BOT_TOKEN: 'bad\nvalue' }), /control characters/)
})

test('updater preserves arbitrary launcher settings and accepts absent deprecated runtime slots', () => {
  const source = { ...privateEnv, ARBITRARY_SERVICE_SETTING: 'ordinary-setting-value', UNRELATED_API_KEY: 'ordinary-named-key' }
  const profile = { transcriptionApiKeyEnv: 'AUDIO_SLOT', marketplaceAuthEnv: 'MARKET_SLOT', codexRuntimeEnvs: ['OLD_ABSENT_SLOT'], launcherLink: '/fixture/launcher' }
  const result = environments(profile, source, '/fixture/askpass')
  assert.equal(result.bridge.ARBITRARY_SERVICE_SETTING, source.ARBITRARY_SERVICE_SETTING)
  assertFiltered(runtimeEnvironment(result.bridge, options).env)
  assert.equal(result.authenticated.GH_TOKEN, privateEnv.MARKET_SLOT)
  assert.equal(result.validation.ARBITRARY_SERVICE_SETTING, undefined, 'candidate validation stays scoped')
})

test('real bridge passes launcher settings to native app-server, its MCP and an agent command without runtime flags', {
  skip: process.env.GELIOS_REAL_CODEX_BIN ? false : 'set GELIOS_REAL_CODEX_BIN for native inheritance coverage', timeout: 90_000,
}, async t => {
  const bin = process.env.GELIOS_REAL_CODEX_BIN
  const root = mkdtempSync(join(tmpdir(), 'gct-env-')), workspace = join(root, 'w'), home = join(root, 'h'), codexHome = join(root, 'c')
  for (const path of [workspace, home, codexHome]) mkdirSync(path)
  const paths = Object.fromEntries(['app', 'mcp', 'command'].map(name => [name, join(root, name + '.json')]))
  const command = `${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(paths.command)},JSON.stringify(process.env))`)}`
  let modelCalls = 0, toolOutput = false
  const observations = []
  const provider = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    toolOutput ||= (input.input || []).some(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type))
    let item
    const tools = [...(input.tools || []), ...(input.input || []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools || [])].flatMap(tool => tool.type === 'namespace' ? (tool.tools || []).map(value => ({ ...value, namespace: tool.name })) : [tool])
    observations.push({ path: request.url, tools: tools.map(tool => tool.name || tool.type), inputTypes: (input.input || []).map(item => item.type) })
    const tool = tools.find(tool => ['exec', 'exec_command', 'shell_command', 'shell'].includes(tool.name))
    if (tool && !existsSync(paths.command)) {
      modelCalls++
      const args = tool.name === 'exec_command' ? { cmd: command, max_output_tokens: 1000 } : tool.name === 'shell' ? { command: ['/bin/sh', '-c', command] } : { command }
      item = { id: 'fc_environment', type: tool.name === 'exec' ? 'custom_tool_call' : 'function_call', call_id: 'call_environment', name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), ...(tool.name === 'exec' ? { input: `text(await tools.exec_command(${JSON.stringify({ cmd: command, max_output_tokens: 1000 })}))` } : { arguments: JSON.stringify(args) }), status: 'completed' }
    } else item = { id: 'msg_environment', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Environment verified.', annotations: [] }] }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const event of [
      { type: 'response.created', response: { id: 'resp_environment_' + modelCalls, status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_environment_' + modelCalls, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  const api = http.createServer(async (request, response) => {
    for await (const _ of request) {}
    if (request.url.endsWith('/getUpdates')) await wait(20)
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, result: request.url.endsWith('/getUpdates') ? [] : true }))
  })
  for (const server of [provider, api]) { server.listen(0, '127.0.0.1'); await once(server, 'listening') }
  // Use the shipped entry point: a checkout-relative worker is a different
  // build from the bridge's durable selection and retires itself. Delay the
  // initialize receipt beyond that retirement interval to expose stale wiring.
  const mcp = join(root, 'mcp-probe.mjs')
  const mcpEnvironment = JSON.parse(readFileSync(new URL('../.mcp.json', import.meta.url))).mcpServers.telegram.env_vars
  writeFileSync(mcp, `import {writeFileSync} from 'node:fs';
const write=process.stdout.write.bind(process.stdout);
process.stdout.write=(chunk,...args)=>{let value;try{value=JSON.parse(String(chunk))}catch{};if(value?.result?.serverInfo?.name==='telegram'){setTimeout(()=>write(chunk,...args),250);return true}return write(chunk,...args)};
${mcpBootstrap}
writeFileSync(${JSON.stringify(paths.mcp)}, JSON.stringify(process.env));\n`)
  writeFileSync(join(codexHome, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local model fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[mcp_servers.telegram]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(mcp)}]\nenv_vars = ${JSON.stringify(mcpEnvironment)}\nrequired = true\n`)
  const shim = join(root, 'codex')
  writeFileSync(shim, `#!/bin/sh\n${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(paths.app)},JSON.stringify(process.env))`)}\nexec ${quote(bin)} "$@"\n`, { mode: 0o700 })
  const oldEnv = { ...process.env }
  Object.assign(process.env, privateEnv, { HOME: home, CODEX_HOME: codexHome, ARBITRARY_SERVICE_SETTING: 'ordinary-setting-value', UNRELATED_API_KEY: 'ordinary-named-key',
    SECRET_ALIAS: 'prefix/' + privateEnv.MARKET_SLOT, AUDIO_ALIAS: privateEnv.AUDIO_SLOT, BOT_ALIAS: privateEnv.TELEGRAM_BOT_TOKEN, GELIOS_TELEGRAM_API_BASE: `http://127.0.0.1:${api.address().port}`, GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin') })
  const bridge = new GeliosBridge({ ...options, codexRuntimeEnvs: [], stateDir: join(root, 's'), workspace, socket: join(root, 'a.sock'), controlSocket: join(root, 'b.sock'), codexBin: shim })
  const logs = []; bridge.log = value => logs.push(value)
  cleanup(t, 'the bridge and app server', async hook => {
    bridge.shuttingDown = true; bridge.heartbeat.stop(); clearTimeout(bridge.retryTimer); clearTimeout(bridge.turnRetryTimer)
    for (const pending of bridge.internal.values()) clearTimeout(pending.timer)
    await bridge.telegram?.stop()
    if (bridge.app && bridge.app.exitCode === null && bridge.app.signalCode === null) { bridge.app.kill('SIGTERM'); await Promise.race([exited(hook, bridge.app), wait(2000)]); if (bridge.app.exitCode === null && bridge.app.signalCode === null) { bridge.app.kill('SIGKILL'); await exited(hook, bridge.app) } }
    for (const server of [bridge.wsServer, bridge.controlServer, provider, api]) if (server) await new Promise(resolve => server.close(resolve))
    for (const name of Object.keys(process.env)) if (!(name in oldEnv)) delete process.env[name]
    Object.assign(process.env, oldEnv)
  }, { timeout: 30_000 })
  // The bridge starts its app-server through a runtime of its own, both with a
  // folder of their own as TMPDIR. Once the bridge has stopped, the runtime
  // stops with stopRuntime, then what is still running in the folder.
  const stateDir = bridge.options.stateDir
  const servers = appServerFolder(t, { what: 'the runtime and app server', stop: async () => { if (existsSync(runtimeSocket(stateDir))) await stopRuntime(stateDir) } })
  try {
    await servers.within(() => bridge.start())
    await bridge.rpc('initialize', { clientInfo: { name: 'environment-fixture', version: '1' }, capabilities: { experimentalApi: true } }); bridge.sendApp({ method: 'initialized' })
    const started = await bridge.rpc('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' })
    const turn = await bridge.rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Execute the environment probe.' }] })
    // A probe creates its file before it writes it, so the wait reads the content of every file the test reads.
    await until(t, () => Object.values(paths).every(path => { try { return existsSync(path) && JSON.parse(readFileSync(path, 'utf8')) } catch { return false } }) && toolOutput,
      () => 'the native environment probe: ' + JSON.stringify({ observations, found: Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, existsSync(path)])) }) + logs.join('\n'))
    for (const [name, path] of Object.entries(paths)) assertFiltered(JSON.parse(readFileSync(path, 'utf8')))
    bridge.log('ordinary-setting-value|' + privateEnv.AUDIO_SLOT)
    assert.equal(logs.at(-1), 'ordinary-setting-value|[redacted]')
    assert.ok(turn.turn.id); assert.ok(toolOutput, 'native model request includes the actual command result')
  } catch (error) {
    error.message += `\nBridge diagnostics:\n${logs.slice(-30).join('\n').slice(-12000)}`
    throw error
  }
})

// This test stays last in its file: with the folder's stop taken out of the
// app-server teardown, its snapshot still runs when the file-level hook looks,
// and the hook fails the file naming it.
test('real bridge: a shell snapshot that outlives the test is stopped by the teardown after the bridge and its runtime', {
  skip: process.env.GELIOS_REAL_CODEX_BIN ? false : 'set GELIOS_REAL_CODEX_BIN for native inheritance coverage', timeout: 30_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'gct-snap-')), workspace = join(root, 'w'), codexHome = join(root, 'c'), stateDir = join(root, 's')
  for (const path of [workspace, codexHome]) mkdirSync(path)
  // Only the model endpoint is a fixture; the snapshot is the one real Codex takes for a new thread.
  const provider = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"data":[],"models":[]}')
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  writeFileSync(join(codexHome, 'config.toml'), `model = "gpt-5.5"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local model fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`)
  const bridge = new GeliosBridge({ stateDir, workspace, socket: join(root, 'a.sock'), controlSocket: join(root, 'b.sock'), codexBin: process.env.GELIOS_REAL_CODEX_BIN, terminalName: 'Operator' })
  const logs = []; bridge.log = value => logs.push(value)
  // The bridge stops first, then its runtime with stopRuntime, then what is still running in the folder.
  const servers = appServerFolder(t, { what: 'the bridge, runtime and app server', stop: async () => {
    await bridge.shutdown(0)
    if (existsSync(runtimeSocket(stateDir))) await stopRuntime(stateDir)
  } })
  // The bridge starts its runtime and app-server from this process's environment, here with a HOME whose shell startup files sleep.
  const oldEnv = { ...process.env }, slow = slowShellEnv(root, { ...process.env, CODEX_HOME: codexHome })
  const replace = env => { for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name]; Object.assign(process.env, env) }
  cleanup(t, 'the model endpoint and environment', async () => {
    replace(oldEnv); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
  }, { timeout: 30_000 })
  replace(slow)
  try {
    await servers.within(() => bridge.start())
    await bridge.rpc('initialize', { clientInfo: { name: 'snapshot-fixture', version: '1' }, capabilities: { experimentalApi: true } }); bridge.sendApp({ method: 'initialized' })
    await bridge.rpc('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' })
    // The snapshot sleeps in its startup file: it runs in a session of its own, outside the runtime's process group.
    await until(t, () => snapshotRunning(servers.folder, bridge.app.pid), 'a shell snapshot running its startup file outside the runtime\'s process group')
  } catch (error) {
    error.message += `\nBridge diagnostics:\n${logs.slice(-30).join('\n').slice(-12000)}`
    throw error
  }
})
