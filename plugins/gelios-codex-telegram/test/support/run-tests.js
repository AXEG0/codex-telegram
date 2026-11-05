#!/usr/bin/env node
// Runs test files the way node --test runs them, each file in its own node
// --test process with its own temporary folder, and bounds each one on every
// Node: node:test bounds the tests and hooks in it where it has --test-timeout
// (Node 20.11 and later, 22 and 24; on 22 that also ends the file), and this
// runner ends a file that runs on past twice that bound, or past the bound
// itself on Node 18, which has no such option. After a file ends, however it
// ends, the runner stops every process still marked with the file's folder
// (test/fixtures.js marks each child a test file starts), and fails the run
// naming each, and names whatever the file left in its folder. A failure
// node:test reports fails the file whatever node's exit code says
// (test/support/failures.js).
//
// Usage: run-tests.js [NODE-OPTION...] [FILE-OR-PATTERN...], the arguments
// node --test takes. node itself reads them and picks the test files
// (test/support/node-arguments.cjs), so each means what it means to node
// --test on the Node that runs; an option node refuses, node refuses here too.
// --test-shard picks the files, --test-concurrency is how many run at once,
// and each reporter writes every file's report, a file destination getting
// each file's report whole once the file ends. Refused, naming why: watch
// mode, coverage, test isolation, --test-global-setup and --test-rerun-failures,
// which each mean something only for a run of every file in one node --test
// process.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopProcessesIn } from './leftovers.js'

const reader = fileURLToPath(new URL('./node-arguments.cjs', import.meta.url))
const failureReporter = fileURLToPath(new URL('./failures.js', import.meta.url))
const [major, minor] = process.versions.node.split('.').map(Number)
const testTimeout = major >= 21 || (major === 20 && minor >= 11)
const forceExit = major >= 22 || (major === 20 && minor >= 14)
const given = process.argv.slice(2)
const fail = (message, code = 1) => { process.stderr.write(`run-tests.js: ${message}\n`); process.exit(code) }

// Refused with the exit code node gives arguments it refuses. Watch mode is
// refused before node reads the arguments, since node would then watch; the
// others after, so a Node without one of them refuses it as node --test does.
const refuse = (arg, why) => fail(`${arg.split('=')[0]} is refused: ${why}`, 9)
for (const arg of given) if (/^--watch/.test(arg)) refuse(arg, 'watch mode reruns files as they change, and the runner checks each file once it ends, which in watch mode it never does')
const meaningful = [
  [/^--(?:experimental-test-coverage|test-coverage-)/, 'coverage is measured over a whole run, and each file runs alone, so each would report, and be held to a threshold for, only what it covers'],
  [/^--(?:experimental-)?test-isolation/, 'it runs every file in one process, and the runner runs each file alone, in a process of its own'],
  [/^--test-global-setup/, 'global setup runs once around a whole run, and each file runs alone, so it would run once per file'],
  [/^--test-rerun-failures/, 'its state file records a whole run, and each file runs alone, so each would overwrite it with its own'],
]

// Tests never inherit a running installation's launcher, socket or build binding.
const base = { ...process.env }
for (const name of ['GELIOS_TELEGRAM_LAUNCHER_LINK', 'GELIOS_TELEGRAM_CONTROL_SOCKET', 'GELIOS_TELEGRAM_MCP_ROOT',
  'GELIOS_TELEGRAM_INSTANCE_ID', 'GELIOS_TELEGRAM_SUPERVISED_CHILD', 'GELIOS_TELEGRAM_OWN_GROUP']) delete base[name]
// A regression test can invoke this runner from another Node test process.
delete base.NODE_TEST_CONTEXT

// The runner's own files: what node made of the arguments, the files it
// picked, and each file's failures and reports, removed once the run ends.
const own = mkdtempSync(join(tmpdir(), 'gco'))
process.on('exit', () => rmSync(own, { recursive: true, force: true }))
// Runs node --test with the reader loaded first; returns what it recorded.
function read(args, only) {
  const record = join(own, `arguments-${only ? 'parse' : 'files'}.jsonl`)
  const result = spawnSync(process.execPath, ['--require', reader, '--test', ...args], {
    env: { ...base, GELIOS_TEST_ARGUMENTS: record, ...(only ? { GELIOS_TEST_ARGUMENTS_ONLY: '1' } : {}) },
    stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
  })
  let lines = []
  try { lines = readFileSync(record, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch {}
  // node refused the arguments, or found no file a pattern names.
  if (result.status !== 0 || result.signal) { process.stderr.write(result.stderr); process.exit(result.status ?? 1) }
  return lines
}
const [parsed] = read(given, true)
// node's options, as node split them, without the reader and --test.
const options = parsed.execArgv.slice(2).filter(arg => arg !== '--test')
for (const arg of options) for (const [shape, why] of meaningful) if (shape.test(arg)) refuse(arg, why)
const patterns = parsed.argv
// Takes out every value an option has, in either form, from `list`.
function take(list, name) {
  const values = [], rest = []
  for (let k = 0; k < list.length; k++) {
    if (list[k] === name) values.push(list[++k])
    else if (list[k].startsWith(`${name}=`)) values.push(list[k].slice(name.length + 1))
    else rest.push(list[k])
  }
  return [values, rest]
}
let rest = options
let reporters, destinations, shards, concurrency, timeouts
;[reporters, rest] = take(rest, '--test-reporter')
;[destinations, rest] = take(rest, '--test-reporter-destination')
;[shards, rest] = take(rest, '--test-shard')
;[concurrency, rest] = take(rest, '--test-concurrency')
;[timeouts] = take(rest, '--test-timeout')
// The files node --test picks from the patterns, a shard included.
const files = [...new Set(read([...rest, ...shards.map(value => `--test-shard=${value}`), ...patterns], false).filter(line => line.file).map(line => line.file))]
if (!files.length) fail('node --test picked no test file from these arguments')

// The bound node:test gives every test and hook that declares no timeout:
// --test-timeout when given, else GELIOS_TEST_TIMEOUT_MS, else 20 minutes.
const bound = Number(timeouts.at(-1)) || Number(process.env.GELIOS_TEST_TIMEOUT_MS) || 1_200_000
// A test that runs out of its bound reports, and its file tears down, before
// the runner ends the file; where node:test has no bound, the runner's is it.
const fileBound = testTimeout ? 2 * bound : bound
// node --test's own default reporter, chosen for this runner's output.
if (!reporters.length && !destinations.length) reporters = [major >= 23 || process.stdout.isTTY ? 'spec' : 'tap']
if (reporters.length === 1 && !destinations.length) destinations = ['stdout']
// A file destination is emptied once, and gets each file's report appended.
for (const destination of destinations) if (!['stdout', 'stderr'].includes(destination)) writeFileSync(resolve(destination), '')
const defaults = [...(testTimeout ? [`--test-timeout=${bound}`] : []), ...(forceExit ? ['--test-force-exit'] : [])]

const failures = []
const running = new Set()
let stopping = false, refused = null, sequence = 0
// A file inside the working folder goes by its path from there, as node --test names the files it picks.
const shown = file => { const path = relative(process.cwd(), file); return path && !path.startsWith('..') && !isAbsolute(path) ? path : file }
const named = list => list.map(({ pid, command }) => `${pid} (${command.length > 240 ? command.slice(0, 240) + '...' : command})`).join('; ')

async function runFile(file) {
  const n = sequence++
  // Each test file makes its own folder inside this one (test/fixtures.js), so
  // the name stays short: a Unix socket a test makes under it has a short limit.
  const directory = mkdtempSync(join(tmpdir(), 'gct'))
  // A test that forgets to scope MCP bootstrap must never write to the user's
  // real command directory. Unclaimed launchers remain visible to the leak check.
  const env = { ...base, GELIOS_TEST_TIMEOUT_MS: String(bound), TMPDIR: directory, TMP: directory, TEMP: directory,
    GELIOS_TELEGRAM_LAUNCHER_DIR: join(directory, 'unclaimed-launchers'),
    GELIOS_TELEGRAM_STATE_DIR: join(directory, 'unclaimed-state') }
  const report = destinations.map((destination, k) => ['stdout', 'stderr'].includes(destination) ? destination : join(own, `report-${n}-${k}`))
  const failed = join(own, `failures-${n}`)
  const args = ['--test', ...defaults, ...rest,
    ...reporters.flatMap(name => ['--test-reporter', name]), ...report.flatMap(path => ['--test-reporter-destination', path]),
    '--test-reporter', failureReporter, '--test-reporter-destination', failed, shown(file)]
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  running.add(child)
  // Each file's output is printed whole once the file ends.
  const out = [], err = []
  child.stdout.on('data', part => out.push(part)); child.stderr.on('data', part => err.push(part))
  const problems = []
  const closed = new Promise(done => {
    child.once('error', error => { problems.push(`could not start: ${error.message}`); done(null) })
    child.once('close', (code, signal) => done({ code, signal }))
  })
  let timer
  const past = new Promise(done => { timer = setTimeout(() => done('past'), fileBound) })
  let ended = await Promise.race([closed, past])
  clearTimeout(timer)
  if (ended === 'past') {
    // The file's own processes carry its mark too, so this ends the file.
    const { left, problems: failedStops } = await stopProcessesIn(directory)
    problems.push(`ran past its bound of ${fileBound} ms, so the runner ended it, stopping ${left.length} process(es) marked with its folder: ` + named(left), ...failedStops)
    ended = await closed
  }
  running.delete(child)
  // node exits 9 on arguments it refuses; the run stops there, as node --test does.
  if (ended?.code === 9) refused ??= Buffer.concat(err).toString()
  if (ended && (ended.code !== 0 || ended.signal)) problems.push(`failed (${ended.signal ? `signal ${ended.signal}` : `exit code ${ended.code}`})`)
  let reported = ''
  try { reported = readFileSync(failed, 'utf8') } catch {}
  if (reported) problems.push(`node:test reported ${reported.trim().split('\n').length} failure(s): ${reported.trim().split('\n').join('; ')}`)
  // What still runs with the file's mark was left by the file: a process a
  // file the bound ended left, or one its teardown missed.
  const { left, remaining, problems: failedStops } = await stopProcessesIn(directory)
  problems.push(...failedStops)
  if (left.length) problems.push(`left ${left.length} process(es) running, which the runner stopped: ` + named(left))
  let leaked = ''
  if (remaining?.length !== 0) problems.push(`processes marked with ${directory} still run; keeping the folder`)
  else {
    const entries = readdirSync(directory)
    if (entries.length) {
      leaked = `Test run left temporary entries in ${directory}:\n` + entries.map(name => `  ${name}\n`).join('')
      problems.push(`left temporary entries in ${directory}`)
    } else {
      // Removing an empty folder cannot conceal a leaked fixture.
      rmdirSync(directory)
    }
  }
  process.stdout.write(Buffer.concat(out))
  process.stderr.write(Buffer.concat(err))
  report.forEach((path, k) => { if (path !== destinations[k]) { try { appendFileSync(resolve(destinations[k]), readFileSync(path)) } catch {} } })
  process.stderr.write(leaked)
  if (problems.length) {
    failures.push({ file, problems })
    process.stderr.write(`Test file ${file}: ${problems.join('; ')}\n`)
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; for (const child of running) child.kill(signal); process.exitCode = 1 })

// As many files run at once as node --test runs: --test-concurrency when
// given, else one fewer than the processors; one while an inspector is asked for.
const inspecting = rest.some(arg => /^--inspect/.test(arg))
const width = inspecting ? 1 : Number(concurrency.at(-1)) || Math.max(1, availableParallelism() - 1)
const queue = [...files]
const workers = Array.from({ length: Math.max(1, Math.min(queue.length, width)) }, async () => {
  while (queue.length && !stopping && refused === null) await runFile(queue.shift())
})
await Promise.all(workers)
if (refused !== null) {
  process.exitCode = 9
} else if (failures.length) {
  process.stderr.write(`\n${failures.length} of ${files.length} test file(s) failed:\n` +
    failures.map(({ file, problems }) => `  failed: ${file}: ${problems.join('; ')}\n`).join(''))
  process.exitCode = 1
} else if (!stopping) process.exitCode = 0
