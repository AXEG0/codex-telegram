import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { GeliosBridge } from '../scripts/bridge.js'
import { mkdtempSync } from './fixtures.js'

const run = promisify(execFile), codexBin = process.env.GELIOS_REAL_CODEX_BIN
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, detail) {
  const deadline = Date.now() + 20_000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`MCP cache replacement timed out: ${detail()}`)
    await wait(20)
  }
}

async function replacement(t, mode, legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'gct-mcp-')), workspace = join(root, 'w'), home = join(root, 'h')
  const codexHome = join(root, 'c'), stateDir = join(root, 's'), tools = join(root, 'tools')
  for (const path of [workspace, home, codexHome, tools]) mkdirSync(path)
  const arm = join(root, 'replace.json'), receipt = join(root, 'replaced.json'), requests = []
  const provider = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    if (body) requests.push(JSON.parse(body))
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Cache replacement verified.', annotations: [] }] }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const event of [
      { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const original = { ...process.env }
  let bridge = null
  t.after(async () => {
    try { if (bridge) await bridge.shutdown(0) }
    finally {
      await new Promise(resolve => provider.close(resolve))
      for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
      Object.assign(process.env, original)
    }
  })
  Object.assign(process.env, { HOME: home, CODEX_HOME: codexHome, GELIOS_TELEGRAM_STATE_DIR: stateDir,
    GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin'), PATH: `${tools}:${original.PATH}` })
  delete process.env.GELIOS_TELEGRAM_MCP_ROOT
  delete process.env.GELIOS_TELEGRAM_CONTROL_SOCKET
  writeFileSync(join(codexHome, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local model fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`)
  // Only the node executable lookup is interposed. The shipped manifest, MCP,
  // bridge and native Codex app-server remain real. Replacement happens after
  // Codex selected the server/cwd but before Node loads the entry point.
  writeFileSync(join(tools, 'node'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), arm = ${JSON.stringify(arm)};
if (fs.existsSync(arm) && (args.includes('-e') || args[0]?.endsWith('/mcp.js') || args[0] === './scripts/mcp.js')) {
  const plan = JSON.parse(fs.readFileSync(arm)); fs.unlinkSync(arm);
  const cwd = process.cwd(), previousInode = fs.statSync(plan.cache).ino;
  const previousVersion = path.basename(plan.cache), parts = previousVersion.split('.').map(Number);
  const nextVersion = plan.mode === 'new-version' ? parts.slice(0, 2).concat(parts[2] + 1).join('.') : previousVersion;
  const next = path.join(path.dirname(plan.cache), nextVersion);
  if (plan.mode === 'new-version') {
    fs.cpSync(plan.cache, next, { recursive: true });
    for (const name of ['.codex-plugin/plugin.json', 'package.json']) { const file = path.join(next, name), value = JSON.parse(fs.readFileSync(file)); value.version = nextVersion; fs.writeFileSync(file, JSON.stringify(value)); }
    fs.rmSync(plan.cache, { recursive: true });
  }
  else { const displaced = plan.cache + '-displaced'; fs.renameSync(plan.cache, displaced); fs.cpSync(displaced, plan.cache, { recursive: true }); fs.rmSync(displaced, { recursive: true }); }
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ cwd, command: process.execPath, args, root: process.env.GELIOS_TELEGRAM_MCP_ROOT,
    cache: plan.cache, next, previousVersion, nextVersion, previousInode, nextInode: fs.statSync(next).ino, oldRemoved: !fs.existsSync(plan.cache), displacedRemoved: !fs.existsSync(plan.cache + '-displaced') }));
}
const result = require('node:child_process').spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) throw result.error; process.exit(result.status ?? 1);
`, { mode: 0o700 })
  const native = async args => {
    const result = await run(codexBin, [...args, '--json'], { env: process.env, timeout: 60_000 })
    return JSON.parse(result.stdout)
  }
  await native(['plugin', 'marketplace', 'add', repository])
  const installed = await native(['plugin', 'add', 'telegram@codex-telegram'])
  const cache = installed.installedPath
  assert.ok(cache?.startsWith(join(codexHome, 'plugins/cache/')))
  const initialize = { clientInfo: { name: 'cache-replacement-fixture', version: '1' }, capabilities: { experimentalApi: true } }
  const options = { stateDir, workspace, socket: join(root, 'a.sock'), controlSocket: join(root, 'b.sock'), codexBin, terminalName: 'Operator' }
  const logs = [], calls = [], completed = new Map()
  const start = async () => {
    bridge = new GeliosBridge(options); bridge.log = value => logs.push(value)
    const onLine = bridge.onAppLine.bind(bridge)
    bridge.onAppLine = line => {
      const message = JSON.parse(line)
      if (message.method === 'turn/completed') completed.set(message.params.turn.id, message.params.turn.status)
      onLine(line)
    }
    const rpc = bridge.rpc.bind(bridge)
    bridge.rpc = (method, params, timeout) => { calls.push(method); return rpc(method, params, timeout) }
    await bridge.start()
    return bridge
  }
  await start()
  await bridge.rpc('initialize', initialize); bridge.sendApp({ method: 'initialized' }); bridge.appReady = true
  const started = await bridge.rpc('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' })
  const threadId = started.thread.id
  bridge.bindThread(threadId); bridge.persistBinding({ initialize })
  const first = await bridge.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Preserve this conversation.' }] })
  await until(() => completed.has(first.turn.id), () => logs.join('\n'))
  assert.equal(completed.get(first.turn.id), 'completed')
  await bridge.shutdown(0); bridge = null
  if (legacy) {
    const path = join(cache, '.mcp.json'), manifest = JSON.parse(readFileSync(path))
    Object.assign(manifest.mcpServers.telegram, { args: ['./scripts/mcp.js'], cwd: '.' })
    writeFileSync(path, JSON.stringify(manifest))
  }
  writeFileSync(arm, JSON.stringify({ cache, mode }))
  logs.length = 0; calls.length = 0
  await start()
  await until(() => !bridge.restoring, () => logs.join('\n'))
  assert.ok(existsSync(receipt), 'the cache replacement must actually run')
  const proof = JSON.parse(readFileSync(receipt))
  assert.equal(proof.displacedRemoved, true)
  if (mode === 'new-version') { assert.equal(proof.oldRemoved, true); assert.notEqual(proof.previousVersion, proof.nextVersion) }
  else { assert.equal(proof.oldRemoved, false); assert.notEqual(proof.previousInode, proof.nextInode); assert.equal(proof.previousVersion, proof.nextVersion) }
  assert.equal(calls.filter(method => method === 'thread/resume').length, 1, 'no resume retry masks startup failure')
  if (legacy) {
    assert.match(logs.join('\n'), /required MCP servers failed to initialize/)
    assert.equal(await bridge.isThreadLoaded(threadId), false)
    t.diagnostic(JSON.stringify({ mode, legacyFailureObserved: true, cwd: proof.cwd }))
    return
  }
  assert.doesNotMatch(logs.join('\n'), /could not restore|required MCP servers failed/)
  assert.ok(logs.some(line => line.includes('restored Telegram routing')))
  assert.equal(proof.cwd, '/')
  assert.ok(proof.root.startsWith(join(stateDir, 'runtime-builds/')))
  assert.ok(!proof.command.startsWith(codexHome))
  assert.equal(bridge.currentThreadId, threadId)
  const before = requests.length
  const after = await bridge.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Continue after replacement.' }] })
  await until(() => completed.has(after.turn.id), () => logs.join('\n'))
  assert.equal(completed.get(after.turn.id), 'completed')
  assert.ok(requests.length > before)
  assert.match(JSON.stringify(requests.at(-1)), /telegram_reply/)
  assert.match(JSON.stringify(requests.at(-1)), /# Telegram collaboration/)
  t.diagnostic(JSON.stringify({ mode, requiredMcpInitialized: true, conversationResumed: true, durableRoot: true, resumeAttempts: 1 }))
}

for (const mode of ['new-version', 'same-version']) {
  test(`native conversation resumes while ${mode} replacement removes the MCP cache tree`, {
    skip: codexBin ? false : 'set GELIOS_REAL_CODEX_BIN for native cache replacement coverage', timeout: 90_000,
  }, t => replacement(t, mode))
  test(`the previous cache-relative entry point fails under the same ${mode} replacement`, {
    skip: codexBin ? false : 'set GELIOS_REAL_CODEX_BIN for native cache replacement coverage', timeout: 90_000,
  }, t => replacement(t, mode, true))
}
