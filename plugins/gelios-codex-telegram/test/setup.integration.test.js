import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readlinkSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mkdtempSync, spawn } from './fixtures.js'
import { controlRequest } from '../scripts/update.js'
import { WebSocketPeer } from '../src/websocket.js'
import { processInfo } from '../src/core.js'

const bin = process.env.GELIOS_REAL_CODEX_BIN, auth = process.env.GELIOS_REAL_CODEX_AUTH
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, detail, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (true) {
    try { if (await predicate()) return } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error }
    if (Date.now() > deadline) throw new Error(`setup test timed out: ${detail()}`)
    await wait(25)
  }
}
async function readTranscript(path, threadId, turnId) {
  const socket = net.createConnection(path); socket.setTimeout(10_000, () => socket.destroy(new Error('evidence socket timed out'))); await once(socket, 'connect')
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n')
  const initial = await new Promise((resolve, reject) => {
    socket.once('error', reject); socket.once('close', () => reject(new Error('evidence socket closed during upgrade')))
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
    if (turnId) await rpc('turn/interrupt', { threadId, turnId })
    return (await rpc('thread/read', { threadId, includeTurns: true })).thread
  } finally { peer.close(); socket.destroy() }
}

test('installed launcher configures and pairs through the local Codex agent, rejects Telegram mutations and preserves the conversation', {
  skip: process.platform !== 'linux' || process.env.GELIOS_REAL_MODEL !== '1' || !bin || !auth || !existsSync(auth) ? 'requires GELIOS_REAL_CODEX_BIN and GELIOS_REAL_CODEX_AUTH' : false,
  timeout: 300_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'g-')), owner = join(root, 'o'), home = join(root, 'c')
  const workspace = join(root, 'workspace'), state = join(owner, '.local/state/gelios-codex-telegram')
  mkdirSync(owner); mkdirSync(home); mkdirSync(workspace); copyFileSync(auth, join(home, 'auth.json'))
  const token = `123456789:${'a'.repeat(32)}`, calls = [], operators = []
  let pairingCode, offered = false, negativeUpdate = null
  // What a message the bridge sent says: plain text, or a rich message's Markdown.
  const sentText = call => call.method === 'sendMessage' ? call.params.text
    : call.method === 'sendRichMessage' ? JSON.parse(call.params.rich_message).markdown : undefined
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
    if (method === 'sendRichMessage') result = { message_id: calls.length }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, result }))
  })
  api.listen(0, '127.0.0.1'); await once(api, 'listening')
  const env = { PATH: `${join(owner, '.local/bin')}:${dirname(bin)}:${process.env.PATH}`, HOME: owner, CODEX_HOME: home, TERM: 'xterm-256color',
    NODE_DISABLE_COMPILE_CACHE: '1', GELIOS_TELEGRAM_API_BASE: `http://127.0.0.1:${api.address().port}` }
  const socket = join(state, 'control.sock'), status = () => controlRequest(socket, { action: 'status' })
  t.after(async () => {
    for (const operator of operators) operator.child.stdin.end()
    await until(() => operators.every(operator => operator.closed), () => 'terminal processes stopped')
    try {
      const current = await status().catch(error => ({ error: error.message }))
      const session = current.ready && !current.tuiAttached ? await readTranscript(current.socket, current.threadId, current.turnId).catch(error => ({ error: error.message })) : null
      if (process.env.GELIOS_SETUP_EVIDENCE) writeFileSync(process.env.GELIOS_SETUP_EVIDENCE, JSON.stringify({
        codexLog: (() => { try { return existsSync(join(home, 'logs_2.sqlite')) ? execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print("\\n".join(str(row) for row in c.execute("SELECT level,target,feedback_log_body FROM logs WHERE level IN (?,?) ORDER BY id", ["ERROR","WARN"])))', join(home, 'logs_2.sqlite')], { encoding: 'utf8' }) : '' } catch (error) { return error.message } })(),
        outputs: operators.map(operator => operator.output), calls, log: existsSync(join(state, 'bridge.log')) ? readFileSync(join(state, 'bridge.log'), 'utf8') : '', status: current,
        runtime: existsSync(join(state, 'runtime.json')) ? JSON.parse(readFileSync(join(state, 'runtime.json'))) : null,
        session: session?.turns ? { turns: session.turns.map(turn => ({ id: turn.id, status: turn.status, items: turn.items.filter(item => item.type !== 'reasoning') })) } : session,
      }, null, 2), { mode: 0o600 })
    } finally {
      try {
        let backendPid, backendIdentity
        try { const current = await status(); backendPid = current.appPid; backendIdentity = (processInfo(backendPid)?.identity || null); await controlRequest(socket, { action: 'shutdown_instance', instanceId: current.instanceId }) } catch (error) {
          if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error
        }
        await until(async () => { try { await status(); return false } catch (error) { return ['ENOENT', 'ECONNREFUSED'].includes(error.code) } }, () => 'test bridge teardown')
        if (backendPid && backendIdentity) await until(() => (processInfo(backendPid)?.identity || null) !== backendIdentity, () => 'native backend stopped before fixture cleanup')
      } finally { api.closeAllConnections?.(); await new Promise(resolve => api.close(resolve)) }
    }
  })
  writeFileSync(join(home, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\n` + `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`)
  const native = args => JSON.parse(execFileSync(bin, [...args, '--json'], { env, cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  const gitPackage = process.env.GELIOS_PACKAGE_TEST_SOURCE === 'AXEG0/codex-telegram'
  native(['plugin', 'marketplace', 'add', ...(gitPackage
    ? ['AXEG0/codex-telegram', '--ref', process.env.GELIOS_PACKAGE_TEST_REF || 'main']
    : [fileURLToPath(new URL('../../../', import.meta.url))])])
  native(['plugin', 'add', 'telegram@codex-telegram'])
  const source = gitPackage
    ? `git+https://github.com/AXEG0/codex-telegram.git#${process.env.GELIOS_PACKAGE_TEST_REF || 'main'}`
    : fileURLToPath(new URL('../../../', import.meta.url))
  execFileSync('npm', ['install', '--global', '--prefix', join(owner, '.local'), '--cache', join(root, 'npm-cache'),
    '--ignore-scripts', '--no-audit', '--no-fund', source], { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 })
  const prepared = { launcher: join(owner, '.local/bin/codex-telegram') }
  assert.equal(existsSync(prepared.launcher), true)
  const installerLink = readlinkSync(prepared.launcher)
  const open = (args = ['--yolo', '--no-alt-screen'], executable = prepared.launcher) => {
    const entry = [executable, ...args]
    const child = spawn('systemd-run', ['--user', '--quiet', '--pipe', '--wait', '--collect', '--service-type=exec', '--property=KillMode=process', '--working-directory', workspace,
      '/usr/bin/env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), 'python3',
      fileURLToPath(new URL('./support/operator.py', import.meta.url)), ...entry], {
      cwd: workspace, env: { ...env, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` }, stdio: ['pipe', 'pipe', 'pipe'] })
    const operator = { child, output: '', closed: false, managed: executable === prepared.launcher }
    child.stdout.on('data', data => { operator.output = (operator.output + data).slice(-100_000) })
    child.stderr.on('data', data => { operator.output = (operator.output + data).slice(-100_000) })
    child.once('close', () => { operator.closed = true }); operators.push(operator)
    return operator
  }
  const close = async operator => {
    await until(() => operator.output.includes('GPT-'), () => operator.output)
    operator.child.stdin.write('/quit'); await wait(250); operator.child.stdin.write('\r')
    await until(() => operator.closed, () => operator.output)
    if (operator.managed) await until(async () => !(await status()).tuiAttached, () => 'TUI detach')
  }
  const first = open()
  await until(async () => { try { const current = await status(); return current.tuiAttached && current.ready && current.threadId } catch { return false } }, () => first.output)
  const beforeConfiguration = await status()
  assert.equal(beforeConfiguration.telegramConfigured, false)
  assert.equal(calls.some(call => call.method === 'getUpdates'), false)
  assert.ok(first.output.includes('full filesystem access'))
  await until(() => first.output.includes('GPT-'), () => first.output)
  await wait(300)
  first.child.stdin.write(`$telegram:configure ${token}`); await wait(250); first.child.stdin.write('\r')
  await until(async () => { const current = await status(); return current.telegramConfigured && pairingCode && !current.turnId }, () => first.output, 120_000)
  first.child.stdin.write(`$telegram:access pair ${pairingCode}`); await wait(250); first.child.stdin.write('\r')
  await until(async () => { const current = await status(); return JSON.parse(readFileSync(join(state, 'access.json'))).users['123'] && !current.turnId }, () => first.output, 120_000)
  const initial = await status(), credentials = readFileSync(join(state, '.env')), access = readFileSync(join(state, 'access.json'))
  assert.equal(initial.pid, beforeConfiguration.pid); assert.equal(initial.appPid, beforeConfiguration.appPid); assert.equal(initial.threadId, beforeConfiguration.threadId)
  assert.equal(JSON.parse(access).users['123'].role, 'admin')
  assert.ok(calls.some(call => call.method === 'getMe'))
  assert.equal(readFileSync(join(state, 'bridge.log'), 'utf8').includes(token), false)
  await close(first)
  const sentBeforeNegative = calls.filter(call => sentText(call) !== undefined).length
  negativeUpdate = { update_id: 2, message: { message_id: 2, date: Math.floor(Date.now() / 1000),
    chat: { id: 123, type: 'private' }, from: { id: 123 }, text: '$telegram:access policy disabled' } }
  await until(() => calls.filter(call => sentText(call) !== undefined).length > sentBeforeNegative, () => 'agent reply to Telegram access request', 120_000)
  await until(async () => !(await status()).turnId, () => 'Telegram refusal turn', 120_000)
  assert.deepEqual(readFileSync(join(state, 'access.json')), access)
  assert.match(sentText(calls.filter(call => sentText(call) !== undefined).at(-1)), /local|terminal|cannot|can't|can’t|refus/i)
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
  const submit = async text => {
    if (text.startsWith('/')) for (const character of text) { second.child.stdin.write(character); await wait(15) }
    else second.child.stdin.write(text)
    await wait(250); second.child.stdin.write('\r')
  }
  await until(() => second.output.includes('GPT-'), () => second.output); await wait(300)
  await submit('/new')
  await until(async () => { const current = await status(); return current.threadId && current.threadId !== initial.threadId && current.threadId === current.tuiThreadId }, () => second.output)
  const fresh = await status(), clean = () => second.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  assert.equal(fresh.permissions.approvalPolicy, 'never')
  assert.equal(fresh.permissions.sandboxPolicy.type, 'dangerFullAccess')
  assert.equal(fresh.pid, initial.pid); assert.equal(fresh.appPid, initial.appPid)
  await submit('/status')
  await until(() => clean().includes(fresh.threadId), () => clean())
  negativeUpdate = { update_id: 3, message: { message_id: 3, date: Math.floor(Date.now() / 1000),
    chat: { id: 123, type: 'private' }, from: { id: 123 }, text: 'Reply with exactly TG-ROUTE-B.' } }
  await until(() => calls.some(call => sentText(call)?.includes('TG-ROUTE-B')), () => 'Telegram reply in conversation B', 120_000)
  await until(async () => !(await status()).turnId, () => 'conversation B completed')
  await wait(300); await submit(`/resume ${initial.threadId}`)
  await until(async () => { const current = await status(); return current.threadId === initial.threadId && current.tuiThreadId === initial.threadId }, () => second.output)
  const resumed = await status()
  assert.equal(resumed.pid, initial.pid); assert.equal(resumed.appPid, initial.appPid)
  const selectedOffset = second.output.length
  await wait(300); await submit('/status')
  await until(() => second.output.slice(selectedOffset).includes(initial.threadId), () => second.output)
  negativeUpdate = { update_id: 4, message: { message_id: 4, date: Math.floor(Date.now() / 1000),
    chat: { id: 123, type: 'private' }, from: { id: 123 }, text: 'Reply with exactly TG-ROUTE-A.' } }
  await until(() => calls.some(call => sentText(call)?.includes('TG-ROUTE-A')), () => 'Telegram reply after resuming A', 120_000)
  await until(async () => !(await status()).turnId, () => 'conversation A completed')
  negativeUpdate = { update_id: 5, message: { message_id: 5, date: Math.floor(Date.now() / 1000),
    chat: { id: 123, type: 'private' }, from: { id: 123 }, text: '/new' } }
  await until(() => calls.some(call => /removed.*unchanged/.test(sentText(call))), () => 'removed Telegram command rejected')
  assert.equal((await status()).threadId, initial.threadId)
  assert.equal((await status()).appPid, initial.appPid)
  const menu = JSON.parse(calls.find(call => call.method === 'setMyCommands').params.commands)
  assert.equal(menu.some(command => command.command === 'new'), false)
  assert.equal(readlinkSync(prepared.launcher), installerLink)
  await close(second)
  const recordedA = await readTranscript(initial.socket, initial.threadId)
  await until(async () => !(await status()).tuiAttached, () => 'A evidence reader detached')
  const recordedB = await readTranscript(initial.socket, fresh.threadId)
  await until(async () => !(await status()).tuiAttached, () => 'B evidence reader detached')
  const inputs = thread => JSON.stringify(thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'userMessage'))
  const tools = thread => thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'mcpToolCall' && item.tool === 'telegram_reply' && item.status === 'completed')
  assert.match(inputs(recordedA), /TG-ROUTE-A/); assert.doesNotMatch(inputs(recordedA), /TG-ROUTE-B/)
  assert.match(inputs(recordedB), /TG-ROUTE-B/); assert.doesNotMatch(inputs(recordedB), /TG-ROUTE-A/)
  assert.ok(tools(recordedA).some(item => item.arguments.text.includes('TG-ROUTE-A')))
  assert.ok(tools(recordedB).some(item => item.arguments.text.includes('TG-ROUTE-B')))
  assert.equal((await status()).threadId, initial.threadId)
  const submitTo = async (operator, text) => {
    await until(() => operator.output.includes('GPT-'), () => operator.output)
    for (const character of text) { operator.child.stdin.write(character); await wait(10) }
    await wait(250); operator.child.stdin.write('\r')
  }
  // Compare --last with an ordinary native terminal using the same private
  // Codex home, without starting a shared system daemon. A separate native conversation makes
  // selecting the saved Telegram binding by accident observable.
  // Release the backend's native session locks before the independent reference.
  await controlRequest(socket, { action: 'shutdown_instance', instanceId: initial.instanceId })
  await until(async () => { try { await status(); return false } catch (error) { return ['ENOENT', 'ECONNREFUSED'].includes(error.code) } }, () => 'reference fixture shutdown')
  await until(() => !processInfo(initial.appPid), () => 'reference native backend released session locks')
  const referenceSeed = open(['--no-daemon', '--yolo', '--no-alt-screen', 'Reply with exactly NATIVE-REFERENCE-SEED.'], bin)
  await until(() => referenceSeed.output.includes('Worked for'), () => referenceSeed.output, 120_000)
  await submitTo(referenceSeed, '/status')
  await until(() => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(referenceSeed.output), () => referenceSeed.output)
  const nativeSeedId = referenceSeed.output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)[0]
  assert.notEqual(nativeSeedId, initial.threadId)
  await close(referenceSeed)
  const reference = open(['--no-daemon', '--no-alt-screen', 'resume', '--last'], bin)
  await submitTo(reference, '/status')
  await until(() => reference.output.includes(nativeSeedId), () => reference.output)
  const nativeLast = nativeSeedId
  await close(reference)
  const cliResume = open(['resume', '--last', '--no-alt-screen'])
  await until(async () => { const current = await status(); return current.tuiAttached && current.tuiThreadId === nativeLast && current.threadId === nativeLast }, () => cliResume.output)
  const cliResumed = await status()
  assert.notEqual(cliResumed.appPid, initial.appPid)
  await submitTo(cliResume, '/status')
  await until(() => cliResume.output.includes(nativeLast), () => cliResume.output)
  await close(cliResume)
  const cliResumeYolo = open(['--yolo', 'resume', '--last', '--no-alt-screen'])
  await until(async () => { const current = await status(); return current.tuiReady && current.tuiThreadId === nativeLast }, () => cliResumeYolo.output)
  assert.equal((await status()).permissions.approvalPolicy, 'never')
  assert.equal((await status()).permissions.sandboxPolicy.type, 'dangerFullAccess')
  negativeUpdate = { update_id: 6, message: { message_id: 6, date: Math.floor(Date.now() / 1000), chat: { id: 123, type: 'private' }, from: { id: 123 }, text: 'Reply with exactly TG-CLI-RESUME.' } }
  await until(() => calls.some(call => sentText(call)?.includes('TG-CLI-RESUME')), () => 'reply after shell resume --last', 120_000)
  await until(async () => !(await status()).turnId, () => 'shell resume reply completed')
  await close(cliResumeYolo)
  const cliFork = open(['fork', '--last', '--no-alt-screen'])
  await until(async () => { const current = await status(); return current.tuiAttached && current.threadId !== nativeLast && current.threadId === current.tuiThreadId }, () => cliFork.output)
  const forked = await status()
  assert.equal(forked.appPid, cliResumed.appPid)
  await submitTo(cliFork, '/status')
  await until(() => cliFork.output.includes(forked.threadId), () => cliFork.output)
  await close(cliFork)
  const cliForkYolo = open(['--yolo', 'resume', forked.threadId, '--no-alt-screen'])
  await until(async () => (await status()).tuiReady && (await status()).tuiThreadId === forked.threadId, () => cliForkYolo.output)
  negativeUpdate = { update_id: 7, message: { message_id: 7, date: Math.floor(Date.now() / 1000), chat: { id: 123, type: 'private' }, from: { id: 123 }, text: 'Reply with exactly TG-CLI-FORK.' } }
  await until(() => calls.some(call => sentText(call)?.includes('TG-CLI-FORK')), () => 'reply after shell fork --last', 120_000)
  await until(async () => !(await status()).turnId, () => 'shell fork reply completed')
  await close(cliForkYolo)
  const nativeWorkspace = join(workspace, 'native-subproject'); mkdirSync(nativeWorkspace)
  const cliReadOnly = open(['-C', nativeWorkspace, '--sandbox', 'read-only', '--ask-for-approval', 'never', '--no-alt-screen', 'Reply with exactly READONLY-SEED.'])
  await until(() => cliReadOnly.output.includes('Folder access'), () => cliReadOnly.output)
  cliReadOnly.child.stdin.write('\r') // Approve the native trust prompt for this owned empty fixture folder.
  await until(async () => { const current = await status(); return current.tuiAttached && current.threadId !== forked.threadId && current.permissions?.sandboxPolicy?.type === 'readOnly' }, () => cliReadOnly.output)
  const readonly = await status()
  assert.equal(readonly.workspace, nativeWorkspace)
  assert.equal(readonly.appPid, cliResumed.appPid)
  await until(async () => Boolean((await status()).turnId), () => 'read-only seed started', 120_000)
  await until(async () => !(await status()).turnId, () => 'read-only seed completed', 120_000)
  await close(cliReadOnly)
  negativeUpdate = { update_id: 8, message: { message_id: 8, date: Math.floor(Date.now() / 1000), chat: { id: 123, type: 'private' }, from: { id: 123 }, text: 'Reply with exactly TG-CLI-READONLY.' } }
  await until(async () => Boolean((await status()).turnId), () => 'read-only Telegram turn started', 120_000)
  await until(async () => !(await status()).turnId, () => 'read-only Telegram turn completed', 120_000)
  assert.equal(calls.some(call => sentText(call)?.includes('TG-CLI-READONLY')), false)
  assert.equal((await status()).permissions.sandboxPolicy.type, 'readOnly')
  await controlRequest(socket, { action: 'shutdown_instance', instanceId: readonly.instanceId })
  await until(() => !processInfo(readonly.appPid), () => 'read-only backend stopped')
  const readonlyRestart = open(['--no-alt-screen'])
  await until(async () => { const current = await status(); return current.tuiReady && current.threadId === readonly.threadId }, () => readonlyRestart.output)
  const restoredReadonly = await status()
  assert.equal(restoredReadonly.workspace, nativeWorkspace)
  assert.equal(restoredReadonly.permissions.sandboxPolicy.type, 'readOnly')
  assert.equal(restoredReadonly.permissions.approvalPolicy, 'never')
  await close(readonlyRestart)
  negativeUpdate = { update_id: 9, message: { message_id: 9, date: Math.floor(Date.now() / 1000), chat: { id: 123, type: 'private' }, from: { id: 123 }, text: 'Reply with exactly TG-CLI-READONLY-RESTART.' } }
  await until(async () => Boolean((await status()).turnId), () => 'read-only Telegram turn after controller restart', 120_000)
  await until(async () => !(await status()).turnId, () => 'read-only restarted turn completed', 120_000)
  assert.equal(calls.some(call => sentText(call)?.includes('TG-CLI-READONLY-RESTART')), false)
  const forkTranscript = await readTranscript(initial.socket, forked.threadId)
  assert.equal(forkTranscript.forkedFromId, nativeLast)
  await until(async () => !(await status()).tuiAttached, () => 'fork reader detached')
  const readonlyTranscript = await readTranscript(initial.socket, readonly.threadId)
  assert.equal(readonlyTranscript.cwd, nativeWorkspace)
  await until(async () => !(await status()).tuiAttached, () => 'read-only reader detached')
  assert.ok(tools(forkTranscript).some(item => item.arguments.text.includes('TG-CLI-FORK')))
  assert.match(inputs(readonlyTranscript), /TG-CLI-READONLY-RESTART/)
  assert.match(JSON.stringify(readonlyTranscript), /MCP tool call requires approval, but approval policy is never/)
  const returnToA = open(['resume', initial.threadId, '--no-alt-screen'])
  await until(async () => (await status()).tuiThreadId === initial.threadId, () => returnToA.output)
  await close(returnToA)
  if (process.env.GELIOS_SETUP_AGENT_EVIDENCE) writeFileSync(process.env.GELIOS_SETUP_AGENT_EVIDENCE, JSON.stringify({
    configuration: transcript, conversationA: recordedA, conversationB: recordedB,
    routing: { original: initial.threadId, newConversation: fresh.threadId, resumed: resumed.threadId,
      backendPid: initial.appPid, afterNewBackendPid: fresh.appPid, afterResumeBackendPid: resumed.appPid },
    nativeCli: { referenceLast: nativeLast, wrappedLast: cliResumed.threadId, fork: forked.threadId, readonly: readonly.threadId,
      readonlyPermissions: readonly.permissions, restoredReadonlyPermissions: restoredReadonly.permissions, forkTranscript, readonlyTranscript },
    calls, terminalOutputs: operators.map(operator => operator.output),
  }, null, 2), { mode: 0o600 })
  await controlRequest(socket, { action: 'shutdown_instance', instanceId: (await status()).instanceId })
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
