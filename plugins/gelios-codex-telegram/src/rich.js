// Telegram rich messages (Bot API 10.3): replies written in GitHub Markdown
// render with native headings, tables, task lists, code blocks, quotes and
// collapsible details. The bridge sends Telegram's own rich Markdown, through
// sendRichMessage and editMessageText, and falls back to plain text when
// Telegram rejects the content. This is AXEG0/claude-telegram's rich.ts,
// ported with the same parser, limits and fallback. Its parse half is
// rich-parse.js, which the worker loads, so the bridge's own thread never
// compiles the parser unless the worker cannot run.

import { Worker } from 'node:worker_threads'

// Telegram rejects a rich message over 32768 characters, rejected one of 600
// paragraphs (the docs say 500 blocks; list items and table rows did not
// count), and cuts its text past about 35000 UTF-8 bytes without an error, so
// a 32000-character Russian reply lost half. Parts stay inside all three,
// counted in UTF-8 bytes of what is sent and in top-level blocks.
export const RICH_PART_BYTES = 30_000
export const RICH_PART_BLOCKS = 400

// Whether a failed rich send or edit goes out plain instead: Telegram rejected
// the content (400, e.g. RICH_MESSAGE_MARKDOWN_INVALID) or the Bot API server
// has no rich messages (404). An unchanged edit, a rate limit or a network
// error is not a reason to. Telegram's code and description arrive as the
// TelegramError's code and message.
export function plainFallback(err) {
  if (err?.code === 404) return true
  return err?.code === 400 && !/message is not modified/i.test(err?.message ?? '')
}

// The parser takes seconds on pathological Markdown (400 nested list levels
// took 5 s), and the bridge's one thread also polls, types and steers turns.
// Parts are therefore computed in one worker for the bridge (a worker per call
// leaked half a megabyte each), replaced when a parse overruns ms. Text not
// split in time, or that the parser fails on, goes out plain as one part.
// Without a worker, as when its file does not load, parts are computed here.
export const RICH_PARSE_MS = 5000

// Each call takes the log its lines go to; the bridge passes its own.
const stderrLog = line => process.stderr.write(`${line}\n`)
const pending = new Map()
let worker
let workerLoaded = false
let workerBroken = false
let lastId = 0

function plainPart(text, why, log) {
  log(`telegram: rich parse failed, sending plain: ${why}`)
  return [{ plain: text }]
}

async function partsHere(text, limits, log) {
  try {
    const { richParts } = await import('./rich-parse.js')
    return richParts(text, limits)
  } catch (err) {
    return plainPart(text, describe(err), log)
  }
}

function stopWorker(settle) {
  worker?.terminate()
  worker = undefined
  workerLoaded = false
  const waiting = [...pending.values()]
  pending.clear()
  for (const p of waiting) p.resolve(settle(p))
}

function startWorker(log) {
  if (worker || workerBroken) return worker
  try {
    const w = new Worker(new URL('./rich-worker.js', import.meta.url))
    w.on('message', data => {
      if (data.loaded) {
        workerLoaded = true
        return
      }
      const p = pending.get(data.id)
      if (!p) return
      pending.delete(data.id)
      p.resolve(data.parts ?? plainPart(p.text, String(data.error), p.log))
    })
    w.on('error', err => {
      if (worker !== w) return
      // A worker that never loaded will not load next time either.
      if (!workerLoaded) {
        workerBroken = true
        log(`telegram: rich worker did not load, parsing in the bridge: ${describe(err)}`)
        stopWorker(p => partsHere(p.text, p.limits, p.log))
      } else stopWorker(p => plainPart(p.text, describe(err), p.log))
    })
    w.on('exit', code => {
      if (worker === w) stopWorker(p => plainPart(p.text, `rich worker exited with code ${code}`, p.log))
    })
    w.unref()
    worker = w
  } catch (err) {
    workerBroken = true
    log(`telegram: rich worker did not start, parsing in the bridge: ${describe(err)}`)
  }
  return worker
}

export function richPartsAsync(text, limits, { ms = RICH_PARSE_MS, log = stderrLog } = {}) {
  const w = startWorker(log)
  if (!w) return Promise.resolve(partsHere(text, limits, log))
  const id = ++lastId
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return
      resolve(plainPart(text, `no result in ${ms} ms`, log))
      // The worker is stuck on this text; what waits behind it goes plain too.
      stopWorker(p => plainPart(p.text, 'parser restarted', p.log))
    }, ms)
    pending.set(id, {
      text,
      limits,
      log,
      resolve: parts => {
        clearTimeout(timer)
        resolve(parts)
      },
    })
    w.postMessage({ id, text, limits })
  })
}

// Sends text as rich messages; a part Telegram rejects, or one only plain
// text keeps whole, goes out plain, cut by plainChunks. send(method, params)
// makes one Bot API call. Message ids land in progress.ids as they are sent,
// with progress.rich holding those sent as rich messages, and progress.done
// counts finished parts of progress.total, so a failure part way reports
// what already went out.
// allowMissingReply false, as in a group, makes a deleted reply target fail the send instead. carry, when
// set, puts question buttons on the last message sent (see questions.js); Telegram refusing the keyboard
// (carry.refused) fails the reply, with no plain copy.
export async function sendRich({ send, chatId, text, replyTo, plainChunks, progress, sent, carry, allowMissingReply = true, log = stderrLog }) {
  const parts = await richPartsAsync(text, undefined, { log })
  progress.total = parts.length
  const replyParams = () => {
    const to = replyTo(progress.ids.length)
    return to != null ? { reply_parameters: { message_id: to, ...(allowMissingReply ? { allow_sending_without_reply: true } : {}) } } : {}
  }
  const via = (last, call) => carry ? carry.wrap(last, call) : call({})
  for (const [index, part] of parts.entries()) {
    const lastPart = index === parts.length - 1
    if (part.rich !== undefined) {
      try {
        const params = { chat_id: chatId, rich_message: { markdown: part.rich }, ...replyParams() }
        const message = await via(lastPart, extra => send('sendRichMessage', { ...params, ...extra }))
        progress.ids.push(message.message_id)
        progress.rich.push(message.message_id)
        sent?.(message.message_id, part.plain)
        progress.done++
        continue
      } catch (err) {
        if (!plainFallback(err) || (lastPart && carry?.refused(err))) throw err
        log(`telegram: rich message rejected, sending plain: ${describe(err)}`)
      }
    }
    const chunks = plainChunks(part.plain)
    for (const [at, chunk] of chunks.entries()) {
      const params = { chat_id: chatId, text: chunk, ...replyParams() }
      const message = await via(lastPart && at === chunks.length - 1, extra => send('sendMessage', { ...params, ...extra }))
      progress.ids.push(message.message_id)
      sent?.(message.message_id, chunk)
    }
    progress.done++
  }
}

// The rich Markdown for an edit to text, or undefined when only plain text
// keeps it whole. Only Telegram's size limit applies here: an edit has no
// second message.
export async function richEditParse(text, log = stderrLog) {
  const parts = await richPartsAsync(text, { bytes: RICH_PART_BYTES, blocks: Infinity }, { log })
  if (parts.length > 1) throw new Error('text too long for one rich message: send it with reply instead')
  return parts[0]?.rich
}

// Edits a message into rich text; if Telegram rejects the content, into plain. markup, when set, is the
// message's new keyboard, and Telegram refusing it (refused) fails the edit.
export async function editRichParsed({ send, chatId, messageId, text, rich, markup, refused, log = stderrLog }) {
  const keyboard = markup ? { reply_markup: markup } : {}
  if (rich !== undefined) {
    try {
      await send('editMessageText', { chat_id: chatId, message_id: messageId, rich_message: { markdown: rich }, ...keyboard })
      return
    } catch (err) {
      if (!plainFallback(err) || (markup && refused?.(err))) throw err
      log(`telegram: rich edit rejected, editing plain: ${describe(err)}`)
    }
  }
  await send('editMessageText', { chat_id: chatId, message_id: messageId, text, ...keyboard })
}

// The text of a rich message, block by block, for a reply to one of the bot's
// rich replies, which carry no plain text.
function inline(x) {
  if (typeof x === 'string') return x
  if (Array.isArray(x)) return x.map(inline).join('')
  if (x && typeof x === 'object') return inline(x.text ?? x.expression ?? '')
  return ''
}
function block(b) {
  return [
    inline(b.summary),
    inline(b.text),
    typeof b.expression === 'string' ? b.expression : '',
    ...(b.blocks ?? []).map(block),
    ...(b.items ?? []).map(block),
    ...(b.cells ?? []).flat().map(c => inline(c.text)),
  ].filter(Boolean).join(' ')
}
export function richText(message) {
  const blocks = message?.rich_message?.blocks
  return Array.isArray(blocks) ? blocks.map(block).join(' ') : undefined
}

function describe(err) {
  return String(err instanceof Error ? err.message : err)
}
