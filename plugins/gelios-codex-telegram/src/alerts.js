// Telegram typing and alerts for the whole Codex turn: typing while the bound conversation's root turn runs,
// a notice when a running turn shows no activity for stuckMinutes (10 unless set), a notice to the owner when
// the session shows none for idleMinutes (45 unless set), and one notice per run of lasting turn failures.
// Each episode gets one recovery notice. The clocks read the native turn activity record (turn-activity.js):
// the stuck clock its progressAt, which user input never moves, and the idle clock progress and input alike.
// Polling, typing pulses and retry waits are not activity. The rules follow AXEG0/claude-telegram's typing.ts,
// alerts.ts and failures.ts; its hook files are replaced by the app-server's own notifications.
//
// Notices are journaled in runtime.json under `alerts` before they are sent, in order per destination, and a
// restarted bridge sends what is still pending, marked with the time it was observed. A lost Telegram answer
// is sent again, so a notice can arrive twice; none is promised exactly once. The bridge holds this state in
// memory and writes it only when it changes, so a tick never reads the journal.
export const TICK_MS = 4000, STUCK_MINUTES = 10, IDLE_MINUTES = 45, ALERTS_VERSION = 1
const MAX_NOTICES = 256, LATE_MS = 60_000, MAX_WAIT_MS = 60_000
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const iso = at => new Date(at).toISOString()
export const duration = ms => { const m = Math.round(ms / 60_000); return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} seconds` : m === 1 ? '1 minute' : `${m} minutes` }
// A long command or tool reports nothing between its start and its end, so silence never means it ended.
export const TEXTS = {
  stuck: ms => `⚠️ No activity observed in this Codex turn for ${duration(ms)}. A long command or tool reports nothing until it ends, so this does not mean the work finished or stopped. Typing has paused.`,
  stuckRecovered: '✅ Back to normal: Codex activity was observed again.',
  idle: ms => `⚠️ No activity observed in this Codex session for ${duration(ms)}: no turn, tool, subagent work or input. It may be stuck.`,
  idleRecovered: '✅ Back to normal: the Codex session is active again.',
  failureTail: 'You will get a message here when a Codex turn completes again.',
  failureRecovered: '✅ Back to normal: a Codex turn completed again.',
}
const minutes = (value, fallback) => Number.isFinite(value) && value > 0 && value <= 10_080 ? value : fallback
// The owner's monitoring settings in config.json; a value the controller would refuse falls back to the default.
export function monitorSettings(config = {}) {
  return { stuckMs: minutes(config.stuckMinutes, STUCK_MINUTES) * 60_000, idleMs: minutes(config.idleMinutes, IDLE_MINUTES) * 60_000,
    alertChat: typeof config.alertChat === 'string' && /^[1-9][0-9]*$/.test(config.alertChat) ? config.alertChat : null }
}
// The journal in any supported version; a newer or damaged one is refused, never reset.
export function alertsOf(runtime) {
  const value = runtime.alerts
  if (value === undefined) return { version: ALERTS_VERSION, sequence: 0, notices: [], episodes: {}, streak: null }
  if (!plain(value) || !Number.isInteger(value.version) || value.version < 1) throw new Error('alert journal is corrupt; refusing to continue')
  if (value.version > ALERTS_VERSION) throw new Error(`alert journal version ${value.version} is newer than this build reads (${ALERTS_VERSION}); refusing to continue`)
  const routed = item => plain(item) && /^-?[1-9][0-9]*$/.test(item.chatId)
  if (!Number.isInteger(value.sequence) || !Array.isArray(value.notices) || !value.notices.every(item => routed(item) && typeof item.text === 'string' && Number.isFinite(item.observedAt)
    && (item.replyTo === undefined || /^[0-9]+$/.test(item.replyTo)))
    || !plain(value.episodes) || !Object.values(value.episodes).every(item => routed(item) && Number.isFinite(item.alertedAt) && (item.kind === 'idle' || Array.isArray(item.routes)))
    || (value.streak !== null && !(plain(value.streak) && Array.isArray(value.streak.notified) && value.streak.notified.every(routed)))) throw new Error('alert journal is corrupt; refusing to continue')
  return value
}
const destKey = item => `${item.chatId}:${item.threadId || ''}`
const routeOf = item => ({ chatId: item.chatId, ...(item.threadId ? { threadId: item.threadId } : {}), ...(item.owner ? { owner: true } : {}) })

// typing: routes(), start(chatId, threadId), stop(chatId, threadId), pause(held), lastPrivateChat(). route(chatId,
// threadId) names where a notice about that route goes (the owner for a paired bot's chat), or null; owner() is
// the owner's validated chat; pollOwner() whether this bridge polls the bot with no conflict since its last poll.
// send(notice) throws an error with permanent, code and retryAfterMs as Telegram or the policy answered.
export class Monitor {
  constructor({ activity, typing, settings, route, owner, pollOwner, send, journal, now = Date.now, log = () => {} }) {
    Object.assign(this, { activity, typing, settings, route, owner, pollOwner, send, journal, now, log })
    this.state = structuredClone(journal.load()); this.delivering = null; this.timer = null
  }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick(), TICK_MS); this.timer.unref?.() } void this.deliver() }
  stop() { clearInterval(this.timer); this.timer = null }
  save() { try { this.journal.save(this.state) } catch (error) { this.log(`alerts: could not journal: ${error.message}`) } }
  queue(route, kind, text) {
    const notices = this.state.notices
    notices.push({ id: ++this.state.sequence, kind, ...routeOf(route), ...(route.replyTo ? { replyTo: String(route.replyTo) } : {}), text, observedAt: this.now() })
    for (const dropped of notices.splice(0, Math.max(0, notices.length - MAX_NOTICES))) this.log(`alerts: ${dropped.kind} notice to ${dropped.chatId} dropped: more than ${MAX_NOTICES} pending`)
  }
  // A root turn's start types into its Telegram inputs' chats, or, with none, the last admitted private chat this
  // bridge saw. Its end, or its conversation's unload, stops all typing; a subagent never starts or extends it. A wait
  // on the user pauses typing from the fact that begins it to the one that ends it; the tick only repeats that.
  onFact(fact) {
    this.typing.pause(Boolean(this.activity.waiting))
    if (fact.scope !== 'root') return
    if (fact.kind === 'turnStarted' && ![...this.typing.routes()].length && this.typing.lastPrivateChat()) this.typing.start(this.typing.lastPrivateChat())
    if (fact.kind === 'turnCompleted' || fact.kind === 'threadClosed' || (fact.kind === 'threadStatus' && fact.status === 'notLoaded')) for (const route of [...this.typing.routes()]) this.typing.stop(route.chatId, route.threadId || '')
  }
  tick() {
    const now = this.now(), activity = this.activity, clocks = activity.clocks, turn = activity.turn, waiting = Boolean(activity.waiting)
    const { stuckMs, idleMs } = this.settings(), routes = [...this.typing.routes()], episodes = this.state.episodes
    let changed = false
    this.typing.pause(waiting)
    // Typing for input that started no turn ends quietly after the stuck limit.
    if (!turn) for (const route of routes) if (now - route.began >= stuckMs) this.typing.stop(route.chatId, route.threadId || '')
    for (const [key, episode] of Object.entries(episodes)) {
      const since = episode.kind === 'idle' ? Math.max(clocks.progressAt ?? 0, clocks.inputAt ?? 0) : Math.max(clocks.progressAt ?? 0, clocks.turnEndedAt ?? 0)
      if (since <= episode.alertedAt) continue
      delete episodes[key]; changed = true
      if (!episode.stopped) this.queue(episode, `${episode.kind}Recovered`, TEXTS[`${episode.kind}Recovered`])
      if (episode.kind === 'stuck' && turn) for (const route of episode.routes || []) this.typing.start(route.chatId, route.threadId)
    }
    // Stuck: the root turn's silence, measured from its start, its last progress or the end of a wait, never from
    // input, so a message steered into a silent turn neither delays nor restarts its notice.
    if (turn && !waiting && now - Math.max(turn.startedAt ?? turn.seenAt, clocks.progressAt ?? 0, clocks.waitEndedAt ?? 0) >= stuckMs) {
      for (const route of routes) {
        this.typing.stop(route.chatId, route.threadId || '')
        const to = this.route(route.chatId, route.threadId); if (!to) continue
        const key = `stuck:${destKey(to)}`, episode = episodes[key], own = { chatId: route.chatId, ...(route.threadId ? { threadId: route.threadId } : {}) }
        if (episode) { if (!episode.routes.some(item => destKey(item) === destKey(own))) { episode.routes.push(own); changed = true } continue }
        episodes[key] = { kind: 'stuck', ...routeOf(to), alertedAt: now, routes: [own] }; changed = true
        this.queue(to, 'stuck', TEXTS.stuck(stuckMs))
      }
    }
    // Idle: no progress or input since the later of this bridge's start and the end of a wait. Only the poll owner
    // alerts, and only to an owner the policy still admits.
    if (!episodes.idle && !waiting && now - Math.max(clocks.startedAt, clocks.progressAt ?? 0, clocks.inputAt ?? 0, clocks.waitEndedAt ?? 0) >= idleMs && this.pollOwner()) {
      const owner = this.owner()
      if (owner) { episodes.idle = { kind: 'idle', ...routeOf(owner), alertedAt: now }; changed = true; this.queue(owner, 'idle', TEXTS.idle(idleMs)) }
    }
    if (changed) this.save()
    void this.deliver()
  }
  // A lasting failure: one notice per destination per run of failures, replying to the route's replyTo message. Its later
  // recovery replaces a stuck episode's.
  failure(routes, text) {
    for (const route of routes) {
      const to = this.route(route.chatId, route.threadId); if (!to) continue
      delete this.state.episodes[`stuck:${destKey(to)}`]
      const streak = this.state.streak ||= { since: this.now(), notified: [] }
      if (streak.notified.some(item => destKey(item) === destKey(to))) continue
      // It replies to the route's message only in that route's own chat, never in the owner's chat it was moved to.
      streak.notified.push(routeOf(to)); this.queue({ ...to, ...(!to.owner && route.replyTo ? { replyTo: route.replyTo } : {}) }, 'failure', text)
    }
    this.save(); void this.deliver()
  }
  // A root turn that completed with a model answer closes the run: each destination told gets one recovery, after its notice.
  answered() {
    const streak = this.state.streak; if (!streak) return
    for (const to of streak.notified) if (!to.stopped) this.queue(to, 'failureRecovered', TEXTS.failureRecovered)
    this.state.streak = null; this.save(); void this.deliver()
  }
  // One delivery at a time; each destination's notices go in order, and one not yet sent holds the rest.
  deliver() {
    if (this.delivering) return this.delivering
    this.delivering = (async () => {
      // Notices queued meanwhile are taken in the same pass.
      const blocked = new Set(), tried = new Set()
      for (let notice; (notice = this.state.notices.find(item => !tried.has(item) && !blocked.has(destKey(item))));) {
        tried.add(notice)
        if ((notice.retryAt ?? 0) > this.now() || !(await this.attempt(notice))) blocked.add(destKey(notice))
      }
    })().catch(error => this.log(`alerts: delivery failed: ${error.message}`)).finally(() => { this.delivering = null })
    return this.delivering
  }
  async attempt(notice) {
    const now = this.now(), late = now - notice.observedAt >= LATE_MS ? `\n\n(Observed at ${iso(notice.observedAt)}; this notice was delayed.)` : ''
    try {
      await this.send({ ...routeOf(notice), ...(notice.replyTo ? { replyTo: notice.replyTo } : {}), text: `${notice.text}${late}` })
      this.state.notices = this.state.notices.filter(item => item !== notice)
      this.log(`alerts: ${notice.kind} notice to ${destKey(notice)} accepted`); this.save()
      return true
    } catch (error) {
      if (error.permanent || error.code === 400 || error.code === 403) {
        // A destination the policy or Telegram refuses for good (400: no such chat or topic; 403: blocked or removed)
        // stops: its pending notices go, and its open episodes and run entry stay, marked stopped, so it is neither
        // told again in the same episode nor sent a recovery. A bad token (401, 404) refuses every chat, and waits.
        const key = destKey(notice), mine = item => destKey(item) === key
        this.state.notices = this.state.notices.filter(item => !mine(item))
        for (const item of [...Object.values(this.state.episodes), ...(this.state.streak?.notified || [])]) if (mine(item)) item.stopped = true
        this.log(`alerts: ${notice.kind} notice to ${key} refused; that destination stops: ${error.message}`)
      } else {
        notice.tries = (notice.tries || 0) + 1
        notice.retryAt = now + (error.code === 429 && error.retryAfterMs > 0 ? error.retryAfterMs : Math.min(TICK_MS * 2 ** (notice.tries - 1), MAX_WAIT_MS))
        this.log(`alerts: ${notice.kind} notice to ${destKey(notice)} not sent (${error.message}); retry ${notice.tries} at ${iso(notice.retryAt)}`)
      }
      this.save()
      return false
    }
  }
  status() {
    const { stuckMs, idleMs, alertChat } = this.settings(), state = this.state
    return { stuckMinutes: stuckMs / 60_000, idleMinutes: idleMs / 60_000, alertChat, owner: Boolean(this.owner()),
      typing: [...this.typing.routes()].map(route => ({ chatId: route.chatId, ...(route.threadId ? { threadId: route.threadId } : {}), since: iso(route.began) })),
      episodes: Object.values(state.episodes).map(item => ({ kind: item.kind, ...routeOf(item), alertedAt: iso(item.alertedAt) })),
      pendingNotices: state.notices.map(item => ({ kind: item.kind, ...routeOf(item), observedAt: iso(item.observedAt), tries: item.tries || 0 })),
      failureRun: state.streak ? { since: iso(state.streak.since), notified: state.streak.notified.map(routeOf) } : null }
  }
}
