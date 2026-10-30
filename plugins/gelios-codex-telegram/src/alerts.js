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
// A chat Telegram does not classify for a failure notice is asked for LOOKUP_MS from this process's first try, then the
// notice goes to the owner's chat (failures.ts PENDING_MS and firstTry).
const LATE_MS = 60_000, MAX_WAIT_MS = 60_000, LOOKUP_MS = 30_000
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
    || !plain(value.episodes) || !Object.values(value.episodes).every(item => routed(item) && Number.isFinite(item.alertedAt) && ['idle', 'stuck'].includes(item.kind))
    || (value.streak !== null && !(plain(value.streak) && Array.isArray(value.streak.notified) && value.streak.notified.every(routed)))
    || (value.runs !== undefined && !(Array.isArray(value.runs) && value.runs.every(run => plain(run) && Array.isArray(run.notified) && run.notified.every(routed))))) throw new Error('alert journal is corrupt; refusing to continue')
  return value
}
const destKey = item => `${item.chatId}:${item.threadId || ''}`
// Telegram refusing a send for good: any 4xx but a 429, a bad token (401) and no such chat (400, 404) included, as the
// reference's failures.ts ends a chat's messages on one.
const refused = error => error.permanent || (error.code >= 400 && error.code < 500 && error.code !== 429)
const routeOf = item => ({ chatId: item.chatId, ...(item.threadId ? { threadId: item.threadId } : {}), ...(item.owner ? { owner: true } : {}) })

// typing: routes(), start(chatId, threadId), stop(chatId, threadId), pause(held), lastPrivateChat(). route(chatId,
// threadId, { ask }) resolves where a notice about that route goes (the owner for a bot's chat), or null; it asks Telegram
// unless ask is false, when it reads only pinned usernames and what Telegram already said, and with ask it rejects when
// Telegram cannot say whether the chat is a bot's; owner() resolves the owner's validated chat or null;
// pollOwner() whether this bridge polls the bot with no conflict since its last poll. send(notice) throws an error with
// permanent, code and retryAfterMs as Telegram or the policy answered. Nothing here rejects: errors are logged.
export class Monitor {
  constructor({ activity, typing, settings, route, owner, pollOwner, send, journal, now = Date.now, log = () => {} }) {
    Object.assign(this, { activity, typing, settings, route, owner, pollOwner, send, journal, now, log })
    this.state = structuredClone(journal.load()); this.delivering = null; this.timer = null; this.ticking = null; this.busy = new Set()
    this.firstTry = new WeakMap()
  }
  // Routing waits on Telegram, so a tick and a failure run as tracked work; settle() waits for all of it and delivery.
  track(work) { const done = work.catch(error => this.log(`alerts: ${error.message}`)).finally(() => this.busy.delete(done)); this.busy.add(done); return done }
  async settle() { for (let work; (work = [...this.busy, this.delivering].filter(Boolean)).length;) await Promise.all(work) }
  // A failure notice's destination: null when the policy admits none; undefined while Telegram has not said whether the
  // chat is a bot's, whatever it answered, so it is asked again until LOOKUP_MS, and then fallback() applies.
  async destination(chatId, threadId) {
    try { return await this.route(chatId, threadId) } catch (error) { this.log(`alerts: no notice about chat ${chatId} yet: ${error.message}`); return undefined }
  }
  // The owner's chat, from alertChat, for a notice about a chat Telegram did not classify in time; none without it.
  fallback(chatId) {
    const { alertChat } = this.settings()
    this.log(`alerts: Telegram did not classify chat ${chatId} in ${LOOKUP_MS / 1000} s; its notice goes to ${alertChat ? 'the owner\'s chat' : 'nobody, with no alertChat'}`)
    return alertChat ? { chatId: alertChat, owner: true } : null
  }
  async ownerOrNull() { try { return await this.owner() } catch (error) { this.log(`alerts: the owner's chat is unconfirmed: ${error.message}`); return null } }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick(), TICK_MS); this.timer.unref?.() } void this.deliver() }
  stop() { clearInterval(this.timer); this.timer = null }
  save() { try { this.journal.save(this.state) } catch (error) { this.log(`alerts: could not journal: ${error.message}`) } }
  // extra carries unclassified with ownerText for a chat Telegram has not classified yet. Every notice stays until it is
  // sent or its destination stops, with no bound, as in the reference.
  queue(route, kind, text, extra = {}) {
    this.state.notices.push({ kind, ...routeOf(route), ...(route.replyTo ? { replyTo: String(route.replyTo) } : {}), ...extra, text, observedAt: this.now() })
  }
  // A root turn types into its Telegram inputs' chats, and the tick adds the last admitted private chat. Its end, or its
  // conversation's unload, stops all typing; a subagent never starts or extends it. A wait on the user pauses typing
  // from the fact that begins it to the one that ends it; the tick only repeats that.
  onFact(fact) {
    this.typing.pause(Boolean(this.activity.waiting))
    if (fact.scope !== 'root') return
    if (fact.kind === 'turnCompleted' || fact.kind === 'threadClosed' || (fact.kind === 'threadStatus' && fact.status === 'notLoaded')) for (const route of [...this.typing.routes()]) this.typing.stop(route.chatId, route.threadId || '')
  }
  tick() {
    if (!this.ticking) this.ticking = this.track(this.step()).finally(() => { this.ticking = null })
    return this.ticking
  }
  async step() {
    const now = this.now(), activity = this.activity, clocks = activity.clocks, turn = activity.turn, waiting = Boolean(activity.waiting)
    const { stuckMs, idleMs } = this.settings(), episodes = this.state.episodes
    let changed = false
    this.typing.pause(waiting)
    // Typing for input that started no turn ends quietly after the stuck limit.
    if (!turn) for (const route of [...this.typing.routes()]) if (now - route.began >= stuckMs) this.typing.stop(route.chatId, route.threadId || '')
    for (const [key, episode] of Object.entries(episodes)) {
      const since = episode.kind === 'idle' ? Math.max(clocks.progressAt ?? 0, clocks.inputAt ?? 0) : Math.max(clocks.progressAt ?? 0, clocks.turnEndedAt ?? 0)
      if (since <= episode.alertedAt) continue
      delete episodes[key]; changed = true
      if (!episode.stopped) this.queue(episode, `${episode.kind}Recovered`, TEXTS[`${episode.kind}Recovered`])
    }
    if (changed) this.save()
    // While the root turn works with root activity inside the stuck limit, the last admitted private chat types, whether
    // other chats do or not, as the reference's typing.ts does on each tick. A turn past the stuck limit stops it below.
    const last = this.typing.lastPrivateChat()
    if (turn && last && now - (clocks.rootActivityAt ?? -Infinity) < stuckMs && ![...this.typing.routes()].some(route => route.chatId === last && !route.threadId)) this.typing.start(last)
    // Stuck: the root turn's silence, measured from its start, its last progress or the end of a wait, never from
    // input, so a message steered into a silent turn neither delays nor restarts its notice. Each route goes to its chat,
    // or to the owner for a pinned bot or a chat Telegram already called a bot's, with no lookup, as the reference's
    // noticeChat reads its cache.
    const stuck = () => { const open = this.activity.turn
      return open && !this.activity.waiting && this.now() - Math.max(open.startedAt ?? open.seenAt, clocks.progressAt ?? 0, clocks.waitEndedAt ?? 0) >= stuckMs }
    if (stuck()) {
      const routes = [...this.typing.routes()], targets = await Promise.all(routes.map(route => this.route(route.chatId, route.threadId, { ask: false })))
      if (stuck()) for (const [index, route] of routes.entries()) {
        const to = targets[index]
        this.typing.stop(route.chatId, route.threadId || ''); if (!to) continue
        const key = `stuck:${destKey(to)}`; if (episodes[key]) continue
        episodes[key] = { kind: 'stuck', ...routeOf(to), alertedAt: this.now() }; this.queue(to, 'stuck', TEXTS.stuck(stuckMs)); this.save()
      }
    }
    // Idle: no progress or input since the later of this bridge's start and the end of a wait. Only the poll owner
    // alerts, and only to an owner the policy and Telegram still admit.
    const idle = () => !episodes.idle && !this.activity.waiting && this.pollOwner()
      && this.now() - Math.max(clocks.startedAt, clocks.progressAt ?? 0, clocks.inputAt ?? 0, clocks.waitEndedAt ?? 0) >= idleMs
    if (idle()) {
      const owner = await this.ownerOrNull()
      if (owner && idle()) { episodes.idle = { kind: 'idle', ...routeOf(owner), alertedAt: this.now() }; this.queue(owner, 'idle', TEXTS.idle(idleMs)); this.save() }
    }
    void this.deliver()
  }
  // A lasting failure: one notice per destination per run of failures, replying to the route's replyTo message. Its later
  // recovery replaces a stuck episode's. text(about) words it: about is null in the route's own chat, or the chat ID a
  // notice moved to the owner is about. A chat Telegram has not classified yet is journaled against itself, marked
  // unclassified, and classified when sent (classify): Telegram's answer within LOOKUP_MS, or else fallback().
  failure(routes, text) { return this.track(this.fail(routes, text)) }
  async fail(routes, text) {
    const targets = []
    for (const route of routes) targets.push([route, await this.destination(route.chatId, route.threadId)])
    for (const [route, resolved] of targets) {
      const unclassified = resolved === undefined
      const to = unclassified ? { chatId: String(route.chatId), ...(route.threadId ? { threadId: String(route.threadId) } : {}) } : resolved
      if (!to) continue
      delete this.state.episodes[`stuck:${destKey(to)}`]
      const streak = this.state.streak ||= { id: ++this.state.sequence, since: this.now(), notified: [] }
      if (streak.notified.some(item => destKey(item) === destKey(to))) continue
      // It replies to the route's message only in that route's own chat, never in the owner's chat it was moved to.
      const moved = Boolean(to.owner) && to.chatId !== route.chatId
      this.queue({ ...to, ...(!moved && route.replyTo ? { replyTo: route.replyTo } : {}) }, 'failure', text(moved ? route.chatId : null),
        { run: streak.id, ...(unclassified ? { unclassified: true, ownerText: text(route.chatId) } : {}) })
      streak.notified.push({ ...routeOf(to), ...(unclassified ? { unclassified: true } : {}) })
    }
    this.save(); void this.deliver()
  }
  // An unclassified chat's destination is known (Telegram's answer, or fallback() after LOOKUP_MS): its pending notices
  // and run entry go where a classified chat's would, to the chat itself or, for a bot's, to the owner by name. With no
  // destination, or an owner already told in the notice's run, open or closed, they go. It returns whether the notice
  // is still to be sent.
  classify(notice, to) {
    const key = destKey(notice), unclassified = item => item.unclassified && destKey(item) === key, mine = item => unclassified(item) && item.run === notice.run
    const run = this.state.streak?.id === notice.run ? this.state.streak : (this.state.runs || []).find(item => item.id === notice.run)
    const entry = run?.notified.find(unclassified), moved = Boolean(to?.owner) && to.chatId !== notice.chatId
    if (!to || (moved && run?.notified.some(item => item !== entry && destKey(item) === destKey(to)))) {
      this.state.notices = this.state.notices.filter(item => !mine(item))
      if (entry) run.notified = run.notified.filter(item => item !== entry)
      this.log(`alerts: notices about chat ${notice.chatId} dropped: ${to ? 'the owner was already told in their run' : 'no destination admits them'}`)
    } else for (const item of [...this.state.notices.filter(mine), ...(entry ? [entry] : [])]) {
      if (moved) { item.chatId = to.chatId; delete item.threadId; item.owner = true; delete item.replyTo; if (item.ownerText) item.text = item.ownerText }
      delete item.unclassified; delete item.ownerText
    }
    this.pruneRuns(); this.save()
    return this.state.notices.includes(notice)
  }
  // A closed run is kept only while one of its entries is unclassified, for classify's once-per-run check.
  pruneRuns() { if (this.state.runs) { this.state.runs = this.state.runs.filter(run => run.notified.some(item => item.unclassified)); if (!this.state.runs.length) delete this.state.runs } }
  // A root turn that completed with a model answer closes the run: each destination told gets one recovery, after its notice.
  answered() {
    const streak = this.state.streak; if (!streak) return
    for (const to of streak.notified) if (!to.stopped) this.queue(to, 'failureRecovered', TEXTS.failureRecovered, { run: streak.id, ...(to.unclassified ? { unclassified: true } : {}) })
    if (streak.notified.some(item => item.unclassified)) this.state.runs = [...(this.state.runs || []), streak]
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
      // An unclassified chat is classified first. A lookup Telegram does not answer, or refuses, is asked again until
      // LOOKUP_MS from this process's first try, and then the notice goes to the owner's chat, as the reference's
      // failures.ts does; after a restart the window starts again. observedAt stays for the delayed line.
      if (notice.unclassified) {
        if (!this.firstTry.has(notice)) this.firstTry.set(notice, now)
        const to = await this.route(notice.chatId, notice.threadId).catch(error => {
          if (now - this.firstTry.get(notice) < LOOKUP_MS) throw error
          return this.fallback(notice.chatId)
        })
        if (!this.classify(notice, to)) return true
      }
      await this.send({ ...routeOf(notice), ...(notice.replyTo ? { replyTo: notice.replyTo } : {}), text: `${notice.text}${late}` })
      this.state.notices = this.state.notices.filter(item => item !== notice)
      this.log(`alerts: ${notice.kind} notice to ${destKey(notice)} accepted`); this.save()
      return true
    } catch (error) {
      // Telegram refusing a reply target (a deleted message in a group) never costs the notice: it goes again at once,
      // replying to nothing. A 400 on that send then stops the destination.
      if (error.code === 400 && notice.replyTo && !error.permanent && !error.lookup && !notice.unclassified) {
        delete notice.replyTo; this.log(`alerts: ${notice.kind} notice to ${destKey(notice)} refused its reply target; sending it without one`)
        return this.attempt(notice)
      }
      if (notice.unclassified) {
        notice.tries = (notice.tries || 0) + 1
        notice.retryAt = Math.min(now + Math.min(TICK_MS * 2 ** (notice.tries - 1), MAX_WAIT_MS), this.firstTry.get(notice) + LOOKUP_MS)
        this.log(`alerts: ${notice.kind} notice about chat ${notice.chatId} waits for Telegram to classify it (${error.message}); next try at ${iso(notice.retryAt)}`)
      } else if (refused(error)) {
        // A destination the policy or Telegram refuses for good (any 4xx but a 429) stops: its pending notices go, and
        // its open episodes and run entry stay, marked stopped, so it is neither told again in the same episode nor sent
        // a recovery. An unclassified chat's own notice is ahead of any other to it, so no refused entry is unclassified.
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
    return { stuckMinutes: stuckMs / 60_000, idleMinutes: idleMs / 60_000, alertChat,
      typing: [...this.typing.routes()].map(route => ({ chatId: route.chatId, ...(route.threadId ? { threadId: route.threadId } : {}), since: iso(route.began) })),
      episodes: Object.values(state.episodes).map(item => ({ kind: item.kind, ...routeOf(item), alertedAt: iso(item.alertedAt) })),
      pendingNotices: state.notices.map(item => ({ kind: item.kind, ...routeOf(item), observedAt: iso(item.observedAt), tries: item.tries || 0 })),
      failureRun: state.streak ? { since: iso(state.streak.since), notified: state.streak.notified.map(routeOf) } : null }
  }
}
