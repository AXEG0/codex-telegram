import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AppServerError, GeliosBridge } from '../scripts/bridge.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gelios-thread-recovery-'))
  const bridge = new GeliosBridge({ stateDir: join(root, 'state'), workspace: root })
  bridge.appReady = true
  bridge.bindThread('saved-thread')
  bridge.currentSettings = { model: 'chosen-model', effort: 'high' }
  bridge.telegram = { acknowledge: async () => {}, stopTyping() {}, sendMessage: async () => {} }
  bridge.log = () => {}
  bridge.retryDelay = () => 60_000
  t.after(() => clearTimeout(bridge.retryTimer))
  const calls = [], users = []
  let loaded = false
  bridge.rpc = async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/loaded/list') return { data: loaded ? ['saved-thread'] : [], nextCursor: null }
    if (method === 'thread/resume') {
      loaded = true
      return { thread: { id: params.threadId, turns: [] }, model: 'chosen-model', reasoningEffort: 'high' }
    }
    if (method === 'thread/read') return { thread: { id: 'saved-thread', turns: [{ id: 'persisted-turn', items: [...users] }] } }
    if (method === 'turn/start' || method === 'turn/steer') {
      users.push({ type: 'userMessage', clientId: params.clientUserMessageId })
      return method === 'turn/start' ? { turn: { id: 'delivery-turn' } } : { turnId: params.expectedTurnId }
    }
    throw new Error(`unexpected RPC ${method}`)
  }
  const event = id => ({ eventId: `telegram-123-${id}`, chatId: '123', messageId: String(id),
    userId: '123', source: 'Telegram', name: 'Operator', role: 'admin', timestamp: id, text: `message ${id}`, prepared: true })
  return { bridge, calls, users, event, setLoaded: value => { loaded = value } }
}

test('unloaded routing resumes once for concurrent arrivals and duplicate deliveries', async t => {
  const { bridge, calls, users, event } = fixture(t)
  await Promise.all([1, 2, 1].map(id => bridge.acceptTelegram(event(id), async () => event(id))))
  assert.equal(calls.filter(call => call.method === 'thread/resume').length, 1)
  assert.deepEqual(calls.find(call => call.method === 'thread/resume').params, {
    threadId: 'saved-thread', cwd: bridge.options.workspace, excludeTurns: true,
    model: 'chosen-model', config: { model_reasoning_effort: 'high' },
    approvalPolicy: 'never', sandbox: 'danger-full-access',
  })
  assert.deepEqual(users.map(user => user.clientId), ['telegram-123-1', 'telegram-123-2'])
  assert.equal(bridge.store.loadBinding().threadId, 'saved-thread')
  assert.deepEqual(bridge.currentSettings, { model: 'chosen-model', effort: 'high' })
  assert.equal(bridge.waitingTelegram.length, 0)
})

test('closure only clears the selected thread activity and retains its binding', async t => {
  const { bridge } = fixture(t)
  let stopped = 0
  bridge.telegram.stopTyping = () => { stopped += 1 }
  bridge.activeTurnId = 'selected-turn'
  bridge.observeAppMessage({ method: 'thread/closed', params: { threadId: 'unrelated-thread' } })
  assert.equal(bridge.activeTurnId, 'selected-turn')
  bridge.observeAppMessage({ method: 'thread/status/changed', params: { threadId: 'saved-thread', status: { type: 'notLoaded' } } })
  assert.equal(bridge.activeTurnId, null)
  bridge.observeAppMessage({ method: 'thread/closed', params: { threadId: 'saved-thread' } })
  assert.equal(stopped, 2)
  assert.equal(bridge.currentThreadId, 'saved-thread')
  assert.equal(bridge.store.loadBinding().threadId, 'saved-thread')
})

test('a closure between loaded verification and turn/start resumes and reconciles before retry', async t => {
  const { bridge, calls, users, event, setLoaded } = fixture(t)
  setLoaded(true)
  const rpc = bridge.rpc
  let closed = false
  bridge.rpc = async (method, params) => {
    if (method === 'turn/start' && !closed) {
      closed = true; setLoaded(false)
      bridge.observeAppMessage({ method: 'thread/closed', params: { threadId: 'saved-thread' } })
      throw new AppServerError({ code: -32600, message: 'thread not found: saved-thread' }, method)
    }
    return rpc(method, params)
  }
  await bridge.acceptTelegram(event(1), async () => event(1))
  assert.deepEqual(calls.map(call => call.method), ['thread/loaded/list', 'thread/resume', 'thread/read', 'turn/start'])
  assert.equal(users.length, 1)
  assert.equal(bridge.store.loadRuntime().events['telegram-123-1'].status, 'delivered')
})

test('unloaded replay reconciles an already accepted client ID instead of injecting it again', async t => {
  const { bridge, calls, users, event } = fixture(t)
  users.push({ type: 'userMessage', clientId: 'telegram-123-1' })
  const accepted = bridge.store.acceptEvent(event(1).eventId, { payload: event(1) }).event
  bridge.store.markEvent(accepted.eventId, 'failed')
  bridge.restorePendingEvents(); bridge.flushWaiting(); await bridge.ingress
  assert.deepEqual(calls.map(call => call.method), ['thread/loaded/list', 'thread/resume', 'thread/read'])
  assert.equal(bridge.store.loadRuntime().events[accepted.eventId].reconciled, true)
  assert.equal(users.length, 1)
})

test('a transient resume failure blocks newer messages and retries in persisted sequence order', async t => {
  const { bridge, calls, users, event } = fixture(t)
  const rpc = bridge.rpc
  let fail = true
  bridge.rpc = async (method, params) => {
    if (method === 'thread/resume' && fail) { fail = false; throw new Error('transient MCP initialization failure') }
    return rpc(method, params)
  }
  await assert.rejects(bridge.acceptTelegram(event(1), async () => event(1)), /transient MCP/)
  await bridge.acceptTelegram(event(2), async () => event(2))
  assert.equal(users.length, 0)
  bridge.waitingTelegram.reverse()
  bridge.flushWaiting(); await bridge.ingress
  assert.deepEqual(users.map(user => user.clientId), ['telegram-123-1', 'telegram-123-2'])
  assert.equal(calls.filter(call => call.method === 'thread/resume').length, 1)
})

test('a missing persisted conversation fails actionably with retained payload and no automatic retries', async t => {
  const { bridge, event } = fixture(t)
  const calls = [], reported = []
  bridge.telegram.sendMessage = async (_chat, text) => { reported.push(text) }
  bridge.rpc = async method => {
    calls.push(method)
    if (method === 'thread/loaded/list') return { data: [], nextCursor: null }
    throw new AppServerError({ code: -32600, message: 'no rollout found for thread saved-thread' }, method)
  }
  await assert.rejects(bridge.acceptTelegram(event(1), async () => event(1)), error =>
    error.permanent === true && /Restore it in Codex/.test(error.message))
  const saved = bridge.store.loadRuntime().events[event(1).eventId]
  assert.equal(saved.status, 'failed'); assert.equal(saved.retryable, false)
  assert.equal(saved.payload.text, 'message 1')
  assert.equal(reported.length, 1)
  await bridge.acceptTelegram(event(1), async () => { throw new Error('must not prepare again') })
  bridge.restorePendingEvents(); bridge.flushWaiting(); await bridge.ingress
  assert.equal(bridge.waitingTelegram.length, 0)
  assert.equal(bridge.retryTimer, null)
  assert.deepEqual(calls, ['thread/loaded/list', 'thread/resume'])
  assert.equal(bridge.currentThreadId, 'saved-thread')
})

test('ambiguous turn failures reconcile before replay and cannot duplicate an accepted message', async t => {
  const { bridge, users, event } = fixture(t)
  const rpc = bridge.rpc
  let timeout = true
  bridge.rpc = async (method, params) => {
    const result = await rpc(method, params)
    if (method === 'turn/start' && timeout) {
      timeout = false
      throw new AppServerError({ message: 'turn/start timed out' }, method, { ambiguous: true })
    }
    return result
  }
  await assert.rejects(bridge.acceptTelegram(event(1), async () => event(1)), /timed out/)
  assert.equal(users.length, 1)
  bridge.flushWaiting(); await bridge.ingress
  assert.equal(users.length, 1)
  assert.equal(bridge.store.loadRuntime().events[event(1).eventId].reconciled, true)
})

test('a binding change or wrong resume result cannot redirect recovery', async t => {
  const { bridge } = fixture(t)
  const rpc = bridge.rpc
  bridge.rpc = async (method, params) => {
    const result = await rpc(method, params)
    if (method === 'thread/resume') bridge.bindThread('operator-selected-thread')
    return result
  }
  await assert.rejects(bridge.ensureBoundThread('saved-thread'), /changed during resume/)
  assert.equal(bridge.currentThreadId, 'operator-selected-thread')
  bridge.bindThread('saved-thread')
  bridge.rpc = async method => method === 'thread/loaded/list' ? { data: [] } : { thread: { id: 'wrong-thread' } }
  await assert.rejects(bridge.ensureBoundThread('saved-thread'), error => error.permanent === true)
  assert.equal(bridge.currentThreadId, 'saved-thread')
})


test('explicit native selection initializes without changing the saved conversation recency', async t => {
  const { bridge, calls } = fixture(t)
  const permissions = { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, activePermissionProfile: null }
  const binding = { threadId: 'saved-thread', workspace: bridge.options.workspace, permissions, initialize: { clientInfo: { name: 'test' } } }
  bridge.store.saveBinding(binding)
  bridge.options.deferBindingResume = true
  const rpc = bridge.rpc
  bridge.rpc = async (method, params) => method === 'initialize' ? (calls.push({ method, params }), {}) : rpc(method, params)
  bridge.sendApp = () => {}
  await bridge.restoreBinding(binding)
  assert.deepEqual(calls.map(call => call.method), ['initialize'])
  assert.equal(bridge.appReady, true)
  assert.equal(bridge.restoring, false)
  assert.equal(bridge.currentThreadId, 'saved-thread')
  assert.deepEqual(bridge.store.loadBinding().permissions, permissions)
  await bridge.ensureBoundThread('saved-thread')
  const resume = calls.find(call => call.method === 'thread/resume')
  assert.equal(resume.params.sandbox, 'read-only')
  assert.equal(resume.params.approvalPolicy, 'never')
})
