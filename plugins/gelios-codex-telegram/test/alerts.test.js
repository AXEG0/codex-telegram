import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { StateStore } from '../src/core.js'
import { TelegramChannel, TelegramError } from '../src/telegram.js'
import { ALERTS_VERSION, TEXTS, TICK_MS, monitorSettings } from '../src/alerts.js'
import { changeAccess, confirmAlertChat } from '../src/local-setup.js'
import { GeliosBridge } from '../scripts/bridge.js'

const TOKEN = `4321:${'c'.repeat(32)}`, GROUP = '-1001234567890', MIN = 60_000
const OWNER = '123', ANN = '456', BOT = '789'
// A bridge bound to thread-1, with a real Telegram channel over a fake Bot API and one clock for the activity record,
// the monitor and typing. The owner (123) is the paired administrator, Ann (456) a contributor, 789 a pinned bot, and
// one group with topics is added. Every Telegram call is recorded; typing pulses are left to the routes' own timers.
function fixture(t, { config = { alertChat: OWNER }, root = mkdtempSync(join(tmpdir(), 'codex-tg-alerts-')), fail = () => null, answer = () => undefined, start = 10_000_000 } = {}) {
  const workspace = join(root, 'workspace'); mkdirSync(workspace, { recursive: true })
  const store = new StateStore(join(root, 'state'))
  store.saveAccess({ version: 2, dmPolicy: 'allowlist', pending: {}, mentionPatterns: [], groups: { [GROUP]: { requireMention: false, allowFrom: [] } },
    users: { [OWNER]: { chatId: OWNER, alias: 'Owner', role: 'admin' }, [ANN]: { chatId: ANN, alias: 'Ann', role: 'contributor' },
      [BOT]: { chatId: BOT, alias: 'helper_bot', role: 'contributor', botUsername: 'helper_bot', botPinnedAt: 'x' } } })
  writeFileSync(store.configPath, JSON.stringify(config))
  const clock = { now: start }, calls = [], logs = []
  const bridge = new GeliosBridge({ stateDir: store.dir, workspace, socket: join(root, 'app.sock'), controlSocket: join(root, 'control.sock'), codexBin: process.execPath, terminalName: 'Op' })
  bridge.log = line => logs.push(line)
  bridge.activity.now = bridge.monitor.now = () => clock.now
  Object.assign(bridge.activity.clocks, { startedAt: clock.now, lastActivityAt: clock.now })
  bridge.appReady = true; bridge.currentThreadId = 'thread-1'; bridge.activity.bind('thread-1')
  bridge.rpc = async method => { throw new Error(`unexpected ${method}`) }
  const channel = new TelegramChannel({ store, token: TOKEN, workspaceRoot: workspace, onInbound: async () => {}, log: line => logs.push(line) })
  channel.now = () => clock.now; channel.typingIntervalMs = 3_600_000; channel.batcher.gap = () => 0; channel.polling = true
  channel.api.call = async (method, params) => {
    const call = { method, params, at: clock.now }; calls.push(call)
    const error = fail(method, params); if (error) { call.refused = true; throw error }
    return answer(method, params) ?? { message_id: 500 + calls.length, chat: { id: Number(params.chat_id) } }
  }
  bridge.telegram = channel; bridge.telegramConfigured = true
  t.after(async () => { bridge.monitor.stop(); clearTimeout(bridge.turnRetryTimer); await channel.stop() })
  const app = message => bridge.observeAppMessage(message)
  const tick = async (ms = 0) => { clock.now += ms; await bridge.monitor.tick(); await bridge.monitor.settle() }
  const sent = () => calls.filter(call => call.method === 'sendMessage' && !call.refused).map(call => [call.params.chat_id, call.params.message_thread_id, call.params.text])
  const typing = () => [...channel.typing.keys()].sort()
  return { root, store, bridge, channel, clock, calls, logs, app, tick, sent, typing }
}
const turnStarted = (id, thread = 'thread-1') => ({ method: 'turn/started', params: { threadId: thread, turn: { id, status: 'inProgress' } } })
const turnCompleted = (id, status = 'completed', error, thread = 'thread-1') => ({ method: 'turn/completed', params: { threadId: thread, turn: { id, status, ...(error ? { error } : {}) } } })
const item = (phase, id, type, turn = 'turn-1', thread = 'thread-1') => ({ method: `item/${phase}`, params: { threadId: thread, turnId: turn, item: { id, type } } })
const answer = (turn = 'turn-1') => [item('started', `msg-${turn}`, 'agentMessage', turn), item('completed', `msg-${turn}`, 'agentMessage', turn)]
const status = (type, flags = []) => ({ method: 'thread/status/changed', params: { threadId: 'thread-1', status: { type, activeFlags: flags } } })
const spawn = (child, turn = 'turn-1') => item('completed', `spawn-${child}`, 'collabAgentToolCall', turn)
// A Telegram message the bridge delivered into a turn, recorded as deliverTelegram records it.
function delivered(store, chatId, messageId, turnId, delivery = 'started', topicId) {
  const eventId = `telegram-${chatId}-${messageId}`
  store.acceptEvent(eventId, { source: 'Telegram', chatId, messageId: String(messageId) })
  store.markEvent(eventId, 'delivered', { delivery, threadId: 'thread-1', turnId, payload: null, ...(topicId ? { topicId } : {}) })
}
const privateMessage = (id, from) => ({ update_id: id, message: { message_id: id, date: id, chat: { id: Number(from), type: 'private' }, from: { id: Number(from), first_name: 'P' }, text: 'hi' } })
const groupMessage = (id, topic) => ({ update_id: id, message: { message_id: id, date: id, chat: { id: Number(GROUP), type: 'supergroup' }, from: { id: 700, first_name: 'M' },
  text: 'hi', is_topic_message: true, message_thread_id: topic } })

test('T01: a Telegram turn types into its own chats and topics, and each tick adds the last admitted private chat, the only chat a terminal or scheduled turn types into', async t => {
  const f = fixture(t)
  await f.channel.handleUpdate(privateMessage(1, ANN))
  await f.channel.handleUpdate(groupMessage(2, 5))
  assert.equal(f.channel.lastPrivateChat, ANN, 'a group message is not a private chat, so it never becomes the terminal route')
  // Telegram input: preparation starts typing in its chat and topic, and the tick adds the last private chat.
  f.channel.startTyping(GROUP, '5')
  f.app(turnStarted('turn-1'))
  assert.deepEqual(f.typing(), [`${GROUP}:5`])
  await f.tick(TICK_MS)
  assert.deepEqual(f.typing(), [`${GROUP}:5`, `${ANN}:`])
  f.app(turnCompleted('turn-1'))
  assert.deepEqual(f.typing(), [], 'the root turn end stops typing')
  // A terminal or scheduled turn has no Telegram input: it types into the last admitted private chat alone.
  f.app(turnStarted('turn-2'))
  await f.tick(TICK_MS)
  assert.deepEqual(f.typing(), [`${ANN}:`])
  // A subagent never starts or extends typing.
  f.app(turnCompleted('turn-2'))
  f.app(turnStarted('child-turn', 'thread-child')); await f.tick(TICK_MS)
  assert.deepEqual(f.typing(), [])
  // Input the running turn took types again until that turn ends, even after an earlier turn's end stopped it.
  f.app(turnStarted('turn-3'))
  f.channel.stopTyping()
  f.bridge.activeTurnId = 'turn-3'
  f.bridge.rpc = async () => ({ turnId: 'turn-3' })
  f.bridge.ensureBoundThread = async () => {}
  for (const id of Object.keys(f.store.loadRuntime().events)) f.store.markEvent(id, 'delivered', { payload: null })
  const { sequence } = f.store.acceptEvent('telegram-g-9', { source: 'Telegram', chatId: GROUP, messageId: '9', topicId: '7' }).event
  await f.bridge.deliverTelegram({ source: 'Telegram', eventId: 'telegram-g-9', chatId: GROUP, threadId: '7', messageId: '9', userId: '700', name: 'M', role: 'contributor',
    timestamp: 1, sequence, prepared: true, text: 'late' })
  assert.deepEqual(f.typing(), [`${GROUP}:7`])
  // A bridge that never saw a private chat types nowhere for terminal work and has no stuck notice to send.
  const g = fixture(t)
  g.app(turnStarted('turn-1'))
  await g.tick(11 * MIN)
  assert.deepEqual([g.typing(), g.sent()], [[], []])
})

test('T01: the stuck clock counts turn, item, hook and subagent progress, never input; a message steered into a silent turn neither delays nor restarts it', async t => {
  const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 600 } })
  f.channel.startTyping(ANN)
  f.app(turnStarted('turn-1'))
  await f.tick(5 * MIN); f.app(item('started', 'cmd-1', 'commandExecution'))
  await f.tick(5 * MIN); f.app(spawn('thread-child')); f.app(turnStarted('child-1', 'thread-child'))
  await f.tick(9 * MIN); f.app(item('completed', 'c-cmd', 'commandExecution', 'child-1', 'thread-child'))
  assert.deepEqual(f.sent(), [], 'subagent progress keeps the root turn clear of the limit')
  f.app(turnCompleted('child-1', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }, 'thread-child'))
  assert.deepEqual([f.typing(), f.bridge.monitor.state.streak], [[`${ANN}:`], null], 'a subagent failure neither stops root typing nor reports to Telegram')
  // Chat B steers into the turn after 9 silent minutes; its input is no progress.
  await f.tick(9 * MIN)
  f.channel.startTyping(OWNER)
  f.app(item('started', 'user-2', 'userMessage')); f.app(item('completed', 'user-2', 'userMessage'))
  f.bridge.activity.noteInput()
  await f.tick(MIN)
  assert.deepEqual(f.sent().map(([chat, , text]) => [chat, text]), [[ANN, TEXTS.stuck(10 * MIN)], [OWNER, TEXTS.stuck(10 * MIN)]])
  assert.match(TEXTS.stuck(10 * MIN), /No activity observed.*does not mean the work finished or stopped/)
  assert.deepEqual(f.typing(), [], 'typing pauses with the notice')
  // One notice per silence: a later tick, or more input, sends nothing more.
  f.channel.startTyping(ANN)
  await f.tick(MIN)
  assert.equal(f.sent().length, 2)
  assert.deepEqual(f.typing(), [], 'a chat already told stays paused while the turn is silent')
  // Progress recovers each episode once and brings typing back while the turn runs, in the last private chat only.
  f.channel.lastPrivateChat = OWNER
  f.app(item('completed', 'cmd-1', 'commandExecution'))
  await f.tick()
  assert.deepEqual(f.sent().slice(2).map(([chat, , text]) => [chat, text]), [[ANN, TEXTS.stuckRecovered], [OWNER, TEXTS.stuckRecovered]])
  assert.deepEqual(f.typing(), [`${OWNER}:`])
  await f.tick(MIN)
  assert.equal(f.sent().length, 4)
})

test('T01: the native waiting state pauses typing and both clocks, which restart when it ends', async t => {
  const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 15 } })
  f.channel.startTyping(ANN)
  f.app(turnStarted('turn-1'))
  f.app(status('active', ['waitingOnUserInput']))
  assert.equal(f.channel.typingPaused, true, 'the fact that begins the wait pauses typing, with no tick')
  await f.tick(30 * MIN)
  assert.deepEqual(f.sent(), [])
  assert.equal(f.channel.typingPaused, true)
  f.app(status('active'))
  assert.equal(f.channel.typingPaused, false, 'the fact that ends the wait resumes typing, with no tick')
  await f.tick(9 * MIN)
  assert.deepEqual(f.sent(), [], 'the stuck clock restarted when the wait ended')
  await f.tick(MIN)
  assert.deepEqual(f.sent().map(([chat]) => chat), [ANN])
})

test('T01: the idle notice needs a configured owner the policy admits, starts at startup, counts input but not polling, and only the poll owner sends it', async t => {
  for (const config of [{}, { alertChat: ANN }, { alertChat: BOT }, { alertChat: '999' }]) {
    const f = fixture(t, { config })
    await f.tick(50 * MIN)
    assert.deepEqual(f.sent(), [], `no idle notice with ${JSON.stringify(config)}`)
  }
  const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 45 } })
  f.store.saveRuntime({ ...f.store.loadRuntime(), alerts: { version: 1, sequence: 0, notices: [], episodes: {}, streak: null } })
  await f.tick(30 * MIN)
  f.channel.recordPoll(0); f.channel.recordPoll(3)
  await f.tick(14 * MIN)
  assert.deepEqual(f.sent(), [], 'completed polls are not activity')
  f.bridge.activity.noteInput()
  await f.tick(44 * MIN)
  assert.deepEqual(f.sent(), [], 'accepted input restarts the idle clock')
  // A poll that ended in a conflict leaves the idle notice to whichever process polls.
  f.channel.pollConflict = true
  await f.tick(2 * MIN)
  assert.deepEqual(f.sent(), [])
  f.channel.pollConflict = false
  await f.tick()
  assert.deepEqual(f.sent(), [[OWNER, undefined, TEXTS.idle(45 * MIN)]])
  await f.tick(60 * MIN)
  assert.equal(f.sent().length, 1, 'one notice per silence')
  f.app(turnStarted('turn-1'))
  await f.tick()
  assert.deepEqual(f.sent().at(-1), [OWNER, undefined, TEXTS.idleRecovered])
})

test('T01: a restart keeps an open idle episode: no recovery at startup, no second notice, and recovery at the first activity', async t => {
  const first = fixture(t, { config: { alertChat: OWNER, idleMinutes: 45 } })
  await first.tick(46 * MIN)
  assert.equal(first.sent().length, 1)
  const second = fixture(t, { config: { alertChat: OWNER, idleMinutes: 45 }, root: first.root, start: first.clock.now + 5000 })
  await second.tick(); await second.tick(46 * MIN)
  assert.deepEqual(second.sent(), [], 'the new bridge neither recovers at startup nor alerts again')
  second.app(turnStarted('turn-1')); await second.tick()
  assert.deepEqual(second.sent(), [[OWNER, undefined, TEXTS.idleRecovered]])
})

test('T02: the finite retry chain ends in one notice to the starters only, and a turn completed with an answer recovers each after its notice', async t => {
  const f = fixture(t)
  f.bridge.turnRetryWaits = [1, 1]
  let turns = 0
  f.bridge.rpc = async method => { if (method === 'turn/start') return { turn: { id: `retry-${++turns}` } }; throw new Error(method) }
  delivered(f.store, ANN, 15, 'turn-a')
  delivered(f.store, GROUP, 16, 'turn-a', 'started', '5')
  delivered(f.store, OWNER, 17, 'turn-a', 'steered')
  delivered(f.store, BOT, 18, 'turn-a')
  const overloaded = { message: 'busy', codexErrorInfo: 'serverOverloaded' }
  f.app(turnStarted('turn-a')); f.app(turnCompleted('turn-a', 'failed', overloaded))
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await f.bridge.runTurnRetry()
    f.app(turnStarted(`retry-${attempt}`)); f.app(turnCompleted(`retry-${attempt}`, 'failed', overloaded))
  }
  await f.bridge.monitor.settle()
  assert.equal(turns, 2, 'the bounded chain is unchanged')
  const notices = f.sent()
  // Ann and the group topic started the turn; the owner only steered into it; the pinned bot's notice goes to the owner.
  assert.deepEqual(notices.map(([chat, topic]) => [chat, topic]), [[ANN, undefined], [GROUP, 5], [OWNER, undefined]])
  assert.match(notices[0][2], /failed again after 2 retries.*serverOverloaded\)\n\nYour message got no answer\. Send it again\. You will get a message here/s)
  // Each replies to its route's message that started the turn, but not in the owner's chat it was moved to.
  const accepted = () => f.calls.filter(call => call.method === 'sendMessage' && !call.refused)
  assert.deepEqual(accepted().map(call => call.params.reply_parameters?.message_id), [15, 16, undefined])
  // A second lasting failure in the same run tells nobody again.
  delivered(f.store, ANN, 19, 'turn-b')
  f.app(turnStarted('turn-b')); f.app(turnCompleted('turn-b', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
  await f.bridge.monitor.settle()
  assert.equal(f.sent().length, 3)
  // A shell command or a compaction completes as a turn with no model answer: no recovery.
  f.app(turnStarted('shell')); f.app(item('started', 'sh', 'commandExecution', 'shell')); f.app(item('completed', 'sh', 'commandExecution', 'shell')); f.app(turnCompleted('shell'))
  f.app(turnStarted('compact')); f.app(item('completed', 'cc', 'contextCompaction', 'compact')); f.app(turnCompleted('compact'))
  await f.bridge.monitor.settle()
  assert.equal(f.sent().length, 3)
  f.app(turnStarted('turn-c')); for (const message of answer('turn-c')) f.app(message); f.app(turnCompleted('turn-c'))
  await f.bridge.monitor.settle()
  assert.deepEqual(f.sent().slice(3).map(([chat, topic, text]) => [chat, topic, text]),
    [[ANN, undefined, TEXTS.failureRecovered], [GROUP, 5, TEXTS.failureRecovered], [OWNER, undefined, TEXTS.failureRecovered]])
  assert.ok(accepted().slice(3).every(call => call.params.reply_parameters === undefined), 'a recovery replies to nothing')
  assert.equal(f.bridge.monitor.state.streak, null)
  // A temporary failure that a retry repairs with no lasting notice makes no new pair.
  delivered(f.store, ANN, 20, 'turn-d')
  f.app(turnStarted('turn-d')); f.app(turnCompleted('turn-d', 'failed', overloaded))
  await f.bridge.runTurnRetry()
  f.app(turnStarted('retry-3')); for (const message of answer('retry-3')) f.app(message); f.app(turnCompleted('retry-3'))
  await f.bridge.monitor.settle()
  assert.equal(f.sent().length, 6)
  // Each notice went through the journal as a Bridge reply.
  const outbound = Object.values(f.store.loadRuntime().events).filter(event => event.source === 'Bridge')
  assert.equal(outbound.length, 6)
})

test('a failure notice whose reply target Telegram refuses goes again at once replying to nothing, and its run still recovers it', async t => {
  // Topic 5's starter message was deleted: Telegram refuses only the reply. Topic 6 was deleted: Telegram refuses every send.
  const f = fixture(t, { fail: (method, params) => method !== 'sendMessage' || params.chat_id !== GROUP ? null
    : params.message_thread_id === 6 ? new TelegramError('Bad Request: message thread not found', 400)
      : params.reply_parameters ? new TelegramError('Bad Request: message to be replied not found', 400) : null })
  delivered(f.store, GROUP, 30, 'turn-x', 'started', '5')
  delivered(f.store, GROUP, 31, 'turn-x', 'started', '6')
  f.app(turnStarted('turn-x')); f.app(turnCompleted('turn-x', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
  await f.bridge.monitor.settle()
  const group = () => f.calls.filter(call => call.method === 'sendMessage' && call.params.chat_id === GROUP)
    .map(call => [call.params.message_thread_id, call.params.reply_parameters?.message_id, call.refused === true])
  assert.deepEqual(group(), [[5, 30, true], [5, undefined, false], [6, 31, true], [6, undefined, true]])
  assert.deepEqual(f.bridge.monitor.state.streak.notified.map(item => [item.threadId, item.stopped === true]), [['5', false], ['6', true]])
  f.app(turnStarted('turn-y')); for (const message of answer('turn-y')) f.app(message); f.app(turnCompleted('turn-y'))
  await f.bridge.monitor.settle()
  assert.deepEqual(f.sent().slice(-1), [[GROUP, 5, TEXTS.failureRecovered]], 'the run recovers the topic told, and not the deleted one')
  assert.equal(group().length, 5)
})

test('T03: an interrupt clears the retry but is not recovery, and a long tool gets a no-activity notice while its turn stays open', async t => {
  const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 600 } })
  f.bridge.turnRetryWaits = [60_000]
  delivered(f.store, ANN, 15, 'turn-a')
  f.app(turnStarted('turn-a')); f.app(turnCompleted('turn-a', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
  await f.bridge.monitor.settle()
  assert.equal(f.sent().length, 1)
  delivered(f.store, ANN, 16, 'turn-b')
  f.app(turnStarted('turn-b')); f.app(turnCompleted('turn-b', 'failed', { message: 'busy', codexErrorInfo: 'serverOverloaded' }))
  assert.equal(f.bridge.turnRetry.attempt, 1)
  f.app(turnStarted('turn-c')); for (const message of answer('turn-c').slice(0, 1)) f.app(message); f.app(turnCompleted('turn-c', 'interrupted'))
  await f.bridge.monitor.settle()
  assert.equal(f.bridge.turnRetry, null, 'the interrupt clears the obsolete retry, as before')
  assert.equal(f.sent().length, 1, 'an interrupted turn is not recovery')
  assert.notEqual(f.bridge.monitor.state.streak, null)
  // A long foreground tool: no activity is observed between its start and end, and nothing claims it ended.
  f.channel.startTyping(ANN)
  f.app(turnStarted('turn-long')); f.app(item('started', 'sleep', 'commandExecution', 'turn-long'))
  await f.tick(10 * MIN)
  assert.deepEqual(f.sent().at(-1), [ANN, undefined, TEXTS.stuck(10 * MIN)])
  assert.doesNotMatch(f.sent().at(-1)[2], /completed|finished\.|terminated|stuck, or was interrupted/)
  assert.equal(f.bridge.activity.turn.id, 'turn-long', 'silence never ends the turn')
  // Its lasting failure replaces the stuck episode's recovery with the run's own.
  delivered(f.store, ANN, 17, 'turn-long')
  // The failure comes after the notice, so the turn's end alone would recover the stuck episode.
  f.clock.now += 1000
  f.app(turnCompleted('turn-long', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
  await f.bridge.monitor.settle()
  await f.tick()
  assert.equal(f.sent().length, 2, 'the run already told Ann, and the stuck recovery folds into it')
  f.app(turnStarted('turn-ok')); for (const message of answer('turn-ok')) f.app(message); f.app(turnCompleted('turn-ok'))
  await f.tick()
  assert.deepEqual(f.sent().slice(2).map(([chat, , text]) => [chat, text]), [[ANN, TEXTS.failureRecovered]])
})

test('notices are journaled in order per destination, carry the observed time when late, recheck the policy on each try, and stop a refused destination', async t => {
  let mode = 'down'
  const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 600 }, fail: (method, params) => {
    if (method !== 'sendMessage') return null
    if (mode === 'down') return new TelegramError('Bad Gateway', 502)
    if (mode === 'limited') return Object.assign(new TelegramError('Too Many Requests: retry after 30', 429), { retryAfterMs: 30_000 })
    if (mode === 'gone' && params.chat_id === GROUP) return new TelegramError('Forbidden: bot was kicked from the supergroup chat', 403)
    return null
  } })
  f.channel.startTyping(ANN); f.channel.startTyping(GROUP, '5')
  f.app(turnStarted('turn-1'))
  await f.tick(10 * MIN)
  f.clock.now += 5000; f.app(item('started', 'x', 'reasoning'))
  await f.tick()
  const pending = f.store.loadRuntime().alerts.notices
  assert.deepEqual(pending.map(notice => [notice.kind, notice.chatId, notice.threadId]),
    [['stuck', ANN, undefined], ['stuck', GROUP, '5'], ['stuckRecovered', ANN, undefined], ['stuckRecovered', GROUP, '5']])
  assert.equal(pending[0].tries, 2, 'a 5xx is retried later, and the recovery waits behind its notice')
  // A restarted bridge restores the pending notices, not the old activity.
  mode = 'limited'
  const refusals = (method, params) => method !== 'sendMessage' ? null : mode === 'limited' ? Object.assign(new TelegramError('Too Many Requests: retry after 30', 429), { retryAfterMs: 30_000 })
    : mode === 'down' ? new TelegramError('Bad Gateway', 502) : mode === 'gone' && params.chat_id === GROUP ? new TelegramError('Forbidden: bot was kicked from the supergroup chat', 403) : null
  const second = fixture(t, { root: f.root, config: { alertChat: OWNER, idleMinutes: 600 }, fail: refusals, start: f.clock.now + 2 * MIN })
  assert.equal(second.bridge.monitor.state.notices.length, 4)
  await second.tick(10_000)
  assert.equal(second.bridge.monitor.state.notices[0].retryAt, second.clock.now + 30_000, '429 waits for retry_after')
  mode = 'gone'
  await second.tick(31_000)
  // Ann's notice and recovery arrive in order, late, with the observed time; the group refused for good, so it stops.
  const texts = second.sent().map(([chat, , text]) => [chat, text.split('\n')[0]])
  assert.deepEqual(texts, [[ANN, TEXTS.stuck(10 * MIN)], [ANN, TEXTS.stuckRecovered]])
  assert.match(second.sent()[0][2], /\(Observed at \d{4}-\d\d-\d\dT[\d:.]+Z; this notice was delayed\.\)$/)
  assert.deepEqual(second.bridge.monitor.state.notices, [])
  assert.ok(second.logs.some(line => /stuck notice to -1001234567890:5 refused; that destination stops/.test(line)))
  // A revoked chat is refused by the policy check on the next try, before any call.
  second.channel.startTyping(ANN)
  second.app(turnStarted('turn-2')); mode = 'down'
  await second.tick(10 * MIN)
  const access = second.store.loadAccess(); delete access.users[ANN]; second.store.saveAccess(access)
  const before = second.calls.length
  await second.tick(MIN)
  assert.equal(second.calls.length, before)
  assert.deepEqual(second.bridge.monitor.state.notices, [])
})

test('H01: only a getUpdates that returns ok writes the poll record; failures, 409, getMe, setMyCommands and update work write nothing', async t => {
  const f = fixture(t)
  const record = join(f.store.dir, 'poll-health.json')
  const script = [new Error('fetch failed'), new TelegramError('Conflict: terminated by other getUpdates request', 409), new TelegramError('Bad Gateway', 502), [], [privateMessage(1, ANN)]]
  let release; const slow = new Promise(done => { release = done }), seen = []
  f.channel.onInbound = () => slow
  f.channel.retryDelay = () => 1
  f.channel.api.call = async (method, params, options) => {
    f.calls.push({ method })
    if (method !== 'getUpdates') { assert.equal(existsSync(record), false, `${method} writes no record`); return method === 'getMe' ? { id: 4321, username: 'cxbot' } : true }
    seen.push([existsSync(record), f.channel.pollConflict])
    const next = script.shift()
    if (next instanceof Error) throw next
    if (next) return next
    await new Promise(done => options.signal.addEventListener('abort', done, { once: true }))
    throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  }
  void f.channel.start({ lockHeld: true })
  for (let tries = 0; tries < 300 && seen.length < 6; tries += 1) await new Promise(done => setTimeout(done, 10))
  assert.deepEqual(seen, [[false, false], [false, false], [false, true], [false, true], [true, false], [true, false]])
  const health = JSON.parse(readFileSync(record, 'utf8'))
  assert.deepEqual([health.version, health.pid, health.updates], [1, process.pid, 1])
  // The update's slow work does not rewrite the record; the record is the API's, not the preparation's.
  const written = readFileSync(record, 'utf8')
  await new Promise(done => setTimeout(done, 30))
  assert.equal(readFileSync(record, 'utf8'), written)
  release()
  // A record that cannot be written never stops polling.
  const g = fixture(t)
  mkdirSync(join(g.store.dir, 'poll-health.json'))
  g.channel.recordPoll(0); g.channel.recordPoll(0)
  assert.equal(g.logs.filter(line => /poll health record not written/.test(line)).length, 1)
  assert.equal(typeof g.channel.lastPollAt, 'number')
})

test('U02: the alert journal is versioned; a newer or damaged one is refused, never reset, and an earlier retry reports to every message it lists', async t => {
  const f = fixture(t)
  const runtime = f.store.loadRuntime()
  assert.equal(runtime.alerts, undefined, 'a journal from an earlier build has no alerts and reads as empty')
  for (const [alerts, message] of [[{ version: ALERTS_VERSION + 1, sequence: 0, notices: [], episodes: {}, streak: null }, /alert journal version 2 is newer/],
    [{ version: 1, sequence: 0, notices: [{ chatId: 'x' }], episodes: {}, streak: null }, /alert journal is corrupt/],
    [{ version: 1, sequence: 0, notices: [], episodes: { idle: { kind: 'idle' } }, streak: null }, /alert journal is corrupt/]]) {
    writeFileSync(f.store.runtimePath, JSON.stringify({ ...runtime, alerts }))
    assert.throws(() => f.store.loadRuntime(), message)
    assert.throws(() => fixture(t, { root: f.root }), message)
    assert.deepEqual(JSON.parse(readFileSync(f.store.runtimePath, 'utf8')).alerts, alerts, 'the refused journal is left as it was')
  }
  writeFileSync(f.store.runtimePath, JSON.stringify({ ...runtime, turnRetry: { threadId: 'thread-1', attempt: 8, started: 8, dueAt: 0,
    error: { message: 'busy', kind: 'serverOverloaded' }, messages: [{ chatId: ANN, messageId: '15' }, { chatId: OWNER, messageId: '16' }] } }))
  const restored = fixture(t, { root: f.root })
  restored.bridge.turnRetryWaits = [1]
  restored.app(turnStarted('retry-9')); restored.app(turnCompleted('retry-9', 'failed', { message: 'busy', codexErrorInfo: 'serverOverloaded' }))
  await restored.bridge.monitor.settle()
  assert.deepEqual(restored.sent().map(([chat]) => chat), [ANN, OWNER])
})

test('the monitoring settings are set locally and checked against the policy; status reports them with the run, episodes and pending notices', async t => {
  const f = fixture(t, { config: {} })
  for (const [key, value] of [['stuckMinutes', '5'], ['idleMinutes', '30'], ['alertChat', OWNER]]) changeAccess(f.store, { command: 'set', first: key, rest: value })
  assert.deepEqual(monitorSettings(f.store.loadConfig()), { stuckMs: 5 * MIN, idleMs: 30 * MIN, alertChat: OWNER })
  for (const [value, message] of [[ANN, /paired administrator/], [BOT, /paired administrator/], [GROUP, /numeric private chat ID/], ['999', /not paired/], ['0', /numeric private chat ID/]])
    assert.throws(() => changeAccess(f.store, { command: 'set', first: 'alertChat', rest: value }), message)
  assert.throws(() => changeAccess(f.store, { command: 'set', first: 'stuckMinutes', rest: '0' }), /minutes from above 0/)
  changeAccess(f.store, { command: 'set', first: 'alertChat', rest: 'off' })
  assert.equal(monitorSettings(f.store.loadConfig()).alertChat, null)
  changeAccess(f.store, { command: 'set', first: 'alertChat', rest: OWNER })
  f.channel.startTyping(ANN); f.app(turnStarted('turn-1'))
  await f.tick(5 * MIN)
  const monitoring = (await f.bridge.handleControl('{"action":"status"}')).monitoring
  assert.deepEqual([monitoring.stuckMinutes, monitoring.idleMinutes, monitoring.alertChat, monitoring.owner], [5, 30, OWNER, true])
  assert.deepEqual(monitoring.episodes.map(episode => [episode.kind, episode.chatId]), [['stuck', ANN]])
  assert.deepEqual([monitoring.pendingNotices, monitoring.failureRun, monitoring.typing], [[], null, []])
})

test('a destination refused for good is not told again in the same episode, and a wrong token (401) or not found (404) stops it the same way', async t => {
  let answer = 403
  const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 45 }, fail: method => method === 'sendMessage' && answer ? new TelegramError(answer === 403 ? 'Forbidden: bot was blocked by the user' : 'Unauthorized', answer) : null })
  await f.tick(46 * MIN)
  for (let count = 0; count < 5; count += 1) await f.tick(4000)
  assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 1, 'the owner who blocked the bot gets one try, not one every tick')
  assert.deepEqual([f.bridge.monitor.state.notices, f.bridge.monitor.state.episodes.idle.stopped], [[], true])
  f.app(turnStarted('turn-1')); await f.tick()
  assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 1, 'no recovery goes to a stopped destination')
  assert.deepEqual(f.bridge.monitor.state.episodes, {})
  // A wrong token (401) or not found (404) is an answer too: one try, no retry, and no recovery to that destination.
  for (const code of [401, 404]) {
    answer = code
    const sends = f.calls.filter(call => call.method === 'sendMessage').length
    await f.tick(46 * MIN)
    for (let count = 0; count < 5; count += 1) await f.tick(4000)
    assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, sends + 1, `${code}`)
    assert.deepEqual([f.bridge.monitor.state.notices, f.bridge.monitor.state.episodes.idle.stopped], [[], true], `${code}`)
    f.app(item('started', `cmd-${code}`, 'commandExecution')); await f.tick()
    assert.deepEqual([f.calls.filter(call => call.method === 'sendMessage').length, f.bridge.monitor.state.episodes], [sends + 1, {}], `${code}`)
  }
  assert.deepEqual(f.sent(), [])
})

// A paired user with no pinned username whom Telegram calls a bot, as after a restart or a token change: nothing cached.
const SAM = '555'
function pairUnpinned(store, role = 'contributor') {
  const access = store.loadAccess(); access.users[SAM] = { chatId: SAM, alias: 'Sam', role }; store.saveAccess(access)
}
const botMember = (...bots) => (method, params) => method === 'getChatMember' ? { status: 'member', user: { id: Number(params.user_id), is_bot: bots.includes(params.user_id) } } : undefined

test('a starter Telegram calls a bot never gets its own notice: the notice goes to alertChat and names that chat', async t => {
  const f = fixture(t, { answer: botMember(SAM) })
  pairUnpinned(f.store)
  assert.equal(f.channel.botChats.size, 0, 'nothing is cached, as after a restart or a token change')
  delivered(f.store, SAM, 40, 'turn-s')
  delivered(f.store, ANN, 41, 'turn-s')
  f.app(turnStarted('turn-s')); f.app(turnCompleted('turn-s', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
  await f.bridge.monitor.settle()
  assert.ok(f.calls.some(call => call.method === 'getChatMember' && call.params.chat_id === SAM), 'Telegram is asked')
  assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.params.chat_id === SAM).length, 0)
  assert.deepEqual(f.sent().map(([chat]) => chat).sort(), [OWNER, ANN].sort())
  const ann = f.sent().find(([chat]) => chat === ANN), owner = f.sent().find(([chat]) => chat === OWNER)
  assert.match(ann[2], /Your message got no answer\. Send it again\./)
  // Moved to the owner, it names the chat it is about and does not ask the owner to send the bot's message again.
  assert.match(owner[2], /The message from Sam \(chat 555\) got no answer\. You will get a message here/)
  assert.doesNotMatch(owner[2], /Send it again/)
  const toOwner = f.calls.find(call => call.method === 'sendMessage' && call.params.chat_id === OWNER)
  assert.equal(toOwner.params.reply_parameters, undefined, 'a moved notice replies to nothing')
})

test('an alertChat Telegram calls a bot gets nothing: no idle notice, and a bot\'s failure notice goes nowhere', async t => {
  const f = fixture(t, { config: { alertChat: SAM, idleMinutes: 15 }, answer: botMember(SAM) })
  pairUnpinned(f.store, 'admin')
  await f.tick(16 * MIN)
  delivered(f.store, BOT, 50, 'turn-b')
  f.app(turnStarted('turn-b')); f.app(turnCompleted('turn-b', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
  await f.tick()
  assert.deepEqual(f.sent(), [])
  assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 0)
  assert.equal((await f.bridge.handleControl('{"action":"status"}')).monitoring.owner, false)
})

test('setting alertChat asks Telegram: a bot is refused, an unanswered lookup refuses the change, and no token defers to each notice', async () => {
  const action = { kind: 'access', command: 'set', first: 'alertChat', rest: SAM }
  await assert.rejects(confirmAlertChat(action, async () => true), /administrator who is not a bot/)
  await assert.rejects(confirmAlertChat(action, async () => { throw new Error('could not tell whether chat 555 is a bot: Bad Gateway') }), /alertChat is unchanged: could not tell/)
  await confirmAlertChat(action, async () => false)
  await confirmAlertChat(action, null)
  await confirmAlertChat({ ...action, rest: 'off' }, async () => true)
  await confirmAlertChat({ ...action, first: 'stuckMinutes', rest: '5' }, async () => true)
})

test('the reconcile path records whether delivered input started its turn or was steered into it', async t => {
  const f = fixture(t)
  f.bridge.ensureBoundThread = async () => {}
  f.bridge.rpc = async method => {
    if (method === 'thread/read') return { thread: { turns: [{ id: 'turn-r', items: [{ type: 'userMessage', clientId: 'telegram-456-60' }, { type: 'userMessage', clientId: 'telegram-456-61' }] }] } }
    throw new Error(`unexpected ${method}`)
  }
  for (const id of ['60', '61']) {
    const payload = { source: 'Telegram', eventId: `telegram-456-${id}`, chatId: ANN, messageId: id, userId: ANN, name: 'Ann', role: 'contributor', timestamp: 1, prepared: true, text: id }
    const { sequence } = f.store.acceptEvent(payload.eventId, { source: 'Telegram', chatId: ANN, messageId: id, payload }).event
    await f.bridge.deliverTelegram({ ...payload, sequence, reconcile: true })
  }
  const events = f.store.loadRuntime().events
  assert.deepEqual(['60', '61'].map(id => [events[`telegram-456-${id}`].turnId, events[`telegram-456-${id}`].delivery]), [['turn-r', 'started'], ['turn-r', 'steered']])
})

for (const path of ['internal', 'forwarded']) test(`an accepted ${path === 'internal' ? 'turn/start the bridge sent' : 'turn/steer the terminal sent'} feeds the idle clock`, async t => {
  {
    const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 15 } })
    await f.tick(14 * MIN)
    if (path === 'internal') f.bridge.internal.set('bridge:t', { resolve() {}, reject() {}, timer: null, method: 'turn/start', params: { threadId: 'thread-1' } })
    else f.bridge.forwarded.set('tui:t', { id: 7, peer: { closed: false, sendText() {} }, method: 'turn/steer', message: { id: 'tui:t', method: 'turn/steer', params: { threadId: 'thread-1' } } })
    f.bridge.onAppLine(JSON.stringify({ id: path === 'internal' ? 'bridge:t' : 'tui:t', result: path === 'internal' ? { turn: { id: 'turn-i', status: 'inProgress' } } : { turnId: 'turn-i' } }))
    assert.equal(f.bridge.activity.clocks.inputAt, f.clock.now, `${path} input is noted`)
    await f.tick(2 * MIN)
    assert.deepEqual(f.sent(), [], `${path} input restarts the idle clock`)
    await f.tick(13 * MIN)
    assert.deepEqual(f.sent().map(([chat]) => chat), [OWNER])
  }
})

test('each send checks the owner again: a notice queued for a former alertChat is refused once another administrator is set', async t => {
  let down = true
  const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 15 }, fail: method => down && method === 'sendMessage' ? new TelegramError('Bad Gateway', 502) : null })
  const access = f.store.loadAccess(); access.users['321'] = { chatId: '321', alias: 'Second', role: 'admin' }; f.store.saveAccess(access)
  await f.tick(16 * MIN)
  assert.equal(f.bridge.monitor.state.notices.length, 1, 'the idle notice waits on a 5xx')
  writeFileSync(f.store.configPath, JSON.stringify({ alertChat: '321', idleMinutes: 15 }))
  down = false
  await f.tick(MIN)
  assert.equal(f.calls.filter(call => call.method === 'sendMessage' && !call.refused && call.params.chat_id === OWNER).length, 0)
  assert.ok(f.logs.some(line => /alertChat no longer names the owner's private chat/.test(line)))
})

test('a failure notice replies to the last message that started the turn in its route', async t => {
  const f = fixture(t)
  delivered(f.store, ANN, 15, 'turn-e')
  delivered(f.store, ANN, 21, 'turn-e', 'started-after-race')
  f.app(turnStarted('turn-e')); f.app(turnCompleted('turn-e', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
  await f.bridge.monitor.settle()
  assert.deepEqual(f.calls.filter(call => call.method === 'sendMessage' && !call.refused).map(call => [call.params.chat_id, call.params.reply_parameters?.message_id]), [[ANN, 21]])
})

test('every notice is kept until it is sent, with no bound: 300 waiting notices all go, in order', async t => {
  const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 600 } })
  for (let i = 0; i < 300; i += 1) f.bridge.monitor.queue({ chatId: GROUP }, 'note', `note ${i}`)
  f.bridge.monitor.save()
  assert.equal(f.store.loadRuntime().alerts.notices.length, 300)
  await f.tick()
  assert.deepEqual(f.sent().map(([chat, , text]) => [chat, text]), Array.from({ length: 300 }, (_, i) => [GROUP, `note ${i}`]))
  assert.deepEqual(f.bridge.monitor.state.notices, [])
})

test('a failure notice about a chat Telegram cannot classify yet is journaled against that chat and sent to it once Telegram, within 30 s, says it is a person\'s', async t => {
  let down = true
  const f = fixture(t, { config: {}, fail: (method, params) => down && method === 'getChatMember' && params.chat_id === SAM ? new TelegramError('Bad Gateway', 502) : null,
    answer: botMember() })
  pairUnpinned(f.store)
  delivered(f.store, SAM, 40, 'turn-u')
  f.app(turnStarted('turn-u')); f.app(turnCompleted('turn-u', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
  await f.bridge.monitor.settle()
  // With no alertChat set, nothing is sent yet, and the notice waits in the journal against Sam's chat, unclassified.
  assert.deepEqual(f.sent(), [])
  assert.deepEqual(f.store.loadRuntime().alerts.notices.map(item => [item.kind, item.chatId, item.unclassified]), [['failure', SAM, true]])
  for (let step = 0; step < 6; step += 1) await f.tick(TICK_MS)
  assert.deepEqual(f.sent(), [], 'while Telegram cannot say, the notice retries and waits')
  // Telegram answers 28 s after the failure; with no alertChat, a move to the owner would have sent nothing.
  down = false
  await f.tick(TICK_MS)
  const toSam = f.calls.filter(call => call.method === 'sendMessage' && !call.refused && call.params.chat_id === SAM)
  assert.equal(toSam.length, 1)
  assert.match(toSam[0].params.text, /Your message got no answer\. Send it again\./)
  assert.equal(toSam[0].params.reply_parameters?.message_id, 40)
  f.app(turnStarted('turn-ok')); for (const message of answer('turn-ok')) f.app(message); f.app(turnCompleted('turn-ok'))
  await f.bridge.monitor.settle()
  assert.deepEqual(f.sent().map(([chat, , text]) => [chat, text]).slice(-1), [[SAM, TEXTS.failureRecovered]])
})

test('a failure notice about a chat Telegram later calls a bot\'s moves to alertChat when sent, by name, and survives a restart while it waits', async t => {
  let down = true
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-alerts-'))
  const options = { root, fail: (method, params) => down && method === 'getChatMember' && params.chat_id === SAM ? new TelegramError('Bad Gateway', 502) : null, answer: botMember(SAM) }
  const first = fixture(t, options)
  pairUnpinned(first.store)
  delivered(first.store, SAM, 40, 'turn-b')
  first.app(turnStarted('turn-b')); first.app(turnCompleted('turn-b', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
  await first.bridge.monitor.settle()
  assert.deepEqual(first.sent(), [])
  first.bridge.monitor.stop()
  // A restarted bridge has nothing cached and finds the notice in the journal; once Telegram answers, it goes to the owner.
  const second = fixture(t, { ...options, start: 10_000_000 + 5 * MIN })
  pairUnpinned(second.store)
  down = false
  await second.tick(MIN)
  assert.equal(second.calls.filter(call => call.method === 'sendMessage' && call.params.chat_id === SAM).length, 0)
  const toOwner = second.calls.filter(call => call.method === 'sendMessage' && !call.refused && call.params.chat_id === OWNER)
  assert.equal(toOwner.length, 1)
  assert.match(toOwner[0].params.text, /The message from Sam \(chat 555\) got no answer\./)
  assert.doesNotMatch(toOwner[0].params.text, /Send it again/)
  assert.equal(toOwner[0].params.reply_parameters, undefined)
  second.app(turnStarted('turn-ok')); for (const message of answer('turn-ok')) second.app(message); second.app(turnCompleted('turn-ok'))
  await second.bridge.monitor.settle()
  assert.deepEqual(second.sent().map(([chat, , text]) => [chat, text]).slice(-1), [[OWNER, TEXTS.failureRecovered]])
})

test('after a restart, a failure notice about an unclassified chat gets 30 s of lookups from this process\'s first try, and keeps its observed time for the delayed line', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-alerts-'))
  const options = { root, fail: (method, params) => method === 'getChatMember' && params.chat_id === SAM ? new TelegramError('Bad Gateway', 502) : null, answer: botMember() }
  const first = fixture(t, options)
  pairUnpinned(first.store)
  delivered(first.store, SAM, 40, 'turn-r')
  first.app(turnStarted('turn-r')); first.app(turnCompleted('turn-r', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
  await first.bridge.monitor.settle()
  first.bridge.monitor.stop()
  // Five minutes later a restarted bridge finds the notice, observed long before, and starts its own 30 s.
  const second = fixture(t, { ...options, start: 10_000_000 + 5 * MIN })
  pairUnpinned(second.store)
  await second.tick()
  for (let step = 0; step < 7; step += 1) await second.tick(TICK_MS)
  assert.deepEqual(second.sent(), [], 'no move to alertChat within 30 s of this process\'s first try')
  await second.tick(TICK_MS)
  assert.deepEqual(second.sent().map(([chat]) => chat), [OWNER])
  assert.match(second.sent()[0][2], /The message from Sam \(chat 555\) got no answer\.[\s\S]*\(Observed at 1970-01-01T02:46:40\.000Z; this notice was delayed\.\)/)
})

test('an owner notice whose check Telegram cannot answer is retried, never stopped', async t => {
  let down = true
  const g = fixture(t, { config: { alertChat: OWNER, idleMinutes: 15 }, fail: (method, params) => method === 'getChatMember' && params.chat_id === OWNER && down ? new TelegramError('Bad Gateway', 502) : null })
  g.bridge.monitor.queue({ chatId: OWNER, owner: true }, 'idle', TEXTS.idle(15 * MIN))
  await g.bridge.monitor.deliver()
  assert.equal(g.bridge.monitor.state.notices.length, 1); assert.equal(g.bridge.monitor.state.notices[0].tries, 1)
  down = false
  await g.tick(MIN)
  assert.deepEqual(g.sent().map(([chat]) => chat), [OWNER])
})

test('a stuck notice asks Telegram nothing: an unknown chat gets the notice itself, and a chat Telegram already called a bot\'s, or a pinned bot, goes to alertChat', async t => {
  for (const [label, chat, setup, to] of [['unknown', SAM, () => {}, SAM], ['cached bot', SAM, f => f.channel.learnPeer({ id: Number(SAM), is_bot: true }), OWNER], ['pinned bot', BOT, () => {}, OWNER]]) {
    const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 600 }, answer: botMember(SAM) })
    pairUnpinned(f.store); setup(f)
    f.channel.startTyping(chat)
    f.app(turnStarted('turn-1')); await f.tick(10 * MIN)
    assert.deepEqual(f.sent().map(([sentTo, , text]) => [sentTo, text]), [[to, TEXTS.stuck(10 * MIN)]], label)
    assert.deepEqual([f.calls.filter(call => call.method === 'getChatMember' && call.params.chat_id !== OWNER).length, f.typing()], [0, []], label)
  }
})

test('each tick while the root turn works with root activity inside the stuck limit, the last private chat types, whether other chats do or not; subagent activity does not count', async t => {
  const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 600 } })
  f.channel.lastPrivateChat = ANN
  f.channel.startTyping(GROUP, '5'); f.app(turnStarted('turn-1'))
  await f.tick(TICK_MS)
  assert.deepEqual(f.typing(), [`${GROUP}:5`, `${ANN}:`])
  // Only a subagent shows activity for 11 minutes: the turn is not stuck, but the root clock is past the limit, so once
  // the last private chat stops typing, the tick does not add it again.
  f.app({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'spawn-1', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['thread-child'] } } })
  f.app(turnStarted('child-1', 'thread-child'))
  for (const minute of [3, 6, 9, 11, 12]) {
    if (minute === 12) f.channel.stopTyping(ANN, '')
    f.clock.now = 10_000_000 + minute * MIN; f.app(item('completed', `c-${minute}`, 'commandExecution', 'child-1', 'thread-child')); await f.tick()
  }
  assert.deepEqual([f.typing(), f.sent()], [[`${GROUP}:5`], []])
  // Root activity brings the last private chat back on the next tick.
  f.clock.now += 1000; f.app(item('started', 'cmd-1', 'commandExecution')); await f.tick()
  assert.deepEqual(f.typing(), [`${GROUP}:5`, `${ANN}:`])
})

test('a restarted bridge knows which chats Telegram called a bot\'s: each private input and a saved retry record the sender, and a new channel reads them', async t => {
  const f = fixture(t)
  await f.channel.handleUpdate(privateMessage(1, ANN))
  await f.channel.handleUpdate({ update_id: 2, message: { message_id: 2, date: 2, chat: { id: Number(BOT), type: 'private' }, from: { id: Number(BOT), is_bot: true, first_name: 'B', username: 'helper_bot' }, text: 'hi' } })
  await f.channel.handleUpdate(groupMessage(3, 5))
  const events = Object.values(f.store.loadRuntime().events)
  assert.deepEqual(events.map(event => [event.chatId, event.senderBot]), [[ANN, false], [BOT, true], [GROUP, undefined]])
  for (const event of events) f.store.markEvent(event.eventId, 'delivered', { turnId: 'turn-1', delivery: 'started' })
  assert.deepEqual(f.bridge.telegramMessagesOf('turn-1').map(item => [item.chatId, item.senderBot]), [[ANN, false], [BOT, true], [GROUP, undefined]])
  // The retry keeps them; a chat known only from it is known to the next channel too.
  f.store.saveTurnRetry({ threadId: 'thread-1', attempt: 1, messages: [{ chatId: SAM, messageId: '9', starter: true, senderBot: true }] })
  const channel = f.bridge.setupChannel(TOKEN)
  assert.deepEqual([ANN, BOT, SAM, GROUP].map(chat => channel.botChats.get(chat)), [false, true, true, undefined])
})

test('typing in a forum topic reaches Telegram with that topic, and a private chat\'s with none', async t => {
  const f = fixture(t)
  f.channel.typingIntervalMs = 5
  f.channel.startTyping(GROUP, '5'); f.channel.startTyping(ANN)
  for (let tries = 0; tries < 100 && new Set(f.calls.filter(call => call.method === 'sendChatAction').map(call => call.params.chat_id)).size < 2; tries += 1) await new Promise(done => setTimeout(done, 5))
  f.channel.stopTyping()
  const actions = f.calls.filter(call => call.method === 'sendChatAction')
  assert.deepEqual(actions.find(call => call.params.chat_id === GROUP).params, { chat_id: GROUP, action: 'typing', message_thread_id: 5 })
  assert.deepEqual(actions.find(call => call.params.chat_id === ANN).params, { chat_id: ANN, action: 'typing' })
})

test('a failure notice about a chat Telegram does not classify in 30 s, its lookup failing or refused, goes to alertChat by name, and nowhere without one', async t => {
  for (const [label, refusal, config] of [['502', ['Bad Gateway', 502], { alertChat: OWNER }], ['400', ['Bad Request: chat not found', 400], { alertChat: OWNER }], ['no alertChat', ['Bad Gateway', 502], {}]]) {
    const f = fixture(t, { config, fail: (method, params) => method === 'getChatMember' && params.chat_id === SAM ? new TelegramError(...refusal) : null, answer: botMember() })
    pairUnpinned(f.store)
    delivered(f.store, SAM, 40, 'turn-u')
    f.app(turnStarted('turn-u')); f.app(turnCompleted('turn-u', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
    await f.bridge.monitor.settle()
    for (let step = 0; step < 7; step += 1) await f.tick(TICK_MS)
    await f.tick(1000)
    assert.deepEqual([f.sent(), f.bridge.monitor.state.notices.map(item => item.unclassified)], [[], [true]], `${label}: Telegram is asked for 30 s`)
    await f.tick(TICK_MS)
    const sent = f.sent()
    if (!config.alertChat) {
      assert.deepEqual([sent, f.bridge.monitor.state.notices, f.bridge.monitor.state.streak.notified], [[], [], []], label)
      continue
    }
    assert.deepEqual(sent.map(([chat]) => chat), [OWNER], label)
    assert.match(sent[0][2], /The message from Sam \(chat 555\) got no answer\./, label)
    assert.equal(f.calls.find(call => call.method === 'sendMessage').params.reply_parameters, undefined, label)
    assert.ok(!f.logs.some(line => /refused its reply target/.test(line)), label)
    f.app(turnStarted('turn-ok')); for (const message of answer('turn-ok')) f.app(message); f.app(turnCompleted('turn-ok'))
    await f.bridge.monitor.settle()
    assert.deepEqual(f.sent().map(([chat, , text]) => [chat, text]).slice(-1), [[OWNER, TEXTS.failureRecovered]], label)
  }
})

test('the owner hears once per run even when a bot\'s notice is classified after the run closed', async t => {
  let down = true
  const f = fixture(t, { fail: (method, params) => down && method === 'getChatMember' && params.chat_id === SAM ? new TelegramError('Bad Gateway', 502) : null,
    answer: botMember(SAM) })
  pairUnpinned(f.store)
  // One run: the pinned bot's notice goes to the owner at once; Sam's waits, unclassified.
  delivered(f.store, BOT, 30, 'turn-r')
  delivered(f.store, SAM, 31, 'turn-r')
  f.app(turnStarted('turn-r')); f.app(turnCompleted('turn-r', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
  await f.bridge.monitor.settle()
  // The run closes while Sam's notice still waits: the owner hears "Back to normal".
  f.app(turnStarted('turn-ok')); for (const message of answer('turn-ok')) f.app(message); f.app(turnCompleted('turn-ok'))
  await f.bridge.monitor.settle()
  const owner = () => f.sent().filter(([chat]) => chat === OWNER).map(([, , text]) => text.split('\n')[0])
  assert.equal(owner().length, 2)
  // Telegram then says Sam's chat is a bot's, within 30 s: the owner was told in that run, so no second notice and no
  // second recovery. The same holds once Sam's chat moves to the owner unclassified after 30 s (a later test).
  down = false
  for (let step = 0; step < 3; step += 1) await f.tick(TICK_MS)
  assert.equal(owner().length, 2, `the owner heard: ${JSON.stringify(owner())}`)
  assert.equal(f.calls.filter(call => call.method === 'sendMessage' && call.params.chat_id === SAM).length, 0)
  assert.deepEqual(f.bridge.monitor.state.notices, [])
})

test('classifying matches notices by their own run, and a closed run leaves the journal once none of its chats is unclassified', async t => {
  let down = true
  const f = fixture(t, { fail: (method, params) => down && method === 'getChatMember' && params.chat_id === SAM ? new TelegramError('Bad Gateway', 502) : null,
    answer: botMember(SAM) })
  pairUnpinned(f.store)
  const failRun = (turn, ...starters) => { for (const [chat, id] of starters) delivered(f.store, chat, id, turn)
    f.app(turnStarted(turn)); f.app(turnCompleted(turn, 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' })) }
  const closeRun = turn => { f.app(turnStarted(turn)); for (const message of answer(turn)) f.app(message); f.app(turnCompleted(turn)) }
  // Run 1: the pinned bot tells the owner; Sam waits unclassified; the run closes.
  failRun('turn-1', [BOT, 30], [SAM, 31]); await f.bridge.monitor.settle()
  closeRun('turn-ok1'); await f.bridge.monitor.settle()
  // Run 2: only Sam fails, unclassified again.
  failRun('turn-2', [SAM, 32]); await f.bridge.monitor.settle()
  assert.equal(f.bridge.monitor.state.runs.length, 1)
  // Telegram calls Sam a bot: run 1's notice is a duplicate for the owner, run 2's is the owner's first in that run.
  down = false
  for (let minute = 0; minute < 3; minute += 1) await f.tick(MIN)
  const owner = f.sent().filter(([chat]) => chat === OWNER).map(([, , text]) => text.split('\n').slice(0, 3).join(' '))
  assert.equal(owner.length, 3, JSON.stringify(owner))
  assert.match(owner[2], /The message from Sam \(chat 555\) got no answer/)
  assert.equal(f.bridge.monitor.state.runs, undefined, 'the closed run left the journal once classified')
})

test('a closed run whose unclassified chat Telegram refuses with a 400 for 30 s leaves the journal once its notices move to alertChat', async t => {
  let refuse = false
  const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 600 }, answer: botMember(),
    fail: (method, params) => method === 'getChatMember' && params.chat_id === SAM ? (refuse ? new TelegramError('Bad Request: chat not found', 400) : new TelegramError('Bad Gateway', 502)) : null })
  pairUnpinned(f.store)
  delivered(f.store, SAM, 40, 'turn-c')
  f.app(turnStarted('turn-c')); f.app(turnCompleted('turn-c', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
  await f.bridge.monitor.settle()
  // The run closes while Sam's chat is unclassified, so the closed run stays in the journal.
  f.app(turnStarted('turn-ok')); for (const message of answer('turn-ok')) f.app(message); f.app(turnCompleted('turn-ok'))
  await f.bridge.monitor.settle()
  assert.equal(f.bridge.monitor.state.runs.length, 1)
  refuse = true
  await f.tick(MIN)
  assert.deepEqual([f.bridge.monitor.state.notices, f.bridge.monitor.state.runs], [[], undefined])
  assert.deepEqual(f.sent().map(([chat, , text]) => [chat, text.split('\n')[0]]), [[OWNER, f.sent()[0][2].split('\n')[0]], [OWNER, TEXTS.failureRecovered]])
  assert.match(f.sent()[0][2], /The message from Sam \(chat 555\) got no answer\./)
})

test('after a stuck recovery typing comes back only in the last admitted private chat, not in the group topic the notice paused', async t => {
  const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 600 } })
  f.channel.lastPrivateChat = ANN
  f.channel.startTyping(GROUP, '5')
  f.app(turnStarted('turn-1')); await f.tick(10 * MIN)
  assert.deepEqual([f.sent().map(([chat, topic]) => [chat, topic]), f.typing()], [[[GROUP, 5]], []])
  f.clock.now += 1000; f.app(item('started', 'cmd-1', 'commandExecution')); await f.tick()
  assert.deepEqual([f.sent().map(([chat, , text]) => [chat, text]).at(-1), f.typing()], [[GROUP, TEXTS.stuckRecovered], [`${ANN}:`]])
})
