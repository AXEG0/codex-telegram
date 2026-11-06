import { spawn } from './fixtures.js'
import assert from 'node:assert/strict'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CASES } from './live-check.js'
import { LONG_CAPTION, NO_CAPTION, NO_TEXT, standInApi } from './support/telegram-stand-in.js'
import { closed } from './support/wait.js'

// The live check (test/live-check.js) run against a pretend Telegram on a local port, which answers as the stand-ins do, or
// otherwise where a test says, and records every call.
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// A token that reads plainly fake, with a colon as a real one has, so the check's masking of each of its parts shows.
const TOKEN = '4242:test-bot-token'
const PARTS = [TOKEN, '4242', 'test-bot-token']
const SENDS = ['sendMessage', 'sendDocument', 'sendMediaGroup']
const BOUND = { timeout: 60_000 }

// A multipart body's text fields, each decoded from the bytes as they came, a leading U+FEFF included.
function formFields(body, boundary) {
  const fields = {}, text = new TextDecoder('utf-8', { ignoreBOM: true }), delimiter = Buffer.from(`--${boundary}`)
  for (let at = body.indexOf(delimiter), next; at >= 0; at = next) {
    next = body.indexOf(delimiter, at + delimiter.length)
    if (next < 0) break
    const part = body.subarray(at + delimiter.length + 2, next - 2), split = part.indexOf('\r\n\r\n')
    const head = part.subarray(0, split).toString(), name = /name="([^"]*)"/.exec(head)?.[1]
    if (name !== undefined && !/filename=/.test(head)) fields[name] = text.decode(part.subarray(split + 4))
  }
  return fields
}

// The pretend Telegram: each call gets `answer(call)`'s reply when it gives one, else the stand-ins' (standInApi) answer.
// A reply with `drop` closes the connection unanswered.
async function pretendTelegram(t, answer = () => undefined) {
  const standIn = standInApi({ firstId: 1 })
  const calls = []
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks), type = request.headers['content-type'] || ''
    const fields = type.startsWith('multipart/') ? formFields(body, /boundary=(.+)$/.exec(type)[1]) : Object.fromEntries(new URLSearchParams(body.toString()))
    const [, token, method] = /^\/bot([^/]*)\/(\w+)$/.exec(request.url) || []
    const call = { method, token, fields, at: Date.now() }
    calls.push(call)
    try {
      call.reply = answer(call) ?? { ok: true, result: method === 'sendDocument' ? await standIn.multipart(method, fields, 'document', {})
        : method === 'sendMediaGroup' ? await standIn.multipartFiles(method, { ...fields, media: JSON.parse(fields.media) }, [])
          : await standIn.call(method, fields) }
    } catch (error) { call.reply = { ok: false, error_code: error.code, description: error.message } }
    if (call.reply.drop) { request.socket.destroy(); return }
    response.statusCode = call.reply.ok ? 200 : call.reply.error_code
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(call.reply))
  })
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  t.after(() => { server.closeAllConnections(); server.close() })
  return { calls, base: `http://127.0.0.1:${server.address().port}` }
}

async function check(t, base, { token, args = ['--chat', '5', '--pace', '0'] } = {}) {
  const env = { PATH: process.env.PATH, GELIOS_TELEGRAM_API_BASE: base }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  if (token !== undefined) env.TELEGRAM_LIVE_CHECK_TOKEN = token
  const child = spawn(process.execPath, [join(plugin, 'test', 'live-check.js'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
  await closed(t, child)
  return { code: child.exitCode, out, err, lines: out.split('\n').filter(Boolean) }
}

// The ids of the messages each send took, and the deletes: each message taken is deleted exactly once, and before the next
// send, so a case's messages are gone before the next case sends.
function deletes(calls) {
  const pending = new Set(), taken = [], deleted = []
  for (const c of calls) {
    if (SENDS.includes(c.method) && c.reply?.ok) {
      assert.deepEqual({ before: c.method, pending: [...pending] }, { before: c.method, pending: [] })
      for (const m of [c.reply.result].flat()) { taken.push(m.message_id); pending.add(m.message_id) }
    }
    if (c.method === 'deleteMessage') { deleted.push(Number(c.fields.message_id)); pending.delete(Number(c.fields.message_id)) }
  }
  return { taken: taken.sort((a, b) => a - b), deleted: deleted.sort((a, b) => a - b) }
}
const names = lines => lines.map(line => line.split(':')[0])

test('live check: without a token or a chat it refuses before any call', BOUND, async t => {
  const telegram = await pretendTelegram(t)
  const none = await check(t, telegram.base)
  assert.equal(none.code, 2)
  assert.match(none.err, /^live-check: no token: set TELEGRAM_LIVE_CHECK_TOKEN to the bot's token; nothing was sent$/m)
  assert.equal(none.out, '')
  const noChat = await check(t, telegram.base, { token: TOKEN, args: ['--pace', '0'] })
  assert.equal(noChat.code, 2)
  assert.match(noChat.err, /^live-check: no chat: name it with --chat; nothing was sent$/m)
  assert.equal(noChat.out, '')
  assert.deepEqual(telegram.calls, [])
  for (const part of PARTS) assert.ok(!noChat.err.includes(part), part)
})

test('live check: where Telegram answers as the stand-ins do, every case agrees, each send is silent, each message it took is deleted, and no part of the token shows', BOUND, async t => {
  const telegram = await pretendTelegram(t)
  const r = await check(t, telegram.base, { token: TOKEN })
  assert.equal(r.err, '')
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(names(r.lines.slice(0, -1)), CASES.map(c => `same     ${c.name}`))
  assert.equal(r.lines.at(-1), `${CASES.length} of ${CASES.length} cases agree`)
  assert.deepEqual([...new Set(telegram.calls.map(c => c.token))], [TOKEN])
  const sends = telegram.calls.filter(c => SENDS.includes(c.method))
  // Each case sends once: its own message, or the one its edit edits.
  assert.equal(sends.length, CASES.length)
  assert.deepEqual(sends.filter(c => c.fields.disable_notification !== 'true'), [])
  const { taken, deleted } = deletes(telegram.calls)
  assert.ok(taken.length > CASES.length / 2)
  assert.deepEqual(deleted, taken)
  for (const part of PARTS) assert.ok(!(r.out + r.err).includes(part), part)
})

test('live check: each case where Telegram answers otherwise is named with both answers, without any part of the token, and the check exits 1', BOUND, async t => {
  const telegram = await pretendTelegram(t, ({ method, fields }) => {
    // Telegram keeps no caption, takes a caption the stand-ins refuse, and refuses an edit with the token in its answer.
    if (method === 'sendDocument' && fields.caption === '\tx\t') return { ok: true, result: { message_id: 900, document: { file_id: 'f' } } }
    if (method === 'sendDocument' && fields.caption === 'x'.repeat(1025)) return { ok: true, result: { message_id: 901, document: { file_id: 'f' }, caption: fields.caption } }
    if (method === 'editMessageCaption' && fields.caption === '\tedited\t') return { ok: false, error_code: 400, description: `Bad Request: ${TOKEN}, 4242 and test-bot-token` }
  })
  const r = await check(t, telegram.base, { token: TOKEN })
  assert.equal(r.code, 1)
  const differ = r.lines.filter(line => line.startsWith('DIFFERS'))
  assert.equal(differ.length, 3)
  assert.match(differ[0], /^DIFFERS {2}caption-tab-ends: Telegram no caption; the stand-ins caption "(x|\\tx\\t)"$/)
  assert.equal(differ[1], 'DIFFERS  caption-1025: Telegram caption "{x\u00d71025}"; the stand-ins refused: Bad Request: message caption is too long')
  assert.match(differ[2], /^DIFFERS {2}caption-edit-tab-ends: Telegram refused: Bad Request: <token>, <token> and <token>; the stand-ins caption "(edited|\\tedited\\t)"$/)
  assert.equal(r.lines.filter(line => line.startsWith('same')).length, CASES.length - 3)
  assert.equal(r.lines.at(-1), `${CASES.length - 3} of ${CASES.length} cases agree; 3 differ: caption-tab-ends, caption-1025, caption-edit-tab-ends`)
  for (const part of PARTS) assert.ok(!(r.out + r.err).includes(part), part)
  // What Telegram took is deleted, whatever the stand-ins answered.
  const { taken, deleted } = deletes(telegram.calls)
  assert.ok(taken.includes(900) && taken.includes(901))
  assert.deepEqual(deleted, taken)
})

test('live check: a run that stops partway deletes every message it took, and exits 2 naming where it stopped', BOUND, async t => {
  // The first caption edit's connection closes unanswered, once the message it edits is sent.
  let dropped = false
  const telegram = await pretendTelegram(t, ({ method }) => {
    if (method === 'editMessageCaption' && !dropped) { dropped = true; return { drop: true } }
  })
  const r = await check(t, telegram.base, { token: TOKEN })
  const at = CASES.findIndex(c => c.method === 'editMessageCaption')
  assert.equal(r.code, 2)
  assert.match(r.err, new RegExp(`^live-check: the run stopped after ${at} of ${CASES.length} cases: fetch failed$`, 'm'))
  assert.deepEqual(names(r.lines.slice(0, -1)), CASES.slice(0, at).map(c => `same     ${c.name}`))
  const failed = telegram.calls.findIndex(c => c.reply?.drop)
  assert.equal(telegram.calls[failed].method, 'editMessageCaption')
  const { taken, deleted } = deletes(telegram.calls)
  assert.deepEqual(deleted, taken)
  // The message the failed edit was for is deleted after it.
  const base = telegram.calls[failed - 1]
  assert.equal(base.method, 'sendMessage')
  assert.deepEqual(telegram.calls.slice(failed + 1).map(c => [c.method, Number(c.fields.message_id)]), [['deleteMessage', base.reply.result.message_id]])
})

test('live check: calls to Telegram go a second apart, or --pace milliseconds apart', BOUND, async t => {
  // Each run stops at its first text edit, whose connection closes unanswered.
  const stop = ({ method }) => method === 'editMessageText' ? { drop: true } : undefined
  const gaps = calls => calls.slice(1).map((c, i) => c.at - calls[i].at)
  const slow = await pretendTelegram(t, stop)
  assert.equal((await check(t, slow.base, { token: TOKEN, args: ['--chat', '5'] })).code, 2)
  assert.deepEqual(slow.calls.map(c => c.method), ['sendMessage', 'editMessageText', 'deleteMessage'])
  for (const gap of gaps(slow.calls)) assert.ok(gap >= 995, `${gap} ms`)
  const paced = await pretendTelegram(t, stop)
  assert.equal((await check(t, paced.base, { token: TOKEN, args: ['--chat', '5', '--pace', '300'] })).code, 2)
  assert.deepEqual(paced.calls.map(c => c.method), ['sendMessage', 'editMessageText', 'deleteMessage'])
  for (const gap of gaps(paced.calls)) assert.ok(gap >= 295 && gap < 995, `${gap} ms`)
})

test('live check: a 429 waits out its retry_after and sends the call again', BOUND, async t => {
  let held = false
  const telegram = await pretendTelegram(t, ({ method }) => {
    if (method === 'sendDocument' && !held) { held = true; return { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } } }
  })
  const r = await check(t, telegram.base, { token: TOKEN })
  assert.equal(r.code, 0)
  assert.equal(r.lines[0], 'Telegram asks to wait 1 s; waiting')
  const [first, second] = telegram.calls.filter(c => c.method === 'sendDocument')
  assert.equal(first.reply.error_code, 429)
  assert.deepEqual(second.fields, first.fields)
  assert.ok(second.at - first.at >= 995, `${second.at - first.at} ms`)
  assert.equal(r.lines.at(-1), `${CASES.length} of ${CASES.length} cases agree`)
})

test('live check: a second 429 in a row stops the run, and it exits 2', BOUND, async t => {
  const telegram = await pretendTelegram(t, ({ method }) => method === 'sendDocument'
    ? { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } } : undefined)
  const r = await check(t, telegram.base, { token: TOKEN })
  // The first file sent is the one the first text edit of a file edits.
  const at = CASES.findIndex(c => c.method === 'sendDocument' || (c.method === 'editMessageText' && c.on === 'file'))
  assert.equal(r.code, 2)
  assert.match(r.err, new RegExp(`^live-check: the run stopped after ${at} of ${CASES.length} cases: Too Many Requests: retry after 1$`, 'm'))
  assert.equal(telegram.calls.filter(c => c.method === 'sendDocument').length, 2)
  const { taken, deleted } = deletes(telegram.calls)
  assert.deepEqual(deleted, taken)
})

test('live check: the stand-ins answer each call the check makes as their rules keep it', async () => {
  const api = standInApi({ firstId: 1 })
  assert.deepEqual(await api.multipart('sendDocument', { chat_id: '5', caption: '\tx\t' }, 'document', {}), { message_id: 1, document: { file_id: 'file-1' }, caption: 'x' })
  assert.deepEqual(await api.call('sendMessage', { chat_id: '5', text: 'a' }), { message_id: 2 })
  // A caption edit of a file they sent answers with that file and the caption they keep, or none, under its own id.
  assert.deepEqual(await api.call('editMessageCaption', { chat_id: '5', message_id: '1', caption: '\tedited\t' }), { message_id: 1, document: { file_id: 'file-1' }, caption: 'edited' })
  assert.deepEqual(await api.call('editMessageCaption', { chat_id: '5', message_id: '1', caption: ' \t\r ' }), { message_id: 1, document: { file_id: 'file-1' } })
  assert.deepEqual(await api.call('editMessageText', { chat_id: '5', message_id: '2', text: 'b' }), { message_id: 5 })
  await assert.rejects(api.call('editMessageText', { chat_id: '5', message_id: '1', text: 'b' }), { message: NO_TEXT, code: 400 })
  await assert.rejects(api.call('editMessageCaption', { chat_id: '5', message_id: '2', caption: 'b' }), { message: NO_CAPTION, code: 400 })
  await assert.rejects(api.multipart('sendDocument', { chat_id: '5', caption: 'x'.repeat(1025) }, 'document', {}), { message: LONG_CAPTION, code: 400 })
  const media = caption => [{ type: 'document', media: 'attach://file0', caption }, { type: 'document', media: 'attach://file1' }]
  await assert.rejects(api.multipartFiles('sendMediaGroup', { chat_id: '5', media: media('x'.repeat(1025)) }, []), { message: LONG_CAPTION, code: 400 })
  assert.deepEqual(await api.multipartFiles('sendMediaGroup', { chat_id: '5', media: media('\tx\t') }, []),
    [{ message_id: 6, document: { file_id: 'file-6' }, caption: 'x' }, { message_id: 7, document: { file_id: 'file-7' } }])
})
