import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { connectRuntime as attachRuntime, ensureRuntime, runtimeSocket, runtimeUnit, stopRuntime } from '../src/runtime.js'
import { requestControl } from '../src/control.js'
import { mkdtempSync } from './fixtures.js'
import { cleanup, until } from './support/wait.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const run = promisify(execFile)
const clients = new Map()
async function connectRuntime(options, env, secrets) {
  const app = await attachRuntime(options, env, secrets)
  if (!clients.has(options.stateDir)) clients.set(options.stateDir, [])
  clients.get(options.stateDir).push(app)
  return app
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
async function fixture(t, base = tmpdir()) {
  const root = mkdtempSync(join(base, 'runtime-reconnect-')), stateDir = join(root, 'state'), workspace = join(root, 'work')
  mkdirSync(workspace)
  const codexBin = join(root, 'codex.cjs'), log = join(root, 'native.jsonl'), done = join(root, 'done')
  writeFileSync(codexBin, `#!${process.execPath}
const fs = require('node:fs'), readline = require('node:readline'), {spawn} = require('node:child_process');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const session = require('node:crypto').randomBytes(8).toString('hex');
const held = new Map();
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)}, line+'\\n');
 if (m.method==='initialize') send({id:m.id,result:{userAgent:'native-fixture',pid:process.pid}});
 else if(m.method==='ownership') send({id:m.id,result:{uid:process.getuid(),rootUid:fs.statSync('/').uid,map:fs.readFileSync('/proc/self/uid_map','utf8')}});
 else if(m.method==='hold') held.set(m.params.label,m);
 else if(m.method==='release') {const old=held.get(m.params.label);held.delete(m.params.label);send({id:old.id,result:{value:old.params.label}});send({id:m.id,result:{released:true}})}
 else if(m.method==='emit-secret') {process.stderr.write(process.env.ROTATING_SLOT+'\\n');send({id:m.id,result:{emitted:true}})}
 else if (m.method==='job') {
  const job=spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(done)},'finished'),1200)`)}],{stdio:'ignore',detached:true}); job.unref();
  send({id:m.id,result:{job:job.pid,session}});
 } else if(m.method==='stubborn') {const job=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});job.unref();setTimeout(()=>send({id:m.id,result:{pid:job.pid}}),100)}
 else if(m.method==='offline') {send({id:m.id,result:{accepted:true}});setTimeout(()=>send({method:'turn/completed',params:{turn:{id:'offline-turn',status:'completed'}}}),100)}
 else if (m.id!==undefined) send({id:m.id,result:{session,pid:process.pid,echo:m.params}});
});
`, { mode: 0o700 }); chmodSync(codexBin, 0o700)
  const options = { stateDir, workspace, codexBin }
  cleanup(t, 'owned runtime', async hook => {
    for (const app of clients.get(stateDir) || []) if (app.exitCode === null) {
      const closed = once(app, 'exit'); app.kill(); await closed
    }
    clients.delete(stateDir)
    if (existsSync(runtimeSocket(stateDir))) {
      await until(hook, async () => !(await requestControl(runtimeSocket(stateDir), 'status')).attached, 'owned clients detach before cleanup')
      await stopRuntime(stateDir)
    }
  }, { timeout: 30_000 })
  return { ...options, options, root, done, log }
}

test('a reconnect keeps the native process, conversation and detached job alive', { timeout: 20_000 }, async t => {
  const f = await fixture(t), first = await connectRuntime(f.options, process.env), a = rpc(first)
  const hello = await a.call('initialize', { clientInfo: { name: 'runtime-test', version: '1' } }); a.initialized()
  const job = await a.call('job')
  await a.call('offline')
  const closed = once(first, 'exit'); first.kill(); await closed
  await until(t, async () => !(await requestControl(runtimeSocket(f.stateDir), 'status')).attached, 'client detached')
  await delay(150)
  const second = await connectRuntime(f.options, process.env), b = rpc(second)
  assert.deepEqual(await b.call('initialize', { clientInfo: { name: 'runtime-test', version: '1' } }), hello); b.initialized()
  const resumed = await b.call('resume')
  assert.equal(resumed.session, job.session); assert.equal(resumed.pid, hello.pid)
  assert.equal(first.runtime.instanceId, second.runtime.instanceId)
  await until(t, () => b.notifications.some(message => message.params?.turn?.id === 'offline-turn'), 'offline completion replay')
  assert.equal(b.notifications.filter(message => message.params?.turn?.id === 'offline-turn').length, 1)
  // The job creates its file before it writes it, so the wait reads the content.
  assert.equal(await until(t, () => existsSync(f.done) && readFileSync(f.done, 'utf8'), 'detached job reaches its own end'), 'finished')
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
  await until(t, async () => !(await requestControl(runtimeSocket(f.stateDir), 'status')).attached, 'operator detaches')
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
  const f = await fixture(t, homedir())
  f.options.systemdUnit = `codex-source-policy-${process.pid}.service`
  t.after(async () => {
    try { await run('systemctl', ['--user', 'stop', f.options.systemdUnit]) }
    catch (error) { if (!/not loaded|not found/.test(error.stderr || '')) throw error }
  })
  const diagnostics = async error => {
    // Keep the failing isolated unit's evidence before fixture cleanup. Never
    // dump another installation's unit or its environment properties.
    const unit = runtimeUnit(f.stateDir)
    for (const [command, args] of [
      ['systemctl', ['--user', 'show', unit, f.options.systemdUnit, '-p', 'ActiveState', '-p', 'Result', '-p', 'ExecMainStatus']],
      ['journalctl', ['--user', '-u', unit, '-u', f.options.systemdUnit, '--no-pager', '-n', '30']],
      ['sysctl', ['kernel.unprivileged_userns_clone', 'kernel.apparmor_restrict_unprivileged_userns']],
    ]) {
      try { const result = await run(command, args, { timeout: 3000, maxBuffer: 64 * 1024 }); t.diagnostic(result.stdout) }
      catch (diagnostic) { t.diagnostic(diagnostic.stdout || diagnostic.message) }
    }
    throw error
  }
  await run('systemd-run', ['--user', '--collect', '--service-type=exec', '--unit=' + f.options.systemdUnit, '--property=MemoryMax=128M', '--property=CPUQuota=100%', '--property=LimitNOFILE=2048', '--property=PrivateTmp=yes', '--property=PrivateUsers=yes', '--property=Nice=5', '--property=RuntimeMaxSec=60', '--', '/usr/bin/sleep', '60']).catch(diagnostics)
  const first = await connectRuntime(f.options, process.env).catch(diagnostics)
  const a = rpc(first)
  const policy = (await run('systemctl', ['--user', 'show', first.runtime.unit, '-p', 'MemoryMax', '-p', 'CPUQuotaPerSecUSec', '-p', 'LimitNOFILE', '-p', 'PrivateTmp', '-p', 'PrivateUsers', '-p', 'Nice', '-p', 'RuntimeMaxUSec'])).stdout
  for (const value of ['MemoryMax=134217728', 'CPUQuotaPerSecUSec=1s', 'LimitNOFILE=2048', 'PrivateTmp=yes', 'PrivateUsers=yes', 'Nice=5', 'RuntimeMaxUSec=infinity']) assert.ok(policy.includes(value), policy)
  await a.call('initialize'); a.initialized()
  const ownership = await a.call('ownership')
  assert.equal(ownership.uid, process.getuid()); assert.notEqual(ownership.rootUid, 0)
  assert.equal(ownership.map.trim().replace(/\s+/g, ' '), `${process.getuid()} ${process.getuid()} 1`)
  await a.call('stubborn')
  const closed = once(first, 'exit'); first.kill(); await closed
  await until(t, async () => !(await requestControl(runtimeSocket(f.stateDir), 'status')).attached, 'systemd client detaches')
  const stopped = await stopRuntime(f.stateDir)
  const result = await run('systemctl', ['--user', 'show', stopped.unit, '--property=ActiveState', '--value'])
  assert.doesNotMatch(result.stdout.trim(), /^(active|activating|deactivating)$/)
  assert.equal(existsSync(join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, 'systemd/user', stopped.unit + '.d', '50-codex-inherited.conf')), false)
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
  const jobPid = join(f.root, 'job-pid'), jobRelease = join(f.root, 'job-release')
  const boundedJob = `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(jobRelease)})){fs.writeFileSync(${JSON.stringify(f.done)},'finished');clearInterval(timer)}else{try{process.kill(${process.pid},0)}catch{process.exit(2)}}},25)`
  const jobScript = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(boundedJob)}],{detached:true,stdio:'ignore'});c.unref();require('node:fs').writeFileSync(${JSON.stringify(jobPid)},String(c.pid))`
  t.after(() => writeFileSync(jobRelease, 'finish'))
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
  await until(t, () => a.notifications.some(m => m.method === 'turn/completed' && m.params.threadId === before.thread.id), 'conversation is persisted')
  // A yielded command can still be starting after its native turn completes.
  await until(t, () => existsSync(jobPid), 'native detached-job receipt: ' + JSON.stringify(a.notifications).slice(-10000))
  assert.equal(existsSync(f.done), false, 'the job is still running at disconnect')
  const closed = once(first, 'exit'); first.kill(); await closed
  await until(t, async () => !(await requestControl(runtimeSocket(f.stateDir), 'status')).attached, 'real client disconnect')
  const second = await connectRuntime(options, env), b = rpc(second)
  await b.call('initialize', { clientInfo: { name: 'runtime-reconnect-test', version: '0' }, capabilities: { experimentalApi: true } }); b.initialized()
  const resumed = await b.call('thread/resume', { threadId: before.thread.id, excludeTurns: true })
  assert.equal(resumed.thread.id, before.thread.id)
  assert.equal(second.pid, first.pid)
  assert.equal(second.runtime.instanceId, first.runtime.instanceId)
  writeFileSync(jobRelease, 'finish')
  assert.equal(await until(t, () => existsSync(f.done) && readFileSync(f.done, 'utf8'), 'real native command reaches its own end'), 'finished')
  second.kill()
})

test('a stale response cannot answer a reused request ID on a new connection', { timeout: 30_000 }, async t => {
  const f = await fixture(t), first = await connectRuntime(f.options, process.env), a = rpc(first)
  await a.call('initialize'); a.initialized(); void a.call('hold', { label: 'old' })
  await a.call('recorded')
  let closed = once(first, 'exit'); first.kill(); await closed
  await until(t, async () => !(await requestControl(runtimeSocket(f.stateDir), 'status')).attached, 'old connection closes')
  const second = await connectRuntime(f.options, process.env), b = rpc(second)
  await b.call('initialize'); b.initialized()
  let settled = false
  const current = b.call('hold', { label: 'new' }).then(value => { settled = true; return value })
  await b.call('release', { label: 'old' })
  assert.equal(settled, false, 'old response was consumed without answering the new caller')
  await b.call('release', { label: 'new' })
  assert.deepEqual(await current, { value: 'new' })
  closed = once(second, 'exit'); second.kill(); await closed
})

test('changed credentials are reported without persisting the credentials or their digest', { timeout: 30_000 }, async t => {
  const f = await fixture(t), first = await connectRuntime(f.options, { ...process.env, ROTATING_SLOT: 'old-credential' }), a = rpc(first)
  await a.call('initialize'); a.initialized()
  assert.equal(first.runtime.environmentChanged, false)
  const closed = once(first, 'exit'); first.kill(); await closed
  await until(t, async () => !(await requestControl(runtimeSocket(f.stateDir), 'status')).attached, 'credential client closes')
  const second = await connectRuntime(f.options, { ...process.env, ROTATING_SLOT: 'new-credential' }), b = rpc(second)
  await b.call('initialize'); b.initialized()
  assert.equal(second.runtime.environmentChanged, true)
  assert.equal(second.pid, first.pid)
  assert.doesNotMatch(readFileSync(join(f.stateDir, 'native-runtime.json'), 'utf8'), /old-credential|new-credential|environmentDigest/)
  const exited = once(second, 'exit'); second.kill(); await exited
})

test('the runtime service launch never receives native credentials as arguments, properties or environment', { timeout: 30_000 }, async t => {
  const f = await fixture(t), secret = 'native-launch-secret-unique', launches = []
  await assert.rejects(ensureRuntime({ ...f.options, systemdUnit: 'fixture.service' }, { ...process.env, SECRET_SLOT: secret }, {
    policy: async () => {},
    launch(command, args, options) {
      launches.push({ command, args, options })
      const child = new EventEmitter(); process.nextTick(() => child.emit('error', new Error('captured launch'))); return child
    },
  }), /captured launch/)
  assert.equal(launches.length, 1)
  assert.equal(launches[0].command, 'systemd-run')
  assert.doesNotMatch(JSON.stringify(launches), new RegExp(secret + '|SECRET_SLOT|--setenv'))
})

test('runtime status tolerates a live supervisor delayed by scheduling pressure', { timeout: 30_000 }, async t => {
  const { runtimeStatus } = await import('../src/runtime.js')
  const f = await fixture(t), app = await connectRuntime(f.options, process.env), a = rpc(app)
  await a.call('initialize'); a.initialized()
  const pid = app.runtime.pid
  process.kill(pid, 'SIGSTOP')
  const resume = setTimeout(() => process.kill(pid, 'SIGCONT'), 800)
  t.after(() => { clearTimeout(resume); try { process.kill(pid, 'SIGCONT') } catch {} })
  const status = await runtimeStatus(f.stateDir)
  assert.equal(status.appPid, app.pid)
  const exited = once(app, 'exit'); app.kill(); await exited
})

test('stderr still redacts the running credentials after the connecting bridge rotates its credentials', { timeout: 30_000 }, async t => {
  const f = await fixture(t), oldSecret = 'old-native-secret-unique', newSecret = 'new-native-secret-unique'
  const first = await connectRuntime(f.options, { ...process.env, ROTATING_SLOT: oldSecret }, [oldSecret]), a = rpc(first)
  await a.call('initialize'); a.initialized()
  let closed = once(first, 'exit'); first.kill(); await closed
  await until(t, async () => !(await requestControl(runtimeSocket(f.stateDir), 'status')).attached, 'old redaction client detaches')
  const second = await connectRuntime(f.options, { ...process.env, ROTATING_SLOT: newSecret }, [newSecret]), b = rpc(second)
  let stderr = ''; second.stderr.on('data', chunk => { stderr += chunk })
  await b.call('initialize'); b.initialized(); await b.call('emit-secret')
  await until(t, () => stderr.includes('[redacted]'), 'old native key was redacted')
  assert.doesNotMatch(stderr, /old-native-secret-unique|new-native-secret-unique/)
  closed = once(second, 'exit'); second.kill(); await closed
})


test('runtime startup validates the full host path before granting a directory anchor', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  chmodSync(f.root, 0o770)
  t.after(() => chmodSync(f.root, 0o700))
  let launched = false
  await assert.rejects(ensureRuntime(f.options, process.env, { launch() { launched = true } }), /untrusted parent directory/)
  assert.equal(launched, false)
})


test('real systemd: messaging inside a user namespace starts and stops the protected runtime', {
  skip: process.env.GELIOS_SYSTEMD_TEST !== '1', timeout: 35_000,
}, async t => {
  const f = await fixture(t, homedir()), unit = `codex-namespaced-client-${process.pid}.service`
  f.options.systemdUnit = unit
  const runtime = new URL('../src/runtime.js', import.meta.url).href
  const code = `import assert from 'node:assert/strict';import {once} from 'node:events';import readline from 'node:readline';
    import {connectRuntime,stopRuntime} from ${JSON.stringify(runtime)};
    const app=await connectRuntime(${JSON.stringify(f.options)},process.env),lines=readline.createInterface({input:app.stdout});
    let id=0;const call=method=>new Promise(resolve=>{lines.once('line',line=>resolve(JSON.parse(line).result));app.stdin.write(JSON.stringify({id:++id,method})+'\\n')});
    await call('initialize');app.stdin.write(JSON.stringify({method:'initialized'})+'\\n');const ownership=await call('ownership');
    const closed=once(app,'exit');app.kill();await closed;await stopRuntime(${JSON.stringify(f.stateDir)});console.log(JSON.stringify(ownership));`
  try {
    const result = await run('systemd-run', ['--user', '--wait', '--pipe', '--quiet', '--collect', '--service-type=exec', '--unit=' + unit,
      '--property=PrivateUsers=yes', '--property=PrivateTmp=yes', '--', process.execPath, '--input-type=module', '-e', code], { timeout: 28_000 })
    const ownership = JSON.parse(result.stdout)
    assert.equal(ownership.uid, process.getuid()); assert.notEqual(ownership.rootUid, 0)
  } finally {
    try { await run('systemctl', ['--user', 'stop', unit]) }
    catch (error) { if (!/not loaded|not found/.test(error.stderr || '')) throw error }
  }
})

test('real systemd: a namespaced client stops a standalone runtime without a user manager', {
  skip: process.env.GELIOS_SYSTEMD_TEST !== '1', timeout: 20_000,
}, async t => {
  const f = await fixture(t, homedir()), unit = `codex-standalone-stop-${process.pid}.service`
  const app = await connectRuntime(f.options, process.env)
  const native = rpc(app); await native.call('initialize'); native.initialized()
  const closed = once(app, 'exit'); app.kill(); await closed
  await until(t, async () => !(await requestControl(runtimeSocket(f.stateDir), 'status')).attached, 'standalone client detaches')
  const bin = join(f.root, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\necho "no user manager in this client" >&2\nexit 86\n', { mode: 0o700 })
  const code = `import {stopRuntime} from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};console.log(JSON.stringify(await stopRuntime(${JSON.stringify(f.stateDir)})));`
  try {
    const result = await run('systemd-run', ['--user', '--wait', '--pipe', '--quiet', '--collect', '--service-type=exec', '--unit=' + unit,
      '--property=PrivateUsers=yes', '--property=PrivateTmp=yes', '--setenv=PATH=' + bin + ':' + process.env.PATH,
      '--', process.execPath, '--input-type=module', '-e', code], { timeout: 15_000 })
    const stopped = JSON.parse(result.stdout)
    assert.equal(stopped.appPid, app.pid); assert.equal(stopped.unit, null)
    assert.equal(existsSync(runtimeSocket(f.stateDir)), false)
  } finally {
    try { await run('systemctl', ['--user', 'stop', unit]) }
    catch (error) { if (!/not loaded|not found/.test(error.stderr || '')) throw error }
  }
})


test('real systemd: namespace coordination rejects writable code before importing outside the sandbox', {
  skip: process.env.GELIOS_SYSTEMD_TEST !== '1', timeout: 20_000,
}, async t => {
  const f = await fixture(t, homedir()), source = fileURLToPath(new URL('../', import.meta.url))
  for (const kind of ['parent', 'module']) {
    const root = join(f.root, kind), runtime = join(root, 'src/runtime.js'), marker = join(f.root, kind + '-executed')
    cpSync(source, root, { recursive: true, filter: path => path !== join(source, 'test') })
    writeFileSync(runtime, `import {statSync as probeStat,writeFileSync as probeWrite} from 'node:fs';if(probeStat('/').uid===0)probeWrite(${JSON.stringify(marker)},'imported');\n` + readFileSync(runtime, 'utf8'))
    chmodSync(kind === 'parent' ? root : runtime, kind === 'parent' ? 0o770 : 0o660)
    const unit = `codex-untrusted-${kind}-${process.pid}.service`, options = { ...f.options, systemdUnit: unit }
    const code = `import {ensureRuntime} from ${JSON.stringify(pathToFileURL(runtime).href)};await ensureRuntime(${JSON.stringify(options)},process.env);`
    try {
      await assert.rejects(run('systemd-run', ['--user', '--wait', '--pipe', '--quiet', '--collect', '--service-type=exec', '--unit=' + unit,
        '--property=PrivateUsers=yes', '--property=PrivateTmp=yes', '--', process.execPath, '--input-type=module', '-e', code], { timeout: 12_000 }), /runtime coordinator (has an untrusted parent|code is not trusted)/)
      assert.equal(existsSync(marker), false)
    } finally {
      try { await run('systemctl', ['--user', 'stop', unit]) }
      catch (error) { if (!/not loaded|not found/.test(error.stderr || '')) throw error }
    }
  }
})


test('a runtime outside a user namespace keeps full ancestor validation', { timeout: 30_000, skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t)
  mkdirSync(f.stateDir, { mode: 0o700 })
  const { directoryIdentity } = await import('../src/builds.js')
  const identity = directoryIdentity(f.stateDir)
  chmodSync(f.root, 0o770); t.after(() => chmodSync(f.root, 0o700))
  await assert.rejects(run(process.execPath, [fileURLToPath(new URL('../scripts/runtime.js', import.meta.url)),
    '--state-dir', f.stateDir, '--state-identity', identity], { timeout: 2000 }), /untrusted parent directory/)
})
