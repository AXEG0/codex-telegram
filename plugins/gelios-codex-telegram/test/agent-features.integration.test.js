import { mkdtempSync, spawn } from './fixtures.js'
import assert from 'node:assert/strict'

import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { GeliosBridge, AppServerError } from '../scripts/bridge.js'
import { TelegramChannel } from '../src/telegram.js'

const bin = process.env.GELIOS_REAL_CODEX_BIN, auth = process.env.GELIOS_REAL_CODEX_AUTH
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) { if (Date.now() > deadline) throw new Error('agent functional test timed out'); await wait(50) }
}
test('native Codex agent uses reply/edit/reaction tools and receives an idle heartbeat on its existing thread', {
  skip: process.env.GELIOS_REAL_MODEL !== '1' || !bin || !auth || !existsSync(auth)
    ? 'set GELIOS_REAL_MODEL=1, GELIOS_REAL_CODEX_BIN and GELIOS_REAL_CODEX_AUTH for agent evidence' : false,
  timeout: 240_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'gelios-agent-features-')), workspace = join(root, 'workspace'), home = join(root, 'home')
  mkdirSync(workspace); mkdirSync(home); copyFileSync(auth, join(home, 'auth.json'))
  const calls = [], completed = new Set(), packageSource = fileURLToPath(new URL('../../../', import.meta.url))
  const options = { stateDir: join(root, 'state'), workspace,
    socket: join(root, 'app.sock'), controlSocket: join(root, 'control.sock'), codexBin: bin, terminalName: 'Test operator' }
  let bridge = new GeliosBridge(options)
  const logs = []; bridge.log = line => logs.push(line)
  const heartbeatCli = async (...args) => {
    const script = fileURLToPath(new URL('../scripts/heartbeat.js', import.meta.url))
    const child = spawn(process.execPath, [script, ...args, '--state-dir', options.stateDir], {
      env: { PATH: process.env.PATH, GELIOS_TELEGRAM_CONTROL_SOCKET: options.controlSocket }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', error = ''; child.stdout.on('data', text => { output += text }); child.stderr.on('data', text => { error += text })
    const [code] = await once(child, 'exit'); assert.equal(code, 0, error)
    return JSON.parse(output)
  }
  bridge.store.saveAccess({ version: 1, dmPolicy: 'allowlist', pending: {}, users: {
    '123': { chatId: '123', alias: 'Test operator', role: 'admin' } } })
  const api = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const params = Object.fromEntries(new URLSearchParams(raw)), method = request.url.split('/').at(-1)
    calls.push({ method, params })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: 77 } : true }))
  })
  api.listen(0, '127.0.0.1'); await once(api, 'listening')
  const attachChannel = () => {
    bridge.telegram = new TelegramChannel({ store: bridge.store, workspaceRoot: workspace, token: `123456789:${'a'.repeat(32)}`,
      onInbound: (event, prepare) => bridge.acceptTelegram(event, prepare), log: line => logs.push(line) })
    bridge.telegram.api.base = `http://127.0.0.1:${api.address().port}`
    bridge.batcher = bridge.telegram.batcher
  }
  attachChannel()
  writeFileSync(join(home, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\n` +
    `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`)
  const ownerHome = join(root, 'owner'); mkdirSync(ownerHome)
  const env = { ...process.env, HOME: ownerHome, CODEX_HOME: home,
    GELIOS_TELEGRAM_CONTROL_SOCKET: options.controlSocket, GELIOS_TELEGRAM_STATE_DIR: options.stateDir }
  for (const name of Object.keys(env)) if (/^(MIMIR_|GH_TOKEN$|GITHUB_TOKEN$|TELEGRAM_BOT_TOKEN$)/.test(name)) delete env[name]
  delete env.GELIOS_TELEGRAM_LAUNCHER_DIR
  const native = args => JSON.parse(execFileSync(bin, [...args, '--json'], { cwd: workspace, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  const marketplace = native(['plugin', 'marketplace', 'add', packageSource])
  const installed = native(['plugin', 'add', 'telegram@codex-telegram'])
  assert.equal(installed.name, 'telegram')
  let app = spawn(bin, ['app-server', '--listen', 'stdio://'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
  bridge.app = app; app.stderr.resume()
  t.after(async () => {
    bridge.heartbeat.stop(); await bridge.telegram.stop(); clearTimeout(bridge.retryTimer)
    for (const pending of bridge.internal.values()) clearTimeout(pending.timer)
    if (app.exitCode === null && app.signalCode === null) {
      app.kill('SIGTERM'); await Promise.race([once(app, 'exit'), wait(2000)])
      if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
    }
    await new Promise(resolve => bridge.controlServer?.close(resolve) || resolve())
    await new Promise(resolve => api.close(resolve)); rmSync(root, { recursive: true, force: true })
  })
  await once(app, 'spawn')
  const observe = () => readline.createInterface({ input: app.stdout }).on('line', line => {
      const message = JSON.parse(line)
      if (message.method === 'turn/completed') completed.add(message.params.turn.id)
      bridge.onAppLine(line)
    })
  observe()
  bridge.controlServer = await bridge.createControlServer()
  const handshake = { clientInfo: { name: 'plugin-agent-test', version: '1' }, capabilities: { experimentalApi: true } }
  bridge.initializedResult = await bridge.rpc('initialize', handshake)
  bridge.persistBinding({ initialize: handshake })
  bridge.sendApp({ method: 'initialized' }); bridge.appReady = true
  const started = await bridge.rpc('thread/start', { cwd: workspace, model: 'gpt-6.1-sol', approvalPolicy: 'never', sandbox: 'danger-full-access' })
  const threadId = started.thread.id; bridge.bindThread(threadId); await bridge.rememberEmptyThread(started)
  await bridge.telegram.handleUpdate({ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000),
    chat: { id: 123, type: 'private' }, from: { id: 123 },
    text: 'Functional plugin test. First invoke $configure from this plugin to prepare its launcher and inspect nonsecret setup state, then invoke $access to list paired users. Do not read credentials or change access. Then, in this paired test chat (123), send "PLUGIN-TEST-INITIAL" using telegram_reply. Edit that bot message to "PLUGIN-TEST-EDITED" using telegram_edit_message and set its reaction to 👍 using telegram_react. Report the resulting message ID. This chat uses a local Bot API fixture; Perform the Telegram send/edit/reaction actions exclusively with the plugin MCP tools.' } })
  await bridge.batcher.flush(); const first = bridge.store.loadRuntime().events['telegram-123-1']
  await until(() => completed.has(first.turnId))
  assert.ok(calls.some(call => call.method === 'sendMessage' && call.params.text.includes('PLUGIN-TEST-INITIAL')))
  assert.ok(calls.some(call => call.method === 'editMessageText' && call.params.text === 'PLUGIN-TEST-EDITED'))
  assert.ok(calls.some(call => call.method === 'setMessageReaction' && call.params.message_id === '77' && call.params.reaction.includes('👍')))
  assert.equal(bridge.store.loadRuntime().events['telegram-123-1'].status, 'delivered')
  assert.equal(calls.some(call => call.method === 'setMessageReaction' && call.params.message_id === '1'), false)
  assert.equal((await heartbeatCli('status')).enabled, false)
  const promptFile = join(root, 'heartbeat.txt')
  writeFileSync(promptFile, 'Functional heartbeat test: answer in your final reply with exactly HEARTBEAT-TEST-ACCEPTED. Do not send a Telegram message.')
  assert.equal((await heartbeatCli('enable', '--every', '1s', '--prompt-file', promptFile)).enabled, true)
  // Lose the transport response after the real native runtime accepted input.
  // Restart the bridge/controller and native backend, then reconcile from its
  // actual persisted conversation rather than a delegate or fixture verdict.
  const startHeartbeat = bridge.heartbeat.startTurn
  let heartbeatTurnId
  bridge.heartbeat.startTurn = async params => {
    const result = await startHeartbeat(params); heartbeatTurnId = result.turn.id
    throw new AppServerError({ message: 'test transport lost accepted response' }, 'turn/start', { ambiguous: true })
  }
  await wait(1050); await bridge.heartbeat.tick()
  assert.ok(bridge.heartbeat.status().pending)
  await until(() => completed.has(heartbeatTurnId))
  const beforePid = app.pid, binding = bridge.store.loadBinding()
  await bridge.telegram.stop(); clearTimeout(bridge.retryTimer)
  await new Promise(resolve => bridge.controlServer.close(resolve))
  app.kill('SIGTERM'); await once(app, 'exit')
  bridge = new GeliosBridge(options); bridge.log = line => logs.push(line); attachChannel()
  bridge.telegram.poll = async () => {}
  await bridge.telegram.start(); await bridge.telegram.reactions.flush('123:1')
  assert.equal(calls.some(call => call.method === 'setMessageReaction' && call.params.message_id === '1'), false)
  app = spawn(bin, ['app-server', '--listen', 'stdio://'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
  bridge.app = app; app.stderr.resume(); await once(app, 'spawn'); observe()
  bridge.controlServer = await bridge.createControlServer()
  await bridge.restoreBinding(binding)
  assert.equal(bridge.currentThreadId, threadId); assert.notEqual(app.pid, beforePid)
  const afterRestartMethods = [], nativeRpc = bridge.rpc.bind(bridge)
  bridge.rpc = (method, ...args) => { afterRestartMethods.push(method); return nativeRpc(method, ...args) }
  await bridge.heartbeat.tick()
  const heartbeat = Object.values(bridge.store.loadRuntime().events).find(event => event.source === 'Heartbeat')
  assert.equal(heartbeat.threadId, threadId); assert.equal(heartbeat.status, 'delivered'); assert.equal(heartbeat.reconciled, true)
  assert.equal(afterRestartMethods.includes('turn/start'), false)
  assert.equal((await heartbeatCli('disable')).enabled, false)
  const transcript = (await bridge.rpc('thread/read', { threadId, includeTurns: true })).thread
  const items = transcript.turns.flatMap(turn => turn.items)
  assert.ok(items.some(item => item.type === 'userMessage' && item.clientId === heartbeat.eventId))
  assert.ok(items.some(item => item.type === 'agentMessage' && item.text.includes('HEARTBEAT-TEST-ACCEPTED')))
  for (const name of ['telegram_reply', 'telegram_edit_message', 'telegram_react']) {
    assert.ok(items.some(item => item.type === 'mcpToolCall' && item.tool === name && item.status === 'completed'), `agent session contains completed ${name}`)
  }
  assert.equal(items.filter(item => item.type === 'userMessage' && item.clientId === heartbeat.eventId).length, 1)

  const evidence = { marketplace, installed, codex: '0.162.0', backendPid: app.pid, beforeRestartPid: beforePid, threadId, calls, heartbeat, afterRestartMethods,
    turns: transcript.turns.map(turn => ({ id: turn.id, status: turn.status, items: turn.items.filter(item => item.type !== 'reasoning') })), logs }
  if (process.env.GELIOS_FEATURE_EVIDENCE) writeFileSync(process.env.GELIOS_FEATURE_EVIDENCE, JSON.stringify(evidence, null, 2), { mode: 0o600 })
  assert.ok(items.some(item => item.type === 'commandExecution' && /setup\.js.*--prepare/.test(item.command)), 'agent session contains its own configure preparation command')
})
