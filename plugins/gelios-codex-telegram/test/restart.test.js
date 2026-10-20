import assert from 'node:assert/strict'
import { spawn } from './fixtures.js'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mkdtempSync } from './fixtures.js'
import { GeliosBridge } from '../scripts/bridge.js'
import { parseRestart } from '../scripts/restart.js'
import { IdleRestart, idleSnapshot, offlineRestartStatus, readRestart } from '../src/restart.js'
import { acquireLock } from '../src/builds.js'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'idle-restart-')); mkdirSync(join(root, 'state'), { mode: 0o700 })
  const bridge = new GeliosBridge({ stateDir: join(root, 'state'), workspace: root, systemdUnit: 'operator-test.service' })
  bridge.appReady = true; bridge.currentThreadId = 'preserved'; await bridge.ingress
  const calls = [], manager = { MainPID: String(process.pid), ActiveState: 'active', LoadState: 'loaded', CanStart: 'yes', CanStop: 'yes', Job: '0', Result: 'success' }
  let time = Date.parse('2030-01-01T00:00:00Z')
  const run = async args => {
    calls.push(args)
    if (args.includes('restart')) { manager.Job = '1'; return { code: 0, output: '' } }
    return { code: 0, output: Object.entries(manager).map(([name, value]) => name + '=' + value).join('\n') }
  }
  bridge.restart = new IdleRestart(bridge, { run, now: () => time })
  return { root, bridge, calls, manager, run, advance: ms => { time += ms } }
}
const restarts = fix => fix.calls.filter(args => args.includes('restart'))

test('restart CLI requires a bounded request or exact cancellation ID and honours an explicit state directory', () => {
  assert.equal(parseRestart(['--timeout', '15m'], {}).args.timeoutMs, 15 * 60_000)
  assert.equal(parseRestart(['--cancel', 'a'.repeat(24)], {}).action, 'restart_cancel')
  assert.equal(parseRestart(['--timeout', '1s', '--state-dir', '/tmp/selected'], { GELIOS_TELEGRAM_CONTROL_SOCKET: '/tmp/other' }).path, '/tmp/selected/control.sock')
  for (const args of [[], ['--timeout', '0s'], ['--timeout', '-1s'], ['--timeout', 'forever'], ['--cancel', 'invalid'], ['--timeout', '1s', '--cancel', 'a'.repeat(24)], ['--timeout', '1s', '--timeout', '2s'], ['--unknown', 'value']]) assert.throws(() => parseRestart(args, {}))
})

test('a pending restart permits subsequent turns, then closes every dispatch path at its final idle decision', async () => {
  const fix = await fixture(), b = fix.bridge, sent = []
  b.app = { stdin: { writable: true, write: message => sent.push(JSON.parse(message)) } }
  b.activeTurnId = 'first'; const request = await b.restart.request({ timeoutMs: 10_000 })
  await b.restart.tick(); assert.equal(restarts(fix).length, 0)
  b.activeTurnId = null; b.tui = { closed: false }
  b.sendApp({ method: 'turn/start' }); b.activeTurnId = 'later'
  await b.restart.tick(); assert.equal(restarts(fix).length, 0)
  b.tui.closed = true; b.activeTurnId = null
  await b.restart.tick()
  assert.equal(restarts(fix).length, 1); assert.equal(b.restart.status().phase, 'handoff')
  for (const method of ['turn/start', 'turn/steer', 'thread/start', 'thread/resume', 'thread/fork']) assert.throws(() => b.sendApp({ method }), /preparing/)
  await assert.rejects(b.acceptTelegram({}), /preparing/)
  await assert.rejects(b.acceptTelegramControl({}), /preparing/)
  for (const action of ['prepare_tui_launch', 'heartbeat_configure', 'reply']) await assert.rejects(b.handleControl(JSON.stringify({ action })), /preparing/)
  await assert.rejects(b.rpc('turn/start', { threadId: b.currentThreadId }), /preparing/)
  assert.throws(() => b.forwardTui({ id: 7, method: 'turn/start', params: { threadId: b.currentThreadId } }, { closed: false }), /preparing/)
  assert.equal(b.internal.size + b.forwarded.size, 0, 'refused dispatch leaves no outstanding request or timer')
  assert.equal(sent.length, 1)
  assert.equal(statSync(join(b.options.stateDir, 'restart-request.json')).mode & 0o777, 0o600)
  assert.equal(readRestart(b.options.stateDir).id, request.id)
  assert.throws(() => acquireLock(join(b.options.stateDir, 'update-locks')), /already running/)
  await b.restart.tick(); assert.equal(restarts(fix).length, 1, 'handoff is never submitted twice')
})

test('unsettled ingress and every full idle blocker defer restart and are exposed in status', async () => {
  const fix = await fixture(), b = fix.bridge
  await b.restart.request({ timeoutMs: 10_000 })
  let settle; b.ingress = new Promise(resolve => { settle = resolve })
  await b.restart.tick(); assert.equal(restarts(fix).length, 0)
  assert.equal((await b.handleControl('{"action":"status"}')).idle.counts.ingress, 1)
  settle(); await b.ingress
  const cases = [
    ['pendingHumanInputs', 1], ['waitingTelegram', [{}]], ['pendingControlIds', ['queued']], ['runningControls', new Set(['running'])],
    ['telegram', { pendingReplies: 1 }], ['heartbeat', { inFlight: true }], ['batcher', { pending: () => true }],
    ['restoring', true], ['appReady', false], ['turnRetry', {}], ['checkingBuild', true],
    ['restoreQueue', ['waiting']], ['tuiLaunches', new Map([['pending', {}]])],
  ]
  for (const [name, value] of cases) {
    const prior = b[name]; b[name] = value
    await b.restart.tick(); assert.equal(restarts(fix).length, 0, name)
    const status = await b.handleControl('{"action":"status"}')
    assert.equal(status.idle.idle, false, name); assert.ok(status.idle.blockers.length, name)
    b[name] = prior
  }
  await b.restart.tick(); assert.equal(restarts(fix).length, 1)
})

test('late work and cancellation during systemd validation cannot pass the final idle decision', async () => {
  for (const kind of ['turn', 'cancel']) {
    const fix = await fixture(), b = fix.bridge
    const request = await b.restart.request({ timeoutMs: 10_000 })
    let release; const previous = b.restart.run
    b.restart.run = async args => { await new Promise(resolve => { release = resolve }); return previous(args) }
    const check = b.restart.tick(); await new Promise(resolve => setImmediate(resolve))
    if (kind === 'turn') b.activeTurnId = 'started-during-validation'
    else b.restart.cancel(request.id)
    release(); await check
    assert.equal(restarts(fix).length, 0); assert.equal(b.updatePrepared, false)
  }
})

test('cancellation and expiry leave attached terminals and live turns alone', async () => {
  for (const kind of ['cancel', 'timeout']) {
    const fix = await fixture(), b = fix.bridge; b.tui = { closed: false }; b.activeTurnId = 'running'
    const request = await b.restart.request({ timeoutMs: 1000 })
    assert.throws(() => b.restart.cancel('wrong'), /ID/)
    if (kind === 'cancel') b.restart.cancel(request.id)
    else fix.advance(1001)
    await b.restart.tick()
    assert.equal(restarts(fix).length, 0); assert.equal(b.tui.closed, false); assert.equal(b.activeTurnId, 'running')
    assert.equal(b.restart.status().phase, kind === 'cancel' ? 'cancelled' : 'failed')
    if (kind === 'timeout') assert.match(b.restart.status().reason, /tui.*turn|turn.*tui/)
    b.tui.closed = true; b.activeTurnId = null; await b.restart.tick()
    assert.equal(restarts(fix).length, 0)
  }
})

test('missing, foreign or unmanageable units refuse a request without changing admission', async () => {
  for (const kind of ['missing', 'foreign', 'policy', 'bus']) {
    const fix = await fixture(), b = fix.bridge
    if (kind === 'missing') b.options.systemdUnit = null
    if (kind === 'foreign') fix.manager.MainPID = '1'
    if (kind === 'policy') fix.manager.CanStop = 'no'
    if (kind === 'bus') b.restart.run = async () => ({ code: 1, output: 'manager unavailable' })
    await assert.rejects(b.restart.request({ timeoutMs: 1000 }), /systemd|configured/)
    assert.equal(b.updatePrepared, false); assert.equal(b.restart.status(), null); assert.equal(restarts(fix).length, 0)
  }
})

test('a definitive restart refusal releases admission and the update reservation without retry', async () => {
  const fix = await fixture(), b = fix.bridge
  await b.restart.request({ timeoutMs: 1000 })
  const previous = b.restart.run
  b.restart.run = args => args.includes('restart') ? Promise.resolve({ code: 1, output: 'job refused' }) : previous(args)
  await b.restart.tick(); assert.equal(b.restart.status().phase, 'failed'); assert.match(b.restart.status().reason, /refused/)
  assert.equal(b.updatePrepared, false); acquireLock(join(b.options.stateDir, 'update-locks'))()
  await b.restart.tick(); assert.equal(b.restart.status().phase, 'failed')
})

test('restart recovery completes once after the original conversation is restored, and reports failed startup offline', async () => {
  const fix = await fixture(), b = fix.bridge
  await b.restart.request({ timeoutMs: 1000 }); await b.restart.tick()
  const replacement = new GeliosBridge({ ...b.options }); replacement.currentThreadId = b.currentThreadId; replacement.appReady = true
  replacement.restart = new IdleRestart(replacement, { run: fix.run })
  await replacement.restart.tick(); assert.equal(replacement.restart.status().phase, 'completed')
  await replacement.restart.tick(); assert.equal(restarts(fix).length, 1)
  fix.manager.ActiveState = 'failed'; fix.manager.Result = 'exit-code'
  const offline = await offlineRestartStatus(b.options.stateDir, fix.run)
  assert.equal(offline.available, false); assert.match(offline.restart.reason, /exit-code/)
  chmodSync(join(b.options.stateDir, 'restart-request.json'), 0o640)
  assert.throws(() => readRestart(b.options.stateDir), /owner-only/)
})

test('an external updater holds the shared reservation before it creates a journal', async t => {
  const fix = await fixture(), b = fix.bridge
  const module = new URL('../src/builds.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import{acquireLock}from ${JSON.stringify(module)};acquireLock(${JSON.stringify(join(b.options.stateDir, 'update-locks'))});console.log('held');setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => child.kill())
  await new Promise(resolve => child.stdout.once('data', resolve))
  await b.restart.request({ timeoutMs: 10_000 })
  assert.equal(idleSnapshot(b).flags.externalUpdate, true)
  await b.restart.tick(); assert.equal(restarts(fix).length, 0)
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited
  await b.restart.tick(); assert.equal(restarts(fix).length, 1)
})

test('update shutdown shares the full work snapshot and cannot cross a committed restart', async () => {
  const fix = await fixture(), b = fix.bridge
  b.shutdown = async () => {}
  const stop = JSON.stringify({ action: 'stop_for_update', instanceId: b.instanceId })
  b.telegram = { pendingReplies: 1 }
  await assert.rejects(b.handleControl(stop), /replies/)
  assert.equal(b.updatePrepared, false)
  b.telegram.pendingReplies = 0
  await b.restart.request({ timeoutMs: 10_000 }); await b.restart.tick()
  await assert.rejects(b.handleControl(stop), /idle restart is already committed/)
  assert.equal(b.updatePrepared, true)
})

test('an indeterminate restart handoff keeps admission closed until systemd proves no job remains', async () => {
  const fix = await fixture(), b = fix.bridge, previous = b.restart.run
  await b.restart.request({ timeoutMs: 10_000 })
  b.restart.run = async args => {
    if (args.includes('restart')) { fix.manager.Job = '12'; return { code: null, output: 'connection ended' } }
    return previous(args)
  }
  await b.restart.tick(); assert.equal(b.updatePrepared, true); assert.equal(b.restart.status().phase, 'handoff')
  fix.manager.Job = '0'; await b.restart.tick()
  assert.equal(b.updatePrepared, false); assert.equal(b.restart.status().phase, 'failed')
  acquireLock(join(b.options.stateDir, 'update-locks'))()
})
