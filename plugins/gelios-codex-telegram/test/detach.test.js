import { mkdtempSync, spawn } from './fixtures.js'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import test from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../bin/gelios-codex-telegram', import.meta.url))
const TEST_TOKEN = `123456789:${'a'.repeat(32)}`

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
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', chunk => {
      value += chunk
      const newline = value.indexOf('\n')
      if (newline < 0) return
      socket.end(); resolvePromise(JSON.parse(value.slice(0, newline)))
    })
    socket.on('error', reject)
  })
}

test('detach returns a verified JSON receipt and keeps marketplace-only credentials out of Codex', { timeout: 15_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gelios-detach-')))
  const stateDir = join(root, 'state')
  const workspace = join(root, 'workspace')
  const socketPath = join(stateDir, 'app.sock')
  const controlPath = join(stateDir, 'control.sock')
  const fakeCodex = join(root, 'fake-codex.mjs')
  const managedCli = join(root, 'gelios-codex-telegram')
  const childEnvPath = join(root, 'child-env.txt')
  mkdirSync(stateDir); mkdirSync(workspace)
  symlinkSync(cli, managedCli)
  writeFileSync(fakeCodex, `#!/usr/bin/env node\nimport { spawn } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\nprocess.on('SIGTERM', () => {})\nconst grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' })\nwriteFileSync(${JSON.stringify(childEnvPath)}, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid, audio: process.env.DETACH_AUDIO_SLOT ?? null, market: process.env.DETACH_MARKET_SLOT ?? null, other: process.env.DETACH_OTHER_PAT ?? null, unrelated: process.env.UNRELATED_DATABASE_TOKEN ?? null, gh: process.env.GH_TOKEN ?? null, launcher: process.env.GELIOS_TELEGRAM_LAUNCHER_LINK ?? null }))\nprocess.stderr.write('runtime=' + process.env.DETACH_OTHER_PAT + '\\n')\nsetInterval(() => {}, 1000)\n`, { mode: 0o700 })
  chmodSync(fakeCodex, 0o700)

  const api = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    if (request.url.endsWith('/getUpdates')) await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, result: request.url.endsWith('/getUpdates') ? [] : true }))
  })
  await new Promise(resolvePromise => api.listen(0, '127.0.0.1', resolvePromise))
  t.after(() => api.close())

  const command = spawn(managedCli, [
    'bridge', '--detach', '--json', '--state-dir', stateDir, '--workspace', workspace,
    '--socket', socketPath, '--control-socket', controlPath, '--codex-bin', fakeCodex,
    '--transcription-api-key-env', 'DETACH_AUDIO_SLOT',
    '--marketplace-auth-env', 'DETACH_MARKET_SLOT',
    '--codex-runtime-env', 'DETACH_OTHER_PAT', '--codex-runtime-env', 'LEGACY_UNSET',
  ], {
    env: { ...process.env, TELEGRAM_BOT_TOKEN: TEST_TOKEN, DETACH_AUDIO_SLOT: 'detached-secret', DETACH_MARKET_SLOT: 'market-secret', DETACH_OTHER_PAT: 'other-pat', UNRELATED_DATABASE_TOKEN: 'unrelated-secret', GH_TOKEN: 'other-gh-secret', GELIOS_TELEGRAM_API_BASE: `http://127.0.0.1:${api.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const { code, stdout, stderr } = await collect(command)
  assert.equal(code, 0, stderr)

  const receipt = JSON.parse(stdout)
  const pid = receipt.pid
  assert.ok(pid > 1, stdout)
  let stopped = false
  t.after(() => { if (!stopped) try { process.kill(pid, 'SIGTERM') } catch {} })
  assert.equal(receipt.socket, socketPath)
  assert.equal(receipt.log, join(stateDir, 'bridge.log'))
  assert.match(receipt.identity, /^\d+$/)
  assert.match(receipt.instanceId, /^[a-f0-9]{32}$/)
  assert.equal(statSync(join(stateDir, 'bridge.log')).mode & 0o777, 0o600)
  assert.match(readFileSync(join(stateDir, 'bridge.log'), 'utf8'), /ready on unix:/)
  for (let count = 0; count < 300 && !readFileSync(join(stateDir, 'bridge.log'), 'utf8').includes('app-server stderr:'); count += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  assert.match(readFileSync(join(stateDir, 'bridge.log'), 'utf8'), /app-server stderr: runtime=other-pat/)
  assert.doesNotMatch(readFileSync(join(stateDir, 'bridge.log'), 'utf8'), /detached-secret|market-secret/)
  const logLines = readFileSync(join(stateDir, 'bridge.log'), 'utf8').split('\n').filter(Boolean)
  assert.ok(logLines.some(line => line.includes('app-server stderr:')))
  for (const line of logLines) {
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z gelios-codex-telegram: /, `untimestamped bridge.log line: ${line}`)
  }
  const childEnvironment = JSON.parse(readFileSync(childEnvPath, 'utf8'))
  assert.deepEqual({ ...childEnvironment, pid: undefined, grandchild: undefined }, { pid: undefined, grandchild: undefined, audio: null, market: null, other: 'other-pat', unrelated: 'unrelated-secret', gh: 'other-gh-secret', launcher: managedCli })
  const profilePath = join(stateDir, 'launch-profile.json')
  const profileText = readFileSync(profilePath, 'utf8')
  const profile = JSON.parse(profileText)
  assert.equal(statSync(profilePath).mode & 0o777, 0o600)
  assert.equal(profile.transcriptionApiKeyEnv, 'DETACH_AUDIO_SLOT')
  assert.equal(profile.marketplaceAuthEnv, 'DETACH_MARKET_SLOT')
  assert.deepEqual(profile.codexRuntimeEnvs, ['DETACH_OTHER_PAT', 'LEGACY_UNSET'])
  assert.equal(profile.launcherLink, managedCli)
  assert.doesNotMatch(profileText, /detached-secret|market-secret|other-pat|unrelated-secret|other-gh-secret/)
  const response = await controlRequest(controlPath)
  assert.equal(response.ok, true)
  assert.equal(response.result.pid, pid)
  assert.equal(response.result.instanceId, receipt.instanceId)

  const stopping = await controlRequest(controlPath, { action: 'shutdown_instance', instanceId: receipt.instanceId })
  assert.equal(stopping.ok, true)
  for (let count = 0; count < 300 && existsSync(join(stateDir, 'status.json')); count += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  stopped = !existsSync(join(stateDir, 'status.json'))
  assert.equal(stopped, true)
  for (let count = 0; count < 500; count += 1) {
    const alive = [childEnvironment.pid, childEnvironment.grandchild].some(childPid => {
      try { process.kill(childPid, 0); return true } catch { return false }
    })
    if (!alive) break
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  assert.throws(() => process.kill(childEnvironment.pid, 0), error => error.code === 'ESRCH')
  assert.throws(() => process.kill(childEnvironment.grandchild, 0), error => error.code === 'ESRCH')
})

test('detach reports startup failure and points to the background log', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gelios-detach-failure-'))
  const stateDir = join(root, 'state')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const { TELEGRAM_BOT_TOKEN: _token, ...env } = process.env
  const command = spawn(cli, [
    'bridge', '--detach', '--state-dir', stateDir, '--workspace', workspace,
  ], { env: { ...env, TELEGRAM_BOT_TOKEN: 'invalid-fixture-token' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const result = await collect(command)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /TELEGRAM_BOT_TOKEN has an invalid shape/)
  assert.match(result.stderr, new RegExp(`see ${join(stateDir, 'bridge.log').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.equal(existsSync(join(stateDir, 'status.json')), false)
})

test('an explicitly selected missing transcription key fails startup safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gelios-detach-key-failure-'))
  const stateDir = join(root, 'state')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const { MISSING_AUDIO_SLOT: _missing, ...env } = process.env
  const command = spawn(cli, [
    'bridge', '--detach', '--state-dir', stateDir, '--workspace', workspace,
    '--transcription-api-key-env', 'MISSING_AUDIO_SLOT',
  ], { env: { ...env, TELEGRAM_BOT_TOKEN: TEST_TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] })
  const result = await collect(command)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /MISSING_AUDIO_SLOT is not configured for transcription/)
  assert.doesNotMatch(result.stderr, /Bearer|sk-/)
  assert.equal(existsSync(join(stateDir, 'status.json')), false)
})

test('detached and foreground startup reject control characters in bridge credentials', async () => {
  for (const detach of [true, false]) {
    const root = mkdtempSync(join(tmpdir(), 'gelios-proxy-control-'))
    const stateDir = join(root, 'state')
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const args = ['bridge']
    if (detach) args.push('--detach')
    args.push('--state-dir', stateDir, '--workspace', workspace)
    const command = spawn(cli, args, {
      env: {
        ...process.env, TELEGRAM_BOT_TOKEN: TEST_TOKEN + '\nforged-log-line',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const result = await collect(command)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /credential values cannot contain control characters|TELEGRAM_BOT_TOKEN has an invalid shape/)
    assert.doesNotMatch(result.stderr, /proxy-secret|forged-log-line/)
    assert.equal(existsSync(join(stateDir, 'status.json')), false)
  }
})
