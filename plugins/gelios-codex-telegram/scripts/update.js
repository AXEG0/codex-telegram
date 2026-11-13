#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync,
  readlinkSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runtimeEnvironment } from '../src/environment.js'
import { StateStore, bootIdentity, defaultStateDir, liveGroupMembers, processInfo } from '../src/core.js'
import { busyUpdate, automaticAttempt, acquireLock, durableJson, copyPluginTree, pinBuild, pruneBuilds, pluginFiles, pluginDigest, trustedDirectory, trustedFile, syncPath } from '../src/builds.js'
import { installLaunchers, mcpBootstrap } from '../src/bootstrap.js'
import { assertMigrationSafe, assertMigrationStopped } from '../src/migration.js'
import { runtimeSocket, runtimeStatus } from '../src/runtime.js'
import { isYoloPolicy } from '../src/session.js'
import { captureInstallation, validateInstallation, restoreInstallation, nativeUpdateEnvironment, installLauncher, packageDigest, verifyInstallationState } from '../src/installation.js'

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_OUTPUT = 1024 * 1024
const SYSTEM_ENV = /^(HOME|PATH|USER|LOGNAME|SHELL|TERM|NODE_DISABLE_COMPILE_CACHE|LANG|LANGUAGE|LC_(ALL|CTYPE|NUMERIC|TIME|COLLATE|MONETARY|MESSAGES|PAPER|NAME|ADDRESS|TELEPHONE|MEASUREMENT|IDENTIFICATION)|TMPDIR|TMP|TEMP|TZ|CODEX_HOME|XDG_(CONFIG_HOME|CACHE_HOME|DATA_HOME|STATE_HOME|RUNTIME_DIR|CONFIG_DIRS|DATA_DIRS)|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS|GIT_SSL_CAINFO|AWS_(REGION|DEFAULT_REGION|PROFILE|CONFIG_FILE|SHARED_CREDENTIALS_FILE|EC2_METADATA_DISABLED)|GELIOS_TELEGRAM_(API|FILE)_BASE)$/i
const PROXY_ENV = /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i
const UNSAFE_SLOT = /^(LC_.*|XDG_.*|LD_.*|DYLD_.*|_RLD.*|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|NODE_(OPTIONS|PATH)|OPENSSL_(CONF|MODULES)|PYTHON(PATH|HOME|STARTUP)|PERL5(OPT|LIB)|RUBY(OPT|LIB)|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|CLASSPATH|GIT_(CONFIG.*|EXEC_PATH|SSH_COMMAND|SSH_VARIANT|TEMPLATE_DIR))$/i
const RESERVED_RUNTIME = new Set([
  'HOME', 'PATH', 'PWD', 'OLDPWD', 'SHELL', 'NODE_OPTIONS', 'TELEGRAM_BOT_TOKEN',
  'GELIOS_CODEX_BIN', 'GELIOS_CODEX_CHILD', 'GELIOS_TERMINAL_NAME', 'GELIOS_TELEGRAM_API_BASE',
  'GELIOS_TELEGRAM_CONTROL_SOCKET', 'GELIOS_TELEGRAM_INSTANCE_ID', 'GELIOS_TELEGRAM_LAUNCHER_LINK',
  'GELIOS_TELEGRAM_OWN_GROUP', 'GELIOS_TELEGRAM_STATE_DIR', 'GELIOS_TELEGRAM_MCP_ROOT', 'GELIOS_WORKSPACE_ROOT',
])
const pluginRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))

function parseArgs(argv) {
  if (argv.includes('--automatic')) return { ...parseArgs(argv.filter(arg => arg !== '--automatic')), installed: true, automatic: true }
  if (argv.includes('--installed')) {
    const rest = argv.filter(arg => arg !== '--installed')
    return { ...parseArgs(rest), installed: true }
  }
  if (argv.includes('--all')) {
    const result = { stateDir: resolve(defaultStateDir()), all: true }
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--all') continue
      if (!['--state-dir', '--installer-root'].includes(argv[i]) || !argv[i + 1]) throw new Error('usage: codex-telegram update [--state-dir PATH]')
      result[argv[i] === '--state-dir' ? 'stateDir' : 'installerRoot'] = resolve(argv[++i])
    }
    if (!result.installerRoot) {
      const command = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').map(dir => join(dir, 'codex-telegram')).find(existsSync)
      if (command) result.installerRoot = dirname(realpathSync(command))
    }
    return result
  }
  if (argv.length === 0) return { stateDir: resolve(defaultStateDir()) }
  if (argv.length === 2 && argv[0] === '--state-dir' && argv[1]) return { stateDir: resolve(argv[1]) }
  throw new Error('usage: gelios-codex-telegram update [--state-dir PATH]')
}

function redact(value, secrets = []) {
  return [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.split(secret).join('[redacted]'), String(value || ''))
}

function signalGroup(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch (error) { if (error?.code !== 'ESRCH') throw error }
}

const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

// Both kill paths end here: a killed group is gone once none of its members still runs, within two seconds.
async function groupEnded(groupId) {
  const deadline = Date.now() + 2000
  let live
  while ((live = liveGroupMembers(groupId)).length && Date.now() < deadline) await delay(25)
  if (live.length) throw new Error(`command process group ${groupId} did not terminate: ${live.map(({ pid, state }) => `${pid} (${state})`).join(', ')}`)
}

async function terminateGroup(child) {
  if (!child.pid) return
  try { signalGroup(child, 'SIGTERM') } catch {}
  await delay(250)
  try { signalGroup(child, 'SIGKILL') } catch {}
  if (process.platform !== 'win32') await groupEnded(child.pid)
}

function signalGroupMembers(groupId, signal) {
  for (const { pid } of liveGroupMembers(groupId)) {
    try { process.kill(pid, signal) } catch (error) { if (error?.code !== 'ESRCH') throw error }
  }
}

async function drainOwnProcessGroup() {
  if (!liveGroupMembers(process.pid).length) return
  signalGroupMembers(process.pid, 'SIGTERM')
  await delay(250)
  signalGroupMembers(process.pid, 'SIGKILL')
  await groupEnded(process.pid)
}

async function superviseCommand(argv) {
  const timeoutMs = Number(argv[0]); const command = argv[1]; const args = argv.slice(2)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !command) process.exit(125)
  const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] })
  let forced = null; let forceTimer = null
  const stop = message => {
    if (forced) return
    forced = message || 'command interrupted'
    if (message) process.stderr.write(`${message}\n`)
    try { signalGroupMembers(process.pid, 'SIGTERM') } catch {}
    forceTimer = setTimeout(() => { try { signalGroupMembers(process.pid, 'SIGKILL') } catch {} }, 250)
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop())
  const timer = setTimeout(() => stop('command timed out'), timeoutMs)
  await new Promise(resolvePromise => {
    child.once('error', error => { forced ||= error.message; process.stderr.write(`${error.message}\n`) })
    child.once('close', async (code, signal) => {
      clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer)
      try { await drainOwnProcessGroup() } catch (error) {
        forced ||= error.message
        process.stderr.write(`${error.message}\n`)
      }
      process.exitCode = forced ? 125 : code ?? (signal ? 128 : 1)
      resolvePromise()
    })
  })
}

function runCommand(command, args, {
  cwd, env, label = 'command', secrets = [], timeoutMs = 60_000, onSpawn,
  supervisorPath = fileURLToPath(import.meta.url),
} = {}) {
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      const supervised = process.platform !== 'win32'
        ? [supervisorPath, '--supervise', String(timeoutMs), command, ...args] : args
      child = spawn(supervised === args ? command : process.execPath, supervised, {
        cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      })
      const identity = processIdentity(child.pid)
      if (onSpawn && !/^\d+$/.test(identity || '')) throw new Error('could not verify supervised command identity')
      onSpawn?.({ pid: child.pid, identity, deadline: Date.now() + timeoutMs + 1000 })
    } catch (error) {
      if (child) { child.on('error', () => {}); void terminateGroup(child).then(() => '', failure => `; ${failure.message}`).then(left => reject(new Error(`${label} failed: ${redact(error.message + left, secrets)}`))) }
      else reject(new Error(`${label} failed: ${redact(error.message, secrets)}`))
      return
    }
    let stdout = ''; let stderr = ''; let forced = null; let killing = null
    // Why the step failed, then what still runs of a group that outlived its kill, which fails the command at once.
    const fail = (why, stuck) => { const detail = [redact(why, secrets).trim(), stuck && redact(stuck.message, secrets)].filter(Boolean).join('; '); reject(new Error(`${label} failed${detail ? `: ${detail}` : ''}`)) }
    const terminate = reason => {
      forced ||= reason
      if (!killing) (killing = terminateGroup(child)).catch(error => fail(stderr || forced, error))
    }
    const append = (name, chunk) => {
      const next = (name === 'stdout' ? stdout : stderr) + chunk
      if (Buffer.byteLength(next) > MAX_OUTPUT) terminate('output exceeded 1 MiB')
      if (name === 'stdout') stdout = next.slice(0, MAX_OUTPUT); else stderr = next.slice(0, MAX_OUTPUT)
    }
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => append('stdout', chunk)); child.stderr?.on('data', chunk => append('stderr', chunk))
    const timer = setTimeout(() => terminate('timed out'), timeoutMs + 1000)
    child.once('error', error => { forced ||= error.message })
    child.once('close', async (code, signal) => {
      clearTimeout(timer)
      let stuck = null
      try {
        if (forced || code !== 0) await (killing ||= terminateGroup(child))
        else await terminateGroup(child) // remove any credential-bearing descendants left behind
      } catch (error) { stuck = error }
      if (!stuck && !forced && code === 0) { resolvePromise({ stdout, stderr }); return }
      fail(stderr || forced || signal || `exit ${code}`, stuck)
    })
  })
}

function withCommandSupervisor(run, supervisorPath) {
  return (command, args, options = {}) => run(command, args, { ...options, supervisorPath })
}

function parseJson(stdout, label) {
  let value
  try { value = JSON.parse(stdout) } catch { throw new Error(`${label} returned invalid JSON`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned an invalid result`)
  return value
}

function readProfile(stateDir) {
  const path = join(stateDir, 'launch-profile.json')
  let info
  try { info = lstatSync(path) } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('launch profile is missing; start the detached bridge once with the current plugin before updating')
    throw error
  }
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`${path} must be an owner-only regular file (mode 0600)`)
  }
  const profile = parseJson(readFileSync(path, 'utf8'), 'launch profile')
  const paths = ['cwd', 'stateDir', 'socket', 'controlSocket', 'codexBin', 'workspace', 'launcherLink']
  if (profile.version !== 1 || paths.some(key => typeof profile[key] !== 'string' || !isAbsolute(profile[key]))) {
    throw new Error('launch profile has an unsupported or invalid shape')
  }
  if (resolve(profile.stateDir) !== stateDir || typeof profile.terminalName !== 'string' || !profile.terminalName ||
      !Array.isArray(profile.bridgeArgs) || profile.bridgeArgs.some(value => typeof value !== 'string')) {
    throw new Error('launch profile does not match this state directory')
  }
  for (const key of ['transcriptionApiKeyEnv', 'marketplaceAuthEnv']) {
    if (profile[key] !== null && !ENV_NAME.test(profile[key] || '')) throw new Error(`launch profile has an invalid ${key}`)
  }
  const reserved = name => RESERVED_RUNTIME.has(name) || SYSTEM_ENV.test(name) || PROXY_ENV.test(name) || UNSAFE_SLOT.test(name)
  if (profile.transcriptionApiKeyEnv && (reserved(profile.transcriptionApiKeyEnv) ||
      ['GH_TOKEN', 'GITHUB_TOKEN'].includes(profile.transcriptionApiKeyEnv))) throw new Error('launch profile has an unsafe transcription credential slot')
  if (profile.marketplaceAuthEnv && reserved(profile.marketplaceAuthEnv)) throw new Error('launch profile has an unsafe marketplace credential slot')
  if (!Array.isArray(profile.codexRuntimeEnvs) || profile.codexRuntimeEnvs.some(name => !ENV_NAME.test(name) ||
      reserved(name) || ['GH_TOKEN', 'GITHUB_TOKEN'].includes(name)) ||
      new Set(profile.codexRuntimeEnvs).size !== profile.codexRuntimeEnvs.length) {
    throw new Error('launch profile has invalid Codex runtime environment slots')
  }
  if (profile.transcriptionApiKeyEnv && profile.transcriptionApiKeyEnv === profile.marketplaceAuthEnv) {
    throw new Error('transcription and marketplace authentication require separate environment slots')
  }
  if (profile.transcriptionApiKeyEnv && profile.codexRuntimeEnvs.includes(profile.transcriptionApiKeyEnv)) {
    throw new Error('the transcription credential cannot be exposed to the Codex runtime')
  }
  if (profile.systemdUnit !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,120}\.service$/.test(profile.systemdUnit || '')) {
    throw new Error('launch profile has an invalid systemdUnit')
  }
  const expectedArgs = [
    '--state-dir', profile.stateDir, '--socket', profile.socket, '--control-socket', profile.controlSocket,
    '--workspace', profile.workspace, '--codex-bin', profile.codexBin, '--terminal-name', profile.terminalName,
  ]
  if (profile.transcriptionApiKeyEnv) expectedArgs.push('--transcription-api-key-env', profile.transcriptionApiKeyEnv)
  if (profile.marketplaceAuthEnv) expectedArgs.push('--marketplace-auth-env', profile.marketplaceAuthEnv)
  for (const name of profile.codexRuntimeEnvs) expectedArgs.push('--codex-runtime-env', name)
  if (profile.systemdUnit) expectedArgs.push('--systemd-unit', profile.systemdUnit)
  if (JSON.stringify(profile.bridgeArgs) !== JSON.stringify(expectedArgs)) {
    throw new Error('launch profile bridge arguments are inconsistent')
  }
  return profile
}

function environments(profile, source, askpassPath, { installed = false } = {}) {
  const transcriptionSecret = profile.transcriptionApiKeyEnv ? source[profile.transcriptionApiKeyEnv] : null
  const authSecret = profile.marketplaceAuthEnv ? source[profile.marketplaceAuthEnv] : (source.GH_TOKEN || source.GITHUB_TOKEN)
  if (!profile.systemdUnit && profile.transcriptionApiKeyEnv && !transcriptionSecret) throw new Error(`${profile.transcriptionApiKeyEnv} is unavailable for bridge restart`)
  if (!installed && profile.marketplaceAuthEnv && !authSecret) throw new Error(`${profile.marketplaceAuthEnv} is unavailable for marketplace authentication`)
  const { env: runtimeEnv, secrets } = runtimeEnvironment(source, {
    transcriptionKeyEnv: profile.transcriptionApiKeyEnv, marketplaceAuthEnv: profile.marketplaceAuthEnv,
  })
  if (transcriptionSecret && authSecret === transcriptionSecret) {
    throw new Error('transcription and marketplace authentication slots alias the same credential')
  }
  const local = Object.fromEntries(Object.entries(runtimeEnv).filter(([name]) => SYSTEM_ENV.test(name)))
  const network = { ...local, ...Object.fromEntries(Object.entries(runtimeEnv).filter(([name]) => PROXY_ENV.test(name))) }
  const clean = { ...local }
  Object.assign(clean, {
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  })
  const authenticated = { ...network, ...clean }
  if (authSecret) Object.assign(authenticated, {
    GH_TOKEN: authSecret, GIT_ASKPASS: askpassPath, GIT_ASKPASS_REQUIRE: 'force',
  })
  const bridge = { ...source, GELIOS_TELEGRAM_LAUNCHER_LINK: profile.launcherLink }
  return {
    read: clean,
    authenticated,
    bridge,
    validation: local,
    installation: network,
    secrets,
  }
}

function controlRequest(path, request, timeoutMs = 2000) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection(path)
    let buffer = ''; let done = false
    const finish = (error, value) => {
      if (done) return
      done = true; clearTimeout(timer); socket.destroy()
      if (error) reject(error); else resolvePromise(value)
    }
    const timer = setTimeout(() => finish(new Error('bridge control request timed out')), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length > MAX_OUTPUT) return finish(new Error('bridge control response is too large'))
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, newline))
        if (!response.ok) return finish(Object.assign(new Error(response.error || 'bridge rejected the request'), { code: response.code }))
        finish(null, response.result)
      } catch (error) { finish(error) }
    })
    socket.on('error', error => finish(error))
  })
}

function assertIdle(status, identityOf = processIdentity) {
  if (!Number.isSafeInteger(status?.pid) || status.pid <= 1) throw new Error('bridge returned an invalid process ID')
  if (!/^\d+$/.test(status.identity || '') || identityOf(status.pid) !== status.identity) throw new Error('bridge returned an invalid process identity')
  if (!/^[a-f0-9]{32}$/.test(status.instanceId || '')) throw new Error('bridge returned an invalid instance ID')
  if (status.appRunning !== true) throw new Error('the Codex app-server is not running')
  if (status.tuiAttached) throw busyUpdate('exit the attached Codex TUI before updating')
  if (status.turnId) throw busyUpdate('wait for the active Codex turn to finish before updating')
  if (status.updatePrepared) throw busyUpdate('the bridge is already preparing for an update; retry shortly')
  return status.pid
}

async function waitForExit(pid, timeoutMs = 15_000, identity = null) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const currentIdentity = identity ? processIdentity(pid) : null
    if (currentIdentity && currentIdentity !== identity) return true
    try { process.kill(pid, 0) } catch (error) { if (error?.code === 'ESRCH') return true; throw error }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  return false
}

const processIdentity = pid => processInfo(pid)?.identity || null

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function waitForStatus(control, path, expectedPid, expectedInstance, timeoutMs = 5000, requireReady = false) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const status = await control(path, { action: 'status' })
      if (status?.pid === expectedPid && status.instanceId === expectedInstance && /^\d+$/.test(status.identity || '') &&
          processIdentity(status.pid) === status.identity && status.appRunning === true && (!requireReady || status.ready)) return status
      lastError = new Error('replacement bridge returned an unexpected process or instance ID')
    } catch (error) { lastError = error }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(`replacement bridge health check failed: ${lastError?.message || 'unavailable'}`)
}

function sameBridge(status, expected) {
  return status?.pid === expected.pid && status.identity === expected.identity && status.instanceId === expected.instanceId
}

function savedConversation(profile, write = () => {}) {
  let binding
  try { binding = new StateStore(profile.stateDir).loadBinding() }
  catch (error) { write(`Ignoring unreadable saved binding: ${error.message}\n`) }
  return binding?.threadId && binding.initialize
    ? { threadId: binding.threadId, workspace: binding.workspace || profile.workspace }
    : { threadId: null, workspace: profile.workspace }
}

// Only consecutive failed reads have an updater deadline. A valid in-flight
// answer renews that tolerance; the bridge owns restoration's RPC deadlines.
async function waitForPreservation(control, path, expected, conversation, {
  identityOf = processIdentity, timeoutMs = 15_000, policy = false, live = false,
  now = Date.now, sleep = delay,
} = {}) {
  let failedSince = null, status
  const fail = message => Object.assign(new Error(message), { preservationFailed: true, verifiedStatus: status })
  while (true) {
    if (identityOf(expected.pid) !== expected.identity) throw new Error('conversation check lost the expected bridge process')
    try { status = await control(path, { action: 'status' }) }
    catch (error) {
      if (identityOf(expected.pid) !== expected.identity) throw new Error('conversation check lost the expected bridge process')
      failedSince ??= now()
      if (now() - failedSince >= timeoutMs) throw new Error(`conversation status remains unavailable: ${error.message}`)
      await sleep(50); continue
    }
    if (!sameBridge(status, expected) || identityOf(status.pid) !== status.identity) throw new Error('conversation check read a different bridge process or instance')
    if (status.appRunning !== true) throw new Error('conversation check found no running Codex app-server')
    if (status.restoration != null) throw fail(`conversation restoration failed (${status.restoration.permanent ? 'permanent' : 'temporary'}): ${status.restoration.error || JSON.stringify(status.restoration)}`)
    if (live && status.ready) return status
    if (!conversation.threadId) {
      if (status.threadId === null) return status
      throw fail('conversation check expected an unbound bridge')
    }
    if (status.ready) {
      if (status.threadId !== conversation.threadId || status.workspace !== conversation.workspace) throw fail('conversation restoration returned a different conversation or workspace')
      if (policy && !isYoloPolicy(status.permissions)) throw fail(`conversation restoration is outside YOLO mode: ${JSON.stringify(status.permissions)}`)
      return status
    }
    if (!Object.hasOwn(status, 'restoration')) throw fail('conversation restoration status is missing')
    failedSince = null
    await sleep(50)
  }
}

function enforcingBuild(root, candidate = null) {
  const digest = pluginDigest(root, null, 0o700)
  return digest === pluginDigest(pluginRoot, null, 0o700) || Boolean(candidate?.restoresYolo === true && digest === candidate.contentDigest)
}

function sweepTransactions(stateDir, profile, status, protectedRoots, write) {
  const parent = join(stateDir, 'update-transactions')
  if (!existsSync(parent)) return
  try {
    const info = lstatSync(parent)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077 || trustedDirectory(parent, 'update transactions') !== parent)
      throw new Error('transaction parent is not an owner-only directory')
    if (!status?.pluginRoot) throw new Error('live bridge code reference is unavailable')
    const roots = [pluginRoot, realpathSync(profile.launcherLink), status.pluginRoot, ...protectedRoots]
    const journal = join(stateDir, 'update-transaction.json')
    if (existsSync(journal)) {
      const id = JSON.parse(readFileSync(trustedFile(journal, 'update journal'), 'utf8')).id
      if (!/^[a-f0-9]{32}$/.test(id || '')) throw new Error('transaction reference is invalid')
      roots.push(snapshotPaths(stateDir, id).transactionRoot)
    }
    for (const name of readdirSync(parent)) {
      if (!/^[a-f0-9]{32}(?:\.tmp-\d+)?$/.test(name)) continue
      const path = join(parent, name), stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) continue
      if (roots.some(root => root === path || root.startsWith(path + '/'))) continue
      try { rmSync(path, { recursive: true }); syncPath(parent) }
      catch (error) { write(`Transaction cleanup deferred: ${error.message}\n`) }
    }
  } catch (error) { write(`Transaction cleanup deferred: ${error.message}\n`) }
}

async function runtimeOwnership(stateDir, transaction, dependencies) {
  if (!transaction.previousRuntime || transaction.bootId !== dependencies.bootOf()) return 'gone'
  let live
  try { live = await dependencies.runtimeStatus(stateDir) }
  catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) return 'unknown'
    if (error.code === 'ECONNREFUSED') {
      const path = runtimeSocket(stateDir)
      let stat
      try { stat = lstatSync(path) }
      catch (readError) { return readError.code === 'ENOENT' && !dependencies.exists(transaction.previousRuntime.appPid) ? 'gone' : 'unknown' }
      if (!stat.isSocket() || stat.uid !== process.getuid() || stat.mode & 0o077) return 'unknown'
    }
    return dependencies.exists(transaction.previousRuntime.appPid) ? 'unknown' : 'gone'
  }
  if (live.instanceId === transaction.previousRuntime.instanceId && live.appPid === transaction.previousRuntime.appPid) return 'previous'
  return dependencies.exists(transaction.previousRuntime.appPid) ? 'unknown' : 'gone'
}

async function controlStatus(control, path, {
  allowStale = false, bootChanged = false, receipts = [], awaitExit = waitForExit,
} = {}) {
  try { return await control(path, { action: 'status' }) } catch (error) {
    if (error?.code === 'ENOENT') return null
    if (error?.code === 'ECONNREFUSED' && allowStale) {
      if (!bootChanged) {
        for (const receipt of receipts) {
          if (!(await awaitExit(receipt.pid, 50, receipt.identity))) {
            throw new Error('bridge control socket could not be classified: a recorded bridge process is still running')
          }
        }
      }
      let info
      try { info = lstatSync(path) } catch (statError) {
        if (statError?.code === 'ENOENT') return null
        throw new Error(`bridge control socket could not be classified: ${statError.message}`)
      }
      if (!info.isSocket() || (process.getuid && info.uid !== process.getuid())) {
        throw new Error('bridge control socket could not be classified: refused path is not an owner-controlled socket')
      }
      return null
    }
    throw new Error(`bridge control socket could not be classified: ${error.message}`)
  }
}

async function stopBridge(control, path, expected, awaitExit, action = 'shutdown_instance', timeoutMs = 30_000) {
  const status = await controlStatus(control, path)
  if (!status) {
    if (await awaitExit(expected.pid, 50, expected.identity)) return
    throw new Error('known bridge is still running without its control socket; refusing to signal it')
  }
  if (!sameBridge(status, expected)) throw new Error('the control socket is owned by an unexpected bridge; refusing shutdown')
  let response
  try { response = await control(path, { action, instanceId: expected.instanceId }, timeoutMs) } catch (error) {
    if (error.code === 'UPDATE_BUSY') throw error
    if (!(await awaitExit(expected.pid, 15_000, expected.identity))) throw error
  }
  if (response && (!sameBridge(response, expected) || response.stopping !== true)) throw new Error('bridge returned an invalid shutdown receipt')
  if (!(await awaitExit(expected.pid, 15_000, expected.identity))) throw new Error(`bridge ${expected.pid} did not stop itself`)
  if (await controlStatus(control, path)) throw new Error('a bridge still owns the control socket after shutdown')
}

function detachedProcess(stdout, label, expectedInstance = null) {
  const result = parseJson(stdout, label)
  if (!Number.isSafeInteger(result.pid) || result.pid <= 1) throw new Error(`${label} returned an invalid process ID`)
  if (!/^\d+$/.test(result.identity || '')) throw new Error(`${label} returned an invalid process identity`)
  if (!/^[a-f0-9]{32}$/.test(result.instanceId || '')) throw new Error(`${label} returned an invalid instance ID`)
  if (expectedInstance && result.instanceId !== expectedInstance) throw new Error(`${label} returned an unexpected instance ID`)
  return { pid: result.pid, identity: result.identity, instanceId: result.instanceId }
}

function atomicSymlink(path, target) {
  const temporary = join(dirname(path), `.${resolve(path).split('/').pop()}.update-${process.pid}-${randomBytes(4).toString('hex')}`)
  try { symlinkSync(target, temporary); renameSync(temporary, path); syncPath(dirname(path)) } finally { try { if (existsSync(temporary)) unlinkSync(temporary) } catch {} }
}

function snapshotPaths(stateDir, id) {
  const parent = join(stateDir, 'update-transactions')
  const transactionRoot = join(parent, id)
  return { parent, transactionRoot, root: join(transactionRoot, 'previous-plugin') }
}

function createSnapshot(stateDir, runningRoot, id) {
  const contentDigest = pluginDigest(runningRoot, null, 0o700); const paths = snapshotPaths(stateDir, id)
  const files = pluginFiles(runningRoot)
  mkdirSync(paths.parent, { recursive: true, mode: 0o700 }); chmodSync(paths.parent, 0o700)
  const temporary = `${paths.transactionRoot}.tmp-${process.pid}`
  try {
    copyPluginTree(runningRoot, join(temporary, 'previous-plugin'))
    syncPath(temporary); renameSync(temporary, paths.transactionRoot); syncPath(paths.parent)
    const root = trustedDirectory(paths.root, 'plugin snapshot')
    return {
      root, digest: pluginDigest(root, files), contentDigest,
      launcher: join(root, 'bin', 'gelios-codex-telegram'),
      askpass: join(root, 'scripts', 'git-askpass.js'),
      updater: join(root, 'scripts', 'update.js'),
    }
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error }
}

function writeTransaction(stateDir, transaction, phase, additions = {}) {
  Object.assign(transaction, additions, { phase })
  durableJson(join(stateDir, 'update-transaction.json'), transaction)
}

function readTransaction(stateDir, profile) {
  const path = join(stateDir, 'update-transaction.json')
  let info
  try { info = lstatSync(path) } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('update transaction journal is not an owner-only regular file')
  }
  const value = parseJson(readFileSync(path, 'utf8'), 'update transaction journal')
  const digest = createHash('sha256').update(JSON.stringify(profile)).digest('hex')
  const expected = /^[a-f0-9]{32}$/.test(value.id || '') ? snapshotPaths(stateDir, value.id) : null
  const validManaged = managed => {
    if (!managed) return true; if (managed.restoresYolo !== undefined && typeof managed.restoresYolo !== 'boolean') return false
    if (managed.contentDigest !== undefined && !/^[a-f0-9]{64}$/.test(managed.contentDigest)) return false
    if (managed.instanceId === undefined) return managed.pid === undefined && managed.identity === undefined
    return /^[a-f0-9]{32}$/.test(managed.instanceId || '') &&
      (managed.pid === undefined || (Number.isSafeInteger(managed.pid) && managed.pid > 1 && /^\d+$/.test(managed.identity || '')))
  }
  if (value.version !== 1 || !/^[a-f0-9-]{16,64}$/.test(value.bootId || '') || value.profileDigest !== digest ||
      !expected || value.snapshot?.root !== expected.root ||
      !/^[a-f0-9]{64}$/.test(value.snapshot?.digest || '') || (value.snapshot.contentDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.snapshot.contentDigest)) || !Number.isSafeInteger(value.previous?.pid) ||
      !/^\d+$/.test(value.previous?.identity || '') || !/^[a-f0-9]{32}$/.test(value.previous?.instanceId || '') ||
      !validManaged(value.candidate) || !validManaged(value.recovery) ||
      (value.previousRuntime && (typeof value.previousRuntime.instanceId !== 'string' || !Number.isSafeInteger(value.previousRuntime.appPid) || value.previousRuntime.appPid <= 1)) ||
      (value.preservation && !((value.preservation.threadId === null || (typeof value.preservation.threadId === 'string' && value.preservation.threadId)) && isAbsolute(value.preservation.workspace || ''))) ||
      (value.installation && !/^[a-f0-9]{64}$/.test(value.snapshot?.coordinatorDigest || '')) ||
      (value.command && (!Number.isSafeInteger(value.command.pid) || !/^\d+$/.test(value.command.identity || '')))) throw new Error('update transaction journal is invalid')
  const root = trustedDirectory(expected.root, 'transaction snapshot')
  if (pluginDigest(root) !== value.snapshot.digest) throw new Error('transaction snapshot changed; refusing recovery')
  value.snapshot = {
    ...value.snapshot, root,
    launcher: join(root, 'bin', 'gelios-codex-telegram'),
    askpass: join(root, 'scripts', 'git-askpass.js'),
    updater: join(root, 'scripts', 'update.js'),
  }
  if (value.installation) validateInstallation(value.installation, profile, expected.transactionRoot)
  if (value.snapshot.coordinatorDigest) {
    const coordinator = join(expected.transactionRoot, 'coordinator')
    if (pluginDigest(coordinator) !== value.snapshot.coordinatorDigest) throw new Error('installation recovery code changed')
    value.snapshot.updater = join(coordinator, 'scripts', 'update.js')
  }
  return value
}

function clearTransaction(stateDir) {
  const path = join(stateDir, 'update-transaction.json')
  if (existsSync(path)) { unlinkSync(path); syncPath(stateDir) }
}

function validateManagedLauncher(profile, root) {
  const info = lstatSync(profile.launcherLink)
  if (!info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('the recorded managed launcher is not an owner-controlled symbolic link')
  }
  trustedDirectory(dirname(profile.launcherLink), 'the recorded managed launcher directory')
  const expected = trustedFile(join(root, 'bin', 'gelios-codex-telegram'), 'the running plugin launcher', {
    root, executable: true,
  })
  if (realpathSync(profile.launcherLink) !== expected) throw new Error('the managed launcher does not point to the running plugin')
  return expected
}

function repairMissingLauncher(profile, root, replaceLauncher) {
  const info = lstatSync(profile.launcherLink)
  if (!info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('the recorded managed launcher is not an owner-controlled symbolic link')
  trustedDirectory(dirname(profile.launcherLink), 'the recorded managed launcher directory')
  const target = resolve(dirname(profile.launcherLink), readlinkSync(profile.launcherLink))
  const oldRoot = dirname(dirname(target))
  if (basename(target) !== 'gelios-codex-telegram' || basename(dirname(target)) !== 'bin' ||
      !['telegram', 'gelios-codex-telegram'].some(name => [basename(oldRoot), basename(dirname(oldRoot))].includes(name))) {
    throw new Error('the missing managed launcher is not a recognized plugin installation')
  }
  const build = pinBuild(root, profile.stateDir)
  replaceLauncher(profile.launcherLink, build.launcher)
  return build.root
}

function installedCandidate(selected, env) {
  const parts = [selected.marketplaceName, selected.name, selected.version]
  if (parts.some(part => typeof part !== 'string' || !/^[A-Za-z0-9._+-]+$/.test(part) || part === '.' || part === '..')) throw new Error('Codex returned an invalid installed plugin identity')
  const cache = join(env.CODEX_HOME || join(homedir(), '.codex'), 'plugins', 'cache', ...parts)
  const installedPath = selected.installedPath || (existsSync(cache) ? cache : selected.marketplaceSource?.sourceType === 'local' ? selected.source?.path : cache)
  return { ...selected, installedPath }
}

function inspectCandidate(result, pluginName, marketplaceName, stateDir = null) {
  if (result.name !== pluginName || result.marketplaceName !== marketplaceName || typeof result.installedPath !== 'string' || !isAbsolute(result.installedPath)) {
    throw new Error('Codex returned an invalid installed plugin candidate')
  }
  const root = trustedDirectory(result.installedPath, 'installed plugin candidate')
  if (stateDir && root.startsWith(join(realpathSync(stateDir), 'update-transactions') + '/')) throw new Error('Codex selected the private rollback snapshot as the update candidate')
  const manifestPath = trustedFile(join(root, '.codex-plugin', 'plugin.json'), 'candidate manifest', { root })
  const manifest = parseJson(readFileSync(manifestPath, 'utf8'), 'candidate manifest')
  if (manifest.name !== pluginName || (result.version && manifest.version !== result.version)) throw new Error('installed plugin candidate has an invalid manifest identity')
  return { root, version: result.version || manifest.version || 'unknown', contentDigest: pluginDigest(root, null, 0o700) }
}

async function validateNextBuild(result, pluginName, marketplaceName, { stateDir, run = runCommand, env = process.env, secrets = [] }) {
  const inspected = inspectCandidate(result, pluginName, marketplaceName, stateDir)
  const build = pinBuild(inspected.root, stateDir)
  if (build.contentDigest !== inspected.contentDigest) throw new Error('candidate changed while being pinned')
  const updater = trustedFile(join(build.root, 'scripts', 'update.js'), 'candidate validation entry', { root: build.root })
  const input = JSON.stringify({ result: { ...result, installedPath: build.root }, pluginName, marketplaceName, stateDir })
  const validation = parseJson((await run(process.execPath, [updater, '--validate-candidate', input], {
    cwd: build.root, env, secrets, label: 'candidate self-validation', timeoutMs: 30_000,
  })).stdout, 'candidate self-validation')
  if (validation.root !== build.root || validation.contentDigest !== build.contentDigest || validation.version !== inspected.version ||
      pluginDigest(build.root, null, 0o700) !== build.contentDigest) throw new Error('candidate validation receipt does not match the pinned build')
  return { ...inspected, root: build.root, runtimeProtocol: validation.runtimeProtocol || null, restoresYolo: validation.restoresYolo === true, launcher: trustedFile(validation.launcher, 'candidate launcher', { root: build.root, executable: true }) }
}

// The candidate reads a private copy of the live state with its own code, so a candidate from this release
// on that cannot read it is refused before activation; only the activated bridge ever migrates the live
// files. An older candidate skips this check: the state this release writes only adds keys, which it ignores.
// The copy lives in the owner-only state directory, never the shared temp folder; one a killed preflight left
// behind is removed by the next, once it is older than any preflight runs.
const PREFLIGHT_STALE_MS = 10 * 60 * 1000
function preflightState(stateDir) {
  for (const name of readdirSync(stateDir)) {
    const path = join(stateDir, name)
    if (name.startsWith('.preflight-') && Date.now() - lstatSync(path).mtimeMs > PREFLIGHT_STALE_MS) rmSync(path, { recursive: true, force: true })
  }
  const copy = mkdtempSync(join(stateDir, '.preflight-'))
  try {
    for (const name of ['access.json', 'runtime.json', 'config.json']) if (existsSync(join(stateDir, name))) cpSync(join(stateDir, name), join(copy, name))
    const store = new StateStore(copy); store.loadAccess({ prune: false }); store.loadRuntime(); store.loadConfig()
  } catch (error) { throw new Error(`candidate cannot read the current state: ${error.message}`) }
  finally { rmSync(copy, { recursive: true, force: true }) }
}
function validateCandidate(result, pluginName, marketplaceName) {
  const inspected = inspectCandidate(result, pluginName, marketplaceName), { root } = inspected
  const manifestPath = join(root, '.codex-plugin', 'plugin.json')
  const launcher = trustedFile(join(root, 'bin', 'gelios-codex-telegram'), 'candidate launcher', { root, executable: true })
  const askpass = trustedFile(join(root, 'scripts', 'git-askpass.js'), 'candidate Git authentication helper', { root, executable: true })
  const bridge = trustedFile(join(root, 'scripts', 'bridge.js'), 'candidate bridge', { root })
  const updater = trustedFile(join(root, 'scripts', 'update.js'), 'candidate updater', { root })
  const mcpScript = trustedFile(join(root, 'scripts', 'mcp.js'), 'candidate MCP server', { root })
  const mcpPath = trustedFile(join(root, '.mcp.json'), 'candidate MCP manifest', { root })
  const manifest = parseJson(readFileSync(manifestPath, 'utf8'), 'candidate manifest')
  const mcp = parseJson(readFileSync(mcpPath, 'utf8'), 'candidate MCP manifest')
  if (manifest.mcpServers !== './.mcp.json') {
    throw new Error('installed plugin candidate has an invalid manifest or launcher')
  }
  const server = mcp.mcpServers?.[pluginName === 'telegram' ? 'telegram' : 'gelios-codex-telegram']
  const requiredEnv = ['GELIOS_TELEGRAM_CONTROL_SOCKET', 'GELIOS_TELEGRAM_STATE_DIR']
  const envVars = server?.env_vars
  const legacy = server?.cwd === '.' && JSON.stringify(server.args) === JSON.stringify(['./scripts/mcp.js'])
  const durable = server?.cwd === '/' && JSON.stringify(server.args) === JSON.stringify(['--input-type=module', '-e', mcpBootstrap]) && Array.isArray(envVars) && ['GELIOS_TELEGRAM_MCP_ROOT', 'CODEX_HOME'].every(name => envVars.includes(name))
  if (!server || server.command !== 'node' || (!legacy && !durable) ||
      !Array.isArray(envVars) || envVars.some(value => typeof value !== 'string') ||
      new Set(envVars).size !== envVars.length || requiredEnv.some(name => !envVars.includes(name)) ||
      server.required !== true || !Number.isFinite(server.startup_timeout_sec) || !Number.isFinite(server.tool_timeout_sec)) {
    throw new Error('installed plugin candidate has an invalid MCP manifest')
  }
  if (pluginName === 'telegram') {
    if (manifest.skills !== './skills/') throw new Error('installed plugin candidate has no setup skills')
    for (const path of ['bin/codex-telegram', 'scripts/setup.js', 'src/bootstrap.js', 'src/local-setup.js', 'scripts/restart.js', 'src/restart.js', 'src/systemd.js', 'skills/configure/SKILL.md', 'skills/access/SKILL.md']) {
      trustedFile(join(root, path), 'candidate setup asset', { root })
    }
  }
  return { ...inspected, launcher, bridge, updater, mcpScript, askpass,
    runtimeProtocol: existsSync(join(root, 'src/runtime.js')) && existsSync(join(root, 'scripts/runtime.js')) ? 1 : null, restoresYolo: true }
}

async function launchBridge(launcher, label, instanceId, profile, commandEnvs, dependencies, onReceipt = null) {
  const { run, control, awaitStatus, identityOf, exists } = dependencies
  const result = await run(launcher, ['bridge', '--detach', '--json', ...profile.bridgeArgs], {
    cwd: profile.cwd, env: { ...commandEnvs.bridge, GELIOS_TELEGRAM_INSTANCE_ID: instanceId },
    label, secrets: commandEnvs.secrets, timeoutMs: 25_000,
  })
  const tracked = detachedProcess(result.stdout, label, instanceId)
  const observedIdentity = identityOf(tracked.pid)
  if (!observedIdentity) {
    if (!exists(tracked.pid)) throw new Error(`${label} exited before its identity could be verified`)
    throw new Error(`${label} process identity could not be verified`)
  }
  if (observedIdentity !== tracked.identity) throw new Error(`${label} process identity changed before its health check`)
  onReceipt?.(tracked)
  await awaitStatus(control, profile.controlSocket, tracked.pid, tracked.instanceId)
  return tracked
}

async function recoverTransaction(stateDir, profile, transaction, commandEnvs, dependencies) {
  const { control, awaitExit, identityOf, replaceLauncher, bootOf, write } = dependencies
  const snapshot = transaction.snapshot
  if (transaction.command?.pid && identityOf(transaction.command.pid) === transaction.command.identity) {
    const remaining = Math.max(1000, Math.min(120_000, Number(transaction.command.deadline || 0) - Date.now() + 1000))
    if (!(await awaitExit(transaction.command.pid, remaining, transaction.command.identity)))
      throw new Error('the exact update subprocess is still running; refusing concurrent recovery')
  }
  const managed = [transaction.previous, transaction.candidate, transaction.recovery].filter(value => value?.instanceId)
  const receipts = managed.filter(value => value?.pid), bootChanged = transaction.bootId !== bootOf()
  let status = await controlStatus(control, profile.controlSocket, {
    allowStale: bootChanged || !managed.some(value => !value.pid), bootChanged, receipts, awaitExit,
  })
  if (status && (!/^\d+$/.test(status.identity || '') || identityOf(status.pid) !== status.identity))
    throw new Error('the bridge owning the control socket has an unverifiable process identity')
  dependencies.assertMigrationSafe(status, profile, snapshot.root)
  const previousLive = status && sameBridge(status, transaction.previous)
  const matchesReceipt = receipt => receipt?.pid ? sameBridge(status, receipt) : receipt?.instanceId === status?.instanceId
  const candidateLive = status && matchesReceipt(transaction.candidate)
  const recoveryLive = status && matchesReceipt(transaction.recovery)
  if (status && !previousLive && !candidateLive && !recoveryLive)
    throw new Error('an unknown bridge owns the control socket; interrupted update recovery refused')
  const legacy = Boolean(transaction.candidate?.instanceId && !transaction.preservation)
  const current = savedConversation(profile, write)
  const historical = legacy && transaction.installation && Object.hasOwn(transaction.installation, 'threadId')
    ? { threadId: transaction.installation.threadId, workspace: transaction.installation.workspace } : null
  const expected = transaction.preservation || historical || current
  const finish = async (build, receipt, { foundLive = false, preservedRuntime = false, native = transaction.previousRuntime, timeoutMs = 15_000 } = {}) => {
    let recovered, preservationError, installationError
    try {
      recovered = await waitForPreservation(control, profile.controlSocket, receipt,
        foundLive ? savedConversation(profile, write) : expected,
        { identityOf, timeoutMs, live: foundLive, policy: !foundLive && enforcingBuild(build.root, transaction.candidate) })
    } catch (error) {
      if (!error.preservationFailed) throw error
      preservationError = error
      recovered = error.verifiedStatus
      if (!sameBridge(recovered, receipt) || identityOf(recovered.pid) !== recovered.identity || !recovered.appRunning) throw error
    }
    if (native && (recovered.runtime?.instanceId !== native.instanceId || recovered.appPid !== native.appPid) &&
        (preservedRuntime || await runtimeOwnership(stateDir, transaction, dependencies) !== 'gone'))
      throw new Error('recovery did not reconnect to the preserved native runtime')
    if (transaction.installation) try { verifyInstallationState(transaction.installation) } catch (error) { installationError = error }
    if (foundLive) {
      const binding = savedConversation(profile, write)
      if (recovered.threadId !== binding.threadId || recovered.workspace !== binding.workspace)
        write('Recovery kept the live bridge; its current binding and status disagree.\n')
    } else if (legacy && (!historical || (historical.threadId === null && current.threadId) ||
        recovered.threadId !== historical.threadId || recovered.workspace !== historical.workspace)) {
      preservationError = Object.assign(new Error('unverified historical preservation: the old update record cannot prove the saved conversation'), { unverified: true })
    }
    replaceLauncher(profile.launcherLink, build.launcher)
    clearTransaction(stateDir)
    dependencies.cleanup(recovered)
    const keptPrevious = foundLive && previousLive && !transaction.candidate?.instanceId && !transaction.installation?.mutated
    if (installationError) write(`Recovery retained changed installation state: ${installationError.message}\n`)
    if (preservationError) throw Object.assign(new Error(`Recovery completed${preservationError.unverified ? '; ' : ' with a conversation preservation failure: '}${preservationError.message}`), { recoverySettled: true })
    if (installationError && !keptPrevious) throw Object.assign(new Error(`Recovery completed with an installation state change: ${installationError.message}`), { recoverySettled: true })
    return { root: build.root, status: recovered, preservedRuntime }
  }
  if (!existsSync(join(snapshot.root, 'src/runtime.js')) && existsSync(runtimeSocket(stateDir))) {
    const live = await dependencies.runtimeStatus(stateDir)
    const compatible = pinBuild(pluginRoot, stateDir)
    if (!existsSync(join(compatible.root, 'src/runtime.js'))) throw new Error('persistent runtime needs a compatible recovery build')
    replaceLauncher(profile.launcherLink, compatible.launcher)
    if (!status && !bootChanged) for (const receipt of receipts) {
      if (identityOf(receipt.pid) === receipt.identity) throw new Error('a transaction bridge is still running without a classifiable control socket')
    }
    if (previousLive) throw new Error('an embedded bridge and a persistent runtime are both live; their work was left intact')
    if (status) await stopBridge(control, profile.controlSocket, status, awaitExit)
    const instanceId = randomBytes(16).toString('hex')
    writeTransaction(stateDir, transaction, 'recovery_starting', { recovery: { instanceId } })
    const receipt = await launchBridge(compatible.launcher, 'persistent runtime messaging recovery', instanceId, profile, commandEnvs, dependencies,
      started => writeTransaction(stateDir, transaction, 'recovery_started', { recovery: { instanceId, ...started } }))
    return finish(compatible, receipt, { preservedRuntime: true, native: live, timeoutMs: 30_000 })
  }
  if (transaction.installation?.mutated) {
    // Observe the native owner before stopping messaging: a new runtime after a
    // reboot must keep its current package, while the old one keeps its inode.
    const ownership = await runtimeOwnership(stateDir, transaction, dependencies)
    if (status) { await stopBridge(control, profile.controlSocket, status, awaitExit); status = null }
    for (const message of restoreInstallation(transaction.installation, { runtimeOwnership: ownership })) write(`${message}\n`)
  }
  const root = !existsSync(join(snapshot.root, 'src/runtime.js')) && existsSync(join(dependencies.recoveryRoot, 'src/runtime.js'))
    ? dependencies.recoveryRoot : snapshot.root
  const recoveryBuild = pinBuild(root, stateDir)
  replaceLauncher(profile.launcherLink, recoveryBuild.launcher)
  if (status?.appRunning === true && (recoveryLive || (previousLive && !status.updatePrepared)))
    return finish(recoveryBuild, status, { foundLive: true })
  if (status) await stopBridge(control, profile.controlSocket, status, awaitExit)
  else if (!bootChanged) for (const receipt of receipts) {
    if (identityOf(receipt.pid) === receipt.identity) throw new Error('a transaction bridge is still running without a classifiable control socket')
  }
  await dependencies.assertMigrationStopped(profile)
  const instanceId = randomBytes(16).toString('hex')
  writeTransaction(stateDir, transaction, 'recovery_starting', { recovery: { instanceId } })
  const receipt = await launchBridge(recoveryBuild.launcher, 'snapshot bridge recovery', instanceId, profile, commandEnvs, dependencies,
    started => writeTransaction(stateDir, transaction, 'recovery_started', { recovery: { instanceId, ...started } }))
  writeTransaction(stateDir, transaction, 'recovery_healthy', { recovery: receipt })
  return finish(recoveryBuild, receipt)
}

async function runUpdate(options = {}, dependencies = {}) {
  if ((options.env || process.env).GELIOS_CODEX_CHILD === '1') throw new Error('run update from the parent terminal, not from inside Codex')
  const stateDir = resolve(options.stateDir || defaultStateDir())
  const env = options.env || process.env
  const run = dependencies.run || runCommand
  const control = dependencies.control || controlRequest
  const awaitExit = dependencies.waitForExit || waitForExit
  const awaitStatus = dependencies.waitForStatus || waitForStatus
  const identityOf = dependencies.processIdentity || processIdentity
  const exists = dependencies.processExists || processExists
  const replaceLauncher = dependencies.atomicSymlink || atomicSymlink
  const bootOf = dependencies.bootIdentity || bootIdentity
  const write = dependencies.write || (message => process.stdout.write(message))
  const protectedRoots = new Set()
  let profile, cleanupReady = false
  const cleanup = status => {
    if (status && identityOf(status.pid) === status.identity) { cleanupReady = true; sweepTransactions(stateDir, profile, status, [...protectedRoots], write) }
    else write('Transaction cleanup deferred: bridge ownership is unavailable.\n')
  }
  const deps = { write, cleanup, runtimeStatus: dependencies.runtimeStatus || runtimeStatus, run, control, awaitExit, awaitStatus, identityOf, exists, replaceLauncher, bootOf, recoveryRoot: dependencies.recoveryRoot || pluginRoot, assertMigrationSafe: dependencies.assertMigrationSafe || assertMigrationSafe, assertMigrationStopped: dependencies.assertMigrationStopped || assertMigrationStopped }
  if (!existsSync(stateDir)) throw new Error('Telegram bridge state is missing; start the detached bridge before updating')
  const stateInfo = statSync(stateDir)
  if (!stateInfo.isDirectory() || (stateInfo.mode & 0o777) !== 0o700 || (process.getuid && stateInfo.uid !== process.getuid())) {
    throw new Error('Telegram bridge state directory must be owner-only (mode 0700)')
  }
  let release, attempt
  try {
    release = acquireLock(join(stateDir, 'update-locks'))
    attempt = options.automatic ? automaticAttempt(stateDir) : null
    if (attempt) automaticAttempt(stateDir, { ...attempt, pid: process.pid, identity: processIdentity(process.pid), bootId: bootIdentity() })
    else automaticAttempt(stateDir, null)
    profile = readProfile(stateDir)
    let runningRoot
    let initialStatus
    let discoveryRun = run
    const interrupted = readTransaction(stateDir, profile)
    if (interrupted) {
      protectedRoots.add(snapshotPaths(stateDir, interrupted.id).transactionRoot)
      const recoveryEnvs = environments(profile, env, interrupted.snapshot.askpass, options)
      discoveryRun = withCommandSupervisor(run, interrupted.snapshot.updater)
      const recoveryDeps = {
        ...deps, run: discoveryRun,
      }
      const recovered = await recoverTransaction(stateDir, profile, interrupted, recoveryEnvs, recoveryDeps)
      runningRoot = recovered.root; initialStatus = recovered.status
    }
    if (!runningRoot) {
      try { runningRoot = trustedDirectory(dependencies.pluginRoot || dirname(dirname(realpathSync(profile.launcherLink))), 'the running plugin') }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        runningRoot = repairMissingLauncher(profile, dependencies.recoveryRoot || pluginRoot, replaceLauncher)
      }
      // A dispatcher can supply the current installed build while the recorded
      // service link still names a cache folder Codex already removed.
      try { realpathSync(profile.launcherLink) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        runningRoot = repairMissingLauncher(profile, runningRoot, replaceLauncher)
      }
    }
    const askpassPath = trustedFile(join(runningRoot, 'scripts', 'git-askpass.js'), 'the plugin Git authentication helper', {
      root: runningRoot, executable: true,
    })
    const commandEnvs = environments(profile, env, askpassPath, options)
    validateManagedLauncher(profile, runningRoot)
    let codexBin = trustedFile(profile.codexBin, 'the recorded Codex binary', { executable: true, allowRoot: true })
    let startedInitial = null
    const initialExpectation = savedConversation(profile, write)
    if (!initialStatus) {
      try { initialStatus = await control(profile.controlSocket, { action: 'status' }) }
      catch (error) {
        if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error
        await deps.assertMigrationStopped(profile)
        let recoveryRoot = runningRoot
        if (!existsSync(join(runningRoot, 'src/runtime.js'))) {
          if (options.automatic) throw new Error('first migration requires the current updater after an explicit embedded-runtime stop')
          recoveryRoot = dependencies.recoveryRoot || pluginRoot
          if (!existsSync(join(recoveryRoot, 'src/runtime.js')) && !dependencies.recoveryRoot)
            throw new Error('first migration requires an independent-runtime release')
        }
        const durable = pinBuild(recoveryRoot, stateDir)
        replaceLauncher(profile.launcherLink, durable.launcher)
        runningRoot = durable.root
        startedInitial = await launchBridge(durable.launcher, 'existing conversation recovery', randomBytes(16).toString('hex'), profile, commandEnvs, deps)
        initialStatus = await control(profile.controlSocket, { action: 'status' })
      }
    }
    deps.assertMigrationSafe(initialStatus, profile, runningRoot)
    cleanup(initialStatus)
    initialStatus = await waitForPreservation(control, profile.controlSocket, startedInitial || initialStatus, initialExpectation,
      { identityOf, live: !startedInitial, policy: Boolean(startedInitial && enforcingBuild(runningRoot)) })
    const baseline = { ...initialStatus }
    let idleBinding = savedConversation(profile, write)
    initialStatus = await control(profile.controlSocket, { action: 'status' })
    if (options.all) {
      let waiting = false
      while (initialStatus.turnId) {
        if (!waiting) { write('Waiting for the current Codex turn to finish.\n'); waiting = true }
        if (initialStatus.tuiAttached) throw new Error('exit the attached Codex TUI, then run codex-telegram update from the parent terminal')
        await delay(250); idleBinding = savedConversation(profile, write); initialStatus = await control(profile.controlSocket, { action: 'status' })
      }
    }
    const oldPid = assertIdle(initialStatus, identityOf)
    if (!sameBridge(initialStatus, baseline) || initialStatus.threadId !== idleBinding.threadId || initialStatus.workspace !== idleBinding.workspace ||
        initialStatus.threadId !== baseline.threadId || initialStatus.workspace !== baseline.workspace)
      throw busyUpdate('the live conversation binding changed while admitting the update; retry when idle')
    ;(dependencies.assertMigrationSafe || assertMigrationSafe)(initialStatus, profile, runningRoot)
    const oldProcess = { pid: oldPid, identity: initialStatus.identity, instanceId: initialStatus.instanceId }
    const manifestPath = trustedFile(join(runningRoot, '.codex-plugin', 'plugin.json'), 'the running plugin manifest', { root: runningRoot })
    const manifest = parseJson(readFileSync(manifestPath, 'utf8'), 'running plugin manifest')
    const currentManifest = parseJson(readFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'), 'updater plugin manifest')
    const target = dependencies.targetPlugin || (manifest.name === 'gelios-codex-telegram' && currentManifest.name === 'telegram'
      ? { name: 'telegram', marketplaceName: 'codex-telegram' } : { name: manifest.name })
    const list = parseJson((await discoveryRun(codexBin, ['plugin', 'list', '--json'], {
      cwd: profile.cwd, env: commandEnvs.read, label: 'Codex plugin discovery', secrets: commandEnvs.secrets,
    })).stdout, 'Codex plugin discovery')
    const installed = Array.isArray(list.installed) ? list.installed.filter(item => item?.name === target.name && item.installed !== false &&
      (!target.marketplaceName || item.marketplaceName === target.marketplaceName)) : []
    if (installed.length !== 1) throw new Error(`expected one installed ${target.name} plugin, found ${installed.length}`)
    const selected = installed[0]
    const migrating = target.name !== manifest.name
    const previousSelections = migrating && Array.isArray(list.installed)
      ? list.installed.filter(item => item?.name === manifest.name && item.installed !== false) : []
    if (previousSelections.length > 1) throw new Error('legacy plugin selection is ambiguous; migration did not change the bridge')
    if (selected.enabled !== true || typeof selected.marketplaceName !== 'string' || !selected.marketplaceName) {
      throw new Error('the running plugin is not enabled from a named marketplace')
    }
    const marketplaces = parseJson((await discoveryRun(codexBin, ['plugin', 'marketplace', 'list', '--json'], {
      cwd: profile.cwd, env: commandEnvs.read, label: 'Codex marketplace discovery', secrets: commandEnvs.secrets,
    })).stdout, 'Codex marketplace discovery')
    const marketplaceMatches = Array.isArray(marketplaces.marketplaces)
      ? marketplaces.marketplaces.filter(item => item?.name === selected.marketplaceName) : []
    if (marketplaceMatches.length !== 1) throw new Error(`expected one ${selected.marketplaceName} marketplace, found ${marketplaceMatches.length}`)
    const id = randomBytes(16).toString('hex')
    const snapshot = createSnapshot(stateDir, runningRoot, id)
    let installation
    if (options.all || !existsSync(join(runningRoot, 'src/runtime.js'))) {
      const directory = snapshotPaths(stateDir, id).transactionRoot, coordinator = join(directory, 'coordinator')
      pluginDigest(pluginRoot); cpSync(pluginRoot, coordinator, { recursive: true }); chmodSync(coordinator, 0o700)
      packageDigest(coordinator, (path, name, stat) => { if (!stat.isSymbolicLink()) syncPath(path) }); syncPath(coordinator)
      snapshot.coordinatorDigest = pluginDigest(coordinator); snapshot.updater = join(coordinator, 'scripts', 'update.js')
    }
    if (options.all) {
      const directory = snapshotPaths(stateDir, id).transactionRoot
      try { installation = captureInstallation(profile, options.installerRoot, directory, env) }
      catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
      for (const component of ['codex', 'launcher']) { if (!installation[component].backup) continue; packageDigest(installation[component].backup, (path, name, stat) => { if (!stat.isSymbolicLink()) syncPath(path) }); syncPath(installation[component].backup) }
      installation.threadId = initialStatus.threadId; installation.workspace = initialStatus.workspace
    }
    const transaction = {
      version: 1, runtimeProtocol: 1, id, phase: 'snapshot_ready', createdAt: new Date().toISOString(),
      bootId: bootOf(),
      profileDigest: createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
      pluginName: target.name, marketplaceName: selected.marketplaceName,
      snapshot: { ...snapshot, version: manifest.version }, previous: oldProcess, candidate: null,
      ...(initialStatus.runtime ? { previousRuntime: { instanceId: initialStatus.runtime.instanceId, appPid: initialStatus.appPid } } : {}),
      ...(installation ? { installation } : {}),
    }
    writeTransaction(stateDir, transaction, 'snapshot_ready')
    const transactionEnvs = environments(profile, env, snapshot.askpass, options)
    const transactionRun = withCommandSupervisor(run, snapshot.updater)
    const transactionDeps = { ...deps, run: transactionRun }
    try {
      writeTransaction(stateDir, transaction, 'arming_fallback')
      replaceLauncher(profile.launcherLink, snapshot.launcher)
      if (realpathSync(profile.launcherLink) !== snapshot.launcher) throw new Error('snapshot launcher was not activated')
      writeTransaction(stateDir, transaction, 'fallback_armed')
      if (installation) {
        writeTransaction(stateDir, transaction, 'stopping_previous')
        ;(dependencies.assertMigrationSafe || assertMigrationSafe)(initialStatus, profile, runningRoot)
        await stopBridge(control, profile.controlSocket, oldProcess, awaitExit, 'stop_for_update', 180_000)
        const preservation = savedConversation(profile, write)
        Object.assign(installation, preservation)
        writeTransaction(stateDir, transaction, 'codex_updating', { preservation, installation: { ...installation, mutated: true }, command: null })
        await transactionRun(codexBin, ['update'], { cwd: profile.cwd, env: nativeUpdateEnvironment(installation, commandEnvs.installation), label: 'Codex CLI update', secrets: commandEnvs.secrets, timeoutMs: 600_000,
          onSpawn: receipt => writeTransaction(stateDir, transaction, 'codex_updating', { command: receipt }) })
        codexBin = trustedFile(profile.codexBin, 'the updated Codex binary', { executable: true, allowRoot: true })
        const version = (await transactionRun(codexBin, ['--version'], { cwd: profile.cwd, env: commandEnvs.read, label: 'updated Codex version', secrets: commandEnvs.secrets })).stdout.trim()
        if (!/^codex-cli \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error('The updated Codex did not report a valid version')
        const numbers = version.slice(10).split('.').map(Number)
        if (numbers[0] === 0 && numbers[1] < 162) throw new Error('The combined updater requires Codex CLI 0.162.0 or later')
        writeTransaction(stateDir, transaction, 'codex_updated', { codexVersion: version, command: null })
      }
      let install
      if (options.installed) install = installedCandidate(selected, env)
      else {
        let authenticatedEnv = transactionEnvs.authenticated
        if (profile.marketplaceAuthEnv) authenticatedEnv = { ...authenticatedEnv, GELIOS_GIT_AUTH_HOST: 'github.com', LC_ALL: 'C' }
        writeTransaction(stateDir, transaction, 'upgrading', { command: null })
        const upgrade = parseJson((await transactionRun(codexBin, ['plugin', 'marketplace', 'upgrade', selected.marketplaceName, '--json'], {
          cwd: profile.cwd, env: authenticatedEnv, label: 'Codex marketplace refresh', secrets: transactionEnvs.secrets,
          onSpawn: receipt => writeTransaction(stateDir, transaction, 'upgrading', { command: receipt }),
        })).stdout, 'Codex marketplace refresh')
        if (!Array.isArray(upgrade.errors) || upgrade.errors.length || !Array.isArray(upgrade.selectedMarketplaces) ||
            !upgrade.selectedMarketplaces.includes(selected.marketplaceName) || !Array.isArray(upgrade.upgradedRoots)) {
          throw new Error('Codex marketplace refresh did not complete cleanly')
        }
        writeTransaction(stateDir, transaction, 'marketplace_ready', { command: null })
        writeTransaction(stateDir, transaction, 'installing', { command: null })
        install = parseJson((await transactionRun(codexBin, ['plugin', 'add', `${target.name}@${selected.marketplaceName}`, '--json'], {
          cwd: profile.cwd, env: commandEnvs.read, label: 'Codex plugin install', secrets: commandEnvs.secrets,
          onSpawn: receipt => writeTransaction(stateDir, transaction, 'installing', { command: receipt }),
        })).stdout, 'Codex plugin install')
      }
      const candidate = await validateNextBuild(install, target.name, selected.marketplaceName, {
        stateDir, run: transactionRun, env: commandEnvs.validation, secrets: commandEnvs.secrets,
      })
      if (initialStatus.runtime && candidate.runtimeProtocol !== 1) throw new Error('cannot downgrade an attached persistent runtime to an embedded-runtime build')
      if (options.automatic && candidate.contentDigest !== attempt?.digest) throw new Error('automatic update candidate changed before cutover')
      writeTransaction(stateDir, transaction, 'candidate_validated', {
        candidate: { root: candidate.root, launcher: candidate.launcher, version: candidate.version, contentDigest: candidate.contentDigest, restoresYolo: candidate.restoresYolo }, command: null,
      })
      validateManagedLauncher(profile, snapshot.root)
      if (!installation) {
        ;(dependencies.assertMigrationSafe || assertMigrationSafe)(initialStatus, profile, runningRoot)
        const finalStatus = await control(profile.controlSocket, { action: 'status' })
        if (assertIdle(finalStatus, identityOf) !== oldPid || !sameBridge(finalStatus, oldProcess)) throw new Error('the live bridge changed during update staging')
      } else {
        const unexpected = await controlStatus(control, profile.controlSocket, { allowStale: true, receipts: [oldProcess], awaitExit })
        if (unexpected) throw new Error('another bridge appeared during installation update')
        writeTransaction(stateDir, transaction, 'launcher_updating', { command: null })
        const launcherVersion = await installLauncher(installation, marketplaceMatches[0].root, candidate.version, snapshotPaths(stateDir, id).transactionRoot, transactionRun,
          { cwd: profile.cwd, env: commandEnvs.installation, label: 'launcher update', secrets: commandEnvs.secrets, timeoutMs: 180_000,
            onSpawn: receipt => writeTransaction(stateDir, transaction, 'launcher_updating', { command: receipt }) })
        writeTransaction(stateDir, transaction, 'launcher_updated', { launcherVersion, command: null })
      }
      const sameVersion = !migrating && candidate.version === manifest.version
      if (sameVersion) {
        if (candidate.contentDigest !== snapshot.contentDigest) throw new Error('candidate plugin content changed without a new manifest version; publish a new version or cachebuster before updating')
      }
      if (!installation) {
        writeTransaction(stateDir, transaction, 'stopping_previous')
        await stopBridge(control, profile.controlSocket, oldProcess, awaitExit, 'stop_for_update', 180_000)
      }
      writeTransaction(stateDir, transaction, 'previous_stopped', installation ? {} : { preservation: savedConversation(profile, write) })
      for (const previous of previousSelections) {
        if (typeof previous.marketplaceName !== 'string' || !previous.marketplaceName) throw new Error('legacy plugin has no named marketplace')
        await transactionRun(codexBin, ['plugin', 'remove', `${previous.name}@${previous.marketplaceName}`, '--json'], {
          cwd: profile.cwd, env: commandEnvs.read, label: 'legacy plugin removal', secrets: commandEnvs.secrets,
        })
      }
      const instanceId = randomBytes(16).toString('hex')
      writeTransaction(stateDir, transaction, 'candidate_starting', {
        candidate: { ...transaction.candidate, instanceId },
      })
      if (candidate.runtimeProtocol === 1 && !existsSync(join(snapshot.root, 'src/runtime.js')))
        replaceLauncher(profile.launcherLink, pinBuild(pluginRoot, stateDir).launcher)
      const candidateProcess = await launchBridge(
        candidate.launcher, 'replacement bridge startup', instanceId, profile, transactionEnvs, transactionDeps,
        started => writeTransaction(stateDir, transaction, 'candidate_started', {
          candidate: { ...transaction.candidate, ...started },
        }),
      )
      writeTransaction(stateDir, transaction, 'candidate_healthy', { candidate: { ...transaction.candidate, ...candidateProcess } })
      const replacementStatus = await waitForPreservation(control, profile.controlSocket, candidateProcess, transaction.preservation,
        { identityOf, policy: candidate.restoresYolo })
      if (transaction.previousRuntime && (replacementStatus.runtime?.instanceId !== transaction.previousRuntime.instanceId ||
          replacementStatus.appPid !== transaction.previousRuntime.appPid)) throw new Error('Telegram replacement changed the persistent Codex runtime')
      if (installation) {
        const restored = replacementStatus
        if (restored.threadId !== installation.threadId || restored.workspace !== installation.workspace) throw new Error('The installation update did not restore the original conversation and workspace')
        if (installation.threadId && !isYoloPolicy(restored.permissions)) throw new Error(`The installation update restored the conversation outside YOLO mode: ${JSON.stringify(restored.permissions)}`)
        verifyInstallationState(installation)
        write(`Installed ${transaction.codexVersion}; launcher ${transaction.launcherVersion}.\n`)
        if (transaction.previousRuntime) write(`Running Codex is unchanged (${restored.runtime?.nativeUserAgent || 'version unverified'}). Finish native work and explicitly stop the runtime to adopt the installed Codex binary.\n`)
      }
      writeTransaction(stateDir, transaction, 'committing')
      replaceLauncher(profile.launcherLink, candidate.launcher)
      if (realpathSync(profile.launcherLink) !== candidate.launcher) throw new Error('replacement launcher was not activated')
      await awaitStatus(control, profile.controlSocket, candidateProcess.pid, candidateProcess.instanceId)
      writeTransaction(stateDir, transaction, 'committed')
      automaticAttempt(stateDir, null)
      clearTransaction(stateDir)
      try {
        if (target.name === 'telegram' && basename(profile.launcherLink) === 'gelios-codex-telegram')
          installLaunchers({ root: candidate.root, directory: dirname(profile.launcherLink), stateDir })
        pruneBuilds(stateDir, [candidate.root, pluginRoot, (await control(profile.controlSocket, { action: 'status' })).pluginRoot])
      }
      catch (error) { write(`Build cleanup deferred: ${error.message}\n`) }
      if (sameVersion) {
        write(`Refreshed ${target.name} ${candidate.version} from marketplace ${selected.marketplaceName}; bridge pid ${candidateProcess.pid}.\n`)
        return { updated: false, refreshed: true, version: candidate.version, marketplace: selected.marketplaceName, pid: candidateProcess.pid, ...(installation ? { codexVersion: transaction.codexVersion, launcherVersion: transaction.launcherVersion } : {}) }
      }
      write(`Updated ${target.name} to ${candidate.version} from marketplace ${selected.marketplaceName}; bridge pid ${candidateProcess.pid}.\n`)
      return { updated: true, version: candidate.version, marketplace: selected.marketplaceName, pid: candidateProcess.pid, ...(installation ? { codexVersion: transaction.codexVersion, launcherVersion: transaction.launcherVersion } : {}) }
    } catch (updateError) {
      if (!existsSync(join(stateDir, 'update-transaction.json'))) throw updateError
      try {
        const recovered = await recoverTransaction(stateDir, profile, transaction, transactionEnvs, transactionDeps)
        if (recovered.preservedRuntime) throw Object.assign(new Error(`${updateError.message}; compatible messaging recovered over the preserved Codex runtime`), { recovered: true })
      } catch (recoveryError) {
        if (recoveryError.recovered) throw recoveryError
        if (recoveryError.recoverySettled) throw new Error(`${updateError.message}; ${recoveryError.message}`)
        throw new Error(`${updateError.message}; snapshot recovery also failed: ${recoveryError.message}`)
      }
      if (existsSync(join(stateDir, 'update-transaction.json'))) throw new Error(`${updateError.message}; recovery remains unresolved; run codex-telegram update`)
      throw Object.assign(new Error(`${updateError.message}; the pinned recovery launcher and bridge were restored`), { code: updateError.code })
    }
  } catch (error) {
    if (release && existsSync(join(stateDir, 'update-transaction.json'))) error = new Error(`${error.message}; recovery is required: run codex-telegram update`)
    if (release && options.automatic && error.code === 'UPDATE_BUSY') automaticAttempt(stateDir, null)
    else if (attempt) automaticAttempt(stateDir, { ...attempt, status: 'failed', reason: error.message })
    throw error
  } finally {
    if (release && profile && cleanupReady) {
      protectedRoots.clear()
      try { cleanup(await control(profile.controlSocket, { action: 'status' })) }
      catch (error) { write(`Transaction cleanup deferred: ${error.message}\n`) }
    }
    release?.()
  }
}

async function main() {
  try { await runUpdate(parseArgs(process.argv.slice(2))) } catch (error) {
    process.stderr.write(`gelios-codex-telegram update: ${error.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--supervise') await superviseCommand(process.argv.slice(3))
  else if (process.argv[2] === '--validate-candidate') {
    try {
      const input = parseJson(process.argv[3], 'candidate validation request')
      const candidate = validateCandidate(input.result, input.pluginName, input.marketplaceName)
      if (candidate.root !== pluginRoot) throw new Error('a candidate validator must run from the build it validates')
      if (typeof input.stateDir === 'string' && input.stateDir) {
        preflightState(input.stateDir)
        if (existsSync(join(input.stateDir, 'launch-profile.json'))) {
          const profile = readProfile(input.stateDir)
          const status = await controlStatus(controlRequest, profile.controlSocket)
          if (status) assertMigrationSafe(status)
          else await assertMigrationStopped(profile)
          const transaction = readTransaction(input.stateDir, profile)
          if (transaction && !existsSync(join(transaction.snapshot.root, 'src/runtime.js')) && transaction.runtimeProtocol !== 1)
            throw new Error('first migration requires the current updater for compatible recovery; run codex-telegram update from the current release')
        }
      }
      for (const script of [candidate.bridge, candidate.updater, candidate.mcpScript]) {
        await runCommand(process.execPath, ['--check', script], { cwd: pluginRoot, label: 'candidate syntax validation' })
      }
      process.stdout.write(JSON.stringify(candidate) + '\n')
    } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
  }
  else await main()
}
export {
  acquireLock, controlRequest, controlStatus, environments, parseArgs, readProfile, runCommand, runUpdate,
  waitForPreservation, savedConversation, sweepTransactions, runtimeOwnership,
  pluginDigest, preflightState, validateCandidate, validateNextBuild, installedCandidate, atomicSymlink, repairMissingLauncher,
}
