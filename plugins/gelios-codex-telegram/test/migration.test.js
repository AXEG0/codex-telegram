import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mkdtempSync } from './fixtures.js'
import { assertMigrationSafe, migrationJobs } from '../src/migration.js'
import { inheritedPolicy } from '../src/runtime-policy.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'migration-processes-'))
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { telegram: { command: 'node', args: ['-e', 'exact shipped entry'] } } }))
  const status = { pid: 10, identity: '100', appPid: 11 }, profile = { systemdUnit: 'bridge.service' }
  const processes = new Map([
    [10, { ppid: 1, pgid: 10, identity: '100', name: 'bridge' }],
    [11, { ppid: 10, pgid: 10, identity: '101', name: 'codex' }],
    [12, { ppid: 11, pgid: 12, identity: '102', name: 'node' }],
    [20, { ppid: 1, pgid: 20, identity: '120', name: 'detached-work' }],
    [21, { ppid: 11, pgid: 10, identity: '121', name: 'nohup-work' }],
  ])
  const deps = { platform: 'linux', info: pid => processes.get(pid), members: () => [11, 21], list: () => [...processes.keys()].map(String), read: (path, encoding) => {
    const pid = Number(path.split('/')[2])
    if (path.endsWith('/cgroup')) return '0::/user.slice/bridge.service' + (pid === 20 ? '/nested' : '') + '\n'
    if (path.endsWith('/cmdline')) return Buffer.from(pid === 12 ? '/usr/bin/node\0-e\0exact shipped entry\0' : '/usr/bin/work\0')
    if (path.endsWith('/stat')) return pid + ' (work) S 1'
    return readFileSync(path, encoding)
  } }
  return { status, profile, root, processes, deps }
}

test('first migration retains detached, reparented, nested-cgroup and same-group work', () => {
  const f = fixture()
  assert.deepEqual(migrationJobs(f.status, f.profile, f.root, f.deps).map(job => job.pid), [20, 21])
  assert.throws(() => assertMigrationSafe(f.status, f.profile, f.root, f.deps), /20 \(detached-work\).*21 \(nohup-work\)/)
  f.processes.delete(20); f.processes.delete(21)
  assert.doesNotThrow(() => assertMigrationSafe(f.status, f.profile, f.root, f.deps))
})

test('a changed embedded-runtime identity fails closed', () => {
  const f = fixture(); f.status.identity = 'reused'
  assert.throws(() => assertMigrationSafe(f.status, f.profile, f.root, f.deps), /cannot verify/)
})

test('the independent runtime permits messaging replacement while its work continues', () => {
  const f = fixture(); f.status.runtime = { instanceId: 'persistent' }
  assert.deepEqual(migrationJobs(f.status, f.profile, f.root, f.deps), [])
})

test('runtime policy retains complete execution settings and resets but no environment or lifecycle commands', () => {
  const policy = inheritedPolicy('[Unit]\nDescription=Bridge\n[Service]\nMemoryMax=64M\nCPUQuota=25%\nLimitNOFILE=1024\nPrivateTmp=yes\nNice=5\nReadOnlyPaths=/one\nReadOnlyPaths=\nReadOnlyPaths=/two\\\n /three\nEnvironment=TOKEN=private-secret\nLoadCredential=secret:/private\nExecStart=/private/launcher\nRestart=always\n')
  for (const setting of ['MemoryMax=64M', 'CPUQuota=25%', 'LimitNOFILE=1024', 'PrivateTmp=yes', 'Nice=5', 'ReadOnlyPaths=/one\nReadOnlyPaths=\nReadOnlyPaths=/two /three']) assert.ok(policy.includes(setting), policy)
  assert.doesNotMatch(policy, /private|TOKEN|Environment|LoadCredential|ExecStart|Restart=|Description=/)
  assert.throws(() => inheritedPolicy('[Service]\nReadWritePaths=/var/lib/%n\n'), /unit-specific/)
})

test('real systemd: candidate validation and the installed updater retain work owned by an embedded runtime', {
  skip: process.env.GELIOS_SYSTEMD_TEST !== '1', timeout: 30_000,
}, async t => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util')
  const { mkdirSync, existsSync } = await import('node:fs'), net = await import('node:net')
  const { fileURLToPath } = await import('node:url'), { processInfo } = await import('../src/core.js')
  const { parseArgs, profileFor } = await import('../scripts/bridge.js'), { runUpdate } = await import('../scripts/update.js')
  const run = promisify(execFile), source = fileURLToPath(new URL('../', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'embedded-unit-')), state = join(root, 'state')
  mkdirSync(state, { mode: 0o700 })
  const unit = `codex-embedded-test-${process.pid}.service`, script = join(root, 'old.cjs'), pids = join(root, 'pids')
  const release = join(root, 'release'), done = join(root, 'done')
  const job = `const f=require('node:fs'),start=Date.now();const timer=setInterval(()=>{if(f.existsSync(${JSON.stringify(release)})){f.writeFileSync(${JSON.stringify(done)},'finished');clearInterval(timer)}else if(Date.now()-start>20000)process.exit(2)},20)`
  writeFileSync(script, `const {spawn}=require('node:child_process'),f=require('node:fs');const app=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});const job=spawn(process.execPath,['-e',${JSON.stringify(job)}],{detached:true,stdio:'ignore'});job.unref();f.writeFileSync(${JSON.stringify(pids)},JSON.stringify({pid:process.pid,appPid:app.pid,jobPid:job.pid}));setInterval(()=>{},1000)\n`)
  t.after(async () => { writeFileSync(release, 'finish'); await run('systemctl', ['--user', 'stop', unit]) })
  await run('systemd-run', ['--user', '--collect', '--service-type=exec', '--unit=' + unit, '--property=KillMode=control-group', '--', process.execPath, script])
  const until = async check => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('fixture deadline'); await new Promise(resolve => setTimeout(resolve, 10)) } }
  await until(() => existsSync(pids))
  const receipt = JSON.parse(readFileSync(pids)), status = { ...receipt, identity: processInfo(receipt.pid).identity, instanceId: 'a'.repeat(32), pluginRoot: source, ready: true, appRunning: true }
  const options = parseArgs(['--state-dir', state, '--workspace', root, '--codex-bin', process.execPath, '--systemd-unit', unit])
  const profile = { ...profileFor(options), launcherLink: join(root, 'launcher') }
  symlinkSync(join(source, 'bin/gelios-codex-telegram'), profile.launcherLink)
  writeFileSync(join(state, 'launch-profile.json'), JSON.stringify(profile), { mode: 0o600 })
  const server = net.createServer(socket => socket.once('data', () => socket.end(JSON.stringify({ ok: true, result: status }) + '\n')))
  await new Promise(resolve => server.listen(profile.controlSocket, resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const input = JSON.stringify({ result: { name: 'telegram', marketplaceName: 'codex-telegram', installedPath: source }, pluginName: 'telegram', marketplaceName: 'codex-telegram', stateDir: state })
  await assert.rejects(run(process.execPath, [join(source, 'scripts/update.js'), '--validate-candidate', input]), /migration is waiting for owned processes/)
  let discovery = false
  await assert.rejects(runUpdate({ stateDir: state, installed: true, env: { ...process.env, GELIOS_CODEX_CHILD: '' } }, { run: async () => { discovery = true; throw new Error('must not stage') } }), /migration is waiting for owned processes/)
  assert.equal(discovery, false)
  assert.equal(processInfo(receipt.pid)?.identity, status.identity)
  process.kill(receipt.jobPid, 0)
  writeFileSync(release, 'finish'); await until(() => existsSync(done))
  await until(() => { try { return !readFileSync(`/proc/${receipt.jobPid}/cmdline`).length } catch { return true } })
  const accepted = JSON.parse((await run(process.execPath, [join(source, 'scripts/update.js'), '--validate-candidate', input])).stdout)
  assert.equal(accepted.runtimeProtocol, 1)
  assert.equal(readFileSync(done, 'utf8'), 'finished')
})
