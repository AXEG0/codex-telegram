import assert from 'node:assert/strict'
import childProcess, { spawnSync as namedSpawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { execFile, execFileSync, mark, marked, mkdtempSync, processesIn, spawn, spawnSync, stopLeftover } from './fixtures.js'
import { checkFolder, checkSource } from './support/check-waits.js'
import { cleanup, closed, exited, notYetThere, until } from './support/wait.js'
import { runCommand } from '../scripts/update.js'

const folder = fileURLToPath(new URL('.', import.meta.url))
const helper = pathToFileURL(fileURLToPath(new URL('./support/wait.js', import.meta.url))).href
const fixtures = pathToFileURL(fileURLToPath(new URL('./fixtures.js', import.meta.url))).href
const runner = fileURLToPath(new URL('./support/run-tests.js', import.meta.url))
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
  await assert.rejects(until({}, () => true, 'no context'), /needs the context of the test, hook, describe body or cleanup it runs in/)
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
import { mkdtempSync, spawn as start } from ${JSON.stringify(fixtures)}
import { cleanup, until } from ${JSON.stringify(helper)}
test('a cleanup fails and leaves a process connected to this file', { timeout: 20_000 }, async t => {
  const own = mkdtempSync(join(${JSON.stringify(root)}, 'owned-'))
  const server = net.createServer(socket => socket.on('error', () => {}))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  // The leftover has the detached bridge's shape: a program outside every
  // fixture folder, started in a group of its own with the fixture as an argument.
  const program = ${JSON.stringify(join(root, 'bridge.cjs'))}
  // It ignores SIGTERM, as a bridge stuck in its shutdown does.
  writeFileSync(program, "process.on('SIGTERM', () => {}); const s = require('node:net').connect(Number(process.argv[2]), '127.0.0.1'); s.on('error', () => {}); setInterval(() => {}, 1000)")
  // A launcher the fixture starts detaches the leftover and exits, as bridge
  // --detach does, so only the mark the fixture set where the launcher started
  // finds it: one launcher gets an environment written by hand without
  // TMPDIR, the other runs through env -i, which clears the environment.
  const launcher = "const [program, port, state, pidFile] = process.argv.slice(1); const c = require('node:child_process').spawn(process.execPath, [program, port, '--state-dir', state], { detached: true, stdio: 'ignore' }); c.unref(); require('node:fs').writeFileSync(pidFile, String(c.pid))"
  const port = String(server.address().port)
  start(process.execPath, ['-e', launcher, program, port, join(own, 'state'), ${JSON.stringify(pidFile)}], { env: { PATH: process.env.PATH }, stdio: 'ignore' })
  start('/usr/bin/env', ['-i', 'PATH=' + process.env.PATH, process.execPath, '-e', launcher, program, port, join(own, 'state-2'), ${JSON.stringify(pidFile + '-2')}], { stdio: 'ignore' })
  // Processes this file did not cause name the fixture too, as viewers opened
  // on its log would; they have another temporary folder, which the shell
  // that starts them sets, as a viewer someone opened from elsewhere has.
  writeFileSync(join(own, 'service.log'), 'log\\n')
  const elsewhere = ${JSON.stringify(tmpdir())}
  const viewers = [[process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(own, 'service.log')]], ['tail', ['-f', join(own, 'service.log')]], [process.execPath, [program, '0', join(own, 'service.log')]],
    ...process.platform === 'linux' ? [['tail', [join(own, 'service.log'), '-f']]] : []]
    .map(([command, args]) => { const viewer = spawn('/bin/sh', ['-c', 'export TMPDIR="$0"; exec "$@"', elsewhere, command, ...args], { detached: true, stdio: 'ignore' }); viewer.unref(); return viewer.pid })
  writeFileSync(${JSON.stringify(viewerFile)}, viewers.join(' '))
  await until(t, () => new Promise(resolve => server.getConnections((error, count) => resolve(!error && count > 1))), 'both leftovers to connect')
  cleanup(t, 'leftover', async hook => { await until(hook, () => false, 'a leftover that never stops') }, { timeout: 300 })
  cleanup(t, 'server', () => { server.close() }, { timeout: 1000 })
})
`)
  const { code, output } = await scratchRun(t, scratch, 'the scratch file to end once its cleanup failed')
  const pids = [pidFile, pidFile + '-2'].map(file => Number(readFileSync(file, 'utf8'))), viewers = readFileSync(viewerFile, 'utf8').split(' ').map(Number)
  const alive = viewers.filter(viewer => { try { process.kill(viewer, 0); return true } catch { return false } })
  for (const viewer of alive) process.kill(viewer, 'SIGKILL')
  assert.deepEqual(alive, viewers, 'the teardown left alone every process this file did not cause')
  for (const viewer of viewers) assert.doesNotMatch(output, new RegExp(`left running: [^\\n]*\\b${viewer} \\(`))
  assert.notEqual(code, 0, output)
  assert.match(output, /cleanup failed after the test: leftover: the leftover cleanup did not finish within its bound of 300 ms/)
  assert.match(output, /the fixture cleanup hook in test\/fixtures\.js: stopped 2 process\(es\) this test file left running: /)
  for (const pid of pids) {
    assert.match(output, new RegExp(`left running: [^\\n]*\\b${pid} \\(`))
    await until(t, () => { try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' } }, `leftover ${pid} to be gone`)
  }
})

test('the fixture starters mark each child where it starts, whatever environment the test hands it', () => {
  const inner = join(mark.TMPDIR, 'inner')
  assert.equal(marked('node', ['x'], { env: { PATH: '/bin' } })[2].env.TMPDIR, mark.TMPDIR)
  assert.equal(marked('node', ['x'], { env: { PATH: '/bin', TMPDIR: inner } })[2].env.TMPDIR, inner)
  assert.equal(marked('node', ['x'])[2].env.TMPDIR, mark.TMPDIR)
  assert.throws(() => marked('node', ['x'], { env: { TMPDIR: '/elsewhere' } }), /outside this test file's folder/)
  // A service manager and env -i drop the environment, so the mark goes in their arguments.
  assert.deepEqual(marked('systemd-run', ['--user', '--', '/usr/bin/env', '-i', 'PATH=/bin', 'node', 'x'], { env: {} }).slice(0, 2),
    ['systemd-run', [`--setenv=TMPDIR=${mark.TMPDIR}`, '--user', '--', '/usr/bin/env', '-i', `TMPDIR=${mark.TMPDIR}`, 'PATH=/bin', 'node', 'x']])
  assert.deepEqual(marked('/usr/bin/env', ['-i', 'PATH=/bin', 'node'], { env: {} }).slice(0, 2), ['/usr/bin/env', ['-i', `TMPDIR=${mark.TMPDIR}`, 'PATH=/bin', 'node']])
  assert.deepEqual(marked('systemd-run', ['--user', '--scope', 'node'], { env: {} })[1], ['--user', '--scope', 'node'])
  // A TMPDIR in the arguments is held to the same rule as one in the environment.
  for (const args of [['--setenv=TMPDIR=/tmp', 'node'], ['-E', 'TMPDIR=/tmp', 'node'], ['-ETMPDIR=/tmp', 'node']]) assert.throws(() => marked('systemd-run', args, { env: {} }), /in its arguments/)
  assert.throws(() => marked('/usr/bin/env', ['-i', 'TMPDIR=/tmp', 'node'], { env: {} }), /in its arguments/)
  assert.deepEqual(marked('systemd-run', [`--setenv=TMPDIR=${inner}`, 'node'], { env: {} })[1], [`--setenv=TMPDIR=${inner}`, 'node'])
})

test('every child this test process starts carries the mark, whichever code starts it and however it reached node:child_process', { timeout: 30_000 }, async t => {
  const env = { PATH: process.env.PATH }, code = 'process.stdout.write(process.env.TMPDIR ?? "no TMPDIR")', print = ['-e', code]
  const shell = `"${process.execPath}" -e '${code}'`
  const seen = {}
  seen.spawnSync = String(spawnSync(process.execPath, print, { env, encoding: 'utf8' }).stdout)
  seen.execFileSync = String(execFileSync(process.execPath, print, { env, encoding: 'utf8' }))
  seen.execFile = await new Promise((resolve, reject) => { execFile(process.execPath, print, { env }, (error, stdout) => error ? reject(error) : resolve(stdout)) })
  seen.promisifiedExecFile = (await promisify(execFile)(process.execPath, print, { env })).stdout
  seen.execSync = String(childProcess.execSync(shell, { env, encoding: 'utf8' }))
  seen.exec = await new Promise((resolve, reject) => { childProcess.exec(shell, { env }, (error, stdout) => error ? reject(error) : resolve(stdout)) })
  seen.named = String(namedSpawnSync(process.execPath, print, { env, encoding: 'utf8' }).stdout)
  seen.required = String(createRequire(import.meta.url)('node:child_process').execFileSync(process.execPath, print, { env, encoding: 'utf8' }))
  if (process.getBuiltinModule) seen.builtin = String(process.getBuiltinModule('node:child_process').spawnSync(process.execPath, print, { env, encoding: 'utf8' }).stdout)
  // The plugin's own command runner, handed an environment written by hand.
  seen.plugin = (await runCommand(process.execPath, print, { env, label: 'mark probe' })).stdout
  const child = spawn(process.execPath, print, { env, stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  child.stdout.on('data', part => { output += part })
  await closed(t, child)
  seen.spawn = output
  assert.deepEqual(seen, Object.fromEntries(Object.keys(seen).map(name => [name, mark.TMPDIR])))
  // Arguments that are null or undefined are an empty list, and the options still count.
  assert.equal(String(spawnSync('/bin/pwd', null, { cwd: '/usr', encoding: 'utf8' }).stdout).trim(), '/usr')
  assert.equal(String(execFileSync('/bin/pwd', undefined, { cwd: '/usr', encoding: 'utf8' })).trim(), '/usr')
  const pwd = spawn('/bin/pwd', null, { cwd: '/usr', stdio: ['ignore', 'pipe', 'ignore'] })
  let where = ''
  pwd.stdout.on('data', part => { where += part })
  await closed(t, pwd)
  assert.equal(where.trim(), '/usr')
})

// Whether this machine's user service manager starts a unit.
const userUnits = (() => {
  if (process.platform !== 'linux') return false
  try { execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 5000 }); return true } catch { return false }
})()

test('a unit a test has the service manager start carries the mark', { skip: !userUnits && 'no user service manager here', timeout: 30_000 }, async t => {
  const unit = `codex-telegram-mark-${process.pid}-${Date.now()}`
  cleanup(t, 'the unit', () => { try { execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' }) } catch {} }, { timeout: 10_000 })
  execFileSync('systemd-run', ['--user', '--quiet', '--collect', `--unit=${unit}`, process.execPath, '-e', 'setInterval(() => {}, 1000)'], { env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } })
  const main = await until(t, () => Number(execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unit], { encoding: 'utf8' }).trim()), 'the unit to start')
  assert.ok(processesIn().some(entry => entry.pid === main), 'the teardown lists the unit the test had the service manager start')
})

test('the teardown names a folder it cannot read or remove and still stops what the file left, and stops a process a leftover starts as it is stopped', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-guards-'))
  const scratch = join(root, 'guards.test.mjs'), pidFile = join(root, 'leftover.pid'), successorFile = join(root, 'successor.pid'), lockedFile = join(root, 'locked.path')
  const program = join(root, 'leftover.cjs')
  // On SIGTERM it starts a successor, which inherits its mark, and exits.
  writeFileSync(program, `process.on('SIGTERM', () => { const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); c.unref(); require('node:fs').writeFileSync(${JSON.stringify(successorFile)}, String(c.pid)); process.exit(0) }); setInterval(() => {}, 1000)`)
  writeFileSync(scratch, `import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { mkdtempSync, spawn as start } from ${JSON.stringify(fixtures)}
import { cleanup, until } from ${JSON.stringify(helper)}
test('a cleanup fails and leaves a process, and a folder nobody can read', { timeout: 20_000 }, async t => {
  const owned = mkdtempSync(join(${JSON.stringify(root)}, 'owned-')), locked = join(owned, 'locked')
  // A runtime record that holds no object, beside a socket path, is no runtime.
  writeFileSync(join(owned, 'native-runtime.json'), 'null'); writeFileSync(join(owned, 'runtime.sock'), '')
  // A folder nobody can read that is not empty cannot be removed either.
  mkdirSync(join(locked, 'inside'), { recursive: true }); chmodSync(locked, 0o000)
  writeFileSync(${JSON.stringify(lockedFile)}, locked)
  const launcher = "const c = require('node:child_process').spawn(process.execPath, [process.argv[1]], { detached: true, stdio: 'ignore' }); c.unref(); require('node:fs').writeFileSync(process.argv[2], String(c.pid))"
  start(process.execPath, ['-e', launcher, ${JSON.stringify(program)}, ${JSON.stringify(pidFile)}], { env: { PATH: process.env.PATH }, stdio: 'ignore' })
  await until(t, () => { try { return Number(readFileSync(${JSON.stringify(pidFile)}, 'utf8')) } catch { return false } }, 'the leftover to start')
  cleanup(t, 'leftover', async hook => { await until(hook, () => false, 'a leftover that never stops') }, { timeout: 300 })
})
`)
  t.after(() => { try { chmodSync(readFileSync(lockedFile, 'utf8'), 0o700) } catch {} })
  const { code, output } = await scratchRun(t, scratch, 'the scratch file to end once its cleanup failed')
  try { chmodSync(readFileSync(lockedFile, 'utf8'), 0o700) } catch {}
  const pid = Number(readFileSync(pidFile, 'utf8')), successor = Number(readFileSync(successorFile, 'utf8'))
  assert.notEqual(code, 0, output)
  assert.match(output, /the runtimes in [^\n]*locked could not be read/)
  assert.match(output, /owned-\w+ could not be removed: /)
  assert.match(output, /stopped 2 process\(es\) this test file left running: /)
  for (const left of [pid, successor]) {
    assert.match(output, new RegExp(`left running: [^\\n]*\\b${left} \\(`))
    await until(t, () => { try { process.kill(left, 0); return false } catch (error) { return error.code === 'ESRCH' } }, `process ${left} to be gone`)
  }
})

test('the teardown stops a runtime that a service manager started without the mark', { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-runtime-'))
  const scratch = join(root, 'runtime.test.mjs'), pidFile = join(root, 'runtime.pid')
  const runtime = pathToFileURL(fileURLToPath(new URL('../src/runtime.js', import.meta.url))).href
  writeFileSync(scratch, `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { mkdtempSync } from ${JSON.stringify(fixtures)}
import { cleanup, until } from ${JSON.stringify(helper)}
import { ensureRuntime } from ${JSON.stringify(runtime)}
// A stand-in for systemd-run: it starts the command after -- with only what
// --setenv names, as a service manager does, so the runtime carries no mark;
// the shell between drops the mark this test process adds to what it starts.
const serviceManager = (command, args, options) => {
  const at = args.indexOf('--'), env = {}
  for (const arg of args.slice(0, at)) if (arg.startsWith('--setenv=')) { const [name, ...value] = arg.slice(9).split('='); env[name] = value.join('=') }
  spawn('/bin/sh', ['-c', 'unset TMPDIR TMP TEMP; exec "$@"', 'sh', ...args.slice(at + 1)], { env, detached: true, stdio: 'ignore' }).unref()
  return spawn(process.execPath, ['-e', ''], { stdio: options.stdio })
}
test('a cleanup fails and leaves a runtime', { timeout: 40_000 }, async t => {
  const state = join(mkdtempSync(join(${JSON.stringify(root)}, 'owned-')), 'state')
  const status = await ensureRuntime({ stateDir: state, systemdUnit: 'codex-telegram-wait-test.service' }, { PATH: process.env.PATH }, { launch: serviceManager, policy: async () => {} })
  writeFileSync(${JSON.stringify(pidFile)}, String(status.pid))
  cleanup(t, 'runtime', async hook => { await until(hook, () => false, 'a runtime cleanup that never ends') }, { timeout: 300 })
})
`)
  const { code, output } = await scratchRun(t, scratch, 'the scratch file to end once its cleanup failed')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.ok(pid > 1, output)
  const environment = (() => { try { return readFileSync(`/proc/${pid}/environ`, 'utf8') } catch { return '' } })()
  assert.doesNotMatch(environment, /TMPDIR=/, 'the runtime carried no mark')
  assert.notEqual(code, 0, output)
  assert.match(output, /cleanup failed after the test: runtime: /)
  const gone = () => { try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' } }
  cleanup(t, 'a runtime the teardown missed', () => { if (!gone()) process.kill(pid, 'SIGKILL') }, { timeout: 5000 })
  await until(t, gone, `the runtime ${pid} to be gone`)
})

test('a wait needs the context it runs in, fails at once without one, and ends once that context\'s signal aborts', { timeout: 30_000 }, async t => {
  await assert.rejects(until(undefined, () => false, 'a condition that never holds'), /until needs the context of the test, hook, describe body or cleanup it runs in/)
  await assert.rejects(until({}, () => false, 'a condition that never holds'), /until needs the context/)
  assert.throws(() => exited({ diagnostic() {} }, { pid: 1 }), /exited needs the context of the test, hook, describe body or cleanup it runs in/)
  await assert.rejects(closed({}, { pid: 1 }), /exited needs the context/)
  // A context with no diagnostic(), as a describe body's on Node 18 and 22.
  const ended = new AbortController()
  const wait = until({ signal: ended.signal }, () => false, 'a condition that never holds')
  ended.abort()
  await assert.rejects(wait, /still waiting for a condition that never holds when the test's bound ended/)
})

test('a wait its cleanup never awaited ends when its test file ends, whatever the file imports first and however its teardown ends', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-file-order-'))
  const scratch = join(root, 'order.test.mjs')
  // The tree's layout: the fixtures first, then the wait helper, and a
  // teardown that fails, since the test leaves a detached process running.
  writeFileSync(scratch, `import { readFileSync } from 'node:fs'
import test from 'node:test'
import { spawn as start } from ${JSON.stringify(fixtures)}
import { cleanup, until } from ${JSON.stringify(helper)}
test('a test leaves a detached process, and its cleanup a wait it never awaited', { timeout: 5000 }, async t => {
  start(process.execPath, ['-e', "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); c.unref(); require('node:fs').writeFileSync(process.argv[1], String(c.pid))", ${JSON.stringify(join(root, 'left.pid'))}], { stdio: 'ignore' })
  await until(t, () => { try { return Number(readFileSync(${JSON.stringify(join(root, 'left.pid'))}, 'utf8')) } catch { return false } }, 'the detached process to start')
  // A cleanup's context is not ended when the cleanup returns, so only the
  // end of the file ends this wait.
  cleanup(t, 'a wait left running', hook => { until(hook, () => false, 'a condition that never holds').catch(() => {}) }, { timeout: 1000 })
})
`)
  const { code, output } = await scratchRun(t, scratch, 'the scratch file to end')
  assert.notEqual(code, 0, output)
  assert.match(output, /stopped 1 process\(es\) this test file left running/)
  assert.match(output, /still waiting for a condition that never holds when the test file ended/)
})

// Runs test files through test/support/run-tests.js, under the calling test's bound.
async function runnerRun(t, files, extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, [runner, ...files], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', part => { output += part }); child.stderr.on('data', part => { output += part })
  await closed(t, child)
  return { code: child.exitCode, output }
}

// node:test ends a file once its tests and hooks are done only where it has forceExit.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const forceExit = nodeMajor >= 22 || (nodeMajor === 20 && nodeMinor >= 14)
test('the test runner bounds every wait whatever runs it, fails a file whose tests vanish, and stops what a file it ends left running', { timeout: 120_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-runner-'))
  const marker = `left-by-a-cut-file-${process.pid}-${Date.now()}`
  const head = `import ${JSON.stringify(fixtures)}
import { before, describe, it, test } from 'node:test'
import { until } from ${JSON.stringify(helper)}
const never = () => false
`
  const failing = {
    'no-timeout.test.mjs': `${head}test('a test that declares no timeout waits', async t => { await until(t, never, 'a condition that never holds') })\n`,
    'file-hook.test.mjs': `${head}before(async t => { await until(t, never, 'a condition that never holds') })\ntest('after the hook', () => {})\n`,
    'file-hook-timeout.test.mjs': `${head}before(async t => { await until(t, never, 'a condition that never holds') }, { timeout: 1000 })\ntest('after the hook', () => {})\n`,
    'describe-body.test.mjs': `${head}describe('a describe body waits', async s => { await until(s, never, 'a condition that never holds'); it('never registered', () => {}) })\n`,
    'describe-hook.test.mjs': `${head}describe('a describe whose before waits', { timeout: 2000 }, () => { before(async s => { await until(s, never, 'a condition that never holds') }); it('x', () => {}) })\n`,
    'top-level.test.mjs': `${head}await until({ signal: new AbortController().signal }, never, 'a condition that never holds')\ntest('never registered', () => {})\n`,
    // On Node 22 node:test reports this describe failed, registers none of its tests and exits 0.
    'describe-throws.test.mjs': `import { describe, it, test } from 'node:test'
test('passes', () => {})
describe('a describe body throws', async () => { await new Promise(resolve => setTimeout(resolve, 10)); throw new Error('the body failed'); it('never registered', () => {}) })
`,
    // A test leaves a detached process, then waits past the bound, so what ends the file never runs its teardown.
    'left-running.test.mjs': `${head}import { spawn } from 'node:child_process'
test('leaves a detached process, then waits', async t => {
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(marker)}], { detached: true, stdio: 'ignore' }).unref()
  await until(t, never, 'a condition that never holds')
})
`,
  }
  for (const [name, text] of Object.entries(failing)) writeFileSync(join(root, name), text)
  // The runner keeps the folder of a file it ended before its teardown ran; the fixture teardown removes this one.
  const folders = mkdtempSync(join(tmpdir(), 'wait-runner-run-'))
  const { code, output } = await runnerRun(t, Object.keys(failing).map(name => join(root, name)), { GELIOS_TEST_TIMEOUT_MS: '3000', TMPDIR: folders })
  assert.notEqual(code, 0, output)
  for (const name of Object.keys(failing)) assert.match(output, new RegExp(`\\n  failed: ${join(root, name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `), output)
  // node:test bounds a test or hook that declares no timeout: on Node 18 and 22 by ending its file.
  assert.match(output, /test timed out after 3000ms/)
  assert.match(output, /still waiting for a condition that never holds when/)
  // What the cut file left was stopped: nothing runs with its marker.
  assert.doesNotMatch(execFileSync('/bin/ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf8' }), new RegExp(marker))
  // The runner names it, or on Node 24, where the test ends at its bound, the file's teardown does.
  assert.match(output, new RegExp(`stopped[^\\n]*${marker}`))
})

test('the test runner ends a file once its tests are done where node:test has forceExit, and at its bound on Node 18', { timeout: 120_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-runner-open-'))
  writeFileSync(join(root, 'open.test.mjs'), `import net from 'node:net'
import test from 'node:test'
test('leaves a server open', () => { net.createServer().listen(0, '127.0.0.1') })
`)
  const { code, output } = await runnerRun(t, [join(root, 'open.test.mjs')], { GELIOS_TEST_TIMEOUT_MS: '15000' })
  assert.match(output, /(\nok \d+ - |✔ )leaves a server open/)
  if (forceExit) assert.equal(code, 0, output)
  else {
    assert.notEqual(code, 0, output)
    assert.match(output, /\n  failed: [^\n]*open\.test\.mjs: failed/)
  }
})

test('the test runner passes a describe hook that declares its own bound, and a todo test that fails', { timeout: 120_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-runner-pass-'))
  writeFileSync(join(root, 'describe-hook-bound.test.mjs'), `import ${JSON.stringify(fixtures)}
import { before, describe, it } from 'node:test'
import { until } from ${JSON.stringify(helper)}
let ready = false
setTimeout(() => { ready = true }, 200)
describe('a describe whose before declares its own bound', { timeout: 30_000 }, () => {
  before(async s => { await until(s, () => ready, 'the condition to hold') }, { timeout: 30_000 })
  it('runs once the hook is done', () => {})
})
`)
  writeFileSync(join(root, 'todo.test.mjs'), `import test from 'node:test'
test('a todo test that fails', { todo: true }, () => { throw new Error('not done yet') })
`)
  const { code, output } = await runnerRun(t, [join(root, 'describe-hook-bound.test.mjs'), join(root, 'todo.test.mjs')])
  assert.equal(code, 0, output)
  assert.match(output, /(\nok \d+ - |✔ )runs once the hook is done/)
})

test('a test run fails naming what a test file left in its temporary folder', { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-leak-'))
  const scratch = join(root, 'leak.test.mjs')
  writeFileSync(scratch, `import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ${JSON.stringify(fixtures)}
test('leaves a folder in its temporary folder', () => { mkdirSync(join(tmpdir(), 'a-leaked-folder')) })
`)
  const { code, output } = await runnerRun(t, [scratch])
  // The runner keeps its folder to show what was left; this test removes it.
  const kept = /Test run left temporary entries in (\S+):/.exec(output)?.[1]
  if (kept && kept.startsWith(mark.TMPDIR + '/')) rmSync(kept, { recursive: true, force: true })
  assert.notEqual(code, 0, output)
  assert.match(output, /left temporary entries in [^\n]*: a-leaked-folder/)
  assert.ok(kept, output)
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
  assert.throws(() => exited({}, running), /needs the context of the test, hook, describe body or cleanup it runs in/)
  // A wait on a child that never exits ends at the bound of its test, naming the child.
  const root = mkdtempSync(join(tmpdir(), 'wait-exit-bound-'))
  const scratch = join(root, 'stuck.test.mjs')
  writeFileSync(scratch, `import test from 'node:test'
import { spawn } from ${JSON.stringify(fixtures)}
import { exited } from ${JSON.stringify(helper)}
test('a child that never exits', { timeout: 300 }, async t => {
  await exited(t, spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }))
})
`)
  const run = await scratchRun(t, scratch, 'the scratch file to end')
  assert.notEqual(run.code, 0, run.output)
  assert.match(run.output, /still waiting for process \d+ \(.*setInterval.*\) to exit when the test's bound ended/)
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
  assert.deepEqual(rules(`const tries = 0, nap = ms => new Promise(resolve => setTimeout(resolve, ms))
while (!ready) await nap(10)
`), ['2:poll'])
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

test('the check resolves node:events, sleeps and file reads through bindings in every spelling', () => {
  // node:events through destructuring and a dynamic import, optional and
  // computed calls, and an event held in a const; an event the check cannot
  // read on what may be no child passes (the next test refuses one on a child).
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
`), ['3:exit-listener', '5:exit-listener', '6:exit-listener', '7:exit-listener', '9:exit-listener'])
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

test('the check refuses a poll on an interval or by recursion and a late close listener on a child, by what the code does', () => {
  // An interval whose callback settles a promise, through the executor's
  // resolve or a name that holds it, or clears itself; a loop over an
  // interval, called there or held in a const. A heartbeat and a progress
  // line settle nothing.
  assert.deepEqual(rules(`await new Promise(resolve => { const id = setInterval(() => { if (ready()) { clearInterval(id); resolve() } }, 10) })
await new Promise(resolve => setInterval(() => ready() && resolve(), 10))
let done
const finished = new Promise(r => { done = r })
const id = setInterval(() => { if (ready()) done() }, 10)
const ticker = setInterval(() => monitor.tick(), 50)
await new Promise(resolve => { const beat = setInterval(() => ping(), 1000); server.once('done', () => { clearInterval(beat); resolve() }) })
import { setInterval as every } from 'node:timers/promises'
for await (const _ of every(10)) if (ready()) break
const ticks = every(10)
for await (const _ of ticks) if (ready()) break
`), ['1:poll', '2:poll', '5:poll', '9:poll', '11:poll'])
  // A cycle of calls that sleeps or schedules a timer: a function calling
  // itself, through a timer's callback or by name, mutual recursion, and a
  // method; a recursive walk that never pauses is no poll.
  assert.deepEqual(rules(`const sleep = ms => new Promise(r => setTimeout(r, ms))
const poll = async () => { if (!ready()) { await sleep(10); return poll() } }
function tick() { if (!ready()) setTimeout(tick, 10) }
const again = () => { if (!ready()) setTimeout(() => again(), 10) }
const soon = () => { if (!ready()) setImmediate(soon) }
async function a() { if (ready()) return; await sleep(10); return b() }
async function b() { return a() }
class P { async poll() { if (ready()) return; await sleep(10); return this.poll() } }
function walk(list) { return list.length ? walk(list.slice(1)) : 0 }
`), ['2:poll', '3:poll', '4:poll', '5:poll', '6:poll', '8:poll'])
  // A close listener on a child, a value traced to what started it in any
  // form, added after an await or in another function; one added where the
  // child starts, in a promise's executor included, and a server's or a
  // socket's pass.
  assert.deepEqual(rules(`import { once } from 'node:events'
import events from 'node:events'
import { spawn as run } from './fixtures.js'
const child = run(process.execPath, ['-e', ''])
const done = new Promise(resolve => child.once('close', resolve))
const watch = () => child.once('close', stop)
await tick()
child.on('close', code => record(code))
await events.once(child, 'close')
const launch = () => run('x')
const other = launch()
await tick()
other.once('close', stop)
let late
late = run('x')
await tick()
late.once('close', stop)
socket.once('close', stop)
async function stopServer(server) { server.close(); await once(server, 'close') }
async function drain(peer) { peer.end(); await once(peer, 'close') }
await once(nobody, 'close')
`), ['6:close-listener', '8:close-listener', '9:close-listener', '13:close-listener', '17:close-listener', '21:close-listener'])
  // An event the check cannot read is refused only on a child.
  assert.deepEqual(rules(`import { spawn } from './fixtures.js'
for (const name of ['data', 'end']) stream.on(name, record)
function relay(peer, type) { peer.on(type, payload => send(type, payload)) }
const child = spawn('x')
for (const name of ['exit', 'close']) child.on(name, record)
`), ['5:exit-listener'])
})

test('the check refuses a late close listener on a child another module of the folder starts', () => {
  const root = mkdtempSync(join(tmpdir(), 'wait-starts-'))
  mkdirSync(join(root, 'support'))
  writeFileSync(join(root, 'fixtures.js'), 'export { spawn } from "node:child_process"\n')
  writeFileSync(join(root, 'support', 'launch.js'), `import { spawn } from '../fixtures.js'
export function launch() { return spawn('x') }
export const relaunch = () => spawn('y')
export function stop(server) { server.close() }
`)
  writeFileSync(join(root, 'a.test.js'), `import { launch, relaunch } from './support/launch.js'
import * as helpers from './support/launch.js'
const one = launch()
await ready()
one.once('close', done)
const two = relaunch()
await ready()
two.on('close', done)
const three = helpers.launch()
await ready()
three.once('close', done)
const { launch: late } = await import('./support/launch.js')
const four = late()
await ready()
four.once('close', done)
const server = make()
await ready()
server.once('close', done)
import * as fixtures from './fixtures.js'
const five = fixtures.spawn('z')
await ready()
five.once('close', done)
`)
  assert.deepEqual(checkFolder(root).map(({ file, line, rule }) => `${file}:${line}:${rule}`),
    ['a.test.js:5:close-listener', 'a.test.js:8:close-listener', 'a.test.js:11:close-listener', 'a.test.js:15:close-listener', 'a.test.js:22:close-listener'])
})

test('the check fails closed on a test file it cannot read, and passes this folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'wait-check-'))
  mkdirSync(join(root, 'support'))
  writeFileSync(join(root, 'broken.test.js'), 'test(`unterminated\n')
  writeFileSync(join(root, 'support', 'helper.js'), 'export const ok = true\n')
  assert.deepEqual(checkFolder(root).map(({ file, rule }) => `${file}:${rule}`), ['broken.test.js:unreadable'])
  assert.deepEqual(checkFolder(folder), [])
})
