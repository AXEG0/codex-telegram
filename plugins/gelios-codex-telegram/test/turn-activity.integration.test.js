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

const codexBin = process.env.GELIOS_REAL_CODEX_BIN
const skip = codexBin ? false : 'set GELIOS_REAL_CODEX_BIN to run the real Codex integration test'
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
const call = (name, args, tools) => ({ type: 'function_call', id: `fc_${name}`, call_id: `call_${name}`, name, arguments: JSON.stringify(args), status: 'completed',
  // Releases that defer the multi-agent tools behind tool search still run a call in their namespace.
  ...(name === 'spawn_agent' && !tools.some(tool => tool.name === 'spawn_agent') ? { namespace: 'multi_agent_v1' } : {}) })
// The request's newest user message names the scenario; tool outputs after it give the step within the turn.
function step(input) {
  const last = input.map(item => item.type === 'message' && item.role === 'user').lastIndexOf(true)
  const text = JSON.stringify(input[last]?.content || '')
  return { text, outputs: input.slice(last + 1).filter(item => item.type === 'function_call_output').length }
}

// Only the model endpoint is a fixture: threads, turns, tools, subagents and their notifications are real Codex.
async function realHost(t, respond, features = '') {
  const provider = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    const { input = [], tools = [] } = JSON.parse(body)
    respond(step(input), response, tools)
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  t.after(() => { provider.closeAllConnections(); return new Promise(resolve => provider.close(resolve)) })
  const root = mkdtempSync(join(tmpdir(), 'codex-telegram-real-activity-'))
  const workspace = join(root, 'workspace'), codexHome = join(root, 'codex-home'), stateDir = join(root, 'state')
  mkdirSync(workspace); mkdirSync(codexHome); mkdirSync(stateDir, { mode: 0o700 })
  writeFileSync(join(codexHome, 'config.toml'), `model = "gpt-5.5"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local integration fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n${features}`)
  const app = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
    cwd: workspace, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const host = { stderr: '', notifications: [], requests: [], facts: [], outgoing: [], workspace }
  app.stderr.setEncoding('utf8'); app.stderr.on('data', chunk => { host.stderr = (host.stderr + chunk).slice(-8192) })
  t.after(async () => {
    if (app.exitCode !== null || app.signalCode !== null) return
    app.kill('SIGTERM'); await Promise.race([once(app, 'exit'), wait(2000)])
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
  })
  await once(app, 'spawn')
  const bridge = new GeliosBridge({ stateDir, workspace, socket: join(root, 'app.sock'), controlSocket: join(root, 'control.sock'), terminalName: 'Operator' })
  bridge.app = app; bridge.appReady = true; bridge.log = () => {}
  bridge.telegram = { acknowledge: async () => {}, startTyping() {}, stopTyping() {} }
  // Everything the bridge sends the app-server, to show that observing activity sends nothing of its own.
  const send = bridge.sendApp.bind(bridge)
  bridge.sendApp = message => { host.outgoing.push(message); return send(message) }
  const observe = bridge.activity.observe.bind(bridge.activity)
  bridge.activity.observe = (message, rootThreadId) => { const fact = observe(message, rootThreadId); if (fact) host.facts.push(fact); return fact }
  // The test keeps its own record of the app-server's notifications, independently of the bridge's.
  readline.createInterface({ input: app.stdout }).on('line', line => {
    const message = JSON.parse(line)
    if (message.method && message.id !== undefined) host.requests.push(message)
    else if (message.method) host.notifications.push(message)
    bridge.onAppLine(line)
  })
  await bridge.rpc('initialize', { clientInfo: { name: 'codex-telegram-activity-integration', version: '0' }, capabilities: { experimentalApi: true } })
  bridge.sendApp({ method: 'initialized' })
  const threadId = (await bridge.rpc('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread.id
  bridge.bindThread(threadId)
  host.ended = turnId => host.notifications.find(message => message.method === 'turn/completed' && message.params.turn.id === turnId)
  host.startedIn = thread => host.notifications.filter(message => message.method === 'turn/started' && message.params.threadId === thread).map(message => message.params.turn.id)
  return { bridge, host, threadId }
}
// The lifecycle facts the bridge recorded for one thread, and the same notifications as the app-server sent them.
const LIFECYCLE = /^(turn|item)\/(started|completed)$/
const recorded = (host, threadId) => host.facts.filter(fact => fact.threadId === threadId && LIFECYCLE.test(fact.method))
  .map(fact => [fact.method, fact.turnId, fact.itemId])
const sent = (host, threadId) => host.notifications.filter(message => message.params?.threadId === threadId && LIFECYCLE.test(message.method))
  .map(message => [message.method, message.params.turnId || message.params.turn?.rootTurnId || message.params.turn?.id, message.params.item?.id || null])

test('real app-server: terminal, Telegram and scheduled turns report whole-turn activity, a running subagent included', { skip, timeout: 90_000 }, async t => {
  let held = null
  const { bridge, host, threadId } = await realHost(t, ({ text, outputs }, response, tools) => {
    if (text.includes('SUBAGENT-TASK') && !text.includes('TERMINAL-TURN')) { held = response; return stream(response, [], { end: false }) }
    if (text.includes('TERMINAL-TURN') && outputs === 0) return stream(response, [call('exec_command', { cmd: 'echo activity' }, tools)])
    if (text.includes('TERMINAL-TURN') && outputs === 1) return stream(response, [call('spawn_agent', { message: 'SUBAGENT-TASK: keep working' }, tools)])
    stream(response, [reply('Done.')])
  })
  try {
    // Terminal input through the shared TUI connection.
    const peer = { closed: false, sent: [], sendText(text) { this.sent.push(JSON.parse(text)) }, close() { this.closed = true } }
    bridge.attachTui(peer); peer.bootstrapped = true
    bridge.onTuiText(JSON.stringify({ id: 'terminal-1', method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'TERMINAL-TURN' }] } }), peer)
    await waitFor(() => host.startedIn(threadId).length === 1 && host.ended(host.startedIn(threadId)[0]) && held, 'the terminal turn to end while its subagent runs')
    const terminalTurn = host.startedIn(threadId)[0]
    const child = host.notifications.find(message => message.method === 'turn/started' && message.params.threadId !== threadId).params.threadId
    await waitFor(() => host.facts.some(fact => fact.threadId === child && fact.kind === 'turnStarted'), 'the subagent turn to reach the bridge')
    let activity = (await bridge.handleControl('{"action":"status"}')).activity
    assert.equal(activity.turn, null)
    assert.deepEqual([activity.lastTurn.id, activity.lastTurn.status], [terminalTurn, 'completed'])
    assert.equal(activity.busy, true, 'the running subagent keeps the whole turn busy')
    assert.deepEqual(activity.descendants.running.map(entry => entry.threadId), [child])
    const terminalFacts = recorded(host, threadId)
    assert.deepEqual(terminalFacts, sent(host, threadId), 'every root turn and item notification is recorded in the order the host sent it')
    for (const type of ['commandExecution', 'collabAgentToolCall']) {
      assert.deepEqual(host.facts.filter(fact => fact.threadId === threadId && fact.itemType === type).map(fact => fact.kind), ['itemStarted', 'itemCompleted'])
    }
    assert.equal(peer.sent.find(message => message.id === 'terminal-1')?.result?.turn?.id, terminalTurn)
    stream(held, [reply('Subagent finished.')])
    await waitFor(() => host.startedIn(child).every(turnId => host.ended(turnId)), 'the subagent turn to complete')
    await waitFor(() => !bridge.activity.snapshot().busy, 'the bridge to see the subagent end')
    activity = bridge.activity.snapshot()
    assert.ok(Date.parse(activity.clocks.descendantActivityAt) >= Date.parse(activity.clocks.turnEndedAt), 'subagent work after the root turn ended is activity')
    // The spawn record links the child. Its work can reach the bridge before that record does; such work is
    // held as unattributed and counted once the record arrives, never assigned to the root.
    const link = host.facts.find(fact => fact.threadId === threadId && fact.itemType === 'collabAgentToolCall' && fact.kind === 'itemCompleted').sequence
    const childFacts = host.facts.filter(fact => fact.threadId === child && LIFECYCLE.test(fact.method))
    assert.ok(childFacts.some(fact => fact.sequence > link), 'the subagent works after its spawn record')
    for (const fact of childFacts) assert.deepEqual([fact.scope, fact.meaningful], fact.sequence > link ? ['descendant', true] : ['other', false])
    peer.closed = true; peer.onClose()

    // Telegram input through the durable journal.
    const event = { eventId: 'telegram-123-1', source: 'Telegram', prepared: true, chatId: '123', messageId: '1', clientId: 'telegram-123-1',
      input: [{ type: 'text', text: 'TELEGRAM-TURN' }] }
    await bridge.acceptTelegram(event, async () => event)
    const telegramTurn = bridge.store.loadRuntime().events[event.eventId].turnId
    await waitFor(() => host.ended(telegramTurn) && bridge.activity.snapshot().lastTurn?.id === telegramTurn, 'the Telegram turn to complete')

    // Scheduled input through the heartbeat.
    bridge.heartbeat.configure({ enabled: true, intervalMs: 60_000, prompt: 'HEARTBEAT-TURN' })
    bridge.heartbeat.state.nextDueAt = 0
    await bridge.heartbeat.tick()
    const heartbeat = Object.values(bridge.store.loadRuntime().events).find(saved => saved.source === 'Heartbeat')
    assert.equal(heartbeat.status, 'delivered')
    await waitFor(() => host.ended(heartbeat.turnId) && bridge.activity.snapshot().lastTurn?.id === heartbeat.turnId, 'the heartbeat turn to complete')

    const turns = host.startedIn(threadId)
    assert.deepEqual(turns, [terminalTurn, telegramTurn, heartbeat.turnId])
    assert.deepEqual(recorded(host, threadId), sent(host, threadId))
    for (const turnId of turns) {
      const kinds = host.facts.filter(fact => fact.turnId === turnId && fact.threadId === threadId && fact.method.startsWith('turn/')).map(fact => [fact.kind, fact.scope, fact.status])
      assert.deepEqual(kinds, [['turnStarted', 'root', 'inProgress'], ['turnCompleted', 'root', 'completed']])
    }
    const sequences = host.facts.map(fact => fact.sequence)
    assert.deepEqual(sequences, sequences.map((_, index) => index + 1), 'facts keep the order the bridge received them in')
    assert.ok(host.facts.every(fact => fact.emittedAt === null || Number.isFinite(fact.emittedAt)))
    activity = bridge.activity.snapshot()
    assert.deepEqual([activity.busy, activity.waiting, activity.unattributedThreads], [false, null, 0])
    // Observing the subagent never resumed, read or sent a turn to it, and no request changed the native policy.
    assert.equal(host.outgoing.some(message => JSON.stringify(message.params || {}).includes(child)), false)
    assert.equal(host.outgoing.some(message => message.method === 'thread/settings/update'), false)
    for (const message of host.outgoing.filter(candidate => candidate.method === 'turn/start'))
      assert.deepEqual(['approvalPolicy', 'sandbox', 'sandboxPolicy', 'permissions'].filter(name => name in message.params), [])
  } catch (error) {
    if (host.stderr.trim()) error.message += `\napp-server stderr:\n${host.stderr.trim()}`
    throw error
  } finally { if (held && !held.writableEnded) held.destroy() }
})

test('real app-server: the native waiting state and an interrupted turn are recorded as the host reports them', { skip, timeout: 90_000 }, async t => {
  // Codex asks the user only when this native feature allows it in the default mode; the bridge adds no approval handling.
  const { bridge, host, threadId } = await realHost(t, ({ text, outputs }, response) => {
    if (text.includes('ASK-TURN') && outputs === 0) return stream(response, [{ type: 'function_call', id: 'fc_ask', call_id: 'call_ask', name: 'request_user_input',
      arguments: JSON.stringify({ questions: [{ id: 'choice', header: 'Pick', question: 'Which one?', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] }), status: 'completed' }])
    if (text.includes('HOLD-TURN')) return stream(response, [], { end: false })
    stream(response, [reply('Thanks.')])
  }, '[features]\ndefault_mode_request_user_input = true\n')
  try {
    const asked = await bridge.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'ASK-TURN' }] })
    await waitFor(() => host.requests.some(request => request.method === 'item/tool/requestUserInput'), 'the native user-input request')
    await waitFor(() => bridge.activity.snapshot().waiting, 'the waiting state to reach the bridge')
    let activity = bridge.activity.snapshot()
    assert.deepEqual([activity.busy, activity.turn.id, activity.waiting.flags], [true, asked.turn.id, ['waitingOnUserInput']])
    const request = host.requests.find(candidate => candidate.method === 'item/tool/requestUserInput')
    bridge.sendApp({ id: request.id, result: { answers: { choice: { answers: ['A'] } } } })
    await waitFor(() => host.ended(asked.turn.id) && !bridge.activity.snapshot().busy, 'the answered turn to complete')
    activity = bridge.activity.snapshot()
    assert.deepEqual([activity.waiting, activity.lastTurn.id, activity.lastTurn.status], [null, asked.turn.id, 'completed'])

    const holding = await bridge.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'HOLD-TURN' }] })
    await waitFor(() => bridge.activity.snapshot().turn?.id === holding.turn.id, 'the held turn to start')
    await bridge.rpc('turn/interrupt', { threadId, turnId: holding.turn.id })
    await waitFor(() => host.ended(holding.turn.id) && !bridge.activity.snapshot().busy, 'the interrupted turn to end')
    activity = bridge.activity.snapshot()
    assert.deepEqual([activity.lastTurn.id, activity.lastTurn.status, activity.lastTurn.closedBy], [holding.turn.id, 'interrupted', null])
    assert.deepEqual(recorded(host, threadId), sent(host, threadId))
  } catch (error) {
    if (host.stderr.trim()) error.message += `\napp-server stderr:\n${host.stderr.trim()}`
    throw error
  }
})

// A review's model answer is its findings as JSON; a held turn's answer never arrives.
function reviewer({ text }, response) {
  if (text.includes('HOLD-TURN')) return stream(response, [], { end: false })
  stream(response, [reply(JSON.stringify({ findings: [], overall_correctness: 'patch is correct', overall_explanation: 'Fine.', overall_confidence_score: 0.9 }))])
}

test('real app-server: an inline review is one turn, though its turn/started carries another ID', { skip, timeout: 90_000 }, async t => {
  const { bridge, host, threadId } = await realHost(t, reviewer)
  try {
    // The review's items and completion use the review's turn ID; its turn/started has its own ID and, from Codex 0.162.0 on,
    // names the review as rootTurnId.
    const review = await bridge.rpc('review/start', { threadId, target: { type: 'custom', instructions: 'REVIEW-TASK: check the change.' } })
    await waitFor(() => host.ended(review.turn.id), 'the review to complete')
    await waitFor(() => !bridge.activity.snapshot().busy, 'the bridge to see the review end')
    // Codex 0.160.0 sends that turn/started with no rootTurnId at all; the root completion still ends the turn.
    const reviewStart = host.notifications.find(message => message.method === 'turn/started' && message.params.threadId === threadId)
    assert.notEqual(reviewStart.params.turn.id, review.turn.id)
    if (reviewStart.params.turn.rootTurnId != null) assert.equal(reviewStart.params.turn.rootTurnId, review.turn.id)
    const activity = bridge.activity.snapshot()
    assert.deepEqual([activity.turn, activity.lastTurn.id, activity.lastTurn.status], [null, review.turn.id, 'completed'])
    assert.deepEqual(recorded(host, threadId), sent(host, threadId))
  } catch (error) {
    if (host.stderr.trim()) error.message += `\napp-server stderr:\n${host.stderr.trim()}`
    throw error
  }
})

test('real app-server: a non-fatal error event leaves a running turn running', { skip, timeout: 90_000 }, async t => {
  const { bridge, host, threadId } = await realHost(t, reviewer)
  try {
    // A base-branch review fails in this workspace, which is no Git repository. The host reports systemError
    // for that error event while another turn keeps running.
    const holding = await bridge.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'HOLD-TURN' }] })
    await waitFor(() => bridge.activity.snapshot().turn?.id === holding.turn.id, 'the held turn to start')
    await bridge.rpc('review/start', { threadId, target: { type: 'baseBranch', branch: 'main' } }).catch(() => {})
    await waitFor(() => host.facts.some(fact => fact.threadId === threadId && fact.kind === 'threadStatus' && fact.status === 'systemError'), 'the host to report systemError')
    let activity = bridge.activity.snapshot()
    assert.deepEqual([activity.busy, activity.turn?.id, activity.lastTurn], [true, holding.turn.id, null])
    await bridge.rpc('turn/interrupt', { threadId, turnId: holding.turn.id })
    await waitFor(() => host.ended(holding.turn.id) && !bridge.activity.snapshot().busy, 'the interrupted turn to end')
    activity = bridge.activity.snapshot()
    assert.deepEqual([activity.lastTurn.id, activity.lastTurn.status, activity.lastTurn.closedBy], [holding.turn.id, 'interrupted', null])
  } catch (error) {
    if (host.stderr.trim()) error.message += `\napp-server stderr:\n${host.stderr.trim()}`
    throw error
  }
})
