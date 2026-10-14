import { mkdtempSync, spawn } from './fixtures.js'
import assert from 'node:assert/strict'

import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { GeliosBridge } from '../scripts/bridge.js'

const codexBin = process.env.GELIOS_REAL_CODEX_BIN
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(predicate) {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for real Codex thread lifecycle')
    await wait(20)
  }
}

test('real app-server resumes an unloaded established conversation and replays queued identities once', {
  skip: codexBin ? false : 'set GELIOS_REAL_CODEX_BIN for real Codex lifecycle coverage', timeout: 60_000,
}, async t => {
  // Only the model endpoint is a fixture; thread persistence, unload, resume and turns are real Codex.
  const provider = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
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
  t.after(() => new Promise(resolve => provider.close(resolve)))
  const root = mkdtempSync(join(tmpdir(), 'gelios-real-thread-recovery-'))
  const workspace = join(root, 'workspace'), codexHome = join(root, 'codex-home')
  mkdirSync(workspace); mkdirSync(codexHome)
  writeFileSync(join(codexHome, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "fixture"\nmodel_reasoning_effort = "high"\n[model_providers.fixture]\nname = "Local integration fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`)
  const app = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
    cwd: workspace, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  app.stderr.setEncoding('utf8'); app.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
  t.after(async () => {
    if (app.exitCode !== null || app.signalCode !== null) return
    app.kill('SIGTERM'); await Promise.race([once(app, 'exit'), wait(2000)])
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
  })
  await once(app, 'spawn')
  const bridge = new GeliosBridge({ stateDir: join(root, 'state'), workspace })
  bridge.app = app; bridge.appReady = true; bridge.log = () => {}
  bridge.telegram = { acknowledge: async () => {}, stopTyping() {} }
  const completed = new Set(), methods = []
  readline.createInterface({ input: app.stdout }).on('line', line => {
    const message = JSON.parse(line)
    if (message.method === 'turn/completed') completed.add(message.params.turn.id)
    bridge.onAppLine(line)
  })
  const rpc = bridge.rpc.bind(bridge)
  bridge.rpc = (method, params, timeoutMs) => { methods.push(method); return rpc(method, params, timeoutMs) }
  try {
    await bridge.rpc('initialize', { clientInfo: { name: 'gelios-recovery-integration', version: '0' }, capabilities: { experimentalApi: true } })
    bridge.sendApp({ method: 'initialized' })
    const started = await bridge.rpc('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' })
    const threadId = started.thread.id
    bridge.bindThread(threadId)
    bridge.currentSettings = { model: started.model, effort: started.reasoningEffort }
    const first = await bridge.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Established history.' }], clientUserMessageId: 'history-client' })
    await waitFor(() => completed.has(first.turn.id))
    const before = (await bridge.rpc('thread/read', { threadId, includeTurns: true })).thread
    assert.ok(before.turns.some(turn => turn.items.some(item => item.type === 'agentMessage' && item.text === 'Fixture reply.')))

    // Archive unloads immediately; unarchive retains the rollout and ID without loading it.
    // This exercises the same notLoaded contract without waiting for the unsubscribe grace period.
    await bridge.rpc('thread/archive', { threadId })
    await bridge.rpc('thread/unarchive', { threadId })
    assert.equal(await bridge.isThreadLoaded(threadId), false)
    assert.equal((await bridge.rpc('thread/read', { threadId, includeTurns: false })).thread.status.type, 'notLoaded')
    const event = id => ({ eventId: `telegram-123-${id}`, source: 'Telegram', prepared: true,
      chatId: '123', messageId: String(id), clientId: `telegram-123-${id}`, input: [{ type: 'text', text: `queued ${id}` }] })
    for (const id of [1, 2]) bridge.store.acceptEvent(event(id).eventId, { source: 'Telegram', payload: event(id) })
    bridge.restorePendingEvents()
    const boundary = methods.length
    bridge.flushWaiting(); await bridge.ingress
    for (const saved of Object.values(bridge.store.loadRuntime().events)) {
      assert.equal(saved.status, 'delivered'); assert.equal(saved.threadId, threadId)
      await waitFor(() => completed.has(saved.turnId))
    }
    const after = (await bridge.rpc('thread/read', { threadId, includeTurns: true })).thread
    const clients = after.turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage').map(item => item.clientId))
    assert.deepEqual(clients, ['history-client', 'telegram-123-1', 'telegram-123-2'])
    assert.equal(methods.slice(boundary).filter(method => method === 'thread/resume').length, 1)
    assert.equal(bridge.currentThreadId, threadId)
    assert.deepEqual(bridge.currentSettings, { model: 'gpt-6.1-sol', effort: 'high' })
    // A stale queue entry and a concurrently accepted duplicate cannot replay the same client ID.
    bridge.waitingTelegram.push({ ...event(1), sequence: 1, reconcile: true })
    bridge.flushWaiting(); await bridge.ingress
    await bridge.acceptTelegram(event(2), async () => { throw new Error('duplicate must not be prepared') })
    const final = (await bridge.rpc('thread/read', { threadId, includeTurns: true })).thread
    assert.deepEqual(final.turns, after.turns)
    // Unload on the real server after verification but before it accepts turn/start.
    const trackedRpc = bridge.rpc
    let raced = false
    bridge.rpc = async (method, params, timeoutMs) => {
      if (method === 'turn/start' && !raced) {
        raced = true
        await rpc('thread/archive', { threadId }); await rpc('thread/unarchive', { threadId })
      }
      return trackedRpc(method, params, timeoutMs)
    }
    await bridge.acceptTelegram(event(3), async () => event(3))
    const third = bridge.store.loadRuntime().events[event(3).eventId]
    assert.equal(third.status, 'delivered'); await waitFor(() => completed.has(third.turnId))
    const racedThread = (await bridge.rpc('thread/read', { threadId, includeTurns: true })).thread
    assert.deepEqual(racedThread.turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage').map(item => item.clientId)),
      ['history-client', 'telegram-123-1', 'telegram-123-2', 'telegram-123-3'])
    assert.equal(methods.slice(boundary).filter(method => method === 'thread/resume').length, 2)
  } catch (error) {
    if (stderr.trim()) error.message += `\napp-server stderr:\n${stderr.trim()}`
    throw error
  }
})
