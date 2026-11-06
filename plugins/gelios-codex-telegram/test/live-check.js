#!/usr/bin/env node
// The live check: every text and caption rule the tests' stand-ins for Telegram keep (support/telegram-stand-in.js), run
// against Telegram itself and against the stand-ins, naming each case where the two differ.
//
//   TELEGRAM_LIVE_CHECK_TOKEN=<bot token> node test/live-check.js --chat <chat id> [--pace <ms>]
//
// The token comes only from TELEGRAM_LIVE_CHECK_TOKEN and the chat only from --chat, both named by the person running it:
// without either it refuses before any call. Every case runs through the stand-ins (standInApi, as the fixture's fakes
// answer), then through Telegram with the plugin's own TelegramApi: each message goes to the chat silently, and each message
// Telegram took is deleted as soon as its case is read; a run that stops partway deletes what it took before it stops. Calls
// to Telegram go --pace milliseconds apart, 1000 unless set, as Telegram asks a bot to send a chat at most about one message a
// second, and a 429 waits out its retry_after and sends the call once more. It prints one line for each case, the stand-ins'
// answer beside Telegram's where they differ, and never any part of the token. It exits 0 when every case agrees, 1 when any
// differs, and 2 when it refused, could not run every case, or could not delete a message. It is no test file, so npm test
// never runs it, and CI has no token for it.
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { TelegramApi } from '../src/telegram.js'
import { standInApi } from './support/telegram-stand-in.js'

// A case sends its value as a document's caption or the first caption of an album of two documents, or edits a message to
// it: a caption edit edits a captioned document, or a text message with `on: 'text'`; a text edit edits a text message, or
// a document with `on: 'file'`.
const caption = (name, value) => ({ name, method: 'sendDocument', value })
const album = (name, value) => ({ name, method: 'sendMediaGroup', value })
const captionEdit = (name, value, on) => ({ name, method: 'editMessageCaption', value, ...(on ? { on } : {}) })
const textEdit = (name, value, on) => ({ name, method: 'editMessageText', value, ...(on ? { on } : {}) })
const x = n => 'x'.repeat(n)
const lines = Array.from({ length: 25 }, () => 'l'.repeat(40)).join('\r\n')
// Each character a caption of nothing but it is checked with, by its name.
const ALONE = [
  ['nbsp', '\u00a0'], ['u200b', '\u200b'], ['u0333', '\u0333'], ['u2000', '\u2000'], ['u2009', '\u2009'], ['u200a', '\u200a'],
  ['u200c', '\u200c'], ['u200d', '\u200d'], ['u200e', '\u200e'], ['u200f', '\u200f'], ['u202f', '\u202f'], ['u2800', '\u2800'],
  ['u3000', '\u3000'], ['ufeff', '\ufeff'], ['u2060', '\u2060'], ['nbsp-u200b', '\u00a0\u200b'], ['u1680', '\u1680'], ['u180e', '\u180e'],
  ['u2001', '\u2001'], ['u2002', '\u2002'], ['u2003', '\u2003'], ['u2004', '\u2004'], ['u2005', '\u2005'], ['u2006', '\u2006'],
  ['u2007', '\u2007'], ['u2008', '\u2008'], ['u205f', '\u205f'], ['ufffc', '\ufffc'], ['ue0000', '\u{e0000}'], ['ue0001', '\u{e0001}'],
  ['ue0020', '\u{e0020}'], ['ue0041', '\u{e0041}'], ['ue007f', '\u{e007f}'], ['ue0080', '\u{e0080}'],
]

// The stand-ins' rules: what they keep of a caption, sent with a file, with an album's first file or as an edit, none when
// nothing is left (captionKept); their refusal of a file send whose caption is over 1024 characters (LONG_CAPTION); their
// refusal of a text edit of a file (NO_TEXT) and of a caption edit of a text (NO_CAPTION); and a text edit of a text, which
// they take. Each case reads one of them at an edge Telegram may draw elsewhere.
export const CASES = [
  textEdit('text-edit', 'edited'),
  textEdit('text-edit-of-file', 'edited', 'file'),
  captionEdit('caption-edit-of-text', 'edited', 'text'),
  caption('caption-ends', ' \n x \n '),
  caption('caption-inside', 'a \n b'),
  caption('caption-spaces-only', ' \n '),
  caption('caption-tab-ends', '\tx\t'),
  caption('caption-control-ends', '\x01x\x01'),
  caption('caption-x00', 'a\x00b'),
  caption('caption-x01', 'a\x01b'),
  caption('caption-x0b', 'a\x0bb'),
  caption('caption-x0c', 'a\x0cb'),
  caption('caption-x1f', 'a\x1fb'),
  caption('caption-x7f', 'a\x7fb'),
  caption('caption-lf', 'a\nb'),
  caption('caption-cr', 'a\rb'),
  caption('caption-u2027', 'a\u2027b'),
  caption('caption-u2028', 'a\u2028b'),
  caption('caption-u2029', 'a\u2029b'),
  caption('caption-u202a', 'a\u202ab'),
  caption('caption-u202b', 'a\u202bb'),
  caption('caption-u202e', 'a\u202eb'),
  caption('caption-u202f', 'a\u202fb'),
  caption('caption-u030a', 'a\u030ab'),
  caption('caption-u0333', 'a\u0333b'),
  caption('caption-u033f', 'a\u033fb'),
  caption('caption-u200b', 'a\u200bb'),
  caption('caption-nbsp-ends', '\u00a0x\u00a0'),
  caption('caption-tabs-cr-only', ' \t\r '),
  ...ALONE.map(([name, value]) => caption(`caption-only-${name}`, value)),
  caption('caption-1024-in-tabs', '\t' + x(1024) + '\t'),
  caption('caption-1024-and-cr', x(1024) + '\r'),
  caption('caption-1024-crlf-lines', lines),
  caption('caption-1024-emoji', '\u{1f600}'.repeat(1024)),
  caption('caption-1025-emoji', '\u{1f600}'.repeat(1025)),
  caption('caption-1025', x(1025)),
  caption('caption-nbsp-and-1024', '\u00a0' + x(1024)),
  album('album-tab-ends', '\tx\t'),
  album('album-1025', x(1025)),
  captionEdit('caption-edit-ends', ' \n edited \n '),
  captionEdit('caption-edit-tab-ends', '\tedited\t'),
  captionEdit('caption-edit-mixed', 'a\x00b\x0cc\u202ad\u202be\u030af\u0333g\u033fh\u2027i\u202fj\r'),
  captionEdit('caption-edit-tabs-cr-only', ' \t\r '),
  ...['nbsp', 'u200b', 'u0333', 'u2009', 'u200c', 'u202f', 'ufeff'].map(name =>
    captionEdit(`caption-edit-only-${name}`, ALONE.find(([n]) => n === name)[1])),
]

// The text or caption of the message an edit case edits, which no case's value is kept as, so no edit answers "message is
// not modified".
const BASE = 'the message before its edit'
const FILE = { bytes: Buffer.from('A file the live check sends and deletes.\n'), name: 'live-check.txt' }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// Telegram through the plugin's own TelegramApi, its file sends with each field's bytes exactly as given: FormData, which
// TelegramApi's multipart sends with, writes every line break in a field as CRLF, so a carriage return alone in a caption
// would reach Telegram as a line break, and the check would read Telegram's rule on another text than the case's.
function exactApi(api) {
  const boundary = `live-check-${randomBytes(12).toString('hex')}`
  const send = async (method, fields, files) => {
    const parts = []
    for (const [key, value] of Object.entries(fields)) {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n`, typeof value === 'object' ? JSON.stringify(value) : String(value), '\r\n')
    }
    for (const { fieldName, file } of files) {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${file.name}"\r\nContent-Type: text/plain\r\n\r\n`, file.bytes, '\r\n')
    }
    parts.push(`--${boundary}--\r\n`)
    const body = Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part) : part))
    const headers = { 'content-type': `multipart/form-data; boundary=${boundary}` }
    return api.result(method, await api.request(`${api.base}/${method}`, { method: 'POST', headers, body }, { timeoutMs: 55_000 }))
  }
  return {
    call: (method, fields) => api.call(method, fields),
    multipart: (method, fields, fieldName, file) => send(method, fields, [{ fieldName, file }]),
    multipartFiles: (method, fields, files) => send(method, fields, files),
  }
}

// Runs each case in turn through api (TelegramApi's call, multipart and multipartFiles, or the stand-ins' fakes for them),
// and deletes each message it took once its case is read. A run that stops partway, on a call that failed to reach
// Telegram or a message an edit case could not send, deletes every message still undeleted before it returns. The outcome
// names each message it could not delete.
export async function runCases({ api, chat, pace, note = () => {} }) {
  // One call, after the pace: its result, or Telegram's refusal and its description. A 429 sends the call once more, after
  // TelegramApi has waited out its retry_after, which it does before its next call; a second 429 stops the run.
  const refusal = error => typeof error?.code === 'number' && error.code >= 400 && error.code < 500
  const attempt = async call => {
    await pause(pace)
    try { return { ok: true, result: await call() } } catch (error) { if (!refusal(error)) throw error; return { ok: false, error } }
  }
  const ask = async call => {
    let a = await attempt(call)
    if (!a.ok && a.error.code === 429) {
      note(`Telegram asks to wait ${Math.ceil((a.error.retryAfterMs || 0) / 1000)} s; waiting`)
      a = await attempt(call)
      if (!a.ok && a.error.code === 429) throw a.error
    }
    return a.ok ? a : { ok: false, description: a.error.message }
  }
  const taken = new Set()
  const took = result => { for (const m of Array.isArray(result) ? result : [result]) if (typeof m?.message_id === 'number') taken.add(m.message_id) }
  const undeleted = []
  const remove = async () => {
    for (const id of [...taken]) {
      taken.delete(id)
      let gone = false
      try { gone = (await ask(() => api.call('deleteMessage', { chat_id: chat, message_id: id }))).ok } catch {}
      if (!gone) undeleted.push(id)
    }
  }
  const sendDocument = text => api.multipart('sendDocument', { chat_id: chat, caption: text, disable_notification: true }, 'document', FILE)
  const cases = []
  try {
    for (const c of CASES) {
      let target
      if (c.method.startsWith('edit')) {
        const ofText = c.method === 'editMessageText' ? c.on !== 'file' : c.on === 'text'
        const base = await ask(() => ofText ? api.call('sendMessage', { chat_id: chat, text: BASE, disable_notification: true }) : sendDocument(BASE))
        if (!base.ok) throw new Error(`the message ${c.name} edits was refused: ${base.description}`)
        took(base.result)
        target = base.result.message_id
      }
      const a = await ask(() => c.method === 'sendDocument' ? sendDocument(c.value)
        : c.method === 'sendMediaGroup' ? api.multipartFiles('sendMediaGroup', { chat_id: chat, disable_notification: true, media: [
          { type: 'document', media: 'attach://file0', caption: c.value }, { type: 'document', media: 'attach://file1' }] },
        [{ fieldName: 'file0', file: FILE }, { fieldName: 'file1', file: FILE }])
          : c.method === 'editMessageText' ? api.call(c.method, { chat_id: chat, message_id: target, text: c.value })
            : api.call(c.method, { chat_id: chat, message_id: target, caption: c.value }))
      let seen
      if (!a.ok) seen = { refused: a.description }
      else {
        if (c.method.startsWith('send')) took(a.result)
        seen = c.method === 'sendMediaGroup' ? { captions: a.result.map(m => m.caption ?? null) }
          : c.method === 'editMessageText' || a.result === true ? { edited: true }
            : { caption: a.result.caption ?? null }
      }
      cases.push({ name: c.name, seen })
      await remove()
    }
    return { cases, undeleted }
  } catch (error) {
    return { cases, stopped: error instanceof Error ? error.message : String(error), undeleted }
  } finally {
    await remove()
  }
}

// A text as a line can show it: quoted, each character outside printable ASCII escaped, and a run of more than eight of one
// character written once with its count.
export function quote(s) {
  const one = ch => {
    if (ch === '"' || ch === '\\') return `\\${ch}`
    if (ch === '\n') return '\\n'
    if (ch === '\t') return '\\t'
    if (ch === '\r') return '\\r'
    const cp = ch.codePointAt(0)
    if (cp >= 0x20 && cp < 0x7f) return ch
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`
  }
  const chars = [...s]
  let out = ''
  for (let i = 0; i < chars.length;) {
    let j = i
    while (j < chars.length && chars[j] === chars[i]) j++
    out += j - i > 8 ? `{${one(chars[i])}\u00d7${j - i}}` : chars.slice(i, j).map(one).join('')
    i = j
  }
  return `"${out}"`
}
export function show(seen) {
  if ('refused' in seen) return `refused: ${seen.refused}`
  if ('caption' in seen) return seen.caption === null ? 'no caption' : `caption ${quote(seen.caption)}`
  if ('captions' in seen) return `captions [${seen.captions.map(c => c === null ? 'none' : quote(c)).join(', ')}]`
  return 'edited'
}

// Every part of a token a line could hold: the whole, the bot's id before its colon and the secret after it.
function masker(token) {
  const parts = [token, ...token.split(':')].filter(p => p.length >= 4).sort((a, b) => b.length - a.length)
  return line => parts.reduce((l, p) => l.split(p).join('<token>'), line)
}

const USAGE = 'usage: TELEGRAM_LIVE_CHECK_TOKEN=<bot token> node test/live-check.js --chat <chat id> [--pace <ms>]'

async function main() {
  const token = process.env.TELEGRAM_LIVE_CHECK_TOKEN ?? ''
  const mask = masker(token)
  const say = line => console.log(mask(line))
  const warn = line => console.error(mask(line))
  const args = process.argv.slice(2)
  let chat, pace = 1000
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]]
    if (flag === '--chat' && value !== undefined && /^(-?\d+|@\w+)$/.test(value)) chat = value
    else if (flag === '--pace' && value !== undefined && /^\d+$/.test(value)) pace = Number(value)
    else { warn(`live-check: ${flag} ${value ?? ''} is not an option it takes; nothing was sent\n${USAGE}`); return 2 }
  }
  if (!token) { warn(`live-check: no token: set TELEGRAM_LIVE_CHECK_TOKEN to the bot's token; nothing was sent\n${USAGE}`); return 2 }
  if (!chat) { warn(`live-check: no chat: name it with --chat; nothing was sent\n${USAGE}`); return 2 }

  const stand = await runCases({ api: standInApi(), chat, pace: 0 })
  if (stand.stopped !== undefined) { warn(`live-check: the stand-ins' run failed (${stand.stopped}); nothing was sent`); return 2 }
  const api = new TelegramApi(token)
  let live
  try { live = await runCases({ api: exactApi(api), chat, pace, note: say }) } finally { api.close() }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const differ = []
  for (const { name, seen } of live.cases) {
    const s = stand.cases.find(c => c.name === name)
    if (s && same(seen, s.seen)) { say(`same     ${name}: ${show(seen)}`); continue }
    differ.push(name)
    say(`DIFFERS  ${name}: Telegram ${show(seen)}; the stand-ins ${s ? show(s.seen) : 'ran no such case'}`)
  }
  say(`${live.cases.length - differ.length} of ${CASES.length} cases agree` + (differ.length ? `; ${differ.length} differ: ${differ.join(', ')}` : ''))
  if (live.stopped !== undefined) warn(`live-check: the run stopped after ${live.cases.length} of ${CASES.length} cases: ${live.stopped}`)
  if (live.undeleted.length) warn(`live-check: ${live.undeleted.length} messages it sent could not be deleted: ${live.undeleted.join(', ')}`)
  if (live.stopped !== undefined || live.undeleted.length) return 2
  return differ.length ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main()
