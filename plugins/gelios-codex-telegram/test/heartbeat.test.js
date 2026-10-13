import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { StateStore } from '../src/core.js'
import { HeartbeatScheduler } from '../src/heartbeat.js'
import { AppServerError } from '../src/session.js'
import { GeliosBridge } from '../scripts/bridge.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gelios-heartbeat-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new StateStore(root), calls = [], turns = []
  let now = 1000, idle = true, threadId = 'same-thread'
  const options = { store, log: () => {}, now: () => now, enqueue: fn => fn(), canRun: () => idle,
    threadId: () => threadId, ensureThread: async () => {}, readThread: async () => ({ thread: { turns } }),
    startTurn: async params => { calls.push(params); return { turn: { id: 'turn' } } } }
  return { store, calls, turns, options, scheduler: new HeartbeatScheduler(options),
    time: value => { now = value }, busy: value => { idle = !value }, select: value => { threadId = value } }
}
test('heartbeat defaults off, persists configuration, defers human work and coalesces missed ticks', async t => {
  const f = fixture(t), s = f.scheduler
  f.time(10_000); await s.tick(); assert.equal(f.calls.length, 0)
  s.configure({ enabled: true, intervalMs: 1000, prompt: 'Check the task.' })
  assert.equal(statSync(s.path).mode & 0o777, 0o600)
  f.busy(true); f.time(90_000); await s.tick(); assert.equal(f.calls.length, 0)
  const restored = new HeartbeatScheduler(f.options)
  assert.equal(restored.status().nextDueAt, 11_000)
  f.busy(false); await restored.tick(); await restored.tick()
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].threadId, 'same-thread')
  assert.equal(restored.status().nextDueAt, 91_000)
  assert.equal(f.store.loadRuntime().events[f.calls[0].clientUserMessageId].source, 'Heartbeat')
  restored.configure({ enabled: false }); f.time(100_000); await restored.tick()
  assert.equal(f.calls.length, 1)
})
test('restart reconciles an accepted heartbeat whose response was lost', async t => {
  const f = fixture(t)
  f.options.startTurn = async params => {
    f.calls.push(params); f.turns.push({ items: [{ type: 'userMessage', clientId: params.clientUserMessageId }] })
    throw new AppServerError({ message: 'transport timed out' }, 'turn/start', { ambiguous: true })
  }
  const s = new HeartbeatScheduler(f.options)
  s.configure({ enabled: true, intervalMs: 1000, prompt: 'Check once.' }); f.time(2000)
  await s.tick(); assert.ok(s.status().pending)
  const restored = new HeartbeatScheduler(f.options)
  await restored.tick(); assert.equal(f.calls.length, 1); assert.equal(restored.status().pending, null)
  assert.equal(f.store.loadRuntime().events[f.calls[0].clientUserMessageId].reconciled, true)
})
test('busy race never steers, and a conversation switch cancels unaccepted old delivery', async t => {
  const f = fixture(t)
  f.options.startTurn = async params => { f.calls.push(params); throw new AppServerError({ message: 'turn already active' }, 'turn/start') }
  const s = new HeartbeatScheduler(f.options)
  s.configure({ enabled: true, intervalMs: 1000, prompt: 'Check idle.' }); f.time(2000)
  await s.tick(); const old = s.status().pending
  f.select('new-thread'); f.options.startTurn = async params => { f.calls.push(params); return { turn: { id: 'new-turn' } } }
  const restored = new HeartbeatScheduler(f.options)
  await restored.tick(); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].threadId, 'new-thread')
  assert.equal(f.store.loadRuntime().events[old.eventId].status, 'cancelled')
})
test('queued heartbeat rechecks idle and disabling before any delivery', async t => {
  const f = fixture(t); let queued
  const s = new HeartbeatScheduler({ ...f.options, enqueue: fn => { queued = fn; return Promise.resolve() } })
  s.configure({ enabled: true, intervalMs: 1000, prompt: 'Check.' }); f.time(2000)
  await s.tick(); f.busy(true); await queued(); assert.equal(f.calls.length, 0)
  f.busy(false); await s.tick(); s.configure({ enabled: false }); await queued(); assert.equal(f.calls.length, 0)
  assert.throws(() => s.configure({ enabled: true, intervalMs: 0, prompt: 'Check.' }), /cadence/)
})
test('an unaccepted first heartbeat retries an empty native thread with no paginated history', async t => {
  const f = fixture(t)
  const bridge = new GeliosBridge({ stateDir: f.store.dir, workspace: f.store.dir, terminalName: 'Test operator' })
  bridge.log = () => {}; bridge.appReady = true; bridge.bindThread('same-thread')
  bridge.emptyThreadHandoffs.set('same-thread', { thread: { id: 'same-thread', turns: [] } })
  let attempts = 0, now = 1000
  bridge.rpc = async method => {
    if (method === 'thread/loaded/list') return { data: ['same-thread'] }
    if (method === 'thread/read') throw new AppServerError({ code: -32601, message: 'list_turns is not supported yet' }, method)
    if (method === 'turn/start') {
      if (++attempts === 1) throw new AppServerError({ message: 'response transport timed out' }, method, { ambiguous: true })
      return { turn: { id: 'accepted' } }
    }
    throw new Error(`unexpected native method ${method}`)
  }
  bridge.heartbeat.now = () => now
  bridge.heartbeat.configure({ enabled: true, intervalMs: 1000, prompt: 'Check.' })
  now = 2000; await bridge.heartbeat.tick(); assert.ok(bridge.heartbeat.status().pending)
  now = 3000; await bridge.heartbeat.tick()
  assert.equal(attempts, 2); assert.equal(bridge.heartbeat.status().pending, null)
  assert.equal(bridge.currentThreadId, 'same-thread')
})
