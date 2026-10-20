import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { liveGroupMembers, mkdtempSync, spawn, stopGroup } from './fixtures.js'

test('cleanup distinguishes an exited group from a genuine signalling denial', async () => {
  let probes = 0
  await stopGroup(7, { readMembers: () => ++probes === 1 ? [8] : [], kill: () => { throw Object.assign(new Error('exited during signal'), { code: 'EPERM' }) } })
  await assert.rejects(stopGroup(7, { readMembers: () => [8], kill: () => { throw Object.assign(new Error('live permission denial'), { code: 'EPERM' }) } }), /live permission denial/)
})

const compiler = spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0
test('a real zombie-only process group needs no signal or fixture-retention delay', { skip: compiler ? false : 'requires a C compiler', timeout: 10_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-zombie-')), source = join(root, 'zombie.c'), binary = join(root, 'zombie')
  writeFileSync(source, `#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>
int main(void) {
  pid_t child = fork(); if (child < 0) return 1;
  if (!child) { if (setsid() < 0) _exit(2); _exit(0); }
  printf("%d\\n", child); fflush(stdout);
  char done; read(0, &done, 1); return waitpid(child, 0, 0) < 0;
}
`)
  execFileSync('cc', [source, '-o', binary])
  const parent = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] })
  t.after(() => { if (!parent.stdin.writableEnded) parent.stdin.end('done') })
  const pid = Number(String((await once(parent.stdout, 'data'))[0]).trim())
  let zombie = false
  for (let n = 0; n < 200; n++) {
    const state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    if (state.startsWith('Z')) { zombie = true; break }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(zombie, true)
  if (process.platform === 'darwin') assert.throws(() => process.kill(-pid, 'SIGTERM'), error => {
    t.diagnostic('zombie-only group signal result: ' + error.code)
    return ['EPERM', 'ESRCH'].includes(error.code)
  })
  assert.deepEqual(liveGroupMembers(pid), [])
  await stopGroup(pid, { kill: () => assert.fail('an exited process must never be signalled') })
  const exited = once(parent, 'exit'); parent.stdin.end('done'); await exited
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
})

const helper = fileURLToPath(new URL('./fixtures.js', import.meta.url))
const runner = fileURLToPath(new URL('./support/run-tests.js', import.meta.url))
const bootstrap = fileURLToPath(new URL('../src/bootstrap.js', import.meta.url))
function environment(directory) {
  const env = { ...process.env, TMPDIR: directory }
  delete env.NODE_TEST_CONTEXT
  return env
}

test('a failed spawn owns no process group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-spawn-error-'))
  const child = spawn(join(root, 'missing-command'), [], { stdio: 'ignore' })
  const closed = new Promise(resolve => child.once('close', resolve))
  const [error] = await once(child, 'error')
  assert.equal(error.code, 'ENOENT')
  await closed
})

test('failed tests clean owned fixtures and stubborn children without deleting other files', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-failure-proof-'))
  const temporary = join(root, 'temporary'), sentinel = join(root, 'unrelated.txt'), pidFile = join(root, 'pid')
  mkdirSync(temporary); writeFileSync(sentinel, 'keep')
  const source = join(root, 'failure.test.mjs')
  writeFileSync(source, `import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { mkdtempSync, spawn } from ${JSON.stringify(helper)}
test('intentional failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'owned-'))
  writeFileSync(join(directory, 'data'), 'fixture')
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
  await once(child.stdout, 'data')
  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
  assert.fail('intentional failure')
})
`)
  const result = spawnSync(process.execPath, ['--test', source], { env: environment(temporary), encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.deepEqual(readdirSync(temporary), [])
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
})

test('cleanup stops an orphaned background writer before removing its fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-descendant-proof-'))
  const temporary = join(root, 'temporary'), pidFile = join(root, 'pid'), source = join(root, 'orphan.test.mjs')
  mkdirSync(temporary)
  const writer = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{try{fs.writeFileSync(process.argv[1],'writing')}catch{}},1)`
  const leader = `const{spawn}=require('node:child_process'),fs=require('node:fs');spawn(process.execPath,['-e',${JSON.stringify(writer)},process.argv[1]],{stdio:'ignore'});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);process.exit(0)}},5)`
  writeFileSync(source, `import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { mkdtempSync, spawn } from ${JSON.stringify(helper)}
test('intentional failure after the leader exits', async () => {
  const directory=mkdtempSync(join(tmpdir(),'owned-'))
  const child=spawn(process.execPath,['-e',${JSON.stringify(leader)},join(directory,'data')],{stdio:'ignore'})
  await once(child,'exit')
  assert.fail('intentional failure')
})
`)
  const result = spawnSync(process.execPath, ['--test', source], { env: environment(temporary), encoding: 'utf8', timeout: 10000 })
  const pid = Number(readFileSync(pidFile, 'utf8'))
  try {
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /intentional failure/)
    assert.deepEqual(readdirSync(temporary), [])
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
  } finally { try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
})

test('the test runner rejects and names fixtures left by a successful child', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-runner-proof-'))
  const source = join(root, 'leaking.test.mjs')
  writeFileSync(source, `import test from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
test('leak', () => writeFileSync(join(tmpdir(), 'leftover.txt'), 'data'))
`)
  const result = spawnSync(process.execPath, [runner, source], { env: environment(root), encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /Test run left temporary entries/)
  assert.match(result.stderr, /leftover\.txt/)
  assert.equal(existsSync(source), true)
})

test('unscoped MCP bootstrap stays inside the runner and fails its leak check', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-launcher-proof-'))
  const outside = join(root, 'outside-bin'), source = join(root, 'bootstrap.test.mjs')
  mkdirSync(outside); writeFileSync(join(outside, 'sentinel'), 'keep')
  writeFileSync(source, `import test from 'node:test'
import { installLaunchers } from ${JSON.stringify(bootstrap)}
test('unscoped bootstrap', () => installLaunchers())
`)
  const result = spawnSync(process.execPath, [runner, source], {
    env: { ...environment(root), GELIOS_TELEGRAM_LAUNCHER_DIR: outside }, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /unclaimed-launchers/)
  assert.deepEqual(readdirSync(outside), ['sentinel'])
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'keep')
})
