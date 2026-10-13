import { mkdtempSync, spawn } from './fixtures.js'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseArgs, profileFor, takeSupervisedStart } from '../scripts/bridge.js'

const cli = fileURLToPath(new URL('../bin/gelios-codex-telegram', import.meta.url))
const TEST_TOKEN = `123456789:${'a'.repeat(32)}`
const UNIT = 'gelios-test.service'
const pause = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

function collect(child) {
  let stdout = ''; let stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  return new Promise(resolvePromise => child.on('exit', code => resolvePromise({ code, stdout, stderr })))
}
function controlRequest(path, request = { action: 'status' }) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection(path)
    let value = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', chunk => {
      value += chunk
      const newline = value.indexOf('\n')
      if (newline < 0) return
      socket.end(); resolvePromise(JSON.parse(value.slice(0, newline)))
    })
    socket.on('error', reject)
  })
}

test('--systemd-unit is validated and recorded last in the launch profile', () => {
  const base = ['--state-dir', '/tmp/gelios-s', '--workspace', '/tmp/gelios-w', '--codex-runtime-env', 'SLOT_A']
  const options = parseArgs([...base, '--systemd-unit', UNIT])
  assert.equal(options.systemdUnit, UNIT)
  const profile = profileFor(options)
  assert.equal(profile.systemdUnit, UNIT)
  assert.deepEqual(profile.bridgeArgs.slice(-2), ['--systemd-unit', UNIT])
  assert.equal(Object.hasOwn(profileFor(parseArgs(base)), 'systemdUnit'), false)
  assert.equal(parseArgs(base).systemdUnit, null)
  for (const bad of ['bad unit.service', 'gelios.timer', '../x.service', '']) {
    assert.throws(() => parseArgs([...base, '--systemd-unit', bad]), /systemd service unit/)
  }
})

test('a supervised start handoff is consumed once and only for its own unit', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gelios-handoff-')))
  const options = parseArgs(['--state-dir', root, '--systemd-unit', UNIT])
  const path = join(root, 'supervised-start.json')
  const write = (value, mode = 0o600) => { writeFileSync(path, JSON.stringify(value), { mode }); chmodSync(path, mode) }
  const valid = { version: 1, unit: UNIT, instanceId: 'a'.repeat(32), launcher: realpathSync(cli), createdAt: Date.now() }
  assert.equal(takeSupervisedStart(options), null)
  write(valid)
  assert.deepEqual(takeSupervisedStart(options), { launcher: realpathSync(cli), instanceId: 'a'.repeat(32) })
  assert.equal(existsSync(path), false)
  assert.equal(takeSupervisedStart(options), null)
  for (const [value, mode, pattern] of [
    [{ ...valid, unit: 'other.service' }, 0o600, /another unit/],
    [{ ...valid, createdAt: Date.now() - 600_000 }, 0o600, /expired/],
    [{ ...valid, instanceId: 'nope' }, 0o600, /instance ID/],
    [{ ...valid, launcher: '/usr/bin/env' }, 0o600, /invalid launcher/],
    [valid, 0o640, /owner-only/],
  ]) {
    write(value, mode)
    assert.throws(() => takeSupervisedStart(options), pattern)
    assert.equal(existsSync(path), false, 'a rejected handoff is still consumed')
  }
})

test('supervised detach starts the bridge through its user service with the requested build and instance', { timeout: 30_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gelios-supervised-')))
  const stateDir = join(root, 'state')
  const workspace = join(root, 'workspace')
  const binDir = join(root, 'bin')
  const socketPath = join(stateDir, 'app.sock')
  const controlPath = join(stateDir, 'control.sock')
  const fakeCodex = join(root, 'fake-codex.mjs')
  const managedCli = join(root, 'gelios-codex-telegram')
  mkdirSync(stateDir, { mode: 0o700 }); mkdirSync(workspace); mkdirSync(binDir)
  symlinkSync(cli, managedCli)
  writeFileSync(fakeCodex, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n', { mode: 0o700 })
  const api = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    if (request.url.endsWith('/getUpdates')) await pause(20)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, result: request.url.endsWith('/getUpdates') ? [] : true }))
  })
  await new Promise(resolvePromise => api.listen(0, '127.0.0.1', resolvePromise))
  t.after(() => api.close())
  const bridgeArgs = ['--state-dir', stateDir, '--socket', socketPath, '--control-socket', controlPath,
    '--workspace', workspace, '--codex-bin', fakeCodex, '--transcription-api-key-env', 'SUPERVISED_AUDIO_SLOT',
    '--systemd-unit', UNIT]
  // A stand-in user manager: "start" runs the unit's ExecStart (the managed launcher, foreground).
  const pidFile = join(root, 'unit.pid')
  const serviceEnv = { TELEGRAM_BOT_TOKEN: TEST_TOKEN, SUPERVISED_AUDIO_SLOT: 'audio-secret', GELIOS_TELEGRAM_API_BASE: 'http://127.0.0.1:' + api.address().port }
  writeFileSync(join(binDir, 'systemctl'), [
    '#!/usr/bin/env bash',
    'pidfile=' + JSON.stringify(pidFile),
    '[[ "$1" == --user ]] || exit 64; shift',
    'alive() { [[ -s "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }',
    'case "$1" in',
    '  is-active) alive && exit 0; exit 3 ;;',
    '  is-failed) exit 1 ;;',
    '  stop) alive && kill "$(cat "$pidfile")"; rm -f "$pidfile"; exit 0 ;;',
    '  start) [[ "$2" == ' + JSON.stringify(UNIT) + ' ]] || exit 5',
    '    unset GELIOS_TELEGRAM_INSTANCE_ID GELIOS_TELEGRAM_LAUNCHER_LINK',
    '    env ' + Object.entries(serviceEnv).map(([k, v]) => k + '=' + JSON.stringify(v)).join(' ') + ' ' + JSON.stringify(managedCli) + ' bridge ' + bridgeArgs.map(value => JSON.stringify(value)).join(' ') + ' </dev/null >>' + JSON.stringify(join(root, 'service.log')) + ' 2>&1 &',
    '    echo $! >"$pidfile"; exit 0 ;;',
    'esac',
    'exit 2',
  ].join('\n') + '\n', { mode: 0o700 })
  t.after(() => { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM') } catch {} })
  const instanceId = 'b'.repeat(32)
  const env = { ...process.env, PATH: binDir + ':' + process.env.PATH, GELIOS_TELEGRAM_INSTANCE_ID: instanceId }
  delete env.TELEGRAM_BOT_TOKEN
  const started = await collect(spawn(managedCli, ['bridge', '--detach', '--json', ...bridgeArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.equal(started.code, 0, started.stderr + readFileSync(join(stateDir, 'bridge.log'), { encoding: 'utf8', flag: 'a+' }))
  const receipt = JSON.parse(started.stdout)
  assert.equal(receipt.instanceId, instanceId, 'the service ran the handoff instance, not a fresh one')
  assert.equal(receipt.unit, UNIT)
  assert.equal(receipt.pid, Number(readFileSync(pidFile, 'utf8')), 'the bridge is the service main process')
  assert.match(receipt.identity, /^\d+$/)
  assert.equal(existsSync(join(stateDir, 'supervised-start.json')), false)
  const profile = JSON.parse(readFileSync(join(stateDir, 'launch-profile.json'), 'utf8'))
  assert.equal(profile.systemdUnit, UNIT)
  assert.deepEqual(profile.bridgeArgs.slice(-2), ['--systemd-unit', UNIT])
  const status = await controlRequest(controlPath)
  assert.equal(status.result.instanceId, instanceId)
  await pause(300)
  assert.equal((await controlRequest(controlPath)).result.pid, receipt.pid, 'a supervised bridge does not exit on stdin EOF')

  const again = await collect(spawn(managedCli, ['bridge', '--detach', '--json', ...bridgeArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.notEqual(again.code, 0)
  assert.match(again.stderr, /already running/)

  const stopping = await controlRequest(controlPath, { action: 'shutdown_instance', instanceId })
  assert.equal(stopping.ok, true)
  for (let count = 0; count < 300 && existsSync(join(stateDir, 'status.json')); count += 1) await pause(10)
  assert.equal(existsSync(join(stateDir, 'status.json')), false)
})

