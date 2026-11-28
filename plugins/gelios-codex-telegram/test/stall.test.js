import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { StateStore } from '../src/core.js'
import { PROBE_MS, StallRecord } from '../src/stall.js'
import { GeliosBridge } from '../scripts/bridge.js'
import { until } from './support/wait.js'

// Codex's sends of unknown outcome while Telegram leaves the bot's calls unanswered, and the one event that names
// them once Telegram answers a write again (src/stall.js). A real bridge and Telegram channel run against Telegram
// stood in for at the HTTP layer; Codex's tool calls come through the bridge's control handler.
const TOKEN = `4321:${'s'.repeat(32)}`, OWNER = '123', ANN = '456', PEER = '777', NEW = '889'
const iso = ms => new Date(ms).toISOString()
const WARNING = (since, until) => `Telegram left these sends of this bot unanswered from ${iso(since)} and answered a write begun after them at ${iso(until)}. Telegram says it keeps a bot's updates up to 24 hours and gives no sign when a message it held will come, so messages sent to this bot in the 24 hours before this note may still arrive, each with its own send time; ${iso(until)} is when Telegram answered this bot's writes again, not when messages to it stopped waiting.`
const PEOPLE = 'Send again what still matters, its first line saying it may repeat an earlier message; for what went stale, send a short note that it replaces any earlier copy.'
const BOTS = 'Ask that bot whether it arrived, and send it again only if it says no.'
const CARDS = 'Its buttons still count if it arrived. If a press on it has reached you, there is nothing to send. Otherwise, if it went stale, send a short note that it replaces any earlier copy; if it still matters, send its text again without buttons, its first line saying it may repeat an earlier message, and ask for the answer in words or on the earlier copy\'s buttons. If its reader says the earlier copy never came, send it again with buttons, as today.'
const unknown = since => `Telegram has left this bot's sends unanswered since ${iso(since)}; do not send it again yet: once Telegram answers a write again, one event names this send and says what to do`
// Telegram over HTTP. f.rule(method, params) answers a call: null for ok, { result } for ok with that result, { status }
// for Telegram's own refusal (4xx) or a 5xx, { drop: true } to cut the connection with no answer, or a promise of one,
// which holds the call until then. Each call keeps the real time it arrived and was answered, for the probe's waits.
async function standIn(t, f) {
  let next = 100
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const method = request.url.slice(1), params = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()))
    const call = { method, params, at: performance.now() }; f.calls.push(call)
    const answer = (await f.rule(method, params)) || {}
    if (answer.drop) { request.socket.destroy(); return }
    const status = answer.status || 200
    const result = answer.result ?? (method === 'sendMessage' ? { message_id: ++next, date: 1, chat: { id: Number(params.chat_id), type: 'private' }, text: params.text }
      : method === 'getUpdates' ? [] : method === 'getChatMember' ? { user: { id: Number(params.user_id), is_bot: params.user_id === PEER } } : true)
    call.answeredAt = performance.now()
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(status === 200 ? { ok: true, result } : { ok: false, error_code: status, description: status >= 500 ? 'Bad Gateway' : 'Bad Request: chat not found' }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}
async function fixture(t, { config = {}, alertChat = OWNER } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-stall-')), workspace = join(root, 'workspace'); mkdirSync(workspace)
  const store = new StateStore(join(root, 'state'))
  store.saveAccess({ version: 2, dmPolicy: 'allowlist', pending: {}, mentionPatterns: [], groups: {}, users: Object.fromEntries([[OWNER, 'Owner', 'admin'],
    [ANN, 'Ann', 'contributor'], [PEER, 'peer', 'contributor'], [NEW, 'New', 'contributor']].map(([chatId, alias, role]) => [chatId, { chatId, alias, role }])) })
  writeFileSync(store.configPath, JSON.stringify({ ...(alertChat ? { alertChat } : {}), ...config }))
  const bridge = new GeliosBridge({ stateDir: store.dir, workspace, socket: join(root, 'app.sock'), controlSocket: join(root, 'control.sock'), codexBin: process.execPath, terminalName: 'Op' })
  const f = { store, bridge, clock: { now: Date.UTC(2026, 10, 14, 20, 13) }, calls: [], logs: [], inputs: [], rule: () => null }
  bridge.log = line => f.logs.push(line)
  bridge.appReady = true; bridge.currentThreadId = 'thread-1'; bridge.ensureBoundThread = async () => {}
  // Codex takes each input: the first starts a turn and the rest steer it.
  bridge.rpc = async (method, params) => {
    if (!['turn/start', 'turn/steer'].includes(method)) throw new Error(`unexpected ${method}`)
    f.inputs.push(params.input[0].text); return method === 'turn/start' ? { turn: { id: 'turn-1' } } : { turnId: 'turn-1' }
  }
  const channel = f.channel = bridge.telegram = bridge.setupChannel(TOKEN); bridge.batcher = channel.batcher; bridge.telegramConfigured = true
  channel.polling = true; channel.typingIntervalMs = 3_600_000; channel.batcher.gap = () => 0
  channel.now = channel.api.now = () => f.clock.now
  for (const [id, isBot] of [[OWNER, false], [ANN, false], [PEER, true]]) channel.learnPeer({ id: Number(id), is_bot: isBot })
  channel.api.base = await standIn(t, f)
  t.after(async () => { bridge.monitor.stop(); clearTimeout(bridge.turnRetryTimer); await channel.stop() })
  // Codex's own tool calls, as the tool client sends them to the bridge; signal aborts as their control connection closes.
  f.reply = (args, signal) => bridge.handleControl(JSON.stringify({ action: 'reply', args: { format: 'text', ...args } }), signal)
  f.edit = (args, signal) => bridge.handleControl(JSON.stringify({ action: 'edit_message', args: { format: 'text', ...args } }), signal)
  // A write: a typing call unless named.
  f.write = (method = 'sendChatAction', params = { chat_id: OWNER, action: 'typing' }, options) => channel.api.call(method, params, options)
  f.journaled = () => Object.values(store.loadRuntime().events).filter(event => event.eventId.startsWith('telegram-stall-'))
  // The inputs Codex got whose metadata line carries the stall event's mark, each split into its lines.
  f.stalls = () => f.inputs.map(text => text.split('\n')).filter(lines => lines[1].includes('event=telegram_stall'))
  f.held = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
  return f
}
const failure = expected => error => { assert.equal(error.message, expected); return true }

test('a reply Telegram answers with a 502 opens the record and its result says to wait; polls, reads, unanswered writes and the bridge\'s own 429 leave it open, and the first answered write that left after it closes it with one event', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  f.rule = method => method === 'sendMessage' ? { status: 502 } : null
  const began = f.clock.now += 1000
  await assert.rejects(f.reply({ chat_id: ANN, text: 'The build is green.' }), failure(`reply failed after 0 Telegram messages: Bad Gateway; delivery unknown: ${unknown(began)}`))
  assert.ok(f.logs.includes(`telegram: stall record opened: since=${iso(began)}; by reply to chat ${ANN} began ${iso(began)} ended ${iso(began)}`), f.logs.join('\n'))
  f.rule = () => null
  for (const [method, params] of [['getUpdates', { offset: 0, timeout: 0 }], ['getMe', {}], ['getFile', { file_id: 'a' }], ['getChat', { chat_id: PEER }],
    ['getChatMember', { chat_id: PEER, user_id: PEER }]]) await f.channel.api.call(method, params)
  f.rule = method => method === 'sendChatAction' ? { status: 502 } : null
  await assert.rejects(f.write(), /Bad Gateway/)
  f.channel.api.holdUntil = f.clock.now + 60_000
  await assert.rejects(f.write('sendChatAction', { chat_id: OWNER, action: 'typing' }, { skipWhileHeld: true }), /rate limit holds calls/)
  f.channel.api.holdUntil = 0
  assert.deepEqual(f.journaled(), [])
  f.rule = () => null
  const closed = f.clock.now += 5000
  await f.write()
  const [event] = f.journaled()
  assert.equal(event.chatId, undefined); assert.equal(event.source, 'Telegram')
  await until(t, () => f.stalls().length === 1, 'the stall event to reach Codex')
  const [label, metadata, delivery, ...text] = f.stalls()[0]
  assert.match(label, new RegExp(`^\\[Telegram/bridge \\| ${iso(closed)} \\| #[0-9]+ \\| event=${event.eventId}\\]$`))
  assert.equal(metadata, `Telegram metadata: chat_id=${OWNER}; event=telegram_stall; since=${iso(began)}; until=${iso(closed)}`)
  assert.match(delivery, /^Telegram delivery: /)
  assert.deepEqual(text, [WARNING(began, closed), `To people, delivery unknown: chat ${ANN} at ${iso(began)}: "The build is green.". ${PEOPLE}`])
  assert.ok(f.logs.includes(`telegram: stall record closed: since=${iso(began)}; until=${iso(closed)}; closed by sendChatAction; reply to chat ${ANN} began ${iso(began)} ended ${iso(began)}; event=${event.eventId}`), f.logs.join('\n'))
  // The record is closed: another answered write makes no second event.
  await f.write(); assert.equal(f.journaled().length, 1)
})

test('a reply with no answer, a reply stopped part way and an edit answered with a 502 each join the record and are named under To bots, To people and Edits; a write Telegram refuses with a 4xx closes it, and a line with no entry is not shown', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { config: { textChunkLimit: 8, chunkMode: 'length' } })
  const draft = (await f.reply({ chat_id: ANN, text: 'Draft 1' })).message_ids[0]
  // The reply's first message is a write Telegram answers, so the record opens on its second, after it.
  f.rule = (method, params) => method === 'sendMessage' && params.text === 'ijklmnop' ? { status: 502 } : null
  const split = f.clock.now += 1000
  await assert.rejects(f.reply({ chat_id: OWNER, text: 'abcdefghijklmnop' }), failure(`reply failed after 1 Telegram messages: Bad Gateway; delivery unknown: ${unknown(split)}`))
  f.rule = (method, params) => method === 'editMessageText' ? { status: 502 } : null
  const edited = f.clock.now += 1000
  await assert.rejects(f.edit({ chat_id: ANN, message_id: String(draft), text: 'Draft 2' }), failure(`Bad Gateway; edit outcome unknown: ${unknown(split)}`))
  f.rule = (method, params) => method === 'sendMessage' && params.chat_id === PEER ? { drop: true } : null
  const asked = f.clock.now += 1000
  await assert.rejects(f.reply({ chat_id: PEER, text: 'Got it?' }), failure(`reply failed after 0 Telegram messages: fetch failed; delivery unknown: ${unknown(split)}`))
  f.rule = method => method === 'setMessageReaction' ? { status: 400 } : null
  const closed = f.clock.now += 1000
  await assert.rejects(f.write('setMessageReaction', { chat_id: ANN, message_id: draft, reaction: [] }), /Bad Request/)
  await until(t, () => f.stalls().length === 1, 'the stall event to reach Codex')
  assert.deepEqual(f.stalls()[0].slice(3), [WARNING(split, closed),
    `To people, delivery unknown: chat ${OWNER} at ${iso(split)}: "abcdefghijklmnop", after 1 of its Telegram messages were sent. ${PEOPLE}`,
    `To bots, delivery unknown: chat ${PEER} at ${iso(asked)}: "Got it?". ${BOTS}`,
    `Edits, outcome unknown: chat ${ANN}, message ${draft} at ${iso(edited)}. Repeat each as it stands.`])
  assert.ok(f.logs.some(line => line.startsWith(`telegram: stall record closed: since=${iso(split)}; until=${iso(closed)}; closed by setMessageReaction; reply to chat ${OWNER} began ${iso(split)} ended ${iso(split)}; edit of message ${draft} in chat ${ANN} began ${iso(edited)} ended ${iso(edited)}; reply to chat ${PEER} began ${iso(asked)} ended ${iso(asked)}; event=telegram-stall-`)), f.logs.join('\n'))
})

test('a reply Telegram refuses with a 4xx, a reply or edit whose call never left, and the bridge\'s own notices and async messages open nothing and read as today', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  f.rule = method => method === 'sendMessage' ? { status: 400 } : null
  await assert.rejects(f.reply({ chat_id: ANN, text: 'Refused' }), failure('reply failed after 0 Telegram messages: Bad Request: chat not found'))
  // Telegram is asked whether a new chat is a bot's before the reply's own call; that read failing sends nothing.
  f.rule = method => method === 'getChatMember' ? { status: 502 } : method === 'sendMessage' ? { status: 502 } : null
  await assert.rejects(f.reply({ chat_id: NEW, text: 'Hello' }), failure(`reply failed after 0 Telegram messages: could not tell whether chat ${NEW} is a bot: Bad Gateway`))
  assert.equal(f.calls.some(call => call.method === 'sendMessage' && call.params.chat_id === NEW), false)
  await assert.rejects(f.bridge.sendNotice({ chatId: ANN, text: 'A turn shows no activity.', kind: 'stuck' }), failure('reply failed after 0 Telegram messages: Bad Gateway'))
  await assert.rejects(f.bridge.sendNotice({ chatId: ANN, text: 'Halfway there.', kind: 'message', format: 'text' }), failure('reply failed after 0 Telegram messages: Bad Gateway'))
  // A call whose control connection had already closed never leaves, a reply's or an edit's.
  f.rule = () => null
  const draft = (await f.reply({ chat_id: ANN, text: 'Draft 1' })).message_ids[0]
  const gone = new AbortController(); gone.abort(new Error('control connection closed'))
  await assert.rejects(f.reply({ chat_id: ANN, text: 'Too late' }, gone.signal), failure('reply failed after 0 Telegram messages: control connection closed'))
  await assert.rejects(f.edit({ chat_id: ANN, message_id: String(draft), text: 'Too late' }, gone.signal), failure('control connection closed'))
  assert.equal(f.calls.some(call => call.params.text === 'Too late'), false)
  await f.write()
  assert.deepEqual(f.journaled(), [])
  assert.equal(f.logs.some(line => line.includes('stall record')), false)
})

test('a reply and an edit whose control connection closed after their call left, on Codex\'s cancel or the tool server\'s own deadline alike, join the record and are named in its event', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const draft = (await f.reply({ chat_id: ANN, text: 'Draft 1' })).message_ids[0]
  const held = f.held()
  f.rule = method => ['sendMessage', 'editMessageText'].includes(method) ? held.promise : null
  // The call reaches Telegram, then its control connection closes before any answer.
  const closing = async (send, text) => {
    const connection = new AbortController(), result = send(connection.signal)
    await until(t, () => f.calls.some(call => call.params.text === text), `"${text}" to reach Telegram`)
    connection.abort(new Error('control connection closed')); return result
  }
  const began = f.clock.now += 1000
  await assert.rejects(closing(signal => f.reply({ chat_id: ANN, text: 'Never mind' }, signal), 'Never mind'),
    failure(`reply failed after 0 Telegram messages: control connection closed; delivery unknown: ${unknown(began)}`))
  const edited = f.clock.now += 1000
  await assert.rejects(closing(signal => f.edit({ chat_id: ANN, message_id: String(draft), text: 'Draft 2' }, signal), 'Draft 2'),
    failure(`control connection closed; edit outcome unknown: ${unknown(began)}`))
  held.release(); f.rule = () => null
  const closed = f.clock.now += 1000
  await f.write()
  await until(t, () => f.stalls().length === 1, 'the stall event to reach Codex')
  assert.deepEqual(f.stalls()[0].slice(3), [WARNING(began, closed), `To people, delivery unknown: chat ${ANN} at ${iso(began)}: "Never mind". ${PEOPLE}`,
    `Edits, outcome unknown: chat ${ANN}, message ${draft} at ${iso(edited)}. Repeat each as it stands.`])
})

test('a send Telegram answered and then a local error opens nothing and reads as today: a short album to a bot, and a text or a file whose record fails to save', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const files = ['a.txt', 'b.txt'].map(name => join(f.bridge.options.workspace, name)); for (const file of files) writeFileSync(file, 'x')
  const document = { message_id: 300, date: 1, chat: { id: 1, type: 'private' }, document: { file_id: 'f', file_unique_id: 'u' } }
  f.rule = method => method === 'sendMediaGroup' ? { result: [document] } : method === 'sendDocument' ? { result: document } : null
  // Telegram took one document of two.
  await assert.rejects(f.reply({ chat_id: PEER, text: 'Two files', files }), failure('reply failed after 1 Telegram messages: Telegram returned an incomplete document album'))
  // The record fails to save once Telegram answered: a text to a person, a file to a bot, and a file after a text to a person.
  const store = f.channel.store, remember = store.rememberMessage.bind(store)
  store.rememberMessage = (chatId, messageId, record) => { if (record.text === 'Saved?' || record.mediaKind === 'document') throw new Error('disk full'); return remember(chatId, messageId, record) }
  await assert.rejects(f.reply({ chat_id: ANN, text: 'Saved?' }), failure('reply failed after 1 Telegram messages: disk full'))
  await assert.rejects(f.reply({ chat_id: PEER, text: 'One file', files: [files[0]] }), failure('reply failed after 1 Telegram messages: disk full'))
  await assert.rejects(f.reply({ chat_id: ANN, text: 'With a file', files: [files[0]] }), failure('reply failed after 2 Telegram messages: disk full'))
  f.rule = () => null
  await f.write()
  assert.deepEqual(f.journaled(), [])
  assert.equal(f.logs.some(line => line.includes('stall record')), false)
})

test('a write that left before the last send ended holds nothing, and a reply still waiting at the close that then ends unknown opens a new record, named in a second event', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const typing = f.held(), late = f.held()
  f.rule = (method, params) => method === 'sendChatAction' ? typing.promise : method === 'sendMessage' && params.chat_id === OWNER ? late.promise.then(() => ({ status: 502 }))
    : method === 'sendMessage' ? { status: 502 } : null
  const early = f.write()
  await until(t, () => f.calls.some(call => call.method === 'sendChatAction'), 'the early typing call to reach Telegram')
  const first = f.clock.now += 1000
  await assert.rejects(f.reply({ chat_id: ANN, text: 'First' }), /delivery unknown/)
  const second = f.clock.now += 1000
  const waiting = assert.rejects(f.reply({ chat_id: OWNER, text: 'Second' }), failure(`reply failed after 0 Telegram messages: Bad Gateway; delivery unknown: ${unknown(second)}`))
  await until(t, () => f.calls.some(call => call.params.text === 'Second'), 'the second reply to reach Telegram')
  typing.release(); await early
  assert.deepEqual(f.journaled(), [])
  f.rule = (method, params) => method === 'sendMessage' && params.chat_id === OWNER ? late.promise.then(() => ({ status: 502 })) : null
  const closed = f.clock.now += 1000
  await f.write()
  await until(t, () => f.stalls().length === 1, 'the first stall event to reach Codex')
  assert.deepEqual(f.stalls()[0].slice(3), [WARNING(first, closed), `To people, delivery unknown: chat ${ANN} at ${iso(first)}: "First". ${PEOPLE}`])
  const ended = f.clock.now += 1000
  late.release(); await waiting
  assert.ok(f.logs.includes(`telegram: stall record opened: since=${iso(second)}; by reply to chat ${OWNER} began ${iso(second)} ended ${iso(ended)}`), f.logs.join('\n'))
  const reopened = f.clock.now += 1000
  await f.write()
  await until(t, () => f.stalls().length === 2, 'the second stall event to reach Codex')
  assert.deepEqual(f.stalls()[1].slice(3), [WARNING(second, reopened), `To people, delivery unknown: chat ${OWNER} at ${iso(second)}: "Second". ${PEOPLE}`])
})

test('a write that left while a send waited for its answer holds nothing, though Telegram answers it after the send ended', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const reply = f.held(), typing = f.held()
  f.rule = method => method === 'sendMessage' ? reply.promise.then(() => ({ status: 502 })) : method === 'sendChatAction' ? typing.promise : null
  const began = f.clock.now += 1000
  const waiting = assert.rejects(f.reply({ chat_id: ANN, text: 'Waiting' }), failure(`reply failed after 0 Telegram messages: Bad Gateway; delivery unknown: ${unknown(began)}`))
  await until(t, () => f.calls.some(call => call.params.text === 'Waiting'), 'the reply to reach Telegram')
  // A typing pulse leaves while the reply waits for its answer, and Telegram answers it only after the reply ended.
  const during = f.write()
  await until(t, () => f.calls.some(call => call.method === 'sendChatAction'), 'the typing call to reach Telegram')
  reply.release(); await waiting
  typing.release(); await during
  assert.deepEqual(f.journaled(), [])
  f.rule = () => null
  const closed = f.clock.now += 1000
  await f.write()
  await until(t, () => f.stalls().length === 1, 'the stall event to reach Codex')
  assert.deepEqual(f.stalls()[0].slice(3), [WARNING(began, closed), `To people, delivery unknown: chat ${ANN} at ${iso(began)}: "Waiting". ${PEOPLE}`])
})

test('a reply that began before the one that opened the record and ends unknown later joins it and moves since to its start', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const held = f.held()
  f.rule = (method, params) => method === 'sendMessage' && params.chat_id === OWNER ? held.promise.then(() => ({ status: 502 })) : method === 'sendMessage' ? { status: 502 } : null
  const earlier = f.clock.now += 1000
  const waiting = assert.rejects(f.reply({ chat_id: OWNER, text: 'Earlier' }), failure(`reply failed after 0 Telegram messages: Bad Gateway; delivery unknown: ${unknown(earlier)}`))
  await until(t, () => f.calls.some(call => call.params.text === 'Earlier'), 'the earlier reply to reach Telegram')
  const opener = f.clock.now += 1000
  await assert.rejects(f.reply({ chat_id: ANN, text: 'Opener' }), failure(`reply failed after 0 Telegram messages: Bad Gateway; delivery unknown: ${unknown(opener)}`))
  const joined = f.clock.now += 1000
  held.release(); await waiting
  f.rule = () => null
  const closed = f.clock.now += 1000
  await f.write()
  await until(t, () => f.stalls().length === 1, 'the stall event to reach Codex')
  const [event] = f.journaled()
  assert.equal(f.stalls()[0][1], `Telegram metadata: chat_id=${OWNER}; event=telegram_stall; since=${iso(earlier)}; until=${iso(closed)}`)
  assert.deepEqual(f.stalls()[0].slice(3), [WARNING(earlier, closed),
    `To people, delivery unknown: chat ${ANN} at ${iso(opener)}: "Opener"; chat ${OWNER} at ${iso(earlier)}: "Earlier". ${PEOPLE}`])
  assert.ok(f.logs.includes(`telegram: stall record closed: since=${iso(earlier)}; until=${iso(closed)}; closed by sendChatAction; reply to chat ${ANN} began ${iso(opener)} ended ${iso(opener)}; reply to chat ${OWNER} began ${iso(earlier)} ended ${iso(joined)}; event=${event.eventId}`), f.logs.join('\n'))
})

test('with no write from Codex the probe closes the record: setMyCommands with the commands polling set, a minute after the record opened and a minute after each probe that settled', { timeout: 30_000 }, async t => {
  assert.equal(PROBE_MS, 60_000); assert.equal(new StallRecord({}).probeMs, PROBE_MS)
  const f = await fixture(t)
  // The minute, cut to a span the stand-in can time; a timer counts from its loop's clock in whole ms, hence the slack.
  const wait = f.channel.stall.probeMs = 300, slack = 5
  // Polling starts and sets its commands; its first poll then waits until the channel stops.
  const polls = f.held()
  let sets = 0
  f.rule = method => method === 'getUpdates' ? polls.promise : method === 'sendMessage' ? { status: 502 } : method === 'setMyCommands' && ++sets === 2 ? { status: 502 } : null
  f.channel.pollPromise = f.channel.poll()
  await until(t, () => f.calls.some(call => call.method === 'getUpdates'), 'polling to set its commands and start its first poll')
  const began = f.clock.now += 1000
  await assert.rejects(f.reply({ chat_id: ANN, text: 'Quiet' }), /delivery unknown/)
  await until(t, () => f.stalls().length === 1, 'the probe to close the record and its event to reach Codex')
  const [polling, ...probes] = f.calls.filter(call => call.method === 'setMyCommands')
  assert.equal(probes.length, 2)
  // The first probe waits from the record's opening, which follows Telegram's answer to the reply; the second from the first's answer.
  const opener = f.calls.find(call => call.params.text === 'Quiet')
  for (const [probe, after] of [[probes[0], opener], [probes[1], probes[0]]])
    assert.ok(probe.at - after.answeredAt >= wait - slack, `a probe left ${Math.round(probe.at - after.answeredAt)} ms after the answer before it`)
  assert.deepEqual(JSON.parse(polling.params.commands).map(command => command.command), ['start', 'help', 'status', 'model', 'reasoning'])
  for (const probe of probes) assert.deepEqual(probe.params, polling.params)
  assert.ok(f.logs.some(line => line.startsWith(`telegram: stall record closed: since=${iso(began)}; until=${iso(f.clock.now)}; closed by setMyCommands (probe); reply to chat ${ANN}`)), f.logs.join('\n'))
  // Closed, the record runs no probe.
  assert.equal(f.channel.stall.timer, null)
})

test('before polling has set its commands the probe skips its round, and the record stays open until a write closes it', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  // Polling never starts here, so the channel has no commands to send; the minute is cut to a span the test can wait out.
  f.channel.stall.probeMs = 50
  const probe = f.channel.stall.probe; let rounds = 0
  f.channel.stall.probe = () => { rounds += 1; return probe() }
  f.rule = method => method === 'sendMessage' ? { status: 502 } : null
  const began = f.clock.now += 1000
  await assert.rejects(f.reply({ chat_id: ANN, text: 'Early' }), failure(`reply failed after 0 Telegram messages: Bad Gateway; delivery unknown: ${unknown(began)}`))
  // Two rounds, or a setMyCommands, whichever comes first, so a probe that goes anyway fails on the assertion below.
  await until(t, () => rounds >= 2 || f.calls.some(call => call.method === 'setMyCommands'), 'two probe rounds')
  assert.equal(f.calls.some(call => call.method === 'setMyCommands'), false)
  assert.deepEqual(f.journaled(), [])
  f.rule = () => null
  const closed = f.clock.now += 1000
  await f.write()
  await until(t, () => f.stalls().length === 1, 'the stall event to reach Codex')
  assert.deepEqual(f.stalls()[0].slice(3), [WARNING(began, closed), `To people, delivery unknown: chat ${ANN} at ${iso(began)}: "Early". ${PEOPLE}`])
})

test('a reply whose message with buttons went unanswered is named under Cards, not To people, and a press on its copy made after the close still counts', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  f.rule = method => method === 'sendMessage' ? { status: 502 } : null
  const asked = f.clock.now += 1000
  await assert.rejects(f.reply({ chat_id: OWNER, text: 'Ship it?', buttons: [['Yes', 'No']] }),
    failure(`reply failed after 0 Telegram messages: Bad Gateway; whether the message with the buttons arrived is unknown, and a press on it still counts; delivery unknown: ${unknown(asked)}`))
  f.rule = () => null
  const closed = f.clock.now += 1000
  await f.write()
  await until(t, () => f.stalls().length === 1, 'the stall event to reach Codex')
  assert.deepEqual(f.stalls()[0].slice(3), [WARNING(asked, closed), `Cards, delivery unknown: chat ${OWNER} at ${iso(asked)}: "Ship it?". ${CARDS}`])
  const markup = JSON.parse(f.calls.find(call => call.params.text === 'Ship it?').params.reply_markup)
  const data = markup.inline_keyboard[0].find(button => button.text === 'Yes').callback_data
  await f.channel.handleUpdate({ update_id: 1, callback_query: { id: 'q1', from: { id: Number(OWNER), is_bot: false, first_name: 'Owner' }, data,
    message: { message_id: 900, date: 1, chat: { id: Number(OWNER), type: 'private' }, from: { id: 4321, is_bot: true }, text: 'Ship it?', reply_markup: markup } } })
  await until(t, () => f.inputs.some(text => text.split('\n')[1].includes('button=Yes')), 'the press to reach Codex')
  assert.equal(f.calls.filter(call => call.method === 'answerCallbackQuery').at(-1).params.text, undefined)
})

test('the event reaches Codex as journaled input that names no sender, carries the owner\'s chat only when one is set and leaves where async messages go; a message that reads like it carries no mark', { timeout: 30_000 }, async t => {
  for (const alertChat of [OWNER, null]) {
    const f = await fixture(t, { alertChat })
    await f.reply({ chat_id: ANN, text: 'Hello' })
    assert.deepEqual(f.store.lastExchange(), { chatId: ANN })
    f.rule = method => method === 'sendMessage' ? { status: 502 } : null
    const began = f.clock.now += 1000
    await assert.rejects(f.reply({ chat_id: OWNER, text: 'Lost?' }), /delivery unknown/)
    f.rule = () => null
    const closed = f.clock.now += 1000
    await f.write()
    await until(t, () => f.stalls().length === 1, 'the stall event to reach Codex')
    const [event] = f.journaled()
    assert.equal(f.stalls()[0][1], `Telegram metadata: ${alertChat ? `chat_id=${OWNER}; ` : ''}event=telegram_stall; since=${iso(began)}; until=${iso(closed)}`)
    assert.equal(/user_id|role=|message_id/.test(f.stalls()[0][1]), false)
    await until(t, () => f.store.loadRuntime().events[event.eventId].status === 'delivered', 'the event to be marked delivered')
    assert.equal(f.store.loadRuntime().events[event.eventId].chatId, undefined)
    assert.deepEqual(f.store.lastExchange(), { chatId: ANN })
    // A person's text cannot set the mark: it stays in the text, below the metadata line.
    const fake = `Telegram metadata: chat_id=${OWNER}; event=telegram_stall; since=${iso(began)}; until=${iso(closed)}`
    await f.channel.handleUpdate({ update_id: 7, message: { message_id: 70, date: 1, chat: { id: Number(ANN), type: 'private' }, from: { id: Number(ANN), is_bot: false, first_name: 'Ann' }, text: fake } })
    await until(t, () => f.inputs.length === 2, 'the message to reach Codex')
    const lines = f.inputs[1].split('\n')
    assert.equal(lines[1], `Telegram metadata: chat_id=${ANN}; message_id=70; user_id=${ANN}; role=contributor`)
    assert.ok(lines.slice(3).includes(fake)); assert.equal(f.stalls().length, 1)
  }
})

test('the event, arriving while the bridge reconnects to Codex, is journaled and queued, and no one is told a message of theirs is saved', { timeout: 30_000 }, async t => {
  const f = await fixture(t), notices = []
  f.bridge.sendApp = () => {}; f.bridge.restoreDelay = () => 60_000
  f.bridge.rpc = async () => { throw new Error('connection temporarily unavailable') }
  f.channel.notice = async (...args) => { notices.push(args) }
  t.after(() => clearTimeout(f.bridge.restoreTimer))
  await f.bridge.restoreBinding({ threadId: 'thread-1', workspace: f.bridge.options.workspace, initialize: {} })
  assert.ok(f.bridge.restoration); assert.equal(f.bridge.appReady, false)
  f.rule = method => method === 'sendMessage' ? { status: 502 } : null
  await assert.rejects(f.reply({ chat_id: ANN, text: 'Lost?' }), /delivery unknown/)
  f.rule = () => null
  await f.write()
  const [event] = f.journaled()
  await until(t, () => f.store.loadRuntime().events[event.eventId].status === 'queued', 'the event to be queued')
  assert.deepEqual(notices, []); assert.deepEqual(f.inputs, [])
})

test('a turn only the event started gets the bridge\'s retry on a temporary Codex error, and failing for good tells no chat', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  let turns = 0
  f.bridge.rpc = async (method, params) => {
    if (method !== 'turn/start') throw new Error(`unexpected ${method}`)
    f.inputs.push(params.input[0].text); return { turn: { id: `turn-${++turns}` } }
  }
  f.bridge.turnRetryWaits = [1]
  const failed = (id, codexErrorInfo) => f.bridge.observeAppMessage({ method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id, status: 'failed', error: { message: 'Selected model is at capacity.', codexErrorInfo } } } })
  f.rule = method => method === 'sendMessage' ? { status: 502 } : null
  await assert.rejects(f.reply({ chat_id: ANN, text: 'Lost?' }), /delivery unknown/)
  f.rule = () => null
  await f.write()
  const [event] = f.journaled()
  await until(t, () => f.store.loadRuntime().events[event.eventId].turnId === 'turn-1', 'the event to start a turn')
  failed('turn-1', 'serverOverloaded')
  await until(t, () => f.inputs.length === 2, 'the bridge to start its retry turn')
  assert.match(f.inputs[1], /Continue the work from where it stopped/)
  const sent = f.calls.length
  failed('turn-2', 'usageLimitExceeded')
  await f.bridge.monitor.settle()
  assert.equal(f.bridge.turnRetry, null)
  assert.deepEqual(f.calls.slice(sent).filter(call => call.method === 'sendMessage'), [])
})
