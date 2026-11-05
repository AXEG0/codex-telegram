#!/usr/bin/env node
// Runs one test file for test/support/run-tests.js through node:test's own
// run(), and exits 1 on any failure node:test reports for it. node:test's exit
// code alone can miss one: on Node 22 a describe whose body throws is reported
// as failed, yet its tests never register and the run exits 0.
import { run } from 'node:test'
import * as reporters from 'node:test/reporters'

const [file, reporterName, ...options] = process.argv.slice(2)
const [major, minor] = process.versions.node.split('.').map(Number)
// The options test/support/run-tests.js passes on, which node:test hands each
// test file's process. A Node without one refuses it, as node --test does.
if (options.some(arg => arg.startsWith('--test-skip-pattern=')) && !(major > 22 || (major === 22 && minor >= 1))) throw new Error(`node ${process.version} has no --test-skip-pattern`)
const patterns = name => options.filter(arg => arg.startsWith(`--test-${name}-pattern=`)).map(arg => arg.slice(arg.indexOf('=') + 1))
const selection = {
  ...(patterns('name').length ? { testNamePatterns: patterns('name') } : {}),
  ...(patterns('skip').length ? { testSkipPatterns: patterns('skip') } : {}),
  ...(options.includes('--test-only') ? { only: true } : {}),
}
const bound = Number(process.env.GELIOS_TEST_TIMEOUT_MS)
if (!file || !Number.isSafeInteger(bound) || bound < 1) throw new Error('run-file.js runs one test file for test/support/run-tests.js')
if (!Object.hasOwn(reporters, reporterName)) throw new Error(`node:test has no ${reporterName} reporter`)
// node:test gives every test and hook that declares no timeout this bound; on
// Node 18 and 22 it also ends the whole file once the file runs out of it.
// forceExit, where node:test has it, ends the file once its tests and hooks
// are done, whatever still runs in it.
const forceExit = major >= 22 || (major === 20 && minor >= 14)
const stream = run({ files: [file], timeout: bound, ...(forceExit ? { forceExit } : {}), ...selection })
// A todo test that fails is reported, and fails nothing.
stream.on('test:fail', data => { if (!data.todo) process.exitCode = 1 })
// The spec reporter is a class; the others are functions of the event stream.
stream.compose(reporterName === 'spec' ? new reporters.spec() : reporters[reporterName]).pipe(process.stdout)
