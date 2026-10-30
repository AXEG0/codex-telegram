import { mkdtempSync, spawn } from './fixtures.js'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { StateStore, chunkText } from '../src/core.js'
import { BOT_OPENER, TelegramChannel, TelegramError } from '../src/telegram.js'
import { OpenAITranscriber, TRANSCRIPT_PREFIX, transcriptionPlan } from '../src/transcription.js'
import { ReactionQueue } from '../src/reactions.js'

const TOKEN = `4321:${'c'.repeat(32)}`
function fixture(t, { users = { '123': { chatId: '123', alias: 'Owner', role: 'admin' } }, transcriber = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-delivery-')), workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const store = new StateStore(join(root, 'state')), events = [], calls = [], logs = []
  store.saveAccess({ version: 2, dmPolicy: 'allowlist', pending: {}, groups: {}, mentionPatterns: [], users })
  const channel = new TelegramChannel({ store, workspaceRoot: workspace, token: TOKEN, transcriber,
    onInbound: async (event, prepare) => events.push(await prepare()), log: line => logs.push(line) })
  channel.batcher.gap = () => 0
  channel.learnPeer({ id: 123, is_bot: false })
  let next = 100
  channel.api.call = async (method, params) => { calls.push({ method, params }); return { message_id: ++next, chat: { id: Number(params.chat_id) || 0 } } }
  t.after(() => channel.stop())
  return { store, events, calls, logs, channel, root, workspace }
}

test('F08: rich stays the default; text and markdownv2 are explicit; an invalid format sends and journals nothing', async t => {
  const f = fixture(t)
  await f.channel.sendReply({ chat_id: '123', text: 'plain *as written*', format: 'text' })
  assert.deepEqual(f.calls.map(call => [call.method, call.params.parse_mode]), [['sendMessage', undefined]])
  await f.channel.sendReply({ chat_id: '123', text: '*bold*', format: 'markdownv2' })
  assert.equal(f.calls.at(-1).params.parse_mode, 'MarkdownV2')
  await f.channel.sendReply({ chat_id: '123', text: '| a | b |\n|---|---|\n| 1 | 2 |' })
  assert.equal(f.calls.at(-1).method, 'sendRichMessage')
  const before = Object.keys(f.store.loadRuntime().events).length; const sent = f.calls.length
  for (const format of ['html', null, 'RICH']) await assert.rejects(f.channel.sendReply({ chat_id: '123', text: 'x', format }), /is not one of rich, text, markdownv2, so nothing was sent/)
  assert.equal(f.calls.length, sent)
  assert.equal(Object.keys(f.store.loadRuntime().events).length, before)
  // Edits take the same formats; an invalid one edits nothing.
  f.store.rememberMessage('123', '101', { text: 'old', sender: { name: 'Codex', isBot: true, isSelf: true } })
  await f.channel.editMessage({ chat_id: '123', message_id: '101', text: '_new_', format: 'markdownv2' })
  assert.deepEqual([f.calls.at(-1).method, f.calls.at(-1).params.parse_mode], ['editMessageText', 'MarkdownV2'])
  await f.channel.editMessage({ chat_id: '123', message_id: '101', text: 'as written', format: 'text' })
  assert.deepEqual([f.calls.at(-1).params.text, f.calls.at(-1).params.parse_mode, f.calls.at(-1).params.rich_message], ['as written', undefined, undefined])
  await assert.rejects(f.channel.editMessage({ chat_id: '123', message_id: '101', text: 'x', format: 'bold' }), /so nothing was edited/)
})

test('B02: an established bot gets every format as literal plain text by its numeric chat, as before', async t => {
  const f = fixture(t, { users: { '777': { chatId: '777', alias: 'peer', role: 'contributor' } } })
  f.channel.learnPeer({ id: 777, is_bot: true })
  for (const format of [undefined, 'markdownv2', 'text']) await f.channel.sendReply({ chat_id: '777', text: '**literal**', format })
  assert.deepEqual(f.calls.map(call => [call.method, call.params.chat_id, call.params.text, call.params.parse_mode]),
    [0, 1, 2].map(() => ['sendMessage', '777', '**literal**', undefined]))
})

test('F14: chunk limit, chunk mode and reply threading apply; an invalid setting sends nothing; pairs are never split', async t => {
  const f = fixture(t)
  writeFileSync(f.store.configPath, JSON.stringify({ textChunkLimit: 6, chunkMode: 'length', replyToMode: 'all' }))
  await f.channel.sendReply({ chat_id: '123', text: 'abcdefghijklm', reply_to: '9', format: 'text' })
  assert.deepEqual(f.calls.map(call => call.params.text), ['abcdef', 'ghijkl', 'm'])
  assert.ok(f.calls.every(call => call.params.reply_parameters?.message_id === 9))
  writeFileSync(f.store.configPath, JSON.stringify({ textChunkLimit: 0 }))
  const sent = f.calls.length
  await assert.rejects(f.channel.sendReply({ chat_id: '123', text: 'x' }), /textChunkLimit must be a whole number from 1 to 4096; nothing was sent/)
  assert.equal(f.calls.length, sent)
  assert.deepEqual(chunkText('ab😀cd', 3, 'length'), ['ab', '😀c', 'd'])
  assert.deepEqual(chunkText('😀😀', 1, 'length'), ['😀', '😀'])
  // MarkdownV2 is never cut: text longer than one message is refused before anything goes.
  writeFileSync(f.store.configPath, JSON.stringify({ textChunkLimit: 5 }))
  await assert.rejects(f.channel.sendReply({ chat_id: '123', text: '*bold text*', format: 'markdownv2' }), /markdownv2 text must fit one message of 5 characters; nothing was sent/)
  assert.equal(f.calls.length, sent)
  assert.deepEqual(chunkText('one two three', 8, 'newline'), ['one two', 'three'])
})

test('F14: the receipt reaction is off by default, set only by receiptReaction, skips edits and survives restart', async t => {
  const f = fixture(t)
  const message = (id, extra = {}) => ({ update_id: id, message: { message_id: id, date: id, chat: { id: 123, type: 'private' }, from: { id: 123 }, text: `m${id}`, ...extra } })
  await f.channel.handleUpdate(message(1))
  assert.equal(f.calls.some(call => call.method === 'setMessageReaction'), false)
  writeFileSync(f.store.configPath, JSON.stringify({ receiptReaction: '👀' }))
  await f.channel.handleUpdate(message(2))
  await f.channel.reactions.flush('123:2')
  assert.deepEqual(f.calls.filter(call => call.method === 'setMessageReaction').map(call => [call.params.message_id, call.params.reaction]), [[2, [{ type: 'emoji', emoji: '👀' }]]])
  await f.channel.handleUpdate({ update_id: 3, edited_message: { message_id: 2, date: 2, edit_date: 3, chat: { id: 123, type: 'private' }, from: { id: 123 }, text: 'changed' } })
  assert.equal(f.calls.filter(call => call.method === 'setMessageReaction').length, 1)
  // A chosen reaction is never replaced by the receipt, and startup keeps the receipt.
  await f.channel.agentReact({ chat_id: '123', message_id: '4', emoji: '👍' })
  f.channel.acknowledge('123', '4')
  const queue = new ReactionQueue({ store: f.store, send: async () => {}, authorize: () => {}, log: () => {} })
  queue.retireReceipts()
  const saved = f.store.loadRuntime().acknowledgements
  assert.deepEqual([saved['123:2'].kind, saved['123:2'].emoji, saved['123:4'].emoji], ['ack', '👀', '👍'])
})

test('B01: a pinned bot that never wrote gets only the fixed opener by username; its reply proves the numeric route', async t => {
  const f = fixture(t, { users: { '123': { chatId: '123', alias: 'Owner', role: 'admin' },
    '7012': { chatId: '7012', alias: 'peer', role: 'contributor', botUsername: 'xybot', botPinnedAt: '2026-10-29T00:00:00.000Z' } } })
  let chatFor = '8888'
  f.channel.api.call = async (method, params) => {
    f.calls.push({ method, params })
    if (method === 'getChat') return { id: Number(chatFor) }
    if (method === 'getChatMember') return { user: { id: 7012, is_bot: true, username: 'xybot' } }
    return { message_id: 50 + f.calls.length, chat: { id: 7012 } }
  }
  // A reassigned username resolves to another chat: nothing at all is sent.
  await assert.rejects(f.channel.sendReply({ chat_id: '7012', text: 'private payload' }), /@xybot is chat 8888, not 7012; nothing was sent/)
  assert.equal(f.calls.some(call => call.method === 'sendMessage'), false)
  chatFor = '7012'
  await assert.rejects(f.channel.sendReply({ chat_id: '7012', text: 'private payload' }), /a fixed opener went to @xybot; nothing from this reply was sent/)
  const sends = () => f.calls.filter(call => call.method === 'sendMessage')
  assert.deepEqual(sends().map(call => [call.params.chat_id, call.params.text]), [['@xybot', BOT_OPENER]])
  // Until the bot answers, the reply stays unavailable and the opener is not sent again.
  await assert.rejects(f.channel.sendReply({ chat_id: '7012', text: 'private payload' }), /has not answered the opener/)
  assert.equal(sends().length, 1)
  await f.channel.handleUpdate({ update_id: 5, message: { message_id: 5, date: 5, chat: { id: 7012, type: 'private' }, from: { id: 7012, is_bot: true, username: 'xybot' }, text: 'hello back' } })
  assert.equal(f.events.at(-1).text, 'hello back')
  await f.channel.sendReply({ chat_id: '7012', text: '**private payload**' })
  assert.deepEqual(sends().slice(1).map(call => [call.params.chat_id, call.params.text]), [['7012', '**private payload**']])
  assert.equal(sends().some(call => call.params.chat_id === '@xybot' && call.params.text !== BOT_OPENER), false)
})

test('B01: an opener that lands in another chat stops first contact until the owner pins the bot again', async t => {
  const users = { '7012': { chatId: '7012', alias: 'peer', role: 'contributor', botUsername: 'xybot', botPinnedAt: 'one' } }
  const f = fixture(t, { users })
  f.channel.api.call = async (method, params) => {
    f.calls.push({ method, params })
    if (method === 'getChat') return { id: 7012 }
    if (method === 'getChatMember') return { user: { is_bot: true } }
    return { message_id: 1, chat: { id: 4242 } }
  }
  await assert.rejects(f.channel.sendReply({ chat_id: '7012', text: 'secret' }), /reached chat 4242, not 7012; first contact stopped/)
  await assert.rejects(f.channel.sendReply({ chat_id: '7012', text: 'secret' }), /stopped: the opener sent to @xybot reached chat 4242/)
  assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 1)
  // A lost answer to the opener counts as possibly sent; a refusal does not.
  const access = f.store.loadAccess(); access.users['7012'].botPinnedAt = 'two'; f.store.saveAccess(access)
  f.channel.api.call = async method => { if (method === 'getChat') return { id: 7012 }; if (method === 'getChatMember') return { user: { is_bot: true } }; throw new TelegramError('Forbidden: bot was blocked', 403) }
  await assert.rejects(f.channel.sendReply({ chat_id: '7012', text: 'secret' }), /Forbidden/)
  f.channel.api.call = async method => { if (method === 'getChat') return { id: 7012 }; if (method === 'getChatMember') return { user: { is_bot: true } }; throw new Error('fetch failed') }
  await assert.rejects(f.channel.sendReply({ chat_id: '7012', text: 'secret' }), /fetch failed/)
  await assert.rejects(f.channel.sendReply({ chat_id: '7012', text: 'secret' }), /has not answered the opener/)
})

test('A01: requests ask for JSON, gpt-transcribe repeats languages[], one-language models take language', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-tg-audio-')); const path = join(dir, 'clip.mp3'); writeFileSync(path, 'audio')
  const bodies = []
  const transcriber = new OpenAITranscriber({ apiKey: 'k', fetchImpl: async (_url, { body }) => { bodies.push(body); return { ok: true, json: async () => ({ text: 'ok' }) } } })
  await transcriber.transcribe({ path, name: 'clip.mp3', mime: 'audio/mpeg' })
  await transcriber.transcribe({ path, name: 'clip.mp3', mime: 'audio/mpeg', settings: { languages: [' en', 'RU', 'en', ''] } })
  await transcriber.transcribe({ path, name: 'clip.mp3', mime: 'audio/mpeg', settings: { model: 'whisper-1', languages: ['pt'] } })
  assert.deepEqual(bodies.map(body => [body.get('model'), body.get('response_format'), body.getAll('languages[]'), body.get('language')]),
    [['gpt-transcribe', 'json', [], null], ['gpt-transcribe', 'json', ['en', 'ru'], null], ['whisper-1', 'json', [], 'pt']])
  assert.deepEqual(transcriptionPlan({ model: 'gpt-4o-mini-transcribe', languages: ['de'] }), { model: 'gpt-4o-mini-transcribe', field: 'language', languages: ['de'] })
})

test('A02: an unsupported model or language setting makes no request and keeps the authorized attachment', async t => {
  let requests = 0
  const transcriber = new OpenAITranscriber({ apiKey: 'k', fetchImpl: async () => { requests += 1 }, log: () => {} })
  const f = fixture(t, { transcriber })
  f.channel.api.download = async () => ({ bytes: Buffer.from('ogg'), file: { file_path: 'voice/a.mp3' } })
  for (const [index, config] of [{ transcriptionModel: 'gpt-9-transcribe' }, { transcriptionModel: 'whisper-1', transcriptionLanguages: ['en', 'fr'] }, { transcriptionLanguages: ['english'] }].entries()) {
    writeFileSync(f.store.configPath, JSON.stringify(config))
    await f.channel.handleUpdate({ update_id: 10 + index, message: { message_id: 10 + index, date: 10, chat: { id: 123, type: 'private' }, from: { id: 123 },
      audio: { file_id: `raw-${index}`, file_unique_id: `u-${index}`, file_size: 3, duration: 1, mime_type: 'audio/mpeg', file_name: 'a.mp3' } } })
  }
  assert.equal(requests, 0)
  assert.equal(f.events.length, 3)
  for (const event of f.events) { assert.match(event.attachment.handle, /^att_/); assert.doesNotMatch(event.text, new RegExp(TRANSCRIPT_PREFIX.replace(/[[\]]/g, '\\$&'))) }
  assert.equal(f.logs.filter(line => /transcription status=fallback/.test(line)).length, 3)
})

test('A03: one deadline covers lookup and download, conversion, and upload; the converter is reaped first', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-tg-audio-')); const path = join(dir, 'voice.ogg'); writeFileSync(path, 'ogg')
  // Download: getFile hangs until the job's own signal ends it.
  const logs = []
  const f = fixture(t, { transcriber: new OpenAITranscriber({ apiKey: 'k', fetchImpl: async () => assert.fail('no upload'), log: line => logs.push(line) }) })
  f.channel.audioDeadlineMs = 50
  let downloadSignal
  f.channel.api.download = (_id, _max, { signal }) => new Promise((_, reject) => { downloadSignal = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  const started = Date.now()
  await f.channel.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 123, type: 'private' }, from: { id: 123 },
    voice: { file_id: 'v', file_unique_id: 'v1', file_size: 3, duration: 1, mime_type: 'audio/ogg' } } })
  assert.ok(Date.now() - started < 5000)
  assert.equal(downloadSignal.reason.category, 'timeout')
  assert.match(f.events[0].attachment.handle, /^att_/)
  assert.ok(f.logs.some(line => /transcription status=fallback reason=timeout/.test(line)))
  assert.deepEqual(f.logs.filter(line => /transcription status=/.test(line)).map(line => line.replace(/\d+/g, 'N')), ['telegram: transcription status=fallback reason=timeout queuedMs=N preparationMs=N'])
  // Conversion: the deadline kills ffmpeg, waits for it, then removes its directory.
  const job = new AbortController(); let closed = false; let temporary
  const spawnImpl = (_bin, args) => { temporary = join(args.at(-1), '..'); const child = new EventEmitter()
    child.kill = () => { setTimeout(() => { closed = true; child.emit('close', null, 'SIGKILL') }, 5); return true }; return child }
  const converting = new OpenAITranscriber({ apiKey: 'k', spawnImpl, fetchImpl: async () => assert.fail('no upload'), log: line => logs.push(line) })
  setTimeout(() => job.abort(Object.assign(new Error('deadline'), { category: 'timeout' })), 20)
  assert.equal(await converting.transcribe({ path, name: 'voice.ogg', mime: 'audio/ogg', signal: job.signal }), null)
  assert.equal(closed, true); assert.equal(existsSync(temporary), false)
  // Upload and answer: the same signal ends the request.
  const upload = new AbortController()
  const uploading = new OpenAITranscriber({ apiKey: 'k', log: line => logs.push(line),
    fetchImpl: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) })
  setTimeout(() => upload.abort(Object.assign(new Error('deadline'), { category: 'timeout' })), 20)
  const mp3 = join(dir, 'clip.mp3'); writeFileSync(mp3, 'mp3')
  assert.equal(await uploading.transcribe({ path: mp3, name: 'clip.mp3', mime: 'audio/mpeg', signal: upload.signal }), null)
  assert.deepEqual(logs.slice(-2), ['transcription: timeout', 'transcription: timeout'])
})

async function helper(t, answer) {
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-helper-')); const socketPath = join(root, 'control.sock'); const actions = []
  const control = net.createServer(socket => socket.once('data', data => {
    const request = JSON.parse(String(data).split('\n')[0]); actions.push(request)
    const reply = answer(request)
    socket.end(`${JSON.stringify(reply)}\n`)
  }))
  await new Promise(done => control.listen(socketPath, done)); t.after(() => control.close())
  const child = spawn(process.execPath, ['scripts/mcp.js'], { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, GELIOS_TELEGRAM_CONTROL_SOCKET: socketPath, GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin'), GELIOS_TELEGRAM_STATE_DIR: join(root, 'state') },
    stdio: ['pipe', 'pipe', 'ignore'] })
  t.after(() => child.kill())
  const replies = new Map(); readline.createInterface({ input: child.stdout }).on('line', line => { const value = JSON.parse(line); replies.set(value.id, value) })
  let id = 0
  const call = async (name, args) => {
    const key = ++id; child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: key, method: 'tools/call', params: { name, arguments: args } })}\n`)
    for (let tries = 0; tries < 500 && !replies.has(key); tries += 1) await new Promise(done => setTimeout(done, 10))
    return replies.get(key).result
  }
  return { call, actions }
}
const replied = { ok: true, result: { message_ids: [1], event_id: 'telegram-out-x', timestamp: 't' } }

test('U01: the tool client refuses optional arguments on an old bridge, and basic calls still work there', async t => {
  const old = await helper(t, request => request.action === 'reply' ? replied : request.action === 'runtime_environment' ? { ok: true, result: {} } : { ok: false, error: 'unknown bridge action' })
  const refused = await old.call('telegram_reply', { chat_id: '123', text: 'x', format: 'text' })
  assert.equal(refused.isError, true); assert.match(refused.content[0].text, /does not support format; nothing was sent/)
  assert.match((await old.call('telegram_reply', { chat_id: '123', text: 'x', message_thread_id: '4' })).content[0].text, /does not support topics/)
  assert.equal(old.actions.some(request => request.action === 'reply'), false)
  assert.match((await old.call('telegram_reply', { chat_id: '123', text: 'basic' })).content[0].text, /Telegram sent message IDs: 1/)
  const current = await helper(t, request => request.action === 'capabilities' ? { ok: true, result: { features: ['format', 'topics'] } } : request.action === 'reply' ? replied : { ok: true, result: {} })
  assert.match((await current.call('telegram_reply', { chat_id: '123', text: 'x', format: 'text', message_thread_id: '4' })).content[0].text, /sent message IDs/)
  // A bridge from before question buttons refuses them, on a reply and on an edit, and nothing is sent.
  assert.match((await current.call('telegram_reply', { chat_id: '123', text: 'x', buttons: [['Yes']] })).content[0].text, /does not support buttons; nothing was sent/)
  assert.match((await current.call('telegram_edit_message', { chat_id: '123', message_id: '5', buttons: [] })).content[0].text, /does not support buttons/)
  assert.equal(current.actions.filter(request => ['reply', 'edit_message'].includes(request.action)).length, 1)
  assert.deepEqual(current.actions.filter(request => request.action === 'reply')[0].args, { chat_id: '123', text: 'x', format: 'text', message_thread_id: '4' })
})

// A poll loop over scripted getUpdates batches; later polls wait until the channel stops.
function scriptedPolls(f, batches) {
  const call = f.channel.api.call
  f.channel.api.call = async (method, params, options) => {
    if (method !== 'getUpdates') return call(method, params, options)
    f.calls.push({ method, params })
    const next = batches.shift(); if (next) return next
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
    throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  }
}
const until = async (check, what) => { for (let tries = 0; tries < 300; tries += 1) { if (check()) return; await new Promise(done => setTimeout(done, 10)) } assert.fail(`timed out waiting for ${what}`) }
const voice = id => ({ update_id: id, message: { message_id: id, date: id, chat: { id: 123, type: 'private' }, from: { id: 123 },
  voice: { file_id: `v${id}`, file_unique_id: `v${id}`, file_size: 3, duration: 1, mime_type: 'audio/ogg' } } })

test('A03: polling journals a voice note, then answers a picker press while that audio job still runs', async t => {
  let release; let transcribing = false
  const f = fixture(t, { transcriber: { transcribe: () => { transcribing = true; return new Promise(done => { release = done }) } } })
  f.channel.api.download = async () => ({ bytes: Buffer.from('ogg'), file: { file_path: 'voice/a.ogg' } })
  const picker = f.store.createCallbackGroup({ chatId: '123', userId: '123', threadId: 't', action: 'selectEffort', model: 'm' }, [{ value: 'low', label: 'low' }], '55')
  f.channel.onControl = () => new Promise(() => {})
  scriptedPolls(f, [[voice(1), { update_id: 2, callback_query: { id: 'q1', data: picker.capabilities[0].callbackData, from: { id: 123 },
    message: { message_id: 55, date: 5, chat: { id: 123, type: 'private' } } } }]])
  void f.channel.start({ lockHeld: true })
  await until(() => f.calls.some(call => call.method === 'answerCallbackQuery'), 'the press answer')
  await until(() => f.store.loadRuntime().updateOffset === 3, 'the offset')
  assert.equal(transcribing, true); assert.equal(f.events.length, 0)
  assert.equal(f.store.loadRuntime().events['telegram-123-1'].status, 'received')
  release({ text: 'spoken words' })
  await until(() => f.events.length === 1, 'the voice delivery')
  assert.match(f.events[0].text, /spoken words/)
})

test('A03: polling journals a voice note, then answers a question press and commits its answer while that audio job still runs', async t => {
  let release; let transcribing = false
  const f = fixture(t, { transcriber: { transcribe: () => { transcribing = true; return new Promise(done => { release = done }) } } })
  f.channel.api.download = async () => ({ bytes: Buffer.from('ogg'), file: { file_path: 'voice/a.ogg' } })
  f.channel.polling = true
  const sent = await f.channel.sendReply({ chat_id: '123', text: 'Pick', format: 'text', buttons: [['Yes']] })
  const markup = f.calls.at(-1).params.reply_markup
  scriptedPolls(f, [[voice(1), { update_id: 2, callback_query: { id: 'q1', data: markup.inline_keyboard[0][0].callback_data, from: { id: 123 },
    message: { message_id: sent.message_ids[0], date: 5, chat: { id: 123, type: 'private' }, from: { id: 4321, is_bot: true }, text: 'Pick', reply_markup: markup } } }]])
  void f.channel.start({ lockHeld: true })
  await until(() => f.calls.some(call => call.method === 'answerCallbackQuery'), 'the press answer')
  await until(() => f.store.loadRuntime().updateOffset === 3, 'the offset')
  assert.equal(transcribing, true)
  assert.equal(Object.values(f.store.loadRuntime().questions.records)[0].status, 'taken')
  // The voice note entered the journal before the answer, so the bridge's ordered queue delivers it first.
  const journal = f.store.loadRuntime().events, answerId = Object.keys(journal).find(id => id.startsWith('telegram-answer-'))
  assert.ok(journal['telegram-123-1'].sequence < journal[answerId].sequence)
  release({ text: 'spoken words' })
  // The bridge's ordered queue, not this fixture, keeps the two in journal order.
  await until(() => f.events.length === 2, 'both deliveries')
  assert.deepEqual(f.events.map(event => event.button).sort(), ['Yes', undefined])
  assert.match(f.events.find(event => !event.button).text, /spoken words/)
})

test('backpressure pauses polling without dropping input, and a bridge boundary leaves updates with Telegram', async t => {
  const f = fixture(t); const releases = []
  f.channel.onInbound = () => new Promise(done => releases.push(done))
  f.channel.maxPendingWork = 1
  const doc = id => ({ update_id: id, message: { message_id: id, date: id, chat: { id: 123, type: 'private' }, from: { id: 123 }, text: `note ${id}` } })
  scriptedPolls(f, [[doc(1), doc(2)]])
  void f.channel.start({ lockHeld: true })
  await until(() => f.logs.some(line => /polling pauses until one finishes/.test(line)), 'the pause')
  assert.equal(f.store.loadRuntime().updateOffset, 2)
  releases[0]()
  await until(() => f.store.loadRuntime().updateOffset === 3, 'the second update')
  assert.deepEqual(Object.keys(f.store.loadRuntime().events).filter(id => id.startsWith('telegram-123-')).sort(), ['telegram-123-1', 'telegram-123-2'])
  const g = fixture(t)
  g.channel.atBoundary = () => true
  scriptedPolls(g, [[doc(7)]])
  void g.channel.start({ lockHeld: true })
  await until(() => g.logs.some(line => /update 7 paused at a bridge boundary/.test(line)), 'the boundary')
  assert.equal(g.store.loadRuntime().updateOffset, 0)
  assert.equal(g.store.loadRuntime().events['telegram-123-7'], undefined)
})
