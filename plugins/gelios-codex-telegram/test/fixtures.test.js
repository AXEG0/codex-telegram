import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { mkdtempSync } from './fixtures.js'

const helper = fileURLToPath(new URL('./fixtures.js', import.meta.url))
const runner = fileURLToPath(new URL('./support/run-tests.js', import.meta.url))
const bootstrap = fileURLToPath(new URL('../src/bootstrap.js', import.meta.url))
function environment(directory) {
  const env = { ...process.env, TMPDIR: directory }
  delete env.NODE_TEST_CONTEXT
  return env
}

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
