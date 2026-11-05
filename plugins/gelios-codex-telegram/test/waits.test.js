import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, spawn } from './fixtures.js'
import { checkFolder, checkSource } from './support/check-waits.js'
import { cleanup, notYetThere, until } from './support/wait.js'

const folder = fileURLToPath(new URL('.', import.meta.url))
const helper = pathToFileURL(fileURLToPath(new URL('./support/wait.js', import.meta.url))).href
const fixtures = pathToFileURL(fileURLToPath(new URL('./fixtures.js', import.meta.url))).href
const rules = source => checkSource(source).findings.map(({ line, rule }) => `${line}:${rule}`)

// Runs a scratch test file in its own test process and waits, under the
// calling test's bound, for that process to end.
async function scratchRun(t, file, what) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, ['--test', file], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', code = null, closed = false
  child.stdout.on('data', part => { output += part }); child.stderr.on('data', part => { output += part })
  child.once('close', status => { code = status; closed = true })
  await until(t, () => closed, what)
  return { code, output }
}

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

test('the check refuses a test, before hook or cleanup that waits without its timeout, and an after hook that waits', () => {
  assert.deepEqual(rules(`import { cleanup, until } from './support/wait.js'
async function ready(t) { await until(t, () => true, 'ready') }
class Client { waitFor(t, what) { return until(t, () => true, what) } }
test('direct', async t => { await until(t, () => true, 'x') })
test('through a helper', async t => { await ready(t) })
test('through a method', async t => { await client.waitFor(t, 'y') })
test('bounded', { timeout: 1000 }, async t => {
  t.after(async () => { await until(t, () => true, 'cleanup') })
  t.after(async () => { await until(t, () => true, 'bounded cleanup') }, { timeout: 1000 })
  cleanup(t, 'own bound', async hook => { await until(hook, () => true, 'a cleanup in its bound') }, { timeout: 1000 })
  cleanup(t, 'no bound', async hook => { await until(hook, () => true, 'a cleanup without one') })
  t.before(async () => { await ready(t) })
  t.after(() => server.close())
  await until(t, () => true, 'z')
})
test('not waiting', () => {})
`), ['4:no-bound', '5:no-bound', '6:no-bound', '8:hook-wait', '9:hook-wait', '11:no-bound', '12:no-bound'])
})

test('a cleanup waits under its own bound once the test\'s bound ended, and a failed one skips none after it', { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-cleanup-'))
  const scratch = join(root, 'cleanup.test.mjs')
  writeFileSync(scratch, `import test from 'node:test'
import { cleanup, until } from ${JSON.stringify(helper)}
test('times out', { timeout: 500 }, async t => {
  let polls = 0
  cleanup(t, 'counting', async hook => {
    await until(hook, () => ++polls >= 3, 'three polls')
    console.log('the counting cleanup polled ' + polls + ' times after its test timed out')
  }, { timeout: 5000 })
  await until(t, () => false, 'a test that runs out of time')
})
test('passes, then a cleanup fails', { timeout: 5000 }, async t => {
  cleanup(t, 'stuck', async hook => { await until(hook, () => false, 'a cleanup that never finishes') }, { timeout: 300 })
  cleanup(t, 'last', () => { console.log('the last cleanup ran') }, { timeout: 1000 })
})
`)
  const { code, output } = await scratchRun(t, scratch, 'the scratch file with cleanups to end')
  assert.notEqual(code, 0, output)
  assert.match(output, /test timed out after 500ms/)
  // Node 22 and later hand the cleanup a test signal that has already aborted,
  // Node 18 one that has not; the cleanup's own bound serves both.
  assert.match(output, /the counting cleanup polled 3 times after its test timed out/)
  assert.match(output, /still waiting for a cleanup that never finishes when the bound of the stuck cleanup ended/)
  assert.match(output, /cleanup failed after the test: stuck: the stuck cleanup did not finish within its bound of 300 ms/)
  assert.match(output, /the last cleanup ran/)
  assert.throws(() => cleanup(t, 'unbounded', () => {}), /the unbounded cleanup needs its timeout/)
})

test('a test file ends when a failed cleanup leaves a process running, which the fixture names and stops', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-leftover-'))
  const scratch = join(root, 'leftover.test.mjs'), pidFile = join(root, 'leftover.pid')
  writeFileSync(scratch, `import net from 'node:net'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { mkdtempSync } from ${JSON.stringify(fixtures)}
import { cleanup, until } from ${JSON.stringify(helper)}
test('a cleanup fails and leaves a process connected to this file', { timeout: 20_000 }, async t => {
  const own = mkdtempSync(join(${JSON.stringify(root)}, 'owned-'))
  const server = net.createServer(socket => socket.on('error', () => {}))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const program = join(own, 'leftover.cjs')
  writeFileSync(program, "const s = require('node:net').connect(Number(process.argv[2]), '127.0.0.1'); s.on('error', () => {}); setInterval(() => {}, 1000)")
  const left = spawn(process.execPath, [program, String(server.address().port)], { detached: true, stdio: 'ignore' })
  left.unref()
  writeFileSync(${JSON.stringify(pidFile)}, String(left.pid))
  await until(t, () => new Promise(resolve => server.getConnections((error, count) => resolve(!error && count > 0))), 'the leftover to connect')
  cleanup(t, 'leftover', async hook => { await until(hook, () => false, 'a leftover that never stops') }, { timeout: 300 })
  cleanup(t, 'server', () => { server.close() }, { timeout: 1000 })
})
`)
  const { code, output } = await scratchRun(t, scratch, 'the scratch file to end once its cleanup failed')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.notEqual(code, 0, output)
  assert.match(output, /cleanup failed after the test: leftover: the leftover cleanup did not finish within its bound of 300 ms/)
  assert.match(output, new RegExp(`the fixture cleanup hook in test/fixtures\\.js: stopped 1 process\\(es\\) this test file left running: ${pid} \\(`))
  await until(t, () => { try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' } }, 'the leftover process to be gone')
})

test('the check fails closed on a test file it cannot read, and passes this folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'wait-check-'))
  mkdirSync(join(root, 'support'))
  writeFileSync(join(root, 'broken.test.js'), 'test(`unterminated\n')
  writeFileSync(join(root, 'support', 'helper.js'), 'export const ok = true\n')
  assert.deepEqual(checkFolder(root).map(({ file, rule }) => `${file}:${rule}`), ['broken.test.js:unreadable'])
  assert.deepEqual(checkFolder(folder), [])
})
