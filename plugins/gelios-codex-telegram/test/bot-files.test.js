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
import { TelegramApi, TelegramChannel } from '../src/telegram.js'
import { GeliosBridge as Bridge } from '../scripts/bridge.js'
import { nativeBridge } from './support/native-bot-bridge.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
function fixture(t, { bot = true, group = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bot-files-')), workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const store = new StateStore(join(root, 'state')), events = [], calls = []
  store.saveAccess({ version: 1, dmPolicy: 'allowlist', pending: {}, users: {
    '2': { chatId: '2', alias: 'Peer', role: 'admin' } },
    groups: group ? { '-3': { chatId: '-3', requireMention: false } } : {} })
  const channel = new TelegramChannel({ store, workspaceRoot: workspace, token: '1:fixture',
    onInbound: async (event, prepare) => events.push(await prepare()), onControl: async () => null, log: () => {} })
  channel.learnPeer({ id: 2, is_bot: bot })
  let nextId = 10
  channel.api.call = async (method, fields) => { calls.push({ method, fields }); return { message_id: nextId++ } }
  channel.api.multipart = async (method, fields, fieldName, file, options) => {
    options?.beforeSend?.(); calls.push({ method, fields, files: [{ fieldName, file }] }); return { message_id: nextId++ }
  }
  channel.api.multipartFiles = async (method, fields, files, options) => {
    options?.beforeSend?.(); calls.push({ method, fields, files }); return files.map(() => ({ message_id: nextId++ }))
  }
  const files = ['one.txt', 'two.png', 'three.csv'].map(name => { const file = join(workspace, name); writeFileSync(file, name); return file })
  t.after(() => channel.stop())
  return { store, channel, files, events, calls, workspace }
}
const message = (id, extra, bot = true) => ({ update_id: id, message: {
  message_id: id, date: id, chat: { id: 2, type: 'private' }, from: { id: 2, is_bot: bot }, ...extra } })

test('bot-file captions use the trimmed 1024 boundary, retaining other whitespace', () => {
  assert.deepEqual(botFileText(' \n '), { pieces: [] })
  assert.deepEqual(botFileText(' \n' + 'x'.repeat(1024) + '\n '), { caption: 'x'.repeat(1024), pieces: [] })
  assert.deepEqual(botFileText('x'.repeat(1025)), { pieces: ['x'.repeat(1025)] })
  assert.deepEqual(botFileText(' \t\r '), { caption: '\t\r', pieces: [] })
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
  await batcher.add(event(18, { userId: '3', threadId: '7' }))
  await batcher.add(event(19, { userId: '3', threadId: '7', rawMessage: { ...event(19).rawMessage, reply_to_message: { message_id: 1 } } }))
  await batcher.flush()
  assert.deepEqual(published.slice(3).map(events => events.map(event => event.eventId)), [['event-16'], ['event-17'], ['event-18'], ['event-19']])
  batcher.stop()
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

async function exchange(t, native = false) {
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
    if (method === 'sendMediaGroup') {
      started(); await wait(9000)
      const result = []
      for (const media of JSON.parse(fields.get('media'))) {
        const file = fields.get(media.media.slice('attach://'.length)), id = nextId++
        uploads.push({ id, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) })
        await receiver.telegram.handleUpdate({ update_id: id, message: { message_id: id, date: id,
          chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: true },
          document: { file_id: `file-${id}`, file_name: file.name }, ...(media.caption ? { caption: media.caption } : {}) } })
        result.push({ message_id: id })
      }
      return result
    }
    assert.equal(method, 'sendMessage')
    const id = nextId++
    await receiver.telegram.handleUpdate({ update_id: id, message: { message_id: id, date: id,
      chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: true }, text: fields.get('text') } })
    return { message_id: id }
  })
  sender.telegram.api.base = base; receiver.telegram.api.base = base
  receiver.telegram.api.download = async fileId => {
    const file = uploads.find(file => `file-${file.id}` === fileId)
    return { bytes: file.bytes, file: { file_path: file.name } }
  }
  const files = ['first.txt', 'second.png', 'third.csv'].map(name => { const file = join(sender.options.workspace, name); writeFileSync(file, `contents:${name}`); return file })
  const text = '/results/' + 'x'.repeat(8200)
  const pending = sender.telegram.reply({ chat_id: '2', text, files })
  void pending.catch(() => {}) // Failed assertions may close the fixture during an upload.
  await uploadStarted; await wait(3100)
  assert.equal(inputs.length, 0, 'no receiving turn begins while the album uploads')
  const receipt = await pending
  await receiver.telegram.batcher.flush(); await receiver.ingress
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].method, 'turn/start')
  const input = inputs[0].params.input.filter(item => item.type === 'text').map(item => item.text).join('\n')
  assert.ok(input.includes(text))
  assert.equal((input.match(/attachment_file_id=/g) || []).length, 3)
  const handles = [...input.matchAll(/attachment_file_id=([^;\n]+)/g)].map(match => match[1])
  assert.equal(new Set(handles).size, 3)
  for (const [i, name] of ['first.txt', 'second.png', 'third.csv'].entries()) {
    assert.ok(input.includes(`name=${name}`))
    assert.equal(uploads[i].bytes.toString(), `contents:${name}`)
  }
  assert.ok(input.indexOf('name=first.txt') < input.indexOf('name=second.png') && input.indexOf('name=second.png') < input.indexOf('name=third.csv'))
  assert.equal(methods[0], 'sendMediaGroup')
  assert.equal(receipt.message_ids.length, 6)
  if (native) {
    const deadline = Date.now() + 10_000
    while (receiver.activeTurnId) { assert.ok(Date.now() < deadline, 'native turn completed'); await wait(20) }
    const thread = (await receiver.rpc('thread/read', { threadId: receiver.currentThreadId, includeTurns: true })).thread
    const userItems = thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'userMessage')
    assert.equal(userItems.length, 1)
    const recorded = JSON.stringify(userItems[0])
    assert.ok(recorded.includes(text))
    for (const name of ['first.txt', 'second.png', 'third.csv']) assert.ok(recorded.includes(`name=${name}`))
  }
}
test('two bridge fixtures deliver three files and all text together after a nine-second upload', { timeout: 25_000 }, t => exchange(t))
test('two real native hosts receive one complete bot-file input after a nine-second upload', {
  skip: !process.env.GELIOS_REAL_CODEX_BIN && 'set GELIOS_REAL_CODEX_BIN for real native hosts', timeout: 45_000,
}, t => exchange(t, true))
