import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AppServerError, GeliosBridge } from '../scripts/bridge.js'
import { until } from './support/wait.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gelios-thread-recovery-'))
  const bridge = new GeliosBridge({ stateDir: join(root, 'state'), workspace: root })
  bridge.appReady = true
  bridge.bindThread('saved-thread')
  bridge.currentSettings = { model: 'chosen-model', effort: 'high' }
  bridge.telegram = { acknowledge: async () => {}, stopTyping() {}, sendMessage: async () => {}, notice: async () => {} }
  bridge.log = () => {}
  bridge.retryDelay = () => 60_000
  t.after(() => { clearTimeout(bridge.retryTimer); clearTimeout(bridge.restoreTimer) })
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
  bridge.telegram.notice = async (_chat, text) => { reported.push(text) }
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


test('native settings notifications persist the selected permission profile and workspace', t => {
  const { bridge } = fixture(t)
  bridge.observeAppMessage({ method: 'thread/settings/updated', params: { threadId: 'saved-thread', threadSettings: {
    model: 'chosen-model', cwd: join(bridge.options.workspace, 'subproject'), approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, activePermissionProfile: { id: ':read-only' },
  } } })
  const saved = bridge.store.loadBinding()
  assert.equal(saved.workspace, bridge.options.workspace)
  assert.equal(saved.permissions.sandboxPolicy.type, 'readOnly')
  assert.equal(saved.permissions.activePermissionProfile.id, ':read-only')
})


test('Telegram delivery waits for native terminal selection to finish', async t => {
  const { bridge, users, event } = fixture(t)
  bridge.tui = { closed: false, bootstrapped: false }
  await bridge.acceptTelegram(event(1), async () => event(1))
  assert.equal(users.length, 0)
  assert.equal(bridge.waitingTelegram.length, 1)
  bridge.tui.bootstrapped = true
  bridge.flushWaiting(); await bridge.ingress
  assert.equal(users.length, 1)
})

test('YOLO resume updates a loaded native thread before rejoining it', async t => {
  const { bridge, calls } = fixture(t)
  const peer = { launchYolo: true, sendText() {} }
  bridge.isThreadLoaded = async () => true
  const rpc = bridge.rpc
  bridge.rpc = async (method, params) => method === 'thread/settings/update' ? (calls.push({ method, params }), {}) : rpc(method, params)
  bridge.forwardTui = async message => calls.push({ method: message.method, params: message.params })
  bridge.onTuiText(JSON.stringify({ id: 17, method: 'thread/resume', params: { threadId: 'saved-thread' } }), peer)
  await bridge.ingress
  assert.deepEqual(calls.map(call => call.method), ['thread/settings/update', 'thread/resume'])
  assert.equal(calls[0].params.permissions, ':danger-full-access')
  assert.equal(calls[1].params.permissions, ':danger-full-access')
})

for (const failedMethod of ['initialize', 'skills/list', 'config/mcpServer/reload', 'thread/resume', 'thread/loaded/list']) {
  test(`routing retries a transient ${failedMethod} failure and delivers saved input once`, { timeout: 60_000 }, async t => {
    const { bridge, calls, event, users } = fixture(t)
    const original = bridge.rpc
    let failed = false
    bridge.app = { runtime: { connectionEpoch: 2, mcpRefreshRequired: true } }
    bridge.sendApp = () => {}
    bridge.restoreDelay = () => 5
    bridge.rpc = async (method, params) => {
      if (method === failedMethod && !failed) { failed = true; throw new Error('transient restore failure') }
      if (['initialize', 'skills/list', 'config/mcpServer/reload'].includes(method)) { calls.push({ method, params }); return {} }
      return original(method, params)
    }
    const binding = { threadId: 'saved-thread', workspace: bridge.options.workspace, initialize: { clientInfo: { name: 'retry-fixture' } } }
    await bridge.restoreBinding(binding)
    assert.equal(bridge.appReady, false)
    assert.equal(bridge.restoration.attempt, 1)
    await bridge.acceptTelegram(event(55), async () => event(55))
    await until(t, () => bridge.appReady && users.length, 'the retried restore to deliver the saved input')
    await bridge.ingress
    assert.equal(bridge.appReady, true)
    assert.equal(bridge.restoration, null)
    assert.deepEqual(users.map(user => user.clientId), ['telegram-123-55'])
    assert.equal(calls.filter(call => call.method === 'turn/start').length, 1)
    assert.equal(bridge.waitingTelegram.length, 0)
  })
}

test('a late restored snapshot cannot resurrect a turn completed during thread/read', async t => {
  const { bridge } = fixture(t)
  bridge.app = { runtime: { connectionEpoch: 2 } }; bridge.sendApp = () => {}
  bridge.activeTurnId = 'finishing-turn'
  bridge.rpc = async method => {
    if (method === 'initialize') return {}
    if (method === 'thread/resume') return { thread: { id: 'saved-thread', status: { type: 'active' } } }
    if (method === 'thread/read') {
      bridge.observeAppMessage({ method: 'turn/completed', params: { threadId: 'saved-thread', turn: { id: 'finishing-turn', status: 'completed' } } })
      return { thread: { id: 'saved-thread', status: { type: 'active' }, turns: [{ id: 'finishing-turn', status: 'inProgress' }] } }
    }
    if (method === 'thread/loaded/list') return { data: [], nextCursor: null }
    throw new Error(method)
  }
  await bridge.restoreBinding({ threadId: 'saved-thread', workspace: bridge.options.workspace, initialize: {} })
  assert.equal(bridge.activeTurnId, null)
  assert.equal(bridge.appReady, true)
})

test('deferred selection refreshes changed tools without resuming saved history', async t => {
  const { bridge, calls } = fixture(t)
  bridge.app = { runtime: { connectionEpoch: 2, mcpRefreshRequired: true } }
  bridge.options.deferBindingResume = true; bridge.sendApp = () => {}
  bridge.rpc = async (method, params) => { calls.push({ method, params }); return method === 'thread/loaded/list' ? { data: [], nextCursor: null } : {} }
  await bridge.restoreBinding({ threadId: 'saved-thread', workspace: bridge.options.workspace, initialize: {} })
  assert.deepEqual(calls.map(call => call.method), ['initialize', 'skills/list', 'config/mcpServer/reload', 'thread/loaded/list'])
  assert.equal(bridge.appReady, true)
})

test('restoring loaded activity keeps a newer notification over a delayed snapshot', async t => {
  const { bridge } = fixture(t)
  bridge.rpc = async method => {
    if (method === 'thread/loaded/list') return { data: ['other-thread'], nextCursor: null }
    bridge.observeAppMessage({ method: 'thread/status/changed', params: { threadId: 'other-thread', status: { type: 'active' } } })
    return { thread: { id: 'other-thread', status: { type: 'idle' } } }
  }
  await bridge.restoreRuntimeActivity()
  assert.ok(bridge.runningThreads.has('other-thread'))
})

test('a reconnect reconstructs loaded threads that have no replayed notifications', async t => {
  const { bridge } = fixture(t)
  bridge.app = { runtime: { connectionEpoch: 2 } }; bridge.sendApp = () => {}
  bridge.rpc = async (method, params) => {
    if (method === 'initialize') return {}
    if (method === 'thread/resume') return { thread: { id: 'saved-thread', turns: [], status: { type: 'idle' } } }
    if (method === 'thread/loaded/list') return { data: ['other-thread'], nextCursor: null }
    if (method === 'thread/read') return { thread: { id: params.threadId, status: { type: 'active' } } }
    throw new Error(method)
  }
  await bridge.restoreBinding({ threadId: 'saved-thread', workspace: bridge.options.workspace, initialize: {} })
  assert.deepEqual([...bridge.runningThreads], ['other-thread'])
})


test('a permanently missing restored conversation reports failure without a silent retry queue', async t => {
  const { bridge, event, users } = fixture(t), notices = [], original = bridge.rpc
  bridge.sendApp = () => {}; bridge.app = { runtime: { connectionEpoch: 2 } }
  let resumes = 0
  bridge.rpc = async method => {
    if (method === 'initialize') return {}
    if (method === 'thread/resume') { resumes++; throw new AppServerError({ code: -32602, message: 'thread not found: saved-thread' }, method) }
    assert.fail(method)
  }
  bridge.telegram.notice = async (...args) => notices.push(args)
  await bridge.restoreBinding({ threadId: 'saved-thread', workspace: bridge.options.workspace, initialize: {} })
  assert.equal(bridge.restoreTimer, null)
  assert.equal(bridge.restoration.permanent, true)
  await assert.rejects(bridge.acceptTelegram(event(66), async () => event(66)), /conversation.*unavailable/)
  assert.equal(resumes, 1); assert.equal(users.length, 0); assert.equal(bridge.waitingTelegram.length, 0)
  assert.equal(notices.length, 1); assert.match(notices[0][1], /automatic retries stopped/)
  assert.equal(bridge.store.loadRuntime().events['telegram-123-66'].retryable, false)
  bridge.rpc = original
  const peer = { sendText() {}, bootstrapped: true, selectedThreadId: 'saved-thread' }
  bridge.forwarded.set('explicit-restore', { method: 'thread/resume', message: { params: { threadId: 'saved-thread' } }, peer, id: 44 })
  bridge.onAppLine(JSON.stringify({ id: 'explicit-restore', result: { thread: { id: 'saved-thread', turns: [] } } }))
  assert.equal(bridge.restoration, null); assert.equal(bridge.appReady, true)
  await bridge.acceptTelegram(event(68), async () => event(68))
  assert.equal(users.length, 1, 'a later message reaches the explicitly restored conversation')
})

test('lasting transient restoration failures notify each saved arrival once', async t => {
  const { bridge, event } = fixture(t), notices = []
  bridge.sendApp = () => {}; bridge.restoreDelay = () => 60000
  bridge.rpc = async () => { throw new Error('connection temporarily unavailable') }
  bridge.telegram.notice = async (...args) => notices.push(args)
  await bridge.restoreBinding({ threadId: 'saved-thread', workspace: bridge.options.workspace, initialize: {} })
  await bridge.acceptTelegram(event(67), async () => event(67))
  await bridge.acceptTelegram(event(67), async () => event(67))
  assert.equal(notices.length, 1); assert.match(notices[0][1], /message is saved/)
  assert.equal(bridge.store.loadRuntime().events['telegram-123-67'].restorationNoticeSent, true)
})
