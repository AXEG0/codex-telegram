import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, openSync, closeSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { acquireLock, pinBuild, trustedDirectory, trustedFile } from './builds.js'
import { ensurePrivateDir, processInfo } from './core.js'
import { requestControl } from './control.js'
import { runSystemctl } from './systemd.js'
import { prepareRuntimePolicy } from './runtime-policy.js'

export const runtimeSocket = stateDir => join(stateDir, 'runtime.sock')
export const runtimeUnit = stateDir => `codex-telegram-runtime-${createHash('sha256').update(stateDir).digest('hex').slice(0, 24)}.service`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function runtimeStatus(stateDir) {
  const status = await requestControl(runtimeSocket(stateDir), 'status', {}, { timeoutMs: 5000 })
  if (status.component !== 'codex-telegram-runtime' || status.protocolVersion !== 1)
    throw new Error('the persistent runtime uses an unsupported protocol; its running work was left intact')
  return status
}
const hostStatus = runtimeStatus

// The supervisor receives credentials through an owner-only socket, never a
// unit argument, Environment= property, launch profile or file on disk.
export async function ensureRuntime(options, env, { launch = spawn, policy = prepareRuntimePolicy } = {}) {
  ensurePrivateDir(options.stateDir); trustedDirectory(options.stateDir, 'runtime state')
  try { return await hostStatus(options.stateDir) } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error
  }
  const release = acquireLock(join(options.stateDir, 'runtime-start-locks'))
  try {
    try { return await hostStatus(options.stateDir) } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error
    }
    const build = pinBuild(fileURLToPath(new URL('../', import.meta.url)), options.stateDir)
    const script = join(build.root, 'scripts/runtime.js')
    const safeEnv = Object.fromEntries(Object.entries(env).filter(([name]) => /^(HOME|PATH|USER|LOGNAME|XDG_RUNTIME_DIR|TMPDIR|TMP|TEMP|NODE_DISABLE_COMPILE_CACHE)$/.test(name)))
    const args = [script, '--state-dir', options.stateDir]
    let child
    if (options.systemdUnit) {
      await policy(options.systemdUnit, runtimeUnit(options.stateDir))
      args.push('--systemd-unit', runtimeUnit(options.stateDir))
      if (!safeEnv.XDG_RUNTIME_DIR && process.getuid && existsSync(`/run/user/${process.getuid()}`)) safeEnv.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`
      child = launch('systemd-run', ['--user', '--quiet', '--collect', '--service-type=exec', `--unit=${runtimeUnit(options.stateDir)}`,
        '--property=UMask=0077', '--property=KillMode=control-group', '--property=TimeoutStopSec=5',
        '--property=WorkingDirectory=/', '--', process.execPath, ...args], { env: safeEnv, stdio: ['ignore', 'ignore', 'pipe'] })
    } else {
      const log = join(options.stateDir, 'runtime.log')
      if (existsSync(log)) trustedFile(log, 'runtime log')
      const fd = openSync(log, 'a', 0o600); chmodSync(log, 0o600)
      try { child = launch(process.execPath, args, { env: { ...safeEnv, CODEX_TELEGRAM_RUNTIME_OWN_GROUP: '1' }, cwd: '/', detached: true, stdio: ['ignore', fd, fd] }) }
      finally { closeSync(fd) }
      child.unref()
    }
    let failure = null, detail = ''
    child.once('error', error => { failure = error })
    child.stderr?.on('data', part => { detail = (detail + part).slice(-2000) })
    child.once('exit', code => { if (code) failure = new Error(`runtime supervisor start failed (${code}): ${detail.trim()}`) })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (failure) throw failure
      try { return await hostStatus(options.stateDir) } catch (error) {
        if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error
      }
      await delay(25)
    }
    throw new Error('independent Codex runtime supervisor did not become ready')
  } finally { release() }
}

// A child-like transport keeps the controller's stdio protocol unchanged.
// kill() disconnects this client. Only the runtime supervisor owns Codex.
export async function connectRuntime(options, env, secrets = []) {
  await ensureRuntime(options, env)
  const socket = net.createConnection(runtimeSocket(options.stateDir))
  socket.on('error', () => {})
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const app = new EventEmitter()
  app.stdout = new PassThrough(); app.stderr = new PassThrough()
  app.stdin = socket; app.exitCode = null; app.signalCode = null; app.killed = false
  app.kill = () => { app.killed = true; socket.end(); return true }
  let finished = false
  socket.once('close', () => {
    if (finished) return
    finished = true; app.exitCode = 0; app.stdout.end(); app.stderr.end()
    app.emit('exit', 0, null); app.emit('close', 0, null)
  })
  const receipt = await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('runtime attach timed out')) }, 15_000)
    const error = value => { clearTimeout(timer); reject(value) }
    socket.once('error', error)
    const onData = part => {
      buffer = Buffer.concat([buffer, part]); const end = buffer.indexOf(10)
      if (end < 0) { if (buffer.length > 64 * 1024) error(new Error('runtime attach receipt is too large')); return }
      socket.off('data', onData); socket.off('error', error); clearTimeout(timer)
      try {
        const answer = JSON.parse(buffer.subarray(0, end).toString())
        if (!answer.ok) throw new Error(answer.error)
        // Pipe only protocol data, never the attach receipt, to the controller.
        const frames = new PassThrough()
        readline.createInterface({ input: frames }).on('line', line => {
          try {
            const frame = JSON.parse(line)
            if (frame.protocol) app.stdout.write(JSON.stringify(frame.protocol) + '\n')
            else if (typeof frame.stderr === 'string') app.stderr.write(frame.stderr)
          } catch (value) { app.emit('error', value); socket.destroy() }
        })
        socket.pipe(frames)
        if (buffer.length > end + 1) frames.write(buffer.subarray(end + 1))
        resolve(answer.result)
      } catch (value) { socket.destroy(); reject(value) }
    }
    socket.on('data', onData)
    socket.write(JSON.stringify({ action: 'attach', args: { codexBin: options.codexBin, workspace: options.workspace, mcpBuildRoot: options.mcpBuildRoot || null, env, secrets } }) + '\n')
  })
  app.pid = receipt.appPid
  app.runtime = Object.fromEntries(['component', 'protocolVersion', 'instanceId', 'unit', 'startedAt', 'pid', 'identity', 'bootId', 'appPid', 'connectionEpoch', 'mcpRefreshRequired', 'environmentChanged']
    .map(key => [key, receipt[key]]))
  return app
}

export async function stopRuntime(stateDir) {
  const status = await hostStatus(stateDir)
  await requestControl(runtimeSocket(stateDir), 'stop', { instanceId: status.instanceId }, { timeoutMs: 10_000 })
  const deadline = Date.now() + 10_000
  while (processInfo(status.pid)?.identity === status.identity && Date.now() < deadline) await delay(25)
  if (processInfo(status.pid)?.identity === status.identity) throw new Error('runtime supervisor did not stop')
  // MainPID can exit before systemd finishes stopping remaining jobs. Wait for
  // that control group too, so the next launch can reuse the same unit safely.
  if (status.unit === runtimeUnit(stateDir)) {
    while (true) {
      const result = await runSystemctl(['show', status.unit, '--property=ActiveState', '--value'], 1000)
      if (result.code !== 0 || !/^(active|activating|deactivating|reloading)$/.test(result.output)) break
      if (Date.now() >= deadline) throw new Error('runtime control group did not finish stopping')
      await delay(25)
    }
  }
  return status
}
