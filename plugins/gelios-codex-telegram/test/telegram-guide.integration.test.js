import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { GeliosBridge } from '../scripts/bridge.js'

const codexBin = process.env.GELIOS_REAL_CODEX_BIN
const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(predicate, what) {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(20)
  }
}

test('a new conversation receives the Telegram guide and telegram_reply in its first model request', {
  skip: codexBin ? false : 'set GELIOS_REAL_CODEX_BIN for real Codex tool exposure coverage', timeout: 90_000,
}, async t => {
  // A model whose catalog entry supports tool search defers MCP tools, and Codex then shows a
  // deferred server's instructions only after the model searches for them. The installed plugin,
  // its MCP server and Codex are real; only the model endpoint is a fixture that records requests.
  const requests = []
  const provider = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push(body)
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Fixture reply.', annotations: [] }] }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const event of [
      { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const root = mkdtempSync(join(tmpdir(), 'gelios-real-telegram-guide-'))
  let app = null
  // One ordered teardown: the app-server stops before its fixture endpoint closes and its Codex home is removed,
  // since a running app-server keeps writing there and a failed removal would leave it running.
  t.after(async () => {
    if (app && app.exitCode === null && app.signalCode === null) {
      app.kill('SIGTERM'); await Promise.race([once(app, 'exit'), wait(2000)])
      if (app.exitCode === null && app.signalCode === null) { app.kill('SIGKILL'); await once(app, 'exit') }
    }
    await new Promise(resolve => provider.close(resolve))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  const workspace = join(root, 'workspace'), codexHome = join(root, 'codex-home')
  mkdirSync(workspace); mkdirSync(codexHome)
  writeFileSync(join(codexHome, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "fixture"\nmodel_reasoning_effort = "high"\n[model_providers.fixture]\nname = "Local integration fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`)
  const env = { ...process.env, CODEX_HOME: codexHome,
    GELIOS_TELEGRAM_CONTROL_SOCKET: join(root, 'control.sock'), GELIOS_TELEGRAM_STATE_DIR: join(root, 'state') }
  // Install from this checkout's marketplace, so the test reads the shipped MCP declaration.
  // Bounded and asynchronous, so a stalled CLI fails this test with its output instead of blocking the runner.
  for (const args of [['plugin', 'marketplace', 'add', repoRoot, '--json'], ['plugin', 'add', 'gelios-codex-telegram@gelios', '--json']]) {
    try { await run(codexBin, args, { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: 60_000 }) } catch (error) {
      throw new Error(`codex ${args.slice(0, 2).join(' ')} failed: ${error.message}\nstdout: ${error.stdout}\nstderr: ${error.stderr}`)
    }
  }
  app = spawn(codexBin, ['app-server', '--listen', 'stdio://'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  app.stderr.setEncoding('utf8'); app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
  await once(app, 'spawn')
  const bridge = new GeliosBridge({ stateDir: join(root, 'state'), workspace })
  bridge.app = app; bridge.appReady = true; bridge.log = () => {}
  const completed = new Set()
  readline.createInterface({ input: app.stdout }).on('line', line => {
    const message = JSON.parse(line)
    if (message.method === 'turn/completed') completed.add(message.params.turn.id)
    bridge.onAppLine(line)
  })
  try {
    await bridge.rpc('initialize', { clientInfo: { name: 'gelios-telegram-guide-integration', version: '0' }, capabilities: { experimentalApi: true } })
    bridge.sendApp({ method: 'initialized' })
    const started = await bridge.rpc('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' })
    const turn = await bridge.rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text',
      text: '[Telegram/Owner | 2026-01-01T00:00:00.000Z | #1 | event=telegram-1-1]\nTelegram metadata: chat_id=1; message_id=1; user_id=1; role=admin\nHey' }] })
    await waitFor(() => completed.has(turn.turn.id), 'the first turn to complete')
    assert.ok(requests.length > 0, 'the fixture model endpoint received no request')
    const first = JSON.stringify(JSON.parse(requests[0]))
    assert.match(first, /# Telegram collaboration/, 'the first model request lacks the Telegram collaboration guide')
    assert.match(first, /telegram_reply/, 'the first model request lacks the telegram_reply tool')
  } catch (error) {
    if (stderr.trim()) error.message += `\napp-server stderr:\n${stderr.trim()}`
    throw error
  }
})
