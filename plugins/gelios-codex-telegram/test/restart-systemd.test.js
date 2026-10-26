import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mkdtempSync } from './fixtures.js'
import { spawn } from './fixtures.js'
import { StateStore } from '../src/core.js'
import { requestControl } from '../src/control.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check().catch(() => false)
    if (value) return value
    await wait(20)
  }
  throw new Error('Timed out: ' + label)
}
async function terminal(path) {
  const socket = net.createConnection(path)
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
  await new Promise((resolve, reject) => socket.once('data', data => data.toString().includes('101 Switching Protocols') ? resolve() : reject(new Error('terminal handshake failed'))))
  return socket
}

test('real systemd: unsafe poll/restart cuts a turn; idle restart preserves later turns, replies and queued arrivals', {
  skip: process.env.GELIOS_SYSTEMD_TEST !== '1', timeout: 90_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'unit-restart-')), workspace = join(root, 'work'), stateDir = join(root, 'state')
  const source = fileURLToPath(new URL('../', import.meta.url)), codex = join(root, 'codex.cjs'), starter = join(root, 'start')
  const log = join(root, 'events.jsonl'), serviceLog = join(root, 'service.log'), barrier = join(root, 'hold-start')
  const unit = `codex-telegram-test-${process.pid}-${randomBytes(4).toString('hex')}.service`, unitPath = join(root, unit)
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}` }
  const manager = args => execFileSync('systemctl', ['--user', ...args], { env, encoding: 'utf8' })
  const events = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  mkdirSync(workspace)
  const store = new StateStore(stateDir), access = store.loadAccess()
  access.dmPolicy = 'allowlist'; access.users['123'] = { chatId: '123', alias: 'Operator', role: 'admin' }; store.saveAccess(access)
  store.saveBinding({ threadId: 'kept-conversation', workspace, initialize: { clientInfo: { name: 'restart-test', version: '1' } } })
  writeFileSync(join(stateDir, 'protected'), 'unchanged')
  const updates = [], delivered = []
  let heldReply, holdReply = false, verified = false
  const api = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    const params = new URLSearchParams(body), method = request.url.split('/').at(-1)
    let result = true
    if (method === 'getUpdates') { await wait(25); result = updates.filter(update => update.update_id >= Number(params.get('offset') || 0)) }
    if (method === 'sendMessage' || method === 'sendRichMessage') {
      // A reply goes out as a rich message; its text is the Markdown it carries.
      const text = method === 'sendMessage' ? params.get('text') : JSON.parse(params.get('rich_message')).markdown
      if (holdReply && text === 'reply-A') await new Promise(resolve => { heldReply = resolve })
      delivered.push({ text, at: Date.now() }); result = { message_id: delivered.length }
    }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, result }))
  })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(() => { heldReply?.(); api.closeAllConnections(); api.close() })
  // The deterministic backend records real turn starts, completions and signals.
  // It is a child in the actual control-group unit, not a service-manager mock.
  writeFileSync(codex, `#!${process.execPath}
const {appendFileSync,existsSync,readFileSync}=require('node:fs'),readline=require('node:readline')
const root=${JSON.stringify(root)},log=${JSON.stringify(log)},source=${JSON.stringify(source)}
const record=(type,data={})=>appendFileSync(log,JSON.stringify({type,...data,pid:process.pid,at:Date.now()})+'\\n')
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n')
if(process.argv.slice(2).join(' ')==='plugin list --json'){send({installed:[{name:'telegram',marketplaceName:'codex-telegram',installed:true,enabled:true,version:JSON.parse(readFileSync(source+'/package.json')).version,installedPath:source}]});process.exit()}
if(process.argv[2]!=='app-server')throw Error('unexpected command')
let active=null,completed=[];record('backend-start',{setting:process.env.TEST_UNIT_SETTING})
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),thread={id:'kept-conversation',turns:active?[{id:active,status:'inProgress'}]:completed}
 if(m.method==='initialize')send({id:m.id,result:{userAgent:'restart-fixture'}})
 else if(m.method==='thread/resume'||m.method==='thread/read')send({id:m.id,result:{thread,approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}}})
 else if(m.method==='thread/loaded/list')send({id:m.id,result:{data:['kept-conversation'],nextCursor:null}})
 else if(m.method==='turn/start'){
   const text=m.params.input.map(x=>x.text||'').join(' '),label=['unsafe','A','B','after-restart'].find(x=>text.endsWith('start-'+x))
   if(!label||active)throw Error('unexpected turn '+text)
   active=label;record('turn-start',{label});send({id:m.id,result:{turn:{id:label,status:'inProgress'}}});send({method:'turn/started',params:{threadId:'kept-conversation',turn:{id:label,status:'inProgress'}}})
 }else if(m.id)throw Error('unexpected method '+m.method)
})
setInterval(()=>{if(active&&existsSync(root+'/complete-'+active)){const label=active;active=null;completed.push({id:label,status:'completed',items:[]});record('turn-complete',{label});send({method:'turn/completed',params:{threadId:'kept-conversation',turn:{id:label,status:'completed'}}})}},10)
process.on('SIGTERM',()=>{record('terminated',{active});process.exit(0)})
`, { mode: 0o700 })
  writeFileSync(starter, `#!/bin/sh\nwhile test -f '${barrier}'; do sleep 0.05; done\nexec '${process.execPath}' '${join(source, 'scripts/bridge.js')}' "$@"\n`, { mode: 0o700 })
  const args = ['--state-dir', stateDir, '--workspace', workspace, '--codex-bin', codex, '--systemd-unit', unit]
  const quote = value => JSON.stringify(value).replaceAll('%', '%%')
  const writeUnit = setting => writeFileSync(unitPath,
    `[Service]\nType=simple\nUMask=0077\nKillMode=control-group\nRestart=on-failure\nTimeoutStopSec=5\nWorkingDirectory=${workspace}\nStandardOutput=append:${serviceLog}\nStandardError=append:${serviceLog}\nExecStart=${[starter, ...args, '--terminal-name', setting].map(quote).join(' ')}\n` +
    Object.entries({ PATH: process.env.PATH, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR, TEST_UNIT_SETTING: setting,
      GELIOS_TELEGRAM_API_BASE: `http://127.0.0.1:${api.address().port}`, TELEGRAM_BOT_TOKEN: '123:' + 'z'.repeat(32),
      GELIOS_TELEGRAM_STATE_DIR: stateDir, GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin'),
    }).map(([name, value]) => `Environment=${quote(name + '=' + value)}\n`).join(''))
  writeUnit('Original')
  t.after(() => {
    if (!verified && existsSync(serviceLog)) console.error(readFileSync(serviceLog, 'utf8').slice(-12000))
    try { manager(['stop', unit]); assert.equal(manager(['show', unit, '--property=MainPID', '--value']).trim(), '0') } finally {
      const link = join(env.XDG_RUNTIME_DIR, 'systemd/user', unit); if (existsSync(link)) unlinkSync(link)
      manager(['daemon-reload']); try { manager(['reset-failed', unit]) } catch {}
    }
    console.log(JSON.stringify({ ownedFixtureCleanupComplete: true }))
  })
  manager(['link', '--runtime', unitPath]); manager(['start', unit])
  const control = (action, args) => requestControl(join(stateDir, 'control.sock'), action, args, { timeoutMs: action === 'reply' ? 15_000 : 1000 })
  const run = argv => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(source, 'scripts/restart.js'), ...argv, '--state-dir', stateDir], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''; child.stdout.on('data', part => { out += part }); child.stderr.on('data', part => { err += part })
    child.on('error', reject); child.on('close', code => resolve({ code, out, err }))
  })
  const cli = argv => run(argv).then(({ code, out, err }) => { if (code !== 0) throw new Error(err); return JSON.parse(out) })
  const status = () => control('status')
  const start = label => { const id = updates.length + 1; updates.push({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: 123, type: 'private' }, from: { id: 123, first_name: 'Operator' }, text: 'start-' + label } }) }
  const ready = () => until(async () => { const s = await status(); return s.ready && s }, 'ready bridge')
  const first = await ready()
  if (process.env.GELIOS_RESTART_TEST_FORCE_FAILURE === '1') throw new Error('forced restart acceptance failure')
  assert.match(manager(['show', unit, '--property=KillMode', '--property=Restart']), /KillMode=control-group/)
  // Old operator sequence: idle read, then a new turn, then manager restart.
  await until(async () => (await status()).idle.idle, 'old idle observation')
  start('unsafe'); await until(async () => (await status()).turnId === 'unsafe', 'turn in old observation/restart gap')
  manager(['restart', unit])
  const second = await until(async () => { const s = await ready(); return s.pid !== first.pid && s }, 'unsafe restart')
  assert.ok(events().some(e => e.type === 'terminated' && e.active === 'unsafe'))
  assert.equal(events().some(e => e.type === 'turn-complete' && e.label === 'unsafe'), false)
  assert.equal(delivered.length, 0, 'unsafe restart cut the turn before its reply')

  // An attached terminal is reported, can time out, and can be cancelled.
  const tui = await terminal(join(stateDir, 'app-server.sock')); t.after(() => tui.destroy())
  await control('restart_request', { timeoutMs: 300 })
  assert.ok((await status()).idle.blockers.includes('tui'))
  await until(async () => (await status()).restart?.phase === 'failed', 'bounded TUI wait')
  assert.equal((await status()).pid, second.pid)
  const cancelled = await cli(['--timeout', '30s'])
  await cli(['--cancel', cancelled.id]); assert.equal((await status()).restart.phase, 'cancelled')
  tui.destroy(); await until(async () => !(await status()).tuiAttached, 'terminal detaches')

  start('A'); await until(async () => (await status()).turnId === 'A', 'first protected turn')
  const request = await cli(['--timeout', '30s'])
  assert.equal(request.phase, 'pending')
  // A second caller's waiting request joins the pending one and returns only with its final phase.
  const waiter = run(['--timeout', '30s', '--wait'])
  // Current loaded unit settings, rather than the saved launch profile, win.
  writeUnit('Changed'); manager(['daemon-reload'])
  holdReply = true
  const replyA = control('reply', { chat_id: '123', text: 'reply-A' })
  await until(async () => Boolean(heldReply), 'first reply waits for Telegram acceptance')
  writeFileSync(join(root, 'complete-A'), 'done')
  await until(async () => !(await status()).turnId, 'A completes')
  start('B'); await until(async () => (await status()).turnId === 'B', 'later turn admitted after restart request')
  assert.equal((await status()).pid, second.pid)
  await control('reply', { chat_id: '123', text: 'reply-B' })
  writeFileSync(join(root, 'complete-B'), 'done')
  await until(async () => !(await status()).turnId, 'B completes')
  const waiting = await status()
  assert.equal(waiting.pid, second.pid); assert.ok(waiting.idle.blockers.includes('replies'))
  assert.equal(waiting.restart.phase, 'pending')
  // Pause only this fixture's next ExecStart so an arrival lands during restart.
  writeFileSync(barrier, 'hold'); heldReply(); await replyA
  await until(async () => Number(manager(['show', unit, '--property=MainPID', '--value']).trim()) !== second.pid, 'systemd replaces bridge')
  assert.equal(events().some(e => e.type === 'terminated' && e.active), true, 'baseline termination recorded')
  assert.equal(events().filter(e => e.type === 'terminated' && e.active).length, 1, 'new path cuts no active turn')
  start('after-restart'); unlinkSync(barrier)
  const final = await until(async () => { const s = await status(); return s.ready && s.pid !== second.pid && s.restart?.phase === 'completed' && s }, 'restart restores original conversation')
  await until(async () => (await status()).turnId === 'after-restart', 'arrival during restart delivered')
  assert.equal(final.threadId, first.threadId); assert.equal(final.restart.id, request.id)
  const waited = await waiter
  assert.equal(waited.code, 0, waited.err)
  assert.deepEqual([JSON.parse(waited.out).id, JSON.parse(waited.out).phase], [request.id, 'completed'])
  assert.equal(readFileSync(join(stateDir, 'protected'), 'utf8'), 'unchanged')
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'launch-profile.json'))).terminalName, 'Changed')
  assert.equal(events().filter(e => e.type === 'backend-start').at(-1).setting, 'Changed')
  const safeStop = events().filter(e => e.type === 'terminated').at(-1).at
  for (const label of ['A', 'B']) {
    assert.ok(events().some(e => e.type === 'turn-complete' && e.label === label && e.at <= safeStop))
    assert.ok(delivered.find(e => e.text === 'reply-' + label).at <= safeStop, 'Telegram accepted reply before the old backend stopped')
  }
  writeFileSync(join(root, 'complete-after-restart'), 'done')
  await until(async () => (await status()).idle.idle, 'replacement idle')
  await wait(500); assert.equal((await status()).pid, final.pid, 'durable request is not submitted twice')
  assert.equal(events().filter(e => e.type === 'turn-start' && e.label === 'after-restart').length, 1)
  // A failed replacement remains visible through the command with no bridge.
  writeUnit('Unavailable')
  writeFileSync(unitPath, readFileSync(unitPath, 'utf8').replace(/^ExecStart=.*$/m, 'ExecStart=/bin/false'))
  manager(['daemon-reload']); await cli(['--timeout', '30s'])
  await until(async () => manager(['show', unit, '--property=ActiveState', '--value']).trim() === 'failed', 'failed replacement unit')
  let offline
  try { execFileSync(process.execPath, [join(source, 'scripts/status.js')], { env: { ...env, GELIOS_TELEGRAM_STATE_DIR: stateDir }, encoding: 'utf8' }); assert.fail('offline status must fail') }
  catch (error) { assert.equal(error.status, 1); offline = JSON.parse(error.stdout) }
  assert.equal(offline.available, false); assert.equal(offline.restart.phase, 'failed'); assert.match(offline.restart.reason, /systemd start failed/)
  verified = true
})
