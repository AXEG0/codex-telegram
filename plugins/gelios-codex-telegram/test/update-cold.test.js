import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mkdtempSync } from './fixtures.js'
import { controlRequest, runUpdate } from '../scripts/update.js'
import { processInfo } from '../src/core.js'
import { runtimeSocket, stopRuntime } from '../src/runtime.js'
import { appServerFolder } from './support/app-server.js'
import { cleanup, until } from './support/wait.js'

for (const heldMethod of ['initialize', 'thread/resume', null]) {
test(heldMethod ? `a real stopped bridge acknowledges before held ${heldMethod}, then the combined updater preserves its saved conversation`
  : 'a real unbound bridge reaches the existing idle refusal and keeps its native process', { timeout: 90_000 }, async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cold-')), stateDir = join(root, 's'), workspace = join(root, 'w')
  const old = join(root, 'o'), candidate = join(root, 'n'), tools = join(root, 'tools'), prefix = join(root, 'p')
  const native = join(root, 'native'), codexBin = join(native, 'bin/codex'), launcherLink = join(root, 'bin/gelios-codex-telegram')
  const installerRoot = join(prefix, 'lib/node_modules/@axeg0/codex-telegram'), marketplace = join(root, 'marketplace')
  const held = join(root, 'held'), calls = join(root, 'rpc.jsonl'), version = join(root, 'native-version')
  const obsolete = join(stateDir, 'update-transactions', 'd'.repeat(32))
  for (const path of [stateDir, workspace, tools, dirname(codexBin), dirname(launcherLink), installerRoot, join(prefix, 'bin'), marketplace, obsolete]) mkdirSync(path, { recursive: true, mode: 0o700 })
  const source = fileURLToPath(new URL('../', import.meta.url))
  cpSync(source, old, { recursive: true }); cpSync(source, candidate, { recursive: true })
  const release = JSON.parse(readFileSync(join(source, 'package.json'))).version
  for (const path of ['package.json', '.codex-plugin/plugin.json']) {
    const manifest = JSON.parse(readFileSync(join(old, path))); manifest.version = '0.4.0-test-old'; writeFileSync(join(old, path), JSON.stringify(manifest))
  }
  const launcher = { name: '@axeg0/codex-telegram', version: '0.4.0-test-old', bin: { 'codex-telegram': 'launcher.js' } }
  writeFileSync(join(installerRoot, 'package.json'), JSON.stringify(launcher)); writeFileSync(join(installerRoot, 'launcher.js'), 'old launcher', { mode: 0o700 })
  symlinkSync(join(installerRoot, 'launcher.js'), join(prefix, 'bin/codex-telegram'))
  writeFileSync(join(marketplace, 'package.json'), JSON.stringify({ ...launcher, version: release }))
  writeFileSync(join(native, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, version: '0.167.0', entrypoint: 'bin/codex' }))
  writeFileSync(version, '0.167.0')
  writeFileSync(codexBin, `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2),out=x=>console.log(JSON.stringify(x));
if(a[0]==='--version') console.log('codex-cli '+fs.readFileSync(${JSON.stringify(version)},'utf8'));
else if(a[0]==='update') fs.writeFileSync(${JSON.stringify(version)},'0.168.0');
else if(a.join(' ')==='plugin list --json') out({installed:[{name:'telegram',marketplaceName:'codex-telegram',version:${JSON.stringify(release)},installed:true,enabled:true,installedPath:${JSON.stringify(candidate)}}]});
else if(a.join(' ')==='plugin marketplace list --json') out({marketplaces:[{name:'codex-telegram',root:${JSON.stringify(marketplace)}}]});
else if(a[0]==='plugin'&&a[1]==='marketplace'&&a[2]==='upgrade') out({errors:[],selectedMarketplaces:['codex-telegram'],upgradedRoots:[${JSON.stringify(marketplace)}]});
else if(a[0]==='plugin'&&a[1]==='add') out({name:'telegram',marketplaceName:'codex-telegram',version:${JSON.stringify(release)},installedPath:${JSON.stringify(candidate)}});
else if(a[0]==='app-server') {
 const send=(id,result)=>out({id,result}),thread={id:'saved-cold-thread',status:{type:'idle'},turns:[]};
 const hold=async method=>{if(method!==${JSON.stringify(heldMethod)}||fs.existsSync(${JSON.stringify(held)}))return;fs.writeFileSync(${JSON.stringify(held)},method);while(fs.existsSync(${JSON.stringify(obsolete)}))await new Promise(r=>setTimeout(r,10));};
 require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
  const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},line+'\\n');if(m.id===undefined)return;
  if(m.method==='initialize') {await hold(m.method);send(m.id,{userAgent:'owned-cold-fixture'});}
  else if(m.method==='thread/resume') {
   await hold(m.method);
   send(m.id,{thread,approvalPolicy:'never',sandbox:{type:'dangerFullAccess'},activePermissionProfile:{id:':danger-full-access'}});
  } else if(m.method==='thread/read')send(m.id,{thread});
  else if(m.method==='thread/loaded/list')send(m.id,{data:[thread.id],nextCursor:null});
  else if(['skills/list','config/mcpServer/reload'].includes(m.method))send(m.id,{});
  else {console.error('unexpected RPC '+m.method);process.exitCode=1;send(m.id,{});}
 });
} else {console.error('unexpected CLI '+a.join(' '));process.exitCode=1;}
`, { mode: 0o700 })
  writeFileSync(join(tools, 'npm'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);
if(a[0]==='pack'){const dir=a[a.indexOf('--pack-destination')+1];fs.writeFileSync(path.join(dir,'launcher.tgz'),'fixture');console.log(JSON.stringify([{filename:'launcher.tgz'}]));}
else if(a[0]==='install'){fs.writeFileSync(${JSON.stringify(join(installerRoot, 'package.json'))},${JSON.stringify(JSON.stringify({ ...launcher, version: release }))});fs.writeFileSync(${JSON.stringify(join(installerRoot, 'launcher.js'))},'new launcher');}
else process.exitCode=1;
`, { mode: 0o700 })
  symlinkSync(join(old, 'bin/gelios-codex-telegram'), launcherLink)
  const profile = { version: 1, cwd: workspace, stateDir, socket: join(stateDir, 'app.sock'), controlSocket: join(stateDir, 'control.sock'),
    codexBin, workspace, terminalName: 'Fixture', bridgeArgs: [], transcriptionApiKeyEnv: null, marketplaceAuthEnv: null, codexRuntimeEnvs: [], launcherLink }
  profile.bridgeArgs = ['--state-dir', stateDir, '--socket', profile.socket, '--control-socket', profile.controlSocket, '--workspace', workspace, '--codex-bin', codexBin, '--terminal-name', profile.terminalName]
  writeFileSync(join(stateDir, 'launch-profile.json'), JSON.stringify(profile), { mode: 0o600 })
  if (heldMethod) writeFileSync(join(stateDir, 'binding.json'), JSON.stringify({ version: 1, threadId: 'saved-cold-thread', workspace, initialize: { clientInfo: { name: 'cold-fixture', version: '1' }, capabilities: { experimentalApi: true } } }), { mode: 0o600 })
  const beforeRestoration = []
  cleanup(t, 'the cold fixture bridge and runtime', async hook => {
    rmSync(obsolete, { recursive: true, force: true })
    try {
      const status = await controlRequest(profile.controlSocket, { action: 'status' })
      await controlRequest(profile.controlSocket, { action: 'shutdown_instance', instanceId: status.instanceId })
      await until(hook, () => !processInfo(status.pid), 'the fixture bridge to stop')
    } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error }
    if (existsSync(runtimeSocket(stateDir))) await stopRuntime(stateDir)
  }, { timeout: 30_000 })
  const servers = appServerFolder(t, { what: 'the cold fixture native processes' })
  const env = servers.env({ HOME: root, PATH: `${tools}:${process.env.PATH}`, GELIOS_TELEGRAM_LAUNCHER_DIR: dirname(launcherLink), NODE_DISABLE_COMPILE_CACHE: '1' })
  const update = runUpdate({ stateDir, all: true, installerRoot, env }, {
    control: async (path, request, timeout) => {
      const value = await controlRequest(path, request, timeout)
      if (request.action === 'status' && !value.ready && existsSync(obsolete)) beforeRestoration.push(value.threadId)
      return value
    }, write: () => {},
  })
  if (!heldMethod) {
    await assert.rejects(update, error => error.code === 'UPDATE_BUSY')
    const unbound = await controlRequest(profile.controlSocket, { action: 'status' })
    assert.equal(unbound.appRunning, true); assert.equal(unbound.ready, false); assert.equal(unbound.threadId, null)
    assert.equal(readFileSync(version, 'utf8'), '0.167.0', 'the real idle gate refused before the native update')
    assert.equal(existsSync(join(stateDir, 'update-transaction.json')), false)
    return
  }
  let result
  await assert.doesNotReject(async () => { result = await update })
  assert.equal(result.updated, true)
  assert.equal(result.codexVersion, 'codex-cli 0.168.0')
  assert.ok(beforeRestoration.length, 'a real start receipt/status preceded asynchronous restoration')
  if (heldMethod === 'initialize') assert.ok(beforeRestoration.includes(null), 'the first receipt precedes assignment of the saved thread')
  assert.equal(existsSync(held), true)
  const after = await controlRequest(profile.controlSocket, { action: 'status' })
  assert.equal(after.ready, true); assert.equal(after.threadId, 'saved-cold-thread'); assert.equal(after.workspace, workspace)
  assert.ok(readFileSync(calls, 'utf8').includes('thread/resume'))
  assert.equal(existsSync(join(stateDir, 'update-transaction.json')), false)
  assert.deepEqual(readdirSync(join(stateDir, 'update-transactions')), [])
})
}
