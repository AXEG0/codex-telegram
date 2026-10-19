import { mkdtempSync, spawn } from './fixtures.js'
import assert from 'node:assert/strict'

import { cpSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { once } from 'node:events'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { mcpBootstrap } from '../src/bootstrap.js'
import { pinBuild } from '../src/builds.js'

test('native MCP launch needs no file or working folder from the plugin cache', () => {
  const server = JSON.parse(readFileSync(new URL('../.mcp.json', import.meta.url))).mcpServers.telegram
  assert.equal(server.command, 'node')
  assert.deepEqual(server.args, ['--input-type=module', '-e', mcpBootstrap])
  assert.equal(server.cwd, '/')
  assert.ok(server.env_vars.includes('GELIOS_TELEGRAM_MCP_ROOT'))
  assert.ok(server.env_vars.includes('CODEX_HOME'))
  assert.equal(server.required, true)
})

test('the MCP entry point supports a predecessor bridge and its retained rollback snapshot', { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'gct-mcp-predecessor-')), socketPath = join(root, 'control.sock')
  const build = pinBuild(fileURLToPath(new URL('../', import.meta.url)), join(root, 'state'))
  const snapshot = join(root, 'snapshot'); cpSync(build.root, snapshot, { recursive: true })
  const actions = []
  const control = net.createServer(socket => {
    socket.once('data', data => {
      const { action } = JSON.parse(data); actions.push(action)
      socket.end(JSON.stringify({ ok: true, result: action === 'status' ? { pluginRoot: snapshot } : {} }) + '\n')
    })
  })
  await new Promise(resolve => control.listen(socketPath, resolve)); t.after(() => control.close())
  const server = JSON.parse(readFileSync(new URL('../.mcp.json', import.meta.url))).mcpServers.telegram
  const env = { ...process.env, CODEX_HOME: root, GELIOS_TELEGRAM_STATE_DIR: join(root, 'state'), GELIOS_TELEGRAM_CONTROL_SOCKET: socketPath,
    GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin') }
  delete env.GELIOS_TELEGRAM_MCP_ROOT
  const child = spawn(process.execPath, server.args, { cwd: server.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const lines = readline.createInterface({ input: child.stdout }), response = new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line))))
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
  assert.equal((await response).result.serverInfo.name, 'telegram')
  assert.deepEqual(actions, ['status', 'runtime_environment'])
})

for (const redirectedCache of [false, true]) {
  test(`the MCP entry point rejects a cache root through aliases (redirected cache: ${redirectedCache})`, { timeout: 5000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gct-mcp-cache-root-'))
    const backing = join(root, redirectedCache ? 'backing' : 'plugins/cache'), cache = join(backing, 'telegram')
    mkdirSync(cache, { recursive: true })
    if (redirectedCache) { mkdirSync(join(root, 'plugins')); symlinkSync(backing, join(root, 'plugins/cache')) }
    symlinkSync(cache, join(root, 'alias'))
    const server = JSON.parse(readFileSync(new URL('../.mcp.json', import.meta.url))).mcpServers.telegram
    const child = spawn(process.execPath, server.args, { cwd: server.cwd,
      env: { ...process.env, CODEX_HOME: root, GELIOS_TELEGRAM_MCP_ROOT: join(root, 'alias') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''; child.stderr.on('data', value => { stderr += value })
    const [code] = await once(child, 'exit')
    assert.notEqual(code, 0); assert.match(stderr, /must run outside the Codex plugin cache/)
  })
}

test('MCP server exposes explicit reply/download tools and uses the local control socket', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gelios-mcp-'))
  const socketPath = join(root, 'control.sock')
  const actions = []
  let cancelled = false
  const control = net.createServer(socket => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(buffer.slice(0, newline))
      if (request.action === 'runtime_environment') { socket.end(JSON.stringify({ ok: true, result: {} }) + '\n'); return }
      actions.push(request)
      if (request.args?.text === 'hold') {
        socket.on('close', () => { cancelled = true })
        return
      }
      const result = request.action === 'reply'
        ? { message_ids: [11], event_id: 'telegram-out-test', timestamp: '2026-08-05T00:00:00.000Z' }
        : { path: '/tmp/file.txt' }
      socket.end(`${JSON.stringify({ ok: true, result })}\n`)
    })
  })
  await new Promise(resolvePromise => control.listen(socketPath, resolvePromise))
  t.after(() => control.close())

  const child = spawn(process.execPath, ['scripts/mcp.js'], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, GELIOS_TELEGRAM_CONTROL_SOCKET: socketPath, GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin'), GELIOS_TELEGRAM_STATE_DIR: join(root, 'state') },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  t.after(() => child.kill())
  const lines = readline.createInterface({ input: child.stdout })
  const replies = []
  lines.on('line', line => replies.push(JSON.parse(line)))
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`)
  const waitFor = async id => {
    for (let count = 0; count < 1000; count += 1) {
      const found = replies.find(reply => reply.id === id)
      if (found) return found
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
    }
    throw new Error(`MCP response ${id} timed out`)
  }

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  const initialized = (await waitFor(1)).result
  assert.equal(initialized.serverInfo.name, 'telegram')
  assert.equal(initialized.serverInfo.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version)
  const guide = readFileSync(new URL('../src/telegram-instructions.md', import.meta.url), 'utf8').trim()
  assert.equal(initialized.instructions, guide)
  assert.match(initialized.instructions, /terminal\s+output does not reach/)
  assert.match(initialized.instructions, /telegram_edit_message/)
  assert.doesNotMatch(initialized.instructions, /<channel|image_path|\/telegram:access/)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  assert.deepEqual((await waitFor(2)).result.tools.map(tool => tool.name), ['telegram_react', 'telegram_edit_message', 'telegram_reply', 'telegram_download_attachment'])
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'telegram_reply', arguments: { chat_id: '123', text: 'hello' } } })
  assert.match((await waitFor(3)).result.content[0].text, /11; event=telegram-out-test; time=2026-08-05/)
  assert.equal(actions[0].action, 'reply')
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'telegram_reply', arguments: { chat_id: '123', text: 'hold' } } })
  for (let count = 0; count < 100 && actions.length < 2; count += 1) await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4, reason: 'test' } })
  assert.equal((await waitFor(4)).result.isError, true)
  assert.match((await waitFor(4)).result.content[0].text, /cancelled/)
  for (let count = 0; count < 100 && !cancelled; count += 1) await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  assert.equal(cancelled, true)
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'telegram_react', arguments: { chat_id: '123', message_id: '11', emoji: '👍' } } })
  assert.match((await waitFor(5)).result.content[0].text, /reaction updated/)
  assert.deepEqual(actions.at(-1), { action: 'react', args: { chat_id: '123', message_id: '11', emoji: '👍' } })
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'telegram_edit_message', arguments: { chat_id: '123', message_id: '11', text: 'updated' } } })
  assert.match((await waitFor(6)).result.content[0].text, /message edited/)
  assert.equal(actions.at(-1).action, 'edit_message')
  child.stdin.end()
})
