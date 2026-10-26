import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock, durableJson, trustedFile } from './builds.js'
import { requestControl } from './control.js'
import { bootIdentity, processInfo } from './core.js'
import { runSystemctl, SUPERVISED_START_MS, unitState } from './systemd.js'

export const REPLACEMENT_READY_MS = 20_000
// A waiting caller allows a replacement the time a supervised start may take to answer, then its readiness deadline.
export const REPLACEMENT_WAIT_MS = SUPERVISED_START_MS + REPLACEMENT_READY_MS
export const RESTART_EXIT_CODES = Object.freeze({ completed: 0, failed: 2, cancelled: 3 })
const noJob = status => status.Job === '' || status.Job === '0'
function externalUpdate(stateDir) {
  if (existsSync(join(stateDir, 'update-transaction.json'))) return true
  const directory = join(stateDir, 'update-locks')
  if (!existsSync(directory)) return false
  try {
    const latest = readdirSync(directory).filter(name => /^\d{20}\.lock$/.test(name)).sort().at(-1)
    if (!latest) return false
    const owner = JSON.parse(readFileSync(trustedFile(join(directory, latest), 'update lock'), 'utf8'))
    return !owner.released && owner.pid !== process.pid && owner.bootId === bootIdentity() && processInfo(owner.pid)?.identity === owner.identity
  } catch { return true }
}
export function idleSnapshot(bridge) {
  // runningThreads: app-server threads with a running turn, the bound conversation's subagents included.
  const counts = { runningThreads: bridge.runningThreads?.size || 0, inputs: bridge.pendingHumanInputs || 0, waitingTelegram: bridge.waitingTelegram?.length || 0,
    restoringInputs: bridge.restoreQueue?.length || 0, terminalLaunches: bridge.tuiLaunches?.size || 0,
    pendingControls: bridge.pendingControlIds?.length || 0, runningControls: bridge.runningControls?.size || 0,
    batchedMessages: bridge.batcher?.current?.events?.length || Number(Boolean(bridge.batcher?.pending())),
    ingress: Number(Boolean(bridge.ingressPending)), replies: bridge.telegram?.pendingReplies || 0,
    heartbeat: Number(Boolean(bridge.heartbeat?.inFlight)), requests: (bridge.internal?.size || 0) + (bridge.forwarded?.size || 0) }
  const flags = { notReady: !bridge.appReady, restoring: Boolean(bridge.restoring), turn: Boolean(bridge.activeTurnId),
    turnRetry: Boolean(bridge.turnRetry), tui: Boolean(bridge.tui && !bridge.tui.closed),
    updating: Boolean(bridge.updatePrepared || bridge.checkingBuild), externalUpdate: externalUpdate(bridge.options.stateDir), shuttingDown: Boolean(bridge.shuttingDown) }
  const blockers = Object.entries({ ...flags, ...counts }).filter(([, value]) => Boolean(value)).map(([name]) => name)
  return { idle: blockers.length === 0, blockers, counts, flags, runningThreadIds: [...(bridge.runningThreads || [])] }
}
export function readRestart(stateDir) {
  const path = join(stateDir, 'restart-request.json')
  if (!existsSync(path)) return null
  const info = lstatSync(path)
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid())) throw new Error('restart request must be an owner-only regular file')
  const value = JSON.parse(readFileSync(trustedFile(path, 'restart request'), 'utf8'))
  if (!/^[a-f0-9]{24}$/.test(value.id || '') || !['pending', 'handoff', 'completed', 'cancelled', 'failed'].includes(value.phase) ||
      !Number.isFinite(Date.parse(value.requestedAt)) || !Number.isFinite(Date.parse(value.deadline)) || typeof value.sourceInstance !== 'string') throw new Error('invalid restart request state')
  return value
}
export async function offlineRestartStatus(stateDir, run = runSystemctl) {
  const restart = readRestart(stateDir)
  if (!restart) throw new Error('bridge is unavailable and has no restart request')
  let systemd
  try { systemd = await unitState(restart.unit, run) } catch (error) { return { available: false, restart: { ...restart, reason: error.message } } }
  const failed = systemd.ActiveState === 'failed' || systemd.LoadState !== 'loaded'
  return { available: false, systemd, restart: { ...restart, ...(failed ? { phase: 'failed' } : {}),
    reason: failed ? `systemd start failed: ${systemd.Result || systemd.LoadState}` : `bridge unavailable; unit is ${systemd.ActiveState}` } }
}
// Follows one request to its final phase. Only a phase a bridge wrote ends the wait; an unanswered socket and the unit
// state read in its absence mean still waiting. The requesting bridge settles a pending request by its deadline. Once it
// hands off, it and then systemd's stop job hold the restart, and the replacement gets REPLACEMENT_WAIT_MS after that.
export async function waitForRestart(request, { path, stateDir, control = requestControl, run = runSystemctl, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), intervalMs = 500 }) {
  let last = request, held = now(), answer = 'none'
  for (;;) {
    let record, holding
    try {
      const status = await control(path, 'status', {}, { timeoutMs: 1000 })
      record = status.restart; answer = `bridge ${status.pid} reports ${record?.phase}${status.ready ? '' : ' and is not ready'}`
      holding = status.instanceId === request.sourceInstance && status.pid === request.sourcePid && record?.phase === 'handoff'
    } catch {
      const offline = await offlineRestartStatus(stateDir, run).catch(error => ({ restart: { reason: error.message } }))
      try { record = readRestart(stateDir) } catch { record = undefined }
      answer = offline.restart.reason; holding = offline.systemd?.ActiveState === 'deactivating'
    }
    if (record === null || (record?.id && record.id !== request.id)) throw new Error(`restart request ${request.id} ${record ? `was replaced by ${record.id}` : 'is no longer recorded'}`)
    if (record) last = record
    if (record && Object.hasOwn(RESTART_EXIT_CODES, record.phase)) return { code: RESTART_EXIT_CODES[record.phase], restart: record }
    if (holding) held = now()
    if (now() >= Math.max(Date.parse(request.deadline), held) + REPLACEMENT_WAIT_MS) return { code: RESTART_EXIT_CODES.failed, restart: { ...last,
      phase: 'failed', reason: `no outcome ${REPLACEMENT_WAIT_MS / 1000}s after the request's deadline and the previous bridge's stop; last answer: ${answer}` } }
    await sleep(intervalMs)
  }
}
export class IdleRestart {
  constructor(bridge, { run = runSystemctl, now = Date.now } = {}) {
    Object.assign(this, { bridge, run, now, readyDeadline: now() + REPLACEMENT_READY_MS, timer: null, checking: false, state: null, error: null })
    try { this.state = readRestart(bridge.options.stateDir) } catch (error) { this.error = error.message }
  }
  status() { return this.error ? { phase: 'failed', reason: this.error } : this.state && structuredClone(this.state) }
  pending() { return this.state?.phase === 'pending' }
  save(value) { durableJson(join(this.bridge.options.stateDir, 'restart-request.json'), value); this.state = value; return this.status() }
  async verify(restarting = true) {
    const unit = this.bridge.options.systemdUnit, status = await unitState(unit, this.run)
    if (status.LoadState !== 'loaded' || status.ActiveState !== 'active' || Number(status.MainPID) !== process.pid) throw new Error('the configured systemd unit does not own this running bridge')
    if (restarting && (status.CanStart !== 'yes' || status.CanStop !== 'yes' || status.RefuseManualStop === 'yes')) throw new Error('systemd refuses a restart of this unit')
    return unit
  }
  async request({ timeoutMs }) {
    if (this.error) throw new Error(this.error)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 365 * 86400_000) throw new Error('restart requires a positive timeout of at most 365d')
    if (this.bridge.shuttingDown || this.bridge.updatePrepared) throw new Error('bridge maintenance is already committed')
    const unit = await this.verify()
    if (this.bridge.shuttingDown || this.bridge.updatePrepared) throw new Error('bridge maintenance is already committed')
    if (this.pending()) return this.status()
    const requestedAt = new Date(this.now()).toISOString()
    return this.save({ id: randomBytes(12).toString('hex'), unit, sourceInstance: this.bridge.instanceId, sourcePid: process.pid, sourceIdentity: processInfo(process.pid)?.identity, sourceBoot: bootIdentity(),
      requestedAt, deadline: new Date(this.now() + timeoutMs).toISOString(), phase: 'pending', reason: null })
  }
  cancel(id) {
    if (id !== this.state?.id) throw new Error('restart request ID does not match')
    if (!this.pending()) throw new Error('restart is no longer waiting; cancellation is too late')
    return this.save({ ...this.state, phase: 'cancelled', finishedAt: new Date(this.now()).toISOString() })
  }
  start() { this.timer = setInterval(() => void this.tick().catch(error => this.bridge.log(`idle restart: ${error.message}`)), 200); this.timer.unref() }
  stop() { clearInterval(this.timer); this.timer = null }
  async tick() {
    if (this.checking || this.error || !['pending', 'handoff'].includes(this.state?.phase) || this.bridge.shuttingDown) return
    this.checking = true
    try {
      const b = this.bridge, record = this.state
      if (record.sourceInstance !== b.instanceId || record.sourcePid !== process.pid || record.sourceIdentity !== processInfo(process.pid)?.identity || record.sourceBoot !== bootIdentity()) {
        if (b.appReady && !b.restoring) {
          await this.verify(false)
          const kept = !record.threadId || record.threadId === b.currentThreadId
          this.save({ ...record, phase: kept ? 'completed' : 'failed', reason: kept ? (record.phase === 'pending' ? 'unit restarted before idle handoff' : null) : 'restart did not restore the recorded conversation', finishedAt: new Date(this.now()).toISOString() })
        } else if (this.now() >= this.readyDeadline) {
          this.save({ ...record, phase: 'failed', reason: 'replacement bridge did not restore readiness before its deadline' })
        }
        return
      }
      if (record.phase === 'handoff') {
        const status = await unitState(record.unit, this.run)
        if (status.ActiveState === 'active' && Number(status.MainPID) === process.pid && noJob(status)) {
          this.save({ ...record, phase: 'failed', reason: 'systemd restart job ended without replacing the bridge' }); b.updatePrepared = false; this.releaseUpdate?.(); this.releaseUpdate = null
        }
        return
      }
      const snapshot = idleSnapshot(b)
      if (this.now() >= Date.parse(record.deadline)) {
        this.save({ ...record, phase: 'failed', reason: `idle deadline reached: ${snapshot.blockers.join(', ') || 'systemd handoff pending'}`, finishedAt: new Date(this.now()).toISOString() }); return
      }
      if (!snapshot.idle) return
      await this.verify()
      if (this.state !== record || !idleSnapshot(b).idle) return
      if (this.now() >= Date.parse(record.deadline)) return
      // No await separates the final decision, closing admission and persisting
      // the handoff. All turn producers share updatePrepared at final dispatch.
      let release
      try { release = acquireLock(join(b.options.stateDir, 'update-locks')) }
      catch (error) { if (error.code === 'UPDATE_BUSY') return; throw error }
      if (!idleSnapshot(b).idle) { release(); return }
      this.releaseUpdate = release; b.updatePrepared = true
      try {
        this.save({ ...record, phase: 'handoff', handoffAt: new Date(this.now()).toISOString(), threadId: b.currentThreadId, workspace: b.options.workspace })
        const result = await this.run(['--no-block', '--job-mode=fail', 'restart', record.unit], 5000)
        if (result.code !== 0) {
          const status = await unitState(record.unit, this.run)
          if (status.ActiveState !== 'active' || Number(status.MainPID) !== process.pid || !noJob(status)) throw new Error('systemd restart outcome is unknown; admission remains closed')
          throw Object.assign(new Error(`systemd restart refused: ${result.output || result.code}`), { reopen: true })
        }
      } catch (error) {
        if (this.state.phase === 'pending' || error.reopen) { b.updatePrepared = false; release(); this.releaseUpdate = null }
        this.save({ ...this.state, phase: b.updatePrepared ? 'handoff' : 'failed', reason: error.message })
      }
    } catch (error) { this.save({ ...this.state, phase: this.bridge.updatePrepared ? 'handoff' : 'failed', reason: error.message }) }
    finally { this.checking = false }
  }
}
