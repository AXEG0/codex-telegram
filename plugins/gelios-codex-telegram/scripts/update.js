#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, closeSync, copyFileSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, linkSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootIdentity, defaultStateDir, processGroupMembers, processInfo } from '../src/core.js'
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
  'GELIOS_TELEGRAM_OWN_GROUP', 'GELIOS_TELEGRAM_STATE_DIR', 'GELIOS_WORKSPACE_ROOT',
])
const pluginRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))

function parseArgs(argv) {
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

async function terminateGroup(child) {
  if (!child.pid) return
  try { signalGroup(child, 'SIGTERM') } catch {}
  await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  try { signalGroup(child, 'SIGKILL') } catch {}
}

function signalGroupMembers(groupId, signal) {
  for (const pid of processGroupMembers(groupId)) {
    try { process.kill(pid, signal) } catch (error) { if (error?.code !== 'ESRCH') throw error }
  }
}

async function drainOwnProcessGroup() {
  if (!processGroupMembers(process.pid).length) return
  signalGroupMembers(process.pid, 'SIGTERM')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  signalGroupMembers(process.pid, 'SIGKILL')
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (!processGroupMembers(process.pid).length) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
  if (processGroupMembers(process.pid).length) throw new Error('command process group did not terminate')
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
      if (child) { child.on('error', () => {}); void terminateGroup(child).then(() => reject(new Error(`${label} failed: ${redact(error.message, secrets)}`))) }
      else reject(new Error(`${label} failed: ${redact(error.message, secrets)}`))
      return
    }
    let stdout = ''; let stderr = ''; let forced = null; let killing = null
    const terminate = reason => {
      forced ||= reason
      killing ||= terminateGroup(child)
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
      if (forced || code !== 0) await (killing ||= terminateGroup(child))
      else await terminateGroup(child) // remove any credential-bearing descendants left behind
      if (!forced && code === 0) { resolvePromise({ stdout, stderr }); return }
      const detail = redact(stderr || forced || signal || `exit ${code}`, secrets).trim()
      reject(new Error(`${label} failed${detail ? `: ${detail}` : ''}`))
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

function acquireLock(path) {
  try { mkdirSync(path, { mode: 0o700 }) } catch (error) { if (error?.code !== 'EEXIST') throw error }
  const directory = lstatSync(path)
  if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700 ||
      (process.getuid && directory.uid !== process.getuid())) {
    throw new Error(`update lock directory at ${path} must be owner-only (mode 0700)`)
  }
  const identity = processIdentity(process.pid)
  if (!/^\d+$/.test(identity || '')) throw new Error('could not verify the updater process identity')
  const owner = {
    pid: process.pid, identity, bootId: bootIdentity(), createdAt: Date.now(),
    nonce: randomBytes(8).toString('hex'), released: false,
  }
  const serialized = `${JSON.stringify(owner)}\n`
  const candidate = join(path, `.candidate-${process.pid}-${owner.nonce}`)
  writeFileSync(candidate, serialized, { flag: 'wx', mode: 0o600 })
  chmodSync(candidate, 0o600); syncPath(candidate)
  try {
    while (true) {
      const generations = readdirSync(path).filter(name => /^\d{20}\.lock$/.test(name)).sort()
      const latestName = generations.at(-1)
      if (latestName) {
        const latestPath = join(path, latestName)
        let info; let current
        try { info = lstatSync(latestPath); current = JSON.parse(readFileSync(latestPath, 'utf8')) } catch {
          throw new Error(`update lock generation at ${latestPath} is invalid`)
        }
        if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid()) ||
            !Number.isSafeInteger(current.pid) || current.pid <= 1 || !/^\d+$/.test(current.identity || '') ||
            !/^[a-f0-9-]{16,64}$/.test(current.bootId || '') || typeof current.released !== 'boolean') {
          throw new Error(`update lock generation at ${latestPath} is invalid`)
        }
        if (!current.released && current.bootId === owner.bootId &&
            processIdentity(current.pid) === current.identity && processExists(current.pid)) {
          throw new Error('another Telegram plugin update is already running')
        }
      }
      const generation = latestName ? BigInt(latestName.slice(0, 20)) + 1n : 1n
      if (generation > 99_999_999_999_999_999_999n) throw new Error('update lock generations are exhausted')
      const generationPath = join(path, `${generation.toString().padStart(20, '0')}.lock`)
      try { linkSync(candidate, generationPath) } catch (error) {
        if (error?.code === 'EEXIST') continue
        throw error
      }
      syncPath(path)
      return () => {
        try {
          if (readFileSync(generationPath, 'utf8') !== serialized) return
          durableJson(generationPath, { ...owner, released: true, releasedAt: Date.now() })
        } catch {}
      }
    }
  } finally {
    try { unlinkSync(candidate) } catch {}
  }
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

function environments(profile, source, askpassPath) {
  const transcriptionSecret = profile.transcriptionApiKeyEnv ? source[profile.transcriptionApiKeyEnv] : null
  const authSecret = profile.marketplaceAuthEnv ? source[profile.marketplaceAuthEnv] : null
  if (profile.transcriptionApiKeyEnv && !transcriptionSecret) throw new Error(`${profile.transcriptionApiKeyEnv} is unavailable for bridge restart`)
  if (profile.marketplaceAuthEnv && !authSecret) throw new Error(`${profile.marketplaceAuthEnv} is unavailable for marketplace authentication`)
  const runtimeSlots = new Set(profile.codexRuntimeEnvs)
  const runtimeSecrets = profile.codexRuntimeEnvs.map(name => {
    if (!source[name]) throw new Error(`${name} is unavailable for the Codex runtime`)
    return source[name]
  })
  const botSecret = source.TELEGRAM_BOT_TOKEN
  const ambientGitSecrets = [source.GH_TOKEN, source.GITHUB_TOKEN].filter(Boolean)
  if (transcriptionSecret && authSecret === transcriptionSecret) {
    throw new Error('transcription and marketplace authentication slots alias the same credential')
  }
  if (runtimeSecrets.some(value => [transcriptionSecret, botSecret].filter(Boolean).includes(value))) {
    throw new Error('a Codex runtime slot aliases a bridge-only credential')
  }
  const proxyEntries = Object.entries(source).filter(([name, value]) => PROXY_ENV.test(name) && value)
  for (const value of [transcriptionSecret, authSecret, botSecret, ...runtimeSecrets, ...proxyEntries.map(([, value]) => value)].filter(Boolean)) {
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('credential values cannot contain control characters')
  }
  const namedSecrets = Object.entries(source).filter(([name]) => /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PAT)$/i.test(name)).map(([, value]) => value)
  const credentials = [...new Set([transcriptionSecret, authSecret, botSecret, ...ambientGitSecrets, ...runtimeSecrets, ...namedSecrets].filter(Boolean))]
  const proxyValues = proxyEntries.flatMap(([, value]) => {
    try {
      const url = new URL(value)
      if (!url.username && !url.password) return []
      return [value, url.username, url.password, ...[url.username, url.password].map(part => { try { return decodeURIComponent(part) } catch { return part } })]
    } catch { return /\/\/[^/@\s]+@/.test(value) ? [value, value.match(/\/\/([^@\s]+)@/)?.[1]] : [] }
  }).filter(Boolean)
  const secrets = [...new Set([...credentials, ...proxyValues])].sort((a, b) => b.length - a.length)
  const local = Object.fromEntries(Object.entries(source).filter(([name, value]) => SYSTEM_ENV.test(name) && !credentials.includes(value)))
  const network = { ...local, ...Object.fromEntries(Object.entries(source).filter(([name]) => PROXY_ENV.test(name))) }
  const clean = { ...local }
  Object.assign(clean, {
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  })
  const authenticated = { ...network, ...clean }
  if (authSecret) Object.assign(authenticated, {
    GH_TOKEN: authSecret, GIT_ASKPASS: askpassPath, GIT_ASKPASS_REQUIRE: 'force',
  })
  const bridge = { ...network, GELIOS_TELEGRAM_LAUNCHER_LINK: profile.launcherLink }
  if (botSecret) bridge.TELEGRAM_BOT_TOKEN = botSecret
  if (transcriptionSecret) bridge[profile.transcriptionApiKeyEnv] = transcriptionSecret
  for (const name of runtimeSlots) bridge[name] = source[name]
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
        if (!response.ok) return finish(new Error(response.error || 'bridge rejected the request'))
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
  if (status.tuiAttached) throw new Error('exit the attached Codex TUI before updating')
  if (status.turnId) throw new Error('wait for the active Codex turn to finish before updating')
  if (status.updatePrepared) throw new Error('the bridge is already preparing for an update; retry shortly')
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

async function waitForStatus(control, path, expectedPid, expectedInstance, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const status = await control(path, { action: 'status' })
      if (status?.pid === expectedPid && status.instanceId === expectedInstance && /^\d+$/.test(status.identity || '') &&
          processIdentity(status.pid) === status.identity && status.appRunning === true) return status
      lastError = new Error('replacement bridge returned an unexpected process or instance ID')
    } catch (error) { lastError = error }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(`replacement bridge health check failed: ${lastError?.message || 'unavailable'}`)
}

function sameBridge(status, expected) {
  return status?.pid === expected.pid && status.identity === expected.identity && status.instanceId === expected.instanceId
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

function syncPath(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function durableJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temporary, 0o600); syncPath(temporary); renameSync(temporary, path); syncPath(dirname(path))
  } finally { try { if (existsSync(temporary)) unlinkSync(temporary) } catch {} }
}

function snapshotPaths(stateDir, id) {
  const parent = join(stateDir, 'update-transactions')
  const transactionRoot = join(parent, id)
  return { parent, transactionRoot, root: join(transactionRoot, 'previous-plugin') }
}

function pluginFiles(root) {
  const found = []
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(directory, entry.name), name)
      else if (entry.isFile()) found.push(name)
      else throw new Error('plugin snapshot contains an unsupported file type')
    }
  }
  walk(root)
  return found.sort()
}

function pluginDigest(root, expectedFiles = null) {
  const found = pluginFiles(root)
  if (expectedFiles && JSON.stringify(found.sort()) !== JSON.stringify([...expectedFiles].sort())) throw new Error('plugin snapshot has an unexpected file set')
  const hash = createHash('sha256')
  for (const name of found.sort()) {
    const path = trustedFile(join(root, name), `plugin file ${name}`, { root, executable: name === 'bin/gelios-codex-telegram' || name === 'scripts/git-askpass.js' })
    const info = statSync(path); hash.update(`${name}\0${info.mode & 0o777}\0`); hash.update(readFileSync(path))
  }
  return hash.digest('hex')
}

function createSnapshot(stateDir, runningRoot, id) {
  const contentDigest = pluginDigest(runningRoot); const paths = snapshotPaths(stateDir, id)
  const files = pluginFiles(runningRoot), directories = new Set(['.'])
  mkdirSync(paths.parent, { recursive: true, mode: 0o700 }); chmodSync(paths.parent, 0o700)
  const temporary = `${paths.transactionRoot}.tmp-${process.pid}`
  try {
    mkdirSync(join(temporary, 'previous-plugin'), { recursive: true, mode: 0o700 })
    // Preserve the complete artifact, including instructions and newly added
    // modules. Recovery cannot depend on a manually maintained runtime list.
    for (const name of files) {
      const source = join(runningRoot, name)
      if (!lstatSync(source).isFile()) throw new Error(`running plugin file ${name} is not a regular file`)
      const trusted = trustedFile(source, `running plugin file ${name}`, { root: runningRoot,
        executable: name === 'bin/gelios-codex-telegram' || name === 'scripts/git-askpass.js' })
      const destination = join(temporary, 'previous-plugin', name)
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      copyFileSync(trusted, destination); chmodSync(destination, statSync(trusted).mode & 0o700); syncPath(destination)
      for (let directory = dirname(name); directory !== '.'; directory = dirname(directory)) directories.add(directory)
    }
    for (const directory of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
      const path = resolve(temporary, 'previous-plugin', directory); chmodSync(path, 0o700); syncPath(path)
    }
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
    if (!managed) return true; if (managed.contentDigest !== undefined && !/^[a-f0-9]{64}$/.test(managed.contentDigest)) return false
    if (managed.instanceId === undefined) return managed.pid === undefined && managed.identity === undefined
    return /^[a-f0-9]{32}$/.test(managed.instanceId || '') &&
      (managed.pid === undefined || (Number.isSafeInteger(managed.pid) && managed.pid > 1 && /^\d+$/.test(managed.identity || '')))
  }
  if (value.version !== 1 || !/^[a-f0-9-]{16,64}$/.test(value.bootId || '') || value.profileDigest !== digest ||
      !expected || value.snapshot?.root !== expected.root ||
      !/^[a-f0-9]{64}$/.test(value.snapshot?.digest || '') || (value.snapshot.contentDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.snapshot.contentDigest)) || !Number.isSafeInteger(value.previous?.pid) ||
      !/^\d+$/.test(value.previous?.identity || '') || !/^[a-f0-9]{32}$/.test(value.previous?.instanceId || '') ||
      !validManaged(value.candidate) || !validManaged(value.recovery) ||
      (value.command && (!Number.isSafeInteger(value.command.pid) || !/^\d+$/.test(value.command.identity || '')))) throw new Error('update transaction journal is invalid')
  const root = trustedDirectory(expected.root, 'transaction snapshot')
  if (pluginDigest(root) !== value.snapshot.digest) throw new Error('transaction snapshot changed; refusing recovery')
  value.snapshot = {
    ...value.snapshot, root,
    launcher: join(root, 'bin', 'gelios-codex-telegram'),
    askpass: join(root, 'scripts', 'git-askpass.js'),
    updater: join(root, 'scripts', 'update.js'),
  }
  if (value.installation) {
    validateInstallation(value.installation, profile, expected.transactionRoot)
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

function trustedOwner(info, allowRoot = false) {
  const uid = process.getuid?.()
  return uid === undefined || info.uid === uid || (allowRoot && info.uid === 0)
}

function validateAncestors(path, label) {
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const info = statSync(parent)
    const stickyRoot = info.uid === 0 && Boolean(info.mode & 0o1000)
    if (!info.isDirectory() || (!stickyRoot && (info.mode & 0o022)) || !trustedOwner(info, true)) {
      throw new Error(`${label} has an untrusted parent directory`)
    }
    if (parent === dirname(parent)) break
  }
}

function trustedDirectory(path, label, { allowRoot = false } = {}) {
  const canonical = realpathSync(path)
  const info = statSync(canonical)
  if (!info.isDirectory() || (info.mode & 0o022) || !trustedOwner(info, allowRoot)) {
    throw new Error(`${label} is not in a trusted directory`)
  }
  validateAncestors(canonical, label)
  return canonical
}

function trustedFile(path, label, { root = null, executable = false, allowRoot = false } = {}) {
  const canonical = realpathSync(path)
  const escaped = root && (relative(root, canonical).startsWith(`..${sep}`) || isAbsolute(relative(root, canonical)))
  if (escaped) throw new Error(`${label} escapes the plugin directory`)
  const info = statSync(canonical)
  if (!info.isFile() || (info.mode & 0o022) || !trustedOwner(info, allowRoot) || (executable && !(info.mode & 0o111))) {
    throw new Error(`${label} is not a trusted${executable ? ' executable' : ' file'}`)
  }
  validateAncestors(canonical, label)
  return canonical
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

function validateCandidate(result, pluginName, marketplaceName) {
  if (result.name !== pluginName || result.marketplaceName !== marketplaceName || typeof result.installedPath !== 'string' || !isAbsolute(result.installedPath)) {
    throw new Error('Codex returned an invalid installed plugin candidate')
  }
  const root = trustedDirectory(result.installedPath, 'installed plugin candidate')
  const manifestPath = trustedFile(join(root, '.codex-plugin', 'plugin.json'), 'candidate manifest', { root })
  const launcher = trustedFile(join(root, 'bin', 'gelios-codex-telegram'), 'candidate launcher', { root, executable: true })
  const askpass = trustedFile(join(root, 'scripts', 'git-askpass.js'), 'candidate Git authentication helper', { root, executable: true })
  const bridge = trustedFile(join(root, 'scripts', 'bridge.js'), 'candidate bridge', { root })
  const updater = trustedFile(join(root, 'scripts', 'update.js'), 'candidate updater', { root })
  const mcpScript = trustedFile(join(root, 'scripts', 'mcp.js'), 'candidate MCP server', { root })
  const mcpPath = trustedFile(join(root, '.mcp.json'), 'candidate MCP manifest', { root })
  const manifest = parseJson(readFileSync(manifestPath, 'utf8'), 'candidate manifest')
  const mcp = parseJson(readFileSync(mcpPath, 'utf8'), 'candidate MCP manifest')
  if (manifest.name !== pluginName || manifest.mcpServers !== './.mcp.json' ||
      (result.version && manifest.version !== result.version)) {
    throw new Error('installed plugin candidate has an invalid manifest or launcher')
  }
  const server = mcp.mcpServers?.[pluginName === 'telegram' ? 'telegram' : 'gelios-codex-telegram']
  const requiredEnv = ['GELIOS_TELEGRAM_CONTROL_SOCKET', 'GELIOS_TELEGRAM_STATE_DIR']
  const envVars = server?.env_vars
  if (!server || server.command !== 'node' || JSON.stringify(server.args) !== JSON.stringify(['./scripts/mcp.js']) ||
      server.cwd !== '.' || !Array.isArray(envVars) || envVars.some(value => typeof value !== 'string') ||
      new Set(envVars).size !== envVars.length || requiredEnv.some(name => !envVars.includes(name)) ||
      server.required !== true || !Number.isFinite(server.startup_timeout_sec) || !Number.isFinite(server.tool_timeout_sec)) {
    throw new Error('installed plugin candidate has an invalid MCP manifest')
  }
  if (pluginName === 'telegram') {
    if (manifest.skills !== './skills/') throw new Error('installed plugin candidate has no setup skills')
    for (const path of ['bin/codex-telegram', 'scripts/setup.js', 'src/bootstrap.js', 'src/local-setup.js', 'skills/configure/SKILL.md', 'skills/access/SKILL.md']) {
      trustedFile(join(root, path), 'candidate setup asset', { root })
    }
  }
  return { root, launcher, bridge, updater, mcpScript, askpass, version: result.version || manifest.version || 'unknown', contentDigest: pluginDigest(root) }
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
  const { control, awaitExit, identityOf, replaceLauncher, bootOf } = dependencies
  const snapshot = transaction.snapshot
  if (transaction.command?.pid && identityOf(transaction.command.pid) === transaction.command.identity) {
    const remaining = Math.max(1000, Math.min(120_000, Number(transaction.command.deadline || 0) - Date.now() + 1000))
    if (!(await awaitExit(transaction.command.pid, remaining, transaction.command.identity))) {
      throw new Error('the exact update subprocess is still running; refusing concurrent recovery')
    }
  }
  const managed = [transaction.previous, transaction.candidate, transaction.recovery]
    .filter(value => value?.instanceId)
  const receipts = managed.filter(value => value?.pid)
  const bootChanged = transaction.bootId !== bootOf()
  const hasUnreceiptedInstance = managed.some(value => !value.pid)
  let status = await controlStatus(control, profile.controlSocket, {
    allowStale: bootChanged || !hasUnreceiptedInstance, bootChanged, receipts, awaitExit,
  })
  if (status && (!/^\d+$/.test(status.identity || '') || identityOf(status.pid) !== status.identity)) {
    throw new Error('the bridge owning the control socket has an unverifiable process identity')
  }
  const previousLive = status && sameBridge(status, transaction.previous)
  const candidateLive = status && transaction.candidate?.instanceId === status.instanceId
  const recoveryLive = status && transaction.recovery?.instanceId === status.instanceId
  if (status && !previousLive && !candidateLive && !recoveryLive) {
    throw new Error('an unknown bridge owns the control socket; interrupted update recovery refused')
  }
  if (transaction.installation?.mutated) {
    if (status) { await stopBridge(control, profile.controlSocket, { pid: status.pid, identity: status.identity, instanceId: status.instanceId }, awaitExit); status = null }
    restoreInstallation(transaction.installation)
  }
  replaceLauncher(profile.launcherLink, snapshot.launcher)
  if (recoveryLive && status?.appRunning === true) {
    clearTransaction(stateDir)
    return { root: snapshot.root, status }
  }
  if (previousLive && status?.appRunning === true && !status.updatePrepared) {
    clearTransaction(stateDir)
    return { root: snapshot.root, status }
  }
  if (status) await stopBridge(control, profile.controlSocket, {
    pid: status.pid, identity: status.identity, instanceId: status.instanceId,
  }, awaitExit)
  else if (!bootChanged) for (const receipt of [transaction.previous, transaction.candidate, transaction.recovery].filter(value => value?.pid)) {
    if (identityOf(receipt.pid) === receipt.identity) {
      throw new Error('a transaction bridge is still running without a classifiable control socket')
    }
  }
  const instanceId = randomBytes(16).toString('hex')
  writeTransaction(stateDir, transaction, 'recovery_starting', { recovery: { instanceId } })
  const receipt = await launchBridge(
    snapshot.launcher, 'snapshot bridge recovery', instanceId, profile, commandEnvs, dependencies,
    started => writeTransaction(stateDir, transaction, 'recovery_started', { recovery: { instanceId, ...started } }),
  )
  writeTransaction(stateDir, transaction, 'recovery_healthy', { recovery: receipt })
  replaceLauncher(profile.launcherLink, snapshot.launcher)
  clearTransaction(stateDir)
  return { root: snapshot.root, status: await control(profile.controlSocket, { action: 'status' }) }
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
  const deps = { run, control, awaitExit, awaitStatus, identityOf, exists, replaceLauncher, bootOf }
  if (!existsSync(stateDir)) throw new Error('Telegram bridge state is missing; start the detached bridge before updating')
  const stateInfo = statSync(stateDir)
  if (!stateInfo.isDirectory() || (stateInfo.mode & 0o777) !== 0o700 || (process.getuid && stateInfo.uid !== process.getuid())) {
    throw new Error('Telegram bridge state directory must be owner-only (mode 0700)')
  }
  const release = acquireLock(join(stateDir, 'update-locks'))
  try {
    const profile = readProfile(stateDir)
    let runningRoot = trustedDirectory(dependencies.pluginRoot || dirname(dirname(realpathSync(profile.launcherLink))), 'the running plugin')
    let initialStatus
    let discoveryRun = run
    const interrupted = readTransaction(stateDir, profile)
    if (interrupted) {
      const recoveryEnvs = environments(profile, env, interrupted.snapshot.askpass)
      discoveryRun = withCommandSupervisor(run, interrupted.snapshot.updater)
      const recoveryDeps = {
        ...deps, run: discoveryRun,
      }
      const recovered = await recoverTransaction(stateDir, profile, interrupted, recoveryEnvs, recoveryDeps)
      runningRoot = recovered.root; initialStatus = recovered.status
    }
    const askpassPath = trustedFile(join(runningRoot, 'scripts', 'git-askpass.js'), 'the plugin Git authentication helper', {
      root: runningRoot, executable: true,
    })
    const commandEnvs = environments(profile, env, askpassPath)
    validateManagedLauncher(profile, runningRoot)
    let codexBin = trustedFile(profile.codexBin, 'the recorded Codex binary', { executable: true, allowRoot: true })
    initialStatus ||= await control(profile.controlSocket, { action: 'status' })
    if (options.all) {
      let waiting = false
      while (initialStatus.turnId) {
        if (!waiting) { write('Waiting for the current Codex turn to finish.\n'); waiting = true }
        if (initialStatus.tuiAttached) throw new Error('exit the attached Codex TUI, then run codex-telegram update from the parent terminal')
        await new Promise(resolvePromise => setTimeout(resolvePromise, 250)); initialStatus = await control(profile.controlSocket, { action: 'status' })
      }
    }
    const oldPid = assertIdle(initialStatus, identityOf)
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
    if (options.all) {
      const directory = snapshotPaths(stateDir, id).transactionRoot, coordinator = join(directory, 'coordinator')
      pluginDigest(pluginRoot); cpSync(pluginRoot, coordinator, { recursive: true }); chmodSync(coordinator, 0o700)
      packageDigest(coordinator, (path, name, stat) => { if (!stat.isSymbolicLink()) syncPath(path) }); syncPath(coordinator)
      snapshot.coordinatorDigest = pluginDigest(coordinator); snapshot.updater = join(coordinator, 'scripts', 'update.js')
      try { installation = captureInstallation(profile, options.installerRoot, directory, env) }
      catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
      for (const component of ['codex', 'launcher']) { packageDigest(installation[component].backup, (path, name, stat) => { if (!stat.isSymbolicLink()) syncPath(path) }); syncPath(installation[component].backup) }
      installation.threadId = initialStatus.threadId; installation.workspace = initialStatus.workspace; installation.permissions = initialStatus.permissions || null
    }
    const transaction = {
      version: 1, id, phase: 'snapshot_ready', createdAt: new Date().toISOString(),
      bootId: bootOf(),
      profileDigest: createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
      pluginName: target.name, marketplaceName: selected.marketplaceName,
      snapshot: { ...snapshot, version: manifest.version }, previous: oldProcess, candidate: null,
      ...(installation ? { installation } : {}),
    }
    writeTransaction(stateDir, transaction, 'snapshot_ready')
    const transactionEnvs = environments(profile, env, snapshot.askpass)
    const transactionRun = withCommandSupervisor(run, snapshot.updater)
    const transactionDeps = { ...deps, run: transactionRun }
    try {
      writeTransaction(stateDir, transaction, 'arming_fallback')
      replaceLauncher(profile.launcherLink, snapshot.launcher)
      if (realpathSync(profile.launcherLink) !== snapshot.launcher) throw new Error('snapshot launcher was not activated')
      writeTransaction(stateDir, transaction, 'fallback_armed')
      if (installation) {
        writeTransaction(stateDir, transaction, 'stopping_previous')
        await stopBridge(control, profile.controlSocket, oldProcess, awaitExit, 'stop_for_update', 180_000)
        writeTransaction(stateDir, transaction, 'codex_updating', { installation: { ...installation, mutated: true }, command: null })
        await transactionRun(codexBin, ['update'], { cwd: profile.cwd, env: nativeUpdateEnvironment(installation, commandEnvs.installation), label: 'Codex CLI update', secrets: commandEnvs.secrets, timeoutMs: 600_000,
          onSpawn: receipt => writeTransaction(stateDir, transaction, 'codex_updating', { command: receipt }) })
        codexBin = trustedFile(profile.codexBin, 'the updated Codex binary', { executable: true, allowRoot: true })
        const version = (await transactionRun(codexBin, ['--version'], { cwd: profile.cwd, env: commandEnvs.read, label: 'updated Codex version', secrets: commandEnvs.secrets })).stdout.trim()
        if (!/^codex-cli \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error('The updated Codex did not report a valid version')
        const numbers = version.slice(10).split('.').map(Number)
        if (numbers[0] === 0 && numbers[1] < 162) throw new Error('The combined updater requires Codex CLI 0.162.0 or later')
        writeTransaction(stateDir, transaction, 'codex_updated', { codexVersion: version, command: null })
      }
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
      const install = parseJson((await transactionRun(codexBin, ['plugin', 'add', `${target.name}@${selected.marketplaceName}`, '--json'], {
        cwd: profile.cwd, env: commandEnvs.read, label: 'Codex plugin install', secrets: commandEnvs.secrets,
        onSpawn: receipt => writeTransaction(stateDir, transaction, 'installing', { command: receipt }),
      })).stdout, 'Codex plugin install')
      const candidate = validateCandidate(install, target.name, selected.marketplaceName)
      if (candidate.root === snapshot.root) throw new Error('Codex selected the private rollback snapshot as the update candidate')
      for (const [script, label] of [[candidate.bridge, 'bridge'], [candidate.updater, 'updater'], [candidate.mcpScript, 'MCP']]) {
        await transactionRun(process.execPath, ['--check', script], {
          cwd: candidate.root, env: commandEnvs.validation, label: `candidate ${label} validation`, secrets: commandEnvs.secrets,
        })
      }
      writeTransaction(stateDir, transaction, 'candidate_validated', {
        candidate: { root: candidate.root, launcher: candidate.launcher, version: candidate.version, contentDigest: candidate.contentDigest }, command: null,
      })
      validateManagedLauncher(profile, snapshot.root)
      if (!installation) {
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
      const runtimeRefresh = !migrating && candidate.version === manifest.version
      if (runtimeRefresh) {
        if (candidate.contentDigest !== snapshot.contentDigest) throw new Error('candidate plugin content changed without a new manifest version; publish a new version or cachebuster before updating')
      }
      if (!installation) {
        writeTransaction(stateDir, transaction, 'stopping_previous')
        await stopBridge(control, profile.controlSocket, oldProcess, awaitExit, 'stop_for_update', 180_000)
      }
      writeTransaction(stateDir, transaction, 'previous_stopped')
      for (const previous of previousSelections) {
        if (typeof previous.marketplaceName !== 'string' || !previous.marketplaceName) throw new Error('legacy plugin has no named marketplace')
        await transactionRun(codexBin, ['plugin', 'remove', `${previous.name}@${previous.marketplaceName}`, '--json'], {
          cwd: profile.cwd, env: commandEnvs.read, label: 'legacy plugin removal', secrets: commandEnvs.secrets,
        })
      }
      const instanceId = randomBytes(16).toString('hex')
      writeTransaction(stateDir, transaction, 'candidate_starting', {
        candidate: { root: candidate.root, launcher: candidate.launcher, version: candidate.version, instanceId },
      })
      const candidateProcess = await launchBridge(
        candidate.launcher, 'replacement bridge startup', instanceId, profile, transactionEnvs, transactionDeps,
        started => writeTransaction(stateDir, transaction, 'candidate_started', {
          candidate: { ...transaction.candidate, ...started },
        }),
      )
      writeTransaction(stateDir, transaction, 'candidate_healthy', { candidate: { ...transaction.candidate, ...candidateProcess } })
      if (installation) {
        const restored = await control(profile.controlSocket, { action: 'status' })
        if (restored.threadId !== installation.threadId || restored.workspace !== installation.workspace) throw new Error('The installation update did not restore the original conversation and workspace')
        if (installation.permissions && (restored.permissions?.approvalPolicy !== installation.permissions.approvalPolicy || restored.permissions?.sandboxPolicy?.type !== installation.permissions.sandboxPolicy?.type)) throw new Error(`The installation update changed the conversation permissions: ${JSON.stringify(installation.permissions)} -> ${JSON.stringify(restored.permissions)}`)
        verifyInstallationState(installation)
        write(`Updated ${transaction.codexVersion}; launcher ${transaction.launcherVersion}.\n`)
      }
      writeTransaction(stateDir, transaction, 'committing')
      replaceLauncher(profile.launcherLink, candidate.launcher)
      if (realpathSync(profile.launcherLink) !== candidate.launcher) throw new Error('replacement launcher was not activated')
      await awaitStatus(control, profile.controlSocket, candidateProcess.pid, candidateProcess.instanceId)
      writeTransaction(stateDir, transaction, 'committed')
      clearTransaction(stateDir)
      try { rmSync(snapshotPaths(stateDir, id).transactionRoot, { recursive: true }); syncPath(snapshotPaths(stateDir, id).parent) } catch {}
      if (runtimeRefresh) {
        write(`Refreshed ${target.name} ${candidate.version} from marketplace ${selected.marketplaceName}; bridge pid ${candidateProcess.pid}.\n`)
        return { updated: false, refreshed: true, version: candidate.version, marketplace: selected.marketplaceName, pid: candidateProcess.pid, ...(installation ? { codexVersion: transaction.codexVersion, launcherVersion: transaction.launcherVersion } : {}) }
      }
      write(`Updated ${target.name} to ${candidate.version} from marketplace ${selected.marketplaceName}; bridge pid ${candidateProcess.pid}.\n`)
      return { updated: true, version: candidate.version, marketplace: selected.marketplaceName, pid: candidateProcess.pid, ...(installation ? { codexVersion: transaction.codexVersion, launcherVersion: transaction.launcherVersion } : {}) }
    } catch (updateError) {
      if (!existsSync(join(stateDir, 'update-transaction.json'))) throw updateError
      try {
        await recoverTransaction(stateDir, profile, transaction, transactionEnvs, transactionDeps)
      } catch (recoveryError) {
        throw new Error(`${updateError.message}; snapshot recovery also failed: ${recoveryError.message}`)
      }
      throw new Error(`${updateError.message}; the durable snapshot launcher and bridge were restored`)
    }
  } finally { release() }
}

async function main() {
  try { await runUpdate(parseArgs(process.argv.slice(2))) } catch (error) {
    process.stderr.write(`gelios-codex-telegram update: ${error.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--supervise') await superviseCommand(process.argv.slice(3))
  else await main()
}
export {
  acquireLock, controlRequest, controlStatus, environments, parseArgs, readProfile, runCommand, runUpdate,
  pluginDigest, validateCandidate,
}
