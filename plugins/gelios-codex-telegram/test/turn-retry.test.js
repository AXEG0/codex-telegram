import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { StateStore } from '../src/core.js'
import { TelegramChannel } from '../src/telegram.js'
import { GeliosBridge } from '../scripts/bridge.js'
const TEST_TOKEN = `123456789:${'a'.repeat(32)}`

// A bridge bound to thread-1 with stubbed Codex and Telegram. Turns it starts are numbered; every
// Telegram call it makes is recorded. Retry waits are a millisecond each.
function fixture(root = mkdtempSync(join(tmpdir(), 'gelios-turn-retry-'))) {
  const bridge = new GeliosBridge({
    stateDir: join(root, 'state'), workspace: root,
    socket: join(root, 'app.sock'), controlSocket: join(root, 'control.sock'),
    codexBin: process.execPath, terminalName: 'Alex',
  })
  bridge.log = () => {}
  // A failure notice goes only to a chat the policy admits.
  bridge.store.saveAccess({ version: 2, dmPolicy: 'allowlist', pending: {}, groups: {}, mentionPatterns: [], users: { '123': { chatId: '123', alias: 'Jake', role: 'admin' } } })
  bridge.turnRetryWaits = [1, 1, 1]
  bridge.appReady = true
  bridge.currentThreadId = 'thread-1'
  const calls = []; let turns = 0
  bridge.rpc = async (method, params) => {
    calls.push({ method, params })
    if (method === 'turn/start') return { turn: { id: `retry-${++turns}`, status: 'inProgress' } }
    throw new Error(`unexpected ${method}`)
  }
  const telegram = []
  bridge.telegram = {
    acknowledge: async (chatId, messageId, state) => { telegram.push(['acknowledge', chatId, messageId, state]) },
    reply: async (request, options) => { telegram.push(['reply', request.chat_id, request.text, options?.source]) },
    startTyping: chatId => { telegram.push(['startTyping', chatId]) },
    stopTyping: chatId => { telegram.push(['stopTyping', chatId]) },
  }
  return { root, bridge, calls, telegram }
}
// A Telegram message the bridge delivered into a turn, as deliverTelegram records it.
function delivered(bridge, messageId, turnId, chatId = '123') {
  const eventId = `telegram-${chatId}-${messageId}`
  bridge.store.acceptEvent(eventId, { source: 'Telegram', chatId, messageId: String(messageId) })
  bridge.store.markEvent(eventId, 'delivered', { delivery: 'started', threadId: 'thread-1', turnId, payload: null })
}
const failed = (id, codexErrorInfo, message = 'Selected model is at capacity.') =>
  ({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id, status: 'failed', error: { message, codexErrorInfo } } } })
const completed = id => ({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id, status: 'completed' } } })
async function settle(bridge) {
  for (let count = 0; count < 200; count += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
    await bridge.ingress
  }
}
const turnStarts = calls => calls.filter(call => call.method === 'turn/start')

test('a temporary failure is continued by a bridge turn, and its success ends the retry with no report', async () => {
  const { bridge, calls, telegram } = fixture()
  delivered(bridge, 15, 'turn-a')
  bridge.activeTurnId = 'turn-a'
  bridge.observeAppMessage(failed('turn-a', 'serverOverloaded'))
  assert.equal(bridge.turnRetry.attempt, 1)
  await settle(bridge)
  assert.equal(turnStarts(calls).length, 1)
  assert.equal(turnStarts(calls)[0].params.threadId, 'thread-1')
  assert.match(turnStarts(calls)[0].params.input[0].text, /Continue the work from where it stopped/)
  assert.equal(turnStarts(calls)[0].params.approvalPolicy, undefined, 'recovery must inherit the selected policy')
  assert.equal(bridge.activeTurnId, 'retry-1')
  bridge.observeAppMessage(completed('retry-1'))
  await settle(bridge)
  assert.equal(bridge.turnRetry, null)
  assert.equal(bridge.store.turnRetry(), null)
  assert.equal(turnStarts(calls).length, 1)
  assert.deepEqual(telegram.filter(call => call[0] === 'reply' || call[0] === 'acknowledge'), [])
})

test('a temporary failure that outlasts every wait is reported once without adding message reactions', async () => {
  const { bridge, calls, telegram } = fixture()
  delivered(bridge, 15, 'turn-a')
  delivered(bridge, 16, 'turn-a')
  bridge.observeAppMessage(failed('turn-a', { responseStreamDisconnected: { httpStatusCode: 502 } }))
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await settle(bridge)
    assert.equal(turnStarts(calls).length, attempt)
    bridge.observeAppMessage(failed(`retry-${attempt}`, 'serverOverloaded'))
  }
  await settle(bridge)
  assert.equal(turnStarts(calls).length, 3)
  assert.equal(bridge.turnRetry, null)
  assert.deepEqual(telegram.filter(call => call[0] === 'acknowledge'), [])
  const replies = telegram.filter(call => call[0] === 'reply')
  assert.equal(replies.length, 1)
  assert.equal(replies[0][1], '123')
  assert.match(replies[0][2], /failed again after 3 retries/)
  assert.match(replies[0][2], /Selected model is at capacity\. \(serverOverloaded\)/)
  assert.equal(replies[0][3], 'Bridge')
})

test('a lasting failure is reported at once with no retry', async () => {
  const { bridge, calls, telegram } = fixture()
  delivered(bridge, 15, 'turn-a')
  bridge.observeAppMessage(failed('turn-a', 'usageLimitExceeded', 'You have hit your usage limit.'))
  await settle(bridge)
  assert.equal(turnStarts(calls).length, 0)
  assert.equal(bridge.turnRetry, null)
  const replies = telegram.filter(call => call[0] === 'reply')
  assert.equal(replies.length, 1)
  assert.match(replies[0][2], /^The Codex turn failed: You have hit your usage limit\. \(usageLimitExceeded\)/)
})

test('a failure with no error kind counts as lasting', async () => {
  const { bridge, calls, telegram } = fixture()
  delivered(bridge, 15, 'turn-a')
  bridge.observeAppMessage(failed('turn-a', null, 'unexpected status 404 Not Found'))
  await settle(bridge)
  assert.equal(turnStarts(calls).length, 0)
  assert.equal(telegram.filter(call => call[0] === 'reply').length, 1)
})

test('completed, interrupted and terminal-only failed turns send nothing', async () => {
  const { bridge, calls, telegram } = fixture()
  delivered(bridge, 15, 'turn-a')
  delivered(bridge, 18, 'turn-other-thread')
  bridge.observeAppMessage(completed('turn-a'))
  bridge.observeAppMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-b', status: 'interrupted' } } })
  bridge.observeAppMessage(failed('turn-terminal', 'serverOverloaded'))
  bridge.observeAppMessage({ method: 'turn/completed', params: { threadId: 'thread-9', turn: { id: 'turn-other-thread', status: 'failed',
    error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } } } })
  await settle(bridge)
  assert.equal(turnStarts(calls).length, 0)
  assert.equal(bridge.turnRetry, null)
  assert.deepEqual(telegram.filter(call => call[0] === 'reply' || call[0] === 'acknowledge'), [])
})

test('a turn already running when the wait ends continues the conversation, and its end settles the retry', async () => {
  const { bridge, calls, telegram } = fixture()
  bridge.turnRetryWaits = [50]
  delivered(bridge, 15, 'turn-a')
  bridge.observeAppMessage(failed('turn-a', 'serverOverloaded'))
  delivered(bridge, 17, 'turn-new')
  bridge.activeTurnId = 'turn-new'
  await new Promise(resolve => setTimeout(resolve, 80)); await settle(bridge)
  assert.equal(turnStarts(calls).length, 0)
  assert.equal(bridge.turnRetry.attempt, 1)
  bridge.observeAppMessage(failed('turn-new', 'usageLimitExceeded', 'You have hit your usage limit.'))
  await settle(bridge)
  assert.deepEqual(telegram.filter(call => call[0] === 'acknowledge'), [])
  const replies = telegram.filter(call => call[0] === 'reply')
  assert.equal(replies.length, 1)
  assert.match(replies[0][2], /^The Codex turn failed: /, 'no retry turn ran, so none is counted')
})

test('a pending retry survives a bridge restart and runs once the conversation is restored', async () => {
  const first = fixture()
  first.bridge.turnRetryWaits = [60_000]
  delivered(first.bridge, 15, 'turn-a')
  first.bridge.observeAppMessage(failed('turn-a', 'serverOverloaded'))
  clearTimeout(first.bridge.turnRetryTimer)
  const saved = first.bridge.store.turnRetry()
  assert.equal(saved.attempt, 1)
  assert.deepEqual(saved.messages, [{ chatId: '123', messageId: '15', starter: true }])
  first.bridge.store.saveTurnRetry({ ...saved, dueAt: Date.now() })

  const second = fixture(first.root)
  assert.equal(second.bridge.turnRetry.attempt, 1)
  second.bridge.restoring = true
  second.bridge.scheduleTurnRetry()
  await settle(second.bridge)
  assert.equal(turnStarts(second.calls).length, 0, 'no retry while the conversation is being restored')
  second.bridge.restoring = false
  second.bridge.scheduleTurnRetry()
  await settle(second.bridge)
  assert.equal(turnStarts(second.calls).length, 1)
  assert.equal(second.bridge.activeTurnId, 'retry-1')
})

test('Telegram moving to another conversation before the retry reports the failure instead', async () => {
  const { bridge, calls, telegram } = fixture()
  bridge.turnRetryWaits = [20]
  delivered(bridge, 15, 'turn-a')
  bridge.observeAppMessage(failed('turn-a', 'serverOverloaded'))
  bridge.currentThreadId = 'thread-2'
  await new Promise(resolve => setTimeout(resolve, 40)); await settle(bridge)
  assert.equal(turnStarts(calls).length, 0)
  const replies = telegram.filter(call => call[0] === 'reply')
  assert.equal(replies.length, 1)
  assert.match(replies[0][2], /moved to another conversation/)
})

test('a bridge report is recorded as an outbound event with its own source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gelios-turn-retry-reply-'))
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const store = new StateStore(join(root, 'state'))
  const access = store.loadAccess()
  access.dmPolicy = 'allowlist'
  access.users['123'] = { chatId: '123', alias: 'Jake', role: 'admin' }
  store.saveAccess(access)
  const channel = new TelegramChannel({ store, token: TEST_TOKEN, workspaceRoot: workspace,
    onInbound: async () => {}, onControl: async () => null, log: () => {} })
  channel.api.call = async () => ({ message_id: 41 })
  const result = await channel.reply({ chat_id: '123', text: 'The Codex turn failed: x' }, { source: 'Bridge' })
  const event = store.loadRuntime().events[result.event_id]
  assert.match(result.event_id, /^telegram-out-/)
  assert.equal(event.source, 'Bridge')
  assert.equal(event.status, 'delivered')
  assert.deepEqual(event.sentMessageIds, [41])
})

test('a retry turn that ends before turn/start returns leaves no retry and no active turn behind', async () => {
  const { bridge, calls, telegram } = fixture()
  delivered(bridge, 15, 'turn-a')
  bridge.rpc = async (method, params) => {
    calls.push({ method, params })
    bridge.observeAppMessage({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'retry-fast' } } })
    bridge.observeAppMessage(completed('retry-fast'))
    return { turn: { id: 'retry-fast', status: 'inProgress' } }
  }
  bridge.observeAppMessage(failed('turn-a', 'serverOverloaded'))
  await settle(bridge)
  assert.equal(turnStarts(calls).length, 1)
  assert.equal(bridge.turnRetry, null)
  assert.equal(bridge.store.turnRetry(), null)
  assert.equal(bridge.activeTurnId, null)
  assert.ok(telegram.some(call => call[0] === 'stopTyping'), 'typing that started with the retry stops at its end')
})

test('failure reporting retains every original message in an accepted burst', async () => {
  const { bridge, telegram } = fixture()
  for (const messageId of ['15', '16']) {
    const id = `telegram-123-${messageId}`
    bridge.store.acceptEvent(id, { source: 'Telegram', chatId: '123', messageId })
    bridge.store.markEvent(id, 'batched', { parentEventId: 'telegram-batch-1', payload: null })
  }
  bridge.store.acceptEvent('telegram-batch-1', { source: 'Telegram', chatId: '123', messageId: '15' })
  bridge.store.markEvent('telegram-batch-1', 'delivered', { turnId: 'turn-a', payload: null })
  bridge.observeAppMessage(failed('turn-a', 'usageLimitExceeded'))
  await settle(bridge)
  assert.deepEqual(telegram.filter(call => call[0] === 'acknowledge'), [])
  assert.equal(telegram.filter(call => call[0] === 'reply').length, 1)
})

test('a due heartbeat waits for failed human work to recover before starting', async t => {
  const { bridge, calls } = fixture()
  t.after(() => { clearTimeout(bridge.turnRetryTimer); bridge.heartbeat.stop() })
  bridge.turnRetryWaits = [60_000]
  bridge.ensureBoundThread = async () => {}
  bridge.heartbeat.configure({ enabled: true, intervalMs: 1000, prompt: 'heartbeat after recovery' })
  bridge.heartbeat.state.nextDueAt = Date.now() - 1
  delivered(bridge, 15, 'turn-a')
  bridge.activeTurnId = 'turn-a'
  bridge.observeAppMessage(failed('turn-a', 'serverOverloaded'))
  await bridge.heartbeat.tick()
  assert.equal(turnStarts(calls).length, 0, 'a due heartbeat cannot take over pending human recovery')
  await bridge.runTurnRetry()
  assert.match(turnStarts(calls)[0].params.input[0].text, /Continue the work from where it stopped/)
  bridge.observeAppMessage(completed('retry-1'))
  await bridge.heartbeat.tick()
  assert.equal(turnStarts(calls).length, 2)
  assert.match(turnStarts(calls)[1].params.input[0].text, /heartbeat after recovery/)
})
