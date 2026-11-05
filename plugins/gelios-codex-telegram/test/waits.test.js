import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync } from './fixtures.js'
import { checkFolder, checkSource } from './support/check-waits.js'
import { notYetThere, until } from './support/wait.js'

const folder = fileURLToPath(new URL('.', import.meta.url))
const helper = pathToFileURL(fileURLToPath(new URL('./support/wait.js', import.meta.url))).href
const rules = source => checkSource(source).findings.map(({ line, rule }) => `${line}:${rule}`)

test('a wait returns what its check returns once it holds, sync or async', { timeout: 60_000 }, async t => {
  let polls = 0
  assert.equal(await until(t, () => ++polls >= 3 && 'held', 'the third poll'), 'held')
  assert.equal(polls, 3)
  assert.deepEqual(await until(t, async () => ({ value: 1 }), 'an async check'), { value: 1 })
})

test('a check that throws fails the wait at once, unless the error means not yet', { timeout: 60_000 }, async t => {
  await assert.rejects(until(t, () => { throw new Error('broken check') }, 'a broken check'), /broken check/)
  let polls = 0
  const missing = () => { if (++polls < 3) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return 'there' }
  assert.equal(await until(t, missing, 'a file that appears', { retry: notYetThere }), 'there')
  await assert.rejects(until(t, () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }, 'a denied read', { retry: notYetThere }), /denied/)
  await assert.rejects(until({}, () => true, 'no context'), /test context/)
})

test('a wait whose condition never holds fails at its test\'s bound, naming what it waited for', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wait-bound-'))
  const scratch = join(root, 'scratch.test.mjs')
  writeFileSync(scratch, `import test from 'node:test'
import { until } from ${JSON.stringify(helper)}
test('scratch', { timeout: 1500 }, async t => {
  t.after(() => console.log('after the bound: ' + t.signal.aborted))
  await until(t, () => false, () => 'the event that never arrives')
})
`)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const started = Date.now()
  const result = spawnSync(process.execPath, ['--test', scratch], { env, encoding: 'utf8' })
  const output = result.stdout + result.stderr
  assert.notEqual(result.status, 0, output)
  assert.match(output, /test timed out after 1500ms/)
  assert.match(output, /still waiting for the event that never arrives when the test's bound ended/)
  assert.ok(Date.now() - started >= 1500, 'the wait ran to the bound')
})

test('the check refuses a deadline loop, a counted poll and an unbounded poll in a test file', () => {
  // The clock goes in by interpolation, so this file's own text holds no deadline.
  const clock = 'Date.now()'
  assert.deepEqual(rules(`const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  const deadline = ${clock} + 15_000
  while (${clock} < deadline) { if (await check()) return; await wait(50) }
  throw new Error('timed out')
}
test('a', async () => {
  for (let tries = 0; tries < 100 && !done; tries += 1) await new Promise(done => setTimeout(done, 5))
  while (!held) await new Promise(resolve => setImmediate(resolve))
  for (const deadline = ${clock} + 10; ${clock} < deadline;) {}
  do { await wait(10) } while (!ready)
})
`), ['4:poll', '8:poll', '9:poll', '10:poll', '11:poll'])
})

test('the check leaves a walk over cases, a fixed pause and a nested test\'s sleep alone', () => {
  assert.deepEqual(rules(`const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
for (const kind of ['a', 'b']) test(kind, { timeout: 1000 }, async t => { await wait(5) })
test('c', async () => {
  for (let tick = 0; tick < 5; tick++) { await bridge.tick(); await wait(50) }
  for (const char of 'text') { write(char); await wait(15) }
})
`), [])
})

test('the check refuses a clock deadline in a program a test runs', () => {
  // Built from parts so this file holds no such program itself.
  const program = 'setInterval(()=>{if(done())process.exit(0);else if(Date.now' + '()-start>9000)process.exit(1)},20)'
  assert.deepEqual(rules(`spawn(process.execPath, ['-e', ${JSON.stringify(program)}])\n`), ['1:program-deadline'])
})

test('the check refuses a test or hook that waits without declaring its timeout', () => {
  assert.deepEqual(rules(`import { until } from './support/wait.js'
async function ready(t) { await until(t, () => true, 'ready') }
class Client { waitFor(t, what) { return until(t, () => true, what) } }
test('direct', async t => { await until(t, () => true, 'x') })
test('through a helper', async t => { await ready(t) })
test('through a method', async t => { await client.waitFor(t, 'y') })
test('bounded', { timeout: 1000 }, async t => {
  t.after(async () => { await until(t, () => true, 'cleanup') })
  t.after(async () => { await until(t, () => true, 'bounded cleanup') }, { timeout: 1000 })
  await until(t, () => true, 'z')
})
test('not waiting', () => {})
`), ['4:no-bound', '5:no-bound', '6:no-bound', '8:no-bound'])
})

test('the check fails closed on a test file it cannot read, and passes this folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'wait-check-'))
  mkdirSync(join(root, 'support'))
  writeFileSync(join(root, 'broken.test.js'), 'test(`unterminated\n')
  writeFileSync(join(root, 'support', 'helper.js'), 'export const ok = true\n')
  assert.deepEqual(checkFolder(root).map(({ file, rule }) => `${file}:${rule}`), ['broken.test.js:unreadable'])
  assert.deepEqual(checkFolder(folder), [])
})
