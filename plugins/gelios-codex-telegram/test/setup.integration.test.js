import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mkdtempSync, spawn } from './fixtures.js'
import { controlRequest } from '../scripts/update.js'
import { WebSocketPeer } from '../src/websocket.js'

const bin = process.env.GELIOS_REAL_CODEX_BIN, auth = process.env.GELIOS_REAL_CODEX_AUTH
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, detail, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error(`setup test timed out: ${detail()}`); await wait(25) }
}
async function readTranscript(path, threadId) {
  const socket = net.createConnection(path); await once(socket, 'connect')
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n')
  const initial = await new Promise(resolve => {
    let header = Buffer.alloc(0)
    const data = chunk => { header = Buffer.concat([header, chunk]); const end = header.indexOf('\r\n\r\n')
      if (end >= 0) { socket.off('data', data); resolve(header.subarray(end + 4)) } }
    socket.on('data', data)
  })
  const peer = new WebSocketPeer(socket, initial), pending = new Map(); let id = 0
  peer.onText = text => { const message = JSON.parse(text); pending.get(message.id)?.(message) }
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => reject(new Error(`evidence ${method} timed out`)), 10_000)
    pending.set(key, message => { clearTimeout(timer); pending.delete(key); message.error ? reject(new Error(message.error.message)) : resolve(message.result) })
    peer.sendText(JSON.stringify({ id: key, method, params }))
  })
  try {
    await rpc('initialize', { clientInfo: { name: 'setup-evidence', version: '1' }, capabilities: { experimentalApi: true } })
    return (await rpc('thread/read', { threadId, includeTurns: true })).thread
  } finally { peer.close(); socket.destroy() }
}

test('installed launcher configures and pairs through the local Codex agent, rejects Telegram mutations and preserves the conversation', {
  skip: process.platform !== 'linux' || process.env.GELIOS_REAL_MODEL !== '1' || !bin || !auth || !existsSync(auth) ? 'requires GELIOS_REAL_CODEX_BIN and GELIOS_REAL_CODEX_AUTH' : false,
  timeout: 300_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'g-')), owner = join(root, 'owner'), home = join(root, 'codex')
  const workspace = join(root, 'workspace'), state = join(owner, '.local/state/gelios-codex-telegram')
  mkdirSync(owner); mkdirSync(home); mkdirSync(workspace); copyFileSync(auth, join(home, 'auth.json'))
  const token = `123456789:${'a'.repeat(32)}`, calls = [], operators = []
  let pairingCode, offered = false, negativeUpdate = null
  const api = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const params = Object.fromEntries(new URLSearchParams(raw)), method = request.url.split('/').at(-1)
    calls.push({ method, params })
    let result = true
    if (method === 'getMe') result = { id: 123456789, is_bot: true, username: 'fixture_bot' }
    if (method === 'getUpdates') {
      result = negativeUpdate ? [negativeUpdate] : offered ? [] : [{ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: 'private' }, from: { id: 123, first_name: 'Fixture owner' }, text: 'pair me' } }]
      offered = true; negativeUpdate = null; if (!result.length) await wait(100)
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
    for (const operator of operators) operator.child.stdin.end()
    await wait(400)
    const current = await status().catch(error => ({ error: error.message }))
    const session = current.ready && !current.tuiAttached ? await readTranscript(current.socket, current.threadId).catch(error => ({ error: error.message })) : null
    if (process.env.GELIOS_SETUP_EVIDENCE) writeFileSync(process.env.GELIOS_SETUP_EVIDENCE, JSON.stringify({
      codexLog: (() => { try { return existsSync(join(home, 'logs_2.sqlite')) ? execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print("\\n".join(str(row) for row in c.execute("SELECT level,target,feedback_log_body FROM logs WHERE level IN (?,?) ORDER BY id", ["ERROR","WARN"])))', join(home, 'logs_2.sqlite')], { encoding: 'utf8' }) : '' } catch (error) { return error.message } })(),
      outputs: operators.map(operator => operator.output), calls, log: existsSync(join(state, 'bridge.log')) ? readFileSync(join(state, 'bridge.log'), 'utf8') : '', status: current,
      runtime: existsSync(join(state, 'runtime.json')) ? JSON.parse(readFileSync(join(state, 'runtime.json'))) : null,
      session: session?.turns ? { turns: session.turns.map(turn => ({ id: turn.id, status: turn.status, items: turn.items.filter(item => item.type !== 'reasoning') })) } : session,
    }, null, 2), { mode: 0o600 })
    try { const current = await status(); await controlRequest(socket, { action: 'shutdown_instance', instanceId: current.instanceId }) } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error
    }
    await until(async () => { try { await status(); return false } catch (error) { return ['ENOENT', 'ECONNREFUSED'].includes(error.code) } }, () => 'test bridge teardown')
    await new Promise(resolve => api.close(resolve))
  })
  writeFileSync(join(home, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\n` + `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`)
  const native = args => JSON.parse(execFileSync(bin, [...args, '--json'], { env, cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  native(['plugin', 'marketplace', 'add', ...(process.env.GELIOS_PACKAGE_TEST_SOURCE
    ? [process.env.GELIOS_PACKAGE_TEST_SOURCE, '--ref', process.env.GELIOS_PACKAGE_TEST_REF || 'main']
    : [fileURLToPath(new URL('../../../', import.meta.url))])])
  const installed = native(['plugin', 'add', 'telegram@codex-telegram'])
  const prepared = { launcher: join(owner, '.local/bin/codex-telegram') }
  assert.equal(existsSync(prepared.launcher), false)
  const open = (bootstrap = false) => {
    const entry = bootstrap && process.env.GELIOS_PACKAGE_TEST_SOURCE === 'AXEG0/codex-telegram'
      ? ['/bin/sh', '-c', `curl -fsSL https://raw.githubusercontent.com/AXEG0/codex-telegram/${process.env.GELIOS_PACKAGE_TEST_REF || 'main'}/launch.sh | sh -s -- --no-alt-screen`]
      : bootstrap ? ['/bin/sh', fileURLToPath(new URL('../../../launch.sh', import.meta.url)), '--no-alt-screen'] : [prepared.launcher, '--no-alt-screen']
    const child = spawn('systemd-run', ['--user', '--quiet', '--pipe', '--wait', '--collect', '--service-type=exec', '--property=KillMode=process', '--working-directory', workspace,
      '/usr/bin/env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), 'python3',
      fileURLToPath(new URL('./support/operator.py', import.meta.url)), ...entry], {
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
  const first = open(true)
  await until(async () => { try { const current = await status(); return current.tuiAttached && current.ready && current.threadId } catch { return false } }, () => first.output)
  const beforeConfiguration = await status()
  assert.equal(beforeConfiguration.telegramConfigured, false)
  assert.equal(calls.some(call => call.method === 'getUpdates'), false)
  assert.ok(first.output.includes('full filesystem access'))
  first.child.stdin.write(`$telegram:configure ${token}`); await wait(250); first.child.stdin.write('\r')
  await until(async () => { const current = await status(); return current.telegramConfigured && pairingCode && !current.turnId }, () => first.output, 120_000)
  first.child.stdin.write(`$telegram:access pair ${pairingCode}`); await wait(250); first.child.stdin.write('\r')
  await until(async () => { const current = await status(); return JSON.parse(readFileSync(join(state, 'access.json'))).users['123'] && !current.turnId }, () => first.output, 120_000)
  const initial = await status(), credentials = readFileSync(join(state, '.env')), access = readFileSync(join(state, 'access.json'))
  assert.equal(initial.pid, beforeConfiguration.pid); assert.equal(initial.threadId, beforeConfiguration.threadId)
  assert.equal(JSON.parse(access).users['123'].role, 'admin')
  assert.ok(calls.some(call => call.method === 'getMe'))
  assert.equal(readFileSync(join(state, 'bridge.log'), 'utf8').includes(token), false)
  await close(first)
  const sentBeforeNegative = calls.filter(call => call.method === 'sendMessage').length
  negativeUpdate = { update_id: 2, message: { message_id: 2, date: Math.floor(Date.now() / 1000),
    chat: { id: 123, type: 'private' }, from: { id: 123 }, text: '$telegram:access policy disabled' } }
  await until(() => calls.filter(call => call.method === 'sendMessage').length > sentBeforeNegative, () => 'agent reply to Telegram access request', 120_000)
  await until(async () => !(await status()).turnId, () => 'Telegram refusal turn', 120_000)
  assert.deepEqual(readFileSync(join(state, 'access.json')), access)
  assert.match(calls.filter(call => call.method === 'sendMessage').at(-1).params.text, /local|terminal|cannot|can't|can’t|refus/i)
  const transcript = await readTranscript(initial.socket, initial.threadId)
  const items = transcript.turns.flatMap(turn => turn.items)
  assert.ok(items.some(item => item.type === 'commandExecution' && /configure\.js.*--token-stdin/s.test(item.command)), 'the agent executed configuration itself')
  assert.ok(items.some(item => item.type === 'commandExecution' && /access pair/s.test(item.command)), 'the agent executed pairing itself')
  assert.ok(items.some(item => item.type === 'mcpToolCall' && item.tool === 'telegram_reply' && item.status === 'completed'), 'the agent replied to the Telegram request itself')
  if (process.env.GELIOS_SETUP_AGENT_EVIDENCE) writeFileSync(process.env.GELIOS_SETUP_AGENT_EVIDENCE, JSON.stringify({ threadId: initial.threadId,
    turns: transcript.turns.map(turn => ({ id: turn.id, status: turn.status, items: turn.items.filter(item => item.type !== 'reasoning') })), calls }, null, 2), { mode: 0o600 })
  await until(async () => !(await status()).tuiAttached, () => 'evidence reader detach')
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
