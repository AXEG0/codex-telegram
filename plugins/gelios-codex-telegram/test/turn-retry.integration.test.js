import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { GeliosBridge } from '../scripts/bridge.js'

const codexBin = process.env.GELIOS_REAL_CODEX_BIN
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(predicate, label) {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await wait(20)
  }
}

// Only the model endpoint is a fixture: it answers "at capacity" the way the Responses API does
// (503, error code server_is_overloaded) for the first `overloaded` requests, then replies.
async function realCodex(t, overloaded) {
  let requests = 0
  const provider = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    requests += 1
    if (requests <= overloaded) {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'server_is_overloaded', message: 'Selected model is at capacity. Please try a different model.' } }))
      return
    }
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Fixture reply.', annotations: [] }] }
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
  t.after(() => new Promise(resolve => provider.close(resolve)))
  const root = mkdtempSync(join(tmpdir(), 'gelios-real-turn-retry-'))
  const workspace = join(root, 'workspace'), codexHome = join(root, 'codex-home')
  mkdirSync(workspace); mkdirSync(codexHome)
  // Codex's own request and stream retries are off, so each overloaded answer fails its turn at once.
  writeFileSync(join(codexHome, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local integration fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`)
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
  const bridge = new GeliosBridge({ stateDir: join(root, 'state'), workspace })
  bridge.app = app; bridge.appReady = true; bridge.log = () => {}
  const telegram = []
  bridge.telegram = {
    acknowledge: async (chatId, messageId, state) => { telegram.push(['acknowledge', chatId, messageId, state]) },
    reply: async (request, options) => { telegram.push(['reply', request.chat_id, request.text, options?.source]) },
    startTyping() {}, stopTyping() {},
  }
  const turns = new Map()
  readline.createInterface({ input: app.stdout }).on('line', line => {
    const message = JSON.parse(line)
    if (message.method === 'turn/completed') turns.set(message.params.turn.id, message.params.turn)
    bridge.onAppLine(line)
  })
  await bridge.rpc('initialize', { clientInfo: { name: 'gelios-turn-retry-integration', version: '0' }, capabilities: { experimentalApi: true } })
  bridge.sendApp({ method: 'initialized' })
  const started = await bridge.rpc('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' })
  bridge.bindThread(started.thread.id)
  const send = async id => {
    const event = { eventId: `telegram-123-${id}`, chatId: '123', messageId: String(id), userId: '123', name: 'Jake',
      role: 'admin', timestamp: Date.now(), input: [{ type: 'text', text: `message ${id}` }] }
    await bridge.acceptTelegram(event, async () => event)
  }
  return { bridge, telegram, turns, send, threadId: started.thread.id, stderr: () => stderr }
}
const withStderr = async (codex, body) => {
  try { await body() } catch (error) {
    if (codex?.stderr().trim()) error.message += `\napp-server stderr:\n${codex.stderr().trim()}`
    throw error
  }
}

test('real app-server: an overloaded turn is continued by the bridge and answered, with nothing reported', {
  skip: codexBin ? false : 'set GELIOS_REAL_CODEX_BIN to run the real Codex integration test', timeout: 60_000,
}, async t => {
  const codex = await realCodex(t, 1)
  await withStderr(codex, async () => {
    const { bridge, telegram, turns, threadId } = codex
    bridge.turnRetryWaits = [10]
    await codex.send(15)
    const first = bridge.store.loadRuntime().events['telegram-123-15']
    await waitFor(() => turns.has(first.turnId), 'the first turn to end')
    assert.equal(turns.get(first.turnId).status, 'failed')
    assert.equal(turns.get(first.turnId).error.codexErrorInfo, 'serverOverloaded')
    await waitFor(() => [...turns.values()].some(turn => turn.status === 'completed'), 'the retry turn to complete')
    await waitFor(() => bridge.turnRetry === null, 'the retry to settle')
    const thread = (await bridge.rpc('thread/read', { threadId, includeTurns: true })).thread
    assert.equal(thread.turns.length, 2)
    assert.match(thread.turns[1].items.find(item => item.type === 'userMessage').content[0].text, /Continue the work from where it stopped/)
    assert.ok(thread.turns[1].items.some(item => item.type === 'agentMessage' && item.text === 'Fixture reply.'))
    assert.deepEqual(telegram.filter(call => call[0] === 'reply' || call[2] === '15' && call[3] === 'failed'), [])
  })
})

test('real app-server: a turn still overloaded after every wait is reported once', {
  skip: codexBin ? false : 'set GELIOS_REAL_CODEX_BIN to run the real Codex integration test', timeout: 60_000,
}, async t => {
  const codex = await realCodex(t, 100)
  await withStderr(codex, async () => {
    const { bridge, telegram, turns } = codex
    bridge.turnRetryWaits = [10, 10]
    await codex.send(16)
    await waitFor(() => telegram.some(call => call[0] === 'reply'), 'the failure report')
    assert.equal(turns.size, 3)
    assert.ok([...turns.values()].every(turn => turn.status === 'failed' && turn.error.codexErrorInfo === 'serverOverloaded'))
    assert.deepEqual(telegram.filter(call => call[0] === 'acknowledge' && call[3] === 'failed'), [])
    const replies = telegram.filter(call => call[0] === 'reply')
    assert.equal(replies.length, 1)
    assert.match(replies[0][2], /failed again after 2 retries.*\(serverOverloaded\)/s)
    assert.equal(replies[0][3], 'Bridge')
  })
})
