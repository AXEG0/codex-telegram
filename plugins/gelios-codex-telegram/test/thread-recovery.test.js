import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AppServerError, GeliosBridge } from '../scripts/bridge.js'
import { enforceYolo, isYoloPolicy } from '../src/session.js'
import { until } from './support/wait.js'

const yolo = { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, activePermissionProfile: { id: ':danger-full-access' } }
const cautious = { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' }, activePermissionProfile: null }

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
  // The conversations Codex holds loaded, none until a resume or a test loads one.
  const loaded = new Set()
  // The policy Codex holds for the loaded conversation, YOLO unless a test says otherwise. Codex applies a
  // resume's policy only to a conversation it loads, and reports a settings update in thread/settings/updated.
  const host = { policy: yolo }
  bridge.threadPermissions.set('saved-thread', yolo)
  bridge.rpc = async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/loaded/list') return { data: [...loaded], nextCursor: null }
    if (method === 'thread/resume') {
      if (!loaded.has(params.threadId)) host.policy = policyOf(params)
      loaded.add(params.threadId)
      if (host.policy) bridge.threadPermissions.set(params.threadId, host.policy) // as the bridge records a resume's response
      return { thread: { id: params.threadId, turns: [] }, model: 'chosen-model', reasoningEffort: 'high' }
    }
    if (method === 'thread/settings/update') {
      // Codex switches only a conversation it holds loaded (codex 0.162.1: -32600 `thread not found`).
      if (!loaded.has(params.threadId)) throw new AppServerError({ code: -32600, message: `thread not found: ${params.threadId}` }, method)
      host.policy = policyOf(params)
      setImmediate(() => bridge.observeAppMessage({ method: 'thread/settings/updated', params: { threadId: params.threadId,
        threadSettings: { model: 'chosen-model', effort: 'high', ...host.policy } } }))
      return {}
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
  return { bridge, calls, users, event, host,
    setLoaded: (value, threadId = 'saved-thread') => { if (value) loaded.add(threadId); else loaded.delete(threadId) } }
}
// The policy Codex reports for the policy a request names.
function policyOf(params) {
  const type = params.permissions === ':danger-full-access' || params.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'readOnly'
  return { approvalPolicy: params.approvalPolicy || 'on-request', sandboxPolicy: { type },
    activePermissionProfile: params.permissions ? { id: params.permissions } : null }
}

test('unloaded routing resumes once for concurrent arrivals and duplicate deliveries', async t => {
  const { bridge, calls, users, event } = fixture(t)
  await Promise.all([1, 2, 1].map(id => bridge.acceptTelegram(event(id), async () => event(id))))
  assert.equal(calls.filter(call => call.method === 'thread/resume').length, 1)
  assert.deepEqual(calls.find(call => call.method === 'thread/resume').params, {
    threadId: 'saved-thread', cwd: bridge.options.workspace, excludeTurns: true,
    model: 'chosen-model', config: { model_reasoning_effort: 'high' },
    approvalPolicy: 'never', permissions: ':danger-full-access',
  })
  assert.equal(calls.some(call => call.method === 'thread/settings/update'), false, 'a resume that loads the conversation needs no switch')
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
  assert.equal(resume.params.sandbox, undefined)
  assert.equal(resume.params.permissions, ':danger-full-access')
  assert.equal(resume.params.approvalPolicy, 'never')
})

test('a resume of a saved conversation with approvals on restores it with approvals off', async t => {
  const { bridge, calls, users, event } = fixture(t)
  const binding = { threadId: 'saved-thread', workspace: bridge.options.workspace, permissions: cautious, initialize: { clientInfo: { name: 'test' } } }
  bridge.store.saveBinding(binding)
  bridge.threadPermissions.set('saved-thread', cautious)
  const rpc = bridge.rpc
  bridge.rpc = async (method, params) => method === 'initialize' ? (calls.push({ method, params }), {}) : rpc(method, params)
  bridge.sendApp = () => {}
  await bridge.restoreBinding(binding)
  const restored = calls.find(call => call.method === 'thread/resume').params
  assert.equal(restored.approvalPolicy, 'never'); assert.equal(restored.permissions, ':danger-full-access')
  assert.equal(restored.sandbox, undefined)
  assert.equal(bridge.restoration, null)
  calls.length = 0
  bridge.rpc = rpc
  await bridge.acceptTelegram(event(1), async () => event(1))
  const resume = calls.find(call => call.method === 'thread/resume')
  assert.equal(resume, undefined, 'the restored conversation is still loaded')
  const turn = calls.find(call => call.method === 'turn/start').params
  assert.equal(turn.approvalPolicy, 'never'); assert.equal(turn.permissions, ':danger-full-access')
  assert.equal(turn.sandboxPolicy, undefined)
  assert.equal(users.length, 1)
})

test('a restore switches a conversation Codex still holds loaded with approvals on before routing reports ready', async t => {
  const { bridge, calls, host, setLoaded } = fixture(t)
  // A replacement bridge knows no policy until Codex reports one. Codex kept the conversation loaded across the
  // replacement, so the restore's resume answers with the policy it holds and leaves it as it was.
  bridge.threadPermissions.clear(); setLoaded(true); host.policy = cautious
  const binding = { threadId: 'saved-thread', workspace: bridge.options.workspace, permissions: cautious, initialize: { clientInfo: { name: 'test' } } }
  bridge.store.saveBinding(binding)
  const status = () => bridge.handleControl(JSON.stringify({ action: 'status' }))
  const readyAtSwitch = []
  const rpc = bridge.rpc
  bridge.rpc = async (method, params) => {
    if (method === 'initialize') { calls.push({ method, params }); return {} }
    if (method === 'thread/settings/update') readyAtSwitch.push((await status()).ready)
    return rpc(method, params)
  }
  bridge.sendApp = () => {}
  await bridge.restoreBinding(binding)
  assert.deepEqual(calls.map(call => call.method), ['initialize', 'thread/resume', 'thread/settings/update'])
  assert.deepEqual(calls[2].params, { threadId: 'saved-thread', approvalPolicy: 'never', permissions: ':danger-full-access' })
  assert.deepEqual(readyAtSwitch, [false], 'the switch is made before routing reports ready')
  const restored = await status()
  assert.equal(restored.ready, true)
  assert.equal(restored.threadId, 'saved-thread')
  // What the update's activation check reads before it commits a replacement.
  assert.equal(isYoloPolicy(restored.permissions), true)
  assert.equal(host.policy.approvalPolicy, 'never')
  assert.equal(bridge.store.loadBinding().permissions.approvalPolicy, 'never')
})

test('a loaded conversation with approvals on is switched before a Telegram turn runs in it', async t => {
  const { bridge, calls, users, event, host, setLoaded } = fixture(t)
  setLoaded(true); host.policy = cautious; bridge.threadPermissions.set('saved-thread', cautious)
  const order = []
  const rpc = bridge.rpc
  bridge.rpc = async (method, params) => { if (method !== 'thread/loaded/list') order.push(method); return rpc(method, params) }
  // Codex reports thread/settings/updated only when the settings changed, so the accepted switch is recorded at once.
  bridge.observeAppMessage = () => {}
  await bridge.acceptTelegram(event(1), async () => event(1))
  assert.deepEqual(order, ['thread/settings/update', 'turn/start'])
  assert.equal(calls.some(call => call.method === 'thread/resume'), false)
  const update = calls.find(call => call.method === 'thread/settings/update').params
  assert.deepEqual(update, { threadId: 'saved-thread', approvalPolicy: 'never', permissions: ':danger-full-access' })
  assert.equal(bridge.threadPermissions.get('saved-thread').sandboxPolicy.type, 'dangerFullAccess')
  assert.equal(bridge.store.loadBinding().permissions.approvalPolicy, 'never')
  assert.equal(users.length, 1)
  // A conversation recorded in YOLO mode is not switched again.
  calls.length = 0; order.length = 0
  bridge.activeTurnId = null
  await bridge.acceptTelegram(event(2), async () => event(2))
  assert.deepEqual(order, ['turn/start'])
})

test('a terminal selection during the switch before a Telegram turn keeps the turn out of the conversation it left', async t => {
  const { bridge, calls, users, event, host, setLoaded } = fixture(t)
  setLoaded(true); host.policy = cautious; bridge.threadPermissions.set('saved-thread', cautious)
  const rpc = bridge.rpc
  bridge.rpc = async (method, params) => {
    const result = await rpc(method, params)
    if (method === 'thread/settings/update') bridge.bindThread('operator-selected-thread')
    return result
  }
  await assert.rejects(bridge.acceptTelegram(event(1), async () => event(1)), /changed before delivery/)
  assert.equal(bridge.currentThreadId, 'operator-selected-thread')
  assert.equal(calls.some(call => call.method === 'turn/start'), false)
  assert.equal(users.length, 0)
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

test('an unloaded empty conversation is loaded again with approvals off', async t => {
  const { bridge } = fixture(t)
  bridge.emptyThreadHandoffs.set('empty', { thread: { id: 'empty', turns: [] }, cwd: bridge.options.workspace, approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } })
  const requests = []
  let loaded = false
  bridge.rpc = async (method, params) => {
    requests.push({ method, params })
    if (method === 'thread/loaded/list') return { data: loaded ? ['empty'] : [], nextCursor: null }
    if (method === 'thread/resume') { loaded = true; return { thread: { id: 'empty', turns: [] } } }
    if (method === 'thread/read') throw new AppServerError({ code: -32601, message: 'list_turns is not supported yet' }, method)
    throw new Error(`unexpected ${method}`)
  }
  assert.equal(await bridge.loadEmptyThread('empty'), true)
  const resume = requests.find(request => request.method === 'thread/resume').params
  assert.deepEqual([resume.approvalPolicy, resume.permissions, 'sandbox' in resume], ['never', ':danger-full-access', false])
})

test('a terminal resume of an empty conversation saved with approvals on is answered: the bridge sets the policy itself', async t => {
  const { bridge } = fixture(t)
  bridge.emptyThreadHandoffs.set('empty', { thread: { id: 'empty', turns: [] }, model: 'old', approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } })
  bridge.loadEmptyThread = async () => true
  const requests = [], replies = []
  bridge.rpc = async (method, params) => { requests.push({ method, params }); return {} }
  const resume = enforceYolo({ id: 7, method: 'thread/resume', params: { threadId: 'empty', approvalPolicy: 'on-request', sandbox: 'read-only' } })
  assert.equal(resume.params.approvalPolicy, 'never')
  await bridge.handoffEmptyThread(resume, { sendText: text => replies.push(JSON.parse(text)) })
  assert.equal(requests.length, 0)
  assert.equal(replies[0].error, undefined)
  assert.equal(replies[0].result.thread.id, 'empty')
  assert.equal(bridge.currentThreadId, 'empty')
})

test('a terminal resume of an empty conversation naming workspace-write sandbox settings is answered: the bridge sets the sandbox itself', async t => {
  const { bridge } = fixture(t)
  bridge.emptyThreadHandoffs.set('empty', { thread: { id: 'empty', turns: [] }, model: 'old', approvalPolicy: 'on-request',
    sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } })
  bridge.loadEmptyThread = async () => true
  const requests = [], replies = []
  bridge.rpc = async (method, params) => { requests.push({ method, params }); return {} }
  // A terminal on a workspace-write sandbox names that sandbox's settings in the resume's config.
  const resume = enforceYolo({ id: 8, method: 'thread/resume', params: { threadId: 'empty', model: 'old', sandbox: 'workspace-write',
    config: { sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false } } } })
  await bridge.handoffEmptyThread(resume, { sendText: text => replies.push(JSON.parse(text)) })
  assert.equal(requests.length, 0)
  assert.equal(replies[0].error, undefined)
  assert.equal(replies[0].result.thread.id, 'empty')
  assert.equal(bridge.currentThreadId, 'empty')
})

test('a plain terminal resume switches a loaded conversation with approvals on before rejoining it', async t => {
  const { bridge, calls, host, setLoaded } = fixture(t)
  const peer = { sendText() {} }
  setLoaded(true); host.policy = cautious; bridge.threadPermissions.set('saved-thread', cautious)
  bridge.forwardTui = async message => calls.push({ method: message.method, params: message.params })
  bridge.onTuiText(JSON.stringify({ id: 17, method: 'thread/resume', params: { threadId: 'saved-thread', approvalPolicy: 'on-request', sandbox: 'read-only' } }), peer)
  await bridge.ingress
  assert.deepEqual(calls.filter(call => call.method !== 'thread/loaded/list').map(call => call.method), ['thread/settings/update', 'thread/resume'])
  const [update, resume] = calls.filter(call => call.method !== 'thread/loaded/list')
  assert.equal(update.params.approvalPolicy, 'never'); assert.equal(update.params.permissions, ':danger-full-access')
  assert.equal(resume.params.approvalPolicy, 'never'); assert.equal(resume.params.permissions, ':danger-full-access')
  assert.equal(resume.params.sandbox, undefined)
})

test('a terminal resume of an unbound loaded conversation Codex reported with approvals on is switched before it is forwarded', async t => {
  const { bridge, calls, setLoaded } = fixture(t)
  setLoaded(true); setLoaded(true, 'other-thread')
  bridge.threadPermissions.set('other-thread', yolo)
  // Another client turns approvals on in a conversation Telegram is not bound to.
  bridge.observeAppMessage({ method: 'thread/settings/updated', params: { threadId: 'other-thread',
    threadSettings: { model: 'chosen-model', effort: 'high', ...cautious } } })
  bridge.forwardTui = async message => calls.push({ method: message.method, params: message.params })
  bridge.onTuiText(JSON.stringify({ id: 18, method: 'thread/resume', params: { threadId: 'other-thread' } }), { sendText() {} })
  await bridge.ingress
  const sent = calls.filter(call => call.method !== 'thread/loaded/list')
  assert.deepEqual(sent.map(call => call.method), ['thread/settings/update', 'thread/resume'])
  assert.deepEqual(sent[0].params, { threadId: 'other-thread', approvalPolicy: 'never', permissions: ':danger-full-access' })
  assert.equal(sent[1].params.threadId, 'other-thread')
  assert.equal(sent[1].params.approvalPolicy, 'never'); assert.equal(sent[1].params.permissions, ':danger-full-access')
})

test('a terminal resume of a conversation Codex has not loaded is forwarded with no switch, and its answer reaches the terminal', async t => {
  const { bridge, calls } = fixture(t)
  // After a restart no policy is known yet, and Codex refuses a switch of a conversation it has not loaded.
  bridge.threadPermissions.clear()
  const sent = []
  bridge.app = { stdin: { writable: true, write: value => sent.push(JSON.parse(value)) } }
  const peer = { closed: false, messages: [], sendText(value) { this.messages.push(JSON.parse(value)) } }
  bridge.onTuiText(JSON.stringify({ id: 19, method: 'thread/resume', params: { threadId: 'saved-thread' } }), peer)
  await until(t, () => sent.length || peer.messages.length, 'the resume to reach Codex or an answer to reach the terminal')
  assert.deepEqual(peer.messages, [], 'nothing answers the terminal before Codex does')
  assert.equal(sent[0].method, 'thread/resume')
  assert.equal(sent[0].params.approvalPolicy, 'never'); assert.equal(sent[0].params.permissions, ':danger-full-access')
  bridge.onAppLine(JSON.stringify({ id: sent[0].id, result: { thread: { id: 'saved-thread', turns: [] },
    approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } } }))
  await bridge.ingress
  assert.equal(calls.some(call => call.method === 'thread/settings/update'), false)
  assert.equal(peer.messages[0].id, 19)
  assert.equal(peer.messages[0].error, undefined)
  assert.equal(peer.messages[0].result.thread.id, 'saved-thread')
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
