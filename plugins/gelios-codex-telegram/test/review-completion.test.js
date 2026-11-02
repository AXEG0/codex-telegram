import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionController } from '../src/session.js'
import { idleSnapshot } from '../src/restart.js'

async function controller() {
  const root = mkdtempSync(join(tmpdir(), 'review-completion-'))
  const session = new SessionController({ stateDir: join(root, 'state'), workspace: root })
  session.appReady = true
  session.currentThreadId = 'thread-review'
  // Delivery queues belong to the bridge; this fixture replays notifications only.
  session.flushWaiting = () => {}
  session.flushPendingControls = () => {}
  await session.ingress
  return session
}
const started = (id, extra = {}, threadId = 'thread-review') => ({ method: 'turn/started', params: { threadId, turn: { id, ...extra } } })
const completed = (id, threadId = 'thread-review') => ({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed' } } })
const entered = (id, threadId = 'thread-review') => ({ method: 'item/started', params: { threadId, turnId: id, item: { id: 'entered-review', type: 'enteredReviewMode' } } })

for (const schema of [{ name: 'with root metadata', extra: { rootTurnId: 'review-root' } }, { name: 'without root metadata', extra: {} }]) {
  test('an inline review uses its review ID and releases idle on completion ' + schema.name, async () => {
    const session = await controller()
    session.observeAppMessage(entered('review-root'))
    session.observeAppMessage(started('review-inner', schema.extra))
    assert.equal(session.activeTurnId, 'review-root')
    assert.equal(idleSnapshot(session).flags.turn, true)
    session.observeAppMessage(completed('review-root'))
    assert.equal(session.activeTurnId, null)
    assert.equal(idleSnapshot(session).idle, true)
    session.observeAppMessage(started('next-turn'))
    assert.equal(session.activeTurnId, 'next-turn', 'the completed review does not relabel later turns')
  })
}

test('a regular turn keeps its own ID even when its root belongs to another turn', async () => {
  const session = await controller()
  session.observeAppMessage(started('own-turn', { rootTurnId: 'outer-turn' }))
  assert.equal(session.activeTurnId, 'own-turn')
  session.observeAppMessage(completed('own-turn'))
  assert.equal(idleSnapshot(session).idle, true)
})

test('unrelated review notifications leave the bound turn running', async () => {
  const session = await controller()
  session.observeAppMessage(started('bound-turn'))
  session.observeAppMessage(entered('other-review', 'thread-other'))
  session.observeAppMessage(started('other-inner', { rootTurnId: 'other-review' }, 'thread-other'))
  session.observeAppMessage(completed('other-review', 'thread-other'))
  assert.equal(session.activeTurnId, 'bound-turn')
  assert.equal(idleSnapshot(session).flags.turn, true)
  session.observeAppMessage(completed('stale-turn'))
  assert.equal(session.activeTurnId, 'bound-turn', 'an unrelated completion cannot end the active turn')
})

test('changing the bound thread discards the previous review identity', async () => {
  const session = await controller()
  session.observeAppMessage(entered('review-root'))
  session.observeAppMessage(started('review-inner', { rootTurnId: 'review-root' }))
  session.bindThread('thread-next')
  session.observeAppMessage(started('next-turn', {}, 'thread-next'))
  assert.equal(session.activeTurnId, 'next-turn')
  session.observeAppMessage(completed('next-turn', 'thread-next'))
  assert.equal(idleSnapshot(session).idle, true)
})

test('unloading a review discards its identity before the next turn', async () => {
  const session = await controller()
  session.log = () => {}
  session.observeAppMessage(entered('review-root'))
  session.observeAppMessage(started('review-inner', { rootTurnId: 'review-root' }))
  session.observeAppMessage({ method: 'thread/closed', params: { threadId: 'thread-review' } })
  session.observeAppMessage(started('next-turn'))
  assert.equal(session.activeTurnId, 'next-turn')
})

test('a new root turn is not relabeled by a previous review marker', async () => {
  const session = await controller()
  session.observeAppMessage(entered('previous-review'))
  session.observeAppMessage(started('new-turn', { rootTurnId: 'new-turn' }))
  assert.equal(session.activeTurnId, 'new-turn')
})

test('a review completion clears its marker even without an inner start', async () => {
  const session = await controller()
  session.observeAppMessage(entered('review-root'))
  session.observeAppMessage(completed('review-root'))
  session.observeAppMessage(started('next-turn'))
  assert.equal(session.activeTurnId, 'next-turn')
})
