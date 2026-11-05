import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mkdtempSync } from './fixtures.js'
import { assertMigrationSafe, assertMigrationStopped } from '../src/migration.js'
import { inheritedPolicy } from '../src/runtime-policy.js'
import { processInfo } from '../src/core.js'
import { until } from './support/wait.js'

test('every live embedded runtime refuses first migration; an independent owner permits messaging replacement', () => {
  for (const status of [{ pid: 10 }, { pid: 11, appRunning: true, turnId: null }, { pid: 12, appRunning: true, turnId: 'busy' }])
    assert.throws(() => assertMigrationSafe(status), /Finish its jobs.*stop its bridge service/)
  assert.doesNotThrow(() => assertMigrationSafe({ runtime: { instanceId: 'persistent' } }))
  assert.doesNotThrow(() => assertMigrationSafe(null))
})

test('a missing control socket does not bypass the live poller identity check', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'migration-owner-'))
  writeFileSync(join(stateDir, 'poller.lock'), JSON.stringify({ pid: process.pid, startTime: processInfo(process.pid).identity }))
  await assert.rejects(assertMigrationStopped({ stateDir }), /explicit stop/)
  writeFileSync(join(stateDir, 'poller.lock'), JSON.stringify({ pid: process.pid, startTime: 'reused' }))
  await assertMigrationStopped({ stateDir })
})

test('first migration requires an inactive service and no remaining cgroup process', async () => {
  const profile = { stateDir: mkdtempSync(join(tmpdir(), 'migration-service-')), systemdUnit: 'old.service' }
  for (const state of ['active', 'activating', 'deactivating', 'reloading', 'unknown'])
    await assert.rejects(assertMigrationStopped(profile, { run: async () => ({ code: 0, output: state }) }), /explicit stop/)
  const deps = { platform: 'linux', run: async () => ({ code: 0, output: 'inactive' }), list: () => ['20'], read: path => path.endsWith('/cgroup') ? '0::/user.slice/old.service/nested' : '20 (helper-or-job) S 1' }
  await assert.rejects(assertMigrationStopped(profile, deps), /explicit stop/)
  deps.list = () => []
  await assertMigrationStopped(profile, deps)
})

test('runtime policy retains complete execution settings and resets but no environment or lifecycle commands', () => {
  const policy = inheritedPolicy('[Unit]\nDescription=Bridge\n[Service]\nMemoryMax=64M\nCPUQuota=25%\nLimitNOFILE=1024\nPrivateTmp=yes\nNice=5\nReadOnlyPaths=/one\nReadOnlyPaths=\nReadOnlyPaths=/two\\\n /three\nEnvironment=TOKEN=private-secret\nLoadCredential=secret:/private\nExecStart=/private/launcher\nRestart=always\nRuntimeMaxSec=2\nRuntimeRandomizedExtraSec=3\n')
  for (const setting of ['MemoryMax=64M', 'CPUQuota=25%', 'LimitNOFILE=1024', 'PrivateTmp=yes', 'Nice=5', 'ReadOnlyPaths=/one\nReadOnlyPaths=\nReadOnlyPaths=/two /three']) assert.ok(policy.includes(setting), policy)
  assert.doesNotMatch(policy, /private|TOKEN|Environment|LoadCredential|ExecStart|Restart=|RuntimeMaxSec|RuntimeRandomizedExtraSec|Description=/)
  assert.throws(() => inheritedPolicy('[Service]\nReadWritePaths=/var/lib/%n\n'), /unit-specific/)
})

test('real systemd: candidate validation and the installed updater retain work owned by an embedded runtime', {
  skip: process.env.GELIOS_SYSTEMD_TEST !== '1', timeout: 30_000,
}, async t => {
  const { execFile } = await import('./fixtures.js'), { promisify } = await import('node:util')
  const { mkdirSync, existsSync } = await import('node:fs'), net = await import('node:net')
  const { fileURLToPath } = await import('node:url'), { processInfo } = await import('../src/core.js')
  const { parseArgs, profileFor } = await import('../scripts/bridge.js'), { runUpdate } = await import('../scripts/update.js')
  const run = promisify(execFile), source = fileURLToPath(new URL('../', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'embedded-unit-')), state = join(root, 'state'), codexBin = join(root, 'codex')
  mkdirSync(state, { mode: 0o700 })
  writeFileSync(codexBin, '#!/bin/sh\nexit 64\n', { mode: 0o700 })
  const unit = `codex-embedded-test-${process.pid}.service`, script = join(root, 'old.cjs'), pids = join(root, 'pids')
  const release = join(root, 'release'), done = join(root, 'done')
  const job = `const f=require('node:fs');const timer=setInterval(()=>{if(f.existsSync(${JSON.stringify(release)})){f.writeFileSync(${JSON.stringify(done)},'finished');clearInterval(timer)}else{try{process.kill(${process.pid},0)}catch{process.exit(2)}}},20)`
  writeFileSync(script, `const {spawn}=require('node:child_process'),f=require('node:fs');const app=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});const job=spawn(process.execPath,['-e',${JSON.stringify(job)}],{detached:true,stdio:'ignore'});job.unref();f.writeFileSync(${JSON.stringify(pids)},JSON.stringify({pid:process.pid,appPid:app.pid,jobPid:job.pid}));setInterval(()=>{},1000)\n`)
  t.after(async () => {
    writeFileSync(release, 'finish')
    try { await run('systemctl', ['--user', 'stop', unit]) }
    catch (error) { if (!/not loaded|not found/.test(error.stderr || '')) throw error }
  })
  await run('systemd-run', ['--user', '--collect', '--service-type=exec', '--unit=' + unit, '--property=KillMode=control-group', '--', process.execPath, script])
  // The unit creates its file before it writes it, so the wait reads the content.
  const receipt = await until(t, () => { const text = existsSync(pids) && readFileSync(pids, 'utf8'); return text && JSON.parse(text) }, 'the embedded unit to record its processes'), status = { ...receipt, identity: processInfo(receipt.pid).identity, instanceId: 'a'.repeat(32), pluginRoot: source, ready: true, appRunning: true }
  const options = parseArgs(['--state-dir', state, '--workspace', root, '--codex-bin', codexBin, '--systemd-unit', unit])
  const profile = { ...profileFor(options), launcherLink: join(root, 'launcher') }
  symlinkSync(join(source, 'bin/gelios-codex-telegram'), profile.launcherLink)
  writeFileSync(join(state, 'launch-profile.json'), JSON.stringify(profile), { mode: 0o600 })
  const server = net.createServer(socket => socket.once('data', () => socket.end(JSON.stringify({ ok: true, result: status }) + '\n')))
  await new Promise(resolve => server.listen(profile.controlSocket, resolve)); t.after(() => server.listening && new Promise(resolve => server.close(resolve)))
  const input = JSON.stringify({ result: { name: 'telegram', marketplaceName: 'codex-telegram', installedPath: source }, pluginName: 'telegram', marketplaceName: 'codex-telegram', stateDir: state })
  await assert.rejects(run(process.execPath, [join(source, 'scripts/update.js'), '--validate-candidate', input]), /explicit stop of the embedded Codex runtime/)
  let discovery = false
  await assert.rejects(runUpdate({ stateDir: state, installed: true, env: { ...process.env, GELIOS_CODEX_CHILD: '' } }, { run: async () => { discovery = true; throw new Error('must not stage') } }), /explicit stop of the embedded Codex runtime/)
  assert.equal(discovery, false)
  assert.equal(processInfo(receipt.pid)?.identity, status.identity)
  process.kill(receipt.jobPid, 0)
  // The job creates its file before it writes it, so the wait reads the content.
  writeFileSync(release, 'finish'); await until(t, () => existsSync(done) && readFileSync(done, 'utf8'), 'the owned job to reach its own end')
  await until(t, () => { try { return !readFileSync(`/proc/${receipt.jobPid}/cmdline`).length } catch { return true } }, 'the owned job to exit')
  await assert.rejects(run(process.execPath, [join(source, 'scripts/update.js'), '--validate-candidate', input]), /explicit stop of the embedded Codex runtime/)
  await run('systemctl', ['--user', 'stop', unit])
  await new Promise(resolve => server.close(resolve))
  const accepted = JSON.parse((await run(process.execPath, [join(source, 'scripts/update.js'), '--validate-candidate', input])).stdout)
  assert.equal(accepted.runtimeProtocol, 1)
  assert.equal(readFileSync(done, 'utf8'), 'finished')
})
