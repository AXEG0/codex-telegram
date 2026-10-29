import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { StateStore, chunkText } from '../src/core.js'
import { BOT_OPENER, TelegramChannel, TelegramError } from '../src/telegram.js'
import { GeliosBridge } from '../scripts/bridge.js'
import { preflightState, validateNextBuild } from '../scripts/update.js'
import { candidateAt } from './support/candidate.js'

const GROUP = '-1001234567890'
const TOKEN = `4321:${'g'.repeat(32)}`
const OWNER = { '123': { chatId: '123', alias: 'Owner', role: 'admin' } }

function fixture(t, { groups = {}, users = OWNER, stateDir } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-guards-')), workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const store = new StateStore(stateDir || join(root, 'state')), events = [], calls = [], held = []
  store.saveAccess({ version: 2, dmPolicy: 'allowlist', pending: {}, groups, mentionPatterns: [], users })
  const channel = new TelegramChannel({ store, workspaceRoot: workspace, token: TOKEN,
    onInbound: async (event, prepare) => { held.push(prepare); events.push(event) }, log: () => {} })
  channel.botUsername = 'cxbot'
  channel.batcher.gap = () => 0
  channel.api.call = async (method, params) => { calls.push({ method, params }); return { message_id: 900 + calls.length, chat: { id: Number(params.chat_id) } } }
  t.after(() => channel.stop())
  return { root, store, events, calls, held, channel }
}
const groupMessage = (id, text, extra = {}) => ({ update_id: id, message: { message_id: id, date: id,
  chat: { id: Number(GROUP), type: 'supergroup' }, from: { id: 700, first_name: 'Member' }, text, ...extra } })

test('a group that requires a mention drops a message without one, and takes the same message with one', async t => {
  const f = fixture(t, { groups: { [GROUP]: { requireMention: true } } })
  await f.channel.handleUpdate(groupMessage(10, 'hello'))
  await f.channel.handleUpdate(groupMessage(11, 'hello', { reply_to_message: { message_id: 3, from: { id: 9999, is_bot: true } } }))
  assert.equal(f.events.length, 0)
  await f.channel.handleUpdate(groupMessage(12, '@cxbot hello', { entities: [{ type: 'mention', offset: 0, length: 6 }] }))
  assert.equal(f.events.length, 1)
})

test('commands in a group are neither run, answered nor passed on, even where no mention is needed', async t => {
  const f = fixture(t, { groups: { [GROUP]: { requireMention: false } } })
  for (const [id, text] of [[20, '/status'], [21, '/model@cxbot'], [22, '/start'], [23, '/help please']]) await f.channel.handleUpdate(groupMessage(id, text))
  assert.equal(f.events.length, 0)
  assert.equal(f.calls.length, 0)
  await f.channel.handleUpdate(groupMessage(24, 'plain words'))
  assert.equal(f.events.length, 1)
})

test('queued group input stops for good when its sender leaves the group\'s member list before preparation', async t => {
  const f = fixture(t, { groups: { [GROUP]: { requireMention: false, allowFrom: ['700', '701'] } } })
  await f.channel.handleUpdate(groupMessage(30, 'from a member'))
  assert.equal(f.held.length, 1)
  const access = f.store.loadAccess(); access.groups[GROUP].allowFrom = ['701']; f.store.saveAccess(access)
  await assert.rejects(f.held[0](), error => error.permanent === true && /Telegram sender authorization changed/.test(error.message))
  // A member still listed is prepared as before.
  await f.channel.handleUpdate(groupMessage(31, 'still here', { from: { id: 701, first_name: 'Kept' } }))
  assert.equal((await f.held[1]()).text, 'still here')
})

test('static access mode is switched on by the bridge\'s own startup, before the channel exists', async t => {
  const start = async accessMode => {
    const root = mkdtempSync(join(tmpdir(), 'codex-tg-static-start-')), stateDir = join(root, 'state')
    const store = new StateStore(stateDir)
    store.saveAccess({ version: 2, dmPolicy: 'allowlist', pending: {}, groups: {}, mentionPatterns: [], users: OWNER })
    writeFileSync(store.configPath, JSON.stringify(accessMode ? { accessMode } : {}))
    const bridge = new GeliosBridge({ stateDir, workspace: root, socket: join(root, 'app.sock'), controlSocket: join(root, 'control.sock') })
    bridge.log = () => {}; bridge.shutdown = async () => {}
    bridge.setupChannel = () => { throw new Error('stopped after the access mode') }
    await assert.rejects(bridge.start(), accessMode === 'sometimes' ? /accessMode must be dynamic or static/ : /stopped after the access mode/)
    return bridge
  }
  const frozen = await start('static')
  assert.throws(() => frozen.store.saveAccess(frozen.store.loadAccess()), /static access mode/)
  const dynamic = await start('dynamic')
  dynamic.store.saveAccess(dynamic.store.loadAccess())
  await start('sometimes')
})

test('candidate validation runs the state preflight in the candidate itself, and refuses state it cannot read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-candidate-preflight-')), stateDir = join(root, 'state')
  mkdirSync(stateDir, { mode: 0o700 })
  const candidate = candidateAt(fileURLToPath(new URL('../', import.meta.url)), join(root, 'candidate'), '0.5.0')
  const options = { stateDir, env: { PATH: process.env.PATH, HOME: process.env.HOME } }
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ version: 7, dmPolicy: 'allowlist', users: {}, pending: {} }))
  await assert.rejects(validateNextBuild(candidate, 'telegram', 'codex-telegram', options), /candidate cannot read the current state: access state version 7 is newer/)
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ version: 2, dmPolicy: 'allowlist', users: {}, pending: {}, groups: {}, mentionPatterns: [] }))
  assert.equal((await validateNextBuild(candidate, 'telegram', 'codex-telegram', options)).version, candidate.version)
})

test('first contact sends nothing when Telegram says the pinned chat is not a bot', async t => {
  const f = fixture(t, { users: { '7012': { chatId: '7012', alias: 'peer', role: 'contributor', botUsername: 'xybot', botPinnedAt: 'one' } } })
  f.channel.api.call = async (method, params) => {
    f.calls.push({ method, params })
    if (method === 'getChat') return { id: 7012 }
    if (method === 'getChatMember') return { user: { id: 7012, is_bot: false } }
    return { message_id: 1, chat: { id: 7012 } }
  }
  await assert.rejects(f.channel.sendReply({ chat_id: '7012', text: 'payload' }), /chat 7012 is not a bot; nothing was sent/)
  assert.equal(f.calls.some(call => call.method === 'sendMessage'), false)
  assert.equal(f.store.loadRuntime().botRoutes?.['7012:xybot:one'], undefined)
})

test('a fixed opener whose answer was a 5xx counts as possibly sent and never goes twice; a 4xx refusal does not count', async t => {
  const f = fixture(t, { users: { '7012': { chatId: '7012', alias: 'peer', role: 'contributor', botUsername: 'xybot', botPinnedAt: 'one' } } })
  let failure = new TelegramError('Bad Gateway', 502)
  f.channel.api.call = async (method, params) => {
    f.calls.push({ method, params })
    if (method === 'getChat') return { id: 7012 }
    if (method === 'getChatMember') return { user: { id: 7012, is_bot: true } }
    throw failure
  }
  const openers = () => f.calls.filter(call => call.method === 'sendMessage' && call.params.text === BOT_OPENER).length
  await assert.rejects(f.channel.sendReply({ chat_id: '7012', text: 'payload' }), /Bad Gateway/)
  await assert.rejects(f.channel.sendReply({ chat_id: '7012', text: 'payload' }), /has not answered the opener/)
  assert.equal(openers(), 1)
  const access = f.store.loadAccess(); access.users['7012'].botPinnedAt = 'two'; f.store.saveAccess(access)
  failure = new TelegramError('Too Many Requests: retry after 1', 429)
  await assert.rejects(f.channel.sendReply({ chat_id: '7012', text: 'payload' }), /Too Many Requests/)
  await assert.rejects(f.channel.sendReply({ chat_id: '7012', text: 'payload' }), /Too Many Requests/)
  assert.equal(openers(), 3)
})

test('length chunks never include a part that is only whitespace', () => {
  assert.deepEqual(chunkText(`a${' '.repeat(10)}b`, 5, 'length'), [`a${' '.repeat(4)}`, ' b'])
  assert.deepEqual(chunkText(`x${' '.repeat(12)}`, 4, 'length'), ['x   '])
  for (const mode of ['length', 'newline']) assert.equal(chunkText(`one${' '.repeat(30)}\n\n${' '.repeat(30)}two`, 8, mode).some(part => !/\S/.test(part)), false)
  assert.deepEqual(chunkText('   ', 2, 'length'), ['  '])
})

test('the state preflight copies into the owner-only state directory, and clears copies a killed preflight left', t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-preflight-place-')), stateDir = join(root, 'state')
  mkdirSync(stateDir, { mode: 0o700 })
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ version: 2, dmPolicy: 'allowlist', users: {}, pending: {}, groups: {}, mentionPatterns: [] }))
  const stale = join(stateDir, '.preflight-killed'), recent = join(stateDir, '.preflight-running')
  for (const dir of [stale, recent]) { mkdirSync(dir); writeFileSync(join(dir, 'access.json'), '{}') }
  const old = new Date(Date.now() - 60 * 60 * 1000); utimesSync(stale, old, old)
  // The temp folder refuses writes, so a copy placed there fails the preflight; one in the state directory does not.
  const temp = mkdtempSync(join(tmpdir(), 'codex-tg-preflight-tmpdir-')), previous = process.env.TMPDIR
  chmodSync(temp, 0o500); t.after(() => chmodSync(temp, 0o700))
  let writable = true
  try { mkdtempSync(join(temp, 'probe-')) } catch { writable = false }
  if (writable) t.diagnostic('this account writes into a read-only folder (root), so the temp folder cannot refuse the copy here')
  process.env.TMPDIR = temp
  try { preflightState(stateDir) } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous }
  assert.equal(writable || readdirSync(temp).length === 0, true)
  assert.equal(existsSync(stale), false)
  assert.equal(existsSync(recent), true)
  if (!writable) assert.deepEqual(readdirSync(temp), [])
  assert.deepEqual(readdirSync(stateDir).filter(name => name.startsWith('.preflight-')), ['.preflight-running'])
})

test('a failed turn from a forum topic is reported in that topic, as a reply to the topic\'s message', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-topic-report-'))
  const bridge = new GeliosBridge({ stateDir: join(root, 'state'), workspace: root, socket: join(root, 'app.sock'), controlSocket: join(root, 'control.sock') })
  bridge.log = () => {}; bridge.appReady = true; bridge.bindThread('thread-1'); bridge.turnRetryWaits = []
  bridge.rpc = async method => {
    if (method === 'thread/loaded/list') return { data: ['thread-1'], nextCursor: null }
    if (method === 'turn/start') return { turn: { id: 'turn-g', status: 'inProgress' } }
    if (method === 'turn/steer') return { turnId: 'turn-g' }
    throw new Error(`unexpected ${method}`)
  }
  const replies = []
  bridge.telegram = { stopTyping() {}, startTyping() {}, reply: async request => { replies.push(request) } }
  const event = (id, threadId) => ({ eventId: `telegram-${GROUP}-${id}`, chatId: GROUP, messageId: String(id), userId: '700', source: 'Telegram',
    name: 'Member', role: 'contributor', timestamp: id, text: `message ${id}`, prepared: true, chatType: 'supergroup', ...(threadId ? { threadId } : {}) })
  await bridge.acceptTelegram(event(40, '9'), async () => event(40, '9'))
  bridge.activeTurnId = 'turn-g'
  await bridge.acceptTelegram(event(41), async () => event(41))
  bridge.observeAppMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-g', status: 'failed', error: { message: 'Refused.' } } } })
  for (let tries = 0; replies.length < 2 && tries < 100; tries += 1) await new Promise(done => setTimeout(done, 5))
  assert.deepEqual(replies.map(request => [request.chat_id, request.message_thread_id, request.reply_to]), [[GROUP, '9', '40'], [GROUP, undefined, '41']])
  // The channel's own journal keeps the topic too, so a turn fed through polling reports there as well.
  const f = fixture(t, { groups: { [GROUP]: { requireMention: false } } })
  await f.channel.handleUpdate(groupMessage(50, 'in a topic', { is_topic_message: true, message_thread_id: 9 }))
  assert.equal(f.store.loadRuntime().events[`telegram-${GROUP}-50`].topicId, '9')
})

test('a retry of a failed turn from a forum topic shows typing in that topic', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-topic-retry-'))
  const bridge = new GeliosBridge({ stateDir: join(root, 'state'), workspace: root, socket: join(root, 'app.sock'), controlSocket: join(root, 'control.sock') })
  bridge.log = () => {}; bridge.appReady = true; bridge.bindThread('thread-1'); bridge.turnRetryWaits = [1]
  t.after(() => { clearTimeout(bridge.turnRetryTimer); clearTimeout(bridge.retryTimer) })
  let turns = 0
  bridge.rpc = async method => {
    if (method === 'thread/loaded/list') return { data: ['thread-1'], nextCursor: null }
    if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress' } }
    throw new Error(`unexpected ${method}`)
  }
  const typing = []
  bridge.telegram = { stopTyping() {}, startTyping: (chatId, topicId) => { typing.push([chatId, topicId]) }, reply: async () => {} }
  const event = { eventId: `telegram-${GROUP}-60`, chatId: GROUP, messageId: '60', userId: '700', source: 'Telegram', name: 'Member',
    role: 'contributor', timestamp: 60, text: 'in a topic', prepared: true, chatType: 'supergroup', threadId: '9' }
  await bridge.acceptTelegram(event, async () => event)
  bridge.activeTurnId = 'turn-1'
  bridge.observeAppMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed',
    error: { message: 'Selected model is at capacity.', codexErrorInfo: 'serverOverloaded' } } } })
  for (let tries = 0; turns < 2 && tries < 200; tries += 1) { await new Promise(done => setTimeout(done, 5)); await bridge.ingress }
  assert.equal(turns, 2)
  assert.deepEqual(typing, [[GROUP, '9']])
})
