import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GeliosBridge } from '../scripts/bridge.js'
import { TurnActivity, turnErrorKind } from '../src/turn-activity.js'

// Synthetic app-server notifications in the shapes Codex 0.164.0 sends; the IDs are fixtures.
const ROOT = 'thread-root', CHILD = 'thread-child', GRANDCHILD = 'thread-grandchild', OTHER = 'thread-other'
const status = (threadId, type, activeFlags) => ({ method: 'thread/status/changed', params: { threadId, status: type === 'active' ? { type, activeFlags: activeFlags || [] } : { type } } })
const turnStarted = (threadId, id) => ({ method: 'turn/started', params: { threadId, turn: { id, status: 'inProgress', items: [] } } })
const turnCompleted = (threadId, id, turnStatus = 'completed', error = null) => ({ method: 'turn/completed', params: { threadId, turn: { id, status: turnStatus, items: [], error } } })
const item = (phase, threadId, turnId, value) => ({ method: `item/${phase}`, params: { threadId, turnId, item: value, [phase === 'started' ? 'startedAtMs' : 'completedAtMs']: 1 } })
const command = (id, itemStatus) => ({ type: 'commandExecution', id, command: 'echo fixture', status: itemStatus, commandActions: [] })
const spawn = (sender, receivers, itemStatus = 'completed') => ({ type: 'collabAgentToolCall', id: `spawn-${receivers.join('-') || 'pending'}`, tool: 'spawnAgent',
  status: itemStatus, senderThreadId: sender, receiverThreadIds: receivers, agentsStates: {} })
// A clock the test moves by hand, so each fact's time is known.
function tracker(start = 1_000) {
  const clock = { now: start }
  const activity = new TurnActivity({ now: () => clock.now })
  const at = (ms, message, root = ROOT) => { clock.now = ms; return activity.observe(message, root) }
  return { activity, clock, at }
}

test('every thread, turn, item, hook and error notification becomes one ordered fact; nothing else does', () => {
  const { activity, at } = tracker()
  const facts = [
    at(1_100, { ...status(ROOT, 'active'), emittedAtMs: 1_099 }),
    at(1_101, turnStarted(ROOT, 'turn-1')),
    at(1_102, item('started', ROOT, 'turn-1', command('call-1', 'inProgress'))),
    at(1_103, { method: 'item/commandExecution/outputDelta', params: { threadId: ROOT, turnId: 'turn-1', itemId: 'call-1', delta: 'eA==' } }),
    at(1_104, { method: 'thread/tokenUsage/updated', params: { threadId: ROOT, turnId: 'turn-1' } }),
    at(1_105, { method: 'hook/started', params: { threadId: ROOT, turnId: 'turn-1', run: { id: 'hook-1', status: 'running' } } }),
    at(1_106, { method: 'error', params: { threadId: ROOT, turnId: 'turn-1', willRetry: true, error: { message: 'Reconnecting' } } }),
    at(1_107, { method: 'item/tool/requestUserInput', id: 7, params: { threadId: ROOT, turnId: 'turn-1' } }),
  ]
  assert.deepEqual(facts.map(fact => fact?.kind ?? null), ['threadStatus', 'turnStarted', 'itemStarted', null, null, 'hookStarted', 'error', null])
  const kept = facts.filter(Boolean)
  assert.deepEqual(kept.map(fact => fact.sequence), [1, 2, 3, 4, 5])
  assert.deepEqual(kept.map(fact => fact.meaningful), [false, true, true, true, false])
  assert.deepEqual([kept[0].emittedAt, kept[1].emittedAt], [1_099, null])
  assert.deepEqual([kept[2].threadId, kept[2].turnId, kept[2].itemId, kept[2].itemType, kept[2].status, kept[2].scope],
    [ROOT, 'turn-1', 'call-1', 'commandExecution', 'inProgress', 'root'])
  assert.deepEqual([kept[3].itemId, kept[3].itemType], ['hook-1', 'hook'])
  assert.equal(kept[4].willRetry, true)
  assert.equal(activity.snapshot().facts, 5)
})

test('the root turn is followed from start to completion, with its open tools and the time each ended', () => {
  const { activity, at } = tracker()
  at(1_100, status(ROOT, 'active'))
  at(1_200, turnStarted(ROOT, 'turn-1'))
  at(1_300, item('started', ROOT, 'turn-1', command('call-1', 'inProgress')))
  let snapshot = activity.snapshot()
  assert.equal(snapshot.busy, true)
  assert.deepEqual(snapshot.turn, { id: 'turn-1', startedAt: new Date(1_200).toISOString(), openItems: 1,
    oldestOpenItem: { id: 'call-1', type: 'commandExecution', startedAt: new Date(1_300).toISOString() } })
  at(1_400, item('completed', ROOT, 'turn-1', command('call-1', 'completed')))
  assert.equal(activity.snapshot().turn.openItems, 0)
  // The host reports idle just before the turn's own completion; idle alone ends nothing.
  at(1_500, status(ROOT, 'idle'))
  assert.equal(activity.snapshot().busy, true)
  at(1_501, turnCompleted(ROOT, 'turn-1'))
  snapshot = activity.snapshot()
  assert.equal(snapshot.busy, false)
  assert.equal(snapshot.turn, null)
  assert.deepEqual(snapshot.lastTurn, { id: 'turn-1', status: 'completed', errorKind: null, closedBy: null, endedAt: new Date(1_501).toISOString() })
  assert.deepEqual(snapshot.clocks, { startedAt: new Date(1_000).toISOString(), lastActivityAt: new Date(1_501).toISOString(),
    rootActivityAt: new Date(1_501).toISOString(), descendantActivityAt: null, turnEndedAt: new Date(1_501).toISOString() })
})

test('failed, interrupted and unloaded turns keep distinct outcomes, and an unload records no invented status', () => {
  const { activity, at } = tracker()
  at(1_100, turnStarted(ROOT, 'turn-1'))
  at(1_200, turnCompleted(ROOT, 'turn-1', 'failed', { message: 'busy', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } }))
  assert.deepEqual([activity.snapshot().lastTurn.status, activity.snapshot().lastTurn.errorKind], ['failed', 'responseStreamDisconnected'])
  at(1_300, turnStarted(ROOT, 'turn-2'))
  at(1_400, turnCompleted(ROOT, 'turn-2', 'interrupted'))
  assert.deepEqual([activity.snapshot().lastTurn.id, activity.snapshot().lastTurn.status], ['turn-2', 'interrupted'])
  at(1_500, turnStarted(ROOT, 'turn-3'))
  at(1_600, status(ROOT, 'notLoaded'))
  assert.deepEqual(activity.snapshot().lastTurn, { id: 'turn-3', status: null, errorKind: null, closedBy: 'notLoaded', endedAt: new Date(1_600).toISOString() })
  at(1_700, turnStarted(ROOT, 'turn-4'))
  at(1_800, { method: 'thread/closed', params: { threadId: ROOT } })
  assert.deepEqual([activity.snapshot().lastTurn.status, activity.snapshot().lastTurn.closedBy, activity.snapshot().busy], [null, 'threadClosed', false])
  // Status changes, closures and retry notices are not activity: the clock stays at the last turn start.
  assert.equal(activity.snapshot().clocks.lastActivityAt, new Date(1_700).toISOString())
})

test('a turn already running when the conversation is bound is followed from the first work the host reports in it', () => {
  const { activity, at } = tracker()
  at(1_100, item('started', ROOT, 'turn-running', command('call-1', 'inProgress')))
  assert.deepEqual([activity.snapshot().turn.id, activity.snapshot().turn.startedAt], ['turn-running', null])
  at(1_200, turnCompleted(ROOT, 'turn-running'))
  assert.equal(activity.snapshot().busy, false)
})

test('subagents linked by their spawn record count as descendant activity at any depth, and keep the whole turn busy', () => {
  const { activity, at } = tracker()
  at(1_100, turnStarted(ROOT, 'turn-1'))
  at(1_200, item('started', ROOT, 'turn-1', spawn(ROOT, [], 'inProgress')))
  // The child's first status arrives before the spawn record names it.
  at(1_201, status(CHILD, 'idle'))
  at(1_202, item('completed', ROOT, 'turn-1', spawn(ROOT, [CHILD])))
  const childStart = at(1_203, turnStarted(CHILD, 'child-turn'))
  assert.equal(childStart.scope, 'descendant')
  assert.equal(childStart.meaningful, true)
  at(1_300, item('completed', CHILD, 'child-turn', spawn(CHILD, [GRANDCHILD])))
  at(1_301, turnStarted(GRANDCHILD, 'grandchild-turn'))
  at(1_400, turnCompleted(ROOT, 'turn-1'))
  let snapshot = activity.snapshot()
  assert.equal(snapshot.turn, null)
  assert.equal(snapshot.busy, true, 'running subagents keep the whole turn busy after the root turn ends')
  assert.deepEqual(snapshot.descendants.running.map(entry => entry.threadId), [CHILD, GRANDCHILD])
  assert.equal(snapshot.descendants.linked, 2)
  // A child's failure is its own: it does not end or fail the root.
  at(1_500, turnCompleted(GRANDCHILD, 'grandchild-turn', 'failed', { message: 'child failed' }))
  assert.equal(activity.snapshot().lastTurn.status, 'completed')
  at(1_600, item('started', CHILD, 'child-turn', command('child-call', 'inProgress')))
  snapshot = activity.snapshot()
  assert.deepEqual([snapshot.clocks.descendantActivityAt, snapshot.clocks.rootActivityAt], [new Date(1_600).toISOString(), new Date(1_400).toISOString()])
  at(1_700, turnCompleted(CHILD, 'child-turn'))
  assert.equal(activity.snapshot().busy, false)
})

test('a thread with no spawn record is never counted as the root, and its earlier work counts once a spawn record links it', () => {
  const { activity, at } = tracker()
  at(1_100, turnStarted(ROOT, 'turn-1'))
  const unrelated = at(1_200, turnStarted(OTHER, 'other-turn'))
  assert.deepEqual([unrelated.scope, unrelated.meaningful], ['other', false])
  at(1_300, item('started', OTHER, 'other-turn', command('other-call', 'inProgress')))
  let snapshot = activity.snapshot()
  assert.deepEqual([snapshot.descendants.running, snapshot.unattributedThreads, snapshot.clocks.lastActivityAt], [[], 1, new Date(1_100).toISOString()])
  // A spawn record that arrives after the child's work links it, crediting that work at the time it was seen.
  at(1_400, item('completed', ROOT, 'turn-1', spawn(ROOT, [OTHER])))
  snapshot = activity.snapshot()
  assert.deepEqual(snapshot.descendants.running.map(entry => entry.turnId), ['other-turn'])
  assert.equal(snapshot.unattributedThreads, 0)
  assert.equal(snapshot.clocks.descendantActivityAt, new Date(1_300).toISOString())
  assert.equal(snapshot.clocks.lastActivityAt, new Date(1_400).toISOString())
})

test('the native waiting state is recorded from the root thread status without approval handling', () => {
  const { activity, at } = tracker()
  at(1_100, turnStarted(ROOT, 'turn-1'))
  at(1_200, status(ROOT, 'active', ['waitingOnUserInput']))
  assert.deepEqual(activity.snapshot().waiting, { flags: ['waitingOnUserInput'], since: new Date(1_200).toISOString() })
  at(1_300, status(ROOT, 'active', ['waitingOnUserInput', 'waitingOnApproval']))
  assert.deepEqual(activity.snapshot().waiting, { flags: ['waitingOnUserInput', 'waitingOnApproval'], since: new Date(1_200).toISOString() })
  // A subagent waiting does not make the root wait.
  at(1_350, item('completed', ROOT, 'turn-1', spawn(ROOT, [CHILD])))
  at(1_360, status(CHILD, 'active', ['waitingOnApproval']))
  assert.deepEqual(activity.snapshot().waiting.flags, ['waitingOnUserInput', 'waitingOnApproval'])
  at(1_400, status(ROOT, 'active'))
  assert.equal(activity.snapshot().waiting, null)
  at(1_500, status(ROOT, 'active', ['waitingOnApproval']))
  at(1_600, turnCompleted(ROOT, 'turn-1', 'interrupted'))
  assert.equal(activity.snapshot().waiting, null)
})

test('binding another conversation starts a fresh root record at once; the old root and its subagents stop counting', () => {
  const { activity, at, clock } = tracker()
  at(1_100, turnStarted(ROOT, 'turn-1'))
  at(1_200, item('completed', ROOT, 'turn-1', spawn(ROOT, [CHILD])))
  at(1_201, turnStarted(CHILD, 'child-turn'))
  clock.now = 1_250
  activity.bind(OTHER)
  let snapshot = activity.snapshot()
  assert.deepEqual([snapshot.rootThreadId, snapshot.busy, snapshot.turn, snapshot.lastTurn, snapshot.descendants.running], [OTHER, false, null, null, []])
  assert.deepEqual([snapshot.clocks.rootActivityAt, snapshot.clocks.descendantActivityAt, snapshot.clocks.turnEndedAt], [null, null, null])
  assert.equal(snapshot.clocks.lastActivityAt, new Date(1_201).toISOString(), 'the session-wide clock keeps the last activity')
  const moved = at(1_300, turnStarted(OTHER, 'other-turn'), OTHER)
  assert.equal(moved.scope, 'root')
  assert.equal(at(1_400, turnCompleted(ROOT, 'turn-1'), OTHER).scope, 'other')
  at(1_500, turnCompleted(CHILD, 'child-turn'), OTHER)
  snapshot = activity.snapshot()
  // Completions in the old root release what was held for it and clear its stale running records.
  assert.deepEqual([snapshot.turn.id, activity.running.size, snapshot.unattributedThreads], ['other-turn', 0, 0])
  assert.equal(activity.observe(turnStarted(ROOT, 'turn-x'), null).scope, 'other', 'an unbound bridge has no root')
})

test('binding a conversation finds its running turn and its running subagents from what the host already reported', () => {
  const { activity, at } = tracker()
  // The terminal runs another conversation, which spawned a subagent, while the bridge is bound to ROOT.
  at(1_100, turnStarted(OTHER, 'other-turn'))
  at(1_200, { method: 'thread/started', params: { thread: { id: CHILD, parentThreadId: OTHER, status: { type: 'idle' } } } })
  at(1_300, turnStarted(CHILD, 'child-turn'))
  assert.deepEqual([activity.snapshot().busy, activity.snapshot().unattributedThreads], [false, 2])
  activity.bind(OTHER)
  let snapshot = activity.snapshot()
  assert.deepEqual([snapshot.busy, snapshot.turn.id, snapshot.turn.startedAt, snapshot.descendants.running.map(entry => entry.threadId)],
    [true, 'other-turn', new Date(1_100).toISOString(), [CHILD]])
  assert.equal(snapshot.unattributedThreads, 0)
  // Binding back finds the former root's open turn too.
  activity.bind(ROOT)
  activity.bind(OTHER)
  assert.equal(activity.snapshot().turn.id, 'other-turn')
  // A thread that leaves is released, so finished unrelated threads never fill the held set.
  at(1_400, turnStarted(GRANDCHILD, 'stray-turn'), OTHER)
  at(1_500, { method: 'thread/closed', params: { threadId: GRANDCHILD } }, OTHER)
  assert.equal(activity.snapshot().unattributedThreads, 0)
  // A turn notification without an ID starts nothing that its completion could fail to end.
  activity.bind(ROOT)
  at(1_600, { method: 'turn/started', params: { threadId: ROOT, turn: { status: 'inProgress', items: [] } } })
  assert.equal(activity.snapshot().turn, null)
})

test('remembered threads, items and running subagents are bounded; the oldest entries leave first', () => {
  const { activity, at } = tracker()
  at(1_100, turnStarted(ROOT, 'turn-1'))
  for (let index = 0; index < 100; index += 1) at(1_200 + index, item('started', ROOT, 'turn-1', command(`call-${index}`, 'inProgress')))
  assert.equal(activity.snapshot().turn.openItems, 64)
  assert.equal(activity.snapshot().turn.oldestOpenItem.id, 'call-36')
  for (let index = 0; index < 100; index += 1) at(2_000 + index, turnStarted(`stranger-${index}`, `turn-${index}`))
  assert.equal(activity.snapshot().unattributedThreads, 64)
  for (let index = 0; index < 600; index += 1) at(3_000, item('completed', ROOT, 'turn-1', spawn(ROOT, [`child-${index}`])))
  assert.equal(activity.parents.size, 512)
  assert.equal(activity.snapshot().descendants.linked, 512)
  const cycle = new TurnActivity()
  cycle.observe(item('completed', 'a', 't', spawn('b', ['a'])), ROOT)
  cycle.observe(item('completed', 'b', 't', spawn('a', ['b'])), ROOT)
  assert.equal(cycle.observe(turnStarted('a', 'turn-a'), ROOT).scope, 'other', 'a cycle in spawn records ends the ancestor walk')
})

// Review findings on the 0.164.0 host; each case below failed before its fix.
test('an inline review is one turn: a root completion ends the open turn whatever its ID, and each fact keeps the host\'s own turn ID', () => {
  const { activity, at } = tracker()
  // The host reports the review's first item, then a turn/started whose own ID differs and whose rootTurnId names the review.
  at(1_100, item('started', ROOT, 'review-turn', { type: 'enteredReviewMode', id: 'entered', review: 'Review this.' }))
  at(1_110, item('completed', ROOT, 'review-turn', { type: 'enteredReviewMode', id: 'entered', review: 'Review this.' }))
  const started = at(1_200, { method: 'turn/started', params: { threadId: ROOT, turn: { id: 'review-step', rootTurnId: 'review-turn', status: 'inProgress', items: [] } } })
  assert.deepEqual([started.turnId, started.rootTurnId], ['review-step', 'review-turn'])
  assert.equal(activity.snapshot().turn.id, 'review-step')
  // A review's streamed message can start without a matching completion; the turn's end closes it.
  at(1_300, item('started', ROOT, 'review-turn', { type: 'agentMessage', id: 'streamed', text: '' }))
  at(1_400, { method: 'turn/completed', params: { threadId: ROOT, turn: { id: 'review-turn', rootTurnId: 'review-turn', status: 'completed', items: [] } } })
  let snapshot = activity.snapshot()
  assert.deepEqual([snapshot.busy, snapshot.turn, snapshot.lastTurn.id, snapshot.lastTurn.status], [false, null, 'review-turn', 'completed'])
  // The conversation runs one turn at a time, so a root completion with an unexpected ID still ends the open turn.
  at(1_500, turnStarted(ROOT, 'turn-2'))
  at(1_600, turnCompleted(ROOT, 'turn-unexpected'))
  snapshot = activity.snapshot()
  assert.deepEqual([snapshot.busy, snapshot.lastTurn.id], [false, 'turn-unexpected'])
})

test('a non-fatal error status leaves a running turn and its subagents running; only an unload or a close ends them', () => {
  const { activity, at } = tracker()
  at(1_100, turnStarted(ROOT, 'turn-1'))
  at(1_200, item('completed', ROOT, 'turn-1', spawn(ROOT, [CHILD])))
  // A subagent's turn names the root's turn as rootTurnId; it is still followed under its own ID.
  const childStart = at(1_300, { method: 'turn/started', params: { threadId: CHILD, turn: { id: 'child-turn', rootTurnId: 'turn-1', status: 'inProgress', items: [] } } })
  assert.deepEqual([childStart.turnId, childStart.rootTurnId, activity.snapshot().descendants.running[0].turnId], ['child-turn', 'turn-1', 'child-turn'])
  // The host reports systemError for every error event, including one that does not affect the running turn.
  at(1_400, status(ROOT, 'systemError'))
  at(1_401, { method: 'error', params: { threadId: ROOT, turnId: 'review-turn', willRetry: false, error: { message: 'not a git repository' } } })
  at(1_500, status(CHILD, 'systemError'))
  let snapshot = activity.snapshot()
  assert.deepEqual([snapshot.busy, snapshot.turn?.id, snapshot.lastTurn, snapshot.descendants.running.map(entry => entry.threadId)], [true, 'turn-1', null, [CHILD]])
  // A real failure ends the turn through its own completion.
  at(1_600, turnCompleted(ROOT, 'turn-1', 'failed', { message: 'failed', codexErrorInfo: 'internalServerError' }))
  snapshot = activity.snapshot()
  assert.deepEqual([snapshot.lastTurn.status, snapshot.lastTurn.closedBy, snapshot.busy], ['failed', null, true])
  at(1_700, status(CHILD, 'notLoaded'))
  assert.equal(activity.snapshot().busy, false)
})

test('only a spawn record links a subagent; messaging, waiting on or resuming another thread links nothing', () => {
  const { activity, at } = tracker()
  const collab = (tool, sender, receivers) => ({ type: 'collabAgentToolCall', id: `${tool}-${receivers.join('-')}`, tool, status: 'completed',
    senderThreadId: sender, receiverThreadIds: receivers, agentsStates: {} })
  at(1_100, turnStarted(ROOT, 'turn-1'))
  for (const tool of ['sendInput', 'sendMessage', 'resumeAgent', 'wait', 'closeAgent', 'followupTask', 'interruptAgent', 'listAgents'])
    at(1_200, item('completed', ROOT, 'turn-1', collab(tool, ROOT, [OTHER])))
  assert.deepEqual([at(1_300, turnStarted(OTHER, 'other-turn')).scope, activity.parents.size], ['other', 0])
  // A subagent that messages the root never makes the root its own descendant.
  at(1_400, item('completed', ROOT, 'turn-1', collab('spawnAgent', ROOT, [CHILD])))
  at(1_500, item('completed', CHILD, 'child-turn', collab('sendMessage', CHILD, [ROOT])))
  at(1_501, { method: 'thread/started', params: { thread: { id: ROOT, parentThreadId: CHILD, status: { type: 'idle' } } } })
  assert.deepEqual([activity.parents.get(CHILD), activity.parents.has(ROOT), activity.descends(ROOT)], [ROOT, false, false])
  assert.equal(at(1_600, turnStarted(CHILD, 'child-turn')).scope, 'descendant')
})

test('a hook is activity but never opens a turn, as a session-end hook carries a turn ID that no turn has', () => {
  const { activity, at } = tracker()
  const hook = (phase, threadId, turnId) => ({ method: `hook/${phase}`, params: { threadId, turnId, run: { id: `hook-${threadId}`, status: phase === 'started' ? 'running' : 'completed' } } })
  const fact = at(1_100, hook('started', ROOT, 'session-end-turn'))
  assert.equal(fact.meaningful, true)
  let snapshot = activity.snapshot()
  assert.deepEqual([snapshot.busy, snapshot.turn, snapshot.clocks.rootActivityAt], [false, null, new Date(1_100).toISOString()])
  at(1_200, hook('completed', ROOT, 'session-end-turn'))
  at(1_300, { method: 'thread/closed', params: { threadId: ROOT } })
  assert.equal(activity.snapshot().lastTurn, null, 'no turn is invented for the hook')
  activity.bind(OTHER)
  at(1_400, item('completed', OTHER, 'turn-o', spawn(OTHER, [CHILD])), OTHER)
  at(1_500, hook('started', CHILD, 'child-session-end'), OTHER)
  snapshot = activity.snapshot()
  assert.deepEqual([snapshot.busy, snapshot.descendants.running, snapshot.clocks.descendantActivityAt], [false, [], new Date(1_500).toISOString()])
})

test('an error kind is read from either codexErrorInfo shape', () => {
  assert.equal(turnErrorKind({ codexErrorInfo: 'serverOverloaded' }), 'serverOverloaded')
  assert.equal(turnErrorKind({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } } }), 'httpConnectionFailed')
  assert.equal(turnErrorKind({ codexErrorInfo: ['unexpected'] }), null)
  assert.equal(turnErrorKind(null), null)
})

test('the bridge records native activity for its bound conversation, reports it in status, and keeps its existing turn tracking', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-telegram-activity-'))
  const bridge = new GeliosBridge({ stateDir: join(root, 'state'), workspace: root, socket: join(root, 'app.sock'),
    controlSocket: join(root, 'control.sock'), codexBin: process.execPath, terminalName: 'Operator' })
  bridge.log = () => {}
  bridge.bindThread(ROOT)
  assert.equal(bridge.activity.snapshot().rootThreadId, ROOT, 'binding a conversation binds the activity record at once')
  const before = bridge.activity.snapshot().clocks.startedAt
  for (const message of [status(ROOT, 'active'), turnStarted(ROOT, 'turn-1'), item('started', ROOT, 'turn-1', command('call-1', 'inProgress'))]) bridge.onAppLine(JSON.stringify(message))
  assert.equal(bridge.activeTurnId, 'turn-1')
  assert.deepEqual([...bridge.runningThreads], [ROOT])
  let reported = (await bridge.handleControl('{"action":"status"}')).activity
  assert.deepEqual([reported.rootThreadId, reported.busy, reported.turn.id, reported.turn.openItems, reported.clocks.startedAt], [ROOT, true, 'turn-1', 1, before])
  for (const message of [item('completed', ROOT, 'turn-1', command('call-1', 'completed')), status(ROOT, 'idle'), turnCompleted(ROOT, 'turn-1')]) bridge.onAppLine(JSON.stringify(message))
  assert.equal(bridge.activeTurnId, null)
  assert.deepEqual([...bridge.runningThreads], [])
  reported = (await bridge.handleControl('{"action":"status"}')).activity
  assert.deepEqual([reported.busy, reported.lastTurn.id, reported.lastTurn.status, reported.facts], [false, 'turn-1', 'completed', 6])
  assert.deepEqual(JSON.parse(JSON.stringify(reported)), reported, 'the status record is plain JSON')
})
