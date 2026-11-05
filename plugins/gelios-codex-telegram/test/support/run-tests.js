#!/usr/bin/env node
// Runs test files, each in its own process with its own temporary folder, and
// bounds each one on every Node: node:test bounds the tests and hooks in it
// (test/support/run-file.js), and this runner ends a file that runs on past
// twice that bound, which a describe body that waits on Node 24 can. After a
// file ends, however it ends, the runner stops every process still marked
// with the file's folder (test/fixtures.js marks each child a test file
// starts), and fails the run naming each, and names whatever the file left in
// its folder.
// Usage: run-tests.js [--test-reporter=spec|tap|dot] [--test-name-pattern=NAME]...
//   [--test-skip-pattern=NAME]... [--test-only] FILE...
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmdirSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopProcessesIn } from './leftovers.js'

const host = fileURLToPath(new URL('./run-file.js', import.meta.url))
let reporter = 'spec'
const files = [], options = []
for (const arg of process.argv.slice(2)) {
  const named = /^--test-reporter=(.+)$/.exec(arg)
  if (named) reporter = named[1]
  else if (/^--test-(?:name-pattern|skip-pattern)=.|^--test-only$/.test(arg)) options.push(arg)
  else if (arg.startsWith('-')) throw new Error(`run-tests.js takes --test-reporter=NAME, --test-name-pattern=NAME, --test-skip-pattern=NAME and --test-only, not ${arg}`)
  else files.push(resolve(arg))
}
if (!files.length) throw new Error('run-tests.js needs the test files to run')
// The bound node:test gives every test and hook that declares no timeout.
const bound = Number(process.env.GELIOS_TEST_TIMEOUT_MS) || 1_200_000
// A test that runs out of its bound reports, and its file tears down, before
// the runner ends the file.
const fileBound = 2 * bound

const base = { ...process.env, GELIOS_TEST_TIMEOUT_MS: String(bound) }
// Tests never inherit a running installation's launcher, socket or build binding.
for (const name of ['GELIOS_TELEGRAM_LAUNCHER_LINK', 'GELIOS_TELEGRAM_CONTROL_SOCKET', 'GELIOS_TELEGRAM_MCP_ROOT',
  'GELIOS_TELEGRAM_INSTANCE_ID', 'GELIOS_TELEGRAM_SUPERVISED_CHILD', 'GELIOS_TELEGRAM_OWN_GROUP']) delete base[name]
// A regression test can invoke this runner from another Node test process.
delete base.NODE_TEST_CONTEXT

const failures = []
const running = new Set()
let stopping = false

const named = list => list.map(({ pid, command }) => `${pid} (${command.length > 240 ? command.slice(0, 240) + '...' : command})`).join('; ')

async function runFile(file) {
  // Each test file makes its own folder inside this one (test/fixtures.js), so
  // the name stays short: a Unix socket a test makes under it has a short limit.
  const directory = mkdtempSync(join(tmpdir(), 'gct'))
  // A test that forgets to scope MCP bootstrap must never write to the user's
  // real command directory. Unclaimed launchers remain visible to the leak check.
  const env = { ...base, TMPDIR: directory, TMP: directory, TEMP: directory,
    GELIOS_TELEGRAM_LAUNCHER_DIR: join(directory, 'unclaimed-launchers'),
    GELIOS_TELEGRAM_STATE_DIR: join(directory, 'unclaimed-state') }
  const child = spawn(process.execPath, [host, file, reporter, ...options], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  running.add(child)
  // Each file's output is printed whole once the file ends.
  const output = []
  child.stdout.on('data', part => output.push(part)); child.stderr.on('data', part => output.push(part))
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
    // The file's own process carries its mark too, so this ends the file.
    const { left, problems: failed } = await stopProcessesIn(directory)
    problems.push(`ran past its bound of ${fileBound} ms, so the runner ended it, stopping ${left.length} process(es) marked with its folder: ` + named(left), ...failed)
    ended = await closed
  }
  running.delete(child)
  if (ended && (ended.code !== 0 || ended.signal)) problems.push(`failed (${ended.signal ? `signal ${ended.signal}` : `exit code ${ended.code}`})`)
  // What still runs with the file's mark was left by the file: a process a
  // file the bound ended left, or one its teardown missed.
  const { left, remaining, problems: failed } = await stopProcessesIn(directory)
  problems.push(...failed)
  if (left.length) problems.push(`left ${left.length} process(es) running, which the runner stopped: ` + named(left))
  const text = Buffer.concat(output).toString()
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
  process.stdout.write(text.endsWith('\n') || !text ? text : text + '\n')
  process.stderr.write(leaked)
  if (problems.length) {
    failures.push({ file, problems })
    process.stderr.write(`Test file ${file}: ${problems.join('; ')}\n`)
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; for (const child of running) child.kill(signal); process.exitCode = 1 })

// As many files run at once as node --test runs.
const queue = [...files]
const workers = Array.from({ length: Math.max(1, Math.min(queue.length, availableParallelism() - 1)) }, async () => {
  while (queue.length && !stopping) await runFile(queue.shift())
})
await Promise.all(workers)
if (failures.length) {
  process.stderr.write(`\n${failures.length} of ${files.length} test file(s) failed:\n` +
    failures.map(({ file, problems }) => `  failed: ${file}: ${problems.join('; ')}\n`).join(''))
  process.exitCode = 1
} else if (!stopping) process.exitCode = 0
