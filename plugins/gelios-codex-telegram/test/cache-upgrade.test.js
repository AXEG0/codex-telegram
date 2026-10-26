import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, spawn } from './fixtures.js'
import { StateStore, processInfo } from '../src/core.js'
import { controlRequest } from '../scripts/update.js'
import { automaticAttempt, pluginDigest } from '../src/builds.js'
import { GeliosBridge } from '../scripts/bridge.js'
import { candidateAt } from './support/candidate.js'

const realSystemd = process.env.GELIOS_SYSTEMD_TEST === '1'
const source = fileURLToPath(new URL('../', import.meta.url))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check().catch(() => false)
    if (result) return result
    await wait(50)
  }
  throw new Error(`Timed out: ${label}`)
}
async function terminal(socketPath) {
  const socket = net.createConnection(socketPath)
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
  await new Promise((resolve, reject) => socket.once('data', data => data.toString().includes('101 Switching Protocols') ? resolve() : reject(new Error('TUI handshake failed'))))
  return socket
}

test('build reconciliation defers every pending turn and attached TUI before any discovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'build-idle-'))
  writeFileSync(join(root, 'launch-profile.json'), '{}', { mode: 0o600 })
  const bridge = new GeliosBridge({ stateDir: root, workspace: root, codexBin: '/must-not-run' })
  bridge.appReady = true
  for (const [key, value] of [['activeTurnId', 'busy'], ['tui', { closed: false }], ['pendingHumanInputs', 1],
    ['restoring', true], ['turnRetry', {}], ['updatePrepared', true], ['checkingBuild', true], ['runningThreads', new Set(['subagent'])]]) {
    bridge[key] = value
    assert.equal(await bridge.reconcileInstalledBuild(), false, key)
    bridge[key] = null
  }
})

for (const predecessor of [false, true]) test(predecessor
  ? 'released 0.4.11 automatically reaches the fixed package and a following changed MCP entry, with visible refusals'
  : 'Codex cache replacement survives a supervised restart and reconciles the pending build after TUI detach', { timeout: 240_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cache-cutover-'))
  const stateDir = join(root, 'state'), workspace = join(root, 'work'), bin = join(root, 'bin')
  const initialVersion = predecessor ? '0.4.11' : '0.4.7', fixedVersion = predecessor ? JSON.parse(readFileSync(join(source, 'package.json'))).version : '0.4.8'
  const codexHome = join(root, 'codex-home'), old = join(codexHome, 'plugins/cache/codex-telegram/telegram', initialVersion)
  const next = join(dirname(old), fixedVersion), release = join(root, 'release')
  const selected = join(root, 'selected.json'), completed = join(root, 'turn-completed')
  const bindingReady = join(root, 'binding-ready'), supervisorEnv = join(root, 'supervisor-env.json')
  let verified = false
  const fakeCodex = join(root, 'codex'), pidFile = join(root, 'unit.pid'), manager = join(bin, 'systemctl')
  const serviceLog = join(root, 'service.log'), appLog = join(root, 'app.jsonl')
  const unit = `codex-telegram-test-${process.pid}-${randomBytes(4).toString('hex')}.service`, managed = join(bin, 'gelios-codex-telegram')
  mkdirSync(workspace); mkdirSync(bin); mkdirSync(dirname(old), { recursive: true })
  if (predecessor) {
    // Use the actual released package, including its unchanged validation code.
    mkdirSync(old)
    const archive = execFileSync('git', ['archive', 'ec230e2', 'plugins/gelios-codex-telegram'], { cwd: dirname(dirname(source.slice(0, -1))), maxBuffer: 8 * 1024 * 1024 })
    execFileSync('tar', ['-xf', '-', '--strip-components=2', '-C', old], { input: archive })
    assert.equal(JSON.parse(readFileSync(join(old, 'package.json'))).version, initialVersion)
    for (const name of ['.mcp.json', 'src/bootstrap.js']) assert.equal(readFileSync(join(old, name), 'utf8'), readFileSync(join(source, name), 'utf8'))
  } else candidateAt(source, old, initialVersion)
  candidateAt(source, release, fixedVersion)
  const selection = path => ({ name: 'telegram', marketplaceName: 'codex-telegram', enabled: true, installed: true,
    version: JSON.parse(readFileSync(join(path, 'package.json'))).version, installedPath: path })
  writeFileSync(selected, JSON.stringify(selection(old)))
  const store = new StateStore(stateDir)
  store.saveBinding({ threadId: 'kept-conversation', workspace, initialize: { clientInfo: { name: 'cache-test', version: '1' } } })
  const protectedFile = join(stateDir, 'protected-evidence'); writeFileSync(protectedFile, 'preserve me')
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import readline from 'node:readline'
const paths = ${JSON.stringify({ selected, old, next, release, completed, bindingReady, appLog })}
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const args = process.argv.slice(2).join(' ')
if (args === 'plugin list --json') { send({ installed: [JSON.parse(readFileSync(paths.selected))] }); process.exit() }
if (args === 'plugin marketplace list --json') { send({ marketplaces: [{ name: 'codex-telegram', root: paths.release }] }); process.exit() }
if (args !== 'app-server --listen stdio://') throw new Error('Unexpected native command: ' + args)
// Reproduce Codex's startup replacement, including pruning the previous version.
if (existsSync(paths.old)) {
  cpSync(paths.release, paths.next, { recursive: true }); rmSync(paths.old, { recursive: true })
  writeFileSync(paths.selected, JSON.stringify({ name: 'telegram', marketplaceName: 'codex-telegram', enabled: true,
    installed: true, version: JSON.parse(readFileSync(paths.next + '/package.json')).version, installedPath: paths.next }))
}
let busy = false
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); appendFileSync(paths.appLog, line + '\\n')
  if (m.method === 'initialize') {
    const timer = setInterval(() => { if (existsSync(paths.bindingReady)) { clearInterval(timer); send({ id: m.id, result: { userAgent: 'cache-fixture' } }) } }, 10)
  }
  else if (m.method === 'thread/resume') {
    send({ id: m.id, result: { thread: { id: m.params.threadId }, approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } } })
    if (!existsSync(paths.completed)) setTimeout(() => { busy = true; send({ method: 'turn/started', params: { threadId: m.params.threadId, turn: { id: 'existing-turn', status: 'inProgress' } } }) }, 25)
  } else if (m.method === 'thread/loaded/list') send({ id: m.id, result: { data: ['kept-conversation'], nextCursor: null } })
  else if (m.method === 'thread/read') send({ id: m.id, result: { thread: { id: 'kept-conversation', turns: [] } } })
  else if (m.id) throw new Error('Unexpected runtime method: ' + m.method)
})
setInterval(() => { if (busy && existsSync(paths.completed)) { busy = false; send({ method: 'turn/completed', params: { threadId: 'kept-conversation', turn: { id: 'existing-turn', status: 'completed' } } }) } }, 20)
`, { mode: 0o700 })
  const api = http.createServer(async (request, response) => {
    for await (const _ of request) {}
    if (request.url.endsWith('/getUpdates')) await wait(25)
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, result: request.url.endsWith('/getUpdates') ? [] : true }))
  })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(() => api.close())
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, CODEX_HOME: codexHome,
    GELIOS_TELEGRAM_LAUNCHER_DIR: bin, GELIOS_TELEGRAM_STATE_DIR: stateDir,
    GELIOS_TELEGRAM_API_BASE: `http://127.0.0.1:${api.address().port}`, TELEGRAM_BOT_TOKEN: `123456789:${'z'.repeat(32)}` }
  delete env.GELIOS_CODEX_CHILD; delete env.GELIOS_TELEGRAM_LAUNCHER_LINK
  const bridgeArgs = ['bridge', '--state-dir', stateDir, '--workspace', workspace, '--codex-bin', fakeCodex, '--systemd-unit', unit, '--transcription-api-key-env', 'TEST_AUDIO_SLOT', '--codex-runtime-env', 'TEST_RUNTIME_SLOT', '--marketplace-auth-env', 'TEST_GIT_SLOT']
  Object.assign(env, { TEST_AUDIO_SLOT: 'fixture-audio', TEST_RUNTIME_SLOT: 'fixture-runtime', TEST_GIT_SLOT: 'fixture-git' })
  const serviceEnv = Object.fromEntries(['TEST_AUDIO_SLOT', 'TEST_RUNTIME_SLOT', 'TEST_GIT_SLOT', 'XDG_RUNTIME_DIR', 'PATH', 'CODEX_HOME', 'GELIOS_TELEGRAM_LAUNCHER_DIR', 'GELIOS_TELEGRAM_STATE_DIR', 'GELIOS_TELEGRAM_API_BASE', 'TELEGRAM_BOT_TOKEN'].filter(name => env[name]).map(name => [name, env[name]]))
  writeFileSync(manager, `#!/usr/bin/env node
const { spawn, execFileSync } = require('node:child_process')
const { existsSync, openSync, readFileSync, writeFileSync } = require('node:fs')
const file = ${JSON.stringify(pidFile)}, unit = ${JSON.stringify(unit)}
const pid = () => existsSync(file) ? Number(readFileSync(file)) : 0
const alive = () => { try { const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid())], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return Boolean(state) && !state.startsWith('Z') } catch { return false } }
async function main() {
  const args = process.argv.slice(2); if (args.shift() !== '--user') return 64
  if (args[0] === 'show') { console.log(alive() ? 'active' : 'inactive'); return 0 }
  if (args[0] === 'is-active') return alive() ? 0 : 3
  if (args[0] === 'is-failed') return 1
  if (args[0] === 'stop') {
    if (alive()) process.kill(-pid(), 'SIGTERM')
    for (let i = 0; i < 100 && alive(); i++) await new Promise(r => setTimeout(r, 10))
    if (alive()) process.kill(-pid(), 'SIGKILL')
    for (let i = 0; i < 100 && alive(); i++) await new Promise(r => setTimeout(r, 10))
    return alive() ? 1 : 0
  }
  if (args[0] !== 'start' || args[1] !== unit || alive()) return 5
  const log = openSync(${JSON.stringify(serviceLog)}, 'a')
  const child = spawn(${JSON.stringify(managed)}, ${JSON.stringify(bridgeArgs)}, { env: ${JSON.stringify(serviceEnv)}, detached: true, stdio: ['ignore', log, log] })
  writeFileSync(file, String(child.pid)); child.unref(); return 0
}
main().then(code => { process.exitCode = code }).catch(e => { console.error(e); process.exitCode = 1 })
`, { mode: 0o700 })
  if (realSystemd) {
    // Only this test's new runtime-linked unit is created. Existing units,
    // installations, manager settings and service processes are untouched.
    const unitPath = join(root, unit)
    const quote = value => JSON.stringify(value).replaceAll('%', '%%')
    writeFileSync(unitPath, `[Service]\nType=simple\nUMask=0077\nKillMode=control-group\nRestart=on-failure\nTimeoutStopSec=5\nStandardOutput=append:${serviceLog}\nStandardError=append:${serviceLog}\nWorkingDirectory=${workspace}\nExecStart=${[managed, ...bridgeArgs].map(quote).join(' ')}\n` +
      Object.entries(serviceEnv).map(([name, value]) => `Environment=${quote(name + '=' + value)}\n`).join(''))
    const actualSystemctl = execFileSync('/bin/sh', ['-c', 'command -v systemctl'], { encoding: 'utf8' }).trim()
    writeFileSync(manager, `#!/bin/sh\nexec ${JSON.stringify(actualSystemctl)} "$@"\n`, { mode: 0o700 })
    execFileSync(manager, ['--user', 'link', '--runtime', unitPath], { env })
    const actualRun = execFileSync('/bin/sh', ['-c', 'command -v systemd-run'], { encoding: 'utf8' }).trim()
    writeFileSync(join(bin, 'systemd-run'), `#!/usr/bin/env node\nconst{spawn}=require('node:child_process'),{writeFileSync}=require('node:fs');writeFileSync(${JSON.stringify(supervisorEnv)},JSON.stringify({env:process.env,args:process.argv.slice(2)}));const c=spawn(${JSON.stringify(actualRun)},process.argv.slice(2),{stdio:'inherit'});c.on('close',code=>process.exitCode=code);c.on('error',e=>{console.error(e);process.exitCode=1})\n`, { mode: 0o700 })

  } else {
    writeFileSync(join(bin, 'systemd-run'), `#!/usr/bin/env node
const {spawn}=require('node:child_process'),{openSync,writeFileSync}=require('node:fs');const args=process.argv.slice(2),at=args.indexOf('--'),env={};for(const arg of args.slice(0,at))if(arg.startsWith('--setenv=')){const part=arg.slice(9),i=part.indexOf('=');env[part.slice(0,i)]=part.slice(i+1)}writeFileSync(${JSON.stringify(supervisorEnv)},JSON.stringify({env:process.env,args}));const log=openSync(${JSON.stringify(join(stateDir, 'build-update.log'))},'a');const child=spawn(args[at+1],args.slice(at+2),{env,detached:true,stdio:['ignore',log,log]});child.unref();child.once('error',e=>{console.error(e);process.exitCode=1})
`, { mode: 0o700 })
  }
  t.after(() => { if (!verified) for (const path of [serviceLog, join(stateDir, 'build-update.log')]) if (existsSync(path)) console.error(path + '\n' + readFileSync(path, 'utf8').slice(-10000)) })
  const sockets = []
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    if (realSystemd || existsSync(pidFile)) { try { execFileSync(manager, ['--user', 'stop', unit], { env }) } catch (error) { if (!realSystemd) throw error } }
    await until(async () => !existsSync(pidFile) || !processInfo(Number(readFileSync(pidFile))), 'owned service cleanup', 5000)
    if (realSystemd) {
      const link = join(env.XDG_RUNTIME_DIR, 'systemd/user', unit)
      if (existsSync(link)) unlinkSync(link)
      execFileSync(manager, ['--user', 'daemon-reload'], { env })
      try { execFileSync(manager, ['--user', 'reset-failed', unit], { env, stdio: 'ignore' }) } catch {}
    }
  })
  const launch = args => new Promise((resolve, reject) => {
    const child = spawn(managed, args, { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''; child.stdout.on('data', x => { out += x }); child.stderr.on('data', x => { err += x })
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err + (existsSync(serviceLog) ? readFileSync(serviceLog) : ''))))
  })
  execFileSync(process.execPath, [join(old, 'scripts/setup.js'), '--prepare', '--state-dir', stateDir], { env, cwd: workspace })
  assert.match(realpathSync(managed), /runtime-builds\/[a-f0-9]{64}\/bin\/gelios-codex-telegram$/)
  const receipt = await launch(['bridge', '--detach', '--json', ...bridgeArgs.slice(1)])
  if (realSystemd) {
    const policy = execFileSync(manager, ['--user', 'show', unit, '--property=KillMode', '--property=Restart'], { env, encoding: 'utf8' })
    assert.match(policy, /KillMode=control-group/); assert.match(policy, /Restart=on-failure/)
  }
  const status = () => controlRequest(join(stateDir, 'control.sock'), { action: 'status' })
  await until(async () => !existsSync(old), 'startup upgrade removes the old cache')
  assert.equal(existsSync(old), false, 'the startup upgrade removed the old cache')
  const tui = await terminal(join(stateDir, 'app-server.sock')); sockets.push(tui)
  writeFileSync(bindingReady, 'ready')
  await until(async () => (await status()).turnId === 'existing-turn', 'original active turn')
  await wait(1300)
  assert.equal((await status()).pid, receipt.pid, 'active turn and TUI block cutover')
  writeFileSync(completed, 'done')
  await until(async () => !(await status()).turnId, 'existing turn completes')
  assert.equal((await status()).pid, receipt.pid, 'an idle attached TUI still blocks cutover')

  // A supervised restart before the pending cutover must use the durable build.
  tui.destroy()
  unlinkSync(bindingReady)
  execFileSync(manager, ['--user', 'stop', unit], { env })
  execFileSync(manager, ['--user', 'start', unit], { env })
  await until(async () => { const s = await status(); return s.appRunning && s.pid !== receipt.pid }, 'restarted backend')
  const pendingTui = await terminal(join(stateDir, 'app-server.sock')); sockets.push(pendingTui)
  writeFileSync(bindingReady, 'ready')
  const restarted = await until(async () => { const s = await status(); return s.ready && s.pid !== receipt.pid && s }, 'service restarts after cache pruning')
  assert.equal(restarted.threadId, 'kept-conversation')
  assert.equal(restarted.pluginVersion, initialVersion)
  const profile = JSON.parse(readFileSync(join(stateDir, 'launch-profile.json')))
  assert.equal(existsSync(realpathSync(profile.launcherLink)), true)
  await wait(1400)
  assert.equal((await status()).pid, restarted.pid, 'pending cutover survives restart and waits for TUI detach')
  pendingTui.destroy()
  const final = await until(async () => { const s = await status(); return s.ready && s.pluginVersion === fixedVersion && s }, 'automatic transactional cutover after detach', 70_000)
  await until(async () => !existsSync(join(stateDir, 'update-transaction.json')), 'cutover commits')
  if (realSystemd) await until(async () => {
    try { execFileSync(manager, ['--user', 'is-active', `codex-telegram-update-${restarted.instanceId}.service`], { env, stdio: 'ignore' }); return false } catch { return true }
  }, 'transient supervisor finishes outside the stopped bridge cgroup')
  assert.notEqual(final.pid, restarted.pid)
  if (realSystemd) assert.equal(final.pid, Number(execFileSync(manager, ['--user', 'show', unit, '--property=MainPID', '--value'], { env, encoding: 'utf8' }).trim()))
  else assert.equal(final.pid, Number(readFileSync(pidFile)))
  assert.equal(final.threadId, 'kept-conversation'); assert.equal(final.workspace, workspace)
  assert.equal(realpathSync(profile.launcherLink), join(final.pluginRoot, 'bin/gelios-codex-telegram'))
  assert.equal(readFileSync(protectedFile, 'utf8'), 'preserve me')
  assert.equal(readFileSync(appLog, 'utf8').includes('thread/start'), false, 'no replacement conversation')
  const supervisor = readFileSync(supervisorEnv, 'utf8')
  for (const secret of ['fixture-audio', 'fixture-runtime', 'fixture-git']) assert.equal(supervisor.includes(secret), false, 'supervisor receives no service credentials')
  const initialized = execFileSync(process.execPath, [join(next, 'scripts/mcp.js')], { env, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n', encoding: 'utf8' })
  assert.equal(JSON.parse(initialized.trim()).result.serverInfo.version, final.pluginVersion, 'MCP and bridge agree')
  if (predecessor) {
    const following = join(dirname(next), '0.5.0')
    for (const kind of ['corrupt', 'foreign', 'changed-entry']) {
      // Replacing this owned cache folder models each installed candidate.
      const published = candidateAt(source, join(root, kind), '0.5.0', true)
      if (kind === 'corrupt') writeFileSync(join(published.installedPath, '.mcp.json'), '{}')
      if (kind === 'foreign') {
        const path = join(published.installedPath, '.codex-plugin/plugin.json'), manifest = JSON.parse(readFileSync(path))
        manifest.name = 'foreign'; writeFileSync(path, JSON.stringify(manifest))
      }
      cpSync(published.installedPath, following, { recursive: true })
      const expected = pluginDigest(following, null, 0o700)
      writeFileSync(selected, JSON.stringify(selection(following)))
      if (kind !== 'changed-entry') {
        const refused = await until(async () => { const s = await status(); return s.automaticBuild?.digest === expected && s.automaticBuild.status === 'failed' && s }, 'visible refusal: ' + kind, 45_000)
        assert.equal(refused.pid, final.pid); assert.equal(refused.threadId, final.threadId)
        assert.ok(refused.automaticBuild.reason)
      } else {
        const adopted = await until(async () => { const s = await status(); return s.ready && s.pluginVersion === '0.5.0' && s }, 'changed-entry automatic cutover', 70_000)
        await until(async () => !existsSync(join(stateDir, 'update-transaction.json')), 'following cutover commits')
        assert.notEqual(adopted.pid, final.pid); assert.equal(adopted.threadId, final.threadId)
        assert.equal((await status()).automaticBuild, null)
        assert.equal(existsSync(join(adopted.pluginRoot, 'scripts/mcp.js')), false)
        const config = JSON.parse(readFileSync(join(following, '.mcp.json'))).mcpServers.telegram
        const reply = execFileSync(config.command, config.args, { cwd: config.cwd, env: { ...env, GELIOS_TELEGRAM_MCP_ROOT: adopted.pluginRoot },
          input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n', encoding: 'utf8' })
        assert.equal(JSON.parse(reply.trim()).result.serverInfo.version, '0.5.0')
        assert.equal(readFileSync(protectedFile, 'utf8'), 'preserve me')
      }
    }
    assert.equal(readFileSync(appLog, 'utf8').includes('thread/start'), false)
  }
  verified = true
})

test('an active automatic unit prevents discovery and a different installed digest clears a failed block', async () => {
  const root = mkdtempSync(join(tmpdir(), 'build-attempt-')), bin = join(root, 'bin'); mkdirSync(bin)
  writeFileSync(join(root, 'launch-profile.json'), '{}', { mode: 0o600 })
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\necho deactivating\n', { mode: 0o700 })
  const bridge = new GeliosBridge({ stateDir: root, workspace: root, codexBin: '/must-not-run' })
  bridge.appReady = true
  const saved = process.env.PATH; process.env.PATH = bin + ':' + saved
  try {
    for (const status of ['pending', 'failed']) {
      automaticAttempt(root, { digest: 'f'.repeat(64), status, unit: 'codex-telegram-test-active.service' })
      assert.equal(await bridge.reconcileInstalledBuild(), false)
    }
  } finally { process.env.PATH = saved }
  const discovery = join(root, 'codex')
  const selected = { name: 'telegram', marketplaceName: 'codex-telegram', version: JSON.parse(readFileSync(join(source, 'package.json'))).version, installed: true, enabled: true, installedPath: source }
  writeFileSync(discovery, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ installed: [selected] }))})\n`, { mode: 0o700 })
  bridge.options.codexBin = discovery; bridge.updateEnvironment = { PATH: saved }
  automaticAttempt(root, { digest: 'f'.repeat(64), status: 'failed' })
  assert.notEqual(pluginDigest(source, null, 0o700), 'f'.repeat(64))
  assert.equal(await bridge.reconcileInstalledBuild(), false)
  assert.equal(automaticAttempt(root), null)
})
