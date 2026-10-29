import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { StateStore } from '../src/core.js'
import { TelegramChannel, TelegramError } from '../src/telegram.js'
import { ANSWERED, CLOSED, MAX_QUESTIONS, NOT_ON_MESSAGE, REPLACED, chosenKeyboard, labelProblem, parseButtons, parseQuestionData } from '../src/questions.js'
import { GeliosBridge } from '../scripts/bridge.js'

const TOKEN = `4321:${'q'.repeat(32)}`
const GROUP = '-1001234567890'
const OWNER = { '123': { chatId: '123', alias: 'Owner', role: 'admin' } }

function fixture(t, { users = OWNER, groups = {}, stateDir } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-questions-')), workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const store = new StateStore(stateDir || join(root, 'state')), events = [], calls = [], logs = []
  store.saveAccess({ version: 2, dmPolicy: 'allowlist', pending: {}, groups, mentionPatterns: [], users })
  const f = { store, events, calls, logs, root, workspace, behave: null }
  f.channel = new TelegramChannel({ store, workspaceRoot: workspace, token: TOKEN,
    // As the bridge does once Codex took the input.
    onInbound: async (event, prepare) => { events.push(await prepare()); store.markEvent(event.eventId, 'delivered') }, log: line => logs.push(line) })
  f.channel.batcher.gap = () => 0
  f.channel.learnPeer({ id: 123, is_bot: false })
  f.channel.polling = true
  let next = 100
  f.channel.api.call = async (method, params, options) => {
    // As TelegramApi.request does: the last check runs just before the request leaves.
    options?.beforeSend?.()
    calls.push({ method, params })
    const scripted = f.behave && await f.behave(method, params, options)
    return scripted ?? { message_id: ++next, chat: { id: Number(params.chat_id) || 0 } }
  }
  t.after(() => f.channel.stop())
  return f
}
let updates = 0
// A press as Telegram delivers it: the bot's message, with the keyboard it carries, and the presser.
function pressUpdate(markup, label, { messageId, chat = { id: 123, type: 'private' }, from = { id: 123, is_bot: false, first_name: 'Owner' }, thread, text = 'Ship it today?', bot = 4321 } = {}) {
  const button = markup.inline_keyboard.flat().find(item => item.text === label)
  return { update_id: ++updates, callback_query: { id: `q${updates}`, from, data: button.callback_data,
    message: { message_id: messageId, date: 1, chat, from: { id: bot, is_bot: true }, text, reply_markup: markup,
      ...(thread ? { is_topic_message: true, message_thread_id: thread } : {}) } } }
}
const answers = f => f.calls.filter(call => call.method === 'answerCallbackQuery').map(call => call.params.text ?? '')
const records = f => Object.values(f.store.loadRuntime().questions?.records || {})
const lastMarkup = f => f.calls.filter(call => call.params.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).at(-1).params.reply_markup
const gate = () => { let open; const opened = new Promise(done => { open = done }); return { open, opened } }
const timeout = () => Object.assign(new Error('Telegram request timed out'), { name: 'AbortError' })
const until = async (check, what) => { for (let tries = 0; tries < 300; tries += 1) { if (check()) return; await new Promise(done => setTimeout(done, 5)) } assert.fail(`timed out waiting for ${what}`) }
const copy = value => JSON.parse(JSON.stringify(value))

test('button labels and shapes are checked before anything is sent, and callback data stays inside 64 bytes', () => {
  assert.deepEqual(parseButtons([['Yes', 'No'], ['Later']], false), [['Yes', 'No'], ['Later']])
  assert.deepEqual(parseButtons([], true), [])
  for (const [rows, message] of [
    [[], /an empty list is refused/], [[[]], /1 to 4 rows of 1 to 4 labels/], [[['a'], ['b'], ['c'], ['d'], ['e']], /1 to 4 rows/],
    [[['a', 'b', 'c', 'd', 'e']], /1 to 4 rows/], [[['Yes', 'Yes']], /appears twice/], [[['x'.repeat(41)]], /is 41 characters/],
    [[['a;b']], /semicolon/], [[['a=b']], /equals sign/], [[[' lead']], /single spaces/], [[['​']], /blank/], [[['\uD800']], /lone surrogate/],
    [[['a\u0007']], /control character/], [[[7]], /each a string/], ['Yes', /1 to 4 rows/],
  ]) assert.throws(() => parseButtons(rows, false), message)
  assert.equal(labelProblem('Ship ✅ / hold'), undefined)
  assert.equal(labelProblem('😀'.repeat(40)), undefined)
  assert.equal(parseQuestionData('gcq:0123456789abcdef:1:15').index, 15)
  for (const bad of ['gct:0123456789abcdef:1:0', 'gcq:0123456789abcdef:0:0', 'gcq:XYZ:1:0', 'gcq:0123456789abcdef:1:100']) assert.equal(parseQuestionData(bad), null)
})

test('Q01: two presses on one question commit one answer; it reaches Codex once, and the keyboard then shows the choice', async t => {
  const f = fixture(t)
  writeFileSync(f.store.configPath, JSON.stringify({ textChunkLimit: 8, chunkMode: 'length' }))
  const result = await f.channel.sendReply({ chat_id: '123', text: 'Ship it today?', format: 'text', buttons: [['Yes', 'No'], ['Later']] })
  const sends = f.calls.filter(call => call.method === 'sendMessage')
  // Only the last part carries the keyboard.
  assert.equal(sends.length, 2); assert.equal(sends[0].params.reply_markup, undefined)
  const markup = sends[1].params.reply_markup, messageId = result.message_ids.at(-1)
  assert.deepEqual(markup.inline_keyboard.map(row => row.map(button => button.text)), [['Yes', 'No'], ['Later']])
  assert.ok(markup.inline_keyboard.flat().every(button => Buffer.byteLength(button.callback_data) <= 64))
  assert.deepEqual(records(f).map(record => [record.status, record.messageId]), [['live', String(messageId)]])
  await Promise.all([f.channel.handleUpdate(pressUpdate(markup, 'No', { messageId })), f.channel.handleUpdate(pressUpdate(markup, 'Yes', { messageId }))])
  assert.equal(f.events.length, 1)
  const [event] = f.events
  assert.equal(event.button, 'No'); assert.equal(event.eventId, `telegram-answer-${records(f)[0].id}-1`)
  assert.equal(event.text, `Pressed "No" on message ${messageId}: "Ship it today?"`)
  assert.deepEqual(answers(f).sort(), ['', ANSWERED].sort())
  const swaps = f.calls.filter(call => call.method === 'editMessageReplyMarkup')
  assert.deepEqual(swaps.map(call => call.params.reply_markup), [chosenKeyboard('No')])
  assert.deepEqual(records(f).map(record => [record.status, record.swap, record.answer.label]), [['taken', undefined, 'No']])
  // A later press reads as answered; the swap already landed, so nothing is edited again.
  await f.channel.handleUpdate(pressUpdate(markup, 'Later', { messageId }))
  assert.equal(answers(f).at(-1), ANSWERED); assert.equal(f.events.length, 1)
  assert.equal(f.calls.filter(call => call.method === 'editMessageReplyMarkup').length, 1)
})

test('Q01: in a group the first admitted member answers without a mention; others, bots and strangers commit nothing', async t => {
  const f = fixture(t, { groups: { [GROUP]: { requireMention: true, allowFrom: ['700', '701'] } } })
  const result = await f.channel.sendReply({ chat_id: GROUP, text: 'Which build?', format: 'text', message_thread_id: '9', buttons: [['A', 'B']] })
  const markup = lastMarkup(f), messageId = result.message_ids[0], chat = { id: Number(GROUP), type: 'supergroup' }
  assert.equal(f.calls[0].params.message_thread_id, 9)
  await f.channel.handleUpdate(pressUpdate(markup, 'A', { messageId, chat, thread: 9, from: { id: 999, first_name: 'Stranger' } }))
  await f.channel.handleUpdate(pressUpdate(markup, 'A', { messageId, chat, thread: 9, from: { id: 701, is_bot: true } }))
  await f.channel.handleUpdate(pressUpdate(markup, 'A', { messageId, chat, thread: 8, from: { id: 700, first_name: 'Member' } }))
  assert.deepEqual(answers(f), ['', '', NOT_ON_MESSAGE]); assert.equal(f.events.length, 0)
  await Promise.all([700, 701].map(id => f.channel.handleUpdate(pressUpdate(markup, id === 700 ? 'B' : 'A', { messageId, chat, thread: 9, from: { id, first_name: `M${id}` } }))))
  assert.equal(f.events.length, 1)
  assert.deepEqual([f.events[0].userId, f.events[0].role, f.events[0].chatType, f.events[0].threadId, f.events[0].button], ['700', 'contributor', 'supergroup', '9', 'B'])
  assert.equal(answers(f).at(-1), ANSWERED)
  assert.deepEqual(JSON.parse(readFileSync(f.store.accessPath, 'utf8')).groups[GROUP].allowFrom, ['700', '701'])
})

test('Q05: a press during the send binds its reservation; a late send result never reopens it, and only matching evidence binds', async t => {
  const f = fixture(t, { users: { ...OWNER, '456': { chatId: '456', alias: 'Other', role: 'contributor' } } })
  const held = gate(); let markup
  f.behave = async (method, params) => { if (method === 'sendMessage' && params.reply_markup) { markup = params.reply_markup; await held.opened; return { message_id: 500, chat: { id: 123 } } } }
  const reply = f.channel.sendReply({ chat_id: '123', text: 'Go?', format: 'text', buttons: [['Go', 'Stop']] })
  await until(() => markup, 'the keyboard send')
  assert.equal(records(f)[0].status, 'prepared')
  // Evidence that does not match the reservation binds nothing.
  await f.channel.handleUpdate(pressUpdate(markup, 'Go', { messageId: 500, bot: 9999 }))
  await f.channel.handleUpdate(pressUpdate(markup, 'Go', { messageId: 500, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false } }))
  const forged = copy(markup); forged.inline_keyboard[0][0].callback_data = forged.inline_keyboard[0][0].callback_data.replace(/:1:0$/, ':2:0')
  await f.channel.handleUpdate(pressUpdate(forged, 'Go', { messageId: 500 }))
  assert.deepEqual(answers(f), [NOT_ON_MESSAGE, NOT_ON_MESSAGE, REPLACED]); assert.equal(records(f)[0].status, 'prepared')
  await f.channel.handleUpdate(pressUpdate(markup, 'Stop', { messageId: 500 }))
  assert.equal(records(f)[0].status, 'taken'); assert.equal(f.events.length, 1)
  held.open(); await reply
  assert.deepEqual(records(f).map(record => [record.status, record.messageId]), [['taken', '500']])
})

test('Q05: an unknown send outcome stays open to one matching press; a refused keyboard is never sent again as plain text', async t => {
  const f = fixture(t)
  let markup
  f.behave = async (method, params) => { if (params.reply_markup && method === 'sendMessage') { markup = params.reply_markup; throw timeout() } }
  await assert.rejects(f.channel.sendReply({ chat_id: '123', text: 'Deploy?', format: 'text', buttons: [['Yes']] }), /whether the message with the buttons arrived is unknown/)
  assert.equal(records(f)[0].status, 'uncertain')
  await f.channel.handleUpdate(pressUpdate(markup, 'Yes', { messageId: 610 }))
  assert.deepEqual(records(f).map(record => [record.status, record.messageId]), [['taken', '610']]); assert.equal(f.events.length, 1)
  // Rich: Telegram refusing the keyboard fails the reply at once, with no plain copy and no open question.
  const g = fixture(t); let sent = 0
  g.behave = async method => { if (method === 'sendRichMessage' || method === 'sendMessage') { sent += 1; throw new TelegramError('Bad Request: BUTTON_DATA_INVALID', 400) } }
  await assert.rejects(g.channel.sendReply({ chat_id: '123', text: '**Deploy?**', buttons: [['Yes']] }), /BUTTON_DATA_INVALID/)
  assert.equal(sent, 1); assert.deepEqual(records(g), [])
  // Refused before the carrier: the record ends, and a press on its data reads as closed.
  const h = fixture(t); let first = true
  writeFileSync(h.store.configPath, JSON.stringify({ textChunkLimit: 4, chunkMode: 'length' }))
  h.behave = async method => { if (method === 'sendMessage' && first) { first = false; throw new TelegramError('Forbidden: bot was blocked by the user', 403) } }
  await assert.rejects(h.channel.sendReply({ chat_id: '123', text: 'abcdefgh', format: 'text', buttons: [['Yes']] }), /blocked/)
  assert.deepEqual(records(h), [])
  // Files: the keyboard rides on the last file only.
  const k = fixture(t); const uploads = []
  writeFileSync(join(k.workspace, 'a.txt'), 'a'); writeFileSync(join(k.workspace, 'b.txt'), 'b')
  k.channel.api.multipart = async (method, fields) => { uploads.push(fields); return { message_id: 700 + uploads.length } }
  await k.channel.sendReply({ chat_id: '123', text: 'files', format: 'text', files: [join(k.workspace, 'a.txt'), join(k.workspace, 'b.txt')], buttons: [['Ok']] })
  assert.equal(k.calls.find(call => call.method === 'sendMessage').params.reply_markup, undefined)
  assert.deepEqual(uploads.map(fields => Boolean(fields.reply_markup)), [false, true])
  assert.deepEqual(records(k).map(record => [record.status, record.messageId]), [['live', '702']])
})

// Q04: every edit outcome, with a press on the old or the new keyboard before, during or after the edit.
// At most one answer is ever accepted, and only for a keyboard the record still names.
const OUTCOMES = {
  ok: () => undefined,
  'not modified': () => { throw new TelegramError('Bad Request: message is not modified', 400) },
  refused: () => { throw new TelegramError('Bad Request: REPLY_MARKUP_INVALID', 400) },
  gone: () => { throw new TelegramError('Bad Request: message to edit not found', 400) },
  unknown: () => { throw timeout() },
}
// What a press gets after the edit settled, on the old keyboard and on the new one.
const AFTER = { ok: [REPLACED, true], 'not modified': [REPLACED, true], refused: [true, REPLACED], gone: [CLOSED, CLOSED], unknown: [REPLACED, true] }
for (const [outcome, result] of Object.entries(OUTCOMES)) {
  test(`Q04: an edit that ends ${outcome} keeps one revision whichever keyboard is pressed, before, during or after it`, async t => {
    for (const [when, which] of [['before', 'old'], ['during', 'old'], ['during', 'new'], ['after', 'old'], ['after', 'new']]) {
      const f = fixture(t)
      const sent = await f.channel.sendReply({ chat_id: '123', text: 'Pick', format: 'text', buttons: [['A', 'B']] })
      const messageId = sent.message_ids[0], old = lastMarkup(f)
      if (when === 'before') await f.channel.handleUpdate(pressUpdate(old, 'A', { messageId }))
      const held = gate(); let fresh
      f.behave = async (method, params) => {
        if (method !== 'editMessageReplyMarkup' || params.reply_markup?.inline_keyboard?.[0]?.[0]?.disabled) return
        fresh = params.reply_markup; await held.opened; return result() ?? true
      }
      const edit = f.channel.editMessage({ chat_id: '123', message_id: String(messageId), buttons: [['C']] }).then(() => 'ok', error => error)
      await until(() => fresh, 'the edit call')
      // A press during the edit is judged at once; its swap waits for the edit, so it is not awaited here.
      let pressing
      if (when === 'during') {
        const answered = answers(f).length
        pressing = f.channel.handleUpdate(pressUpdate(which === 'old' ? old : fresh, which === 'old' ? 'A' : 'C', { messageId }))
        await until(() => answers(f).length > answered, 'the press answer')
      }
      held.open(); const ended = await edit; await pressing
      if (outcome === 'unknown') assert.match(ended.message, /whether the edit landed is unknown/)
      if (when === 'after') await f.channel.handleUpdate(pressUpdate(which === 'old' ? old : fresh, which === 'old' ? 'A' : 'C', { messageId }))
      const expected = when === 'before' ? true : when === 'during' ? (which === 'old' ? REPLACED : true) : AFTER[outcome][which === 'old' ? 0 : 1]
      const label = `${outcome}/${when}/${which}`
      assert.ok(f.events.length <= 1, label)
      if (expected === true) {
        assert.equal(f.events.length, 1, label); assert.equal(f.events[0].button, which === 'old' ? 'A' : 'C', label)
        assert.equal(answers(f).at(-1), '', label)
      } else { assert.equal(f.events.length, 0, label); assert.equal(answers(f).at(-1), expected, label) }
      // No keyboard revision ever commits a second answer. An edit after an answer asks a new question, so a press
      // on its new keyboard may answer that revision once.
      for (const [markup, button] of [[old, 'B'], [fresh, 'C'], [old, 'A'], [fresh, 'C']]) await f.channel.handleUpdate(pressUpdate(markup, button, { messageId }))
      const ids = f.events.map(event => event.eventId)
      assert.equal(new Set(ids).size, ids.length, label)
      assert.ok(ids.length <= (when === 'before' ? 2 : 1), label)
    }
  })
}

test('Q04: text alone removes the buttons, buttons alone keep the text, an empty list removes them, and neither is refused', async t => {
  const f = fixture(t)
  const sent = await f.channel.sendReply({ chat_id: '123', text: 'Pick', format: 'text', buttons: [['A']] })
  const messageId = String(sent.message_ids[0]), first = lastMarkup(f)
  const before = f.calls.length
  await assert.rejects(f.channel.editMessage({ chat_id: '123', message_id: messageId }), /needs text, buttons or both; nothing was edited/)
  await assert.rejects(f.channel.editMessage({ chat_id: '123', message_id: messageId, buttons: [['A', 'A']] }), /appears twice; .*nothing was edited/)
  await assert.rejects(f.channel.editMessage({ chat_id: '123', message_id: messageId, format: 'text', buttons: [['B']] }), /format applies only to text/)
  assert.equal(f.calls.length, before)
  await f.channel.editMessage({ chat_id: '123', message_id: messageId, buttons: [['B']] })
  assert.deepEqual([f.calls.at(-1).method, f.calls.at(-1).params.text, f.calls.at(-1).params.reply_markup.inline_keyboard[0][0].text], ['editMessageReplyMarkup', undefined, 'B'])
  assert.equal(records(f)[0].revision, 2)
  await f.channel.editMessage({ chat_id: '123', message_id: messageId, text: 'Changed', format: 'text' })
  assert.deepEqual([f.calls.at(-1).method, f.calls.at(-1).params.reply_markup], ['editMessageText', undefined])
  assert.deepEqual(records(f), [])
  await f.channel.handleUpdate(pressUpdate(first, 'A', { messageId: Number(messageId) }))
  assert.equal(answers(f).at(-1), CLOSED)
  await f.channel.editMessage({ chat_id: '123', message_id: messageId, text: 'Again', format: 'text', buttons: [['C']] })
  assert.equal(f.calls.at(-1).params.reply_markup.inline_keyboard[0][0].text, 'C')
  await f.channel.editMessage({ chat_id: '123', message_id: messageId, buttons: [] })
  assert.deepEqual([f.calls.at(-1).method, f.calls.at(-1).params.reply_markup], ['editMessageReplyMarkup', undefined])
  assert.deepEqual(records(f), [])
})

test('Q04 and Q05: a send or edit stopped before its request left changes nothing, so the old keyboard still answers', async t => {
  const f = fixture(t)
  const sent = await f.channel.sendReply({ chat_id: '123', text: 'Pick', format: 'text', buttons: [['A']] })
  const messageId = sent.message_ids[0], old = lastMarkup(f)
  // Access changes between the checks before the edit and its request: nothing leaves, and the edit is refused.
  const destination = f.store.destination.bind(f.store); let revoked = false
  f.store.destination = chat => { if (revoked) throw Object.assign(new Error('Telegram destination is not paired'), { permanent: true }); return destination(chat) }
  const edit = f.channel.editMessage({ chat_id: '123', message_id: String(messageId), buttons: [['B']] })
  revoked = true
  await assert.rejects(edit, /not paired/)
  revoked = false
  assert.equal(f.calls.filter(call => call.method === 'editMessageReplyMarkup').length, 0)
  assert.deepEqual(records(f).map(record => [record.status, record.revision]), [['live', 1]])
  await f.channel.handleUpdate(pressUpdate(old, 'A', { messageId }))
  assert.equal(f.events.length, 1)
  // A reply whose last part never left: its question ends instead of staying uncertain, and the tool says nothing about an unknown outcome.
  const g = fixture(t); const gDestination = g.store.destination.bind(g.store); let parts = 0
  g.store.destination = chat => { if (parts >= 1) throw Object.assign(new Error('Telegram destination is not paired'), { permanent: true }); return gDestination(chat) }
  writeFileSync(g.store.configPath, JSON.stringify({ textChunkLimit: 4, chunkMode: 'length' }))
  g.behave = async method => { if (method === 'sendMessage') parts += 1 }
  await assert.rejects(g.channel.sendReply({ chat_id: '123', text: 'abcdefgh', format: 'text', buttons: [['Yes']] }), error => /not paired/.test(error.message) && !/is unknown/.test(error.message))
  assert.equal(g.calls.filter(call => call.method === 'sendMessage').length, 1)
  assert.deepEqual(records(g), [])
})

test('Q04: a swap in flight finishes before a later edit sets new buttons, so the newer keyboard is never overwritten', async t => {
  const f = fixture(t)
  const sent = await f.channel.sendReply({ chat_id: '123', text: 'Pick', format: 'text', buttons: [['A']] })
  const messageId = sent.message_ids[0], markup = lastMarkup(f), held = gate()
  f.behave = async (method, params) => { if (method === 'editMessageReplyMarkup' && params.reply_markup?.inline_keyboard?.[0]?.[0]?.disabled) { await held.opened; return true } }
  const pressed = f.channel.handleUpdate(pressUpdate(markup, 'A', { messageId }))
  for (let tries = 0; !f.calls.some(call => call.params.reply_markup?.inline_keyboard?.[0]?.[0]?.disabled) && tries < 200; tries += 1) await new Promise(done => setImmediate(done))
  const edit = f.channel.editMessage({ chat_id: '123', message_id: String(messageId), buttons: [['Next']] })
  await new Promise(done => setTimeout(done, 20))
  assert.equal(f.calls.filter(call => call.method === 'editMessageReplyMarkup').length, 1)
  held.open(); await pressed; await edit
  const edits = f.calls.filter(call => call.method === 'editMessageReplyMarkup').map(call => call.params.reply_markup.inline_keyboard[0][0].text)
  assert.deepEqual(edits, ['A', 'Next'])
  assert.deepEqual(records(f).map(record => [record.status, record.revision]), [['live', 2]])
})

test('Q06: question capacity protects undelivered answers; the oldest settled ones go first, and an evicted question reads as closed', async t => {
  const f = fixture(t)
  const runtime = f.store.loadRuntime(); const recordsById = {}
  for (let i = 0; i < MAX_QUESTIONS; i += 1) {
    const id = i.toString(16).padStart(16, '0'), eventId = `telegram-answer-${id}-1`
    recordsById[id] = { id, chatId: '123', messageId: String(1000 + i), revision: 1, status: 'taken', previous: null, createdAt: i, updatedAt: i,
      answer: { label: 'Yes', senderId: '123', eventId, at: i } }
    runtime.events[eventId] = { source: 'Telegram', eventId, sequence: ++runtime.sequence, status: 'received', createdAt: i, updatedAt: i, payload: { eventId } }
  }
  runtime.questions = { version: 1, records: recordsById }
  f.store.saveRuntime(runtime)
  await assert.rejects(f.channel.sendReply({ chat_id: '123', text: 'More?', format: 'text', buttons: [['Yes']] }), /all 1000 question slots hold answers still being delivered/)
  assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 0)
  assert.equal(records(f).length, MAX_QUESTIONS)
  // Two answers are delivered: the oldest of them goes when room is needed, and the other stays.
  f.store.markEvent('telegram-answer-0000000000000005-1', 'delivered'); f.store.markEvent('telegram-answer-0000000000000009-1', 'delivered')
  await f.channel.sendReply({ chat_id: '123', text: 'More?', format: 'text', buttons: [['Yes']] })
  const left = new Set(records(f).map(record => record.id))
  assert.equal(left.size, MAX_QUESTIONS); assert.equal(left.has('0000000000000005'), false); assert.equal(left.has('0000000000000009'), true)
  const evicted = { inline_keyboard: [[{ text: 'Yes', callback_data: 'gcq:0000000000000005:1:0' }]] }
  await f.channel.handleUpdate(pressUpdate(evicted, 'Yes', { messageId: 1005 }))
  assert.equal(answers(f).at(-1), CLOSED); assert.equal(f.events.length, 0)
})

test('buttons are refused for a bot, while another process may be polling, and before anything is journaled', async t => {
  const f = fixture(t, { users: { ...OWNER, '777': { chatId: '777', alias: 'peer', role: 'contributor' } } })
  f.channel.learnPeer({ id: 777, is_bot: true })
  const events = Object.keys(f.store.loadRuntime().events).length
  await assert.rejects(f.channel.sendReply({ chat_id: '777', text: 'x', buttons: [['A']] }), /buttons are refused in a bot's chat: a bot cannot press one; nothing was sent/)
  f.store.rememberMessage('777', '5', { text: 'old', sender: { name: 'Codex', isBot: true, isSelf: true } })
  await assert.rejects(f.channel.editMessage({ chat_id: '777', message_id: '5', buttons: [['A']] }), /a bot cannot press one; nothing was edited/)
  f.channel.pollConflict = true
  await assert.rejects(f.channel.sendReply({ chat_id: '123', text: 'x', buttons: [['A']] }), /ended in a conflict \(409\)/)
  f.channel.pollConflict = false; f.channel.polling = false
  await assert.rejects(f.channel.sendReply({ chat_id: '123', text: 'x', buttons: [['A']] }), /this bridge is not polling the bot/)
  assert.equal(f.calls.filter(call => call.method !== 'getChatMember').length, 0)
  assert.equal(Object.keys(f.store.loadRuntime().events).length, events); assert.deepEqual(records(f), [])
  // Inline-mode presses, and presses on a button Telegram returned without its keyboard, commit nothing.
  f.channel.polling = true
  const sent = await f.channel.sendReply({ chat_id: '123', text: 'Pick', format: 'text', buttons: [['A']] })
  const markup = lastMarkup(f), inline = pressUpdate(markup, 'A', { messageId: sent.message_ids[0] })
  delete inline.callback_query.message; inline.callback_query.inline_message_id = 'abc'
  const bodyButton = pressUpdate(markup, 'A', { messageId: sent.message_ids[0] }); delete bodyButton.callback_query.message.reply_markup
  for (const update of [inline, bodyButton]) await f.channel.handleUpdate(update)
  assert.deepEqual(answers(f), [NOT_ON_MESSAGE, NOT_ON_MESSAGE]); assert.equal(f.events.length, 0)
})

test('a press is answered at once while its delivery waits, and a swap Telegram did not take is retried at the next start', async t => {
  const f = fixture(t)
  const sent = await f.channel.sendReply({ chat_id: '123', text: 'Pick', format: 'text', buttons: [['A']] })
  const markup = lastMarkup(f)
  f.channel.onInbound = () => new Promise(() => {})
  f.channel.retryDelay = () => 5
  let refusals = 2
  f.behave = async (method, params) => { if (method === 'editMessageReplyMarkup' && params.reply_markup.inline_keyboard[0][0].disabled && refusals-- > 0) throw new TelegramError('Too Many Requests: retry after 1', 429) }
  await f.channel.handleUpdate(pressUpdate(markup, 'A', { messageId: sent.message_ids[0] }), { background: true })
  assert.deepEqual(answers(f), [''])
  assert.equal(f.store.loadRuntime().events[`telegram-answer-${records(f)[0].id}-1`].status, 'received')
  // Two swaps Telegram did not take are retried after a wait; the third lands.
  await until(() => records(f)[0].swap === undefined, 'the retried swap')
  assert.equal(f.logs.filter(line => /keyboard swap on message .* still pending: Too Many Requests/.test(line)).length, 2)
  assert.equal(f.calls.filter(call => call.method === 'editMessageReplyMarkup').length, 3)
  // A send in flight when the bridge stopped is uncertain after the restart, so a matching press still binds it.
  const runtime = f.store.loadRuntime(); runtime.questions.records.f00d00000000beef = { id: 'f00d00000000beef', chatId: '123', revision: 1,
    rows: [['Z']], status: 'prepared', previous: null, createdAt: 1, updatedAt: 1 }
  f.store.saveRuntime(runtime)
  const started = async resumed => {
    const channel = fixture(t, { stateDir: f.store.dir })
    channel.behave = (method, params, options) => method === 'getUpdates' ? new Promise((done, fail) => options.signal.addEventListener('abort',
      () => fail(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })) : undefined
    void channel.channel.start({ lockHeld: true, resumed })
    await until(() => channel.calls.some(call => call.method === 'getUpdates'), 'the first poll')
    await channel.channel.stop({ releaseLock: false })
    return records(channel).find(record => record.id === 'f00d00000000beef').status
  }
  // A channel started again in the same process, after a token change, leaves sends of the earlier one in flight.
  assert.equal(await started(true), 'prepared')
  assert.equal(await started(false), 'uncertain')
})

test('Q02 and Q03: an answer committed before a crash reaches Codex once after restart, through the existing reconciliation', async t => {
  const f = fixture(t)
  const sent = await f.channel.sendReply({ chat_id: '123', text: 'Pick', format: 'text', buttons: [['Yes']] })
  f.channel.onInbound = () => new Promise(() => {}) // the bridge stops before the input is handed over
  await f.channel.handleUpdate(pressUpdate(lastMarkup(f), 'Yes', { messageId: sent.message_ids[0] }), { background: true })
  const eventId = `telegram-answer-${records(f)[0].id}-1`
  const bridge = new GeliosBridge({ stateDir: f.store.dir, workspace: f.root })
  bridge.appReady = true; bridge.bindThread('saved-thread'); bridge.log = () => {}; bridge.retryDelay = () => 60_000
  bridge.telegram = { stopTyping() {}, notice: async () => {} }
  t.after(() => clearTimeout(bridge.retryTimer))
  const users = [], calls = []
  let lose = true
  bridge.rpc = async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/loaded/list') return { data: ['saved-thread'], nextCursor: null }
    if (method === 'thread/read') return { thread: { id: 'saved-thread', turns: [{ id: 'turn', items: [...users] }] } }
    if (method === 'turn/start') {
      users.push({ type: 'userMessage', clientId: params.clientUserMessageId, input: params.input })
      // Q03: Codex took the input, and its answer is lost.
      if (lose) { lose = false; throw new Error('app-server connection closed') }
      return { turn: { id: 'turn' } }
    }
    throw new Error(`unexpected RPC ${method}`)
  }
  bridge.restorePendingEvents(); bridge.flushWaiting(); await bridge.ingress
  clearTimeout(bridge.retryTimer); bridge.retryTimer = null
  bridge.flushWaiting(); await bridge.ingress
  assert.equal(users.length, 1); assert.equal(users[0].clientId, eventId)
  assert.match(users[0].input[0].text, /; button=Yes/); assert.match(users[0].input[0].text, /Pressed "Yes" on message/)
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1)
  assert.equal(bridge.store.loadRuntime().events[eventId].status, 'delivered')
})

test('R01: an added standard reaction is input; the sender\'s own message is suppressed and an unknown message is marked so', async t => {
  const f = fixture(t, { users: { ...OWNER, '456': { chatId: '456', alias: 'Other', role: 'contributor' } } })
  const sent = await f.channel.sendReply({ chat_id: '123', text: 'Deployed the new build to staging', format: 'text' })
  await f.channel.handleUpdate({ update_id: 1, message: { message_id: 40, date: 1, chat: { id: 123, type: 'private' }, from: { id: 123, first_name: 'Owner' }, text: 'mine' } })
  const before = f.events.length
  const react = (id, message, added, old = [], extra = {}) => f.channel.handleUpdate({ update_id: id, message_reaction: { chat: { id: 123, type: 'private' },
    user: { id: 123, is_bot: false }, message_id: message, date: 5, old_reaction: old, new_reaction: added, ...extra } })
  await react(10, sent.message_ids[0], [{ type: 'emoji', emoji: '👍' }])
  await react(10, sent.message_ids[0], [{ type: 'emoji', emoji: '👍' }])
  await react(11, 40, [{ type: 'emoji', emoji: '🔥' }])
  await react(12, 9999, [{ type: 'emoji', emoji: '🎉' }])
  await react(13, sent.message_ids[0], [], [{ type: 'emoji', emoji: '👍' }])
  await react(14, sent.message_ids[0], [{ type: 'custom_emoji', custom_emoji_id: '1' }, { type: 'paid' }])
  await react(15, sent.message_ids[0], [{ type: 'emoji', emoji: '👍' }, { type: 'emoji', emoji: '❤' }], [{ type: 'emoji', emoji: '👍' }])
  await react(16, sent.message_ids[0], [{ type: 'emoji', emoji: '👀' }], [], { chat: { id: Number(GROUP), type: 'supergroup' } })
  await react(17, sent.message_ids[0], [{ type: 'emoji', emoji: '👀' }], [], { user: { id: 999, is_bot: false }, chat: { id: 999, type: 'private' } })
  await react(18, sent.message_ids[0], [{ type: 'emoji', emoji: '👀' }], [], { user: { id: 123, is_bot: true } })
  const reactions = f.events.slice(before)
  assert.deepEqual(reactions.map(event => [event.reaction, event.reactedMessage, event.text]), [
    ['👍', 'bot', `👍 on message ${sent.message_ids[0]}: "Deployed the new build to staging"`],
    ['🎉', 'unknown', '🎉 on message 9999'],
    ['❤', 'bot', `❤ on message ${sent.message_ids[0]}: "Deployed the new build to staging"`],
  ])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f.store.accessPath, 'utf8')).users).sort(), ['123', '456'])
  assert.deepEqual(JSON.parse(readFileSync(f.store.accessPath, 'utf8')).pending, {})
  assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 1)
  const bridge = new GeliosBridge({ stateDir: join(f.root, 'bridge-state'), workspace: f.root })
  assert.match(bridge.telegramInput({ ...reactions[0], sequence: 1 })[0].text, /; reaction=👍; reacted_message=bot\n/)
  assert.match(bridge.telegramInput({ ...reactions[1], sequence: 2 })[0].text, /; reaction=🎉; reacted_message=unknown\n/)
  assert.match(bridge.telegramInput({ ...reactions[0], reaction: undefined, button: 'a;b', sequence: 3 })[0].text, /; button=invalid\n/)
})

test('U02: the question journal is versioned; a newer or damaged one is refused at load and by a candidate, never reset', async t => {
  const f = fixture(t)
  await f.channel.handleUpdate({ update_id: 1, message: { message_id: 41, date: 1, chat: { id: 123, type: 'private' }, from: { id: 123, first_name: 'Owner' }, text: 'kept' } })
  // An older journal without questions gains them on the first question and keeps everything else.
  await f.channel.sendReply({ chat_id: '123', text: 'Pick', format: 'text', buttons: [['A']] })
  const runtime = f.store.loadRuntime()
  assert.equal(runtime.questions.version, 1); assert.ok(runtime.events['telegram-123-41'])
  const { preflightState } = await import('../scripts/update.js')
  preflightState(f.store.dir)
  const saved = readFileSync(f.store.runtimePath, 'utf8')
  for (const [questions, message] of [[{ version: 2, records: {} }, /question journal version 2 is newer than this build reads \(1\)/],
    [{ version: 1, records: { a: { id: 'b' } } }, /question journal is corrupt/], [[], /question journal is corrupt/]]) {
    writeFileSync(f.store.runtimePath, JSON.stringify({ ...JSON.parse(saved), questions }))
    assert.throws(() => f.store.loadRuntime(), message)
    assert.throws(() => preflightState(f.store.dir), new RegExp(`candidate cannot read the current state: ${message.source}`))
    assert.deepEqual(JSON.parse(readFileSync(f.store.runtimePath, 'utf8')).questions, questions)
  }
})
