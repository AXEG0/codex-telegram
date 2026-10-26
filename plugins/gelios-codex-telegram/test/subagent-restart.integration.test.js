import { mkdtempSync, spawn } from './fixtures.js'
import assert from 'node:assert/strict'

import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { GeliosBridge } from '../scripts/bridge.js'
import { IdleRestart } from '../src/restart.js'

const codexBin = process.env.GELIOS_REAL_CODEX_BIN
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(predicate, label) {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await wait(20)
  }
}
function stream(response, items, { end = true } = {}) {
  const id = `resp_${Math.random().toString(16).slice(2)}`
  if (!response.headersSent) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id, status: 'in_progress', output: [] } })}\n\n`)
  }
  if (!end) return
  items.forEach((item, index) => response.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: index, item })}\n\n`))
  response.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output: items, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`)
  response.end()
}
const reply = text => ({ id: `msg_${text.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })

test('real app-server: an idle restart waits for a running subagent turn under the bound conversation, then runs', {
  skip: codexBin ? false : 'set GELIOS_REAL_CODEX_BIN to run the real Codex integration test', timeout: 90_000,
}, async t => {
  // Only the model endpoint is a fixture. The bound conversation's turn calls the native spawn_agent tool, so
  // Codex spawns a real subagent thread; that subagent's model answer is held until the test releases it.
  let subagentResponse = null
  const provider = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    const { input = [], tools = [] } = JSON.parse(body)
    if (input.some(item => item.type === 'function_call_output')) return stream(response, [reply('Subagent started.')])
    if (JSON.stringify(input).includes('SUBAGENT-TASK')) { subagentResponse = response; return stream(response, [], { end: false }) }
    // Releases that defer the multi-agent tools behind tool search still run a call in their namespace.
    const direct = tools.some(tool => tool.name === 'spawn_agent')
    stream(response, [{ type: 'function_call', id: 'fc_spawn', call_id: 'call_spawn', name: 'spawn_agent',
      ...(direct ? {} : { namespace: 'multi_agent_v1' }), arguments: JSON.stringify({ message: 'SUBAGENT-TASK: keep working' }), status: 'completed' }])
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  t.after(() => { provider.closeAllConnections(); return new Promise(resolve => provider.close(resolve)) })
  const root = mkdtempSync(join(tmpdir(), 'codex-telegram-real-subagent-restart-'))
  const workspace = join(root, 'workspace'), codexHome = join(root, 'codex-home'), stateDir = join(root, 'state')
  mkdirSync(workspace); mkdirSync(codexHome); mkdirSync(stateDir, { mode: 0o700 })
  // A model Codex knows, so its turns carry the native tools; the fixture provider serves any name.
  writeFileSync(join(codexHome, 'config.toml'), `model = "gpt-5.5"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local integration fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`)
  const app = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
    cwd: workspace, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  app.stderr.setEncoding('utf8'); app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
  t.after(async () => {
    if (app.exitCode !== null || app.signalCode !== null) return
    app.kill('SIGTERM'); await Promise.race([once(app, 'exit'), wait(2000)])
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
  })
  await once(app, 'spawn')
  const bridge = new GeliosBridge({ stateDir, workspace, systemdUnit: 'operator-test.service' })
  bridge.app = app; bridge.appReady = true; bridge.log = () => {}
  // Only the service manager is a fixture: it reports the unit as this bridge and records the restart job.
  const systemctl = [], unit = { MainPID: String(process.pid), ActiveState: 'active', LoadState: 'loaded', CanStart: 'yes', CanStop: 'yes', Job: '0', Result: 'success' }
  bridge.restart = new IdleRestart(bridge, { run: async args => {
    systemctl.push(args)
    if (args.includes('restart')) { unit.Job = '1'; return { code: 0, output: '' } }
    return { code: 0, output: Object.entries(unit).map(([name, value]) => `${name}=${value}`).join('\n') }
  } })
  const restarts = () => systemctl.filter(args => args.includes('restart'))
  // The test reads the app-server's own turn notifications, independently of the bridge's bookkeeping.
  const started = new Map(), completed = new Map()
  readline.createInterface({ input: app.stdout }).on('line', line => {
    const message = JSON.parse(line)
    if (message.method === 'turn/started') started.set(message.params.turn.id, message.params.threadId)
    if (message.method === 'turn/completed') completed.set(message.params.turn.id, message.params.threadId)
    bridge.onAppLine(line)
  })
  try {
    await bridge.rpc('initialize', { clientInfo: { name: 'codex-telegram-subagent-restart-integration', version: '0' }, capabilities: { experimentalApi: true } })
    bridge.sendApp({ method: 'initialized' })
    const bound = (await bridge.rpc('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread.id
    bridge.bindThread(bound)
    await bridge.rpc('turn/start', { threadId: bound, input: [{ type: 'text', text: 'Start a subagent for the long task.' }] })
    const subagentTurn = () => [...started].find(([turn, thread]) => thread !== bound && !completed.has(turn))
    await waitFor(() => [...completed.values()].includes(bound) && subagentTurn() && subagentResponse, 'the bound turn to complete while its subagent turn runs')
    const subagent = subagentTurn()[1]
    const { thread } = await bridge.rpc('thread/read', { threadId: subagent })
    assert.equal(thread.source.subAgent.thread_spawn.parent_thread_id, bound)
    assert.equal(bridge.activeTurnId, null)

    const request = await bridge.restart.request({ timeoutMs: 60_000 })
    for (let tick = 0; tick < 5; tick++) { await bridge.restart.tick(); await wait(50) }
    assert.deepEqual(restarts(), [], 'the restart waits while the subagent turn runs')
    const waiting = await bridge.handleControl('{"action":"status"}')
    assert.deepEqual(waiting.idle.blockers, ['runningThreads'])
    assert.deepEqual(waiting.idle.runningThreadIds, [subagent])
    assert.equal(waiting.restart.phase, 'pending')

    stream(subagentResponse, [reply('Subagent finished.')])
    await waitFor(() => [...completed.values()].includes(subagent), 'the subagent turn to complete')
    await bridge.restart.tick()
    assert.equal(restarts().length, 1, 'the restart runs once the subagent turn completes')
    assert.deepEqual([bridge.restart.status().id, bridge.restart.status().phase, bridge.updatePrepared], [request.id, 'handoff', true])
  } catch (error) {
    if (stderr.trim()) error.message += `\napp-server stderr:\n${stderr.trim()}`
    throw error
  } finally { bridge.restart.releaseUpdate?.() }
})
