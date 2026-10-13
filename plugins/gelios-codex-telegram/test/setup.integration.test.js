import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mkdtempSync, spawn } from './fixtures.js'
import { controlRequest } from '../scripts/update.js'

const bin = process.env.GELIOS_REAL_CODEX_BIN, auth = process.env.GELIOS_REAL_CODEX_AUTH
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, detail, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error(`setup test timed out: ${detail()}`); await wait(25) }
}

test('installed guided launcher hides token entry, pairs locally, reattaches and restarts the same native conversation', {
  skip: process.platform !== 'linux' || !bin || !auth || !existsSync(auth) ? 'requires GELIOS_REAL_CODEX_BIN and GELIOS_REAL_CODEX_AUTH' : false,
  timeout: 120_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-')), owner = join(root, 'owner'), home = join(root, 'codex')
  const workspace = join(root, 'workspace'), state = join(owner, '.local/state/gelios-codex-telegram')
  mkdirSync(owner); mkdirSync(home); mkdirSync(workspace); copyFileSync(auth, join(home, 'auth.json'))
  const token = `123456789:${'a'.repeat(32)}`, calls = [], operators = []
  let pairingCode, offered = false
  const api = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const params = Object.fromEntries(new URLSearchParams(raw)), method = request.url.split('/').at(-1)
    calls.push({ method, params })
    let result = true
    if (method === 'getMe') result = { id: 123456789, is_bot: true, username: 'fixture_bot' }
    if (method === 'getUpdates') {
      result = offered ? [] : [{ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: 'private' }, from: { id: 123, first_name: 'Fixture owner' }, text: 'pair me' } }]
      offered = true; if (!result.length) await wait(100)
    }
    if (method === 'sendMessage') {
      pairingCode ||= /access pair ([A-Za-z0-9]+)/.exec(params.text)?.[1]
      result = { message_id: calls.length }
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, result }))
  })
  api.listen(0, '127.0.0.1'); await once(api, 'listening')
  const env = { PATH: `${dirname(bin)}:${process.env.PATH}`, HOME: owner, CODEX_HOME: home, TERM: 'xterm-256color',
    NODE_DISABLE_COMPILE_CACHE: '1', GELIOS_TELEGRAM_API_BASE: `http://127.0.0.1:${api.address().port}` }
  const socket = join(state, 'control.sock'), status = () => controlRequest(socket, { action: 'status' })
  t.after(async () => {
    if (process.env.GELIOS_SETUP_EVIDENCE) writeFileSync(process.env.GELIOS_SETUP_EVIDENCE, JSON.stringify({ outputs: operators.map(operator => operator.output), log: existsSync(join(state, 'bridge.log')) ? readFileSync(join(state, 'bridge.log'), 'utf8') : '', status: await status().catch(error => ({ error: error.message })) }, null, 2), { mode: 0o600 })
    for (const operator of operators) operator.child.stdin.end()
    await wait(400)
    try { const current = await status(); await controlRequest(socket, { action: 'shutdown_instance', instanceId: current.instanceId }) } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error
    }
    await until(async () => { try { await status(); return false } catch (error) { return ['ENOENT', 'ECONNREFUSED'].includes(error.code) } }, () => 'test bridge teardown')
    await new Promise(resolve => api.close(resolve))
  })
  const native = args => JSON.parse(execFileSync(bin, [...args, '--json'], { env, cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  native(['plugin', 'marketplace', 'add', ...(process.env.GELIOS_PACKAGE_TEST_SOURCE
    ? [process.env.GELIOS_PACKAGE_TEST_SOURCE, '--ref', process.env.GELIOS_PACKAGE_TEST_REF || 'main']
    : [fileURLToPath(new URL('../../../', import.meta.url))])])
  const installed = native(['plugin', 'add', 'telegram@codex-telegram'])
  const prepared = JSON.parse(execFileSync(process.execPath, [join(installed.installedPath, 'scripts/setup.js'), '--prepare'], { env, cwd: workspace, encoding: 'utf8' }))
  assert.equal(prepared.running, false); assert.equal(prepared.configured, false)
  const open = () => {
    const child = spawn('systemd-run', ['--user', '--quiet', '--pipe', '--wait', '--collect', '--service-type=exec', '--property=KillMode=process', '--working-directory', workspace,
      '/usr/bin/env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), 'python3',
      fileURLToPath(new URL('./support/operator.py', import.meta.url)), prepared.launcher, '--no-alt-screen'], {
      cwd: workspace, env: { ...env, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` }, stdio: ['pipe', 'pipe', 'pipe'] })
    const operator = { child, output: '', closed: false }
    child.stdout.on('data', data => { operator.output = (operator.output + data).slice(-100_000) })
    child.stderr.on('data', data => { operator.output = (operator.output + data).slice(-100_000) })
    child.once('close', () => { operator.closed = true }); operators.push(operator)
    return operator
  }
  const close = async operator => {
    await until(() => operator.output.includes('GPT-'), () => operator.output)
    operator.child.stdin.write('/quit'); await wait(250); operator.child.stdin.write('\r')
    await until(() => operator.closed, () => operator.output)
    await until(async () => !(await status()).tuiAttached, () => 'TUI detach')
  }
  const first = open()
  await until(() => first.output.includes('Telegram bot token:'), () => first.output)
  first.child.stdin.write(`${token}\r`)
  await until(() => first.output.includes('Pairing code') && pairingCode, () => first.output)
  assert.ok(first.output.includes('full filesystem access'))
  first.child.stdin.write(`${pairingCode}\r`)
  await until(() => first.output.includes('Folder access'), () => first.output)
  first.child.stdin.write('\r')
  await until(async () => { try { const current = await status(); return current.tuiAttached && current.ready && current.threadId } catch { return false } }, () => first.output)
  const initial = await status(), credentials = readFileSync(join(state, '.env')), access = readFileSync(join(state, 'access.json'))
  assert.equal(JSON.parse(access).users['123'].role, 'admin')
  assert.ok(calls.some(call => call.method === 'getMe'))
  assert.equal(first.output.includes(token), false)
  await close(first)
  const second = open()
  await until(async () => (await status()).tuiAttached, () => second.output)
  const repeated = await status(); assert.equal(repeated.pid, initial.pid); assert.equal(repeated.threadId, initial.threadId)
  assert.equal(second.output.includes('Telegram bot token:'), false)
  await close(second)
  await controlRequest(socket, { action: 'shutdown_instance', instanceId: repeated.instanceId })
  await until(async () => { try { await status(); return false } catch (error) { return ['ENOENT', 'ECONNREFUSED'].includes(error.code) } }, () => 'backend shutdown')
  const third = open()
  await until(async () => { try { return (await status()).tuiAttached } catch { return false } }, () => third.output)
  const restarted = await status(); assert.notEqual(restarted.pid, initial.pid); assert.equal(restarted.threadId, initial.threadId)
  assert.deepEqual(readFileSync(join(state, '.env')), credentials); assert.deepEqual(readFileSync(join(state, 'access.json')), access)
  assert.equal(restarted.workspace, workspace)
  await close(third)
  // Opt-in historical package proof uses the original public snapshot; no
  // private repository or historical issue/PR data enters the fixture.
  if (process.env.GELIOS_LEGACY_TEST_REF && process.env.GELIOS_PACKAGE_TEST_SOURCE) {
    const legacySource = join(root, 'legacy-source'); mkdirSync(legacySource)
    const archive = execFileSync('git', ['archive', process.env.GELIOS_LEGACY_TEST_REF], { cwd: fileURLToPath(new URL('../../../', import.meta.url)) })
    execFileSync('tar', ['-x', '-C', legacySource], { input: archive })
    native(['plugin', 'marketplace', 'add', legacySource])
    const oldPackage = native(['plugin', 'add', 'gelios-codex-telegram@gelios'])
    await controlRequest(socket, { action: 'shutdown_instance', instanceId: restarted.instanceId })
    await until(async () => { try { await status(); return false } catch (error) { return ['ENOENT', 'ECONNREFUSED'].includes(error.code) } }, () => 'pre-migration fixture shutdown')
    const managed = join(owner, '.local/bin/gelios-codex-telegram')
    rmSync(managed); symlinkSync(join(oldPackage.installedPath, 'bin/gelios-codex-telegram'), managed)
    const profile = JSON.parse(readFileSync(join(state, 'launch-profile.json')))
    execFileSync(managed, ['bridge', '--detach', ...profile.bridgeArgs], { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
    await until(async () => { const current = await status(); return current.ready && current.threadId }, () => 'legacy fixture restore')
    const beforeMigration = await status()
    assert.equal(beforeMigration.threadId, initial.threadId)
    const migrated = open()
    await until(async () => { try { const current = await status(); return current.tuiAttached && current.pid !== beforeMigration.pid } catch { return false } }, () => migrated.output, 60_000)
    const current = await status()
    assert.equal(current.threadId, initial.threadId); assert.equal(current.workspace, workspace)
    assert.deepEqual(readFileSync(join(state, '.env')), credentials); assert.deepEqual(readFileSync(join(state, 'access.json')), access)
    const selections = native(['plugin', 'list']).installed
    assert.ok(selections.some(item => item.name === 'telegram' && item.marketplaceName === 'codex-telegram' && item.enabled))
    assert.equal(selections.some(item => item.name === 'gelios-codex-telegram'), false)
    assert.ok(migrated.output.includes('Updated telegram'))
    await close(migrated)
  }
})
