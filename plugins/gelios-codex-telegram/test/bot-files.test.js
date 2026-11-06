import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, truncateSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { botFileText, botTextPieces } from '../src/bot-files.js'
import { BurstBatcher } from '../src/batching.js'
import { StateStore } from '../src/core.js'
import { TelegramApi, TelegramChannel, TelegramError } from '../src/telegram.js'
import { GeliosBridge as Bridge } from '../scripts/bridge.js'
import { nativeBridge } from './support/native-bot-bridge.js'
import { until } from './support/wait.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
// Telegram's refusals of an edit made through the wrong call, as Telegram answered them when read live on
// 2026-11-06: editMessageText on a file, and editMessageCaption on a text message, which this plugin never makes.
const NO_TEXT = 'Bad Request: there is no text in the message to edit'
const NO_CAPTION = 'Bad Request: there is no caption in the message to edit'
// A caption as Telegram keeps it, read live on 2026-11-06: every carriage return, U+2028 to U+202E and the combining marks
// U+030A, U+0333 and U+033F removed, every other control character but the line break turned into a space, then spaces and
// line breaks trimmed at each end; anything else stays, and what is left with only the characters Telegram answered as
// empty (the no-break space, U+1680, U+180E, U+2000 to U+200F, U+202F, U+205F, U+2800, U+3000, U+FEFF, U+FFFC and the tag
// block U+E0000 to U+E007F), alone or in any mix with spaces and line breaks between, is no caption. A file send whose kept caption is over 1024 characters (code
// points) it refused with LONG_CAPTION.
const captionKept = caption => {
  const kept = caption?.replace(/[\r\u2028-\u202e\u030a\u0333\u033f]/g, '').replace(/[\0-\t\v-\x1f]/g, ' ').replace(/^[ \n]+|[ \n]+$/g, '')
  return kept === undefined || /^[ \n\u00a0\u1680\u180e\u2000-\u200f\u202f\u205f\u2800\u3000\ufeff\ufffc\u{e0000}-\u{e007f}]*$/u.test(kept) ? '' : kept
}
const LONG_CAPTION = 'Bad Request: message caption is too long'
const tooLong = captions => captions.some(caption => [...captionKept(caption)].length > 1024)
// state reuses another fixture's state folder, as a restarted bridge reads it; peer: false leaves the bot unlearned;
// dropCaption answers a captioned file send without its caption.
function fixture(t, { bot = true, group = false, state, peer = true, dropCaption = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bot-files-')), workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const store = new StateStore(state || join(root, 'state')), events = [], calls = []
  store.saveAccess({ version: 1, dmPolicy: 'allowlist', pending: {}, users: {
    '2': { chatId: '2', alias: 'Peer', role: 'admin' } },
    groups: group ? { '-3': { chatId: '-3', requireMention: false } } : {} })
  const channel = new TelegramChannel({ store, workspaceRoot: workspace, token: '1:fixture',
    onInbound: async (event, prepare) => events.push(await prepare()), onControl: async () => null, log: () => {} })
  if (peer) channel.learnPeer({ id: 2, is_bot: bot })
  let nextId = 10
  // What this fake sent, by message ID; an ID it never sent it accepts, as before.
  const kinds = new Map()
  // Telegram answers a file send with the file and its caption as it keeps one (captionKept).
  const fileSent = (field, caption) => {
    const id = nextId++, kept = captionKept(caption); kinds.set(id, 'file')
    return { message_id: id, [field]: field === 'photo' ? [{ file_id: `file-${id}` }] : { file_id: `file-${id}` }, ...(kept && !dropCaption ? { caption: kept } : {}) }
  }
  channel.api.call = async (method, fields) => {
    calls.push({ method, fields })
    const kind = kinds.get(Number(fields?.message_id))
    if (method === 'editMessageText' && kind === 'file') throw new TelegramError(NO_TEXT, 400)
    if (method === 'editMessageCaption' && kind === 'text') throw new TelegramError(NO_CAPTION, 400)
    const id = nextId++; if (['sendMessage', 'sendRichMessage'].includes(method)) kinds.set(id, 'text')
    return { message_id: id }
  }
  channel.api.multipart = async (method, fields, fieldName, file, options) => {
    options?.beforeSend?.(); calls.push({ method, fields, files: [{ fieldName, file }] })
    if (tooLong([fields.caption])) throw new TelegramError(LONG_CAPTION, 400)
    return fileSent(fieldName, fields.caption)
  }
  channel.api.multipartFiles = async (method, fields, files, options) => {
    options?.beforeSend?.(); calls.push({ method, fields, files })
    if (tooLong(fields.media.map(item => item.caption))) throw new TelegramError(LONG_CAPTION, 400)
    return fields.media.map(item => fileSent(item.type, item.caption))
  }
  const files = ['one.txt', 'two.png', 'three.csv'].map(name => { const file = join(workspace, name); writeFileSync(file, name); return file })
  t.after(() => channel.stop())
  return { store, channel, files, events, calls, workspace }
}
const message = (id, extra, bot = true) => ({ update_id: id, message: {
  message_id: id, date: id, chat: { id: 2, type: 'private' }, from: { id: 2, is_bot: bot }, ...extra } })

test('bot-file captions are kept and counted as Telegram keeps and counts a caption, and a longer text keeps its own edges', () => {
  const one = caption => ({ caption, pieces: [] })
  assert.deepEqual(botFileText(' \n '), { pieces: [] })
  assert.deepEqual(botFileText(' \n' + 'x'.repeat(1024) + '\n '), one('x'.repeat(1024)))
  assert.deepEqual(botFileText('x'.repeat(1025)), { pieces: ['x'.repeat(1025)] })
  // Telegram removes every carriage return and U+2028 to U+202E, turns every other control character but the line break
  // into a space, then trims spaces and line breaks at each end: a live read kept '\tx\t' as 'x' and 'a\rb' as 'ab'.
  assert.deepEqual(botFileText('\tx\t'), one('x'))
  assert.deepEqual(botFileText('a\rb'), one('ab'))
  assert.deepEqual(botFileText('\tthe\tnote\t'), one('the note'))
  assert.deepEqual(botFileText('\x01a\x0bb\x1f\r\n'), one('a b'))
  assert.deepEqual(botFileText('a\u2028b\u202ec'), one('abc'))
  assert.deepEqual(botFileText(' \n\u2029\n '), { pieces: [] })
  // A text of tabs and carriage returns is empty as a caption: Telegram answered a caption edit to ' \t\r ' with none.
  assert.deepEqual(botFileText(' \t\r '), { pieces: [] })
  // The combining marks U+030A, U+0333 and U+033F go, NUL and a form feed become spaces, U+202A and U+202B go, and
  // U+2027 and U+202F, just outside the removed range, stay.
  assert.deepEqual(botFileText('a\u030ab\u0333c\u033fd'), one('abcd'))
  assert.deepEqual(botFileText('a\x00b\x0cc'), one('a b c'))
  assert.deepEqual(botFileText('a\u202ab\u202bc'), one('abc'))
  assert.deepEqual(botFileText('a\u2027b\u202fc'), one('a\u2027b\u202fc'))
  // Any other character stays and counts: a no-break space, which JavaScript's own trim removes, DEL and U+200B.
  assert.deepEqual(botFileText(' \t\u00a0x\u00a0\r\n'), one('\u00a0x\u00a0'))
  assert.deepEqual(botFileText('\x7f\u200b'), one('\x7f\u200b'))
  // But what is left with only the characters Telegram answered as empty, alone or in any mix, or only those marks, is
  // no caption: Telegram sent each alone, and a no-break space followed by U+200B, with no caption. The tag block was
  // read at both ends and three points inside.
  const empty = ['\u00a0', '\u1680', '\u180e', ...Array.from({ length: 16 }, (_, i) => String.fromCodePoint(0x2000 + i)),
    '\u202f', '\u205f', '\u2800', '\u3000', '\ufeff', '\ufffc', '\u{e0000}', '\u{e0001}', '\u{e0020}', '\u{e0041}', '\u{e007f}']
  for (const text of [...empty, '\u0333', ' \u00a0\t\u200b\r\n', empty.join(' ')]) assert.deepEqual(botFileText(text), { pieces: [] })
  // U+2060, and U+E0080 just past the tag block, Telegram kept alone, so each rides as the caption.
  assert.deepEqual(botFileText('\u2060'), one('\u2060'))
  assert.deepEqual(botFileText('\u{e0080}'), one('\u{e0080}'))
  assert.deepEqual(botFileText('\u00a0' + 'x'.repeat(1024)), { pieces: ['\u00a0' + 'x'.repeat(1024)] })
  // The 1024 counts what Telegram keeps, in characters (code points): it took 1024 between two tabs, 1024 and a carriage
  // return, and 1024 characters outside the Basic Multilingual Plane (2,048 UTF-16 units), and refused 1025 of those.
  assert.deepEqual(botFileText('\t' + 'x'.repeat(1024) + '\t'), one('x'.repeat(1024)))
  assert.deepEqual(botFileText('x'.repeat(1024) + '\r'), one('x'.repeat(1024)))
  // 25 lines of 40 joined by CRLF: 1,048 UTF-16 units, and 1,024 characters once the carriage returns go.
  const lines = Array.from({ length: 25 }, () => 'l'.repeat(40))
  assert.deepEqual(botFileText(lines.join('\r\n')), one(lines.join('\n')))
  assert.deepEqual(botFileText('😀'.repeat(1024)), one('😀'.repeat(1024)))
  assert.deepEqual(botFileText('😀'.repeat(1025)), { pieces: ['😀'.repeat(1025)] })
  // A longer text goes as text messages, as before: only spaces and line breaks leave its edges, and its tabs and
  // carriage returns go as written.
  const long = '\t' + 'x'.repeat(600) + '\r\n\t' + 'y'.repeat(600) + '\r'
  assert.deepEqual(botFileText(` \n${long}\n `), { pieces: [long] })
})
test('long bot text preserves cuts, surrogate pairs and the reference fallback', () => {
  for (const text of ['x'.repeat(4095) + '😀tail', 'x'.repeat(4095) + ' ' + 'y'.repeat(5000), 'x'.repeat(4080) + ' \n ' + 'y'.repeat(5000), 'a'.repeat(9000)]) {
    const pieces = botTextPieces(text)
    assert.equal(pieces.join(''), text)
    for (const piece of pieces) {
      assert.ok(piece.length <= 4096)
      assert.doesNotMatch(piece, /[\ud800-\udbff]$/)
      assert.doesNotMatch(piece, /^[\udc00-\udfff]/)
      assert.equal(piece.replace(/^[ \n]+|[ \n]+$/g, ''), piece)
    }
    assert.ok(pieces.slice(0, -1).every(piece => piece.length >= 4000))
  }
  const fallback = 'a'.repeat(3999) + ' '.repeat(200) + 'z'
  assert.equal(botTextPieces(fallback)[0].length, 4096)
  const pairedFallback = '😀 '.repeat(2000), pieces = botTextPieces(pairedFallback)
  assert.equal(pieces[0].length, 4095)
  assert.equal(pieces.join(''), pairedFallback)
  for (const piece of pieces) { assert.doesNotMatch(piece, /[\ud800-\udbff]$/); assert.doesNotMatch(piece, /^[\udc00-\udfff]/) }
})
test('bot files are one document album with the caption on its first member', async t => {
  const f = fixture(t)
  const sent = await f.channel.reply({ chat_id: '2', text: ' **literal** ', files: f.files, reply_to: '5', format: 'markdownv2' })
  assert.deepEqual(f.calls.map(call => call.method), ['sendMediaGroup'])
  const album = f.calls[0]
  assert.deepEqual(album.fields.media, f.files.map((file, i) => ({ type: 'document', media: `attach://file${i}`, ...(i ? {} : { caption: '**literal**' }) })))
  assert.equal(album.fields.caption, undefined)
  assert.equal(album.fields.parse_mode, undefined)
  assert.equal(album.fields.reply_parameters.message_id, 5)
  assert.deepEqual(sent.message_ids, [10, 11, 12])
  assert.deepEqual(sent.message_ids.map(id => f.store.message('2', id).mediaKind), ['document', 'document', 'document'])
  assert.equal(f.store.message('2', 10).text, '**literal**')
})
test('single bot file uses sendDocument; blank captions send no separate message', async t => {
  const f = fixture(t)
  await f.channel.reply({ chat_id: '2', text: ' \n ', files: [f.files[1]] })
  assert.deepEqual(f.calls.map(call => call.method), ['sendDocument'])
  assert.equal(f.calls[0].fields.caption, undefined)
  assert.equal(f.calls[0].files[0].fieldName, 'document')
})
test('long bot-file text follows all files in safe pieces; ten files is still the reply limit', async t => {
  const f = fixture(t), text = '/output/' + 'x'.repeat(9000)
  const sent = await f.channel.reply({ chat_id: '2', text, files: Array(10).fill(f.files[0]), reply_to: '5' })
  assert.equal(f.calls[0].method, 'sendMediaGroup'); assert.equal(f.calls[0].files.length, 10)
  assert.equal(f.calls[0].fields.media.some(item => item.caption), false)
  assert.equal(f.calls.slice(1).map(call => call.fields.text).join(''), text)
  assert.equal(f.calls.slice(1).some(call => call.fields.reply_parameters), false)
  assert.equal(sent.message_ids.length, 13)
  const before = f.calls.length
  await assert.rejects(f.channel.reply({ chat_id: '2', text: 'too many', files: Array(11).fill(f.files[0]) }), /at most 10 files/)
  assert.equal(f.calls.length, before)
})
test('failed album stops text and preserves acknowledged IDs on a later failure', async t => {
  const f = fixture(t)
  f.channel.api.multipartFiles = async () => { throw new Error('upload refused') }
  await assert.rejects(f.channel.reply({ chat_id: '2', text: 'x'.repeat(1100), files: f.files }), /after 0 Telegram messages: upload refused/)
  assert.equal(f.calls.length, 0)
  f.channel.api.multipartFiles = async () => [1, 2, 3].map(message_id => ({ message_id }))
  f.channel.api.call = async () => { throw new Error('text refused') }
  await assert.rejects(f.channel.reply({ chat_id: '2', text: 'x'.repeat(1100), files: f.files }), /after 3 Telegram messages: text refused/)
  const failed = Object.values(f.store.loadRuntime().events).filter(event => event.status === 'failed')
  assert.deepEqual(failed.at(-1).sentMessageIds, [1, 2, 3])
})
test('incomplete and overcomplete album acknowledgements stop before cache writes or following text', async t => {
  for (const count of [2, 4]) {
    const f = fixture(t)
    f.channel.api.multipartFiles = async () => Array.from({ length: count }, (_, i) => ({ message_id: i + 1 }))
    await assert.rejects(f.channel.reply({ chat_id: '2', text: 'x'.repeat(1100), files: f.files }), new RegExp(`after ${count} Telegram messages: Telegram returned an incomplete document album`))
    assert.equal(f.calls.length, 0)
    for (let id = 1; id <= count; id += 1) assert.equal(f.store.message('2', id), null)
    const event = Object.values(f.store.loadRuntime().events).find(event => event.status === 'failed')
    assert.equal(event.sentMessageIds.length, count)
  }
})
test('bot albums honor all/off reply modes, preflight files and recheck access before upload', async t => {
  for (const replyToMode of ['all', 'off']) {
    const f = fixture(t)
    writeFileSync(f.store.configPath, JSON.stringify({ replyToMode }))
    await f.channel.reply({ chat_id: '2', text: 'x'.repeat(1100), files: f.files, reply_to: '5' })
    assert.ok(f.calls.every(call => Boolean(call.fields.reply_parameters) === (replyToMode === 'all')))
    const before = f.calls.length
    await assert.rejects(f.channel.reply({ chat_id: '2', text: 'invalid file', files: [f.files[0], join(f.workspace, 'missing')] }), /ENOENT|not found/)
    assert.equal(f.calls.length, before)
    await assert.rejects(f.channel.reply({ chat_id: '2', text: 'invalid format', files: f.files, format: 'invalid' }), /nothing was sent/)
    assert.equal(f.calls.length, before)
  }
  const f = fixture(t), file = join(f.workspace, 'large.png')
  writeFileSync(file, ''); truncateSync(file, 11 * 1024 * 1024)
  await f.channel.reply({ chat_id: '2', text: 'image as document', files: [file] })
  assert.equal(f.calls[0].method, 'sendDocument')
  f.channel.api.multipartFiles = async (method, fields, files, options) => {
    const access = f.store.loadAccess(); delete access.users['2']; f.store.saveAccess(access)
    options.beforeSend(); assert.fail('revoked upload must not leave the process')
  }
  await assert.rejects(f.channel.reply({ chat_id: '2', text: 'revoked', files: f.files }), /not paired/)
})
test('people and groups keep text first, photo previews and document order', async t => {
  for (const group of [false, true]) {
    const f = fixture(t, { bot: false, group })
    await f.channel.reply({ chat_id: group ? '-3' : '2', text: 'hello', files: f.files, ...(group ? { message_thread_id: '7' } : {}) })
    assert.deepEqual(f.calls.map(call => call.method), ['sendRichMessage', 'sendDocument', 'sendPhoto', 'sendDocument'])
    if (group) assert.ok(f.calls.every(call => call.fields.message_thread_id === 7))
  }
})
test('file waits distinguish bot and human media and preserve slash command boundaries', async t => {
  const batcher = new BurstBatcher({ publish: () => {} })
  for (const bot of [false, true]) for (const field of ['photo', 'document']) {
    assert.equal(batcher.gap({ rawMessage: { from: { is_bot: bot }, [field]: field === 'photo' ? [{}] : {} } }), bot ? 3000 : 500)
  }
  assert.equal(batcher.gap({ rawMessage: { from: { is_bot: true }, text: '/output/file' } }), 300)
  assert.equal(batcher.gap({ rawMessage: { text: '/output/file' } }), 0)
  assert.equal(batcher.gap({ rawMessage: { from: { is_bot: true }, voice: {} } }), 0)
  assert.equal(batcher.gap({ edited: true, rawMessage: { from: { is_bot: true }, document: {} } }), 0)
  const f = fixture(t)
  f.channel.api.download = async fileId => ({ bytes: Buffer.from(fileId), file: { file_path: fileId } })
  await f.channel.handleUpdate(message(1, { document: { file_id: 'one', file_name: 'one.txt' } }))
  await f.channel.handleUpdate(message(2, { text: '/output/whole text' }))
  assert.equal(f.events.length, 0)
  await f.channel.batcher.flush()
  assert.equal(f.events.length, 1)
  assert.ok(f.events[0].text.includes('/output/whole text'))
  await f.channel.handleUpdate(message(3, { text: '/status' }))
  assert.equal(f.events.length, 1)
  assert.ok(f.calls.some(call => call.method === 'sendMessage'))
})
test('bot-file bursts retain the lifetime, count, size and routing boundaries', async () => {
  let now = 0, timer
  const published = [], batcher = new BurstBatcher({ publish: events => published.push(events), now: () => now,
    setTimer: (fn, ms) => { timer = { fn, ms }; return timer }, clearTimer: () => {} })
  const event = (id, extra = {}) => ({ ...message(id, { document: { file_id: String(id) } }).message,
    eventId: `event-${id}`, chatId: '2', userId: '2', text: '', rawMessage: message(id, { document: {} }).message, ...extra })
  await batcher.add(event(1)); assert.equal(timer.ms, 3000)
  now = 7000; await batcher.add(event(2)); assert.equal(timer.ms, 500)
  await timer.fn(); await batcher.tail
  assert.deepEqual(published[0].map(event => event.eventId), ['event-1', 'event-2'])
  for (let id = 3; id < 15; id += 1) await batcher.add(event(id))
  assert.equal(published[1].length, 12)
  await batcher.add(event(15, { text: 'x'.repeat(30_000) }))
  await batcher.add(event(16, { text: 'x'.repeat(30_000) }))
  assert.deepEqual(published[2].map(event => event.eventId), ['event-15'])
  await batcher.add(event(17, { userId: '3' }))
  await batcher.add(event(18, { userId: '3', threadId: '7', rawMessage: { ...event(18).rawMessage, reply_to_message: { message_id: 1 } } }))
  await batcher.add(event(19, { userId: '3', threadId: '7', rawMessage: { ...event(19).rawMessage, reply_to_message: { message_id: 2 } } }))
  await batcher.flush()
  assert.deepEqual(published.slice(3).map(events => events.map(event => event.eventId)), [['event-16'], ['event-17'], ['event-18'], ['event-19']])
  batcher.stop()
})
test('only bot bursts tolerate an untargeted continuation; conflicting explicit targets stay separate', async () => {
  for (const bot of [false, true]) for (const replies of [[1, null, null], [null, 1, null], [1, null, 2]]) {
    const published = [], batcher = new BurstBatcher({ publish: events => published.push(events), setTimer: () => 0, clearTimer() {} })
    for (const [i, reply] of replies.entries()) await batcher.add({ eventId: `event-${i}`, chatId: '2', userId: '2', text: `part-${i}`,
      rawMessage: { from: { is_bot: bot }, text: `part-${i}`, ...(reply ? { reply_to_message: { message_id: reply } } : {}) } })
    await batcher.flush()
    assert.deepEqual(published.map(events => events.length), bot ? (replies[2] === 2 ? [2, 1] : [3]) : (replies[0] === null || replies[2] === 2 ? [1, 1, 1] : [1, 2]))
    batcher.stop()
  }
})

// What each message of a reply holds: text, a file, or a file whose caption holds the text, from Telegram's answer.
const self = { name: 'Codex', isBot: true, isSelf: true }
const FILE_REFUSAL = id => `message ${id} holds a file with no text, so it has no text to edit; nothing was edited`
const EMPTY_REFUSAL = 'a caption needs text once its ends are trimmed; nothing was edited'
const LONG_REFUSAL = count => `this text has ${count} characters, over the 1024 a caption holds; nothing was edited; send it as a new reply`
// The channel's whole result: today's fields, each of its own shape, and holds.
function assertReply(sent, ids, holds) {
  assert.match(sent.event_id, /^telegram-out-[0-9a-f]{24}$/)
  assert.ok(!Number.isNaN(Date.parse(sent.timestamp)) && Number.isInteger(sent.sequence))
  assert.deepEqual(sent, { message_ids: ids, event_id: sent.event_id, timestamp: sent.timestamp, sequence: sent.sequence, holds })
}
const text1087 = 'n'.repeat(1087)
test('holds: a reply to a bot with files answers what each message holds', async t => {
  let f = fixture(t)
  assertReply(await f.channel.reply({ chat_id: '2', text: ' \n short note \n ', files: [f.files[0]] }), [10], ['caption'])
  assert.equal(f.calls[0].fields.caption, 'short note')
  f = fixture(t)
  assertReply(await f.channel.reply({ chat_id: '2', text: 'short note', files: f.files }), [10, 11, 12], ['caption', 'file', 'file'])
  f = fixture(t)
  assertReply(await f.channel.reply({ chat_id: '2', text: text1087, files: [f.files[0]] }), [10, 11], ['file', 'text'])
  assert.deepEqual(f.calls.map(call => call.method), ['sendDocument', 'sendMessage'])
  f = fixture(t)
  assertReply(await f.channel.reply({ chat_id: '2', text: 'x'.repeat(5000), files: f.files }), [10, 11, 12, 13, 14], ['file', 'file', 'file', 'text', 'text'])
  assert.deepEqual(f.calls.map(call => call.method), ['sendMediaGroup', 'sendMessage', 'sendMessage'])
})
test('holds: a reply to a bot sends its text as the caption Telegram keeps, counted as Telegram counts it', async t => {
  let f = fixture(t)
  assertReply(await f.channel.reply({ chat_id: '2', text: '\tthe\r\nnote\t', files: [f.files[0]] }), [10], ['caption'])
  assert.deepEqual(f.calls.map(call => [call.method, call.fields.caption]), [['sendDocument', 'the\nnote']])
  assert.equal(f.store.message('2', '10').text, 'the\nnote')
  f = fixture(t)
  assertReply(await f.channel.reply({ chat_id: '2', text: '😀'.repeat(1024), files: f.files }), [10, 11, 12], ['caption', 'file', 'file'])
  assert.deepEqual(f.calls.map(call => [call.method, call.fields.media[0].caption]), [['sendMediaGroup', '😀'.repeat(1024)]])
  f = fixture(t)
  assertReply(await f.channel.reply({ chat_id: '2', text: ' \t\r ', files: [f.files[0]] }), [10], ['file'])
  assert.deepEqual(f.calls.map(call => [call.method, call.fields.caption]), [['sendDocument', undefined]])
})
test('holds: a captioned file Telegram answers without its caption is held as a file', async t => {
  const f = fixture(t, { dropCaption: true })
  assertReply(await f.channel.reply({ chat_id: '2', text: 'short note', files: [f.files[0]] }), [10], ['file'])
  assert.equal(f.calls[0].fields.caption, 'short note')
})
test('holds: a reply to a person holds its text and then its file in every format, and text alone holds text', async t => {
  for (const format of [undefined, 'text', 'markdownv2']) {
    const f = fixture(t, { bot: false })
    assertReply(await f.channel.reply({ chat_id: '2', text: 'hello', files: [f.files[0]], ...(format ? { format } : {}) }), [10, 11], ['text', 'file'])
    assert.deepEqual(f.calls.map(call => call.method), [format ? 'sendMessage' : 'sendRichMessage', 'sendDocument'])
  }
  const f = fixture(t, { bot: false })
  assertReply(await f.channel.reply({ chat_id: '2', text: 'hello' }), [10], ['text'])
})
test('holds: a caption edit keeps the text as Telegram keeps a caption and edits the caption alone', async t => {
  const f = fixture(t)
  await f.channel.reply({ chat_id: '2', text: 'short note', files: [f.files[0]] })
  const before = f.calls.length
  assert.deepEqual(await f.channel.editMessage({ chat_id: '2', message_id: '10', text: '  \n corrected note \n ' }), { message_id: '10', caption: true })
  assert.deepEqual(f.calls.slice(before), [{ method: 'editMessageCaption', fields: { chat_id: '2', message_id: 10, caption: 'corrected note' } }])
  assert.equal(f.store.message('2', '10').holds, 'caption')
  // Carriage returns go and tabs become spaces before the trim, as the send keeps a caption and Telegram keeps one.
  const next = f.calls.length
  assert.deepEqual(await f.channel.editMessage({ chat_id: '2', message_id: '10', text: ' \n\tcorrected\r\nnote\tagain\t\r\n ' }), { message_id: '10', caption: true })
  assert.deepEqual(f.calls.slice(next), [{ method: 'editMessageCaption', fields: { chat_id: '2', message_id: 10, caption: 'corrected\nnote again' } }])
})
test('holds: a caption edit Telegram refuses fails with its reason after its one call, and the record stays as it was', async t => {
  const f = fixture(t)
  await f.channel.reply({ chat_id: '2', text: 'short note', files: [f.files[0]] })
  const record = f.store.message('2', '10')
  const call = f.channel.api.call
  // Telegram's refusal of an edit of a message that is gone.
  f.channel.api.call = async (method, fields, options) => {
    if (method !== 'editMessageCaption') return call(method, fields, options)
    f.calls.push({ method, fields }); throw new TelegramError('Bad Request: message to edit not found', 400)
  }
  const before = f.calls.length
  await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '10', text: 'corrected note' }), { message: 'Bad Request: message to edit not found' })
  assert.deepEqual(f.calls.slice(before), [{ method: 'editMessageCaption', fields: { chat_id: '2', message_id: 10, caption: 'corrected note' } }])
  assert.deepEqual(f.store.message('2', '10'), record)
})
test('holds: a caption edit whose outcome is unknown fails with its error after its one call, and the record stays as it was', async t => {
  // Telegram answered with a 5xx, or no answer came, after the request left: the edit's outcome is unknown.
  for (const failure of [new TelegramError('Gateway Timeout', 504), new Error('Telegram request timed out')]) {
    const f = fixture(t)
    await f.channel.reply({ chat_id: '2', text: 'short note', files: [f.files[0]] })
    const record = f.store.message('2', '10')
    const call = f.channel.api.call
    f.channel.api.call = async (method, fields, options) => {
      if (method !== 'editMessageCaption') return call(method, fields, options)
      options?.beforeSend?.(); f.calls.push({ method, fields }); throw failure
    }
    const before = f.calls.length
    await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '10', text: 'corrected note' }), { message: failure.message })
    assert.deepEqual(f.calls.slice(before), [{ method: 'editMessageCaption', fields: { chat_id: '2', message_id: 10, caption: 'corrected note' } }])
    assert.deepEqual(f.store.message('2', '10'), record)
  }
})
test('holds: a caption edit checks empty and too long on the text as Telegram keeps a caption, as the send does', async t => {
  const f = fixture(t)
  await f.channel.reply({ chat_id: '2', text: 'short note', files: [f.files[0]] })
  let before = f.calls.length
  // Tabs, carriage returns, other control characters and U+2028 alone are empty as a caption, and so is a text left with
  // only the characters Telegram answered as empty, or only the combining marks it removes: Telegram answered a caption
  // edit to ' \t\r ', and to a no-break space, U+200B, U+0333, U+202F, U+200C, U+FEFF and U+2009 each alone, with no
  // caption, so the edit would delete the text.
  for (const text of [' \t\r ', '\r\n\t', '\x01\u2028\x1f', '\u00a0', '\u200b', '\u0333', ' \u0333\t', '\u00a0 \u200b',
    '\u202f', '\u200c', '\ufeff', '\u2009', '\u3000\n\u2800\u200d', '\u1680', '\u180e', '\u{e0000}\u{e007f}']) {
    await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '10', text }), { message: EMPTY_REFUSAL })
  }
  assert.deepEqual(f.calls.slice(before), [])
  // Any other character stays, such as a no-break space around a letter, which JavaScript's own trim removes.
  assert.deepEqual(await f.channel.editMessage({ chat_id: '2', message_id: '10', text: ' \u00a0x\u00a0\t\r' }), { message_id: '10', caption: true })
  assert.deepEqual(f.calls.slice(before), [{ method: 'editMessageCaption', fields: { chat_id: '2', message_id: 10, caption: '\u00a0x\u00a0' } }])
  // U+2060, and U+E0080 just past the tag block, Telegram kept alone, so each goes out.
  for (const text of ['\u2060', '\u{e0080}']) {
    before = f.calls.length
    assert.deepEqual(await f.channel.editMessage({ chat_id: '2', message_id: '10', text }), { message_id: '10', caption: true })
    assert.deepEqual(f.calls.slice(before), [{ method: 'editMessageCaption', fields: { chat_id: '2', message_id: 10, caption: text } }])
  }
  // NUL and a form feed become spaces, U+202A, U+202B and the marks U+030A, U+0333 and U+033F go, and U+2027 and U+202F,
  // just outside the removed range, stay, as Telegram kept each in the live reads.
  before = f.calls.length
  const mixed = 'a\x00b\x0cc\u202ad\u202be\u030af\u0333g\u033fh\u2027i\u202fj'
  assert.deepEqual(await f.channel.editMessage({ chat_id: '2', message_id: '10', text: mixed }), { message_id: '10', caption: true })
  assert.deepEqual(f.calls.slice(before), [{ method: 'editMessageCaption', fields: { chat_id: '2', message_id: 10, caption: 'a b cdefgh\u2027i\u202fj' } }])
  // The 1024 counts what Telegram keeps: 1024 characters between a tab and a CRLF, and 25 lines of 40 joined by CRLF
  // (1,048 UTF-16 units, 1,024 characters once the carriage returns go), each go out.
  const lines = Array.from({ length: 25 }, () => 'l'.repeat(40))
  for (const [text, kept] of [[` \t${'c'.repeat(1024)}\r\n`, 'c'.repeat(1024)], [lines.join('\r\n'), lines.join('\n')]]) {
    before = f.calls.length
    assert.deepEqual(await f.channel.editMessage({ chat_id: '2', message_id: '10', text }), { message_id: '10', caption: true })
    assert.deepEqual(f.calls.slice(before).map(call => [call.method, call.fields.caption]), [['editMessageCaption', kept]])
  }
  // A no-break space and 1024 characters are 1025, so nothing goes.
  before = f.calls.length
  await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '10', text: '\u00a0' + 'c'.repeat(1024) }), { message: LONG_REFUSAL(1025) })
  assert.deepEqual(f.calls.slice(before), [])
})
test('holds: a caption edit takes 1024 characters once trimmed and refuses 1025 or none with no call', async t => {
  const f = fixture(t)
  await f.channel.reply({ chat_id: '2', text: 'short note', files: [f.files[0]] })
  let before = f.calls.length
  await f.channel.editMessage({ chat_id: '2', message_id: '10', text: ` \n${'c'.repeat(1024)}\n ` })
  assert.deepEqual(f.calls.slice(before).map(call => [call.method, call.fields.caption]), [['editMessageCaption', 'c'.repeat(1024)]])
  before = f.calls.length
  await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '10', text: ` ${'c'.repeat(1025)} ` }), { message: LONG_REFUSAL(1025) })
  await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '10', text: '  \n ' }), { message: EMPTY_REFUSAL })
  await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '10', text: '' }), { message: 'message text must be nonempty' })
  assert.equal(f.calls.length, before)
})
test('holds: a caption edit Telegram answers with message is not modified counts as done', async t => {
  const f = fixture(t)
  await f.channel.reply({ chat_id: '2', text: 'same note', files: [f.files[0]] })
  // Telegram's answer to an edit that changes nothing, as a repeat of an edit that already landed gets.
  const NOT_MODIFIED = 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message'
  const call = f.channel.api.call
  f.channel.api.call = async (method, fields, options) => {
    if (method !== 'editMessageCaption') return call(method, fields, options)
    f.calls.push({ method, fields }); throw new TelegramError(NOT_MODIFIED, 400)
  }
  const before = f.calls.length
  assert.deepEqual(await f.channel.editMessage({ chat_id: '2', message_id: '10', text: 'same note' }), { message_id: '10', caption: true })
  assert.deepEqual(f.calls.slice(before), [{ method: 'editMessageCaption', fields: { chat_id: '2', message_id: 10, caption: 'same note' } }])
  assert.equal(f.store.message('2', '10').holds, 'caption')
})
test('holds: a caption edit counts its 1024 in characters (code points), as Telegram and the send do', async t => {
  // Telegram took a caption of 1024 characters outside the Basic Multilingual Plane, 2,048 UTF-16 units, and refused 1025.
  const wide = count => '😀'.repeat(count)
  assert.deepEqual([botFileText(wide(1024)), botFileText(wide(1025))], [{ caption: wide(1024), pieces: [] }, { pieces: [wide(1025)] }])
  const f = fixture(t)
  await f.channel.reply({ chat_id: '2', text: 'short note', files: [f.files[0]] })
  const before = f.calls.length
  await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '10', text: wide(1025) }), { message: LONG_REFUSAL(1025) })
  assert.equal(f.calls.length, before)
  assert.deepEqual(await f.channel.editMessage({ chat_id: '2', message_id: '10', text: wide(1024) }), { message_id: '10', caption: true })
  assert.deepEqual(f.calls.slice(before).map(call => [call.method, call.fields.caption]), [['editMessageCaption', wide(1024)]])
})
test('holds: a text edit of a file with no text is refused with no call, buttons or not, and a text message edits as before', async t => {
  const f = fixture(t)
  await f.channel.reply({ chat_id: '2', text: text1087, files: [f.files[0]] })
  const before = f.calls.length
  await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '10', text: 'corrected' }), { message: FILE_REFUSAL(10) })
  await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '10', text: 'corrected', buttons: [['Yes']] }), { message: FILE_REFUSAL(10) })
  assert.equal(f.calls.length, before)
  assert.deepEqual(await f.channel.editMessage({ chat_id: '2', message_id: '11', text: 'corrected' }), { message_id: '11' })
  assert.deepEqual(f.calls.slice(before), [{ method: 'editMessageText', fields: { chat_id: '2', message_id: 11, text: 'corrected' } }])
})
test('holds: a person-chat file with buttons refuses a text edit with no call and edits its buttons alone', async t => {
  const f = fixture(t, { bot: false })
  f.channel.polling = true
  assertReply(await f.channel.reply({ chat_id: '2', text: 'pick', files: [f.files[0]], format: 'text', buttons: [['Yes']] }), [10, 11], ['text', 'file'])
  assert.ok(f.calls.at(-1).fields.reply_markup)
  const before = f.calls.length
  await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '11', text: 'corrected', buttons: [['No']] }), { message: FILE_REFUSAL(11) })
  assert.equal(f.calls.length, before)
  await f.channel.editMessage({ chat_id: '2', message_id: '11', buttons: [['No']] })
  assert.deepEqual(f.calls.slice(before).map(call => call.method), ['editMessageReplyMarkup'])
})
test('holds: a buttons-only edit of a file whose caption holds the text reads no label and changes the buttons alone', async t => {
  const f = fixture(t)
  await f.channel.reply({ chat_id: '2', text: 'short note', files: [f.files[0]] })
  const record = f.store.message('2', '10'), before = f.calls.length
  assert.deepEqual(await f.channel.editMessage({ chat_id: '2', message_id: '10', buttons: [] }), { message_id: '10' })
  assert.deepEqual(f.calls.slice(before), [{ method: 'editMessageReplyMarkup', fields: { chat_id: '2', message_id: 10 } }])
  await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '10', buttons: [['Yes']] }), { message: "buttons are refused in a bot's chat: a bot cannot press one; nothing was edited" })
  assert.equal(f.calls.length, before + 1)
  assert.deepEqual(f.store.message('2', '10'), record)
})
test('holds: on a bridge that does not poll, a text edit with buttons of a file answers the file refusal', async t => {
  const f = fixture(t, { bot: false })
  await f.channel.reply({ chat_id: '2', text: 'hello', files: [f.files[0]] })
  const before = f.calls.length
  await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '11', text: 'corrected', buttons: [['Yes']] }), { message: FILE_REFUSAL(11) })
  assert.equal(f.calls.length, before)
})
test('holds: after a restart a text edit of a file is refused with no call, the bot lookup included', async t => {
  const f = fixture(t)
  await f.channel.reply({ chat_id: '2', text: text1087, files: [f.files[0]] })
  const restarted = fixture(t, { state: f.store.dir, peer: false })
  await assert.rejects(restarted.channel.editMessage({ chat_id: '2', message_id: '10', text: 'corrected' }), { message: FILE_REFUSAL(10) })
  assert.deepEqual(restarted.calls, [])
})
test('holds: a caption edit refused as empty or too long makes no call after a restart, and answers its own refusal with buttons', async t => {
  const f = fixture(t)
  await f.channel.reply({ chat_id: '2', text: 'short note', files: [f.files[0]] })
  // After a restart the peer is not learned yet: each caption refusal comes before the bot lookup.
  const restarted = fixture(t, { state: f.store.dir, peer: false })
  await assert.rejects(restarted.channel.editMessage({ chat_id: '2', message_id: '10', text: ' \t\r ' }), { message: EMPTY_REFUSAL })
  await assert.rejects(restarted.channel.editMessage({ chat_id: '2', message_id: '10', text: 'c'.repeat(1025) }), { message: LONG_REFUSAL(1025) })
  assert.deepEqual(restarted.calls, [])
  // In a bot's chat, buttons get their own refusal only after the caption's.
  const before = f.calls.length
  await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '10', text: ' \t\r ', buttons: [['Yes']] }), { message: EMPTY_REFUSAL })
  await assert.rejects(f.channel.editMessage({ chat_id: '2', message_id: '10', text: 'c'.repeat(1025), buttons: [['Yes']] }), { message: LONG_REFUSAL(1025) })
  assert.equal(f.calls.length, before)
})
test('holds: the store keeps what each message holds across a reload, and a caption edit there edits the caption', async t => {
  const f = fixture(t)
  await f.channel.reply({ chat_id: '2', text: 'short note', files: [f.files[0]] })
  assert.equal(new StateStore(f.store.dir).message('2', '10').holds, 'caption')
  const restarted = fixture(t, { state: f.store.dir })
  assert.deepEqual(await restarted.channel.editMessage({ chat_id: '2', message_id: '10', text: 'corrected note' }), { message_id: '10', caption: true })
  assert.deepEqual(restarted.calls.map(call => [call.method, call.fields.caption]), [['editMessageCaption', 'corrected note']])
})
test('holds: the store keeps only the three values it knows', async t => {
  const f = fixture(t)
  for (const [id, holds] of [[50, 'bogus'], [51, 'text'], [52, 'file'], [53, 'caption']]) f.store.rememberMessage('2', id, { text: 'x', holds, sender: self })
  const reloaded = new StateStore(f.store.dir)
  assert.deepEqual([50, 51, 52, 53].map(id => reloaded.message('2', id).holds), [undefined, 'text', 'file', 'caption'])
  assert.equal('holds' in reloaded.message('2', 50), false)
})
test('holds: a file recorded before holds is edited through editMessageText as before', async t => {
  const f = fixture(t)
  f.store.rememberMessage('2', 50, { text: '(document: x.txt)', mediaKind: 'document', sender: self })
  f.store.rememberMessage('2', 51, { text: 'a note that was a caption', mediaKind: 'document', sender: self })
  for (const id of ['50', '51']) assert.deepEqual(await f.channel.editMessage({ chat_id: '2', message_id: id, text: 'corrected' }), { message_id: id })
  assert.deepEqual(f.calls.map(call => [call.method, call.fields.message_id]), [['editMessageText', 50], ['editMessageText', 51]])
})

async function apiServer(t, handler) {
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks), type = request.headers['content-type']
      const fields = type?.startsWith('multipart/')
        ? await new Request('http://localhost', { method: 'POST', headers: { 'content-type': type }, body }).formData()
        : new URLSearchParams(body.toString())
      const result = await handler(request.url.slice(1), fields)
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, result }))
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ ok: false, description: error.message })) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}
test('multipart album sends every byte and shares cancellation and authorization with single uploads', async t => {
  const received = [], base = await apiServer(t, async (method, fields) => {
    received.push({ method, media: JSON.parse(fields.get('media')), bytes: await fields.get('file0').text(), name: fields.get('file1').name })
    return [{ message_id: 1 }, { message_id: 2 }]
  })
  const api = new TelegramApi('1:fixture'); api.base = base
  const files = ['first', 'second'].map((text, index) => ({ fieldName: `file${index}`, file: { name: `${text}.txt`, bytes: Buffer.from(text) } }))
  const fields = { chat_id: '2', media: files.map(({ fieldName }) => ({ type: 'document', media: `attach://${fieldName}` })) }
  await api.multipartFiles('sendMediaGroup', fields, files)
  assert.equal(received[0].bytes, 'first'); assert.equal(received[0].name, 'second.txt')
  await assert.rejects(api.multipartFiles('sendMediaGroup', fields, files, { beforeSend: () => { throw new Error('revoked') } }), /revoked/)
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  await assert.rejects(api.multipartFiles('sendMediaGroup', fields, files, { signal: controller.signal }), /cancelled/)
  assert.equal(received.length, 1); api.close()
})
test('album deadlines retain one upload budget per file, and early abort prepares and sends nothing', async () => {
  const api = new TelegramApi('1:fixture'), deadlines = []
  api.request = async (url, options, timing) => { deadlines.push(timing.timeoutMs); return new Response(JSON.stringify({ ok: true, result: [] })) }
  const file = { name: 'data.txt', bytes: Buffer.from('data') }
  for (const count of [1, 3, 10]) await api.multipartFiles('sendMediaGroup', {}, Array.from({ length: count }, (_, i) => ({ fieldName: `file${i}`, file })))
  assert.deepEqual(deadlines, [55_000, 165_000, 550_000])
  const controller = new AbortController(); controller.abort(new Error('cancelled before preparation'))
  let prepared = false
  await assert.rejects(api.multipartFiles('sendMediaGroup', {}, [{ fieldName: 'file0', file: {
    name: 'unused.txt', get bytes() { prepared = true; return Buffer.from('unused') },
  } }], { signal: controller.signal }), /cancelled before preparation/)
  assert.equal(prepared, false); assert.equal(deadlines.length, 3); api.close()
})

async function exchange(t, native = false, { textSize = 8200, replyToMode = 'first', threaded = false, uploadDelay = 9000 } = {}) {
  const bridges = []
  for (const id of [1, 2]) {
    const root = mkdtempSync(join(tmpdir(), 'bot-file-bridge-')), workspace = join(root, 'workspace'); mkdirSync(workspace)
    const bridge = native ? await nativeBridge(t, root, workspace) : new Bridge({ stateDir: join(root, 'state'), workspace })
    if (!native) { bridge.log = () => {}; bridge.appReady = true; bridge.currentThreadId = `thread-${id}`; bridge.ensureBoundThread = async () => {} }
    bridge.telegram = bridge.setupChannel(`${id}:fixture`)
    bridge.store.saveAccess({ version: 1, dmPolicy: 'allowlist', pending: {}, users: {
      [3 - id]: { chatId: String(3 - id), alias: 'Peer', role: 'contributor' } } })
    bridge.telegram.learnPeer({ id: 3 - id, is_bot: true })
    t.after(() => bridge.telegram.stop()); bridges.push(bridge)
  }
  const [sender, receiver] = bridges, inputs = [], uploads = [], methods = []
  if (replyToMode !== 'first') writeFileSync(sender.store.configPath, JSON.stringify({ replyToMode }))
  const rpc = receiver.rpc.bind(receiver)
  receiver.rpc = async (method, params) => {
    if (method === 'turn/start' || method === 'turn/steer') inputs.push({ method, params })
    return native ? rpc(method, params) : { turn: { id: 'received-turn' } }
  }
  let nextId = 10, started
  const uploadStarted = new Promise(resolve => { started = resolve })
  const base = await apiServer(t, async (method, fields) => {
    methods.push(method)
    if (method === 'sendChatAction') return true
    const reply = fields.get('reply_parameters') ? { reply_to_message: { message_id: JSON.parse(fields.get('reply_parameters')).message_id,
      date: 1, from: { id: 2, is_bot: true }, text: 'Prior context' } } : {}
    if (method === 'sendMediaGroup') {
      started(); await wait(uploadDelay)
      const result = []
      for (const media of JSON.parse(fields.get('media'))) {
        const file = fields.get(media.media.slice('attach://'.length)), id = nextId++
        uploads.push({ id, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) })
        await receiver.telegram.handleUpdate({ update_id: id, message: { message_id: id, date: id,
          chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: true },
          document: { file_id: `file-${id}`, file_name: file.name }, ...reply, ...(media.caption ? { caption: media.caption } : {}) } })
        result.push({ message_id: id })
      }
      return result
    }
    assert.equal(method, 'sendMessage')
    const id = nextId++
    await receiver.telegram.handleUpdate({ update_id: id, message: { message_id: id, date: id,
      chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: true }, text: fields.get('text'), ...reply } })
    return { message_id: id }
  })
  sender.telegram.api.base = base; receiver.telegram.api.base = base
  receiver.telegram.api.download = async fileId => {
    const file = uploads.find(file => `file-${file.id}` === fileId)
    return { bytes: file.bytes, file: { file_path: file.name } }
  }
  const files = ['first.txt', 'second.png', 'third.csv'].map(name => { const file = join(sender.options.workspace, name); writeFileSync(file, `contents:${name}`); return file })
  const text = '/results/' + 'x'.repeat(textSize)
  const pending = sender.telegram.reply({ chat_id: '2', text, files, ...(threaded ? { reply_to: '5' } : {}) })
  void pending.catch(() => {}) // Failed assertions may close the fixture during an upload.
  await uploadStarted
  if (uploadDelay >= 3100) { await wait(3100); assert.equal(inputs.length, 0, 'no receiving turn begins while the album uploads') }
  const receipt = await pending
  await receiver.telegram.batcher.flush(); await receiver.ingress
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].method, 'turn/start')
  const input = inputs[0].params.input.filter(item => item.type === 'text').map(item => item.text).join('\n')
  assert.ok(input.includes(text))
  if (threaded && replyToMode !== 'off') assert.ok(input.includes('Prior context'))
  assert.equal((input.match(/attachment_file_id=/g) || []).length, 3)
  const handles = [...input.matchAll(/attachment_file_id=([^;\n]+)/g)].map(match => match[1])
  assert.equal(new Set(handles).size, 3)
  for (const [i, name] of ['first.txt', 'second.png', 'third.csv'].entries()) {
    assert.ok(input.includes(`name=${name}`))
    assert.equal(uploads[i].bytes.toString(), `contents:${name}`)
  }
  assert.ok(input.indexOf('name=first.txt') < input.indexOf('name=second.png') && input.indexOf('name=second.png') < input.indexOf('name=third.csv'))
  assert.equal(methods[0], 'sendMediaGroup')
  assert.equal(receipt.message_ids.length, 3 + botFileText(text).pieces.length)
  if (native) {
    await until(t, () => !receiver.activeTurnId, 'the native turn to complete')
    const thread = (await receiver.rpc('thread/read', { threadId: receiver.currentThreadId, includeTurns: true })).thread
    const userItems = thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'userMessage')
    assert.equal(userItems.length, 1)
    const recorded = JSON.stringify(userItems[0])
    assert.ok(recorded.includes(text))
    for (const name of ['first.txt', 'second.png', 'third.csv']) assert.ok(recorded.includes(`name=${name}`))
  }
}
test('two bridge fixtures deliver three files and all text together after a nine-second upload', { timeout: 25_000 }, t => exchange(t))
for (const [replyToMode, textSize] of [['first', 1100], ['first', 8200], ['all', 8200]]) test(`threaded bot files and ${textSize} text characters reach one input in ${replyToMode} mode`,
  { timeout: 10_000 }, t => exchange(t, false, { replyToMode, textSize, threaded: true, uploadDelay: 0 }))
test('two real native hosts receive one complete bot-file input after a nine-second upload', {
  skip: !process.env.GELIOS_REAL_CODEX_BIN && 'set GELIOS_REAL_CODEX_BIN for real native hosts', timeout: 45_000,
}, t => exchange(t, true, { threaded: true }))
