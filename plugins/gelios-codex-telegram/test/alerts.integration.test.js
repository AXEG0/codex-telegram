import { mkdtempSync, spawn } from './fixtures.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { TelegramChannel } from '../src/telegram.js'
import { TEXTS } from '../src/alerts.js'
import { GeliosBridge } from '../scripts/bridge.js'

// Typing and alerts against a real Codex app-server. Only the model endpoint and the Bot API are fixtures; turns, tools,
// the waiting state, interrupts and shell commands are the host's own.
const codexBin = process.env.GELIOS_REAL_CODEX_BIN
const skip = codexBin ? false : 'set GELIOS_REAL_CODEX_BIN to run the real Codex integration test'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(predicate, label, ms = 30_000) {
  const deadline = Date.now() + ms
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`); await wait(20) }
}
function stream(response, items, { end = true } = {}) {
  const id = `resp_${Math.random().toString(16).slice(2)}`
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id, status: 'in_progress', output: [] } })}\n\n`)
  if (!end) return
  items.forEach((item, index) => response.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: index, item })}\n\n`))
  response.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output: items, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`)
  response.end()
}
const reply = text => ({ id: `msg_${text.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })
const call = (name, args) => ({ type: 'function_call', id: `fc_${name}`, call_id: `call_${name}`, name, arguments: JSON.stringify(args), status: 'completed' })
function step(input) {
  const last = input.map(item => item.type === 'message' && item.role === 'user').lastIndexOf(true)
  return { text: JSON.stringify(input[last]?.content || ''), outputs: input.slice(last + 1).filter(item => item.type === 'function_call_output').length }
}
const OWNER = '123', ANN = '456', GROUP = '-1001234567890'
async function realHost(t, respond, { features = '', config = {} } = {}) {
  const provider = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    respond(step(JSON.parse(body).input || []), response)
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  t.after(() => { provider.closeAllConnections(); return new Promise(resolve => provider.close(resolve)) })
  const root = mkdtempSync(join(tmpdir(), 'codex-telegram-real-alerts-'))
  const workspace = join(root, 'workspace'), codexHome = join(root, 'codex-home'), stateDir = join(root, 'state')
  mkdirSync(workspace); mkdirSync(codexHome); mkdirSync(stateDir, { mode: 0o700 })
  writeFileSync(join(codexHome, 'config.toml'), `model = "gpt-5.5"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local integration fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n${features}`)
  const app = spawn(codexBin, ['app-server', '--listen', 'stdio://'], { cwd: workspace, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] })
  const host = { stderr: '', notifications: [], requests: [], responses: new Map() }
  app.stderr.setEncoding('utf8'); app.stderr.on('data', chunk => { host.stderr = (host.stderr + chunk).slice(-8192) })
  t.after(async () => {
    if (app.exitCode !== null || app.signalCode !== null) return
    app.kill('SIGTERM'); await Promise.race([once(app, 'exit'), wait(2000)])
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
  })
  await once(app, 'spawn')
  const bridge = new GeliosBridge({ stateDir, workspace, socket: join(root, 'app.sock'), controlSocket: join(root, 'control.sock'), terminalName: 'Operator' })
  bridge.store.saveAccess({ version: 2, dmPolicy: 'allowlist', pending: {}, mentionPatterns: [], groups: { [GROUP]: { requireMention: false, allowFrom: [] } },
    users: { [OWNER]: { chatId: OWNER, alias: 'Owner', role: 'admin' }, [ANN]: { chatId: ANN, alias: 'Ann', role: 'contributor' } } })
  writeFileSync(bridge.store.configPath, JSON.stringify({ alertChat: OWNER, ...config }))
  bridge.app = app; bridge.appReady = true; bridge.log = () => {}
  // A real channel over a fake Bot API: typing routes, notices and their journal are the bridge's own.
  const calls = []
  const channel = new TelegramChannel({ store: bridge.store, token: `4321:${'d'.repeat(32)}`, workspaceRoot: workspace, onInbound: async () => {}, log: () => {} })
  channel.typingIntervalMs = 3_600_000; channel.batcher.gap = () => 0; channel.polling = true
  channel.api.call = async (method, params) => { calls.push({ method, params }); return { message_id: 900 + calls.length, chat: { id: Number(params.chat_id) } } }
  bridge.telegram = channel; bridge.telegramConfigured = true
  t.after(async () => { bridge.monitor.stop(); await channel.stop() })
  readline.createInterface({ input: app.stdout }).on('line', line => {
    const message = JSON.parse(line)
    if (message.method && message.id !== undefined) host.requests.push(message)
    else if (message.method) host.notifications.push(message)
    bridge.onAppLine(line)
  })
  await bridge.rpc('initialize', { clientInfo: { name: 'codex-telegram-alerts-integration', version: '0' }, capabilities: { experimentalApi: true } })
  bridge.sendApp({ method: 'initialized' })
  const threadId = (await bridge.rpc('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread.id
  bridge.bindThread(threadId)
  host.ended = turnId => host.notifications.some(message => message.method === 'turn/completed' && message.params.turn.id === turnId)
  const notices = () => calls.filter(item => item.method === 'sendMessage').map(item => [item.params.chat_id, item.params.text])
  const typing = () => [...channel.typing.keys()].sort()
  // The monitor's own ticks, faster than its four seconds, on the real clock.
  const ticker = setInterval(() => bridge.monitor.tick(), 50); t.after(() => clearInterval(ticker))
  return { bridge, host, threadId, channel, calls, notices, typing }
}
const fail = error => { throw error }
const withStderr = host => error => { if (host.stderr.trim()) error.message += `\napp-server stderr:\n${host.stderr.trim()}`; throw error }

test('real app-server: terminal and Telegram turns type into their eligible chats, and a long command gets the no-activity notice without being ended', { skip, timeout: 90_000 }, async t => {
  const held = []
  const { bridge, host, threadId, channel, notices, typing } = await realHost(t, ({ text, outputs }, response) => {
    if (text.includes('TERMINAL-TURN') && outputs === 0) return held.push(response)
    if (text.includes('LONG-TURN') && outputs === 0) return stream(response, [call('exec_command', { cmd: 'sleep 3', yield_time_ms: 10_000 })])
    stream(response, [reply('Done.')])
  }, { config: { stuckMinutes: 0.025, idleMinutes: 600 } })
  try {
    await channel.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: Number(ANN), type: 'private' }, from: { id: Number(ANN), first_name: 'Ann' }, text: 'hi' } })
    for (const id of Object.keys(bridge.store.loadRuntime().events)) bridge.store.markEvent(id, 'delivered', { payload: null })
    channel.stopTyping()
    // A terminal turn types into the last admitted private chat while the host runs it, and stops at its end.
    const peer = { closed: false, sent: [], sendText(text) { this.sent.push(JSON.parse(text)) }, close() { this.closed = true } }
    bridge.attachTui(peer); peer.bootstrapped = true
    bridge.onTuiText(JSON.stringify({ id: 'terminal-1', method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'TERMINAL-TURN' }] } }), peer)
    await waitFor(() => held.length && bridge.activity.turn, 'the terminal turn to run')
    await waitFor(() => typing().length, 'typing for the terminal turn')
    assert.deepEqual(typing(), [`${ANN}:`])
    stream(held[0], [reply('Done.')])
    await waitFor(() => !bridge.activity.turn && host.notifications.some(message => message.method === 'turn/completed'), 'the terminal turn to end')
    assert.deepEqual(typing(), [])
    peer.closed = true; peer.onClose()
    // A Telegram turn from a group topic types only in that topic, and a long command with no activity gets the notice.
    const event = { eventId: 'telegram-g-1', source: 'Telegram', prepared: true, chatId: GROUP, threadId: '5', messageId: '1', userId: '700', name: 'M', role: 'contributor', clientId: 'telegram-g-1',
      timestamp: Date.now(), text: 'LONG-TURN', input: [{ type: 'text', text: 'LONG-TURN' }] }
    channel.startTyping(GROUP, '5')
    await bridge.acceptTelegram(event, async () => event)
    const turnId = bridge.store.loadRuntime().events[event.eventId].turnId
    await waitFor(() => notices().length === 1, 'the no-activity notice during the long command', 20_000)
    assert.deepEqual(notices()[0], [GROUP, TEXTS.stuck(1500)])
    assert.equal(bridge.activity.turn?.id, turnId, 'silence never ends the turn')
    assert.equal(host.ended(turnId), false)
    await waitFor(() => notices().length === 2, 'the recovery once the command reports its end', 20_000)
    assert.deepEqual(notices()[1], [GROUP, TEXTS.stuckRecovered])
    await waitFor(() => host.ended(turnId) && !bridge.activity.turn, 'the long turn to complete')
    assert.deepEqual(typing(), [])
    assert.ok(notices().every(([chat]) => chat === GROUP), 'no notice for the group turn went to a private chat')
    assert.equal(bridge.store.loadRuntime().events[event.eventId].topicId, '5')
  } catch (error) { withStderr(host)(error) }
})

test('real app-server: the waiting state pauses typing and the clock; an interrupt and a shell command are not recovery, a turn with an answer is', { skip, timeout: 90_000 }, async t => {
  let failing = true
  const { bridge, host, threadId, channel, notices } = await realHost(t, ({ text, outputs }, response) => {
    if (text.includes('ASK-TURN') && outputs === 0) return stream(response, [{ type: 'function_call', id: 'fc_ask', call_id: 'call_ask', name: 'request_user_input',
      arguments: JSON.stringify({ questions: [{ id: 'choice', header: 'Pick', question: 'Which one?', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] }), status: 'completed' }])
    if (text.includes('FAIL-TURN') && failing) { response.writeHead(400, { 'Content-Type': 'application/json' }); return response.end(JSON.stringify({ error: { message: 'fixture refuses this request', type: 'invalid_request_error' } })) }
    if (text.includes('HOLD-TURN')) return stream(response, [], { end: false })
    stream(response, [reply('Thanks.')])
  }, { features: '[features]\ndefault_mode_request_user_input = true\n', config: { stuckMinutes: 0.02, idleMinutes: 600 } })
  try {
    // Waiting on the user's answer pauses typing and the stuck clock.
    channel.startTyping(ANN)
    const asked = await bridge.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'ASK-TURN' }] })
    await waitFor(() => bridge.activity.waiting, 'the waiting state')
    await wait(2500)
    assert.equal(channel.typingPaused, true)
    assert.deepEqual(notices(), [], 'no notice while Codex waits on the user')
    const request = host.requests.find(candidate => candidate.method === 'item/tool/requestUserInput')
    bridge.sendApp({ id: request.id, result: { answers: { choice: { answers: ['A'] } } } })
    await waitFor(() => host.ended(asked.turn.id) && !bridge.activity.turn, 'the answered turn to complete')
    assert.equal(channel.typingPaused, false)
    // A lasting failure tells the chat whose message started the turn.
    const event = { eventId: 'telegram-456-2', source: 'Telegram', prepared: true, chatId: ANN, messageId: '2', userId: ANN, name: 'Ann', role: 'contributor', clientId: 'telegram-456-2',
      timestamp: Date.now(), text: 'FAIL-TURN', input: [{ type: 'text', text: 'FAIL-TURN' }] }
    await bridge.acceptTelegram(event, async () => event)
    const failed = bridge.store.loadRuntime().events[event.eventId].turnId
    await waitFor(() => host.ended(failed) && notices().length === 1, 'the failure notice')
    assert.equal(notices()[0][0], ANN)
    assert.match(notices()[0][1], /^The Codex turn failed: .*\n\nYour message got no answer\. Send it again\. You will get a message here/s)
    failing = false
    // An interrupted turn and a shell command run as a turn complete no model answer: the run stays open.
    const holding = await bridge.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'HOLD-TURN' }] })
    await waitFor(() => bridge.activity.turn?.id === holding.turn.id, 'the held turn')
    await bridge.rpc('turn/interrupt', { threadId, turnId: holding.turn.id })
    await waitFor(() => host.ended(holding.turn.id), 'the interrupt')
    const turnsBefore = host.notifications.filter(message => message.method === 'turn/completed').length
    await bridge.rpc('thread/shellCommand', { threadId, command: 'true' })
    await waitFor(() => host.notifications.filter(message => message.method === 'turn/completed').length > turnsBefore, 'the shell command turn')
    const shell = host.notifications.filter(message => message.method === 'turn/completed').at(-1).params.turn
    assert.equal(shell.status, 'completed')
    await wait(300)
    assert.equal(bridge.activity.lastTurn.answered, false)
    assert.ok(notices().every(([, text]) => text !== TEXTS.failureRecovered), 'neither the interrupt nor the shell command is recovery')
    assert.notEqual(bridge.monitor.state.streak, null)
    // A turn that completes with Codex's answer ends the run, and the chat told hears it once.
    const done = await bridge.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'OK-TURN' }] })
    await waitFor(() => host.ended(done.turn.id) && notices().some(([, text]) => text === TEXTS.failureRecovered), 'the recovery')
    assert.deepEqual(notices().filter(([, text]) => text === TEXTS.failureRecovered), [[ANN, TEXTS.failureRecovered]])
    assert.equal(bridge.monitor.state.streak, null)
  } catch (error) { withStderr(host)(error) }
})
void fail
