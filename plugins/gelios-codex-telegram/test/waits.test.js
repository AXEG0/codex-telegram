import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, spawn, stopLeftover } from './fixtures.js'
import { checkFolder, checkSource } from './support/check-waits.js'
import { cleanup, closed, exited, notYetThere, until } from './support/wait.js'

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

test('the check refuses a test or cleanup that waits without its timeout, and any hook that waits', () => {
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
before(async t => { await until(t, () => true, 'a before hook with a timeout') }, { timeout: 1000 })
beforeEach(async t => { await ready(t) }, { timeout: 1000 })
test('not waiting', () => {})
`), ['4:no-bound', '5:no-bound', '6:no-bound', '8:hook-wait', '9:hook-wait', '11:no-bound', '12:hook-wait', '16:hook-wait', '17:hook-wait'])
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
  const scratch = join(root, 'leftover.test.mjs'), pidFile = join(root, 'leftover.pid'), viewerFile = join(root, 'viewer.pid')
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
  // The leftover has the detached bridge's shape: a program outside every
  // fixture folder, started in a group of its own with the fixture as an argument.
  const program = ${JSON.stringify(join(root, 'bridge.cjs'))}
  writeFileSync(program, "const s = require('node:net').connect(Number(process.argv[2]), '127.0.0.1'); s.on('error', () => {}); setInterval(() => {}, 1000)")
  const left = spawn(process.execPath, [program, String(server.address().port), '--state-dir', join(own, 'state')], { detached: true, stdio: 'ignore' })
  left.unref()
  writeFileSync(${JSON.stringify(pidFile)}, String(left.pid))
  // Processes this file did not cause name the fixture too, as viewers opened
  // on its log would; they inherited another temporary folder.
  writeFileSync(join(own, 'service.log'), 'log\\n')
  const elsewhere = { PATH: process.env.PATH, TMPDIR: ${JSON.stringify(tmpdir())} }
  const viewers = [[process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(own, 'service.log')]], ['tail', ['-f', join(own, 'service.log')]], [process.execPath, [program, '0', join(own, 'service.log')]],
    ...process.platform === 'linux' ? [['tail', [join(own, 'service.log'), '-f']]] : []]
    .map(([command, args]) => { const viewer = spawn(command, args, { detached: true, stdio: 'ignore', env: elsewhere }); viewer.unref(); return viewer.pid })
  writeFileSync(${JSON.stringify(viewerFile)}, viewers.join(' '))
  await until(t, () => new Promise(resolve => server.getConnections((error, count) => resolve(!error && count > 0))), 'the leftover to connect')
  cleanup(t, 'leftover', async hook => { await until(hook, () => false, 'a leftover that never stops') }, { timeout: 300 })
  cleanup(t, 'server', () => { server.close() }, { timeout: 1000 })
})
`)
  const { code, output } = await scratchRun(t, scratch, 'the scratch file to end once its cleanup failed')
  const pid = Number(readFileSync(pidFile, 'utf8')), viewers = readFileSync(viewerFile, 'utf8').split(' ').map(Number)
  const alive = viewers.filter(viewer => { try { process.kill(viewer, 0); return true } catch { return false } })
  for (const viewer of alive) process.kill(viewer, 'SIGTERM')
  assert.deepEqual(alive, viewers, 'the teardown left alone every process this file did not cause')
  for (const viewer of viewers) assert.doesNotMatch(output, new RegExp(`left running: [^\\n]*\\b${viewer} \\(`))
  assert.notEqual(code, 0, output)
  assert.match(output, /cleanup failed after the test: leftover: the leftover cleanup did not finish within its bound of 300 ms/)
  assert.match(output, new RegExp(`the fixture cleanup hook in test/fixtures\\.js: stopped 1 process\\(es\\) this test file left running: ${pid} \\(`))
  await until(t, () => { try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' } }, 'the leftover process to be gone')
})

test('the teardown signals a listed process only while its start identity is still the listed one', async () => {
  // A pid reused by another process before the first signal is never signalled.
  await stopLeftover({ pid: 4242424, identity: 'listed' }, { info: () => ({ identity: 'another' }), kill: () => assert.fail('a reused pid must never be signalled') })
  // The listed process gets SIGTERM; once it is gone, nothing more is sent.
  const sent = []
  let alive = true
  await stopLeftover({ pid: 4242424, identity: 'listed' }, {
    info: () => alive ? { identity: 'listed' } : null,
    kill: (pid, name) => { sent.push(name); alive = false },
  })
  assert.deepEqual(sent, ['SIGTERM'])
})

test('a wait on a child\'s exit or close ends even when it starts after the child exited', { timeout: 20_000 }, async t => {
  const quick = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' })
  // The exit is recorded, and its event has passed, before the wait starts.
  await until(t, () => quick.exitCode !== null, 'the quick child to exit')
  assert.deepEqual(await exited(t, quick), [3, null])
  const talker = spawn(process.execPath, ['-e', 'process.stdout.write("done")'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  talker.stdout.on('data', part => { output += part })
  await until(t, () => talker.exitCode !== null && talker.stdout.closed && talker.stderr.closed, 'the talking child to exit and close its output')
  await closed(t, talker)
  assert.equal(output, 'done')
  const running = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const ended = exited(t, running)
  running.kill('SIGTERM')
  assert.deepEqual(await ended, [null, 'SIGTERM'])
  await assert.rejects(exited(t, spawn(join(folder, 'no-such-command'), [], { stdio: 'ignore' })), /ENOENT/)
  // A wait on a child that never exits ends at the bound of its context, naming the child.
  const stuck = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const notes = [], bound = new AbortController()
  const pending = exited({ signal: bound.signal, diagnostic: note => notes.push(note) }, stuck)
  bound.abort()
  await assert.rejects(pending, new RegExp(`still waiting for process ${stuck.pid} \\(.*setInterval.*\\) to exit when the test's bound ended`))
  assert.equal(notes.length, 1)
  assert.throws(() => exited({}, stuck), /test context/)
  const stopped = exited(t, stuck); stuck.kill('SIGTERM'); await stopped
})

test('the check refuses an exit listener on a child, however node:events is imported, and leaves the process\'s own alone', () => {
  assert.deepEqual(rules(`import { once } from 'node:events'
child.once('exit', resolve)
await once(app, 'exit')
worker.on('exit', code => done(code))
bridge.app?.addListener('exit', stop)
process.on('exit', cleanup)
await once(process, 'exit')
child.once('close', resolve)
const [code] = await exited(t, child)
`), ['2:exit-listener', '3:exit-listener', '4:exit-listener', '5:exit-listener'])
  assert.deepEqual(rules(`import events from 'node:events'
await events.once(child, 'exit')
`), ['2:exit-listener'])
  assert.deepEqual(rules(`import * as events from 'events'
await events.once(child, 'exit')
`), ['2:exit-listener'])
  assert.deepEqual(rules(`import { once as on } from 'node:events'
await on(child, 'exit')
`), ['2:exit-listener'])
  assert.deepEqual(rules(`import { EventEmitter } from 'node:events'
await EventEmitter.once(child, 'exit')
`), ['2:exit-listener'])
})

test('the check refuses a poll in each spelling of a sleep, and a counted loop that can skip its sleep', () => {
  assert.deepEqual(rules(`import { promisify } from 'node:util'
const sleep = promisify(setTimeout)
while (!ready) await sleep(10)
`), ['3:poll'])
  assert.deepEqual(rules(`import util from 'node:util'
const sleep = util.promisify(setTimeout)
while (!ready) await sleep(10)
`), ['3:poll'])
  assert.deepEqual(rules(`import timers from 'node:timers/promises'
while (!ready) await timers.setTimeout(10)
`), ['2:poll'])
  assert.deepEqual(rules(`import * as timers from 'timers/promises'
while (!ready) await timers.setTimeout(10)
`), ['2:poll'])
  assert.deepEqual(rules(`import { setTimeout as pause } from 'node:timers/promises'
while (!ready) await pause(10)
`), ['2:poll'])
  assert.deepEqual(rules(`const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
for (let i = 0; i < 100; i++) { if (!done) await wait(10) }
for (let i = 0; i < 100; i++) { done || await wait(10) }
for (let i = 0; i < 5; i++) { await tick(); await wait(10) }
`), ['2:poll', '3:poll'])
  const root = mkdtempSync(join(tmpdir(), 'wait-sleep-'))
  mkdirSync(join(root, 'support'))
  writeFileSync(join(root, 'support', 'helpers.js'), 'export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))\nexport async function nap(ms) { await delay(ms) }\n')
  writeFileSync(join(root, 'a.test.js'), "import { delay, nap as rest } from './support/helpers.js'\nwhile (!ready) await delay(10)\ndo { await rest(10) } while (!ready)\n")
  assert.deepEqual(checkFolder(root).map(({ file, line, rule }) => `${file}:${line}:${rule}`), ['a.test.js:2:poll', 'a.test.js:3:poll'])
})

test('the check refuses a wait that ends once a file exists when the file is then read', () => {
  assert.deepEqual(rules(`import { until } from './support/wait.js'
test('a', { timeout: 1000 }, async t => {
  await until(t, () => existsSync(join(root, 'job-pid')), 'the job pid')
  const pid = Number(readFileSync(join(root, 'job-pid')))
  await until(t, () => existsSync(done) && readFileSync(done, 'utf8'), 'the content')
  await until(t, () => existsSync(marker), 'a marker nobody reads')
})
`), ['3:exists-then-read'])
})

test('the check finds waits through a namespace, an object helper, a test modifier and an exit wait, by binding', () => {
  assert.deepEqual(rules(`import * as w from './support/wait.js'
test('a', async t => { await w.until(t, () => true, 'x') })
const h = { ready: t => until(t, () => true, 'y') }
test('b', async t => { await h.ready(t) })
test.only('c', async t => { await until(t, () => true, 'z') })
it.skip('d', async t => { await until(t, () => true, 'z') })
test.todo('e', async t => { await exited(t, child) })
test('f', async t => { await closed(t, child) })
import { until, exited, closed } from './support/wait.js'
`), ['2:no-bound', '4:no-bound', '5:no-bound', '6:no-bound', '7:no-bound', '8:no-bound'])
  // A function bound to a member is reached through member calls only, and a
  // local binding shadows a waiting one of the same name.
  assert.deepEqual(rules(`import { exited } from './support/wait.js'
const harness = {}
harness.run = async () => exited(t, app)
function run() { return 1 }
test('g', async () => { run() })
test('h', async () => { const exited = () => 1; exited() })
test('i', async () => { await harness.run() })
`), ['7:no-bound'])
})

test('the check resolves node:test, node:events, sleeps and file reads through bindings in every spelling', () => {
  // Tests and hooks under another name, and a timeout that never ends.
  assert.deepEqual(rules(`import { until } from './support/wait.js'
import { before as setup, test as check } from 'node:test'
setup(async t => { await until(t, () => false, 'x') }, { timeout: 1000 })
check('a', async t => { await until(t, () => false, 'x') })
check('b', { timeout: Infinity }, async t => { await until(t, () => false, 'x') })
check('c', { timeout: process.env.SLOW ? 240_000 : 60_000 }, async t => { await until(t, () => true, 'x') })
`), ['3:hook-wait', '4:no-bound', '5:no-bound'])
  assert.deepEqual(rules(`import { until } from './support/wait.js'
import spec from 'node:test'
spec('a', async t => { await until(t, () => false, 'x') })
`), ['3:no-bound'])
  // node:events through destructuring and a dynamic import, optional and
  // computed calls, and an event held in a const; an event the check cannot
  // read is refused.
  assert.deepEqual(rules(`import events from 'node:events'
const { once: on } = events
await on(child, 'exit')
const { once: when } = await import('node:events')
await when(child, 'exit')
child.once?.('exit', done)
child['once']('exit', done)
const ev = 'exit'
child.once(ev, done)
let later = 'exit'
child.on(later, done)
child.once('close', done)
`), ['3:exit-listener', '5:exit-listener', '6:exit-listener', '7:exit-listener', '9:exit-listener', '11:exit-listener'])
  // Sleeps bound to an object or a class member, or destructured from
  // node:timers/promises.
  assert.deepEqual(rules(`const h = { sleep: ms => new Promise(r => setTimeout(r, ms)) }
while (!ready) await h.sleep(10)
class Clock { nap(ms) { return new Promise(r => setTimeout(r, ms)) } }
const clock = new Clock()
while (!ready) await clock.nap(10)
`), ['2:poll', '5:poll'])
  assert.deepEqual(rules(`import timers from 'node:timers/promises'
const { setTimeout: nap } = timers
while (!ready) await nap(10)
`), ['3:poll'])
  assert.deepEqual(rules(`const { setTimeout: nap } = await import('node:timers/promises')
while (!ready) await nap(10)
`), ['2:poll'])
  // A file read after its existence wait: asynchronously, through a const
  // holding its path, or inside a helper.
  assert.deepEqual(rules(`import { until } from './support/wait.js'
import { readFile } from 'node:fs/promises'
const finished = () => readFileSync(marker, 'utf8')
test('a', { timeout: 1000 }, async t => {
  await until(t, () => existsSync(done), 'done')
  assert.equal(await readFile(done, 'utf8'), 'finished')
  const pid = join(root, 'job-pid')
  await until(t, () => existsSync(join(root, 'job-pid')), 'the pid')
  assert.equal(readFileSync(pid, 'utf8'), '1')
  await until(t, () => existsSync(marker), 'the marker')
  assert.equal(finished(), 'finished')
})
`), ['5:exists-then-read', '8:exists-then-read', '10:exists-then-read'])
})

test('the check fails closed on a test file it cannot read, and passes this folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'wait-check-'))
  mkdirSync(join(root, 'support'))
  writeFileSync(join(root, 'broken.test.js'), 'test(`unterminated\n')
  writeFileSync(join(root, 'support', 'helper.js'), 'export const ok = true\n')
  assert.deepEqual(checkFolder(root).map(({ file, rule }) => `${file}:${rule}`), ['broken.test.js:unreadable'])
  assert.deepEqual(checkFolder(folder), [])
})
