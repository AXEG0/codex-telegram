import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { StateStore } from '../src/core.js'
import { TelegramChannel } from '../src/telegram.js'
import { admitGroupMessage, destination, isMentioned, normalizeAccess, senderAdmitted } from '../src/policy.js'
import { accessAction, changeAccess, localSetupInput, setupFingerprint } from '../src/local-setup.js'
import { GeliosBridge } from '../scripts/bridge.js'

const GROUP = '-1001234567890'
const BOT_TOKEN = `4321:${'b'.repeat(32)}`
function fixture(t, { groups = { [GROUP]: { requireMention: true, allowFrom: [] } }, patterns = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-groups-')), workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const store = new StateStore(join(root, 'state')), events = [], calls = []
  store.saveAccess({ version: 2, dmPolicy: 'allowlist', pending: {}, groups, mentionPatterns: patterns,
    users: { '123': { chatId: '123', alias: 'Owner', role: 'admin' } } })
  const channel = new TelegramChannel({ store, workspaceRoot: workspace, token: BOT_TOKEN,
    onInbound: async (event, prepare) => events.push(await prepare()), log: () => {} })
  channel.botUsername = 'cxbot'
  channel.batcher.gap = () => 0
  channel.api.call = async (method, params) => { calls.push({ method, params }); return { message_id: 900 + calls.length, chat: { id: Number(params.chat_id) } } }
  t.after(() => channel.stop())
  return { store, events, calls, channel, root }
}
const groupMessage = (id, text, extra = {}) => ({ update_id: id, message: { message_id: id, date: id,
  chat: { id: Number(GROUP), type: 'supergroup' }, from: { id: 700, first_name: 'Member' }, text, ...extra } })
const mention = text => ({ entities: [{ type: 'mention', offset: 0, length: '@cxbot'.length }], text: `@cxbot ${text}` })

test('G01: an admitted group member contributes input but gets no private controls', async t => {
  const f = fixture(t)
  await f.channel.handleUpdate(groupMessage(10, 'hello', mention('hello')))
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0].chatId, GROUP)
  assert.equal(f.events[0].userId, '700')
  assert.equal(f.events[0].role, 'contributor')
  assert.equal(f.events[0].chatType, 'supergroup')
  // Commands are private-chat controls: in a group none runs, answers or becomes input.
  await f.channel.handleUpdate(groupMessage(11, '/model', { text: '/model@cxbot' }))
  await f.channel.handleUpdate(groupMessage(12, '/status'))
  assert.equal(f.events.length, 1)
  assert.equal(f.calls.some(call => call.method === 'sendMessage'), false)
  const bridge = new GeliosBridge({ stateDir: f.store.dir, workspace: f.channel.workspaceRoot })
  assert.throws(() => bridge.assertTelegramAdmin({ chatId: GROUP, userId: '700' }), /not a paired private chat/)
})

test('G02: unlisted members, anonymous admins, channel identities and unknown groups drop without any write', async t => {
  const f = fixture(t, { groups: { [GROUP]: { requireMention: false, allowFrom: ['701'] } } })
  const before = readFileSync(f.store.accessPath, 'utf8')
  await f.channel.handleUpdate(groupMessage(20, 'not listed'))
  await f.channel.handleUpdate(groupMessage(21, 'anonymous admin', { from: { id: 9876, is_bot: true, first_name: 'Group' }, sender_chat: { id: Number(GROUP), type: 'supergroup' } }))
  await f.channel.handleUpdate(groupMessage(22, 'as a channel', { from: { id: 701 }, sender_chat: { id: -100999, type: 'channel' } }))
  await f.channel.handleUpdate(groupMessage(23, 'no sender', { from: undefined }))
  await f.channel.handleUpdate(groupMessage(27, 'a listed bot', { from: { id: 701, is_bot: true } }))
  await f.channel.handleUpdate(groupMessage(28, 'service account', { from: { id: 777000 } }))
  await f.channel.handleUpdate({ update_id: 24, message: { message_id: 24, date: 24, chat: { id: -100555, type: 'supergroup' }, from: { id: 701 }, text: 'other group' } })
  await f.channel.handleUpdate({ update_id: 25, message: { message_id: 25, date: 25, chat: { id: -100555, type: 'channel' }, text: 'channel post' } })
  assert.equal(f.events.length, 0)
  assert.equal(readFileSync(f.store.accessPath, 'utf8'), before)
  assert.equal(f.calls.length, 0)
  await f.channel.handleUpdate(groupMessage(26, 'listed', { from: { id: 701, first_name: 'Listed' } }))
  assert.equal(f.events.length, 1)
})

test('mention rules: entity, text mention, reply to the bot and owner patterns count; a topic opener does not', () => {
  const bot = { botId: '4321', botUsername: 'cxbot', patterns: ['^hey\\s+codex\\b'] }
  assert.equal(isMentioned({ text: 'hi @CxBot', entities: [{ type: 'mention', offset: 3, length: 6 }] }, bot), true)
  assert.equal(isMentioned({ text: 'hi @qqbot', entities: [{ type: 'mention', offset: 3, length: 6 }] }, bot), false)
  assert.equal(isMentioned({ text: 'hi', entities: [{ type: 'text_mention', offset: 0, length: 2, user: { id: 4321 } }] }, bot), true)
  assert.equal(isMentioned({ text: 'yes', reply_to_message: { from: { id: 4321 } } }, bot), true)
  assert.equal(isMentioned({ text: 'yes', reply_to_message: { from: { id: 4321 }, forum_topic_created: {} } }, bot), false)
  assert.equal(isMentioned({ text: 'Hey  Codex, look' }, bot), true)
  assert.equal(isMentioned({ text: 'look', }, { ...bot, patterns: ['[invalid'] }), false)
})

test('G03: topics, reply targets and mixed senders keep their own route and batches', async t => {
  const f = fixture(t, { groups: { [GROUP]: { requireMention: false } } })
  f.channel.batcher.gap = event => event.edited ? 0 : 300
  const topic = { is_topic_message: true, message_thread_id: 44 }
  await f.channel.handleUpdate(groupMessage(30, 'one', { ...topic, from: { id: 700, first_name: 'A' } }))
  await f.channel.handleUpdate(groupMessage(31, 'two', { ...topic, from: { id: 701, first_name: 'B' } }))
  await f.channel.handleUpdate(groupMessage(32, 'three', { from: { id: 701, first_name: 'B' } }))
  await f.channel.batcher.flush()
  assert.deepEqual(f.events.map(event => [event.userId, event.threadId || null, event.text]), [['700', '44', 'one'], ['701', '44', 'two'], ['701', null, 'three']])
  const bridge = new GeliosBridge({ stateDir: f.store.dir, workspace: f.channel.workspaceRoot })
  const input = bridge.telegramInput({ ...f.events[0], sequence: 1 })
  assert.match(input[0].text, new RegExp(`chat_id=${GROUP}; message_id=30; user_id=700; role=contributor; chat_type=group; message_thread_id=44`))
  // The reply stays in the topic, and a deleted target fails rather than moving the reply.
  f.calls.length = 0
  await f.channel.sendReply({ chat_id: GROUP, text: 'answer', reply_to: '30', message_thread_id: '44', format: 'text' })
  const sent = f.calls.find(call => call.method === 'sendMessage')
  assert.equal(sent.params.message_thread_id, 44)
  assert.deepEqual(sent.params.reply_parameters, { message_id: 30 })
  f.calls.length = 0
  f.channel.api.call = async (method, params) => { f.calls.push({ method, params }); return { message_id: 1, chat: { id: Number(GROUP) } } }
  const { richPartsAsync } = await import('../src/rich.js')
  await richPartsAsync('warm up', undefined, { log: () => {} })
  await f.channel.sendReply({ chat_id: GROUP, text: '**rich**', reply_to: '30', message_thread_id: '44' })
  const rich = f.calls.find(call => call.method === 'sendRichMessage')
  assert.deepEqual(rich.params.reply_parameters, { message_id: 30 })
  assert.equal(rich.params.message_thread_id, 44)
})

test('a group that Telegram migrated fails the reply with the new ID and changes no policy', async t => {
  const f = fixture(t)
  const before = readFileSync(f.store.accessPath, 'utf8')
  f.channel.api.call = async method => {
    if (method === 'sendMessage') {
      const { TelegramError } = await import('../src/telegram.js')
      throw Object.assign(new TelegramError('Bad Request: group chat was upgraded to a supergroup chat', 400), { migrateTo: '-100777' })
    }
    return {}
  }
  await assert.rejects(f.channel.sendReply({ chat_id: GROUP, text: 'x', format: 'text' }), /moved this group to chat -100777, which only the owner can add locally/)
  assert.equal(readFileSync(f.store.accessPath, 'utf8'), before)
})

test('G04: dynamic revocation between chunks stops the reply; static mode changes only at restart', async t => {
  const f = fixture(t, { groups: { [GROUP]: { requireMention: false } } })
  writeFileSync(f.store.configPath, JSON.stringify({ textChunkLimit: 5, chunkMode: 'length' }))
  let sends = 0
  f.channel.api.call = async (method, params) => {
    if (method !== 'sendMessage') return {}
    sends += 1
    if (sends === 1) { const access = f.store.loadAccess(); delete access.groups[GROUP]; f.store.saveAccess(access) }
    return { message_id: sends, chat: { id: Number(params.chat_id) } }
  }
  await assert.rejects(f.channel.sendReply({ chat_id: GROUP, text: 'aaaaabbbbbccccc', format: 'text' }), /after 1 Telegram messages: Telegram destination is not paired/)
  assert.equal(sends, 1)
  // Static: the snapshot keeps the group until restart, and pairing never writes.
  const g = fixture(t, { groups: { [GROUP]: { requireMention: false } } })
  const access = g.store.loadAccess(); access.dmPolicy = 'pairing'; g.store.saveAccess(access)
  g.store.freezeAccess()
  const disk = new StateStore(g.store.dir); const removed = disk.loadAccess(); delete removed.groups[GROUP]; disk.saveAccess(removed)
  assert.equal(g.store.destination(GROUP).kind, 'group')
  assert.equal(g.store.loadAccess().dmPolicy, 'allowlist')
  assert.deepEqual(g.store.gatePrivateMessage({ id: 999 }, { id: 999, type: 'private' }), { action: 'drop' })
  assert.throws(() => g.store.saveAccess(g.store.loadAccess()), /static access mode/)
  assert.throws(() => new StateStore(g.store.dir).destination(GROUP), /not paired/)
})

test('disabled policy blocks group input, outgoing calls and attachment recovery', async t => {
  const f = fixture(t, { groups: { [GROUP]: { requireMention: false } } })
  const access = f.store.loadAccess(); access.dmPolicy = 'disabled'; f.store.saveAccess(access)
  await f.channel.handleUpdate(groupMessage(40, 'blocked'))
  assert.equal(f.events.length, 0)
  await assert.rejects(f.channel.sendReply({ chat_id: GROUP, text: 'x' }), /disabled/)
  assert.equal(admitGroupMessage(f.store.loadAccess(), groupMessage(41, 'x').message, { mention: false }), null)
  assert.equal(senderAdmitted(f.store.loadAccess(), GROUP, '700'), false)
})

test('access state: version 1 gains the version 2 keys in memory; a newer version or a corrupt file is refused, never reset', t => {
  const v1 = normalizeAccess({ version: 1, dmPolicy: 'pairing', users: { '1': { chatId: '1', alias: 'A', role: 'admin' } }, pending: {} })
  assert.deepEqual([v1.version, v1.groups, v1.mentionPatterns, v1.users['1'].alias], [2, {}, [], 'A'])
  assert.throws(() => normalizeAccess({ version: 3, dmPolicy: 'pairing' }), /version 3 is newer than this build reads \(2\)/)
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-versions-'))
  const store = new StateStore(root)
  writeFileSync(store.accessPath, JSON.stringify({ version: 3, dmPolicy: 'pairing', users: { '1': {} } }))
  assert.throws(() => store.loadAccess(), /newer than this build reads/)
  assert.match(readFileSync(store.accessPath, 'utf8'), /"version":3/)
  writeFileSync(store.runtimePath, JSON.stringify({ version: 9, events: { kept: {} } }))
  assert.throws(() => store.loadRuntime(), /runtime journal version 9 is newer/)
  assert.match(readFileSync(store.runtimePath, 'utf8'), /kept/)
  assert.throws(() => destination(v1, '@somebody'), /numeric chat ID/)
})

test('the local controller parses group, bot and set commands exactly, and Telegram text cannot reach it', () => {
  const action = localSetupInput([{ type: 'text', text: `$telegram:access group add ${GROUP} --no-mention --allow 1,2` }])
  assert.deepEqual(action, { kind: 'access', command: 'group', first: 'add', second: GROUP, rest: '--no-mention --allow 1,2' })
  // The skill's command line yields the same action, so the controller's fingerprint matches.
  assert.equal(setupFingerprint(accessAction(['group', 'add', GROUP, '--no-mention', '--allow', '1,2'])), setupFingerprint(action))
  const set = localSetupInput([{ type: 'text', text: '$telegram:access set mentionPatterns ["^hey  codex"]' }])
  assert.deepEqual(set, { kind: 'access', command: 'set', first: 'mentionPatterns', rest: '["^hey  codex"]' })
  assert.deepEqual(localSetupInput([{ type: 'text', text: '$telegram:access bot 7012 @xybot' }]),
    { kind: 'access', command: 'bot', first: '7012', second: '@xybot' })
  assert.equal(localSetupInput([{ type: 'text', text: '$telegram:access group add' }]), null)
  assert.equal(localSetupInput([{ type: 'text', text: '$telegram:access set receiptReaction' }]), null)
  // The original commands keep their fingerprint.
  assert.equal(setupFingerprint({ kind: 'access', command: 'pair', first: 'abcdef' }), setupFingerprint(localSetupInput([{ type: 'text', text: '$telegram:access pair abcdef' }])))
})

test('local access changes write groups, pinned bots, patterns and settings, and refuse bad values', t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-changes-'))
  const store = new StateStore(root)
  changeAccess(store, { command: 'group', first: 'add', second: GROUP, rest: '--allow 5,6' })
  assert.deepEqual(store.loadAccess().groups[GROUP], { requireMention: true, allowFrom: ['5', '6'] })
  assert.throws(() => changeAccess(store, { command: 'group', first: 'add', second: '12345', rest: '' }), /negative numeric chat ID/)
  assert.throws(() => changeAccess(store, { command: 'group', first: 'add', second: GROUP, rest: '--everyone' }), /unknown group flag/)
  changeAccess(store, { command: 'bot', first: '7012', second: '@xybot' })
  const pinned = store.loadAccess().users['7012']
  assert.deepEqual([pinned.chatId, pinned.role, pinned.botUsername], ['7012', 'contributor', 'xybot'])
  assert.throws(() => changeAccess(store, { command: 'bot', first: '7012', second: '@plain_person' }), /ending in bot/)
  changeAccess(store, { command: 'set', first: 'mentionPatterns', rest: '["^hey codex\\\\b"]' })
  assert.deepEqual(store.loadAccess().mentionPatterns, ['^hey codex\\b'])
  assert.throws(() => changeAccess(store, { command: 'set', first: 'mentionPatterns', rest: '["("]' }), /invalid/)
  changeAccess(store, { command: 'set', first: 'receiptReaction', rest: '👀' })
  changeAccess(store, { command: 'set', first: 'textChunkLimit', rest: '2000' })
  changeAccess(store, { command: 'set', first: 'transcriptionLanguages', rest: 'en, ru' })
  assert.throws(() => changeAccess(store, { command: 'set', first: 'transcriptionModel', rest: 'whisper-1' }), /takes one language hint/)
  assert.throws(() => changeAccess(store, { command: 'set', first: 'textChunkLimit', rest: '5000' }), /1 to 4096/)
  assert.throws(() => changeAccess(store, { command: 'set', first: 'receiptReaction', rest: 'x' }), /reaction emoji/)
  assert.deepEqual(store.loadConfig(), { replyToMode: 'first', inboxRetentionHours: 24, receiptReaction: '👀', textChunkLimit: 2000, transcriptionLanguages: ['en', 'ru'] })
  changeAccess(store, { command: 'group', first: 'rm', second: GROUP })
  assert.deepEqual(store.loadAccess().groups, {})
})

test('U02: a candidate reads a private copy of the live state; one that cannot is refused and the live files stay as they were', async () => {
  const { preflightState } = await import('../scripts/update.js')
  const root = mkdtempSync(join(tmpdir(), 'codex-tg-preflight-'))
  const legacy = { version: 1, dmPolicy: 'allowlist', users: { '5': { chatId: '5', alias: 'A', role: 'admin' } }, pending: {} }
  writeFileSync(join(root, 'access.json'), JSON.stringify(legacy))
  writeFileSync(join(root, 'runtime.json'), JSON.stringify({ version: 1, sequence: 3, updateOffset: 9, events: { 'telegram-5-1': { status: 'queued', payload: { text: 'kept' } } } }))
  const before = ['access.json', 'runtime.json'].map(name => readFileSync(join(root, name), 'utf8'))
  preflightState(root)
  assert.deepEqual(['access.json', 'runtime.json'].map(name => readFileSync(join(root, name), 'utf8')), before)
  writeFileSync(join(root, 'access.json'), JSON.stringify({ ...legacy, version: 7 }))
  assert.throws(() => preflightState(root), /candidate cannot read the current state: access state version 7 is newer/)
})
