import assert from 'node:assert/strict'
import { spawn } from './fixtures.js'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mkdtempSync } from './fixtures.js'
import { GeliosBridge } from '../scripts/bridge.js'
import { parseRestart } from '../scripts/restart.js'
import { IdleRestart, idleSnapshot, offlineRestartStatus, readRestart, REPLACEMENT_WAIT_MS, waitForRestart } from '../src/restart.js'
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
  return { root, bridge, calls, manager, run, now: () => time, advance: ms => { time += ms } }
}
const restarts = fix => fix.calls.filter(args => args.includes('restart'))

test('restart CLI requires a bounded request or exact cancellation ID and honours an explicit state directory', () => {
  assert.equal(parseRestart(['--timeout', '15m'], {}).args.timeoutMs, 15 * 60_000)
  assert.equal(parseRestart(['--cancel', 'a'.repeat(24)], {}).action, 'restart_cancel')
  assert.equal(parseRestart(['--timeout', '1s', '--state-dir', '/tmp/selected'], { GELIOS_TELEGRAM_CONTROL_SOCKET: '/tmp/other' }).path, '/tmp/selected/control.sock')
  assert.equal(parseRestart(['--timeout', '15m'], {}).wait, false)
  const waiting = parseRestart(['--wait', '--timeout', '15m', '--state-dir', '/tmp/selected'], {})
  assert.deepEqual([waiting.wait, waiting.args.timeoutMs, waiting.stateDir], [true, 15 * 60_000, '/tmp/selected'])
  for (const args of [[], ['--timeout', '0s'], ['--timeout', '-1s'], ['--timeout', 'forever'], ['--cancel', 'invalid'], ['--timeout', '1s', '--cancel', 'a'.repeat(24)], ['--timeout', '1s', '--timeout', '2s'], ['--unknown', 'value'],
    ['--wait'], ['--cancel', 'a'.repeat(24), '--wait'], ['--timeout', '1s', '--wait', '--wait'], ['--timeout', '1s', '--wait', 'yes']]) assert.throws(() => parseRestart(args, {}))
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

test('replacement readiness timing begins after systemd stop, and never interrupts restoration', async () => {
  const fix = await fixture(), b = fix.bridge
  await b.restart.request({ timeoutMs: 1000 }); await b.restart.tick()
  fix.advance(60_000) // A unit may spend this time in its configured stop job.
  const replacement = new GeliosBridge({ ...b.options }); replacement.currentThreadId = b.currentThreadId
  replacement.restart = new IdleRestart(replacement, { run: fix.run, now: fix.now })
  await replacement.restart.tick(); assert.equal(replacement.restart.status().phase, 'handoff')
  fix.advance(20_001); await replacement.restart.tick()
  assert.equal(replacement.restart.status().phase, 'failed'); assert.match(replacement.restart.status().reason, /readiness/)
  assert.equal(replacement.shuttingDown, false); assert.equal(restarts(fix).length, 1)
})

// Drives one wait under the fixture's clock: each poll interval advances the clock, then runs the next step,
// which may change who answers on the control socket (`at.serving`; null for no answer).
function follow(fix, request, steps, { cap = () => Infinity } = {}) {
  const at = { serving: fix.bridge }
  const control = async () => {
    if (!at.serving) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    return at.serving.handleControl('{"action":"status"}')
  }
  const sleep = async ms => {
    fix.advance(ms)
    if (fix.now() > cap()) throw new Error('the wait outlived its bound')
    await steps.shift()?.(at)
  }
  return waitForRestart(request, { path: join(fix.root, 'unused.sock'), stateDir: fix.bridge.options.stateDir, control, run: fix.run, now: fix.now, sleep })
}
function replacementOf(fix, { ready = true } = {}) {
  const replacement = new GeliosBridge({ ...fix.bridge.options }); replacement.currentThreadId = fix.bridge.currentThreadId; replacement.appReady = ready
  replacement.restart = new IdleRestart(replacement, { run: fix.run, now: fix.now })
  return replacement
}

test('a wait follows its request across the old bridge exit and offline answers, a failed unit included, to the phase the replacement writes', async () => {
  const fix = await fixture(), b = fix.bridge
  b.activeTurnId = 'running'
  const request = await b.restart.request({ timeoutMs: 600_000 })
  let replacement
  const steps = [
    async () => { await b.restart.tick(); assert.equal(restarts(fix).length, 0, 'the running turn holds the restart') },
    async () => { b.activeTurnId = null; await b.restart.tick(); assert.equal(b.restart.status().phase, 'handoff') },
    at => { at.serving = null; fix.manager.ActiveState = 'deactivating' },
    // While the bridge is down the unit reads failed, which the offline status reports as a failed phase.
    async () => {
      Object.assign(fix.manager, { ActiveState: 'failed', Result: 'exit-code' })
      assert.equal((await offlineRestartStatus(b.options.stateDir, fix.run)).restart.phase, 'failed')
    },
    at => { Object.assign(fix.manager, { ActiveState: 'active', Result: 'success' }); replacement = replacementOf(fix); at.serving = replacement },
    // The replacement completes the request and is gone again before the next read.
    async at => { await replacement.restart.tick(); assert.equal(replacement.restart.status().phase, 'completed'); at.serving = null },
  ]
  const result = await follow(fix, request, steps)
  assert.equal(steps.length, 0, 'every step ran before the outcome')
  assert.equal(result.code, 0); assert.equal(result.restart.id, request.id); assert.equal(result.restart.phase, 'completed')
})

test('a wait reports failed when the replacement never becomes ready, counting from the old bridge stop', async () => {
  for (const kind of ['answers', 'offline']) {
    const fix = await fixture(), b = fix.bridge
    const request = await b.restart.request({ timeoutMs: 1000 }); await b.restart.tick()
    assert.equal(b.restart.status().phase, 'handoff')
    let stopping
    const steps = [
      () => {}, () => {},
      // The old bridge's socket closes, and a slow stop job outlasts the request's deadline and the replacement's whole window.
      ...Array.from({ length: 120 }, () => at => { at.serving = null; fix.manager.ActiveState = 'deactivating'; stopping = fix.now() }),
      at => {
        fix.manager.ActiveState = kind === 'offline' ? 'activating' : 'active'
        // A replacement whose startup never finishes answers in handoff and never ticks.
        if (kind === 'answers') at.serving = replacementOf(fix, { ready: false })
      },
    ]
    const result = await follow(fix, request, steps, { cap: () => stopping + REPLACEMENT_WAIT_MS + 5000 })
    assert.equal(result.code, 2, kind); assert.equal(result.restart.id, request.id); assert.equal(result.restart.phase, 'failed')
    assert.ok(fix.now() >= stopping + REPLACEMENT_WAIT_MS && fix.now() < stopping + REPLACEMENT_WAIT_MS + 1000, `${kind} ended ${fix.now() - stopping}ms after the stop`)
    assert.match(result.restart.reason, kind === 'offline' ? /no outcome 40s after .*unit is activating/ : /no outcome 40s after .*reports handoff and is not ready/)
  }
})

test('a wait ends on the bridge failure to read the request, and refuses a request another one replaced', async () => {
  const fix = await fixture(), b = fix.bridge
  b.activeTurnId = 'running'
  const request = await b.restart.request({ timeoutMs: 600_000 })
  b.restart.error = 'invalid restart request state'
  assert.deepEqual(await follow(fix, request, []), { code: 2, restart: { phase: 'failed', reason: 'invalid restart request state' } })
  b.restart.error = null; b.restart.cancel(request.id); await b.restart.request({ timeoutMs: 1000 })
  await assert.rejects(follow(fix, request, []), /was replaced by/)
})

// The CLI runs as its own process against the fixture bridge's real control socket. When nothing answers, it asks
// a systemctl on PATH, which logs each call and prints the unit state the test last wrote.
const restartScript = fileURLToPath(new URL('../scripts/restart.js', import.meta.url))
async function until(check, label, timeout = 10_000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 20))) if (await check()) return
  throw new Error('Timed out: ' + label)
}
async function served(t, fix, bridge = fix.bridge) {
  bridge.options.controlSocket = join(fix.bridge.options.stateDir, 'control.sock')
  const handle = bridge.handleControl.bind(bridge); bridge.actions = []
  bridge.handleControl = (line, signal) => { bridge.actions.push(JSON.parse(line).action); return handle(line, signal) }
  bridge.controlServer = await bridge.createControlServer()
  t.after(() => new Promise(resolve => bridge.controlServer.close(() => resolve())))
  return bridge
}
const unit = (fix, ActiveState) => writeFileSync(join(fix.root, 'unit-state'), Object.entries({ ...fix.manager, ActiveState }).map(([name, value]) => `${name}=${value}\n`).join(''))
function cli(fix, argv) {
  const bin = join(fix.root, 'bin')
  if (!existsSync(bin)) {
    mkdirSync(bin)
    writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> '${join(fix.root, 'systemctl.log')}'\ncat '${join(fix.root, 'unit-state')}'\n`, { mode: 0o700 })
  }
  const child = spawn(process.execPath, [restartScript, ...argv, '--state-dir', fix.bridge.options.stateDir], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', part => { out += part }); child.stderr.on('data', part => { err += part })
  child.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, out, err })) })
  return child
}

test('restart --wait completes after the running turn ends, across the old bridge exit, and exits 0', async t => {
  const fix = await fixture(), b = await served(t, fix)
  b.activeTurnId = 'running'; unit(fix, 'active')
  const waiter = cli(fix, ['--timeout', '15m', '--wait'])
  await until(() => b.actions.includes('status'), 'the waiting caller reads status')
  const request = b.restart.status(); assert.equal(request.phase, 'pending')
  await b.restart.tick(); assert.equal(restarts(fix).length, 0); assert.equal(waiter.exitCode, null)
  b.activeTurnId = null; await b.restart.tick(); assert.equal(b.restart.status().phase, 'handoff')
  // The old bridge's socket closes while systemd stops it, then the replacement answers on the same path.
  unit(fix, 'deactivating'); await new Promise(resolve => b.controlServer.close(resolve))
  await until(() => existsSync(join(fix.root, 'systemctl.log')), 'the waiting caller reads the offline answer')
  unit(fix, 'active')
  const replacement = await served(t, fix, replacementOf(fix))
  await until(() => replacement.actions.includes('status'), 'the waiting caller reads the replacement')
  assert.equal(waiter.exitCode, null, 'an offline answer is not the outcome')
  await replacement.restart.tick()
  const { code, out, err } = await waiter.done
  assert.equal(code, 0, err)
  const record = JSON.parse(out)
  assert.equal(record.id, request.id); assert.equal(record.phase, 'completed')
})

test('restart --wait that reaches its deadline exits 2 with the remaining blockers', async t => {
  const fix = await fixture(), b = await served(t, fix)
  b.activeTurnId = 'running'
  const waiter = cli(fix, ['--timeout', '1s', '--wait'])
  await until(() => b.actions.includes('status'), 'the waiting caller reads status')
  fix.advance(1001); await b.restart.tick()
  const { code, out, err } = await waiter.done
  assert.equal(code, 2, err)
  const record = JSON.parse(out)
  assert.equal(record.phase, 'failed'); assert.match(record.reason, /idle deadline reached: turn/)
})

test('restart --wait follows the request already pending and exits 3 when it is cancelled', async t => {
  const fix = await fixture(), b = await served(t, fix)
  b.activeTurnId = 'running'
  const request = await b.restart.request({ timeoutMs: 600_000 })
  const waiter = cli(fix, ['--timeout', '15m', '--wait'])
  await until(() => b.actions.includes('status'), 'the waiting caller reads status')
  const cancel = await cli(fix, ['--cancel', request.id]).done
  assert.equal(cancel.code, 0, cancel.err)
  const { code, out, err } = await waiter.done
  assert.equal(code, 3, err)
  const record = JSON.parse(out)
  assert.equal(record.id, request.id); assert.equal(record.phase, 'cancelled')
})
