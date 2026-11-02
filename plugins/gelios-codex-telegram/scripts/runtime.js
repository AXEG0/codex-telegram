#!/usr/bin/env node
// A persistent stdio owner. Telegram is a reconnecting client, not Codex's
// parent. Keeping the native connection open also keeps its subscriptions.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import { join, resolve } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { acquireLock, durableJson, pinBuild, trustedDirectory } from '../src/builds.js'
import { bootIdentity, ensurePrivateDir, processGroupMembers, processInfo } from '../src/core.js'
import { runtimeSocket, runtimeUnit } from '../src/runtime.js'

const stateArgument = process.argv.indexOf('--state-dir')
if (stateArgument < 0 || !process.argv[stateArgument + 1]) throw new Error('--state-dir is required')
const stateDir = resolve(process.argv[stateArgument + 1])
const unitArgument = process.argv.indexOf('--systemd-unit'), unit = unitArgument < 0 ? null : process.argv[unitArgument + 1]
if (unitArgument >= 0 && unit !== runtimeUnit(stateDir)) throw new Error('the runtime unit does not match its state directory')
ensurePrivateDir(stateDir); trustedDirectory(stateDir, 'runtime state')
const release = acquireLock(join(stateDir, 'runtime-host-locks'))
pinBuild(fileURLToPath(new URL('../', import.meta.url)), stateDir)
const path = runtimeSocket(stateDir), instanceId = randomBytes(16).toString('hex')
if (existsSync(path)) {
  const stat = lstatSync(path)
  if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) throw new Error('runtime path is not an owned socket')
  unlinkSync(path)
}
let app = null, client = null, stopping = false, initialized = null, initializing = false, nativeInitialized = false
let epoch = 0, nextId = 0, replayBytes = 0
const pending = new Map(), replay = [], clients = new Set()
const MAX_REPLAY_BYTES = 16 * 1024 * 1024
const startedAt = new Date().toISOString()
const status = () => ({ component: 'codex-telegram-runtime', protocolVersion: 1, instanceId, unit, startedAt, pid: process.pid, identity: processInfo(process.pid)?.identity,
  bootId: bootIdentity(), appPid: app?.pid || null, running: Boolean(app && app.exitCode === null && !app.killed), attached: Boolean(client), connectionEpoch: epoch, replayBytes })
const saveStatus = () => durableJson(join(stateDir, 'native-runtime.json'), status())
const answer = (socket, result) => socket.write(JSON.stringify({ ok: true, result }) + '\n')
const fail = (socket, error) => socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n')
const pause = () => { app?.stdout.pause(); app?.stderr.pause() }
const resume = () => { if (client && !replayBytes && client.socket.writableLength < 64 * 1024) { app?.stdout.resume(); app?.stderr.resume() } }
function write(socket, line) { if (!socket.write(line)) pause() }
const protocol = (socket, message) => write(socket, JSON.stringify({ protocol: message }) + '\n')
function outgoing(message, stderr = false) {
  const line = JSON.stringify(stderr ? { stderr: message } : { protocol: message }) + '\n'
  if (client && (client.ready || stderr) && !client.socket.destroyed) { write(client.socket, line); return }
  replay.push(line); replayBytes += Buffer.byteLength(line)
  // Apply transport backpressure instead of discarding a completion or tool
  // request. The runtime and its jobs are never stopped to make room.
  if (replayBytes >= MAX_REPLAY_BYTES) pause()
}
function onApp(line) {
  let message; try { message = JSON.parse(line) } catch { return }
  if (!message.method && pending.has(String(message.id))) {
    const request = pending.get(String(message.id)); pending.delete(String(message.id))
    if (request.initialize) {
      initializing = false
      if (message.result) initialized = message.result
      // An initialize reply belongs to the current attach, even if the previous
      // client disconnected during initialization. No second native handshake.
      const waiter = client?.initialize
      if (waiter !== undefined) { protocol(client.socket, { ...message, id: waiter }); delete client.initialize }
      return
    }
    if (request.epoch === client?.epoch) protocol(client.socket, { ...message, id: request.id })
    return
  }
  outgoing(message)
}
async function start(args) {
  if (app) return
  if (typeof args.codexBin !== 'string' || !args.codexBin.startsWith('/') || typeof args.workspace !== 'string' ||
      !args.env || Object.values(args.env).some(value => typeof value !== 'string')) throw new Error('invalid runtime launch request')
  app = spawn(args.codexBin, ['app-server', '--listen', 'stdio://'], { cwd: args.workspace, env: args.env, stdio: ['pipe', 'pipe', 'pipe'] })
  try { await new Promise((resolve, reject) => { app.once('spawn', resolve); app.once('error', reject) }) }
  catch (error) { app = null; throw error }
  app.stderr.setEncoding('utf8')
  app.stderr.on('data', part => outgoing(part, true))
  readline.createInterface({ input: app.stdout }).on('line', onApp)
  app.once('exit', code => { for (const socket of clients) socket.destroy(); if (!stopping) void stop(code || 1) })
  saveStatus()
}
function input(owner, message) {
  if (owner !== client) return
  if (message.method === 'initialize') {
    if (initialized) protocol(owner.socket, { id: message.id, result: initialized })
    else {
      owner.initialize = message.id
      if (!initializing) {
        initializing = true; const id = `runtime:${++nextId}`
        pending.set(id, { initialize: true }); app.stdin.write(JSON.stringify({ ...message, id }) + '\n')
      }
    }
    return
  }
  if (message.method === 'initialized') {
    if (!initialized) throw new Error('initialize must complete before initialized')
    owner.ready = true
    if (!owner.notified) {
      owner.notified = true
      if (!nativeInitialized) { nativeInitialized = true; app.stdin.write(JSON.stringify(message) + '\n') }
    }
    for (const line of replay.splice(0)) write(owner.socket, line)
    replayBytes = 0
    resume()
    return
  }
  if (message.method && message.id !== undefined) {
    const id = `runtime:${++nextId}`; pending.set(id, { epoch: owner.epoch, id: message.id })
    app.stdin.write(JSON.stringify({ ...message, id }) + '\n')
  } else app.stdin.write(JSON.stringify(message) + '\n')
}
const server = net.createServer(socket => {
  clients.add(socket); socket.setEncoding('utf8'); socket.on('error', () => {})
  socket.on('drain', resume)
  let owner = null, first = true, buffer = '', busy = false
  const lines = []
  async function drain() {
    if (busy) return
    busy = true
    try {
      while (lines.length) {
        const message = JSON.parse(lines.shift())
        if (!first) { input(owner, message); continue }
        first = false
        if (message.action === 'status') { answer(socket, status()); socket.end(); continue }
        if (message.action === 'stop') {
          if (message.args?.instanceId !== instanceId) throw new Error('runtime identity changed')
          if (client && !client.socket.destroyed) throw new Error('stop the Telegram bridge before stopping its native runtime')
          socket.end(JSON.stringify({ ok: true, result: status() }) + '\n', () => void stop(0)); continue
        }
        if (message.action !== 'attach') throw new Error('unknown runtime action')
        if (client && !client.socket.destroyed) throw new Error('the runtime already has a messaging client')
        await start(message.args || {})
        owner = { socket, epoch: ++epoch, ready: false, notified: false, reconnected: Boolean(initialized) }
        client = owner; answer(socket, status()); saveStatus()
      }
    } catch (error) { fail(socket, error) }
    finally { busy = false }
  }
  socket.on('data', part => {
    buffer += part.toString('utf8')
    if (buffer.length > 8 * 1024 * 1024) { socket.destroy(); return }
    let end
    while ((end = buffer.indexOf('\n')) >= 0) { lines.push(buffer.slice(0, end)); buffer = buffer.slice(end + 1) }
    void drain()
  })
  socket.once('close', () => { clients.delete(socket); if (client === owner) { client = null; if (!stopping) saveStatus() } })
})
async function stop(code) {
  if (stopping) return
  stopping = true
  for (const socket of clients) socket.destroy()
  server.close()
  if (app && app.exitCode === null) {
    if (process.env.CODEX_TELEGRAM_RUNTIME_OWN_GROUP === '1' && processInfo(process.pid)?.pgid === process.pid) {
      try { process.kill(-process.pid, 'SIGTERM') } catch {}
    }
    app.kill('SIGTERM')
    await Promise.race([new Promise(resolve => app.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))])
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
  }
  if (process.env.CODEX_TELEGRAM_RUNTIME_OWN_GROUP === '1' && processInfo(process.pid)?.pgid === process.pid) {
    for (const pid of processGroupMembers(process.pid)) {
      if (processInfo(pid)?.pgid === process.pid) try { process.kill(pid, 'SIGKILL') } catch {}
    }
  }
  if (existsSync(path)) unlinkSync(path)
  release(); process.exitCode = code
  setTimeout(() => process.exit(code), 50).unref()
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void stop(0))
server.listen(path, () => { chmodSync(path, 0o600); saveStatus() })
