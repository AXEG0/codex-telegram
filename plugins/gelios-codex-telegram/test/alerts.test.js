import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { StateStore } from '../src/core.js'
import { TelegramChannel, TelegramError } from '../src/telegram.js'
import { ALERTS_VERSION, TEXTS, monitorSettings } from '../src/alerts.js'
import { changeAccess } from '../src/local-setup.js'
import { GeliosBridge } from '../scripts/bridge.js'

const TOKEN = `4321:${'c'.repeat(32)}`, GROUP = '-1001234567890', MIN = 60_000
const OWNER = '123', ANN = '456', BOT = '789'
// A bridge bound to thread-1, with a real Telegram channel over a fake Bot API and one clock for the activity record,
// the monitor and typing. The owner (123) is the paired administrator, Ann (456) a contributor, 789 a pinned bot, and
// one group with topics is added. Every Telegram call is recorded; typing pulses are left to the routes' own timers.
function fixture(t, { config = { alertChat: OWNER }, root = mkdtempSync(join(tmpdir(), 'codex-tg-alerts-')), fail = () => null, start = 10_000_000 } = {}) {
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
    return { message_id: 500 + calls.length, chat: { id: Number(params.chat_id) } }
  }
  bridge.telegram = channel; bridge.telegramConfigured = true
  t.after(async () => { bridge.monitor.stop(); clearTimeout(bridge.turnRetryTimer); await channel.stop() })
  const app = message => bridge.observeAppMessage(message)
  const tick = async (ms = 0) => { clock.now += ms; bridge.monitor.tick(); await bridge.monitor.delivering }
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

test('T01: a Telegram turn types into its own chats and topics, a terminal or scheduled turn into the last admitted private chat, never a group', async t => {
  const f = fixture(t)
  await f.channel.handleUpdate(privateMessage(1, ANN))
  await f.channel.handleUpdate(groupMessage(2, 5))
  assert.equal(f.channel.lastPrivateChat, ANN, 'a group message is not a private chat, so it never becomes the terminal route')
  // Telegram input: preparation starts typing in its chat and topic; the turn it starts adds nothing else.
  f.channel.startTyping(GROUP, '5')
  f.app(turnStarted('turn-1'))
  assert.deepEqual(f.typing(), [`${GROUP}:5`])
  f.app(turnCompleted('turn-1'))
  assert.deepEqual(f.typing(), [], 'the root turn end stops typing')
  // A terminal or scheduled turn has no Telegram input: it types into the last admitted private chat.
  f.app(turnStarted('turn-2'))
  assert.deepEqual(f.typing(), [`${ANN}:`])
  // A subagent never starts or extends typing.
  f.app(turnCompleted('turn-2'))
  f.app(turnStarted('child-turn', 'thread-child'))
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
  // Progress recovers each episode once and brings typing back while the turn runs.
  f.app(item('completed', 'cmd-1', 'commandExecution'))
  await f.tick()
  assert.deepEqual(f.sent().slice(2).map(([chat, , text]) => [chat, text]), [[ANN, TEXTS.stuckRecovered], [OWNER, TEXTS.stuckRecovered]])
  assert.deepEqual(f.typing(), [`${OWNER}:`, `${ANN}:`])
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
  await f.bridge.monitor.delivering
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
  await f.bridge.monitor.delivering
  assert.equal(f.sent().length, 3)
  // A shell command or a compaction completes as a turn with no model answer: no recovery.
  f.app(turnStarted('shell')); f.app(item('started', 'sh', 'commandExecution', 'shell')); f.app(item('completed', 'sh', 'commandExecution', 'shell')); f.app(turnCompleted('shell'))
  f.app(turnStarted('compact')); f.app(item('completed', 'cc', 'contextCompaction', 'compact')); f.app(turnCompleted('compact'))
  await f.bridge.monitor.delivering
  assert.equal(f.sent().length, 3)
  f.app(turnStarted('turn-c')); for (const message of answer('turn-c')) f.app(message); f.app(turnCompleted('turn-c'))
  await f.bridge.monitor.delivering
  assert.deepEqual(f.sent().slice(3).map(([chat, topic, text]) => [chat, topic, text]),
    [[ANN, undefined, TEXTS.failureRecovered], [GROUP, 5, TEXTS.failureRecovered], [OWNER, undefined, TEXTS.failureRecovered]])
  assert.ok(accepted().slice(3).every(call => call.params.reply_parameters === undefined), 'a recovery replies to nothing')
  assert.equal(f.bridge.monitor.state.streak, null)
  // A temporary failure that a retry repairs with no lasting notice makes no new pair.
  delivered(f.store, ANN, 20, 'turn-d')
  f.app(turnStarted('turn-d')); f.app(turnCompleted('turn-d', 'failed', overloaded))
  await f.bridge.runTurnRetry()
  f.app(turnStarted('retry-3')); for (const message of answer('retry-3')) f.app(message); f.app(turnCompleted('retry-3'))
  await f.bridge.monitor.delivering
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
  await f.bridge.monitor.delivering
  const group = () => f.calls.filter(call => call.method === 'sendMessage' && call.params.chat_id === GROUP)
    .map(call => [call.params.message_thread_id, call.params.reply_parameters?.message_id, call.refused === true])
  assert.deepEqual(group(), [[5, 30, true], [5, undefined, false], [6, 31, true], [6, undefined, true]])
  assert.deepEqual(f.bridge.monitor.state.streak.notified.map(item => [item.threadId, item.stopped === true]), [['5', false], ['6', true]])
  f.app(turnStarted('turn-y')); for (const message of answer('turn-y')) f.app(message); f.app(turnCompleted('turn-y'))
  await f.bridge.monitor.delivering
  assert.deepEqual(f.sent().slice(-1), [[GROUP, 5, TEXTS.failureRecovered]], 'the run recovers the topic told, and not the deleted one')
  assert.equal(group().length, 5)
})

test('T03: an interrupt clears the retry but is not recovery, and a long tool gets a no-activity notice while its turn stays open', async t => {
  const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 600 } })
  f.bridge.turnRetryWaits = [60_000]
  delivered(f.store, ANN, 15, 'turn-a')
  f.app(turnStarted('turn-a')); f.app(turnCompleted('turn-a', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
  await f.bridge.monitor.delivering
  assert.equal(f.sent().length, 1)
  delivered(f.store, ANN, 16, 'turn-b')
  f.app(turnStarted('turn-b')); f.app(turnCompleted('turn-b', 'failed', { message: 'busy', codexErrorInfo: 'serverOverloaded' }))
  assert.equal(f.bridge.turnRetry.attempt, 1)
  f.app(turnStarted('turn-c')); for (const message of answer('turn-c').slice(0, 1)) f.app(message); f.app(turnCompleted('turn-c', 'interrupted'))
  await f.bridge.monitor.delivering
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
  f.app(turnCompleted('turn-long', 'failed', { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }))
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
  await restored.bridge.monitor.delivering
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

test('a destination refused for good is not told again in the same episode, and a bad token (401) refuses no destination', async t => {
  let answer = 403
  const f = fixture(t, { config: { alertChat: OWNER, idleMinutes: 45 }, fail: method => method === 'sendMessage' && answer ? new TelegramError(answer === 403 ? 'Forbidden: bot was blocked by the user' : 'Unauthorized', answer) : null })
  await f.tick(46 * MIN)
  for (let count = 0; count < 5; count += 1) await f.tick(4000)
  assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 1, 'the owner who blocked the bot gets one try, not one every tick')
  assert.deepEqual([f.bridge.monitor.state.notices, f.bridge.monitor.state.episodes.idle.stopped], [[], true])
  f.app(turnStarted('turn-1')); await f.tick()
  assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 1, 'no recovery goes to a stopped destination')
  assert.deepEqual(f.bridge.monitor.state.episodes, {})
  // A bad token answers 401 for every chat: the notice waits for a working token instead of stopping its destination.
  answer = 401
  await f.tick(46 * MIN)
  assert.equal(f.bridge.monitor.state.notices.length, 1)
  assert.equal(f.bridge.monitor.state.notices[0].tries, 1)
  answer = 0
  await f.tick(MIN)
  assert.deepEqual(f.sent().map(([chat, , text]) => [chat, text.split('\n')[0]]), [[OWNER, TEXTS.idle(45 * MIN)]])
})
