import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { isDeepStrictEqual } from 'node:util'
import { StateStore, sourceLabel, logLines } from './core.js'
// The controller owns the native runtime connection and the shared TUI/thread state.
// Transport adapters supply input preparation and lifecycle callbacks, never another runtime.
const YOLO_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork', 'turn/start'])
const THREAD_SELECTION_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork'])
function yoloParams(method, params = {}) {
  // A new bridge-created conversation retains the existing full-access default.
  // Native terminal selections supply their own policy. Resume and subsequent
  // turns inherit that conversation's policy rather than silently elevating it.
  return method === 'thread/start'
    ? { approvalPolicy: 'never', sandbox: 'danger-full-access', ...params }
    : { ...params }
}
function enforceYolo(message) {
  if (!YOLO_METHODS.has(message.method)) return message
  return { ...message, params: yoloParams(message.method, message.params) }
}
function savedPolicyParams(policy) {
  if (!policy) return { approvalPolicy: 'never', sandbox: 'danger-full-access' } // Legacy bridges always used this policy.
  if (policy.activePermissionProfile?.id) return { approvalPolicy: policy.approvalPolicy, permissions: policy.activePermissionProfile.id }
  const modes = { dangerFullAccess: 'danger-full-access', readOnly: 'read-only', workspaceWrite: 'workspace-write' }
  const sandbox = modes[policy.sandboxPolicy?.type]
  if (!sandbox && !policy.activePermissionProfile?.id) throw new Error('Cannot restore the saved native permission profile')
  const result = { approvalPolicy: policy.approvalPolicy, ...(sandbox ? { sandbox } : { permissions: policy.activePermissionProfile.id }) }
  if (sandbox === 'workspace-write') {
    const p = policy.sandboxPolicy
    result.config = { sandbox_workspace_write: { writable_roots: p.writableRoots || [], network_access: p.networkAccess === true,
      exclude_tmpdir_env_var: p.excludeTmpdirEnvVar === true, exclude_slash_tmp: p.excludeSlashTmp === true } }
  }
  return result
}
function emptyResumeChanges(params, saved) {
  const modes = { dangerFullAccess: 'danger-full-access', readOnly: 'read-only', workspaceWrite: 'workspace-write' }
  const known = { model: saved.model, modelProvider: saved.modelProvider, cwd: saved.cwd, serviceTier: saved.serviceTier,
    approvalPolicy: saved.approvalPolicy, sandbox: modes[saved.sandbox?.type], permissions: saved.activePermissionProfile?.id }
  return Object.entries(params).some(([key, value]) => {
    if (value == null || ['threadId', 'excludeTurns', 'initialTurnsPage', 'itemsBackwardsCursor', 'turnsBackwardsCursor'].includes(key)) return false
    if (key === 'config') return Object.entries(value).some(([name, setting]) => !isDeepStrictEqual(setting,
      name === 'model_reasoning_effort' ? saved.reasoningEffort : name === 'sandbox_workspace_write' && saved.sandbox?.type === 'workspaceWrite'
        ? savedPolicyParams({ approvalPolicy: saved.approvalPolicy, sandboxPolicy: saved.sandbox }).config.sandbox_workspace_write : undefined))
    return !isDeepStrictEqual(value, known[key])
  })
}
class AppServerError extends Error {
  constructor(error, method, { ambiguous = false } = {}) {
    super(error?.message || `${method} failed`)
    this.name = 'AppServerError'
    this.code = error?.code
    this.data = error?.data
    this.method = method
    this.ambiguous = ambiguous
  }
}
function isTurnStateRace(error) {
  if (!(error instanceof AppServerError) || error.ambiguous) return false
  return /(turn.*(complete|active|in.?progress|mismatch|not found)|no active turn|expected active turn|expected.?turn)/i.test(error.message)
}
function isMissingThread(error) {
  return error instanceof AppServerError && !error.ambiguous && /^(thread not found:|no rollout found)/i.test(error.message)
}
function unavailableThread(threadId, error) {
  const failure = new Error(`Saved Telegram conversation ${threadId} is unavailable: ${error.message}. Restore it in Codex or explicitly select another conversation; automatic retries stopped and the message remains saved.`)
  failure.permanent = true
  return failure
}
function isEmptyThreadPaginationGap(error) { return error instanceof AppServerError && error.code === -32601 && error.message === 'list_turns is not supported yet' }

// A Telegram turn that fails with a temporary error is continued by a turn the bridge starts itself,
// after each of these waits in turn; a lasting error, or a failure after the last wait, is reported.
const TURN_RETRY_WAITS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000]
const TEMPORARY_TURN_ERRORS = new Set([
  'serverOverloaded', 'rateLimitExceeded', 'flexUnavailable', 'internalServerError', 'httpConnectionFailed',
  'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts',
])
const CONTINUE_TEXT = 'Gelios Telegram bridge: the previous turn stopped on a temporary Codex error before it finished. ' +
  'Continue the work from where it stopped and answer the Telegram messages it was handling.'
// codexErrorInfo is a bare name ("serverOverloaded") or a one-key object ({ "httpConnectionFailed": { ... } }).
function turnErrorKind(error) {
  const info = error?.codexErrorInfo
  if (typeof info === 'string') return info
  if (info && typeof info === 'object' && !Array.isArray(info)) return Object.keys(info)[0] || null
  return null
}
function uniqueMessages(messages) {
  const seen = new Set()
  return messages.filter(item => {
    const key = `${item.chatId}:${item.messageId}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })
}

export class SessionController {
  constructor(options) {
    this.options = options; this.store = new StateStore(options.stateDir)
    const requestedInstance = process.env.GELIOS_TELEGRAM_INSTANCE_ID
    this.instanceId = /^[a-f0-9]{32}$/.test(requestedInstance || '') ? requestedInstance : randomBytes(16).toString('hex')
    delete process.env.GELIOS_TELEGRAM_INSTANCE_ID
    this.tui = null; this.app = null; this.appReady = false; this.initializedResult = null
    this.currentThreadId = null; this.activeTurnId = null
    this.currentSettings = null
    this.threadPermissions = new Map()
    this.threadWorkspaces = new Map()
    this.tuiLaunches = new Map()
    this.emptyThreadHandoffs = new Map(Object.entries(this.store.emptyThreads()).filter(([id, result]) => result?.thread?.id === id))
    this.emptyHistoryChecked = new Set()
    this.retainedTerminalThreads = new Set()
    this.forwarded = new Map(); this.forwardId = 0
    this.internal = new Map(); this.internalId = 0
    this.ingress = Promise.resolve(); this.waitingTelegram = []
    this.pendingControlIds = []; this.runningControls = new Set()
    this.retryTimer = null; this.retryAttempt = 0
    this.retryDelay = attempt => Math.min(1000 * (2 ** attempt), 15_000)
    this.turnRetry = this.store.turnRetry(); this.turnRetryTimer = null; this.turnRetryWaits = TURN_RETRY_WAITS_MS
    this.shuttingDown = false; this.ownsSockets = false
    this.updatePrepared = false
    this.restoring = false; this.restoreQueue = []
    this.log = message => process.stderr.write(logLines(message))
  }
  async startRuntime(env, secrets = []) {
    this.app = spawn(this.options.codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd: this.options.workspace, env, stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.pipeAppStderr(this.app.stderr, secrets)
    await new Promise((resolve, reject) => { this.app.once('spawn', resolve); this.app.once('error', reject) })
    this.app.on('error', error => { this.log(`app-server failed: ${error.message}`); void this.shutdown(1) })
    this.app.on('exit', (code, signal) => {
      if (!this.shuttingDown) { this.log(`app-server exited (${signal || code})`); void this.shutdown(code || 1) }
    })
    readline.createInterface({ input: this.app.stdout }).on('line', line => this.onAppLine(line))
  }
  attachTui(peer) {
    if (this.updatePrepared) {
      peer.close(1013, 'Gelios bridge is preparing for an update')
      return
    }
    if (this.tui && !this.tui.closed) {
      peer.close(1013, 'Gelios already has an attached terminal')
      return
    }
    this.tui = peer
    peer.sessionId = randomBytes(8).toString('hex')
    peer.selectedThreadId = this.currentThreadId
    peer.bootstrapped = false
    peer.ephemeralThreadIds = new Set()
    peer.onText = text => this.onTuiText(text, peer)
    peer.onClose = () => {
      if (this.tui === peer) this.tui = null
      this.onLocalInputBoundary?.()
    }
  }
  onTuiText(text, peer = this.tui) {
    if (this.restoring) { this.restoreQueue.push([text, peer]); return }
    let message
    try { message = JSON.parse(text) } catch { this.tui?.close(1007, 'invalid JSON'); return }
    message = enforceYolo(message)
    if (peer?.launchYolo && YOLO_METHODS.has(message.method)) {
      message.params = { ...message.params, approvalPolicy: 'never', permissions: ':danger-full-access' }
      delete message.params.sandbox; delete message.params.sandboxPolicy
    }
    if (['turn/start', 'turn/steer'].includes(message.method) || THREAD_SELECTION_METHODS.has(message.method)) {
      this.beforeTerminalInput?.()
      this.pendingHumanInputs = (this.pendingHumanInputs || 0) + 1
      const prepared = message.method.startsWith('turn/') && !peer?.ephemeralThreadIds?.has(message.params?.threadId)
        ? this.prepareTerminalIngress(message, peer) : message
      this.ingress = this.ingress.then(() => this.forwardTui(prepared, peer))
        .catch(error => this.log(`terminal ingress failed: ${error.message}`))
        .finally(() => { this.pendingHumanInputs -= 1 })
      return
    }
    this.forwardTui(message, peer)
  }
  prepareTerminalIngress(message, peer) {
    const event = this.store.nextTerminalEvent(this.options.terminalName, {
      timestamp: Date.now(),
      clientUserMessageId: message.params?.clientUserMessageId,
      requestId: message.id,
      sessionId: peer?.sessionId,
      method: message.method,
      params: message.params,
    })
    this.onLocalTerminalInput?.(message.params?.input || [], message.params?.threadId, event.eventId, event.duplicate)
    message.params = structuredClone(event.payload?.params || message.params || {})
    message.params.clientUserMessageId ||= event.clientUserMessageId || event.eventId
    message.__geliosEventId = event.eventId
    message.__geliosDuplicate = event.duplicate
    return message
  }
  forwardTui(message, peer = this.tui) {
    if (peer?.closed) return
    const selecting = THREAD_SELECTION_METHODS.has(message.method) && message.params?.ephemeral !== true
      && !peer?.ephemeralThreadIds?.has(message.params?.threadId)
    const staleBootstrap = selecting && peer?.selectedThreadId !== undefined && !peer.bootstrapped && peer.selectedThreadId !== this.currentThreadId
    const staleInput = message.method?.startsWith('turn/') && message.params?.threadId !== this.currentThreadId
      && !peer?.ephemeralThreadIds?.has(message.params?.threadId)
    if (staleBootstrap || staleInput) {
      const error = { code: -32602, message: 'The shared conversation changed; the managed TUI will reattach.' }
      if (message.__geliosEventId) this.store.markEvent(message.__geliosEventId, 'failed', { error: error.message, retryable: false })
      peer?.sendText(JSON.stringify({ id: message.id, error }))
      return
    }
    if (message.method === 'initialize' && this.initializedResult) {
      peer?.sendText(JSON.stringify({ id: message.id, result: this.initializedResult }))
      return
    }
    if (message.method === 'initialized' && this.appReady) return
    // The terminal releases its frontend subscription; the shared controller
    // still owns this conversation for Telegram, including a new empty thread.
    if (message.method === 'thread/unsubscribe' && message.params?.threadId === this.currentThreadId &&
        !peer?.ephemeralThreadIds?.has(message.params.threadId)) {
      this.retainedTerminalThreads.add(this.currentThreadId)
      peer?.sendText(JSON.stringify({ id: message.id, result: { status: 'unsubscribed' } }))
      return
    }
    const isEmptyThreadHandoff = ['thread/resume', 'thread/turns/list', 'thread/items/list'].includes(message.method)
      || (message.method === 'thread/read' && message.params?.includeTurns === true)
    const handoffThreadId = isEmptyThreadHandoff ? message.params?.threadId : null
    if (message.id !== undefined && handoffThreadId && this.emptyThreadHandoffs.has(handoffThreadId)) {
      return this.handoffEmptyThread(message, peer)
    }
    if (message.method && message.id !== undefined) {
      const prior = message.__geliosDuplicate && this.store.loadRuntime().events[message.__geliosEventId]
      if (prior?.status === 'delivered' && prior.cachedResponse) {
        peer?.sendText(JSON.stringify({ id: message.id, ...prior.cachedResponse }))
        return
      }
      const proxyId = `tui:${++this.forwardId}`
      const copy = { ...message, id: proxyId }
      delete copy.__geliosEventId
      delete copy.__geliosDuplicate
      let resolveDelivery
      const delivery = ['turn/start', 'turn/steer'].includes(message.method) || THREAD_SELECTION_METHODS.has(message.method)
        ? new Promise(resolvePromise => { resolveDelivery = resolvePromise })
        : undefined
      this.forwarded.set(proxyId, {
        id: message.id,
        peer,
        method: message.method,
        eventId: message.__geliosEventId,
        message: copy,
        resolveDelivery,
      })
      if (message.__geliosEventId && ['turn/start', 'turn/steer'].includes(message.method))
        this.onLocalTerminalDispatch?.(message.__geliosEventId, message.params?.threadId)
      this.sendApp(copy)
      return delivery
    }
    this.sendApp(message)
    if (message.method === 'initialized') {
      this.appReady = true
      this.flushWaiting()
      this.flushPendingControls()
    }
  }
  async rememberEmptyThread(startResult) {
    const threadId = startResult?.thread?.id
    if (!threadId) return
    this.emptyThreadHandoffs.set(threadId, structuredClone(startResult)); this.store.rememberEmptyThread(threadId, startResult)
    try { await this.rpc('thread/read', { threadId, includeTurns: true }); this.completeEmptyThread(threadId) } catch (error) {
      if (!isEmptyThreadPaginationGap(error))
        { this.completeEmptyThread(threadId); throw error }
      this.emptyHistoryChecked.add(threadId)
    }
  }
  completeEmptyThread(threadId) { this.emptyHistoryChecked.delete(threadId); if (threadId && this.emptyThreadHandoffs.delete(threadId)) this.store.forgetEmptyThread(threadId) }
  async isThreadLoaded(threadId) {
    let cursor = null; const seen = new Set()
    do {
      const page = await this.rpc('thread/loaded/list', { cursor, limit: 100 })
      if ((page?.data || []).some(thread => (typeof thread === 'string' ? thread : thread?.id) === threadId)) return true
      cursor = page?.nextCursor || null; if (cursor && seen.has(cursor)) throw new Error('Codex repeated a thread/loaded/list cursor'); if (cursor) seen.add(cursor)
    } while (cursor)
    return false
  }
  // Ingress serializes loading and delivery. A readable rollout alone is not a live subscription.
  async ensureBoundThread(threadId, forceResume = false) {
    if (forceResume || !(await this.isThreadLoaded(threadId))) {
      let resumed
      const binding = this.store.loadBinding()
      const policy = savedPolicyParams(this.threadPermissions.get(threadId) || (binding?.threadId === threadId ? binding.permissions : null))
      try {
        resumed = await this.rpc('thread/resume', yoloParams('thread/resume', {
          ...policy, threadId, cwd: this.options.workspace, excludeTurns: true,
          ...(this.currentSettings?.model ? { model: this.currentSettings.model } : {}),
          ...(policy.config || this.currentSettings?.effort ? { config: { ...policy.config, ...(this.currentSettings?.effort ? { model_reasoning_effort: this.currentSettings.effort } : {}) } } : {}),
        }), 120_000)
      } catch (error) {
        if (isMissingThread(error)) throw unavailableThread(threadId, error)
        throw error
      }
      if (resumed?.thread?.id !== threadId) throw unavailableThread(threadId, new Error('Codex resumed a different conversation'))
      if (this.currentThreadId !== threadId) throw new Error('Telegram conversation changed during resume')
      this.activeTurnId = resumed.thread.turns?.find(turn => turn.status === 'inProgress')?.id || null
      if (resumed.model) this.currentSettings = { model: resumed.model, effort: resumed.reasoningEffort || null }
      this.log(`resumed unloaded Telegram thread ${threadId}`)
    }
    if (this.currentThreadId !== threadId) throw new Error('Telegram conversation changed before delivery')
  }
  async loadEmptyThread(threadId) {
    if (!(await this.isThreadLoaded(threadId))) {
      const saved = this.emptyThreadHandoffs.get(threadId)
      const policy = saved?.sandbox ? { approvalPolicy: saved.approvalPolicy, sandboxPolicy: saved.sandbox, activePermissionProfile: saved.activePermissionProfile } : null
      try { await this.rpc('thread/resume', { ...savedPolicyParams(policy), threadId, cwd: saved?.cwd || this.options.workspace, excludeTurns: true }) } catch (error) {
        if (!isEmptyThreadPaginationGap(error)) { if (error instanceof AppServerError && error.code === -32600 && /no rollout found/.test(error.message)) return false; throw error } }
      if (!(await this.isThreadLoaded(threadId))) return false
    }
    if (!this.emptyHistoryChecked.has(threadId)) {
      try { await this.rpc('thread/read', { threadId, includeTurns: true }); this.completeEmptyThread(threadId) } catch (error) {
        if (!isEmptyThreadPaginationGap(error)) throw error
        this.emptyHistoryChecked.add(threadId)
      }
    }
    return true
  }
  async handoffEmptyThread(message, peer) {
    const threadId = message.params?.threadId; let startResult = this.emptyThreadHandoffs.get(threadId)
    if (!startResult) return this.forwardTui(message, peer)
    let loaded; try { loaded = await this.loadEmptyThread(threadId) } catch (error) {
      this.log(`could not verify empty thread ${threadId} is still loaded: ${error.message}`)
      return this.forwardTui(message, peer)
    }
    if (this.emptyThreadHandoffs.get(threadId) !== startResult) return this.forwardTui(message, peer)
    if (!loaded) { this.completeEmptyThread(threadId); return this.forwardTui(message, peer) }
    if (message.method === 'thread/resume') {
      if (emptyResumeChanges(message.params, startResult)) {
        peer?.sendText(JSON.stringify({ id: message.id, error: { code: -32601, message: 'list_turns is not supported yet' } }))
        return
      }
      if (startResult.approvalPolicy && startResult.sandbox) this.threadPermissions.set(threadId,
        { approvalPolicy: startResult.approvalPolicy, sandboxPolicy: startResult.sandbox, activePermissionProfile: startResult.activePermissionProfile || null })
      if (startResult.cwd) this.threadWorkspaces.set(threadId, startResult.cwd)
      this.bindThread(threadId, peer)
      if (peer) peer.bootstrapped = true
      this.activeTurnId = null
      if (startResult.model) this.currentSettings = { model: startResult.model, effort: startResult.reasoningEffort || null }
      this.flushWaiting()
      this.flushPendingControls()
    }
    const emptyPage = { data: [], nextCursor: null, backwardsCursor: null }
    let result = message.method === 'thread/read' ? { thread: structuredClone(startResult.thread) }
      : ['thread/turns/list', 'thread/items/list'].includes(message.method) ? emptyPage : structuredClone(startResult)
    if (message.method === 'thread/resume') {
      result.turnsBackwardsCursor ??= null; result.itemsBackwardsCursor ??= null
      if (message.params?.initialTurnsPage) result.initialTurnsPage = emptyPage
    }
    peer?.sendText(JSON.stringify({ id: message.id, result }))
  }
  sendApp(message) {
    if (!this.app?.stdin.writable) throw new Error('Codex app-server is not writable')
    this.app.stdin.write(`${JSON.stringify(message)}\n`)
  }
  pipeAppStderr(stream, secrets) {
    const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value)
    const tail = () => Math.max(0, ...secrets.map(secret => secret.length - 1))
    let buffer = ''
    const emit = line => this.log(`app-server stderr: ${line}`)
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      buffer = redact(buffer + chunk)
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline >= 0) { emit(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); continue }
        if (buffer.length > 65_536 + tail()) { emit(buffer.slice(0, 65_536)); buffer = buffer.slice(65_536); continue }
        break
      }
    })
    stream.on('end', () => { if (buffer) emit(redact(buffer)) })
  }
  onAppLine(line) {
    let message
    try { message = JSON.parse(line) } catch {
      this.log('app-server emitted invalid JSON')
      return
    }
    const key = message.id !== undefined ? String(message.id) : null
    const method = this.internal.get(key)?.method || this.forwarded.get(key)?.method
    if (THREAD_SELECTION_METHODS.has(method) && message.result?.thread?.id && message.result.approvalPolicy) {
      this.threadPermissions.set(message.result.thread.id, { approvalPolicy: message.result.approvalPolicy,
        sandboxPolicy: message.result.sandbox || message.result.sandboxPolicy, activePermissionProfile: message.result.activePermissionProfile || null })
    }
    if (THREAD_SELECTION_METHODS.has(method) && message.result?.thread?.id && message.result.cwd) {
      this.threadWorkspaces.set(message.result.thread.id, message.result.cwd)
      if (this.currentThreadId === message.result.thread.id) this.options.workspace = message.result.cwd
    }
    if (!message.method && key && this.internal.has(key)) {
      const pending = this.internal.get(key)
      this.internal.delete(key)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new AppServerError(message.error, pending.method))
      else {
        if (pending.method === 'turn/start') this.completeEmptyThread(pending.params?.threadId)
        pending.resolve(message.result)
      }
      return
    }
    if (!message.method && key && this.forwarded.has(key)) {
      const request = this.forwarded.get(key)
      this.forwarded.delete(key)
      const boundTurn = request.message.params?.threadId === this.currentThreadId
      if (boundTurn && ['turn/start', 'turn/steer'].includes(request.method) && message.error && isTurnStateRace(new AppServerError(message.error, request.method))) {
        void this.retryTerminalTurn(request.id, request, message.error)
        return
      }
      if (request.method === 'initialize' && message.result) {
        this.initializedResult = message.result
        this.persistBinding({ initialize: request.message.params ?? {} })
      }
      const threadResponse = THREAD_SELECTION_METHODS.has(request.method) && message.result?.thread
      const ephemeral = threadResponse && (request.message.params?.ephemeral === true || threadResponse.ephemeral === true)
      if (ephemeral && request.peer) (request.peer.ephemeralThreadIds ||= new Set()).add(threadResponse.id)
      const selectsCurrentThread = threadResponse && !ephemeral
      if (selectsCurrentThread && message.result?.thread?.id) {
        this.bindThread(message.result.thread.id, request.peer)
        if (request.method === 'thread/start' && Array.isArray(message.result.thread.turns) && !message.result.thread.turns.length) {
          void this.rememberEmptyThread(message.result).catch(error => this.log(`could not retain empty terminal thread: ${error.message}`))
        }
        if (request.peer) request.peer.bootstrapped = true
        const selectedModel = request.message.params?.model || message.result.model
        const selectedEffort = request.message.params?.config?.model_reasoning_effort ?? message.result.reasoningEffort
        this.currentSettings = selectedModel ? { model: selectedModel, effort: selectedEffort || null } : null
        this.flushWaiting()
        this.flushPendingControls()
      }
      if (boundTurn && request.method === 'turn/start' && message.result?.turn?.id) this.activeTurnId = message.result.turn.id
      if (request.method === 'turn/start' && !message.error) this.completeEmptyThread(request.message.params?.threadId)
      if (boundTurn && ['turn/start', 'turn/steer'].includes(request.method) && !message.error) {
        const requestedModel = request.message.params?.model
        const requestedEffort = request.message.params?.effort
        if (requestedModel || requestedEffort) this.currentSettings = {
          model: requestedModel || this.currentSettings?.model,
          effort: requestedEffort || this.currentSettings?.effort || null,
        }
      }
      if (request.eventId) this.store.markEvent(request.eventId, message.error ? 'failed' : 'delivered', {
        cachedResponse: message.error ? { error: message.error } : { result: message.result },
        ...(message.error ? {} : { payload: null }),
      })
      if (['thread/unsubscribe', 'thread/delete'].includes(request.method) && !message.error)
        request.peer?.ephemeralThreadIds?.delete(request.message.params?.threadId)
      request.resolveDelivery?.()
      request.peer?.sendText(JSON.stringify({ ...message, id: request.id }))
      return
    }
    if (message.method) this.observeAppMessage(message)
    this.tui?.sendText(JSON.stringify(message))
  }
  async retryTerminalTurn(id, request, originalError) {
    const params = request.message.params || {}
    try {
      let result
      if (this.activeTurnId) {
        const expectedTurnId = this.activeTurnId
        try {
          result = await this.rpc('turn/steer', {
            threadId: params.threadId, input: params.input, expectedTurnId,
            clientUserMessageId: params.clientUserMessageId,
          })
          this.activeTurnId = result?.turnId || expectedTurnId
        } catch (steerError) {
          if (!isTurnStateRace(steerError)) throw steerError
          if (this.activeTurnId === expectedTurnId) this.activeTurnId = null
        }
      }
      if (!result) {
        const startParams = yoloParams('turn/start', params); delete startParams.expectedTurnId
        try {
          result = await this.rpc('turn/start', startParams)
          this.activeTurnId = result?.turn?.id || this.activeTurnId
        } catch (startError) {
          if (!this.activeTurnId || !isTurnStateRace(startError)) throw startError
          result = await this.rpc('turn/steer', {
            threadId: params.threadId, input: params.input, expectedTurnId: this.activeTurnId,
            clientUserMessageId: params.clientUserMessageId,
          })
        }
      }
      let cachedResponse = { result: { turnId: result?.turnId || result?.turn?.id || this.activeTurnId } }
      if (request.method === 'turn/start') {
        let turn = result?.turn
        if (!turn) try {
          const thread = await this.rpc('thread/read', { threadId: params.threadId, includeTurns: true })
          turn = thread?.thread?.turns?.find(candidate => candidate.id === this.activeTurnId)
        } catch {}
        cachedResponse = { result: { turn: turn || { id: this.activeTurnId, items: [], status: 'inProgress' } } }
      }
      if (request.eventId) this.store.markEvent(request.eventId, 'delivered', { delivery: 'started-after-race', cachedResponse, payload: null })
      request.peer?.sendText(JSON.stringify({ id, ...cachedResponse }))
    } catch (error) {
      if (request.eventId) this.store.markEvent(request.eventId, 'failed', { error: error.message })
      request.peer?.sendText(JSON.stringify({ id, error: originalError }))
    } finally {
      request.resolveDelivery?.()
    }
  }
  observeAppMessage(message) {
    const params = message.params || {}
    if (message.method === 'thread/settings/updated' && params.threadId === this.currentThreadId && params.threadSettings?.model) {
      const settings = params.threadSettings
      this.currentSettings = { model: settings.model, effort: settings.effort || null }
      if (settings.approvalPolicy && settings.sandboxPolicy) this.threadPermissions.set(params.threadId,
        { approvalPolicy: settings.approvalPolicy, sandboxPolicy: settings.sandboxPolicy, activePermissionProfile: settings.activePermissionProfile || null })
      if (settings.cwd) { this.threadWorkspaces.set(params.threadId, settings.cwd); this.options.workspace = settings.cwd }
      this.persistBinding({ permissions: this.threadPermissions.get(params.threadId) || null, workspace: this.options.workspace })
    }
    const isCurrentThread = typeof params.threadId === 'string' && params.threadId === this.currentThreadId
    if (isCurrentThread && (message.method === 'thread/closed' ||
        (message.method === 'thread/status/changed' && params.status?.type === 'notLoaded'))) {
      this.activeTurnId = null
      this.onSessionIdle?.()
      this.log(`Telegram thread ${params.threadId} unloaded; retaining its binding`)
    }
    if (message.method === 'turn/started' && isCurrentThread && params.turn?.id) {
      this.completeEmptyThread(params.threadId)
      this.activeTurnId = params.turn.id
      this.onLocalTurnStarted?.(params.threadId, params.turn.id)
    }
    const isActiveTurn = params.turn?.id && params.turn.id === this.activeTurnId
    if (message.method === 'turn/completed' && params.turn?.id) this.lastCompletedTurnId = params.turn.id
    if (message.method === 'turn/completed' && (isCurrentThread || isActiveTurn)) {
      this.onLocalTurnCompleted?.()
      if (!params.turn?.id || isActiveTurn) { this.activeTurnId = null; this.onSessionIdle?.() }
      if (isCurrentThread) {
        this.settleTurn(params.threadId, params.turn)
        this.flushWaiting()
        this.flushPendingControls()
      }
    }
  }
  saveTurnRetry(value) {
    this.turnRetry = value
    if (!value) { clearTimeout(this.turnRetryTimer); this.turnRetryTimer = null }
    try { this.store.saveTurnRetry(value) } catch (error) { this.log(`could not save the turn retry: ${error.message}`) }
  }
  settleTurn(threadId, turn) {
    if (!turn?.id) return
    const pending = this.turnRetry?.threadId === threadId ? this.turnRetry : null
    if (turn.status !== 'failed') {
      if (pending) {
        this.saveTurnRetry(null)
        this.log(`turn ${turn.id} ended ${turn.status || 'completed'} after ${pending.started || 0} retry turns; retry finished`)
      }
      return
    }
    const messages = uniqueMessages([...(pending?.messages || []), ...this.telegramMessagesOf(turn.id)])
    // A failed turn that handled no Telegram message showed its error in the terminal that started it.
    if (!messages.length) return
    this.retryOrReport({ threadId, attempt: pending?.attempt || 0, started: pending?.started || 0, messages },
      turn.error?.message || 'the turn failed without an error message', turnErrorKind(turn.error))
  }
  retryOrReport(retry, message, kind) {
    const temporary = TEMPORARY_TURN_ERRORS.has(kind)
    if (temporary && retry.attempt < this.turnRetryWaits.length && !this.shuttingDown) {
      const wait = this.turnRetryWaits[retry.attempt]
      this.saveTurnRetry({ ...retry, attempt: retry.attempt + 1, error: { message, kind }, dueAt: Date.now() + wait })
      this.log(`turn failed (${kind}); retry ${retry.attempt + 1} of ${this.turnRetryWaits.length} in ${wait} ms`)
      this.scheduleTurnRetry()
      return
    }
    this.saveTurnRetry(null)
    this.log(`turn failed (${kind || 'no error kind'}) after ${retry.started} retry turns; reporting to Telegram`)
    void this.reportFailedTurn(retry.messages, message, kind, retry.started)
      .catch(error => this.log(`could not report the failed turn: ${error.message}`))
  }
  scheduleTurnRetry() {
    clearTimeout(this.turnRetryTimer); this.turnRetryTimer = null
    if (!this.turnRetry || this.shuttingDown) return
    this.turnRetryTimer = setTimeout(() => {
      this.turnRetryTimer = null
      this.ingress = this.ingress.then(() => this.runTurnRetry())
        .catch(error => this.log(`turn retry failed: ${error.message}`))
    }, Math.max(0, Number(this.turnRetry.dueAt || 0) - Date.now()))
    this.turnRetryTimer.unref?.()
  }
  async runTurnRetry() {
    const retry = this.turnRetry
    // Not ready: restoreBinding schedules the retry again once the conversation is back.
    if (!retry || this.updatePrepared || !this.appReady || this.restoring) return
    if (this.currentThreadId !== retry.threadId) {
      this.saveTurnRetry(null)
      await this.reportFailedTurn(retry.messages, `${retry.error?.message}; Telegram moved to another conversation before the retry`,
        retry.error?.kind, retry.started || 0)
      return
    }
    // A turn already running in the conversation continues it; its end settles the retry.
    if (this.activeTurnId) return
    // Counted and typing before the call: the turn can end before turn/start returns.
    const chats = [...new Set(retry.messages.map(item => item.chatId))]
    this.saveTurnRetry({ ...retry, started: (retry.started || 0) + 1 })
    for (const chatId of chats) this.telegram?.startTyping?.(chatId)
    try {
      const result = await this.rpc('turn/start', yoloParams('turn/start', {
        threadId: retry.threadId, input: [{ type: 'text', text: CONTINUE_TEXT }],
      }))
      if (result?.turn?.id && result.turn.id !== this.lastCompletedTurnId) this.activeTurnId = result.turn.id
      this.log(`retry ${retry.attempt} of ${this.turnRetryWaits.length} started turn ${result?.turn?.id}`)
    } catch (error) {
      // Another turn began first: it continues the conversation, so this attempt does not count.
      if (isTurnStateRace(error)) {
        if (this.turnRetry?.attempt === retry.attempt) this.saveTurnRetry({ ...this.turnRetry, started: retry.started || 0 })
        return
      }
      for (const chatId of chats) this.telegram?.stopTyping?.(chatId)
      this.log(`retry ${retry.attempt} could not start a turn: ${error.message}`)
      this.retryOrReport(retry, error.message, retry.error?.kind)
    }
  }
  bindThread(threadId, selectingPeer = null) {
    if (this.currentThreadId !== threadId) this.onLocalInputBoundary?.()
    const previous = this.currentThreadId
    if (this.currentThreadId !== threadId) { this.activeTurnId = null; this.onSessionIdle?.() }
    this.currentThreadId = threadId
    if (this.threadWorkspaces.has(threadId)) this.options.workspace = this.threadWorkspaces.get(threadId)
    if (selectingPeer) selectingPeer.selectedThreadId = threadId
    if (threadId) this.persistBinding({ threadId, workspace: this.options.workspace, permissions: this.threadPermissions.get(threadId) || null })
    if (previous && previous !== threadId && this.retainedTerminalThreads.delete(previous)) {
      void this.rpc('thread/unsubscribe', { threadId: previous }).catch(error => this.log(`could not release former terminal thread: ${error.message}`))
    }
  }
  persistBinding(update) {
    try { this.store.saveBinding(update) } catch (error) { this.log(`could not save the Telegram binding: ${error.message}`) }
  }
  // After a restart nothing has attached yet: replay the last terminal's handshake and resume the
  // conversation Telegram was bound to, so Telegram keeps working with no terminal attached.
  async restoreBinding(binding) {
    try {
      this.initializedResult = await this.rpc('initialize', binding.initialize)
      this.sendApp({ method: 'initialized' })
      this.appReady = true
      this.currentThreadId = binding.threadId
      this.options.workspace = binding.workspace || this.options.workspace
      if (this.options.deferBindingResume) return // Let the native selector resolve --last before touching saved history.
      const resumed = await this.rpc('thread/resume', yoloParams('thread/resume', {
        ...savedPolicyParams(binding.permissions), threadId: binding.threadId, excludeTurns: true,
      }), 120_000)
      if (resumed?.thread?.id !== binding.threadId) throw new Error('Codex resumed a different thread')
      this.bindThread(binding.threadId)
      this.activeTurnId = null
      if (resumed.model) this.currentSettings = { model: resumed.model, effort: resumed.reasoningEffort || null }
      this.log(`restored Telegram routing to thread ${binding.threadId}`)
    } catch (error) {
      this.log(`could not restore Telegram routing to thread ${binding.threadId} (${error.message}); waiting for the Codex TUI`)
    } finally {
      this.restoring = false
      for (const [text, peer] of this.restoreQueue.splice(0)) this.onTuiText(text, peer)
      this.flushWaiting()
      this.flushPendingControls()
      this.scheduleTurnRetry()
    }
  }
  rpc(method, params, timeoutMs = 30_000) {
    const empty = method === 'thread/resume' && this.emptyThreadHandoffs.get(params?.threadId)
    if (empty && this.emptyHistoryChecked.has(params.threadId) && emptyResumeChanges(params, empty))
      return Promise.reject(new AppServerError({ code: -32601, message: 'list_turns is not supported yet' }, method))
    const id = `gelios:${++this.internalId}`
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.internal.delete(id)
        reject(new AppServerError({ message: `${method} timed out` }, method, { ambiguous: true }))
      }, timeoutMs)
      this.internal.set(id, { resolve: resolvePromise, reject, timer, method, params })
      this.sendApp({ id, method, params })
    })
  }
}
export { AppServerError, yoloParams, enforceYolo, isTurnStateRace, isMissingThread, unavailableThread, isEmptyThreadPaginationGap }
