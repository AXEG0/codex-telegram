#!/usr/bin/env node
// Runs the tests as node --test runs them, with every argument node --test
// takes, in one node --test run over every file, as plain node --test does.
// Its additions:
// - the run's temporary folder, inside which each test file makes its own
//   (test/fixtures.js), and the bound test/support/wait.js keeps in each test
//   file's own process: GELIOS_TEST_TIMEOUT_MS, 20 minutes unless set, or the
//   --test-timeout node takes when one is given;
// - --test-force-exit where node has it, so a file ends once its tests are done;
// - its failure reporter, test/support/failures.js, in the place of one
//   reporter node takes, which it hands every event on to, so the run has
//   exactly the reporters node takes; it records each failure node:test
//   reports, a todo test aside, so the run fails on one whatever node's exit
//   code says: on Node 22 a describe whose body throws is reported as failed,
//   yet its tests never register and node exits 0;
// - once the run ends, it stops each process still marked with the run's
//   folder, naming it, and names whatever is left in the folder.
// Which options node takes, and which change puts the failure reporter in
// the place of one of node's, the runner learns from node itself
// (test/support/node-arguments.cjs), from every source node reads them from.
// A watched run is a person's session that never ends, so node --test gets
// it whole, with every argument and none of the runner's additions but its
// folder.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as builtins from 'node:test/reporters'
import { stopProcessesIn } from './leftovers.js'

const reader = fileURLToPath(new URL('./node-arguments.cjs', import.meta.url))
// The failure reporter goes to node as a data: URL, so Node 18, which counts
// the coverage of what node --test itself loads, leaves it out of a coverage
// report as it leaves out node's own modules.
const failureReporter = `data:text/javascript;base64,${readFileSync(new URL('./failures.js', import.meta.url)).toString('base64')}`
const [major, minor] = process.versions.node.split('.').map(Number)
const forceExit = major >= 22 || (major === 20 && minor >= 14)
const given = process.argv.slice(2)

// The runner's own files, outside the run's folder: what node takes, and the
// failures the run reports. Removed once the runner ends.
const own = mkdtempSync(join(tmpdir(), 'gco'))
process.on('exit', () => rmSync(own, { recursive: true, force: true }))
// Each test file makes its own folder inside this one (test/fixtures.js), so
// the name stays short: a Unix socket a test makes under it has a short limit.
const directory = mkdtempSync(join(tmpdir(), 'gct'))
// A test that forgets to scope MCP bootstrap must never write to the user's
// real command directory. Unclaimed launchers remain visible to the leak check.
const env = { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory,
  GELIOS_TELEGRAM_LAUNCHER_DIR: join(directory, 'unclaimed-launchers'),
  GELIOS_TELEGRAM_STATE_DIR: join(directory, 'unclaimed-state') }
// Tests never inherit a running installation's launcher, socket or build binding.
for (const name of ['GELIOS_TELEGRAM_LAUNCHER_LINK', 'GELIOS_TELEGRAM_CONTROL_SOCKET', 'GELIOS_TELEGRAM_MCP_ROOT',
  'GELIOS_TELEGRAM_INSTANCE_ID', 'GELIOS_TELEGRAM_SUPERVISED_CHILD', 'GELIOS_TELEGRAM_OWN_GROUP']) delete env[name]
// A regression test can invoke this runner from another Node test process.
delete env.NODE_TEST_CONTEXT

// NODE_OPTIONS as node splits it: at a space outside double quotes, a
// backslash inside them taking the next character as it is.
function splitNodeOptions(text) {
  const tokens = []
  let quoted = false, fresh = true
  for (let k = 0; k < text.length; k++) {
    let c = text[k]
    if (c === '\\' && quoted) c = text[++k] ?? ''
    else if (c === ' ' && !quoted) { fresh = true; continue } else if (c === '"') { quoted = !quoted; continue }
    if (fresh) { tokens.push(c); fresh = false } else tokens[tokens.length - 1] += c
  }
  return tokens
}
const joinNodeOptions = tokens => tokens.map(token => `"${token.replace(/[\\"]/g, '\\$&')}"`).join(' ')
const replaced = (list, k, value) => list.map((item, n) => (n === k ? value : item))

// The options node takes, as node itself reads them from the command line,
// NODE_OPTIONS and a config file. node --test starts no inspector in its own
// process, so an inspector option given here acts only in the run itself.
const givenOptions = env.NODE_OPTIONS === undefined ? undefined : splitNodeOptions(env.NODE_OPTIONS)
let reads = 0
function readOptions(argv, nodeOptions) {
  const file = join(own, `arguments-${reads++}.json`)
  const probeOptions = nodeOptions === undefined ? undefined
    : nodeOptions === givenOptions ? env.NODE_OPTIONS : joinNodeOptions(nodeOptions)
  // The reader loads first, so it exits before any module the options
  // preload runs: first in NODE_OPTIONS, which node loads ahead of the command
  // line's, where NODE_OPTIONS holds options; first on the command line
  // otherwise, since a NODE_OPTIONS that holds any keeps Node 22 from reading
  // a config file and Node 24 from reading its node options. With
  // --test-isolation=none, Node 24 loads the reporters before the reader, so
  // the runner's must load there too.
  const first = ['--require', reader]
  let front = first
  const probeEnv = { ...env, GELIOS_TEST_ARGUMENTS: file, GELIOS_TEST_REPORTER: 'tap', GELIOS_TEST_FAILURES: join(own, 'read-failures') }
  if (probeOptions === undefined) delete probeEnv.NODE_OPTIONS
  else if (nodeOptions.length) { probeEnv.NODE_OPTIONS = `${joinNodeOptions(first)} ${probeOptions}`; front = [] }
  else probeEnv.NODE_OPTIONS = probeOptions
  const probe = spawnSync(process.execPath, ['--expose-internals', ...front, '--test', ...argv],
    { env: probeEnv, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' })
  if (probe.status !== 0 || probe.signal) return { refused: probe }
  return JSON.parse(readFileSync(file, 'utf8'))
}
const takes = readOptions(given, givenOptions)
// node refused the arguments: it says why, with its own exit code.
if (takes.refused) { process.stderr.write(takes.refused.stderr); rmSync(directory, { recursive: true, force: true }); process.exit(takes.refused.status ?? 1) }

// The places node reads a reporter from, each with the runner's reporter put
// in the place of one reporter there: an option on the command line or in
// NODE_OPTIONS, or an entry of a config file, which the runner copies with
// that entry changed. node itself says which change took (see below).
const reporterOption = /^--test[-_]reporter(=|$)/
const configOption = /^--experimental[-_]config[-_]file(=|$)/
const defaultConfigOption = /^--experimental[-_]default[-_]config[-_]file$/
function * placesIn(tokens, place) {
  for (let k = 0; k < tokens.length; k++) {
    const option = reporterOption.exec(tokens[k])
    if (option?.[1] === '=') yield { ...place(replaced(tokens, k, `${tokens[k].slice(0, tokens[k].indexOf('='))}=${failureReporter}`)), value: tokens[k].slice(tokens[k].indexOf('=') + 1) }
    else if (option && k + 1 < tokens.length) yield { ...place(replaced(tokens, k + 1, failureReporter)), value: tokens[k + 1] }
  }
}
function * configPlacesIn(tokens, place) {
  for (let k = 0; k < tokens.length; k++) {
    const option = configOption.exec(tokens[k])
    const isDefault = defaultConfigOption.test(tokens[k])
    if (!option && !isDefault) continue
    const valueAt = option?.[1] === '=' ? k : k + 1
    const path = isDefault ? 'node.config.json' : option[1] === '=' ? tokens[k].slice(tokens[k].indexOf('=') + 1) : tokens[k + 1]
    let config
    try { config = JSON.parse(readFileSync(path, 'utf8')) } catch { continue }
    for (const scope of ['nodeOptions', 'test']) {
      const entry = config?.[scope]?.['test-reporter']
      const entries = Array.isArray(entry) ? entry : entry === undefined ? [] : [entry]
      for (let n = 0; n < entries.length; n++) {
        const copy = join(own, `config-${reads}-${scope}-${n}.json`)
        writeFileSync(copy, JSON.stringify({ ...config, [scope]: { ...config[scope], 'test-reporter': Array.isArray(entry) ? replaced(entry, n, failureReporter) : failureReporter } }))
        yield { ...place(isDefault ? replaced(tokens, k, `--experimental-config-file=${copy}`)
          : valueAt === k ? replaced(tokens, k, `${tokens[k].slice(0, tokens[k].indexOf('='))}=${copy}`) : replaced(tokens, valueAt, copy)), value: entries[n] }
      }
    }
  }
}

const failed = join(own, 'failures')
let args, environment = env
if (takes.watch) args = ['--test', ...given]
else {
  // The bound wait.js keeps in each test file's process: the --test-timeout
  // node takes, which node applies to each file too, else the runner's own.
  // With --test-isolation=none every file runs in node --test's own process,
  // where node bounds each test and no file, so the bound there is the
  // runner's own, for the whole run.
  const runnerBound = Number(process.env.GELIOS_TEST_TIMEOUT_MS) || 1_200_000
  environment = { ...env, GELIOS_TEST_FAILURES: failed,
    GELIOS_TEST_FILE_BOUND_MS: String(takes.isolation !== 'none' && takes.timeout > 0 ? takes.timeout : runnerBound) }
  const { reporters, destinations } = takes
  let front = [], argv = given
  if (!reporters.length && !destinations.length) {
    // node's own default reporter, to stdout, as node picks it.
    front = ['--test-reporter', failureReporter]
    environment.GELIOS_TEST_REPORTER = major >= 23 || process.stdout.isTTY ? 'spec' : 'tap'
  } else if (reporters.length === destinations.length || (reporters.length === 1 && !destinations.length)) {
    // The first change after which node takes the same reporters, the
    // runner's in one place, and the same destinations; a built-in reporter's
    // place first, since node always loads one, and only a reporter node
    // cannot load or use fails with the runner's reporter in its error's stack.
    const changes = [
      ...placesIn(given, tokens => ({ argv: tokens, nodeOptions: givenOptions })),
      ...(givenOptions ? placesIn(givenOptions, tokens => ({ argv: given, nodeOptions: tokens })) : []),
      ...configPlacesIn(given, tokens => ({ argv: tokens, nodeOptions: givenOptions })),
      ...(givenOptions ? configPlacesIn(givenOptions, tokens => ({ argv: given, nodeOptions: tokens })) : []),
    ].sort((one, other) => Object.hasOwn(builtins, other.value) - Object.hasOwn(builtins, one.value))
    let taken
    for (const change of changes) {
      const now = readOptions(change.argv, change.nodeOptions)
      if (now.refused || now.reporters.length !== reporters.length || JSON.stringify(now.destinations) !== JSON.stringify(destinations)) continue
      const differ = reporters.flatMap((name, n) => (now.reporters[n] === name ? [] : [n]))
      if (differ.length === 1 && now.reporters[differ[0]] === failureReporter) { taken = { ...change, name: reporters[differ[0]] }; break }
    }
    if (taken) {
      argv = taken.argv
      environment.GELIOS_TEST_REPORTER = taken.name
      if (taken.nodeOptions !== givenOptions) {
        // wait.js hands a test file's children the given NODE_OPTIONS back.
        environment.NODE_OPTIONS = joinNodeOptions(taken.nodeOptions)
        environment.GELIOS_TEST_GIVEN_NODE_OPTIONS = env.NODE_OPTIONS
      }
    } else process.stderr.write('test runner: no reporter option node takes could be changed for its failure reporter; node:test failures its exit code misses go unseen in this run\n')
  } // else node refuses the unpaired reporters, as it does without the runner
  args = ['--test', ...(forceExit ? ['--test-force-exit'] : []), ...front, ...argv]
}

const child = spawn(process.execPath, args, { env: environment, stdio: 'inherit' })
const ended = new Promise(done => {
  child.once('error', error => { process.stderr.write(`${error.message}\n`); done([1, null]) })
  child.once('close', (status, name) => done([status, name]))
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
const [code, signal] = await ended
const problems = []
let reported = ''
try { reported = readFileSync(failed, 'utf8').trim() } catch {}
if (code === 0 && reported) problems.push(`node:test reported ${reported.split('\n').length} failure(s) its exit code does not show: ${reported.split('\n').join('; ')}`)
// What still runs with the run's mark was left by a test file: one its
// teardown missed, or one a file ended at its bound left.
const { left, remaining, problems: stops } = await stopProcessesIn(directory)
// Node 18 leaves its coverage folder in the temporary folder it was given;
// it goes where node --test leaves it, the temporary folder the runner was given.
if (takes.coverage) for (const name of readdirSync(directory)) if (name.startsWith('node-coverage-')) renameSync(join(directory, name), join(tmpdir(), name))
problems.push(...stops)
if (left.length) problems.push(`stopped ${left.length} process(es) the test files left running: ` +
  left.map(({ pid, command }) => `${pid} (${command.length > 240 ? command.slice(0, 240) + '...' : command})`).join('; '))
if (remaining?.length !== 0) problems.push(`processes marked with ${directory} still run; keeping the folder`)
else {
  const entries = readdirSync(directory)
  if (entries.length) {
    problems.push(`Test run left temporary entries in ${directory}:\n` + entries.map(name => `  ${name}`).join('\n'))
  } else {
    // Removing an empty runner directory cannot conceal a leaked fixture.
    rmdirSync(directory)
  }
}
for (const problem of problems) process.stderr.write(`${problem}\n`)
process.exitCode = code !== 0 ? (code ?? 1) : signal || problems.length ? 1 : 0
