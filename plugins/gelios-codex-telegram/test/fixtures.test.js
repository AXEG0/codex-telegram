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
