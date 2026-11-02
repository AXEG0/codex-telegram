import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { connectRuntime, runtimeSocket, stopRuntime } from '../src/runtime.js'
import { requestControl } from '../src/control.js'
import { mkdtempSync } from './fixtures.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const run = promisify(execFile)
async function until(check, label) {
  const end = Date.now() + 10_000
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(20) }
  throw new Error(`timed out: ${label}`)
}
function rpc(app) {
  let next = 0
  const pending = new Map(), notifications = []
  readline.createInterface({ input: app.stdout }).on('line', line => {
    const message = JSON.parse(line)
    if (message.id !== undefined && pending.has(message.id)) {
      const answer = pending.get(message.id); pending.delete(message.id)
      if (message.error) answer.reject(new Error(message.error.message)); else answer.resolve(message.result)
    } else notifications.push(message)
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject }); app.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  return { call, notifications, initialized: () => app.stdin.write('{"method":"initialized"}\n') }
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-reconnect-')), stateDir = join(root, 'state'), workspace = join(root, 'work')
  mkdirSync(workspace)
  const codexBin = join(root, 'codex.cjs'), log = join(root, 'native.jsonl'), done = join(root, 'done')
  writeFileSync(codexBin, `#!${process.execPath}
const fs = require('node:fs'), readline = require('node:readline'), {spawn} = require('node:child_process');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const session = require('node:crypto').randomBytes(8).toString('hex');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)}, line+'\\n');
 if (m.method==='initialize') send({id:m.id,result:{userAgent:'native-fixture',pid:process.pid}});
 else if (m.method==='job') {
  const job=spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(done)},'finished'),1200)`)}],{stdio:'ignore',detached:true}); job.unref();
  send({id:m.id,result:{job:job.pid,session}});
 } else if(m.method==='stubborn') {const job=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});job.unref();setTimeout(()=>send({id:m.id,result:{pid:job.pid}}),100)}
 else if(m.method==='offline') {send({id:m.id,result:{accepted:true}});setTimeout(()=>send({method:'turn/completed',params:{turn:{id:'offline-turn',status:'completed'}}}),100)}
 else if (m.id!==undefined) send({id:m.id,result:{session,pid:process.pid,echo:m.params}});
});
`, { mode: 0o700 }); chmodSync(codexBin, 0o700)
  const options = { stateDir, workspace, codexBin }
  t.after(async () => { if (existsSync(runtimeSocket(stateDir))) await stopRuntime(stateDir) })
  return { ...options, options, root, done, log }
}

test('a reconnect keeps the native process, conversation and detached job alive', { timeout: 20_000 }, async t => {
  const f = await fixture(t), first = await connectRuntime(f.options, process.env), a = rpc(first)
  const hello = await a.call('initialize', { clientInfo: { name: 'runtime-test', version: '1' } }); a.initialized()
  const job = await a.call('job')
  await a.call('offline')
  const closed = once(first, 'exit'); first.kill(); await closed
  await until(async () => !(await requestControl(runtimeSocket(f.stateDir), 'status')).attached, 'client detached')
  await delay(150)
  const second = await connectRuntime(f.options, process.env), b = rpc(second)
  assert.deepEqual(await b.call('initialize', { clientInfo: { name: 'runtime-test', version: '1' } }), hello); b.initialized()
  const resumed = await b.call('resume')
  assert.equal(resumed.session, job.session); assert.equal(resumed.pid, hello.pid)
  assert.equal(first.runtime.instanceId, second.runtime.instanceId)
  await until(() => b.notifications.some(message => message.params?.turn?.id === 'offline-turn'), 'offline completion replay')
  assert.equal(b.notifications.filter(message => message.params?.turn?.id === 'offline-turn').length, 1)
  await until(() => existsSync(f.done), 'detached job reaches its own end')
  assert.equal(readFileSync(f.done, 'utf8'), 'finished')
  const native = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(native.filter(m => m.method === 'initialize').length, 1)
  assert.equal(native.filter(m => m.method === 'initialized').length, 1)
  second.kill()
})

test('a second messaging client is refused without disturbing the first', { timeout: 20_000 }, async t => {
  const f = await fixture(t), app = await connectRuntime(f.options, process.env), a = rpc(app)
  await a.call('initialize'); a.initialized()
  await assert.rejects(connectRuntime(f.options, process.env), /already has a messaging client/)
  await assert.rejects(stopRuntime(f.stateDir), /stop the Telegram bridge/)
  assert.equal((await a.call('still-running')).pid, app.pid)
  app.kill()
})

test('runtime launch credentials are not persisted in its state', { timeout: 20_000 }, async t => {
  const f = await fixture(t), secret = 'private-runtime-secret-491', app = await connectRuntime(f.options, { ...process.env, FIXTURE_SECRET: secret })
  const a = rpc(app); await a.call('initialize'); a.initialized()
  assert.ok(!readFileSync(join(f.stateDir, 'native-runtime.json'), 'utf8').includes(secret))
  app.kill()
})

test('the operator can inspect and explicitly stop a detached runtime', { timeout: 20_000 }, async t => {
  const f = await fixture(t), app = await connectRuntime(f.options, process.env), a = rpc(app)
  await a.call('initialize'); a.initialized()
  const launcher = fileURLToPath(new URL('../bin/codex-telegram', import.meta.url))
  const args = ['telegram', 'runtime'], state = ['--state-dir', f.stateDir]
  const status = JSON.parse((await run(process.execPath, [launcher, ...args, 'status', ...state])).stdout)
  assert.equal(status.appPid, app.pid); assert.equal(status.attached, true)
  await assert.rejects(run(process.execPath, [launcher, ...args, 'stop', ...state]), /stop the Telegram bridge/)
  const exited = once(app, 'exit'); app.kill(); await exited
  await until(async () => !(await requestControl(runtimeSocket(f.stateDir), 'status')).attached, 'operator detaches')
  const stopped = JSON.parse((await run(process.execPath, [launcher, ...args, 'stop', ...state])).stdout)
  assert.equal(stopped.stopped, true); assert.equal(stopped.instanceId, status.instanceId)
  assert.equal(existsSync(runtimeSocket(f.stateDir)), false)
})

test('the independent runtime never overwrites the bridge input journal', { timeout: 20_000 }, async t => {
  const f = await fixture(t)
  mkdirSync(f.stateDir, { mode: 0o700 })
  const journal = '{"events":{"queued-input":{"status":"queued"}}}\n'
  writeFileSync(join(f.stateDir, 'runtime.json'), journal, { mode: 0o600 })
  const app = await connectRuntime(f.options, process.env), a = rpc(app)
  await a.call('initialize'); a.initialized()
  assert.equal(readFileSync(join(f.stateDir, 'runtime.json'), 'utf8'), journal)
  app.kill()
})

test('real systemd: explicit runtime stop waits for its remaining jobs and permits immediate relaunch', {
  skip: process.env.GELIOS_SYSTEMD_TEST !== '1', timeout: 30_000,
}, async t => {
  const f = await fixture(t)
  f.options.systemdUnit = 'fixture-bridge.service'
  const first = await connectRuntime(f.options, process.env), a = rpc(first)
  await a.call('initialize'); a.initialized(); await a.call('stubborn')
  const closed = once(first, 'exit'); first.kill(); await closed
  await until(async () => !(await requestControl(runtimeSocket(f.stateDir), 'status')).attached, 'systemd client detaches')
  const stopped = await stopRuntime(f.stateDir)
  const result = await run('systemctl', ['--user', 'show', stopped.unit, '--property=ActiveState', '--value'])
  assert.doesNotMatch(result.stdout.trim(), /^(active|activating|deactivating)$/)
  const second = await connectRuntime(f.options, process.env), b = rpc(second)
  await b.call('initialize'); b.initialized()
  assert.notEqual(second.pid, first.pid)
  const detached = once(second, 'exit'); second.kill(); await detached
})

test('real Codex: reconnect preserves the loaded conversation and a detached command', {
  skip: !process.env.GELIOS_REAL_CODEX_BIN, timeout: 30_000,
}, async t => {
  const f = await fixture(t), codexHome = join(f.root, 'codex-home')
  mkdirSync(codexHome)
  const jobPid = join(f.root, 'job-pid')
  const jobScript = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(f.done)},'finished'),3000)`)}],{detached:true,stdio:'ignore'});c.unref();require('node:fs').writeFileSync(${JSON.stringify(jobPid)},String(c.pid))`
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'"
  const command = [process.execPath, '-e', jobScript].map(quote).join(' ')
  // Only inference is a loopback fixture. The native runtime owns the real
  // conversation, command processes and subscriptions across reconnect.
  const provider = http.createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part
    const { input = [], tools = [] } = JSON.parse(body)
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Established conversation.', annotations: [] }] }
    let output = [item]
    if (!input.some(value => value.type === 'function_call_output')) {
      function tool(list, namespace) {
        for (const value of list) {
          if (['exec_command', 'shell_command'].includes(value.name)) return { name: value.name, namespace }
          if (value.type === 'namespace') { const nested = tool(value.tools || [], value.name); if (nested) return nested }
        }
      }
      const native = tool(tools)
      assert.ok(native, 'native shell tool is advertised')
      output = [{ type: 'function_call', id: 'fc_job', call_id: 'call_job', name: native.name,
        ...(native.namespace ? { namespace: native.namespace } : {}), status: 'completed',
        arguments: JSON.stringify(native.name === 'exec_command' ? { cmd: command, yield_time_ms: 1000 } : { command }) }]
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const event of [
      { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item: output[0] },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  t.after(() => { provider.closeAllConnections(); provider.close() })
  writeFileSync(join(codexHome, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`)
  const options = { ...f.options, codexBin: process.env.GELIOS_REAL_CODEX_BIN }
  const env = { ...process.env, CODEX_HOME: codexHome }
  const first = await connectRuntime(options, env), a = rpc(first)
  await a.call('initialize', { clientInfo: { name: 'runtime-reconnect-test', version: '0' }, capabilities: { experimentalApi: true } }); a.initialized()
  const before = await a.call('thread/start', { cwd: f.workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' })
  await a.call('turn/start', { threadId: before.thread.id, input: [{ type: 'text', text: 'Establish the conversation.' }] })
  await until(() => a.notifications.some(m => m.method === 'turn/completed'), 'conversation is persisted')
  assert.ok(existsSync(jobPid), 'the real native turn started its detached job')
  assert.equal(existsSync(f.done), false, 'the job is still running at disconnect')
  const closed = once(first, 'exit'); first.kill(); await closed
  await until(async () => !(await requestControl(runtimeSocket(f.stateDir), 'status')).attached, 'real client disconnect')
  const second = await connectRuntime(options, env), b = rpc(second)
  await b.call('initialize', { clientInfo: { name: 'runtime-reconnect-test', version: '0' }, capabilities: { experimentalApi: true } }); b.initialized()
  const resumed = await b.call('thread/resume', { threadId: before.thread.id, excludeTurns: true })
  assert.equal(resumed.thread.id, before.thread.id)
  assert.equal(second.pid, first.pid)
  assert.equal(second.runtime.instanceId, first.runtime.instanceId)
  await until(() => existsSync(f.done), 'real native command reaches its own end')
  assert.equal(readFileSync(f.done, 'utf8'), 'finished')
  second.kill()
})
