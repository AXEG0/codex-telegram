import { mkdtempSync, spawn } from './fixtures.js'
import assert from 'node:assert/strict'

import { once } from 'node:events'
import http from 'node:http'
import { copyFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import test from 'node:test'
import { AppServerError, GeliosBridge } from '../scripts/bridge.js'
import { createUnixWebSocketServer } from '../src/websocket.js'
import { TelegramChannel } from '../src/telegram.js'

const codexBin = process.env.GELIOS_REAL_CODEX_BIN
const tuiAuth = process.env.GELIOS_REAL_CODEX_AUTH
const tuiHasCredentials = Boolean(process.env.OPENAI_API_KEY) || Boolean(tuiAuth && existsSync(tuiAuth))
const scriptBin = process.env.GELIOS_REAL_SCRIPT_BIN || '/usr/bin/script'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(predicate, timeoutMs = 10_000, signal) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    signal?.throwIfAborted()
    if (Date.now() >= deadline) throw new Error('timed out waiting for the real Codex TUI bootstrap')
    await wait(25)
  }
}
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), wait(2000)])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

test('real app-server hands a still-loaded empty Telegram thread to the TUI', {
  skip: codexBin ? false : 'set GELIOS_REAL_CODEX_BIN to run the real Codex integration test',
  timeout: 30_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'gelios-real-app-server-'))
  const workspace = join(root, 'workspace')
  const codexHome = join(root, 'codex-home')
  mkdirSync(workspace)
  mkdirSync(codexHome)
  const app = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: codexHome, GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  app.stderr.setEncoding('utf8')
  app.stderr.on('data', chunk => { stderr += chunk })
  t.after(async () => {
    if (app.exitCode !== null || app.signalCode !== null) return
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); app.off('exit', finish); resolve() }
      const timer = setTimeout(finish, 2000)
      app.once('exit', finish)
      app.kill('SIGTERM')
    })
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
  })
  await once(app, 'spawn')

  const bridge = new GeliosBridge({
    stateDir: join(root, 'state'), workspace,
    socket: join(root, 'app.sock'), controlSocket: join(root, 'control.sock'),
    codexBin, terminalName: 'Integration test',
  })
  bridge.app = app
  bridge.log = () => {}
  readline.createInterface({ input: app.stdout }).on('line', line => bridge.onAppLine(line))

  try {
    await bridge.rpc('initialize', {
      clientInfo: { name: 'gelios-integration-test', title: 'Gelios integration test', version: '0' },
      capabilities: { experimentalApi: true },
    })
    bridge.sendApp({ method: 'initialized', params: {} })
    const startResult = await bridge.rpc('thread/start', {
      cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access',
    })
    const threadId = startResult.thread.id
    assert.equal(Object.hasOwn(startResult, 'instructionSources'), true)
    assert.ok((await bridge.rpc('thread/loaded/list', {})).data.includes(threadId))
    await assert.rejects(
      bridge.rpc('thread/resume', { threadId, cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' }),
      error => error instanceof AppServerError && error.code === -32600 && /no rollout found/.test(error.message),
    )
    await assert.rejects(
      bridge.rpc('thread/read', { threadId, includeTurns: true }),
      error => error instanceof AppServerError &&
        /(not materialized yet|list_turns is not supported yet)/.test(error.message),
    )
    await assert.rejects(
      bridge.rpc('thread/resume', { threadId, cwd: workspace, excludeTurns: true }),
      error => error instanceof AppServerError && error.code === -32601 && /list_turns is not supported yet/.test(error.message),
    )
    assert.ok((await bridge.rpc('thread/loaded/list', {})).data.includes(threadId))

    await bridge.rememberEmptyThread(startResult)
    const methods = []
    const rpc = bridge.rpc.bind(bridge)
    bridge.rpc = (method, params, timeoutMs) => { methods.push(method); return rpc(method, params, timeoutMs) }
    const peer = { messages: [], sendText(value) { this.messages.push(JSON.parse(value)) } }
    await bridge.forwardTui({ id: 42, method: 'thread/resume', params: { threadId, cwd: workspace } }, peer)
    assert.deepEqual(methods, ['thread/loaded/list'])
    assert.deepEqual(peer.messages, [{ id: 42, result: {
      ...startResult, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
    } }])
    await bridge.forwardTui({ id: 43, method: 'thread/read', params: { threadId, includeTurns: true } }, peer)
    assert.deepEqual(methods, ['thread/loaded/list', 'thread/loaded/list'])
    assert.deepEqual(peer.messages.at(-1), { id: 43, result: { thread: startResult.thread } })
    await bridge.forwardTui({ id: 44, method: 'thread/turns/list', params: {
      threadId, limit: 5, sortDirection: 'desc', itemsView: 'notLoaded',
    } }, peer)
    assert.deepEqual(methods, ['thread/loaded/list', 'thread/loaded/list', 'thread/loaded/list'])
    assert.deepEqual(peer.messages.at(-1), {
      id: 44, result: { data: [], nextCursor: null, backwardsCursor: null },
    })
    await bridge.forwardTui({ id: 45, method: 'thread/items/list', params: {
      threadId, limit: 100, sortDirection: 'desc',
    } }, peer)
    assert.deepEqual(methods, [
      'thread/loaded/list', 'thread/loaded/list', 'thread/loaded/list', 'thread/loaded/list',
    ])
    assert.deepEqual(peer.messages.at(-1), {
      id: 45, result: { data: [], nextCursor: null, backwardsCursor: null },
    })
  } catch (error) {
    if (stderr.trim()) error.message += `\napp-server stderr:\n${stderr.trim()}`
    throw error
  }
})

test('real app-server reloads a durable empty Telegram thread after bridge restart', {
  skip: codexBin ? false : 'set GELIOS_REAL_CODEX_BIN to run the real Codex integration test',
  timeout: 30_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'gelios-real-empty-restart-'))
  const workspace = join(root, 'workspace'), codexHome = join(root, 'codex-home'), stateDir = join(root, 'state')
  mkdirSync(workspace); mkdirSync(codexHome)
  let stderr = ''
  const start = async () => {
    const app = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd: workspace, env: { ...process.env, CODEX_HOME: codexHome, GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin') }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    app.stderr.setEncoding('utf8'); app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65_536) })
    await once(app, 'spawn')
    const bridge = new GeliosBridge({
      stateDir, workspace, socket: join(root, 'app.sock'), controlSocket: join(root, 'control.sock'),
      codexBin, terminalName: 'Restart integration test',
    })
    bridge.app = app; bridge.log = () => {}
    readline.createInterface({ input: app.stdout }).on('line', line => bridge.onAppLine(line))
    await bridge.rpc('initialize', {
      clientInfo: { name: 'gelios-restart-test', title: 'Gelios restart test', version: '0' },
      capabilities: { experimentalApi: true },
    })
    bridge.sendApp({ method: 'initialized', params: {} }); bridge.appReady = true
    return { app, bridge }
  }
  let running
  t.after(async () => { if (running) await terminate(running.app) })
  try {
    running = await start()
    const startResult = await running.bridge.rpc('thread/start', {
      cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access',
    })
    const threadId = startResult.thread.id
    await running.bridge.rememberEmptyThread(startResult)
    assert.deepEqual(running.bridge.store.emptyThreads()[threadId], startResult)
    await terminate(running.app)

    running = await start()
    assert.equal(running.bridge.emptyThreadHandoffs.has(threadId), true)
    assert.equal((await running.bridge.rpc('thread/loaded/list', {})).data.includes(threadId), false)
    const peer = { messages: [], sendText(value) { this.messages.push(JSON.parse(value)) } }
    await running.bridge.forwardTui({ id: 50, method: 'thread/resume', params: { threadId, cwd: workspace } }, peer)
    assert.equal((await running.bridge.rpc('thread/loaded/list', {})).data.includes(threadId), true)
    assert.equal(running.bridge.currentThreadId, threadId)
    assert.deepEqual(peer.messages, [{ id: 50, result: {
      ...startResult, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
    } }])
  } catch (error) {
    if (stderr.trim()) error.message += `\napp-server stderr:\n${stderr.trim()}`
    throw error
  }
})

test('real app-server restores an existing empty conversation after a restart without a terminal', {
  skip: codexBin ? false : 'set GELIOS_REAL_CODEX_BIN to run the real Codex integration test',
  timeout: 30_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'gelios-real-empty-restore-'))
  const workspace = join(root, 'workspace'), codexHome = join(root, 'codex-home'), stateDir = join(root, 'state')
  mkdirSync(workspace); mkdirSync(codexHome)
  let stderr = ''
  const logs = []
  const start = async () => {
    const app = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd: workspace, env: { ...process.env, CODEX_HOME: codexHome, GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin') }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    app.stderr.setEncoding('utf8'); app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65_536) })
    await once(app, 'spawn')
    const bridge = new GeliosBridge({
      stateDir, workspace, socket: join(root, 'app.sock'), controlSocket: join(root, 'control.sock'),
      codexBin, terminalName: 'Empty restore integration test',
    })
    bridge.app = app; bridge.log = message => logs.push(message)
    readline.createInterface({ input: app.stdout }).on('line', line => bridge.onAppLine(line))
    return { app, bridge }
  }
  const initialize = {
    clientInfo: { name: 'gelios-empty-restore-test', title: 'Gelios empty restore test', version: '0' },
    capabilities: { experimentalApi: true },
  }
  let running
  t.after(async () => { if (running) await terminate(running.app) })
  try {
    running = await start()
    await running.bridge.rpc('initialize', initialize)
    running.bridge.sendApp({ method: 'initialized', params: {} }); running.bridge.appReady = true
    running.bridge.persistBinding({ initialize })
    // Preserve an existing empty conversation, including state created by older releases.
    const startResult = await running.bridge.rpc('thread/start', {
      cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access',
    })
    const threadId = startResult.thread.id
    await running.bridge.rememberEmptyThread(startResult)
    running.bridge.bindThread(threadId)
    await terminate(running.app)

    running = await start()
    const binding = running.bridge.store.loadBinding()
    assert.equal(binding.threadId, threadId)
    await running.bridge.restoreBinding(binding)
    assert.ok(logs.includes(`restored Telegram routing to thread ${threadId}`), logs.join('\n'))
    assert.equal(running.bridge.currentThreadId, threadId)
    assert.equal(running.bridge.appReady, true)
    assert.equal((await running.bridge.rpc('thread/loaded/list', {})).data.includes(threadId), true)
  } catch (error) {
    if (stderr.trim()) error.message += `\napp-server stderr:\n${stderr.trim()}`
    throw error
  }
})

test('real app-server accepts reply context, photo recovery metadata, and local image input', {
  skip: !codexBin ? 'set GELIOS_REAL_CODEX_BIN to run the real Codex integration test'
    : !tuiAuth || !existsSync(tuiAuth) ? 'set GELIOS_REAL_CODEX_AUTH to an isolated-test-readable auth.json' : false,
  timeout: 60_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'gelios-real-reply-envelope-'))
  const workspace = join(root, 'workspace')
  const codexHome = join(root, 'codex-home')
  mkdirSync(workspace); mkdirSync(codexHome)
  copyFileSync(tuiAuth, join(codexHome, 'auth.json'))
  const app = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
    cwd: workspace, env: { ...process.env, CODEX_HOME: codexHome, GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin') }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  app.stderr.setEncoding('utf8'); app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65_536) })
  t.after(() => terminate(app))
  await once(app, 'spawn')
  const bridge = new GeliosBridge({
    stateDir: join(root, 'state'), workspace,
    socket: join(root, 'app.sock'), controlSocket: join(root, 'control.sock'),
    codexBin, terminalName: 'Reply envelope test',
  })
  bridge.app = app; bridge.log = () => {}
  readline.createInterface({ input: app.stdout }).on('line', line => bridge.onAppLine(line))
  try {
    await bridge.rpc('initialize', { clientInfo: { name: 'gelios-reply-envelope-test', title: 'Gelios reply envelope test', version: '0' } })
    bridge.sendApp({ method: 'initialized', params: {} })
    const started = await bridge.rpc('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' })
    const localImage = join(workspace, 'photo.png')
    writeFileSync(localImage, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZbWQAAAAASUVORK5CYII=', 'base64'))
    const input = bridge.telegramInput({
      eventId: 'telegram-123-2', name: 'Jake', timestamp: 2000, sequence: 2,
      chatId: '123', messageId: '2', userId: '123', role: 'admin', text: 'Reply only OK.',
      localImage,
      attachment: { kind: 'photo', handle: 'att_0123456789abcdef01234567', size: 68, mime: 'image/png', name: 'photo.png' },
      replyContext: { schema: 'telegram_reply_context_v1', mode: 'selected_quote', parentMessageId: '1', text: 'parent', quote: { entities: [], isManual: false } },
    })
    assert.equal(input.length, 3)
    assert.match(input[1].text, /attachment_file_id=att_0123456789abcdef01234567/)
    assert.deepEqual(input[2], { type: 'localImage', path: localImage })
    const result = await bridge.rpc('turn/start', {
      threadId: started.thread.id, input, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
      clientUserMessageId: 'telegram-123-2',
    })
    assert.ok(result.turn.id)
    await bridge.rpc('turn/interrupt', { threadId: started.thread.id, turnId: result.turn.id }).catch(() => {})
  } catch (error) {
    if (stderr.trim()) error.message += `\napp-server stderr:\n${stderr.trim()}`
    throw error
  }
})

test('real managed TUI preserves its conversation when removed Telegram /new is requested', {
  skip: !codexBin ? 'set GELIOS_REAL_CODEX_BIN to run the real Codex integration test'
    : !tuiHasCredentials ? 'set OPENAI_API_KEY or GELIOS_REAL_CODEX_AUTH for the real TUI test'
      : process.platform !== 'linux' ? 'real TUI test drives util-linux script'
        : !existsSync(scriptBin) ? `real TUI test requires ${scriptBin}` : false,
  timeout: process.env.GELIOS_REAL_MODEL === '1' ? 240_000 : 60_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'gelios-real-tui-'))
  const workspace = join(root, 'workspace')
  const serverHome = join(root, 'server-home')
  const clientHome = join(root, 'client-home')
  const socket = join(root, 'app.sock')
  mkdirSync(workspace)
  mkdirSync(serverHome)
  mkdirSync(clientHome)
  const trust = `model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\n` +
    `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`
  writeFileSync(join(serverHome, 'config.toml'), trust)
  writeFileSync(join(clientHome, 'config.toml'), trust)
  if (tuiAuth && existsSync(tuiAuth)) copyFileSync(tuiAuth, join(serverHome, 'auth.json'))
  t.after(() => rmSync(join(serverHome, 'auth.json'), { force: true }))
  const isolatedEnv = { ...process.env }
  for (const name of Object.keys(isolatedEnv))
    if (/^(MIMIR_|GH_TOKEN$|GITHUB_TOKEN$|TELEGRAM_BOT_TOKEN$)/.test(name)) delete isolatedEnv[name]

  const app = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
    cwd: workspace,
    env: { ...isolatedEnv, CODEX_HOME: serverHome, GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let appStderr = ''
  app.stderr.setEncoding('utf8')
  app.stderr.on('data', chunk => { appStderr = (appStderr + chunk).slice(-65_536) })
  t.after(() => terminate(app))
  await once(app, 'spawn')

  const bridge = new GeliosBridge({
    stateDir: join(root, 'state'), workspace, socket, controlSocket: join(root, 'control.sock'),
    codexBin, terminalName: 'Real TUI integration test',
  })
  bridge.app = app
  bridge.log = () => {}
  const agentMessages = [], tuiRequests = [], errors = []
  let phase = 'bootstrap'
  const progress = () => {
    if (process.env.GELIOS_FORK_EVIDENCE) writeFileSync(`${process.env.GELIOS_FORK_EVIDENCE}.progress`, JSON.stringify({
      phase, backendPid: app.pid, binding: bridge.currentThreadId, tuiThreadId: bridge.tui?.selectedThreadId,
      requests: tuiRequests.map(request => ({ method: request.method, threadId: request.params?.threadId, ephemeral: request.params?.ephemeral })),
      agentMessages, errors,
    }, null, 2), { mode: 0o600 })
  }
  readline.createInterface({ input: app.stdout }).on('line', line => {
    const message = JSON.parse(line)
    if (message.error) errors.push({ code: message.error.code,
      method: bridge.forwarded.get(String(message.id))?.method || bridge.internal.get(String(message.id))?.method })
    if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage')
      agentMessages.push({ threadId: message.params.threadId, text: message.params.item.text })
    bridge.onAppLine(line)
    if (message.error || message.method === 'item/completed' || message.method === 'turn/completed') progress()
  })
  bridge.initializedResult = await bridge.rpc('initialize', {
    clientInfo: { name: 'gelios-tui-integration-test', title: 'Gelios TUI integration test', version: '0' },
    capabilities: { experimentalApi: true },
  })
  bridge.appReady = true
  bridge.sendApp({ method: 'initialized', params: {} })
  const startResult = await bridge.rpc('thread/start', {
    cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access',
  })
  const threadId = startResult.thread.id
  bridge.bindThread(threadId)
  await bridge.rememberEmptyThread(startResult)

  const onTuiText = bridge.onTuiText
  bridge.onTuiText = function (text, peer) {
    try {
      const message = JSON.parse(text)
      tuiRequests.push({ method: message.method, params: message.params })
      progress()
    } catch {}
    return onTuiText.call(this, text, peer)
  }
  const forwardedForThread = []
  const sendApp = bridge.sendApp.bind(bridge)
  bridge.sendApp = message => {
    if (message.params?.threadId === threadId) forwardedForThread.push(message.method)
    sendApp(message)
  }
  const server = await createUnixWebSocketServer(socket, peer => bridge.attachTui(peer))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const controlServer = await bridge.createControlServer()
  t.after(() => new Promise(resolve => controlServer.close(resolve)))

  const command = [
    shellQuote(fileURLToPath(new URL('../bin/gelios-codex-telegram', import.meta.url))),
    'tui', '--state-dir', shellQuote(bridge.options.stateDir), '--no-alt-screen',
  ].join(' ')
  const tui = spawn(scriptBin, ['-qefc', command, '/dev/null'], {
    cwd: workspace,
    env: { ...isolatedEnv, CODEX_HOME: clientHome, GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin'), TERM: 'xterm-256color', GELIOS_TELEGRAM_CONTROL_SOCKET: bridge.options.controlSocket },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let tuiOutput = ''
  const capture = chunk => { tuiOutput = (tuiOutput + chunk).slice(-65_536) }
  tui.stdout.on('data', capture)
  tui.stderr.on('data', capture)
  t.after(() => terminate(tui))
  await once(tui, 'spawn')

  try {
    await waitFor(() => tuiRequests.some(request =>
      request.method === 'thread/turns/list' && request.params?.threadId === threadId))
    await wait(250)
    const bootstrap = tuiRequests.filter(request =>
      request.params?.threadId === threadId &&
      ['thread/read', 'thread/resume', 'thread/turns/list', 'thread/items/list'].includes(request.method))
    assert.ok(bootstrap.some(request => request.method === 'thread/resume'))
    assert.ok(bootstrap.some(request => request.method === 'thread/turns/list'))
    assert.deepEqual(forwardedForThread.filter(method =>
      ['thread/resume', 'thread/turns/list', 'thread/items/list'].includes(method)), [])
    assert.doesNotMatch(tuiOutput, /Failed to resume session|bounded thread history|thread\/read failed|no rollout found/)
    assert.equal(tui.exitCode, null)
    assert.equal(tui.signalCode, null)
    assert.equal(bridge.emptyThreadHandoffs.has(threadId), true)
    const access = bridge.store.loadAccess()
    access.dmPolicy = 'allowlist'; access.users['123'] = { chatId: '123', alias: 'Test operator', role: 'admin' }; bridge.store.saveAccess(access)
    const beforeRequestCount = tuiRequests.length
    await assert.rejects(bridge.acceptTelegramControl({ controlId: 'real-tui-new', action: 'new', chatId: '123', userId: '123', messageId: '1' }), /removed/)
    const newId = threadId
    assert.equal(bridge.currentThreadId, threadId)
    assert.equal(bridge.tui.selectedThreadId, threadId)
    assert.equal(tuiRequests.length, beforeRequestCount)
    assert.equal(bridge.app.pid, app.pid); assert.equal(app.exitCode, null)
    assert.equal(bridge.emptyThreadHandoffs.has(threadId), true)
    assert.equal(tui.exitCode, null)
    await t.test('native /fork keeps subsequent terminal and Telegram input on the fork, while /btw remains temporary', {
      skip: process.env.GELIOS_REAL_MODEL !== '1' ? 'set GELIOS_REAL_MODEL=1 for real agent fork evidence' : false,
    }, async forkTest => {
      const calls = []
      const api = http.createServer(async (request, response) => {
        let raw = ''; for await (const chunk of request) raw += chunk
        const method = request.url.split('/').at(-1), params = Object.fromEntries(new URLSearchParams(raw))
        calls.push({ method, params }); response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: 77 } : true }))
      })
      api.listen(0, '127.0.0.1'); await once(api, 'listening')
      const channel = new TelegramChannel({ store: bridge.store, workspaceRoot: workspace,
        token: `123456789:${'a'.repeat(32)}`, onInbound: (event, prepare) => bridge.acceptTelegram(event, prepare), log: () => {} })
      channel.api.base = `http://127.0.0.1:${api.address().port}`; bridge.telegram = channel; bridge.batcher = channel.batcher
      bridge.beforeTerminalInput = () => { void channel.batcher.flush().catch(() => {}) }
      t.after(async () => { await channel.stop(); await new Promise(resolve => api.close(resolve)) })
      const answered = (id, marker) => agentMessages.some(message => message.threadId === id && message.text?.includes(marker))
      const until = (predicate, timeout = 120_000) => waitFor(predicate, timeout, forkTest.signal)
      const submit = async text => {
        // Separate paste/typing from Enter so native burst-paste handling does
        // not consume the submission key as part of pasted content.
        if (text.startsWith('/')) for (const char of text) { tui.stdin.write(char); await wait(15) }
        else tui.stdin.write(`\x1b[200~${text}\x1b[201~`)
        await wait(300); tui.stdin.write('\r')
      }
      phase = 'seed'; progress(); await submit('Reply with exactly FORK-SEED.')
      await until(() => answered(newId, 'FORK-SEED') && !bridge.activeTurnId); await wait(250)
      phase = 'fork'; progress(); await submit('/fork')
      await until(() => tuiRequests.some(request => request.method === 'thread/fork' && request.params?.threadId === newId && !request.params.ephemeral), 20_000)
      await until(() => bridge.currentThreadId !== newId && bridge.tui?.selectedThreadId === bridge.currentThreadId, 20_000)
      const forkId = bridge.currentThreadId
      assert.equal(bridge.store.loadBinding().threadId, forkId); await wait(250)
      phase = 'terminal-after-fork'; progress(); await submit('Reply with exactly FORK-TUI-ACCEPTED.')
      await until(() => answered(forkId, 'FORK-TUI-ACCEPTED') && !bridge.activeTurnId)
      phase = 'telegram-after-fork'; progress()
      await channel.handleUpdate({ update_id: 20, message: { message_id: 20, date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: 'private' }, from: { id: 123 },
        text: 'Reply with exactly FORK-TG-ACCEPTED. Do not use tools or send a Telegram reply.' } })
      await channel.batcher.flush()
      await until(() => answered(forkId, 'FORK-TG-ACCEPTED') && !bridge.activeTurnId)
      const fork = (await bridge.rpc('thread/read', { threadId: forkId, includeTurns: true })).thread
      const parent = (await bridge.rpc('thread/read', { threadId: newId, includeTurns: true })).thread
      const texts = thread => thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'agentMessage').map(item => item.text)
      for (const marker of ['FORK-SEED', 'FORK-TUI-ACCEPTED', 'FORK-TG-ACCEPTED']) assert.ok(texts(fork).some(text => text.includes(marker)))
      assert.equal(texts(parent).some(text => /FORK-(TUI|TG)-ACCEPTED/.test(text)), false)
      assert.equal(bridge.store.loadRuntime().events['telegram-123-20'].threadId, forkId)
      phase = 'temporary-side'; progress(); await wait(250); await submit('/btw Reply with exactly FORK-SIDE-ACCEPTED.')
      await until(() => tuiRequests.some(request => request.method === 'thread/fork' && request.params?.threadId === forkId && request.params.ephemeral), 20_000)
      await until(() => agentMessages.some(message => message.threadId !== forkId && message.text?.includes('FORK-SIDE-ACCEPTED')))
      assert.equal(bridge.currentThreadId, forkId); assert.equal(bridge.tui.selectedThreadId, forkId)
      assert.equal(bridge.app.pid, app.pid); assert.equal(app.exitCode, null); assert.equal(tui.exitCode, null)
      phase = 'passed'; progress()
      if (process.env.GELIOS_FORK_EVIDENCE) writeFileSync(process.env.GELIOS_FORK_EVIDENCE, JSON.stringify({
        backendPid: app.pid, originalThreadId: threadId, parentId: newId, forkId,
        binding: bridge.store.loadBinding().threadId, tuiThreadId: bridge.tui.selectedThreadId,
        requests: tuiRequests.filter(request => ['thread/fork', 'turn/start', 'turn/steer'].includes(request.method)).map(request => ({
          method: request.method, threadId: request.params?.threadId, ephemeral: request.params?.ephemeral,
          clientUserMessageId: request.params?.clientUserMessageId, input: request.params?.input,
          approvalPolicy: request.params?.approvalPolicy, sandbox: request.params?.sandbox,
        })),
        forkTurns: fork.turns.map(turn => ({ id: turn.id, status: turn.status,
          items: turn.items.filter(item => ['userMessage', 'agentMessage'].includes(item.type)) })),
        agentMessages, calls, parentReplies: texts(parent), forkReplies: texts(fork),
      }, null, 2), { mode: 0o600 })
    })
  } catch (error) {
    const diagnostics = [appStderr.trim(), tuiOutput.trim()].filter(Boolean).join('\nTUI output:\n')
    if (diagnostics) error.message += `\n${diagnostics}`
    throw error
  } finally {
    if (tui.exitCode === null && tui.signalCode === null) tui.stdin.write('\u0003')
    await wait(100)
    await terminate(tui)
  }
})
