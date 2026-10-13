import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { atomicWriteJson, readJson } from './core.js'
import { isTurnStateRace } from './session.js'

const defaults = () => ({ version: 1, enabled: false, intervalMs: null, prompt: null, generation: null, nextDueAt: null, pending: null })
export class HeartbeatScheduler {
  constructor({ store, enqueue, canRun, threadId, ensureThread, readThread, startTurn, log, now = Date.now }) {
    Object.assign(this, { store, enqueue, canRun, threadId, ensureThread, readThread, startTurn, log, now })
    this.path = join(store.dir, 'heartbeat.json')
    this.state = readJson(this.path, defaults(), 'heartbeat state')
    this.inFlight = false; this.timer = null; this.retryUntil = 0; this.retryAttempt = 0
    this.validate(this.state)
  }
  validate(state) {
    if (state.version !== 1 || typeof state.enabled !== 'boolean') throw new Error('invalid heartbeat state')
    if (state.enabled && (!Number.isSafeInteger(state.intervalMs) || state.intervalMs < 1000 || state.intervalMs > 365 * 86400_000 ||
        typeof state.prompt !== 'string' || !state.prompt.trim() || state.prompt.length > 16_384)) throw new Error('heartbeat requires a cadence from 1s to 365d and a nonempty prompt of at most 16384 characters')
    if (state.enabled && (!/^[a-f0-9]{24}$/.test(state.generation || '') || !Number.isSafeInteger(state.nextDueAt))) throw new Error('invalid heartbeat schedule')
    if (state.pending && (typeof state.pending.eventId !== 'string' || typeof state.pending.threadId !== 'string' || !Number.isSafeInteger(state.pending.dueAt) || typeof state.pending.prompt !== 'string')) throw new Error('invalid pending heartbeat')
  }
  save() { atomicWriteJson(this.path, this.state) }
  status() { return structuredClone(this.state) }
  configure({ enabled, intervalMs, prompt }) {
    const state = { ...this.state, enabled, generation: randomBytes(12).toString('hex'), pending: null,
      ...(intervalMs !== undefined ? { intervalMs } : {}), ...(prompt !== undefined ? { prompt } : {}) }
    state.nextDueAt = enabled ? this.now() + state.intervalMs : null
    this.validate(state)
    if (this.state.pending) this.store.markEvent(this.state.pending.eventId, 'cancelled', { payload: null, retryable: false, reason: 'heartbeat configuration changed' })
    this.state = state; this.retryUntil = 0; this.retryAttempt = 0
    this.save()
    this.log(`heartbeat state=${enabled ? 'enabled' : 'disabled'} cadence_ms=${state.intervalMs || 0}`)
    return this.status()
  }
  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 1000); this.timer.unref()
  }
  stop() { clearInterval(this.timer); this.timer = null }
  async tick() {
    if (!this.state.enabled || this.inFlight || this.now() < this.state.nextDueAt || this.now() < this.retryUntil || !this.canRun()) return
    this.inFlight = true
    try { await this.enqueue(() => this.deliver()) }
    catch (error) {
      this.retryUntil = this.now() + Math.min(1000 * 2 ** this.retryAttempt++, 60_000)
      this.log(`heartbeat state=${isTurnStateRace(error) ? 'deferred' : 'failed'} error=${error.message}`)
    }
    finally { this.inFlight = false }
  }
  async deliver() {
    if (!this.state.enabled || !this.canRun()) return false
    let pending = this.state.pending
    if (pending) {
      // An interrupted transport can lose a successful response. Reconcile the
      // durable client identity before issuing any replacement request.
      if (pending.threadId === this.threadId()) await this.ensureThread(pending.threadId)
      const result = await this.readThread(pending.threadId)
      const accepted = (result?.thread?.turns || []).some(turn => (turn.items || []).some(item =>
        item.type === 'userMessage' && item.clientId === pending.eventId))
      if (accepted) { this.complete(pending, { reconciled: true }); return true }
      if (pending.threadId !== this.threadId()) {
        this.store.markEvent(pending.eventId, 'cancelled', { payload: null, retryable: false, reason: 'conversation changed before heartbeat delivery' })
        this.state.pending = null; this.save(); pending = null
      }
    }
    const threadId = this.threadId()
    if (!threadId || !this.canRun()) return false
    await this.ensureThread(threadId)
    if (!this.canRun() || this.threadId() !== threadId) return false
    if (!pending) {
      const eventId = `heartbeat-${this.state.generation}-${this.state.nextDueAt}-${threadId}`
      pending = { eventId, threadId, dueAt: this.state.nextDueAt, prompt: this.state.prompt }
      this.store.acceptEvent(eventId, { source: 'Heartbeat', threadId, dueAt: pending.dueAt, payload: pending })
      this.state.pending = pending; this.save()
    }
    if (!this.canRun() || pending.threadId !== this.threadId()) return false
    const input = [{ type: 'text', text: `[Heartbeat | event=${pending.eventId} | scheduled=${new Date(pending.dueAt).toISOString()}]\n${pending.prompt}` }]
    // A heartbeat only starts an idle turn. It never steers, interrupts, forks,
    // or creates a conversation, including when app-server reports a race.
    const result = await this.startTurn({ threadId, input, clientUserMessageId: pending.eventId })
    this.complete(pending, { turnId: result?.turn?.id })
    return true
  }
  complete(pending, details) {
    this.store.markEvent(pending.eventId, 'delivered', { ...details, payload: null, threadId: pending.threadId })
    this.state.pending = null
    this.retryUntil = 0; this.retryAttempt = 0
    this.state.nextDueAt = this.now() + this.state.intervalMs
    this.save()
    this.log(`heartbeat state=delivered event=${pending.eventId} thread=${pending.threadId}${details.reconciled ? ' reconciled=true' : ''}`)
  }
}
