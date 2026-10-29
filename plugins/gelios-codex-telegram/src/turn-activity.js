// Native turn activity: the facts that typing and alerts need, read from the Codex app-server's own
// notifications. Each thread, turn, item and hook notification becomes one fact that keeps its IDs, the
// order in which the bridge received it, and the app-server's emission time when the host sends one.
// The tracker follows the bound (root) conversation's turn and the subagent threads it spawned, at any depth.
//
// It only observes. It sends no request, so it never resumes a thread or starts a turn to watch a child,
// and it records no outcome the host did not report: a turn whose thread unloads first ends with an
// unknown status. What counts as activity follows the busy, subagent and turn-end hooks of
// AXEG0/claude-telegram (prompts, each tool call's start and end, subagent work, turn ends); here that is
// the start and end of a native turn, item or hook. Deltas, repeated running states, retry notices and
// token counts are not progress.

const LIFECYCLE = new Map([['turn/started', 'turnStarted'], ['turn/completed', 'turnCompleted'],
  ['item/started', 'itemStarted'], ['item/completed', 'itemCompleted'], ['hook/started', 'hookStarted'], ['hook/completed', 'hookCompleted']])
const STATE = new Map([['thread/started', 'threadStarted'], ['thread/status/changed', 'threadStatus'], ['thread/closed', 'threadClosed'], ['error', 'error']])
// A thread the host reports gone or broken ends what was running in it; an idle status does not, since
// the host reports idle just before the turn's own completion.
const ENDING_STATUS = new Set(['notLoaded', 'systemError'])
const LIMITS = { links: 512, unattributed: 64, openItems: 64, running: 256, depth: 32 }

// codexErrorInfo is a bare name ("serverOverloaded") or a one-key object ({ "httpConnectionFailed": { ... } }).
export function turnErrorKind(error) {
  const info = error?.codexErrorInfo
  if (typeof info === 'string') return info
  if (info && typeof info === 'object' && !Array.isArray(info)) return Object.keys(info)[0] || null
  return null
}
const id = value => typeof value === 'string' && value ? value : null
const iso = at => Number.isFinite(at) ? new Date(at).toISOString() : null
// Re-inserting moves a key to the newest end, so the oldest entry is the first one dropped.
function remember(map, key, value, limit) {
  map.delete(key); map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value)
}

export class TurnActivity {
  constructor({ now = Date.now } = {}) {
    this.now = now
    this.sequence = 0
    this.rootThreadId = null
    this.turn = null; this.lastTurn = null; this.waiting = null; this.openItems = new Map()
    // parents: child thread -> the thread that spawned it. running: descendant thread -> its open turn.
    // unattributed: threads not yet linked to the root with work running, held until a spawn record links them
    // or that work ends.
    this.parents = new Map(); this.running = new Map(); this.unattributed = new Map()
    // A new bridge's clocks start at its own startup, never at an earlier instance's timestamps.
    const startedAt = now()
    this.clocks = { startedAt, lastActivityAt: startedAt, rootActivityAt: null, descendantActivityAt: null, turnEndedAt: null }
  }
  // Returns the normalized fact for a thread, turn, item, hook or error notification, or null for any other message.
  observe(message, rootThreadId = null) {
    const method = message?.method
    const kind = LIFECYCLE.get(method) || STATE.get(method)
    if (!kind) return null
    const params = message.params || {}
    const threadId = id(params.threadId) || id(params.thread?.id)
    if (!threadId) return null
    this.bind(rootThreadId)
    const item = params.item && typeof params.item === 'object' ? params.item : null
    this.link(id(params.thread?.parentThreadId), id(params.thread?.id))
    if (item?.type === 'collabAgentToolCall' && Array.isArray(item.receiverThreadIds))
      for (const child of item.receiverThreadIds) this.link(id(item.senderThreadId) || threadId, id(child))
    if (item?.type === 'subAgentActivity') this.link(threadId, id(item.agentThreadId))
    const scope = threadId === this.rootThreadId ? 'root' : this.descends(threadId) ? 'descendant' : 'other'
    const fact = {
      sequence: ++this.sequence, at: this.now(), emittedAt: Number.isFinite(message.emittedAtMs) ? message.emittedAtMs : null,
      method, kind, scope, threadId, turnId: id(params.turnId) || id(params.turn?.id),
      itemId: id(item?.id) || id(params.run?.id), itemType: id(item?.type) || (params.run ? 'hook' : null),
      status: id(params.turn?.status) || id(params.status?.type) || id(item?.status) || id(params.run?.status),
      meaningful: LIFECYCLE.has(method) && scope !== 'other',
    }
    if (kind === 'threadStatus') fact.flags = (Array.isArray(params.status?.activeFlags) ? params.status.activeFlags : []).filter(flag => id(flag))
    if (kind === 'turnCompleted') fact.errorKind = turnErrorKind(params.turn?.error)
    if (kind === 'error') fact.willRetry = params.willRetry === true
    if (scope === 'root') this.applyRoot(fact)
    else if (scope === 'descendant') this.applyDescendant(fact)
    else this.hold(fact)
    return fact
  }
  // The bridge calls this when it binds a conversation; observe() checks it again for each notification.
  bind(rootThreadId = null) {
    if ((rootThreadId || null) === this.rootThreadId) return
    // The former root's open turn is held like any unlinked thread's, so binding it again finds it.
    if (this.rootThreadId && this.turn?.id) remember(this.unattributed, this.rootThreadId, { activityAt: this.clocks.rootActivityAt,
      turn: { threadId: this.rootThreadId, turnId: this.turn.id, startedAt: this.turn.startedAt } }, LIMITS.unattributed)
    this.rootThreadId = rootThreadId || null
    this.turn = null; this.lastTurn = null; this.waiting = null; this.openItems.clear()
    Object.assign(this.clocks, { rootActivityAt: null, descendantActivityAt: null, turnEndedAt: null })
    // A turn the new root was already running when it was bound, as far as the host has reported it.
    const held = this.unattributed.get(this.rootThreadId)
    this.unattributed.delete(this.rootThreadId)
    if (held?.turn) this.turn = { id: held.turn.turnId, startedAt: held.turn.startedAt }
    this.credit()
  }
  applyRoot(fact) {
    const { kind, at, turnId, itemId } = fact
    if (kind === 'turnStarted' && turnId) { this.turn = { id: turnId, startedAt: at }; this.openItems.clear() }
    // A conversation bound while its turn already runs: the host's report of work in that turn shows it,
    // though not when it began.
    else if (!this.turn && turnId && (kind === 'itemStarted' || kind === 'hookStarted')) this.turn = { id: turnId, startedAt: null }
    if (kind === 'itemStarted' && itemId) remember(this.openItems, itemId, { id: itemId, type: fact.itemType, startedAt: at }, LIMITS.openItems)
    if (kind === 'itemCompleted' && itemId) this.openItems.delete(itemId)
    if (kind === 'turnCompleted') this.endTurn(turnId, { status: fact.status, errorKind: fact.errorKind, closedBy: null }, at)
    if (kind === 'threadClosed' || (kind === 'threadStatus' && ENDING_STATUS.has(fact.status))) {
      if (this.turn) this.endTurn(this.turn.id, { status: null, errorKind: null, closedBy: kind === 'threadClosed' ? 'threadClosed' : fact.status }, at)
      this.waiting = null
    } else if (kind === 'threadStatus') this.setWaiting(fact.status === 'active' ? fact.flags : [], at)
    if (fact.meaningful) this.clocks.rootActivityAt = this.clocks.lastActivityAt = at
  }
  endTurn(turnId, outcome, at) {
    // A completion of some other turn of this conversation is recorded without ending the one being followed.
    if (this.turn?.id && turnId && this.turn.id !== turnId) { this.lastTurn = { id: turnId, ...outcome, endedAt: at }; return }
    this.lastTurn = { id: turnId || this.turn?.id || null, ...outcome, endedAt: at }
    this.turn = null; this.openItems.clear(); this.waiting = null
    this.clocks.turnEndedAt = at
  }
  // Waiting on approval or user input pauses the clocks in a later stage; this records only what the host reports.
  setWaiting(flags, at) {
    if (!flags.length) { this.waiting = null; return }
    this.waiting = { flags: [...flags], since: this.waiting?.since ?? at }
  }
  applyDescendant(fact) {
    const { kind, at, threadId, turnId } = fact
    if (kind === 'turnStarted') remember(this.running, threadId, { threadId, turnId, startedAt: at }, LIMITS.running)
    else if (!this.running.has(threadId) && turnId && (kind === 'itemStarted' || kind === 'hookStarted'))
      remember(this.running, threadId, { threadId, turnId, startedAt: null }, LIMITS.running)
    if (kind === 'turnCompleted' && (!turnId || !this.running.get(threadId)?.turnId || this.running.get(threadId).turnId === turnId)) this.running.delete(threadId)
    if (kind === 'threadClosed' || (kind === 'threadStatus' && ENDING_STATUS.has(fact.status))) this.running.delete(threadId)
    if (fact.meaningful) this.clocks.descendantActivityAt = this.clocks.lastActivityAt = at
  }
  // A thread not linked to the root may be a subagent whose spawn record has not arrived yet, or an unrelated
  // conversation the terminal opened. Its work counts only once a spawn record links it to the root.
  hold(fact) {
    const { kind, at, threadId, turnId } = fact
    if (kind === 'turnCompleted' || kind === 'threadClosed' || (kind === 'threadStatus' && ENDING_STATUS.has(fact.status))) {
      this.unattributed.delete(threadId); this.running.delete(threadId); return
    }
    if (!LIFECYCLE.has(fact.method)) return
    const held = this.unattributed.get(threadId) || { activityAt: null, turn: null }
    held.activityAt = at
    if (kind === 'turnStarted' || (!held.turn && turnId)) held.turn = { threadId, turnId, startedAt: kind === 'turnStarted' ? at : null }
    remember(this.unattributed, threadId, held, LIMITS.unattributed)
  }
  link(parentId, childId) {
    if (!parentId || !childId || parentId === childId || this.parents.get(childId) === parentId) return
    remember(this.parents, childId, parentId, LIMITS.links)
    this.credit()
  }
  // Work a newly linked subagent did before its spawn record arrived counts at the time it was seen.
  credit() {
    for (const [threadId, held] of this.unattributed) {
      if (!this.descends(threadId)) continue
      this.unattributed.delete(threadId)
      if (held.turn) remember(this.running, threadId, held.turn, LIMITS.running)
      if (held.activityAt !== null) {
        this.clocks.descendantActivityAt = Math.max(this.clocks.descendantActivityAt ?? held.activityAt, held.activityAt)
        this.clocks.lastActivityAt = Math.max(this.clocks.lastActivityAt, held.activityAt)
      }
    }
  }
  descends(threadId) {
    if (!this.rootThreadId) return false
    let current = threadId
    for (let depth = 0; depth < LIMITS.depth; depth += 1) {
      current = this.parents.get(current)
      if (!current) return false
      if (current === this.rootThreadId) return true
    }
    return false
  }
  // Whole-turn activity for status, and later for typing and alerts: the root's open turn and its running subagents.
  snapshot() {
    const running = [...this.running.values()].filter(entry => this.descends(entry.threadId))
    const oldest = this.openItems.values().next().value
    return {
      rootThreadId: this.rootThreadId,
      busy: Boolean(this.turn) || running.length > 0,
      turn: this.turn ? { id: this.turn.id, startedAt: iso(this.turn.startedAt), openItems: this.openItems.size,
        oldestOpenItem: oldest ? { id: oldest.id, type: oldest.type, startedAt: iso(oldest.startedAt) } : null } : null,
      lastTurn: this.lastTurn ? { ...this.lastTurn, endedAt: iso(this.lastTurn.endedAt) } : null,
      waiting: this.waiting ? { flags: [...this.waiting.flags], since: iso(this.waiting.since) } : null,
      descendants: { linked: [...this.parents.keys()].filter(threadId => this.descends(threadId)).length,
        running: running.map(entry => ({ threadId: entry.threadId, turnId: entry.turnId, startedAt: iso(entry.startedAt) })) },
      unattributedThreads: this.unattributed.size,
      clocks: Object.fromEntries(Object.entries(this.clocks).map(([name, at]) => [name, iso(at)])),
      facts: this.sequence,
    }
  }
}
