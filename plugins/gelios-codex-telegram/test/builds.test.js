import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mkdtempSync, spawn } from './fixtures.js'
import { pruneBuilds } from '../src/builds.js'

const builds = new URL('../src/builds.js', import.meta.url).href
const bootstrap = new URL('../src/bootstrap.js', import.meta.url).href

test('launcher bootstrap uses the default state directory without a second build store', () => {
  const home = mkdtempSync(join(tmpdir(), 'default-builds-')), bin = join(home, '.local/bin')
  const env = { ...process.env, HOME: home, GELIOS_TELEGRAM_LAUNCHER_DIR: bin }
  delete env.GELIOS_TELEGRAM_STATE_DIR
  const root = execFileSync(process.execPath, ['--input-type=module', '-e', `import {installLaunchers} from ${JSON.stringify(bootstrap)};console.log(installLaunchers().root)`], { env, encoding: 'utf8' }).trim()
  assert.ok(root.startsWith(join(home, '.local/state/gelios-codex-telegram/runtime-builds/')))
  assert.equal(existsSync(join(bin, '.codex-telegram')), false)
})

test('build collection keeps committed, running, live consumers and journal snapshots; dead leases expire', async t => {
  const root = mkdtempSync(join(tmpdir(), 'collect-builds-')), state = join(root, 'state')
  const pin = (name, live = false) => {
    const source = join(root, name); mkdirSync(source); writeFileSync(join(source, 'value'), name)
    const code = `import {pinBuild} from ${JSON.stringify(builds)};console.log(JSON.stringify(pinBuild(${JSON.stringify(source)},${JSON.stringify(state)})));${live ? 'setInterval(()=>{},1000)' : ''}`
    return live ? spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] }) : JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }))
  }
  const committed = pin('committed'), running = pin('running'), snapshot = pin('snapshot'), stale = pin('stale')
  const consumer = pin('consumer', true)
  t.after(() => consumer.kill())
  const active = JSON.parse(await new Promise((resolve, reject) => { consumer.stdout.once('data', data => resolve(data.toString())); consumer.once('error', reject) }))
  writeFileSync(join(state, 'update-transaction.json'), JSON.stringify({ snapshot: { root: snapshot.root } }))
  pruneBuilds(state, [committed.root, running.root])
  for (const build of [committed, running, snapshot, active]) assert.equal(existsSync(build.root), true)
  assert.equal(existsSync(stale.root), false)
  const exited = new Promise(resolve => consumer.once('exit', resolve)); consumer.kill(); await exited
  pruneBuilds(state, [committed.root, running.root])
  assert.equal(existsSync(active.root), false)
  assert.equal(readFileSync(join(snapshot.root, 'value'), 'utf8'), 'snapshot')
})


test('a host-validated directory anchor keeps identity, ownership and descendant checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'anchored-builds-'))
  const code = `import assert from 'node:assert/strict';import {mkdirSync,writeFileSync,chmodSync,renameSync} from 'node:fs';
    import {join} from 'node:path';import {anchorDirectory,directoryIdentity,trustedDirectory,trustedFile} from ${JSON.stringify(builds)};
    const root=${JSON.stringify(root)},state=join(root,'state'),child=join(state,'child'),outside=join(root,'outside');
    mkdirSync(state,{mode:0o700});mkdirSync(child,{mode:0o700});mkdirSync(outside,{mode:0o700});mkdirSync(join(outside,'nested'),{mode:0o700});
    trustedDirectory(state,'host state');const identity=directoryIdentity(state);
    assert.throws(()=>anchorDirectory(state,'wrong'),/identity or ownership/);
    anchorDirectory(state,identity);assert.equal(trustedDirectory(child,'child'),child);
    writeFileSync(join(child,'file'),'trusted',{mode:0o600});trustedFile(join(child,'file'),'file',{root:state});
    chmodSync(child,0o770);assert.throws(()=>trustedDirectory(child,'child'),/trusted directory/);chmodSync(child,0o700);
    chmodSync(outside,0o770);assert.throws(()=>trustedDirectory(join(outside,'nested'),'outside'),/untrusted parent directory/);
    assert.throws(()=>trustedFile(join(root,'outside'),'escape',{root:state}),/escapes/);
    chmodSync(state,0o770);assert.throws(()=>trustedDirectory(child,'child'),/identity or ownership/);chmodSync(state,0o700);
    renameSync(state,state+'-previous');mkdirSync(state,{mode:0o700});assert.throws(()=>trustedDirectory(state,'replaced'),/identity or ownership/);`
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
})
