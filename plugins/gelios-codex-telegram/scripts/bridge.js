#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { accessSync, chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { busyUpdate, automaticAttempt, pinBuild, pluginDigest, observedPluginDigest } from '../src/builds.js'
import { atomicSymlink, installedCandidate, repairMissingLauncher, runCommand, validateNextBuild } from './update.js'
import { StateStore, atomicWriteJson, bootIdentity, defaultStateDir, ensurePrivateDir, loadToken, logLines, parseEnvFile, processGroupMembers, processInfo, safeDisplayName, sourceLabel } from '../src/core.js'
import { TelegramChannel } from '../src/telegram.js'
import { labelProblem } from '../src/questions.js'
import { OpenAITranscriber } from '../src/transcription.js'
import { createUnixWebSocketServer } from '../src/websocket.js'
import { SessionController, AppServerError, yoloParams, isTurnStateRace, isMissingThread, isEmptyThreadPaginationGap } from '../src/session.js'
import { runtimeEnvironment } from '../src/environment.js'
import { HeartbeatScheduler } from '../src/heartbeat.js'
import { Monitor, TEXTS, alertsOf, monitorSettings } from '../src/alerts.js'
import { IdleRestart, idleSnapshot } from '../src/restart.js'
import { runSystemctl, SUPERVISED_START_MS } from '../src/systemd.js'
import { changeAccess, localSetupInput, saveConfiguredToken, setupFingerprint } from '../src/local-setup.js'
import { telegramDeliveryInstructions, withTelegramDelivery } from '../src/telegram-guidance.js'
const SYSTEM_ENV = /^(HOME|PATH|USER|LOGNAME|SHELL|TERM|NODE_DISABLE_COMPILE_CACHE|LANG|LANGUAGE|LC_(ALL|CTYPE|NUMERIC|TIME|COLLATE|MONETARY|MESSAGES|PAPER|NAME|ADDRESS|TELEPHONE|MEASUREMENT|IDENTIFICATION)|TMPDIR|TMP|TEMP|TZ|CODEX_HOME|XDG_(CONFIG_HOME|CACHE_HOME|DATA_HOME|STATE_HOME|RUNTIME_DIR|CONFIG_DIRS|DATA_DIRS)|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS|GIT_SSL_CAINFO|AWS_(REGION|DEFAULT_REGION|PROFILE|CONFIG_FILE|SHARED_CREDENTIALS_FILE|EC2_METADATA_DISABLED)|GELIOS_TELEGRAM_(API|FILE)_BASE)$/i
const PROXY_ENV = /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i
const UNSAFE_SLOT = /^(LC_.*|XDG_.*|LD_.*|DYLD_.*|_RLD.*|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|NODE_(OPTIONS|PATH)|OPENSSL_(CONF|MODULES)|PYTHON(PATH|HOME|STARTUP)|PERL5(OPT|LIB)|RUBY(OPT|LIB)|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|CLASSPATH|GIT_(CONFIG.*|EXEC_PATH|SSH_COMMAND|SSH_VARIANT|TEMPLATE_DIR))$/i
function baseEnvironment(source, excluded = [], { network = true } = {}) {
  return Object.fromEntries(Object.entries(source).filter(([name, value]) =>
    (SYSTEM_ENV.test(name) || (network && PROXY_ENV.test(name))) && !excluded.includes(value)))
}
const processIdentity = pid => processInfo(pid)?.identity || null
const SYSTEMD_UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,120}\.service$/
const SUPERVISED_HANDOFF = 'supervised-start.json'
const SUPERVISED_HANDOFF_TTL_MS = 120_000
function systemdUnitName(value) {
  if (value === undefined) return null
  if (typeof value !== 'string' || !SYSTEMD_UNIT.test(value)) throw new Error('--systemd-unit must name a systemd service unit')
  return value
}
function parseArgs(argv) {
  const options = { codexRuntimeEnvs: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--detach') { options.detach = true; continue }
    if (key === '--defer-binding-resume') { options.deferBindingResume = true; continue }
    if (key === '--json') { options.json = true; continue }
    if (key === '--resolve-supervised-start') { options.resolveSupervisedStart = true; continue }
    if (key === '--resolve-durable-start') { options.resolveDurableStart = true; continue }
    if (key === '--codex-runtime-env') {
      if (index + 1 >= argv.length) throw new Error(`invalid argument: ${key}`)
      options.codexRuntimeEnvs.push(argv[++index]); continue
    }
    if (!key.startsWith('--') || index + 1 >= argv.length) throw new Error(`invalid argument: ${key}`)
    options[key.slice(2)] = argv[++index]
  }
  const stateDir = resolve(options['state-dir'] || defaultStateDir())
  const transcriptionKeyEnv = options['transcription-api-key-env']
  if (transcriptionKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(transcriptionKeyEnv)) {
    throw new Error('--transcription-api-key-env must name an environment variable')
  }
  const marketplaceAuthEnv = options['marketplace-auth-env']
  if (marketplaceAuthEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(marketplaceAuthEnv)) {
    throw new Error('--marketplace-auth-env must name an environment variable')
  }
  if (transcriptionKeyEnv && transcriptionKeyEnv === marketplaceAuthEnv) {
    throw new Error('--transcription-api-key-env and --marketplace-auth-env must name separate variables')
  }
  const reservedSlots = new Set([
    'HOME', 'PATH', 'PWD', 'OLDPWD', 'SHELL', 'NODE_OPTIONS', 'TELEGRAM_BOT_TOKEN',
    'GELIOS_CODEX_BIN', 'GELIOS_CODEX_CHILD', 'GELIOS_TERMINAL_NAME', 'GELIOS_TELEGRAM_API_BASE',
    'GELIOS_TELEGRAM_CONTROL_SOCKET', 'GELIOS_TELEGRAM_INSTANCE_ID', 'GELIOS_TELEGRAM_LAUNCHER_LINK',
    'GELIOS_TELEGRAM_OWN_GROUP', 'GELIOS_TELEGRAM_STATE_DIR', 'GELIOS_TELEGRAM_MCP_ROOT', 'GELIOS_WORKSPACE_ROOT',
  ])
  const reserved = name => reservedSlots.has(name) || SYSTEM_ENV.test(name) || PROXY_ENV.test(name) || UNSAFE_SLOT.test(name)
  if (transcriptionKeyEnv && (reserved(transcriptionKeyEnv) || ['GH_TOKEN', 'GITHUB_TOKEN'].includes(transcriptionKeyEnv))) {
    throw new Error('--transcription-api-key-env collides with a runtime environment variable')
  }
  if (marketplaceAuthEnv && reserved(marketplaceAuthEnv)) {
    throw new Error('--marketplace-auth-env collides with a runtime environment variable')
  }
  if (options.codexRuntimeEnvs.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || reserved(name) ||
      ['GH_TOKEN', 'GITHUB_TOKEN'].includes(name) || name === transcriptionKeyEnv)) {
    throw new Error('--codex-runtime-env must name a non-reserved environment variable')
  }
  return {
    stateDir,
    socket: resolve(options.socket || `${stateDir}/app-server.sock`),
    controlSocket: resolve(options['control-socket'] || `${stateDir}/control.sock`),
    workspace: resolve(options.workspace || process.cwd()),
    codexBin: resolve(options['codex-bin'] || process.env.GELIOS_CODEX_BIN || `${process.env.HOME}/.local/bin/codex`),
    terminalName: safeDisplayName(options['terminal-name'] || process.env.GELIOS_TERMINAL_NAME || 'Operator'),
    transcriptionKeyEnv,
    marketplaceAuthEnv,
    codexRuntimeEnvs: [...new Set(options.codexRuntimeEnvs)],
    detach: options.detach === true,
    deferBindingResume: options.deferBindingResume === true,
    json: options.json === true,
    systemdUnit: systemdUnitName(options['systemd-unit']),
    resolveSupervisedStart: options.resolveSupervisedStart === true,
    resolveDurableStart: options.resolveDurableStart === true,
  }
}
function profileFor(options) {
  const bridgeArgs = [
    '--state-dir', options.stateDir, '--socket', options.socket,
    '--control-socket', options.controlSocket, '--workspace', options.workspace,
    '--codex-bin', options.codexBin, '--terminal-name', options.terminalName,
  ]
  if (options.transcriptionKeyEnv) bridgeArgs.push('--transcription-api-key-env', options.transcriptionKeyEnv)
  if (options.marketplaceAuthEnv) bridgeArgs.push('--marketplace-auth-env', options.marketplaceAuthEnv)
  for (const name of options.codexRuntimeEnvs) bridgeArgs.push('--codex-runtime-env', name)
  if (options.systemdUnit) bridgeArgs.push('--systemd-unit', options.systemdUnit)
  return {
    version: 1,
    cwd: resolve(process.cwd()),
    stateDir: options.stateDir,
    socket: options.socket,
    controlSocket: options.controlSocket,
    codexBin: options.codexBin,
    workspace: options.workspace,
    terminalName: options.terminalName,
    bridgeArgs,
    transcriptionApiKeyEnv: options.transcriptionKeyEnv || null,
    marketplaceAuthEnv: options.marketplaceAuthEnv || null,
    codexRuntimeEnvs: options.codexRuntimeEnvs,
    launcherLink: resolve(process.env.GELIOS_TELEGRAM_LAUNCHER_LINK || ''),
    ...(options.systemdUnit ? { systemdUnit: options.systemdUnit } : {}),
  }
}
function waitForChildExit(child, timeoutMs) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolvePromise => {
    const finish = value => { clearTimeout(timer); child.off('exit', onExit); child.off('error', onError); resolvePromise(value) }
    const onExit = () => finish(true); const onError = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit); child.once('error', onError)
  })
}
async function terminateDetachedChild(child, { termMs = 5000, killMs = 2000 } = {}) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const signal = name => {
    try { process.kill(-child.pid, name) } catch (error) {
      try { child.kill(name) } catch {}
    }
  }
  signal('SIGTERM')
  if (await waitForChildExit(child, termMs)) return
  signal('SIGKILL')
  if (!(await waitForChildExit(child, killMs))) throw new Error(`detached bridge process ${child.pid} did not stop`)
}
async function startDetached(options) {
  ensurePrivateDir(options.stateDir)
  const profile = profileFor(options)
  const scriptPath = fileURLToPath(import.meta.url)
  const logPath = join(options.stateDir, 'bridge.log')
  const logFd = openSync(logPath, 'a', 0o600)
  chmodSync(logPath, 0o600)
  let child; let receipt; let interrupted = false
  const interrupt = () => {
    if (interrupted || !child) return
    interrupted = true
    void terminateDetachedChild(child)
  }
  try {
    runtimeEnvironment(process.env, options) // validate bridge-owned credentials before detaching
    const childEnv = { ...process.env }
    const requestedInstance = process.env.GELIOS_TELEGRAM_INSTANCE_ID
    if (requestedInstance && !/^[a-f0-9]{32}$/.test(requestedInstance)) throw new Error('invalid managed bridge instance ID')
    if (requestedInstance) childEnv.GELIOS_TELEGRAM_INSTANCE_ID = requestedInstance
    childEnv.GELIOS_TELEGRAM_OWN_GROUP = '1'
    child = spawn(process.execPath, [scriptPath, ...profile.bridgeArgs, ...(options.deferBindingResume ? ['--defer-binding-resume'] : [])], {
      cwd: process.cwd(), env: childEnv, detached: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
    })
  } finally { closeSync(logFd) }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, interrupt)
  try {
    await new Promise((resolvePromise, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true; clearTimeout(timer)
        if (error) reject(error); else resolvePromise()
      }
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish(new Error('timed out waiting for the detached bridge'))
      }, 15_000)
      child.once('error', error => finish(error))
      child.once('exit', (code, signal) => finish(new Error(`detached bridge exited during startup (${signal || code})`)))
      child.on('message', message => {
        if (message?.type === 'ready' && /^[a-f0-9]{32}$/.test(message.instanceId || '') && /^\d+$/.test(message.identity || '')) {
          receipt = { instanceId: message.instanceId, identity: message.identity }; finish()
        }
        else if (message?.type === 'ready') finish(new Error('detached bridge returned an invalid identity receipt'))
        else if (message?.type === 'error') finish(new Error(message.message))
      })
    })
  } catch (error) {
    let stopError
    try { await terminateDetachedChild(child) } catch (failure) { stopError = failure }
    if (child.connected) child.disconnect()
    child.unref()
    throw new Error(`${error.message}${stopError ? `; ${stopError.message}` : ''}; see ${logPath}`)
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt)
  }
  try { atomicWriteJson(join(options.stateDir, 'launch-profile.json'), profile) } catch (error) {
    let stopError
    try { await terminateDetachedChild(child) } catch (failure) { stopError = failure }
    if (child.connected) child.disconnect()
    child.unref()
    throw new Error(`could not save the detached bridge launch profile: ${error.message}${stopError ? `; ${stopError.message}` : ''}`)
  }
  if (child.connected) child.disconnect()
  child.unref()
  if (options.json) process.stdout.write(`${JSON.stringify({ pid: child.pid, ...receipt, socket: options.socket, log: logPath })}\n`)
  else process.stdout.write(`Bridge started in the background (pid ${child.pid}).\nSocket: unix://${options.socket}\nLog: ${logPath}\n`)
}
const pause = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
function controlStatus(path, timeoutMs = 2000) {
  return new Promise(resolvePromise => {
    let value = ''; let settled = false
    const socket = net.createConnection(path)
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolvePromise(result) }
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ action: 'status' })}\n`))
    socket.on('data', chunk => {
      value += chunk
      const newline = value.indexOf('\n')
      if (newline < 0) return
      try { const response = JSON.parse(value.slice(0, newline)); finish(response.ok ? response.result : null) } catch { finish(null) }
    })
    socket.on('error', () => finish(null))
  })
}
// `bridge --detach --systemd-unit` starts the bridge through its user service, so the service manager
// supervises it and restarts it after a crash or a reboot. A one-shot handoff names this plugin build
// and the instance ID, so an update or its rollback runs the build it asked for.
async function startSupervised(options) {
  ensurePrivateDir(options.stateDir)
  const unit = options.systemdUnit
  const profile = profileFor(options)
  const logPath = join(options.stateDir, 'bridge.log')
  const requestedInstance = process.env.GELIOS_TELEGRAM_INSTANCE_ID
  if (requestedInstance && !/^[a-f0-9]{32}$/.test(requestedInstance)) throw new Error('invalid managed bridge instance ID')
  const instanceId = requestedInstance || randomBytes(16).toString('hex')
  if ((await runSystemctl(['is-active', '--quiet', unit])).code === 0) throw new Error(`${unit} is already running; stop it before starting another bridge`)
  const handoffPath = join(options.stateDir, SUPERVISED_HANDOFF)
  const launcher = join(realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..')), 'bin', 'gelios-codex-telegram')
  atomicWriteJson(handoffPath, { version: 1, unit, instanceId, launcher, deferBindingResume: options.deferBindingResume, createdAt: Date.now() })
  const started = await runSystemctl(['start', unit])
  let receipt = null
  let failure = started.code === 0 ? null : `systemctl --user start ${unit} failed (${started.output || started.code})`
  const deadline = Date.now() + SUPERVISED_START_MS
  while (!failure && Date.now() < deadline) {
    const status = await controlStatus(options.controlSocket)
    if (status?.instanceId === instanceId && status.appRunning === true && /^\d+$/.test(status.identity || '') && Number.isInteger(status.pid)) { receipt = status; break }
    if ((await runSystemctl(['is-failed', '--quiet', unit])).code === 0) failure = `${unit} failed during startup`
    else await pause(200)
  }
  try { unlinkSync(handoffPath) } catch {}
  if (!receipt) {
    await runSystemctl(['stop', unit])
    throw new Error(`${failure || `timed out waiting for ${unit}`}; see ${logPath} and journalctl --user -u ${unit}`)
  }
  try { atomicWriteJson(join(options.stateDir, 'launch-profile.json'), profile) } catch (error) {
    await runSystemctl(['stop', unit])
    throw new Error(`could not save the bridge launch profile: ${error.message}`)
  }
  if (options.json) process.stdout.write(`${JSON.stringify({ pid: receipt.pid, instanceId, identity: receipt.identity, socket: options.socket, log: logPath, unit })}\n`)
  else process.stdout.write(`Bridge started by ${unit} (pid ${receipt.pid}).\nSocket: unix://${options.socket}\nLog: ${logPath}\n`)
}
// Consumed by the launcher when the service starts the bridge: returns the build and instance ID that
// `startSupervised` asked for, or null for an ordinary (re)start through the managed launcher.
function takeSupervisedStart(options) {
  const path = join(options.stateDir, SUPERVISED_HANDOFF)
  let info
  try { info = lstatSync(path) } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
  const raw = info.isFile() ? readFileSync(path, 'utf8') : ''
  unlinkSync(path)
  if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('the handoff must be an owner-only regular file')
  let handoff
  try { handoff = JSON.parse(raw) } catch { throw new Error('the handoff is corrupt') }
  if (handoff?.version !== 1 || handoff.unit !== options.systemdUnit) throw new Error('the handoff names another unit')
  if (!/^[a-f0-9]{32}$/.test(handoff.instanceId || '')) throw new Error('the handoff has an invalid instance ID')
  if (!Number.isFinite(handoff.createdAt) || Math.abs(Date.now() - handoff.createdAt) > SUPERVISED_HANDOFF_TTL_MS) throw new Error('the handoff expired')
  const named = handoff.launcher
  if (typeof named !== 'string' || !isAbsolute(named) || basename(named) !== 'gelios-codex-telegram' || basename(dirname(named)) !== 'bin') throw new Error('the handoff names an invalid launcher')
  const launcher = realpathSync(named)
  const launcherInfo = lstatSync(launcher)
  if (!launcherInfo.isFile() || (launcherInfo.mode & 0o022) || (process.getuid && launcherInfo.uid !== process.getuid())) throw new Error('the handoff launcher must be an owner-controlled file')
  accessSync(launcher, fsConstants.X_OK)
  return { launcher, instanceId: handoff.instanceId, deferBindingResume: handoff.deferBindingResume === true }
}
const BRIDGE_FEATURES = ['format', 'topics', 'buttons']
function notifyParent(message) {
  try { if (process.connected) process.send(message) } catch {}
}
// A label passed labelProblem when it was set, so it comes back as written; anything else reads as invalid.
function pressMetadata(event) {
  if (typeof event.button === 'string') return `; button=${labelProblem(event.button) ? 'invalid' : event.button}`
  if (typeof event.reaction === 'string') return `; reaction=${safeDisplayName(event.reaction, 'invalid')}; reacted_message=${event.reactedMessage === 'bot' ? 'bot' : 'unknown'}`
  return ''
}
function numericMetadata(value) {
  const text = String(value ?? '')
  return /^-?[0-9]+$/.test(text) ? text : 'invalid'
}
function updateBoundaryError() {
  const error = new Error('Gelios bridge is preparing for an update')
  error.retryWithoutAdvancing = true
  return error
}
class GeliosBridge extends SessionController {
  constructor(options) {
    super(options)
    this.localSetupIntent = null
    this.pendingLocalSetups = new Map()
    this.onLocalInputBoundary = () => { this.localSetupIntent = null; this.pendingLocalSetups.clear() }
    this.onLocalTurnCompleted = () => { this.localSetupIntent = null }
    this.onLocalTerminalInput = (input, threadId, eventId, duplicate) => {
      const action = localSetupInput(input)
      this.onLocalInputBoundary()
      if (action && !duplicate) this.pendingLocalSetups.set(eventId, { digest: setupFingerprint(action), threadId, expiresAt: Date.now() + 600_000 })
    }
    this.onLocalTurnStarted = (threadId, turnId) => {
      if (this.localSetupIntent?.threadId === threadId) this.localSetupIntent.turnId = turnId
    }
    this.onLocalTerminalDispatch = (eventId, threadId) => {
      const intent = this.pendingLocalSetups.get(eventId)
      this.pendingLocalSetups.delete(eventId)
      this.localSetupIntent = intent?.threadId === threadId ? intent : null
      if (this.localSetupIntent) this.localSetupIntent.turnId = this.activeTurnId
    }
    this.onSessionIdle = () => this.telegram?.stopTyping?.()
    // Typing and alerts read the native activity record, not activeTurnId: see alerts.js and the PR for #35 stage 3.
    this.monitor = new Monitor({ activity: this.activity, log: message => this.log(message),
      typing: { routes: () => this.telegram?.typingRoutes?.() ?? [], start: (chatId, threadId) => this.telegram?.startTyping?.(chatId, threadId), stop: (chatId, threadId) => this.telegram?.stopTyping?.(chatId, threadId),
        pause: held => { if (this.telegram) this.telegram.typingPaused = held }, lastPrivateChat: () => this.telegram?.lastPrivateChat },
      settings: () => { try { return monitorSettings(this.store.loadConfig()) } catch { return monitorSettings() } },
      route: (chatId, threadId) => this.noticeRoute(chatId, threadId), owner: () => this.ownerRoute(),
      pollOwner: () => Boolean(this.telegram?.polling && !this.telegram.pollConflict), send: notice => this.sendNotice(notice),
      journal: { load: () => alertsOf(this.store.loadRuntime()), save: state => { const runtime = this.store.loadRuntime(); runtime.alerts = structuredClone(state); this.store.saveRuntime(runtime) } } })
    this.onActivity = fact => this.monitor.onFact(fact)
    this.onTurnAnswered = () => this.monitor.answered()
    this.pendingHumanInputs = 0
    this.restart = new IdleRestart(this)
    this.heartbeat = new HeartbeatScheduler({
      store: this.store, log: message => this.log(message),
      enqueue: work => {
        const task = this.ingress.then(work)
        this.ingress = task.catch(() => {})
        return task
      },
      canRun: () => this.appReady && this.currentThreadId && !this.activeTurnId && !this.restoring &&
        this.tui?.bootstrapped !== false && !this.pendingHumanInputs && !this.waitingTelegram.length && !this.pendingControlIds.length &&
        !this.updatePrepared && !this.shuttingDown && !this.turnRetry && !this.batcher?.pending(),
      threadId: () => this.currentThreadId,
      ensureThread: id => this.ensureBoundThread(id),
      readThread: async id => {
        try { return await this.rpc('thread/read', { threadId: id, includeTurns: true }) }
        catch (error) {
          if (this.emptyThreadHandoffs.has(id) && isEmptyThreadPaginationGap(error)) return { thread: { turns: [] } }
          throw error
        }
      },
      startTurn: async params => {
        const result = await this.rpc('turn/start', yoloParams('turn/start', params))
        this.activeTurnId = result?.turn?.id || this.activeTurnId
        return result
      },
    })
  }
  async start() {
    try {
      const hasToken = process.env.TELEGRAM_BOT_TOKEN || parseEnvFile(join(this.options.stateDir, '.env')).TELEGRAM_BOT_TOKEN
      const token = hasToken ? loadToken(this.options.stateDir) : ''
      this.telegramConfigured = Boolean(token)
      const keyName = this.options.transcriptionKeyEnv
      const transcriptionKey = keyName ? process.env[keyName] : null
      if (keyName && !transcriptionKey) throw new Error(`${keyName} is not configured for transcription`)
      const marketplaceSecret = this.options.marketplaceAuthEnv ? process.env[this.options.marketplaceAuthEnv] : null
      if (marketplaceSecret && marketplaceSecret === transcriptionKey) {
        throw new Error('transcription and marketplace authentication slots alias the same credential')
      }
      const { env: runtimeEnv, secrets } = runtimeEnvironment(process.env, this.options, token)
      // Supervised updaters never receive service credentials; the unit supplies its environment.
      this.updateEnvironment = this.options.systemdUnit ? baseEnvironment(runtimeEnv) : { ...process.env }
      this.setupSecrets = secrets
      const writeLog = this.log
      this.log = message => writeLog(secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(message)))
      this.transcriber = transcriptionKey ? new OpenAITranscriber({
        apiKey: transcriptionKey, ffmpegEnv: baseEnvironment(runtimeEnv, [], { network: false }), log: this.log,
      }) : null
      // Static access mode reads the policy once, here; a change saved on disk waits for the next start.
      const accessMode = this.store.loadConfig().accessMode
      if (accessMode !== undefined && !['dynamic', 'static'].includes(accessMode)) throw new Error('channel config accessMode must be dynamic or static')
      if (accessMode === 'static') { this.store.freezeAccess(); this.log('static access mode: the access policy was read once at startup') }
      this.telegram = this.setupChannel(token)
      this.batcher = this.telegram.batcher
      this.beforeTerminalInput = () => { void this.batcher.flush().catch(() => {}) }
      this.telegram.acquireLock(); this.ownsSockets = true
      this.store.removeSocket(this.options.socket)
      this.store.removeSocket(this.options.controlSocket)
      const childEnv = {
        ...runtimeEnv,
        GELIOS_CODEX_CHILD: '1',
        GELIOS_TELEGRAM_STATE_DIR: this.options.stateDir,
        GELIOS_TELEGRAM_CONTROL_SOCKET: this.options.controlSocket,
        GELIOS_TELEGRAM_MCP_ROOT: pinBuild(resolve(dirname(fileURLToPath(import.meta.url)), '..'), this.options.stateDir).root,
        GELIOS_WORKSPACE_ROOT: this.options.workspace,
      }
      this.runtimeEnvironment = childEnv
      this.controlServer = await this.createControlServer()
      await this.startRuntime(childEnv, secrets)
      let binding = null
      try { binding = this.store.loadBinding() } catch (error) { this.log(`ignoring the saved Telegram binding: ${error.message}`) }
      const restorable = binding?.threadId && binding?.initialize ? binding : null
      this.restoring = Boolean(restorable)
      this.wsServer = await createUnixWebSocketServer(this.options.socket, peer => this.attachTui(peer))
      this.heartbeat.start()
      this.monitor.start()
      this.restorePendingEvents()
      this.restorePendingControls()
      if (token) this.telegram.start({ lockHeld: true }).catch(error => {
        if (!this.shuttingDown) {
          this.log(error.message); void this.shutdown(1)
        }
      })
      writeFileSync(`${this.options.stateDir}/status.json`, `${JSON.stringify({
        pid: process.pid, socket: this.options.socket, controlSocket: this.options.controlSocket, workspace: this.options.workspace,
        startedAt: new Date().toISOString(),
      }, null, 2)}\n`, { mode: 0o600 })
      this.log(`ready on unix://${this.options.socket}`)
      if (restorable) void this.restoreBinding(restorable)
    } catch (error) {
      await this.shutdown(1)
      throw error
    }
  }
  startBuildMonitor() {
    const check = () => void this.reconcileInstalledBuild().catch(error => this.log(`installed build reconciliation: ${error.message}`))
    this.buildMonitor = setInterval(check, 30_000); this.buildMonitor.unref()
    this.firstBuildCheck = setTimeout(check, 1000); this.firstBuildCheck.unref()
  }
  async reconcileInstalledBuild() {
    if (this.restart?.pending() || !idleSnapshot(this).idle) return false
    if (!existsSync(join(this.options.stateDir, 'launch-profile.json'))) return false
    this.checkingBuild = true
    let handedOff = false, candidateDigest = null
    try {
      let attempt = automaticAttempt(this.options.stateDir)
      if (attempt?.unit) {
        const unitState = await runSystemctl(['show', systemdUnitName(attempt.unit), '--property=ActiveState', '--value'])
        if (/^(active|activating|deactivating|reloading|refreshing)$/.test(unitState.output)) return false
      }
      if (attempt?.status === 'pending') {
        if (!attempt.unit && attempt.bootId === bootIdentity() && attempt.identity && processInfo(attempt.pid)?.identity === attempt.identity) return false
        attempt = { ...attempt, status: 'failed', reason: 'automatic cutover ended without committing; see build-update.log' }; automaticAttempt(this.options.stateDir, attempt)
      }
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
      const env = baseEnvironment(this.updateEnvironment || process.env)
      const result = await runCommand(this.options.codexBin, ['plugin', 'list', '--json'], { env,
        cwd: this.options.workspace, supervisorPath: join(root, 'scripts', 'update.js'), timeoutMs: 15_000 })
      const selected = JSON.parse(result.stdout).installed?.filter(item => item.name === 'telegram' && item.marketplaceName === 'codex-telegram' && item.enabled && item.installed !== false)
      if (selected?.length !== 1) return false
      candidateDigest = createHash('sha256').update(JSON.stringify(selected[0])).digest('hex')
      if (attempt?.status === 'failed' && attempt.digest === candidateDigest) return false
      const installed = installedCandidate(selected[0], env)
      candidateDigest = observedPluginDigest(installed.installedPath)
      if (attempt && attempt.digest !== candidateDigest) { automaticAttempt(this.options.stateDir, null); attempt = null }
      if (attempt?.status === 'failed' || candidateDigest === pluginDigest(root, null, 0o700)) return false
      const candidate = await validateNextBuild(installed, 'telegram', 'codex-telegram', {
        stateDir: this.options.stateDir, env, secrets: this.setupSecrets,
      })
      if (candidate.contentDigest !== candidateDigest) throw new Error('installed candidate changed during validation')
      if (this.restart?.pending() || idleSnapshot(this).blockers.some(name => name !== 'updating')) return false
      // systemd owns the supervisor in a different unit: setsid alone does
      // not escape KillMode=control-group when the bridge exits cleanly.
      const args = [join(root, 'scripts', 'update.js'), '--automatic', '--state-dir', this.options.stateDir]
      const logPath = join(this.options.stateDir, 'build-update.log')
      const unit = this.options.systemdUnit ? `codex-telegram-update-${this.instanceId}.service` : null
      automaticAttempt(this.options.stateDir, { digest: candidate.contentDigest, status: 'pending', unit })
      if (unit) {
        await runCommand('systemd-run', ['--user', '--collect', '--service-type=exec',
          `--unit=${unit}`,
          `--property=WorkingDirectory=${this.options.workspace}`, `--property=StandardOutput=append:${logPath}`,
          `--property=StandardError=append:${logPath}`,
          ...Object.entries(env).map(([name, value]) => `--setenv=${name}=${value}`), '--', process.execPath, ...args],
        { env, cwd: this.options.workspace, secrets: this.setupSecrets, supervisorPath: join(root, 'scripts', 'update.js'), timeoutMs: 15_000 })
        return true
      }
      const log = openSync(logPath, 'a', 0o600)
      let child
      try { child = spawn(process.execPath, args, {
        cwd: this.options.workspace, env: this.updateEnvironment || env, detached: true, stdio: ['ignore', log, log],
      }) } finally { closeSync(log) }
      automaticAttempt(this.options.stateDir, { digest: candidate.contentDigest, status: 'pending', pid: child.pid, identity: processIdentity(child.pid), bootId: bootIdentity() })
      child.unref()
      child.once('error', error => { this.checkingBuild = false; this.log(`installed build cutover: ${error.message}`) })
      child.once('exit', code => { this.checkingBuild = false; if (code) this.log(`installed build cutover exited with status ${code}; see build-update.log`) })
      handedOff = true
      return true
    } catch (error) {
      if (!candidateDigest) throw error
      const previous = automaticAttempt(this.options.stateDir)
      if (previous?.digest !== candidateDigest || previous.status !== 'failed') {
        automaticAttempt(this.options.stateDir, { digest: candidateDigest, status: 'failed', reason: error.message })
        this.log(`installed build refused ${candidateDigest}: ${error.message}`)
      }
      return false
    } finally { if (!handedOff) this.checkingBuild = false }
  }
  setupChannel(token) {
    return new TelegramChannel({ store: this.store, token, workspaceRoot: this.options.workspace,
      transcriber: this.transcriber, onInbound: (event, prepare) => this.acceptTelegram(event, prepare), atBoundary: () => this.updatePrepared,
      onControl: request => this.acceptTelegramControl(request),
      onStatus: () => ({ ready: this.appReady && !this.restoring, threadId: this.currentThreadId, turnId: this.activeTurnId,
        model: this.currentSettings?.model, effort: this.currentSettings?.effort }), log: this.log })
  }
  assertLocalSetup(action, intent = this.localSetupIntent) {
    if (!intent || intent !== this.localSetupIntent || intent.consumed || intent.expiresAt <= Date.now() ||
        intent.threadId !== this.currentThreadId || !intent.turnId || intent.turnId !== this.activeTurnId ||
        !this.tui || this.tui.closed || intent.digest !== setupFingerprint(action)) {
      throw new Error('setup/access changes require the matching request in the local Codex terminal')
    }
    return intent
  }
  async localSetup(action, signal) {
    const intent = this.assertLocalSetup(action)
    if (action.kind === 'access') {
      intent.consumed = true
      // In static access mode the bridge keeps its startup policy; the change is saved for its next start.
      const frozen = Boolean(this.store.frozenAccess)
      const result = changeAccess(frozen ? new StateStore(this.options.stateDir) : this.store,
        { command: action.command, first: action.first, second: action.second, rest: action.rest })
      if (frozen) return { ...result, message: `${result.message}; static access mode applies it when the bridge next starts` }
      if (result.chatId) await this.telegram.notifyPaired(result.chatId, result.alias, result.role)
      return result
    }
    if (action.kind !== 'configure' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(action.token || '')) throw new Error('invalid bot token')
    if (this.telegramConfigured && !action.rotate) throw new Error('bot token already configured; use $telegram:configure rotate TOKEN locally')
    this.setupSecrets?.push(action.token)
    this.setupSecrets?.sort((a, b) => b.length - a.length)
    const channel = this.setupChannel(action.token)
    try {
      const bot = await channel.api.call('getMe', {}, { signal })
      if (bot?.is_bot !== true) throw new Error('Telegram did not confirm this bot')
      signal?.throwIfAborted(); this.assertLocalSetup(action, intent)
      intent.consumed = true
      saveConfiguredToken(this.store, action.token, { rotate: Boolean(action.rotate) })
      const previous = this.telegram
      await previous.stop({ releaseLock: false })
      channel.lockIdentity = previous.lockIdentity; channel.lastPrivateChat = previous.lastPrivateChat
      this.telegram = channel; this.batcher = channel.batcher; this.telegramConfigured = true
      channel.start({ lockHeld: true, resumed: true }).catch(error => {
        if (!this.shuttingDown) { this.log(channel.errorText(error)); void this.shutdown(1) }
      })
      this.flushWaiting()
      return { configured: true, message: 'Telegram configured. Send a message to your bot, then invoke $telegram:access pair CODE here.' }
    } catch (error) { channel.api.close(); throw new Error(channel.errorText(error)) }
  }
  assertTelegramAdmin(request) {
    const authorized = this.store.authorizedChat(request.chatId)
    if (String(authorized.userId) !== String(request.userId)) throw new Error('Telegram control owner is no longer paired')
    if (authorized.role !== 'admin') throw new Error('Telegram control requires an administrator')
    return authorized
  }
  async modelCatalog() {
    const models = []
    let cursor = null
    for (let page = 0; page < 20; page += 1) {
      const response = await this.rpc('model/list', { cursor, limit: 100 })
      for (const model of response?.data || []) if (!model.hidden && model.id && model.model) models.push(model)
      cursor = response?.nextCursor || null
      if (!cursor) break
    }
    if (!models.length) throw new Error('Codex returned no selectable models')
    return models
  }
  normalizeSettings(models, model, effort) {
    const selected = models.find(candidate => candidate.model === model || candidate.id === model)
      || models.find(candidate => candidate.isDefault) || models[0]
    const efforts = selected.supportedReasoningEfforts || []
    const selectedEffort = efforts.some(option => option.reasoningEffort === effort)
      ? effort : selected.defaultReasoningEffort || efforts[0]?.reasoningEffort || null
    if (!selectedEffort) throw new Error(`Codex model ${selected.displayName} advertises no reasoning effort`)
    return { model: selected.model, effort: selectedEffort, catalogModel: selected }
  }
  async effectiveSettings(models = null) {
    models ||= await this.modelCatalog()
    if (this.currentSettings?.model) return this.normalizeSettings(models, this.currentSettings.model, this.currentSettings.effort)
    const response = await this.rpc('config/read', { cwd: this.options.workspace, includeLayers: false })
    const settings = this.normalizeSettings(models, response?.config?.model, response?.config?.model_reasoning_effort)
    this.currentSettings = { model: settings.model, effort: settings.effort }
    return settings
  }
  modelPicker(threadId, models, settings) {
    return {
      type: 'modelPicker',
      threadId,
      text: `Current model: ${settings.catalogModel.displayName}\nChoose the model for this chat and future chats:`,
      choices: models.map(model => ({
        value: model.model,
        label: `${model.model === settings.model ? '✓ ' : ''}${model.displayName}`,
      })),
    }
  }
  reasoningPicker(threadId, model, currentEffort = null) {
    const efforts = model.supportedReasoningEfforts || []
    if (!efforts.length) throw new Error(`Codex model ${model.displayName} advertises no reasoning effort`)
    return {
      type: 'reasoningPicker',
      threadId,
      model: model.model,
      text: `Model: ${model.displayName}\nChoose the reasoning effort for this chat and future chats:`,
      choices: efforts.map(option => ({
        value: option.reasoningEffort,
        label: `${option.reasoningEffort === currentEffort ? '✓ ' : ''}${option.reasoningEffort}`,
      })),
    }
  }
  async persistDefaultSettings(model, effort) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.rpc('config/read', { cwd: this.options.workspace, includeLayers: true })
      if (current?.config?.model === model && current?.config?.model_reasoning_effort === effort) return
      const userLayer = (current?.layers || []).find(layer => layer.name?.type === 'user')
      let response
      try {
        response = await this.rpc('config/batchWrite', {
          edits: [
            { keyPath: 'model', value: model, mergeStrategy: 'replace' },
            { keyPath: 'model_reasoning_effort', value: effort, mergeStrategy: 'replace' },
          ],
          expectedVersion: userLayer?.version || null,
          reloadUserConfig: false,
        })
      } catch (error) {
        if (error?.data?.config_write_error_code === 'configVersionConflict' && attempt < 2) continue
        throw error
      }
      if (response?.status === 'ok') return
      if (response?.status === 'okOverridden') throw new Error('Codex settings are overridden by a higher-precedence configuration layer')
    }
    throw new Error('Codex settings changed concurrently; run the command again')
  }
  async executeTelegramControl(control) {
    const saved = this.store.control(control.controlId) || control
    if (saved.action === 'new') throw Object.assign(new Error('Telegram /new has been removed'), { permanent: true })
    if (saved.status === 'completed' && saved.result) return saved.result
    this.assertTelegramAdmin(saved)
    if (!this.appReady) throw new Error('Codex is still starting')
    const threadId = saved.threadId || this.currentThreadId
    if (!threadId) throw new Error('No active Codex thread is attached')
    if (saved.threadId && saved.threadId !== this.currentThreadId) throw new Error('This picker belongs to a different Codex chat')
    if (!saved.threadId) this.store.markControl(saved.controlId, saved.status, { threadId })
    const models = await this.modelCatalog()
    const settings = await this.effectiveSettings(models)
    if (saved.action === 'model') return this.modelPicker(threadId, models, settings)
    if (saved.action === 'reasoning') return this.reasoningPicker(threadId, settings.catalogModel, settings.effort)
    if (saved.action === 'selectModel') {
      const model = models.find(candidate => candidate.model === saved.value)
      if (!model) throw new Error('That model is no longer available')
      const effort = (model.supportedReasoningEfforts || []).some(option => option.reasoningEffort === settings.effort)
        ? settings.effort : model.defaultReasoningEffort
      return this.reasoningPicker(threadId, model, effort)
    }
    if (saved.action !== 'selectEffort') throw new Error('Unknown Telegram control')
    const model = models.find(candidate => candidate.model === saved.model)
    if (!model || !(model.supportedReasoningEfforts || []).some(option => option.reasoningEffort === saved.value)) {
      throw new Error('That model and reasoning pair is no longer available')
    }
    const desired = { model: model.model, effort: saved.value }
    this.store.markControl(saved.controlId, 'applying', { threadId, desiredModel: desired.model, desiredEffort: desired.effort })
    await this.rpc('thread/settings/update', { threadId, model: desired.model, effort: desired.effort })
    this.currentSettings = desired
    this.store.markControl(saved.controlId, 'threadUpdated')
    await this.persistDefaultSettings(desired.model, desired.effort)
    return {
      type: 'message',
      text: `Updated this chat and future chats.\nmodel=${desired.model}\nreasoning=${desired.effort}`,
    }
  }
  async acceptTelegramControl(request) {
    if (request.action === 'new') throw Object.assign(new Error('Telegram /new has been removed'), { permanent: true })
    this.onLocalInputBoundary()
    if (this.updatePrepared) throw updateBoundaryError()
    const accepted = this.store.acceptControl(request.controlId, request)
    if (accepted.control.status === 'completed' && accepted.control.result) return accepted.control.result
    this.pendingHumanInputs += 1
    const task = this.ingress.then(async () => {
      const result = await this.executeTelegramControl(this.store.control(request.controlId) || accepted.control)
      this.store.markControl(request.controlId, 'completed', { result, retryable: false })
      return result
    })
    this.ingress = task.catch(() => {}).finally(() => { this.pendingHumanInputs -= 1 })
    try {
      return await task
    } catch (error) {
      this.store.markControl(request.controlId, 'failed', { error: error.message, retryable: error.permanent !== true })
      throw error
    }
  }
  restorePendingControls() {
    for (const control of Object.values(this.store.loadRuntime().controls || {})) {
      if (control.action === 'new' && control.status !== 'completed' && control.retryable !== false)
        this.store.markControl(control.controlId, 'failed', { error: 'Telegram /new has been removed', retryable: false })
    }
    const controls = Object.values(this.store.loadRuntime().controls || {})
      .filter(control => control.status !== 'completed' && control.retryable !== false)
      .sort((a, b) => a.sequence - b.sequence)
    this.pendingControlIds.push(...controls.map(control => control.controlId))
  }
  flushPendingControls() {
    if (this.updatePrepared || !this.appReady || !this.currentThreadId || !this.pendingControlIds.length) return
    const ready = []
    const waiting = []
    for (const controlId of this.pendingControlIds) {
      const control = this.store.control(controlId)
      if (!control || control.status === 'completed' || control.retryable === false) continue
      const boundThread = control.threadId || control.priorThreadId
      if (!boundThread || boundThread === this.currentThreadId || control.createdThreadId === this.currentThreadId) ready.push(control)
      else waiting.push(controlId)
    }
    this.pendingControlIds = waiting
    for (const control of ready) {
      if (this.runningControls.has(control.controlId)) continue
      this.runningControls.add(control.controlId)
      this.ingress = this.ingress.then(async () => {
        const result = await this.executeTelegramControl(control)
        this.store.markControl(control.controlId, 'completed', { result, retryable: false })
      }).catch(error => {
        this.store.markControl(control.controlId, 'failed', { error: error.message, retryable: error.permanent !== true })
        this.log(`control ${control.controlId} recovery failed: ${error.message}`)
      }).finally(() => this.runningControls.delete(control.controlId))
    }
  }
  async acceptTelegram(event, prepare = async () => event) {
    this.onLocalInputBoundary()
    if (this.updatePrepared) {
      // Input the poll loop already journaled waits in the queue: a boundary that is then cancelled still delivers it.
      const saved = this.store.loadRuntime().events[event.eventId]
      if (saved?.payload && saved.status !== 'delivered' && saved.retryable !== false) this.queueForRetry({ ...saved.payload, sequence: saved.sequence })
      throw updateBoundaryError()
    }
    const accepted = this.store.acceptEvent(event.eventId, {
      source: 'Telegram',
      name: event.name,
      sourceTimestamp: event.timestamp,
      chatId: event.chatId,
      messageId: event.messageId,
      payload: { ...event, source: 'Telegram', prepared: false },
    })
    if (accepted.duplicate && accepted.event.status === 'delivered') {
      this.markTelegramBatchDelivered(event)
      return
    }
    this.pendingHumanInputs += 1
    const task = this.ingress.then(async () => {
      const saved = this.store.loadRuntime().events[event.eventId]
      if (saved?.status === 'delivered' || saved?.retryable === false) {
        if (saved.status === 'delivered') this.markTelegramBatchDelivered(event)
        return
      }
      const prepared = accepted.event.payload?.prepared ? accepted.event.payload : await prepare()
      const queued = {
        ...prepared,
        rawMessage: undefined,
        prepared: true,
        source: 'Telegram',
        clientId: event.eventId,
        sequence: accepted.event.sequence,
        reconcile: accepted.duplicate && (!event.journaledOnly || accepted.event.deliveryAttempted === true),
      }
      this.store.markEvent(event.eventId, 'received', { payload: queued, error: null })
      return this.deliverTelegram(queued)
    })
    this.ingress = task.catch(() => {}).finally(() => { this.pendingHumanInputs -= 1 })
    try {
      return await task
    } catch (error) {
      this.store.markEvent(event.eventId, 'failed', { error: error.message, retryable: error.permanent !== true })
      if (error.permanent === true) this.telegram.stopTyping?.(event.chatId)
      else {
        const payload = this.store.loadRuntime().events[event.eventId]?.payload
        if (payload) this.queueForRetry({ ...payload, sequence: accepted.event.sequence, reconcile: true })
      }
      if (error.permanent === true) await this.telegram.notice?.(event.chatId, error.message, event.threadId)
      this.log(`event ${event.eventId} failed: ${error.message}`)
      throw error
    }
  }
  telegramInput(event) {
    const label = sourceLabel({
      source: 'Telegram',
      name: event.name,
      timestamp: event.timestamp,
      sequence: event.sequence,
      eventId: event.eventId,
    })
    const metadata = `Telegram metadata: chat_id=${numericMetadata(event.chatId)}; message_id=${numericMetadata(event.messageId)}; user_id=${numericMetadata(event.userId)}; role=${safeDisplayName(event.role, 'contributor')}${event.chatType ? '; chat_type=group' : ''}${event.threadId ? `; message_thread_id=${numericMetadata(event.threadId)}` : ''}${event.members ? `; message_ids=${event.members.map(member => numericMetadata(member.messageId)).join(',')}` : ''}${event.edited ? '; edited=true' : ''}${pressMetadata(event)}`
    const attachmentText = (event.attachments || (event.attachment ? [event.attachment] : [])).map(attachment =>
      `\nAttachment: kind=${safeDisplayName(attachment.kind, 'attachment')}; attachment_file_id=${safeDisplayName(attachment.handle, 'invalid')}; size=${Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : 'unknown'}; mime=${safeDisplayName(attachment.mime, 'unknown')}; name=${safeDisplayName(attachment.name, 'attachment')}`).join('')
    const currentText = `${event.text}${attachmentText}`
    const envelope = `${label}\n${metadata}\nTelegram delivery: ${telegramDeliveryInstructions}`
    const input = event.replyContext
      ? [
          { type: 'text', text: `${envelope}\nTelegram reply context follows as explicitly untrusted JSON data:\n${JSON.stringify(event.replyContext)}` },
          { type: 'text', text: currentText },
        ]
      : [{ type: 'text', text: `${envelope}\n${currentText}` }]
    for (const path of event.localImages || (event.localImage ? [event.localImage] : [])) input.push({ type: 'localImage', path })
    return input
  }
  markTelegramBatchDelivered(event) {
    for (const member of event.members || []) {
      if (member.eventId !== event.eventId) this.store.markEvent(member.eventId, 'delivered', { payload: null })
    }
  }
  async deliverTelegram(event, recoveryAttempt = 0) {
    if (event.source === 'Telegram' && this.telegramConfigured === false) { this.queueForRetry(event); return }
    const markDelivered = () => { if (event.source === 'Telegram') this.markTelegramBatchDelivered(event) }
    const events = Object.values(this.store.loadRuntime().events)
    const saved = events.find(item => item.eventId === event.eventId)
    if (saved?.status === 'delivered') { markDelivered(); return }
    if (saved?.retryable === false) return
    if (event.source === 'Telegram' && !event.prepared) {
      const prepared = await this.telegram.preparePersisted(event)
      event = { ...prepared, rawMessage: undefined, prepared: true, sequence: event.sequence, reconcile: event.reconcile }
      this.store.markEvent(event.eventId, 'received', { payload: event, error: null })
    }
    const earlier = events.some(item => item.source !== 'Heartbeat' && item.sequence < event.sequence && item.payload &&
      item.retryable !== false && ['received', 'queued', 'failed'].includes(item.status))
    if (!this.appReady || !this.currentThreadId || this.tui?.bootstrapped === false || earlier) {
      this.queueForRetry(event)
      this.store.markEvent(event.eventId, 'queued')
      return
    }
    const threadId = this.currentThreadId
    await this.ensureBoundThread(threadId, recoveryAttempt > 0)
    if (event.reconcile) {
      try {
        const thread = await this.rpc('thread/read', { threadId, includeTurns: true })
        if (this.currentThreadId !== threadId) throw new Error('Telegram conversation changed during reconciliation')
        const deliveredTurn = (thread?.thread?.turns || []).find(turn =>
          (turn.items || []).some(item => item.type === 'userMessage' && item.clientId === (event.clientId || event.eventId)))
        if (deliveredTurn) {
          const cachedResponse = event.source === 'Terminal'
            ? event.method === 'turn/start' ? { result: { turn: deliveredTurn } } : { result: { turnId: deliveredTurn.id } }
            : undefined
          // The turn it reached, and whether its input opened that turn, as a delivery would have recorded them.
          const first = (deliveredTurn.items || []).find(item => item.type === 'userMessage')
          this.store.markEvent(event.eventId, 'delivered', { payload: null, reconciled: true, turnId: deliveredTurn.id, ...this.telegramTopic(event),
            delivery: first?.clientId === (event.clientId || event.eventId) ? 'started' : 'steered', ...(cachedResponse ? { cachedResponse } : {}) })
          this.retryAttempt = 0
          markDelivered()
          return
        }
      } catch (error) {
        if (isMissingThread(error) && recoveryAttempt === 0) return this.deliverTelegram({ ...event, reconcile: true }, 1)
        this.log(`event ${event.eventId} reconciliation failed; retaining queue: ${error.message}`)
        this.queueForRetry(event)
        this.store.markEvent(event.eventId, 'queued')
        return
      }
    }
    const originalInput = event.input || this.telegramInput(event)
    const input = event.source === 'Telegram' ? withTelegramDelivery(originalInput) : originalInput
    const terminalParams = event.source === 'Terminal' ? event.params || {} : {}
    const steer = () => this.rpc('turn/steer', {
      ...(event.method === 'turn/steer' ? terminalParams : {}),
      threadId,
      input,
      expectedTurnId: this.activeTurnId,
      clientUserMessageId: event.clientId || event.eventId,
    })
    const start = () => this.rpc('turn/start', yoloParams('turn/start', {
      ...(event.method === 'turn/start' ? terminalParams : {}),
      threadId,
      input,
      clientUserMessageId: event.clientId || event.eventId,
    }))
    const beganActive = Boolean(this.activeTurnId)
    if (event.source === 'Terminal') this.onLocalTerminalDispatch(event.eventId, threadId)
    else this.localSetupIntent = null
    this.store.markEvent(event.eventId, 'received', { deliveryAttempted: true })
    let mode = beganActive ? 'steered' : 'started'
    let deliveryResult
    try {
      if (beganActive) deliveryResult = await steer()
      else {
        deliveryResult = await start()
        this.activeTurnId = deliveryResult?.turn?.id || this.activeTurnId
      }
    } catch (firstError) {
      if (isMissingThread(firstError) && recoveryAttempt === 0) {
        return this.deliverTelegram({ ...event, reconcile: true }, 1)
      }
      if (beganActive && isTurnStateRace(firstError)) {
        this.activeTurnId = null
        try {
          deliveryResult = await start()
          this.activeTurnId = deliveryResult?.turn?.id || this.activeTurnId
          mode = 'started-after-race'
        } catch (startError) {
          if (!this.activeTurnId || !isTurnStateRace(startError)) throw startError
          deliveryResult = await steer()
          mode = 'steered-after-race'
        }
      } else if (!beganActive && this.activeTurnId && isTurnStateRace(firstError)) {
        deliveryResult = await steer()
        mode = 'steered-after-race'
      } else {
        throw firstError
      }
    }
    const cachedResponse = event.source === 'Terminal'
      ? event.method === 'turn/start'
        ? { result: deliveryResult?.turn ? deliveryResult : { turn: { id: this.activeTurnId } } }
        : { result: { turnId: deliveryResult?.turnId || deliveryResult?.turn?.id || this.activeTurnId } }
      : undefined
    this.store.markEvent(event.eventId, 'delivered', {
      delivery: mode,
      threadId,
      turnId: this.activeTurnId,
      ...this.telegramTopic(event),
      payload: null,
      ...(cachedResponse ? { cachedResponse } : {}),
    })
    this.retryAttempt = 0
    markDelivered()
    // Input a turn took types until that turn ends, even when an earlier turn's end stopped its typing. The host can
    // answer turn/start before it reports turn/started, so a turn not seen to complete counts as running.
    if (event.source === 'Telegram' && this.activeTurnId && this.activeTurnId !== this.lastCompletedTurnId) this.telegram?.startTyping?.(event.chatId, event.threadId)
  }
  // The Telegram topic of delivered input, kept once its payload is cleared, so a notice about its turn stays in that topic.
  telegramTopic(event) { return event.source === 'Telegram' && event.threadId ? { topicId: String(event.threadId) } : {} }
  // Telegram messages a finished turn handled: each delivery records the turn it started or steered, and its topic.
  // A message that started the turn is its starter; one steered into it was absorbed. A delivery recorded by an
  // earlier build, with no mode, counts as a starter, as that build reported every message.
  telegramMessagesOf(turnId) {
    const events = this.store.loadRuntime().events
    return Object.values(events)
      .filter(event => event.source === 'Telegram' && (event.turnId || events[event.parentEventId]?.turnId) === turnId && event.chatId != null && event.messageId != null)
      .sort((a, b) => a.sequence - b.sequence)
      .map(event => { const record = event.turnId ? event : events[event.parentEventId]
        return { chatId: String(event.chatId), messageId: String(event.messageId), ...(record.topicId ? { topicId: record.topicId } : {}),
          starter: !record.delivery || ['started', 'started-after-race'].includes(record.delivery) } })
  }
  // A lasting failure tells the chats whose messages started the turn, once per run of failures (alerts.js); messages
  // steered into it, and terminal, scheduled or subagent turns, add no recipient. A retry saved by an earlier build
  // lists no starters, so each of its messages counts as one.
  async reportFailedTurn(messages, message, kind, retries) {
    const detail = `${message}${kind ? ` (${kind})` : ''}`
    const text = `${retries > 0
      ? `The Codex turn failed again after ${retries} ${retries === 1 ? 'retry' : 'retries'}, so the bridge stopped retrying: ${detail}`
      : `The Codex turn failed: ${detail}`}\n\nYour message got no answer. Send it again. ${TEXTS.failureTail}`
    for (const chatId of new Set(messages.map(item => item.chatId))) this.telegram?.stopTyping?.(chatId)
    this.monitor.failure(messages.filter(item => item.starter !== false).map(item => ({ chatId: item.chatId, threadId: item.topicId })), text)
  }
  // Where a notice about a Telegram route goes: that chat and topic, or the owner for a paired bot's chat. A route the
  // policy no longer admits gets none.
  noticeRoute(chatId, threadId) {
    let route; try { route = this.store.destination(chatId) } catch { return null }
    if (route.kind === 'private' && (route.user.botUsername || this.telegram?.botChats?.get(route.chatId) === true)) return this.ownerRoute()
    return { chatId: route.chatId, ...(threadId ? { threadId: String(threadId) } : {}) }
  }
  // The owner's chat from alertChat, while the policy admits it as a paired administrator's private chat that is not a bot.
  ownerRoute() {
    let chatId; try { chatId = monitorSettings(this.store.loadConfig()).alertChat } catch { return null }
    try { const route = chatId && this.store.destination(chatId)
      if (route?.kind === 'private' && route.user.role === 'admin' && !route.user.botUsername && this.telegram?.botChats?.get(chatId) !== true) return { chatId, owner: true } } catch {}
    return null
  }
  // A journaled notice, sent as plain text, with the policy checked again for each try.
  async sendNotice({ chatId, threadId, text, owner }) {
    if (!this.telegram || this.telegramConfigured === false) throw new Error('Telegram is not configured')
    if (owner && this.ownerRoute()?.chatId !== chatId) throw Object.assign(new Error('alertChat no longer names the owner\'s private chat'), { permanent: true })
    return this.telegram.reply({ chat_id: chatId, text, format: 'text', ...(threadId ? { message_thread_id: threadId } : {}) }, { source: 'Bridge' })
  }
  restorePendingEvents() {
    const runtime = this.store.loadRuntime()
    for (const event of Object.values(runtime.events).sort((a, b) => a.sequence - b.sequence)) {
      if (event.source === 'Heartbeat') continue
      if (!['received', 'queued', 'failed'].includes(event.status) || event.retryable === false || !event.payload) continue
      this.waitingTelegram.push({ ...event.payload, sequence: event.sequence, reconcile: true })
    }
  }
  queueForRetry(event) {
    event.reconcile = true
    if (!this.waitingTelegram.some(item => item.eventId === event.eventId)) this.waitingTelegram.push(event)
    if (!this.appReady || !this.currentThreadId || this.retryTimer || this.shuttingDown) return
    const delay = this.retryDelay(this.retryAttempt)
    this.retryAttempt = Math.min(this.retryAttempt + 1, 4)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.flushWaiting()
    }, delay)
    this.retryTimer.unref()
  }
  flushWaiting() {
    // At a boundary the queue keeps its retry timer, so an update or restart that is cancelled delivers it after all.
    if (this.updatePrepared && this.waitingTelegram.length && !this.retryTimer && !this.shuttingDown) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.flushWaiting() }, this.retryDelay(this.retryAttempt)); this.retryTimer.unref()
    }
    if (this.updatePrepared || !this.appReady || !this.currentThreadId || this.tui?.bootstrapped === false || !this.waitingTelegram.length) return
    const pending = this.waitingTelegram.splice(0).sort((a, b) => a.sequence - b.sequence)
    for (const event of pending) {
      this.ingress = this.ingress.then(() => this.deliverTelegram(event)).catch(error => {
        if (error.permanent === true && event.source === 'Telegram') this.telegram.stopTyping?.(event.chatId)
        else if (error.permanent !== true) this.queueForRetry(event)
        this.store.markEvent(event.eventId, 'failed', { error: error.message, retryable: error.permanent !== true })
        this.log(`queued event ${event.eventId} failed: ${error.message}`)
        if (error.permanent === true && event.source === 'Telegram') {
          void this.telegram.notice?.(event.chatId, error.message, event.threadId).catch(failure => this.log(`could not report unavailable conversation: ${failure.message}`))
        }
      })
    }
  }
  async createControlServer() {
    const server = net.createServer(socket => {
      let buffer = ''
      let handled = false
      const controller = new AbortController()
      // A client gone before its reply fails that reply's write; the failure ends this connection, not the bridge.
      socket.on('error', error => this.log(`control client left before its reply: ${error.message}`))
      socket.once('close', () => controller.abort())
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        if (handled) return
        buffer += chunk
        if (buffer.length > 1024 * 1024) return socket.destroy()
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        handled = true
        const line = buffer.slice(0, newline)
        buffer = ''
        void this.handleControl(line, controller.signal).then(result => {
          socket.end(`${JSON.stringify({ ok: true, result })}\n`)
        }).catch(error => {
          socket.end(`${JSON.stringify({ ok: false, error: this.telegram?.errorText(error) || error.message, code: error.code })}\n`)
        })
      })
    })
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(this.options.controlSocket, () => {
        server.off('error', reject)
        chmodSync(this.options.controlSocket, 0o600)
        resolvePromise()
      })
    })
    return server
  }
  async handleControl(line, signal) {
    const request = JSON.parse(line)
    if (this.updatePrepared && ['prepare_tui_launch', 'heartbeat_configure', 'reply'].includes(request.action)) throw updateBoundaryError()
    if (request.action === 'restart_request') return this.restart.request(request.args || {})
    if (request.action === 'restart_cancel') return this.restart.cancel(request.args?.id)
    if (request.action === 'runtime_environment') return this.runtimeEnvironment || {}
    // The optional tool arguments this bridge honors; a newer tool client checks them before sending any.
    if (request.action === 'capabilities') return { features: BRIDGE_FEATURES }
    if (request.action === 'prepare_tui_launch') {
      if (this.tuiLaunches.size >= 32) throw new Error('too many pending terminal launches')
      const token = randomBytes(32).toString('hex')
      const path = join(this.options.stateDir, `t${token.slice(0, 12)}`)
      const launch = { used: false }
      const server = await createUnixWebSocketServer(path, peer => {
        if (launch.used) { peer.close(1008, 'Terminal launch already consumed'); return }
        launch.used = true; peer.launchYolo = request.args?.yolo === true
        this.attachTui(peer)
      })
      chmodSync(path, 0o600)
      launch.close = () => { clearTimeout(launch.timer); this.tuiLaunches.delete(token); server.close() }
      launch.timer = setTimeout(launch.close, 60_000); launch.timer.unref()
      this.tuiLaunches.set(token, launch)
      return { token, socket: path }
    }
    if (request.action === 'release_tui_launch') { this.tuiLaunches.get(request.args?.token)?.close(); return {} }
    if (request.action === 'local_setup') return this.localSetup(request.args || {}, signal)
    if (request.action === 'heartbeat_status') return this.heartbeat.status()
    if (request.action === 'heartbeat_configure') {
      const task = this.ingress.then(() => { signal?.throwIfAborted(); return this.heartbeat.configure(request.args || {}) })
      this.ingress = task.catch(() => {})
      return task
    }
    if (request.action === 'stop_for_update' || request.action === 'shutdown_instance') {
      if (this.restart?.state?.phase === 'handoff' && this.updatePrepared) throw busyUpdate('an idle restart is already committed')
      if (request.instanceId !== this.instanceId) throw new Error('bridge instance changed; refusing shutdown')
      if (this.tui && !this.tui.closed) throw busyUpdate('detach the Codex TUI before updating')
      this.updatePrepared = true
      while (true) {
        const pending = this.ingress
        await pending
        if (pending === this.ingress) break
      }
      if (this.activeTurnId) {
        this.updatePrepared = false
        throw busyUpdate('wait for the active Codex turn to finish before updating')
      }
      const blockers = idleSnapshot(this).blockers.filter(name => !['updating', 'externalUpdate'].includes(name))
      if (request.action === 'stop_for_update' && blockers.length) {
        this.updatePrepared = false
        throw busyUpdate(`wait for bridge work to finish before updating: ${blockers.join(', ')}`)
      }
      if (signal?.aborted) {
        this.updatePrepared = false
        throw new Error('the update request disconnected before shutdown')
      }
      setImmediate(() => void this.shutdown(0))
      return { pid: process.pid, identity: processIdentity(process.pid), instanceId: this.instanceId, stopping: true }
    }
    if (['reply', 'react', 'edit_message', 'download_attachment', 'notify_paired'].includes(request.action) && this.telegramConfigured === false) throw new Error('Telegram is not configured; invoke $telegram:configure in the local Codex terminal')
    if (request.action === 'reply') return this.telegram.reply(request.args || {}, { signal })
    if (request.action === 'react') return this.telegram.agentReact(request.args || {})
    if (request.action === 'edit_message') return this.telegram.editMessage(request.args || {}, { signal })
    if (request.action === 'download_attachment') {
      return { path: await this.telegram.downloadAttachment(request.args?.attachment_file_id, { signal }) }
    }
    if (request.action === 'notify_paired') {
      const authorized = this.store.authorizedChat(request.args?.chatId)
      if (authorized.alias !== request.args?.alias || authorized.role !== request.args?.role) {
        throw new Error('paired identity changed before notification')
      }
      await this.telegram.notifyPaired(request.args.chatId, request.args.alias, request.args.role)
      return { notified: true }
    }
    if (request.action === 'status') return {
      pluginVersion: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
      pluginRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
      pid: process.pid,
      identity: processIdentity(process.pid),
      instanceId: this.instanceId,
      ready: this.appReady && !this.restoring,
      telegramConfigured: this.telegramConfigured !== false,
      appRunning: Boolean(this.app && this.app.exitCode === null && !this.app.killed),
      appPid: this.app?.pid || null,
      permissions: this.threadPermissions.get(this.currentThreadId) || null,
      threadId: this.currentThreadId,
      turnId: this.activeTurnId,
      turnRetry: this.turnRetry ? { attempt: this.turnRetry.attempt, of: this.turnRetryWaits.length,
        dueAt: Number.isFinite(this.turnRetry.dueAt) ? new Date(this.turnRetry.dueAt).toISOString() : null,
        error: this.turnRetry.error?.kind || null } : null,
      tuiAttached: Boolean(this.tui && !this.tui.closed),
      tuiReady: Boolean(this.tui && !this.tui.closed && this.tui.bootstrapped),
      tuiThreadId: this.tui?.selectedThreadId || null,
      socket: this.options.socket,
      codexBin: this.options.codexBin,
      workspace: this.options.workspace,
      updatePrepared: this.updatePrepared,
      automaticBuild: automaticAttempt(this.options.stateDir),
      idle: idleSnapshot(this),
      activity: this.activity.snapshot(),
      monitoring: { ...this.monitor.status(), lastPollAt: this.telegram?.lastPollAt ? new Date(this.telegram.lastPollAt).toISOString() : null },
      restart: this.restart.status(),
    }
    throw new Error('unknown bridge action')
  }
  shutdown(exitCode = 0) {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shuttingDown = true
    clearInterval(this.buildMonitor); clearTimeout(this.firstBuildCheck)
    this.heartbeat?.stop()
    this.monitor?.stop()
    this.restart?.stop()
    this.shutdownPromise = this.finishShutdown(exitCode)
    return this.shutdownPromise
  }
  async finishShutdown(exitCode) {
    for (const launch of this.tuiLaunches.values()) launch.close()
    process.stdin.pause()
    process.stdin.destroy()
    for (const pending of this.internal.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Gelios bridge is shutting down'))
    }
    this.internal.clear()
    clearTimeout(this.retryTimer)
    clearTimeout(this.turnRetryTimer)
    for (const request of this.forwarded.values()) request.resolveDelivery?.(); this.forwarded.clear()
    await this.telegram?.stop().catch(() => {})
    this.tui?.close(1001, 'Gelios bridge shutting down')
    await Promise.all([
      new Promise(resolvePromise => this.wsServer?.close(resolvePromise) || resolvePromise()),
      new Promise(resolvePromise => this.controlServer?.close(resolvePromise) || resolvePromise()),
    ])
    if (this.ownsSockets) {
      try { this.store.removeSocket(this.options.socket) } catch {}
      try { this.store.removeSocket(this.options.controlSocket) } catch {}
    }
    if (this.ownsSockets) try {
      const statusPath = `${this.options.stateDir}/status.json`
      if (existsSync(statusPath)) unlinkSync(statusPath)
    } catch {}
    if (process.env.GELIOS_TELEGRAM_OWN_GROUP === '1') {
      try { process.kill(-process.pid, 'SIGTERM') } catch {}
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        if (!processGroupMembers(process.pid).length) break
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
      }
      if (processGroupMembers(process.pid).length) process.kill(-process.pid, 'SIGKILL')
    } else if (this.app && !this.app.killed) {
      this.app.kill('SIGTERM')
      if (!(await waitForChildExit(this.app, 2000))) this.app.kill('SIGKILL')
      await waitForChildExit(this.app, 2000)
    }
    process.exitCode = exitCode
  }
}
async function main() {
  const argv = process.argv.slice(2)
  const options = parseArgs(argv)
  delete process.env.GELIOS_TELEGRAM_SUPERVISED_CHILD
  if (options.resolveDurableStart) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const build = pinBuild(root, options.stateDir)
    const link = process.env.GELIOS_TELEGRAM_LAUNCHER_LINK
    if (link && lstatSync(link).isSymbolicLink() && (!process.getuid || lstatSync(link).uid === process.getuid())) {
      try {
        if (realpathSync(link) === realpathSync(join(root, 'bin', 'gelios-codex-telegram'))) atomicSymlink(link, build.launcher)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        repairMissingLauncher({ launcherLink: link, stateDir: options.stateDir }, root, atomicSymlink)
      }
    }
    process.stdout.write(build.launcher)
    return
  }
  if (options.resolveSupervisedStart) {
    try {
      const handoff = options.systemdUnit && !options.detach ? takeSupervisedStart(options) : null
      if (handoff) process.stdout.write(`${handoff.launcher}\t${handoff.instanceId}${handoff.deferBindingResume ? '\t--defer-binding-resume' : ''}\n`)
    } catch (error) { process.stderr.write(logLines(`ignoring the supervised start handoff: ${error.message}`)) }
    return
  }
  if (options.detach) {
    try { await (options.systemdUnit ? startSupervised(options) : startDetached(options)) } catch (error) {
      process.stderr.write(`gelios-codex-telegram: ${error.message}\n`)
      process.exitCode = 1
    }
    return
  }
  const bridge = new GeliosBridge(options)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void bridge.shutdown(0))
  if (!process.stdin.isTTY && typeof process.send !== 'function' && !options.systemdUnit) {
    process.stdin.resume()
    process.stdin.once('end', () => void bridge.shutdown(0))
  }
  process.on('unhandledRejection', error => bridge.log(`unhandled rejection: ${error?.message || error}`))
  process.on('uncaughtException', error => {
    bridge.log(`uncaught exception: ${error.message}`)
    void bridge.shutdown(1)
  })
  try {
    await bridge.start()
    // A service manager starts this bridge with no detached launcher to record how it was started.
    if (options.systemdUnit) {
      try { atomicWriteJson(join(options.stateDir, 'launch-profile.json'), profileFor(options)) } catch (error) {
        bridge.log(`could not save the launch profile: ${error.message}`)
      }
    }
    bridge.startBuildMonitor()
    bridge.restart.start()
    notifyParent({ type: 'ready', instanceId: bridge.instanceId, identity: processIdentity(process.pid) })
  } catch (error) {
    notifyParent({ type: 'error', message: error.message })
    bridge.log(error.message)
    process.exitCode = 1
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
export { AppServerError, GeliosBridge, isTurnStateRace, parseArgs, profileFor, takeSupervisedStart, terminateDetachedChild }
