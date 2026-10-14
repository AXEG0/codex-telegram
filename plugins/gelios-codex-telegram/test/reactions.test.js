import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { StateStore } from '../src/core.js'
import { ReactionQueue } from '../src/reactions.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gelios-reactions-'))
  const store = new StateStore(root), calls = []
  let authorized = true
  const options = { store, log: () => {}, authorize: () => { if (!authorized) throw new Error('not paired') },
    send: async (...args) => { calls.push(args) } }
  const queue = new ReactionQueue(options)
  t.after(() => { queue.stop(); rmSync(root, { recursive: true, force: true }) })
  return { store, calls, options, queue, revoke: () => { authorized = false } }
}
function legacyReceipt(store, key, eventId, pending = true) {
  const [chatId, messageId] = key.split(':')
  const runtime = store.loadRuntime(); runtime.acknowledgements ||= {}
  runtime.acknowledgements[key] = { chatId, messageId, eventId, kind: 'receipt', emoji: '👀', pending, revision: 1 }
  store.saveRuntime(runtime)
}
test('starting and retrying an empty queue generates no reactions', async t => {
  const f = fixture(t); f.queue.start(); f.queue.retry()
  assert.deepEqual(f.calls, [])
})
test('legacy receipts are cleared on restart even before native acceptance', async t => {
  const f = fixture(t)
  f.store.acceptEvent('queued', { source: 'Telegram' }); f.store.markEvent('queued', 'queued')
  legacyReceipt(f.store, '1:2', 'queued')
  f.queue.start(); await f.queue.flush('1:2')
  assert.deepEqual(f.calls.map(call => call[2]), [null])
  assert.equal(f.store.loadRuntime().acknowledgements['1:2'].pending, false)
  f.queue.stop(); const restored = new ReactionQueue(f.options); t.after(() => restored.stop())
  restored.start(); await restored.flush('1:2')
  assert.deepEqual(f.calls.map(call => call[2]), [null], 'retired eyes cannot be re-added after another restart')
})
test('legacy receipt cleanup survives a rate limit without replaying eyes', async t => {
  const f = fixture(t); legacyReceipt(f.store, '1:2', 'event', false)
  f.queue.send = async () => { const error = new Error('rate limited'); error.code = 429; throw error }
  f.queue.start(); await assert.rejects(f.queue.flush('1:2'), /rate limited/)
  assert.equal(f.store.loadRuntime().acknowledgements['1:2'].emoji, null)
  assert.equal(f.store.loadRuntime().acknowledgements['1:2'].pending, true)
  f.queue.stop(); const restored = new ReactionQueue(f.options); t.after(() => restored.stop())
  restored.start(); await restored.flush('1:2')
  assert.deepEqual(f.calls.map(call => call[2]), [null])
})
test('an in-flight legacy clear cannot erase a newer agent-chosen reaction', async t => {
  const f = fixture(t); let release
  legacyReceipt(f.store, '1:2', 'event')
  f.queue.send = async (...args) => {
    f.calls.push(args)
    if (args[2] === null) await new Promise(resolve => { release = resolve })
  }
  f.queue.start()
  const explicit = f.queue.explicit('1', '2', '👍'); release(); await explicit
  assert.deepEqual(f.calls.map(call => call[2]), [null, '👍'])
  f.queue.retry(); await f.queue.flush('1:2')
  assert.equal(f.calls.at(-1)[2], '👍')
})
test('agent-chosen reactions remain authorized, validated, durable and clearable', async t => {
  const f = fixture(t)
  f.queue.send = async () => { const error = new Error('rate limited'); error.code = 429; throw error }
  await assert.rejects(f.queue.explicit('1', '2', '👍'), /rate limited/)
  f.queue.stop(); const restored = new ReactionQueue(f.options); t.after(() => restored.stop())
  restored.start(); await restored.flush('1:2'); await restored.explicit('1', '2', '')
  assert.deepEqual(f.calls.map(call => call[2]), ['👍', null])
  await assert.rejects(restored.explicit('1', '2', '✅'), /unsupported/)
  f.revoke(); await assert.rejects(restored.explicit('1', '2', '👍'), /not paired/)
})
test('startup keeps existing explicit reactions and reconciles accepted batch members', async t => {
  const f = fixture(t)
  f.store.acceptEvent('member', { source: 'Telegram' }); f.store.markEvent('member', 'batched', { parentEventId: 'batch', payload: null })
  f.store.acceptEvent('batch', { source: 'Telegram' }); f.store.markEvent('batch', 'delivered', { payload: null })
  await f.queue.explicit('1', '2', '👍'); const before = f.calls.length
  f.queue.start(); await f.queue.flush('1:2')
  assert.equal(f.calls.length, before)
  assert.equal(f.store.loadRuntime().acknowledgements['1:2'].emoji, '👍')
  assert.equal(f.store.loadRuntime().events.member.status, 'delivered')
})
