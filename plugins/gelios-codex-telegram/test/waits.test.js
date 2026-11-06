import assert from 'node:assert/strict'
import childProcess, { spawnSync as namedSpawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
const runnerPath = fileURLToPath(new URL('./support/run-tests.js', import.meta.url))
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
  assert.match(output, /the fixture cleanup hook in test\/fixtures\.js, for \S*leftover\.test\.mjs: stopped 2 process\(es\) this test file left running: /)
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
  // A context the code made, with no diagnostic(), as a describe body's on Node 18 and 22.
  const ended = new AbortController()
  const wait = until({ signal: ended.signal }, () => false, 'a condition that never holds')
  ended.abort()
  await assert.rejects(wait, /still waiting for a condition that never holds when the abort of the signal it was given ended/)
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

// Runs `args` through test/support/run-tests.js in `cwd`, or through plain
// node --test with `plain`, under the calling test's bound; `env` adds to the
// environment.
async function runIn(t, cwd, args, { env: extra = {}, plain = false } = {}) {
  const env = { ...process.env, ...extra }
  delete env.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, plain ? ['--test', ...args] : [runnerPath, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', part => { output += part }); child.stderr.on('data', part => { output += part })
  await closed(t, child)
  return { code: child.exitCode, output }
}
// Runs `args` in `cwd` through plain node --test and through the runner side
// by side, each with a temporary folder of its own, which it returns too.
async function bothRuns(t, cwd, args, env = {}) {
  const folders = { plain: mkdtempSync(join(tmpdir(), 'wait-plain-')), runner: mkdtempSync(join(tmpdir(), 'wait-run-')) }
  const [plain, runner] = await Promise.all(['plain', 'runner'].map(kind => runIn(t, cwd, args, { env: { ...env, TMPDIR: folders[kind] }, plain: kind === 'plain' })))
  return { plain, runner, folders }
}
const nodeMajor = Number(process.versions.node.split('.')[0])
const isolationNone = nodeMajor >= 23 ? '--test-isolation=none' : '--experimental-test-isolation=none'

// A run's output with what differs from one run to the next taken out:
// durations, times, the folder, an inspector's address, a random seed and
// the process id a warning names.
// Lines are sorted, and the dot reporter's marks, since files run side by
// side finish in either order.
const comparable = (output, cwd) => output.split(cwd + '/').join('').split(cwd).join('.')
  .replace(/duration_ms"?:? [\d.]+/g, 'duration_ms').replace(/\([\d.]+m?s\)/g, '(time)').replace(/time="[\d.]+"/g, 'time=""')
  .replace(/timestamp="[^"]*"/g, 'timestamp=""').replace(/hostname="[^"]*"/g, 'hostname=""').replace(/ws:\/\/\S+/g, 'ws://address')
  .replace(/[Rr]andom(ized)? (test order )?seed:? \d+/g, 'random seed').replace(/\(node:\d+\)/g, '(node:pid)')
  .replace(/^[.X]+$/gm, dots => [...dots].sort().join(''))
  .split('\n').map(line => line.trimEnd()).filter(Boolean).sort()
// Both runs alike: the same exit code and the same whole output, where the
// runner's only addition is main's: once node ends, it names what is left in
// its folder, as many entries as plain node --test leaves in its own, and
// fails the run.
function same(runs, label) {
  const message = `${label}\n--- plain\n${runs.plain.output}\n--- runner\n${runs.runner.output}`
  // Node 18's coverage folder stays where both runs leave it.
  const leftByPlain = readdirSync(runs.folders.plain).filter(name => !name.startsWith('node-coverage-')).length
  const leak = /^Test run left temporary entries in \S+:\n((?: {2}\S+\n)*)/m
  const named = leak.exec(runs.runner.output)?.[1].split('\n').filter(Boolean).length ?? 0
  assert.equal(named, leftByPlain, message)
  assert.deepEqual({ code: runs.runner.code, output: comparable(runs.runner.output.replace(leak, ''), runs.cwd) },
    { code: leftByPlain && !runs.plain.code ? 1 : runs.plain.code, output: comparable(runs.plain.output, runs.cwd) }, message)
}

test('the test file\'s own bound ends every wait whatever runs it, and a wait that fails where node:test reports no failure fails a test, under plain node --test and the test runner alike', { timeout: 120_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-bound-'))
  const marker = `left-by-a-cut-file-${process.pid}-${Date.now()}`
  const head = `import ${JSON.stringify(fixtures)}
import { before, describe, it, test } from 'node:test'
import { until } from ${JSON.stringify(helper)}
const never = () => false
`
  const leave = `spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(marker)}], { detached: true, stdio: 'ignore' }).unref()`
  const files = {
    'no-timeout.test.mjs': `${head}test('a test that declares no timeout waits', async t => { await until(t, never, 'a condition that never holds') })\n`,
    'file-hook.test.mjs': `${head}before(async t => { await until(t, never, 'a condition that never holds') })\ntest('after the hook', () => {})\n`,
    'file-hook-timeout.test.mjs': `${head}before(async t => { await until(t, never, 'a condition that never holds') }, { timeout: 1000 })\ntest('after the hook', () => {})\n`,
    'describe-body.test.mjs': `${head}describe('a describe body waits', async s => { await until(s, never, 'a condition that never holds'); it('never registered', () => {}) })\n`,
    'describe-hook.test.mjs': `${head}describe('a describe whose before waits', { timeout: 2000 }, () => { before(async s => { await until(s, never, 'a condition that never holds') }); it('x', () => {}) })\n`,
    'top-level.test.mjs': `${head}await until({ signal: new AbortController().signal }, never, 'a condition that never holds')\ntest('never registered', () => {})\n`,
    // On Node 22 node:test reports a describe body that throws as failed,
    // registers none of its tests and passes the run.
    'describe-refused.test.mjs': `${head}test('passes', () => {})\ndescribe('a describe body whose wait is refused', async () => { await until(undefined, never, 'a condition that never holds'); it('never registered', () => {}) })\n`,
    'describe-check.test.mjs': `${head}test('passes', () => {})\ndescribe('a describe body whose check throws', async s => { await until(s, () => { throw new Error('the check broke') }, 'a check that breaks'); it('never registered', () => {}) })\n`,
    // A test leaves a detached process, then waits past the bound: its teardown stops what it left.
    'left-running.test.mjs': `${head}import { spawn } from 'node:child_process'
test('leaves a detached process, then waits', async t => { ${leave}; await until(t, never, 'a condition that never holds') })
`,
    // A test leaves a detached process, then hangs outside any wait, so its teardown never comes.
    'left-hanging.test.mjs': `${head}import { spawn } from 'node:child_process'
test('leaves a detached process, then hangs outside any wait', async () => { ${leave}; setInterval(() => {}, 1000); await new Promise(() => {}) })
`,
    // A test leaves a server open, so its file never ends on its own.
    'open-handle.test.mjs': `${head}import net from 'node:net'\ntest('leaves a server open', () => { net.createServer().listen(0, '127.0.0.1') })\n`,
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
  // A 3 s bound, and 10 s where the file's teardown runs between the bound and
  // twice the bound: listing and stopping what a file left takes seconds on a
  // busy macOS runner.
  const bound = name => name === 'left-running.test.mjs' ? 10_000 : 3000
  const runs = await Promise.all(Object.keys(files).map(async name => [name, await bothRuns(t, root, [name], { GELIOS_TEST_TIMEOUT_MS: String(bound(name)) })]))
  // Every file in node --test's own process, where the bound counts from the run's start.
  if (nodeMajor >= 22) runs.push(['isolation none', await bothRuns(t, root, [isolationNone, '--test-concurrency=1', 'describe-body.test.mjs', 'file-hook.test.mjs'], { GELIOS_TEST_TIMEOUT_MS: '3000' })])
  for (const [name, both] of runs) {
    for (const kind of ['plain', 'runner']) {
      const { code, output } = both[kind]
      const label = `${kind}: ${name}\n${output}`
      assert.equal(code, 1, label)
      if (/refused|check/.test(name)) assert.match(output, /a wait failed in a describe body or a describe's hook: (until needs the context|the check broke)/, label)
      else if (/hanging|open-handle/.test(name)) assert.match(output, new RegExp(`test file ran past twice its bound of ${bound(name)} ms; stopped `), label)
      else if (!name.includes('hook-timeout')) assert.match(output, new RegExp(`test file ran past its bound of ${bound(name)} ms`), label)
      if (/hook|body|level|no-timeout|running|none/.test(name)) assert.match(output, /still waiting for a condition that never holds when/, label)
      if (name.includes('left-hanging')) assert.match(output, new RegExp(`stopped 1 process\\(es\\) it left running: [^\\n]*${marker}`), label)
      if (name.includes('left-running')) assert.match(output, new RegExp(`stopped 1 process\\(es\\) this test file left running: [^\\n]*${marker}`), label)
    }
  }
  // What the files left was stopped: nothing runs with the marker.
  assert.doesNotMatch(execFileSync('/bin/ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf8' }), new RegExp(marker))
})

test('a wait failure its caller handles fails nothing, and one no caller handles fails the run, named, under plain node --test and the test runner alike', { timeout: 300_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-handled-'))
  const head = `import ${JSON.stringify(fixtures)}
import { after, before, beforeEach, describe, it, test } from 'node:test'
import { cleanup, until } from ${JSON.stringify(helper)}
const broken = () => { throw new Error('the check broke') }
const never = () => false
`
  // A wait on a controller the code made, then ended.
  const made = "const ended = new AbortController(); const wait = until({ signal: ended.signal }, never, 'a condition that never holds'); ended.abort()"
  const handled = {
    'h-abort.test.mjs': `test('a test aborts a wait on a controller it made, and handles the rejection', async () => { ${made}; await wait.catch(() => {}) })\n`,
    'h-race.test.mjs': `test('a test races two waits and aborts the loser', async t => { let ready = false; setTimeout(() => { ready = true }, 50); const loser = new AbortController(); await Promise.race([until(t, () => ready, 'the time to pass'), until({ signal: loser.signal }, never, 'a condition that never holds')]); loser.abort() })\n`,
    'h-describe.test.mjs': `describe('a describe body catches its wait\\'s failure', async s => { await until(s, broken, 'a check that breaks').catch(() => {}); it('runs after', () => {}) })\n`,
    'h-module.test.mjs': `await until({ signal: AbortSignal.timeout(200) }, never, 'a condition that never holds').catch(() => {})\ntest('passes', () => {})\n`,
    'h-file-before.test.mjs': `before(async () => { ${made}; await wait.catch(() => {}) })\ntest('after the hook', () => {})\n`,
    'h-file-after.test.mjs': `test('passes', () => {})\nafter(async t => { await until(t, broken, 'a check that breaks').catch(() => {}) })\n`,
    'h-file-each.test.mjs': `beforeEach(async t => { await until(t, broken, 'a check that breaks').catch(() => {}) })\ntest('first', () => {})\ntest('second', () => {})\n`,
    'h-describe-before.test.mjs': `describe('a describe whose before catches its wait\\'s failure', () => { before(async s => { await until(s, broken, 'a check that breaks').catch(() => {}) }); it('inside', () => {}) })\n`,
    'h-describe-after.test.mjs': `describe('a describe whose after catches its wait\\'s failure', () => { it('inside', () => {}); after(async s => { await until(s, broken, 'a check that breaks').catch(() => {}) }) })\n`,
    'h-cleanup.test.mjs': `test('a cleanup catches its wait\\'s failure', t => { cleanup(t, 'a tolerant step', async hook => { await until(hook, broken, 'a check that breaks').catch(() => {}) }, { timeout: 5000 }) })\n`,
    'h-refused.test.mjs': `test('a test catches a refused wait', async () => { await until(undefined, never, 'a condition that never holds').catch(() => {}) })\ndescribe('a describe body catches a refused wait', async () => { await until(undefined, never, 'a condition that never holds').catch(() => {}); it('inside', () => {}) })\n`,
    'h-own.test.mjs': `test('a test catches its own wait\\'s failure', async t => { await until(t, broken, 'a check that breaks').catch(() => {}) })\n`,
  }
  const unhandled = {
    'u-describe.test.mjs': `test('passes', () => {})\ndescribe('a describe body whose check throws', async s => { await until(s, broken, 'a check that breaks'); it('never registered', () => {}) })\n`,
    'u-describe-before.test.mjs': `describe('a describe whose before fails', () => { before(async s => { await until(s, broken, 'a check that breaks') }); it('inside', () => {}) })\n`,
    'u-describe-before-alone.test.mjs': `test('passes', () => {})\ndescribe('a describe with no tests whose before fails', () => { before(async s => { await until(s, broken, 'a check that breaks') }) })\n`,
    'u-describe-after.test.mjs': `test('passes', () => {})\ndescribe('a describe whose after fails', () => { it('inside', () => {}); after(async s => { await until(s, broken, 'a check that breaks') }) })\n`,
    'u-made-test.test.mjs': `test('a test awaits a wait on a controller it made and ended', async () => { ${made}; await wait })\n`,
    'u-made-describe.test.mjs': `test('passes', () => {})\ndescribe('a describe body awaits a wait on a controller it made and ended', async () => { ${made}; await wait })\n`,
    'u-file-before.test.mjs': `before(async t => { await until(t, broken, 'a check that breaks') })\ntest('after the hook', () => {})\n`,
    // The end of the file, whose hook test/fixtures.js registers first, cuts
    // a wait a file-level after hook starts before its first check.
    'u-file-after-cut.test.mjs': `test('passes', () => {})\nafter(async t => { await until(t, broken, 'a check that breaks') })\n`,
    // A file-level beforeEach's wait fails once for each of a dozen tests.
    'u-file-each.test.mjs': `beforeEach(async t => { await until(t, broken, 'a check that breaks') })\n${Array.from({ length: 12 }, (_, k) => `test('test ${k}', () => {})\n`).join('')}`,
    'u-module.test.mjs': `await until({ signal: AbortSignal.timeout(200) }, never, 'a condition that never holds')\ntest('never registered', () => {})\n`,
    'u-unawaited.test.mjs': `test('passes', () => {})\ndescribe('a describe body starts a wait it never awaits', s => { until(s, broken, 'a check that breaks'); it('inside', () => {}) })\n`,
    'u-refused.test.mjs': `test('passes', () => {})\ndescribe('a describe body awaits a refused wait', async () => { await until(undefined, never, 'a condition that never holds') })\n`,
    'u-cleanup.test.mjs': `test('a cleanup\\'s wait fails', t => { cleanup(t, 'a step', async hook => { await until(hook, broken, 'a check that breaks') }, { timeout: 5000 }) })\n`,
  }
  // node:test's own, with no wait: on Node 22 the describe body and the
  // describe hook pass the run, and with --test-isolation=none on Node 22 and
  // 24 the file-level after hook does.
  const own = {
    'n-file-after.test.mjs': `test('passes', () => {})\nafter(() => { throw new Error('the hook failed') })\n`,
    'n-describe.test.mjs': `test('passes', () => {})\ndescribe('a describe body throws', () => { throw new Error('the body failed') })\n`,
    'n-describe-after.test.mjs': `test('passes', () => {})\ndescribe('a describe whose after throws', () => { it('inside', () => {}); after(() => { throw new Error('the hook failed') }) })\n`,
  }
  // Each of node:test's own also runs without the suite, to exit as it does.
  const bare = Object.fromEntries(Object.entries(own).map(([name, text]) => [name.replace('.test.mjs', '.bare.test.mjs'), "import { after, describe, it, test } from 'node:test'\n" + text]))
  writeFiles(root, { ...Object.fromEntries(Object.entries({ ...handled, ...unhandled, ...own }).map(([name, text]) => [name, head + text])), ...bare })
  const runs = []
  for (const name of Object.keys({ ...handled, ...unhandled, ...own, ...bare })) {
    runs.push([name, []])
    if (nodeMajor >= 22) runs.push([name, [isolationNone]])
  }
  // A name filter that matches no test of the describe.
  runs.push(['u-describe.test.mjs', ['--test-name-pattern=passes']])
  const results = []
  for (let k = 0; k < runs.length; k += 8) results.push(...await Promise.all(runs.slice(k, k + 8).map(async ([name, extra]) => [name, extra, await bothRuns(t, root, [...extra, name])])))
  // Every run is checked, and every miss reported with both outputs.
  const named = /a wait failed in a describe body or a describe's hook: /
  const misses = []
  for (const [name, extra, both] of results) {
    const run = [...extra, name].join(' ')
    const miss = what => misses.push(`${run}: ${what}\n--- plain\n${both.plain.output}\n--- runner\n${both.runner.output}`)
    if (both.runner.code !== both.plain.code) miss(`the runner exits ${both.runner.code}, plain node --test ${both.plain.code}`)
    for (const [kind, { code, output }] of Object.entries({ plain: both.plain, runner: both.runner })) {
      if (name.startsWith('h-') && code !== 0) miss(`${kind} exits ${code} for a handled failure`)
      if (!name.startsWith('u-') && named.test(output)) miss(`${kind} names a wait failure no wait left unhandled`)
      if (name.startsWith('u-') && code !== 1) miss(`${kind} exits ${code} for an unhandled failure`)
      if (name.startsWith('u-') && !/the check broke|until needs the context|still waiting for/.test(output)) miss(`${kind} does not say how the wait failed`)
      if (name.startsWith('u-') && /describe|refused/.test(name) && !named.test(output)) miss(`${kind} does not name the failure in a describe`)
      if (/MaxListenersExceededWarning/.test(output)) miss(`${kind} warns of more listeners than a process expects`)
    }
    const without = results.find(([other, more]) => other === name.replace('.test.mjs', '.bare.test.mjs') && other !== name && more.join(' ') === extra.join(' '))
    if (without && both.plain.code !== without[2].plain.code) miss(`exits ${both.plain.code} with the suite and ${without[2].plain.code} without it`)
  }
  assert.deepEqual(misses, [], misses.join('\n\n'))
})

test('node names itself in its own messages through the test runner as under plain node --test, by the name or the link it was started by', { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-name-'))
  const link = join(root, 'linked-node')
  symlinkSync(process.execPath, link)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const run = async (file, argv0, args) => {
    const child = spawn(file, args, { argv0, cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', part => { output += part }); child.stderr.on('data', part => { output += part })
    await closed(t, child)
    return { code: child.exitCode, output }
  }
  for (const [file, argv0, named] of [[process.execPath, 'node', /^node: bad option: --test-bogus$/m], [link, link, new RegExp(`^${link.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: bad option: --test-bogus$`, 'm')]]) {
    const [plain, runner] = await Promise.all([run(file, argv0, ['--test', '--test-bogus']), run(file, argv0, [runnerPath, '--test-bogus'])])
    const label = `${argv0}\n--- plain\n${plain.output}\n--- runner\n${runner.output}`
    assert.match(plain.output, named, label)
    assert.equal(runner.output, plain.output, label)
    assert.equal(runner.code, plain.code, label)
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
  const { code, output } = await runIn(t, root, ['describe-hook-bound.test.mjs', 'todo.test.mjs'])
  assert.equal(code, 0, output)
  assert.match(output, /(\n\s*ok \d+ - |✔ )runs once the hook is done/)
})

test('a given --test-timeout bounds each test as node does, for every value node accepts, and the test file\'s own bound stays as it is without one', { timeout: 120_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-timeout-'))
  const head = `import ${JSON.stringify(fixtures)}\nimport test from 'node:test'\nimport { until } from ${JSON.stringify(helper)}\n`
  // A wait that holds once `ms` have passed since it started.
  const waits = (name, ms, options = '') => `test(${JSON.stringify(name)}, ${options}async t => { let ready = false; setTimeout(() => { ready = true }, ${ms}); await until(t, () => ready, 'the time to pass') })\n`
  writeFiles(root, {
    // Each test fits a 3 s --test-timeout; together they run past it.
    'each-fits.test.mjs': `${head}${waits('first waits 2 s', 2000)}${waits('second waits 2 s', 2000)}`,
    'declared.test.mjs': `${head}${waits('first declares 10 s and waits 2 s', 2000, '{ timeout: 10_000 }, ')}${waits('second declares 10 s and waits 2 s', 2000, '{ timeout: 10_000 }, ')}`,
    'longer.test.mjs': `${head}${waits('declares 20 s and waits 5 s', 5000, '{ timeout: 20_000 }, ')}`,
    // The same with no wait helper.
    'sleeps.test.mjs': "import test from 'node:test'\ntest('declares 20 s and sleeps 5 s', { timeout: 20_000 }, async () => { await new Promise(resolve => setTimeout(resolve, 5000)) })\n",
    'holds.test.mjs': `${head}${waits('waits 200 ms', 200, '{ timeout: 30_000 }, ')}`,
    ...Object.fromEntries([1, 2, 3].map(n => [`w${n}.test.mjs`, `${head}${waits(`waits 1.5 s in file ${n}`, 1500, '{ timeout: 30_000 }, ')}`])),
  })
  // The file's own bound is far off, as it is by default, so only node's bounds act.
  const far = { GELIOS_TEST_TIMEOUT_MS: '600000' }
  const cases = [
    [['--test-timeout=3000', 'each-fits.test.mjs'], far], [['--test-timeout=3000', 'declared.test.mjs'], far], [['--test-timeout=3000', 'longer.test.mjs'], far],
    [['--test-timeout=3000', 'sleeps.test.mjs'], far],
    // A value node reads as no timeout, and one past what one timer holds.
    [['--test-timeout=Infinity', 'holds.test.mjs'], far], [[`--test-timeout=${2e9}`, 'holds.test.mjs'], far],
    // Every file in node --test's own process.
    [[isolationNone, '--test-concurrency=1', '--test-timeout=3000', 'w1.test.mjs', 'w2.test.mjs', 'w3.test.mjs'], far],
    // The file's own bound: one that means none, and one past what one timer holds.
    [['holds.test.mjs'], { GELIOS_TEST_TIMEOUT_MS: 'Infinity' }], [['holds.test.mjs'], { GELIOS_TEST_TIMEOUT_MS: `${2e9}` }],
  ]
  const runs = await Promise.all(cases.map(async ([args, env]) => [args, env, await bothRuns(t, root, args, env)]))
  for (const [args, env, both] of runs) same({ ...both, cwd: root }, `GELIOS_TEST_TIMEOUT_MS=${env.GELIOS_TEST_TIMEOUT_MS} ${args.join(' ')}`)
  // Node 24 bounds each test and no file, so each of these passes there; and
  // the file's own bound never ends a file that passes.
  if (nodeMajor >= 24) for (const [args, , both] of runs.slice(0, 4)) assert.equal(both.plain.code, 0, `${args.join(' ')}\n${both.plain.output}`)
  for (const [args, , both] of runs.slice(-2)) assert.equal(both.plain.code, 0, `${args.join(' ')}\n${both.plain.output}`)
})

// Reporters of every kind node loads: a function from a file, a class, and
// a package whose exports only an import reaches.
const reporterFiles = {
  'gen.mjs': "export default async function * fromFile(source) { for await (const e of source) if (/^test:(pass|fail)$/.test(e.type)) yield `file ${e.type} ${e.data.name}\\n` }\n",
  'my reporters/gen.mjs': "export default async function * spaced(source) { for await (const e of source) if (/^test:(pass|fail)$/.test(e.type)) yield `spaced ${e.type} ${e.data.name}\\n` }\n",
  'cls.mjs': "import { Transform } from 'node:stream'\nexport default class Lines extends Transform {\n  constructor() { super({ writableObjectMode: true }) }\n  _transform(e, _, done) { done(null, /^test:(pass|fail)$/.test(e.type) ? `class ${e.type} ${e.data.name}\\n` : undefined) }\n}\n",
  'node_modules/rep-esm/package.json': '{ "name": "rep-esm", "type": "module", "exports": { "import": "./index.js" } }\n',
  'node_modules/rep-esm/index.js': "export default async function * packaged(source) { for await (const e of source) if (/^test:(pass|fail)$/.test(e.type)) yield `package ${e.type} ${e.data.name}\\n` }\n",
}
function writeFiles(root, files) {
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text) }
}

test('the test runner hands node --test every argument as it is given, from the command line, NODE_OPTIONS and a config file alike, with the same whole output, files and exit', { timeout: 600_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-options-'))
  mkdirSync(join(root, 'sub')); mkdirSync(join(root, 'test'))
  const files = {
    'sel.test.mjs': "import test from 'node:test'\ntest('alpha one', () => {})\ntest('beta two', () => {})\ntest.only('gamma only', () => {})\ntest('a todo test that fails', { todo: true }, () => { throw new Error('not done yet') })\n",
    'fail.test.mjs': "import test from 'node:test'\ntest('delta fails', () => { throw new Error('delta') })\ntest('slow one', async () => { await new Promise(resolve => setTimeout(resolve, 400)) })\n",
    'sub/other-test.mjs': "import test from 'node:test'\ntest('epsilon sees the preload', () => { if (!globalThis.preloaded) throw new Error('no preload') })\ntest('zeta has gc', () => { if (typeof globalThis.gc !== 'function') throw new Error('no gc') })\n",
    'test/helper.mjs': "import test from 'node:test'\ntest('eta in a test folder', () => {})\n",
    'notatest.mjs': "import test from 'node:test'\ntest('theta never picked by default', () => {})\n",
    // A file node's --test-timeout ends, whatever the load: no default pattern picks it.
    'slow-case.mjs': "import test from 'node:test'\ntest('waits past its bound', async () => { await new Promise(resolve => setTimeout(resolve, 6000)) })\n",
    // On Node 22 node:test reports this describe failed, registers none of its tests and exits 0.
    'thrown-case.mjs': "import { describe, it, test } from 'node:test'\ntest('passes', () => {})\ndescribe('a describe body throws', () => { throw new Error('the body failed'); it('never registered', () => {}) })\n",
    'preload.cjs': 'globalThis.preloaded = true\n',
    'my preload.cjs': 'globalThis.preloaded = true\n',
    // A name holding pattern characters, beside the file that name matches as a pattern.
    'br[1].test.mjs': "import test from 'node:test'\ntest('iota fails', () => { throw new Error('iota') })\n",
    'br1.test.mjs': "import test from 'node:test'\ntest('kappa passes', () => {})\n",
    // A brace name, beside a file that name matches as a pattern.
    'st{a,b}.test.mjs': "import test from 'node:test'\ntest('lambda fails', () => { throw new Error('lambda') })\n",
    'sta.test.mjs': "import test from 'node:test'\ntest('mu passes', () => {})\n",
    'setup.mjs': "export async function globalSetup() { console.log('global setup ran') }\nexport async function globalTeardown() { console.log('global teardown ran') }\n",
    // Reporters node reads from a config file, where node has one.
    'cfg.json': '{ "test": { "test-reporter": "dot" } }\n',
    'cfg2.json': '{ "nodeOptions": { "test-reporter": ["./gen.mjs", "dot"], "test-reporter-destination": ["stdout", "out.dot"] } }\n',
    'node.config.json': '{ "test": { "test-reporter": "rep-esm" } }\n',
    // Reporters node cannot load or use.
    'throws.mjs': "throw new Error('the reporter broke')\n",
    'empty.mjs': 'export const nothing = 1\n',
    'on.mjs': "export default async function * onEvents(source) { source.on('test:pass', () => {}); for await (const e of source) yield '' }\n",
    // A reporter that counts each time a process loads it.
    'count.mjs': "import { appendFileSync } from 'node:fs'\nappendFileSync('loads.txt', `loaded\\n`)\nexport default async function * counted(source) { for await (const e of source) if (/^test:(pass|fail)$/.test(e.type)) yield `counted ${e.type} ${e.data.name}\\n` }\n",
    ...reporterFiles,
  }
  writeFiles(root, files)
  const tap = '--test-reporter=tap'
  const reports = ['out.tap', 'out.dot', 'out.xml', 'rerun.json', 'loads.txt']
  // Each case on every Node: where node lacks an option, both runs refuse it.
  const cases = [
    [[tap]], [[]], [[tap, '--test-name-pattern', 'alpha']], [[tap, '--test-name-pattern=/BETA/i']], [[tap, '--test-skip-pattern=alpha']],
    [[tap, '--test-only']], [[tap, '--test-shard=1/2']], [[tap, '--test-shard', '2/2']], [[tap, '--test-concurrency=1']],
    [[tap, '--test-timeout=2000', 'slow-case.mjs']], [[tap, '--test-timeout=Infinity']], [[tap, `--test-timeout=${2e9}`]], [[tap, '--test-force-exit']],
    [[tap, '--test-isolation=process']], [[tap, '--experimental-test-isolation=process']], [[tap, '--test-isolation=none', '--test-concurrency=1']],
    [[tap, '--experimental-test-isolation=none', '--test-concurrency=1']],
    [[tap, '--test-update-snapshots']], [[tap, '--experimental-test-module-mocks']], [[tap, '--test-random-seed=7']], [[tap, '--experimental-test-tag-filter=x']],
    [[tap, '--expose-gc']], [[tap, '--require', './preload.cjs']], [[tap, '-r', './preload.cjs']], [[tap, '--import', './preload.cjs']],
    [[tap, 'sel.test.mjs']], [[tap, 'sub']], [[tap, 'sub/*.mjs']], [[tap, 'notatest.mjs']], [[tap, 'test']], [[tap, 'missing.test.mjs']],
    [[tap, 'br[1].test.mjs']], [[tap, 'br[1].test.mjs', 'br1.test.mjs']], [[tap, 'st{a,b}.test.mjs']], [[tap, 'st{a,b}.test.mjs', 'sta.test.mjs']],
    [[tap, '--require', './preload.cjs', '--expose-gc']], [[tap, '--inspect=0', 'br1.test.mjs']], [[tap, '--watch-path=.', 'br1.test.mjs']],
    [['--test-reporter=spec']], [['--test-reporter=dot']], [['--test-reporter=junit']], [['--test-reporter=junit', '--test-reporter-destination=out.xml', 'sel.test.mjs', 'br1.test.mjs']],
    [[tap, '--test-reporter-destination=out.tap']], [[tap, '--test-reporter-destination=stdout', '--test-reporter=dot', '--test-reporter-destination=out.dot']],
    [['--test-reporter-destination=out.tap']], [[tap, '--test']],
    [[tap, '--experimental-test-coverage', '--test-concurrency=1']], [[tap, '--experimental-test-coverage', '--test-coverage-lines=100', '--test-concurrency=1']],
    [[tap, '--test-global-setup=./setup.mjs']], [[tap, '--test-rerun-failures=rerun.json']],
    [[tap], { NODE_OPTIONS: '--test-shard=2/2' }], [[], { NODE_OPTIONS: '--test-reporter=dot' }], [[tap], { NODE_OPTIONS: '--test-only' }],
    [[tap], { NODE_OPTIONS: '--test-name-pattern=alpha' }], [['--test-reporter=tap'], { NODE_OPTIONS: '--test-reporter=dot --test-reporter-destination=out.dot' }],
    [['--test-reporter-destination=stdout'], { NODE_OPTIONS: '--test-reporter=dot' }], [['--test-reporter-destination=out.dot'], { NODE_OPTIONS: '--test-reporter=tap --test-reporter=dot --test-reporter-destination=stdout' }],
    // Each kind of reporter, alone and beside another; in each form node
    // takes the option in; past a file name or --, where node reads it as a
    // pattern; three, where node itself warns of the listeners they add.
    [['--test-reporter=./gen.mjs']], [[`--test-reporter=${join(root, 'gen.mjs')}`]], [[`--test-reporter=${pathToFileURL(join(root, 'gen.mjs'))}`]],
    [['--test-reporter=rep-esm']], [['--test-reporter=./cls.mjs']], [['--test-reporter', 'dot']], [['--test_reporter=dot']],
    [['sel.test.mjs', '--test-reporter=dot']], [['--', '--test-reporter=dot']],
    [['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', '--test-reporter-destination=out.tap']],
    [['--test-reporter=./gen.mjs', '--test-reporter-destination=stdout', '--test-reporter=rep-esm', '--test-reporter-destination=out.tap']],
    [['--test-reporter=rep-esm', '--test-reporter-destination=stdout', '--test-reporter=dot', '--test-reporter-destination=out.dot']],
    [['--test-reporter=./cls.mjs', '--test-reporter-destination=out.tap', '--test-reporter=spec', '--test-reporter-destination=stdout']],
    [['--test-reporter=./nope.mjs', '--test-reporter-destination=stdout', '--test-reporter=dot', '--test-reporter-destination=out.dot']],
    [['--test-reporter=tap', '--test-reporter-destination=stdout', '--test-reporter=dot', '--test-reporter-destination=out.dot', '--test-reporter=junit', '--test-reporter-destination=out.xml']],
    [[], { NODE_OPTIONS: '--test-reporter="./my reporters/gen.mjs"' }], [[], { NODE_OPTIONS: '--test-reporter=rep-esm' }],
    [[], { NODE_OPTIONS: '--require "./my preload.cjs" --test-reporter=dot' }],
    [['--test-reporter=./gen.mjs', '--test-reporter-destination=out.tap'], { NODE_OPTIONS: '--test-reporter=rep-esm --test-reporter-destination=stdout' }],
    [['--experimental-config-file=cfg.json']], [['--experimental-config-file', 'cfg2.json']], [['--experimental-default-config-file']],
    [['--test-reporter=spec'], { NODE_OPTIONS: '--experimental-config-file=cfg.json' }],
    // Reporters node cannot load or use: the run fails with node's own error.
    [['--test-reporter=no-such-reporter', 'br1.test.mjs']], [['--test-reporter=./nope.mjs', 'br1.test.mjs']], [['--test-reporter=./throws.mjs', 'br1.test.mjs']], [['--test-reporter=./empty.mjs', 'br1.test.mjs']],
    [['--test-reporter=./on.mjs', 'br1.test.mjs']],
    // On Node 22 the run passes, as node:test's exit code says.
    [[tap, 'thrown-case.mjs']], [['--test-reporter=./gen.mjs', 'thrown-case.mjs']], [['thrown-case.mjs'], { NODE_OPTIONS: '--test-reporter=dot' }],
    // Options after which node exits before it runs anything.
    [['--version']], [['--v8-options']], [['--completion-bash']], [['--help']],
    // The permission model, where node has it.
    [[tap, '--permission', '--allow-fs-read=*', '--allow-child-process', 'br1.test.mjs']], [[tap, '--experimental-permission', '--allow-fs-read=*', '--allow-child-process', 'br1.test.mjs']],
    // A reporter's load-time code runs once, every file in node --test's own process or not.
    [['--test-reporter=./count.mjs', '--test-isolation=none', 'br1.test.mjs', 'sel.test.mjs']], [['--test-reporter=./count.mjs', '--experimental-test-isolation=none', 'br1.test.mjs', 'sel.test.mjs']],
    [['--test-reporter=./count.mjs', 'br1.test.mjs', 'sel.test.mjs']],
  ]
  const collect = run => {
    for (const name of reports) { try { run.output += `\n== ${name}\n${readFileSync(join(root, name), 'utf8')}`; rmSync(join(root, name)) } catch {} }
    return run
  }
  for (const [args, env = {}] of cases) {
    // One run at a time: both write their destinations into one folder.
    const folders = { plain: mkdtempSync(join(tmpdir(), 'wait-options-plain-')), runner: mkdtempSync(join(tmpdir(), 'wait-options-run-')) }
    const plain = collect(await runIn(t, root, args, { env: { ...env, TMPDIR: folders.plain }, plain: true }))
    const runner = collect(await runIn(t, root, args, { env: { ...env, TMPDIR: folders.runner } }))
    same({ plain, runner, folders, cwd: root }, `${Object.entries(env).map(([k, v]) => `${k}=${v} `).join('')}${args.join(' ')}`)
  }
})

test('a test file\'s children get the NODE_OPTIONS and environment the run was given, and the failure of a run one of them makes stays its own', { timeout: 120_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-children-'))
  // The file imports neither the fixtures nor the wait helper.
  writeFiles(root, {
    'child.test.mjs': `import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import test from 'node:test'
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
test('a child reports what it was given', () => {
  const seen = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ options: process.env.NODE_OPTIONS ?? null, names: Object.keys(process.env).sort() }))'], { env, encoding: 'utf8' })
  writeFileSync('seen.json', seen.stdout)
})
test('an inner node --test run over a failing file fails on its own', () => {
  const inner = spawnSync(process.execPath, ['--test', 'inner-case.mjs'], { env, encoding: 'utf8' })
  if (inner.status === 0) throw new Error('the inner run passed: ' + inner.stdout + inner.stderr)
})
`,
    'inner-case.mjs': "import test from 'node:test'\ntest('inner fails', () => { throw new Error('inner') })\n",
    'my preload.cjs': 'globalThis.preloaded = true\n',
  })
  // What the runner sets for every test file and its children, and what it takes out.
  const sets = ['TMP', 'TEMP', 'GELIOS_TELEGRAM_LAUNCHER_DIR', 'GELIOS_TELEGRAM_STATE_DIR']
  const removes = ['GELIOS_TELEGRAM_LAUNCHER_LINK', 'GELIOS_TELEGRAM_CONTROL_SOCKET', 'GELIOS_TELEGRAM_MCP_ROOT', 'GELIOS_TELEGRAM_INSTANCE_ID', 'GELIOS_TELEGRAM_SUPERVISED_CHILD', 'GELIOS_TELEGRAM_OWN_GROUP']
  for (const options of [undefined, '--test-reporter=dot', '--require "./my preload.cjs" --test-reporter=dot']) {
    const env = options === undefined ? {} : { NODE_OPTIONS: options }
    const seen = {}
    for (const kind of ['plain', 'runner']) {
      const run = await runIn(t, root, ['child.test.mjs'], { env: { ...env, TMPDIR: mkdtempSync(join(tmpdir(), `wait-children-${kind}-`)) }, plain: kind === 'plain' })
      let reported
      try { reported = JSON.parse(readFileSync(join(root, 'seen.json'), 'utf8')) } catch (error) { assert.fail(`${kind}, NODE_OPTIONS=${options}: ${error.message}\n${run.output}`) }
      seen[kind] = { ...run, ...reported }
      rmSync(join(root, 'seen.json'))
    }
    const label = `NODE_OPTIONS=${options}\n--- plain\n${seen.plain.output}\n--- runner\n${seen.runner.output}`
    assert.equal(seen.runner.code, 0, label)
    assert.equal(seen.plain.code, 0, label)
    assert.deepEqual(comparable(seen.runner.output, root), comparable(seen.plain.output, root), label)
    assert.equal(seen.runner.options, options ?? (process.env.NODE_OPTIONS ?? null), label)
    assert.equal(seen.plain.options, seen.runner.options, label)
    // Only names: the values of the environment never reach the output.
    assert.deepEqual(seen.runner.names.filter(name => !seen.plain.names.includes(name) && !sets.includes(name)), [], label)
    assert.deepEqual(seen.plain.names.filter(name => !seen.runner.names.includes(name) && !removes.includes(name) && !sets.includes(name)), [], label)
  }
})

test('a coverage report through the test runner is plain node --test\'s, over files that import the wait helper, and node leaves the same files behind', { timeout: 120_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-coverage-'))
  // Each step takes one path whatever the load: a check that holds at once,
  // one that holds on its third poll, and a cleanup.
  writeFileSync(join(root, 'covered.test.mjs'), `import ${JSON.stringify(fixtures)}
import test from 'node:test'
import { cleanup, until } from ${JSON.stringify(helper)}
test('waits', { timeout: 30_000 }, async t => {
  await until(t, () => true, 'a condition that holds at once')
  let polls = 0
  await until(t, () => ++polls >= 3, 'the third poll')
  cleanup(t, 'a step after the test', () => {}, { timeout: 5000 })
})
`)
  // Node 24 leaves the files of a test folder out of the report unless told otherwise.
  const measured = nodeMajor >= 22 ? ['--test-coverage-exclude=**/covered.test.mjs'] : []
  const runs = await bothRuns(t, root, ['--experimental-test-coverage', ...measured, '--test-reporter=tap', 'covered.test.mjs'])
  same({ ...runs, cwd: root }, 'coverage')
  assert.match(runs.plain.output, /# +(\S*\/)?wait\.js +\| +\d/)
  // Node 18 leaves its coverage folder in the temporary folder it was given.
  const left = folder => readdirSync(folder).map(name => name.replace(/^node-coverage-.*/, 'node-coverage-'))
  assert.deepEqual(left(runs.folders.runner), left(runs.folders.plain))
})

test('the test runner shows where to attach a debugger that waits, and hands a watched run to node whole', { timeout: 120_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wait-session-'))
  writeFileSync(join(root, 'a.test.mjs'), "import test from 'node:test'\ntest('lambda', () => {})\n")
  // Starts a session, waits until its output shows `ready`, then, after `then`
  // if given, until it shows `next`; returns the output, then stops it.
  const session = async (args, plain, ready, then, next) => {
    const env = { ...process.env, TMPDIR: mkdtempSync(join(tmpdir(), 'wait-session-run-')) }
    delete env.NODE_TEST_CONTEXT
    const child = spawn(process.execPath, plain ? ['--test', ...args] : [runnerPath, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', part => { output += part }); child.stderr.on('data', part => { output += part })
    // The session runs in a process group of its own (test/fixtures.js): stopping the group stops what it started.
    cleanup(t, 'a session left running', async hook => { try { process.kill(-child.pid, 'SIGKILL') } catch {} ; await exited(hook, child) }, { timeout: 10_000 })
    await until(t, () => ready.test(output), () => `the session to show ${ready}: ${output}`)
    if (then) { then(); await until(t, () => next.test(output.slice(output.search(ready) + 1)), () => `the session to show ${next} again: ${output}`) }
    return output
  }
  for (const plain of [true, false]) {
    const shown = await session(['--inspect-brk=0', 'a.test.mjs'], plain, /Debugger listening on ws:\/\/\S+/)
    assert.match(shown, /Debugger listening on ws:\/\/127\.0\.0\.1:\d+\//)
    const watched = await session(['--watch', '--test-reporter=tap', 'a.test.mjs'], plain, /ok \d+ - lambda/,
      () => writeFileSync(join(root, 'a.test.mjs'), "import test from 'node:test'\ntest('lambda', () => {})\ntest('mu after a change', () => {})\n"), /ok \d+ - mu after a change/)
    assert.match(watched, /ok \d+ - mu after a change/)
    writeFileSync(join(root, 'a.test.mjs'), "import test from 'node:test'\ntest('lambda', () => {})\n")
  }
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
  const { code, output } = await runIn(t, folder, [scratch])
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
