import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { StateStore } from '../src/core.js'
import { TelegramChannel } from '../src/telegram.js'
import { GeliosBridge } from '../scripts/bridge.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gelios-features-')), workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const store = new StateStore(join(root, 'state')), events = [], calls = []
  store.saveAccess({ version: 1, dmPolicy: 'allowlist', pending: {}, users: {
    '123': { chatId: '123', alias: 'Alex', role: 'admin' }, '456': { chatId: '456', alias: 'Guest', role: 'contributor' } } })
  const create = () => {
    let ingress = Promise.resolve()
    const channel = new TelegramChannel({ store, workspaceRoot: workspace, token: `123456789:${'a'.repeat(32)}`,
      onInbound: (event, prepare) => {
        const task = ingress.then(async () => events.push(await prepare()))
        ingress = task.catch(() => {})
        return task
      }, onControl: async () => null,
      onStatus: () => ({}), log: () => {} })
    channel.api.call = async (method, params) => { calls.push({ method, params }); return { message_id: 77 } }
    return channel
  }
  const channel = create()
  t.after(async () => { await channel.stop(); rmSync(root, { recursive: true, force: true }) })
  return { store, events, calls, channel, create }
}
const update = (id, text, sender = 123, extra = {}) => ({ update_id: id, message: {
  message_id: id, date: id, chat: { id: sender, type: 'private' }, from: { id: sender }, text, ...extra } })
test('one sender burst retains identities and reply context, and changing sender flushes ordering', async t => {
  const f = fixture(t), parent = { message_id: 9, text: 'Original question', from: { id: 123 }, date: 1 }
  await f.channel.handleUpdate(update(10, 'one', 123, { reply_to_message: parent }))
  await f.channel.handleUpdate(update(11, 'two', 123, { reply_to_message: parent }))
  assert.equal(f.events.length, 0)
  await f.channel.handleUpdate(update(12, 'next', 456)); await f.channel.batcher.flush()
  assert.deepEqual(f.events.map(event => event.text), ['one\ntwo', 'next'])
  assert.deepEqual(f.events[0].members.map(event => event.messageId), ['10', '11'])
  assert.equal(f.events[0].replyContext.text, 'Original question')
  assert.equal(f.store.loadRuntime().events['telegram-123-10'].parentEventId, f.events[0].eventId)
})
test('Telegram split paste joins without an inserted newline and a changed reply target splits batches', async t => {
  const f = fixture(t)
  await f.channel.handleUpdate(update(1, 'x'.repeat(4096))); await f.channel.handleUpdate(update(2, 'tail'))
  await f.channel.batcher.flush(); assert.equal(f.events[0].text, 'x'.repeat(4096) + 'tail')
  await f.channel.handleUpdate(update(3, 'reply', 123, { reply_to_message: { message_id: 1, text: 'parent' } }))
  await f.channel.handleUpdate(update(4, 'separate')); await f.channel.batcher.flush()
  assert.equal(f.events.length, 3)
})
test('photo bursts retain every authorized local image and recovery handle', async t => {
  const f = fixture(t)
  f.channel.api.download = async fileId => ({ bytes: Buffer.from('photo'), file: { file_path: `${fileId}.jpg` } })
  for (const id of [1, 2]) await f.channel.handleUpdate(update(id, undefined, 123, {
    caption: `Photo ${id}`, photo: [{ file_id: `file-${id}`, file_unique_id: `unique-${id}`, file_size: 5 }] }))
  await f.channel.batcher.flush()
  const event = f.events[0]
  assert.equal(event.localImages.length, 2); assert.equal(event.attachments.length, 2)
  assert.notEqual(event.attachments[0].handle, event.attachments[1].handle)
  const input = GeliosBridge.prototype.telegramInput.call({}, event)
  assert.deepEqual(input.filter(item => item.type === 'localImage').map(item => item.path), event.localImages)
  assert.ok(input[0].text.includes('message_ids=1,2'))
})
test('edited text is identifiable, deduplicated and never treated as a channel command', async t => {
  const f = fixture(t)
  await f.channel.handleUpdate(update(1, 'original')); await f.channel.batcher.flush()
  const edited = { update_id: 20, edited_message: { ...update(1, '/new changed').message, edit_date: 20 } }
  await f.channel.handleUpdate(edited); await f.channel.handleUpdate(edited)
  assert.equal(f.events.length, 2); assert.equal(f.events[1].edited, true)
  assert.equal(f.events[1].messageId, '1'); assert.match(f.events[1].eventId, /^telegram-edit-/)
  assert.equal(f.events[1].text, '/new changed')
  await f.channel.handleUpdate({ ...edited, edited_message: { ...edited.edited_message, from: { id: 999 } } })
  assert.equal(f.events.length, 2)
})
test('a stopped burst remains journaled and restart restores it in original order', async t => {
  const f = fixture(t)
  await f.channel.handleUpdate(update(1, 'first')); await f.channel.handleUpdate(update(2, 'second'))
  await f.channel.stop(); assert.equal(f.events.length, 0)
  const restored = f.create()
  restored.poll = async () => {}
  await restored.start(); await restored.batcher.flush()
  assert.equal(f.events[0].text, 'first\nsecond'); await restored.stop()
})
test('agent edit renders formatting, restricts bot-owned messages and enforces authorization', async t => {
  const f = fixture(t)
  await f.channel.reply({ chat_id: '123', text: 'First reply.' })
  await f.channel.editMessage({ chat_id: '123', message_id: '77', text: '**Updated** reply.' })
  const call = f.calls.find(call => call.method === 'editMessageText')
  assert.equal(call.params.text, 'Updated reply.'); assert.equal(call.params.entities[0].type, 'bold')
  assert.equal(f.store.message('123', '77').text, 'Updated reply.')
  await assert.rejects(f.channel.editMessage({ chat_id: '123', message_id: '1', text: 'edit user' }), /sent by this bot/)
  await assert.rejects(f.channel.editMessage({ chat_id: '999', message_id: '77', text: 'edit other' }), /not paired/)
  await assert.rejects(f.channel.agentReact({ chat_id: '999', message_id: '77', emoji: '👍' }), /not paired/)
})

test('incoming batches, duplicate delivery and user edits never create reactions with legacy config', async t => {
  const f = fixture(t)
  writeFileSync(f.store.configPath, JSON.stringify({ ackReaction: '👀' }))
  await f.channel.handleUpdate(update(10, 'first'))
  await f.channel.handleUpdate(update(11, 'second')); await f.channel.batcher.flush()
  const batch = f.events[0]
  f.store.markEvent(batch.eventId, 'delivered', { payload: null })
  const bridge = new GeliosBridge({ stateDir: f.store.dir, workspace: f.channel.workspaceRoot })
  bridge.markTelegramBatchDelivered(batch)
  await f.channel.handleUpdate(update(10, 'first'))
  await f.channel.handleUpdate({ update_id: 20, edited_message: { ...update(10, 'edited').message, edit_date: 20 } })
  await f.channel.batcher.flush()
  assert.equal(f.events.length, 2)
  assert.equal(f.events[1].edited, true)
  assert.equal(f.calls.some(call => call.method === 'setMessageReaction'), false)
  assert.deepEqual(f.store.loadRuntime().acknowledgements || {}, {})
})
