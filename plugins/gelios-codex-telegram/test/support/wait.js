// The one wait every test uses. A wait ends when its check holds or when the
// bound of what runs it ends, never on a clock of its own: a slow machine makes
// a test slower, never red. A test's or a hook's bound is the `timeout` it
// declares to node:test, which aborts its signal when it ends; a cleanup's
// bound is the `timeout` it declares to cleanup() below; and the test file's
// own bound (below) ends every wait still running in the file, whatever runs
// it, a describe body or a file's top level included, on every Node.
// Everything here runs in the test file's own process and reads nothing the
// test runner sets, so a file runs the same under plain node --test as under
// test/support/run-tests.js.
// test/support/check-waits.js reports a test file that polls on a clock of its
// own; it reads code, and bounds nothing.

import { after, test } from 'node:test'
import { stopProcessesIn } from './leftovers.js'

// Each poll pauses this long; the pause paces the checks and ends nothing.
const pause = 20

// A wait still running when its test file ends, such as one a test started
// and never awaited, ends then and names itself on the file's output. The hook
// never throws, and test/fixtures.js imports this file first, so the hook
// runs before the fixture teardown whatever order a test file imports them in.
const fileEnd = new AbortController()
const pending = new Set()
let fileEndName = 'the test file'
let fileEnded = false
after(() => {
  fileEnded = true
  for (const name of pending) process.stderr.write(`still waiting for ${name} when ${fileEndName} ended\n`)
  fileEnd.abort()
})

// The test file's own bound, from its start, in the file's own process:
// GELIOS_TEST_TIMEOUT_MS, or 20 minutes. Once the file has run that long,
// every wait still running, and every wait after, ends at once naming that
// bound, so the test or hook that waits fails and the file's teardown runs,
// and the file fails. Once it has run twice that long, as a file whose
// teardown never comes does, what the file left running, each process marked
// with its folder (test/fixtures.js hands it over below), is stopped and
// named, and the file ends. A bound past what one timer holds is waited out in
// turns; a value that is not a positive finite number of milliseconds, such
// as Infinity, means no bound. With --test-isolation=none every file runs in
// node --test's own process, which loads this file once, so the bound there
// counts from the run's start. A test that blocks its file's event loop, or a
// file that imports neither this file nor test/fixtures.js, has no bound here.
const fileBound = Number(process.env.GELIOS_TEST_TIMEOUT_MS) || 1_200_000
let ownFolder = null
// test/fixtures.js hands over the folder that marks every process its test
// file starts.
export function stopAtBound(folder) { ownFolder = folder }
// Calls `fn` once `ms` have passed since the process started, never keeping it alive.
function after_(ms, fn) {
  const left = ms - process.uptime() * 1000
  const turn = Math.min(Math.max(left, 0), 2 ** 31 - 1)
  setTimeout(() => (turn < left ? after_(ms, fn) : fn()), turn).unref()
}
if (fileBound > 0 && Number.isFinite(fileBound)) {
  after_(fileBound, () => {
    fileEndName = `the test file's bound of ${fileBound} ms`
    process.stderr.write(`test file ran past its bound of ${fileBound} ms\n`)
    process.on('exit', () => { process.exitCode = 1 })
    fileEnd.abort()
  })
  after_(2 * fileBound, async () => {
    let stopped = 'nothing it left running'
    if (ownFolder) {
      const { left, problems } = await stopProcessesIn(ownFolder)
      stopped = `${left.length} process(es) it left running: ` + left.map(({ pid, command }) => `${pid} (${command.slice(0, 240)})`).join('; ') + problems.map(problem => `; ${problem}`).join('')
    }
    process.stderr.write(`test file ran past twice its bound of ${fileBound} ms; stopped ${stopped}\n`)
    process.exit(1)
  })
}

// A wait that fails, or is refused, where node:test reports no failure of its
// own fails a test instead, so no file's tests vanish: on Node 22 a describe
// body that throws is reported as failed, yet its tests never register and
// the run passes. A describe body, a describe's hook and a context the code
// made have no test() of their own; there the wait registers a test that fails
// with its error, which node:test counts on every Node. A test's or a test
// hook's context, and a cleanup's, report the failure themselves, and a wait
// the end of its file cuts names itself (above).
const cleanupContexts = new WeakSet()
function failed(t, error) {
  if (fileEnded || typeof t?.test === 'function' || cleanupContexts.has(t)) return error
  test(`a wait failed where node:test reports no failure: ${String(error?.message).split('\n')[0]}`, () => { throw error })
  return error
}

// A wait ends with what runs it: it takes the context node:test hands a test,
// a hook or a describe body, or the one cleanup() hands a cleanup, and ends
// once that context's signal aborts. A wait handed no such signal fails at once.
function boundSignal(t, helper) {
  const signal = t?.signal
  if (!(signal instanceof AbortSignal)) throw new TypeError(`${helper} needs the context of the test, hook, describe body or cleanup it runs in`)
  return signal
}

// A wait cut at its bound names itself in the report of what ran it, or on the
// file's output where that context has no diagnostic(), as a describe body's
// has none on Node 18 and 22.
const note = (t, message) => typeof t.diagnostic === 'function' ? t.diagnostic(message) : process.stderr.write(`${message}\n`)

// Calls `cut` once either signal aborts; returns the function that stops listening.
function onEnd(signal, cut) {
  if (signal.aborted || fileEnd.signal.aborted) { cut(); return () => {} }
  const stop = () => { signal.removeEventListener('abort', fire); fileEnd.signal.removeEventListener('abort', fire) }
  const fire = () => { stop(); cut() }
  signal.addEventListener('abort', fire, { once: true })
  fileEnd.signal.addEventListener('abort', fire, { once: true })
  return stop
}

// Waits for `check` (sync or async) to return a truthy value and returns it.
// `t` is the test context, or the context cleanup() hands its function. `what`
// names the wait, or is a function that describes it when the bound ends. A
// check that throws fails the wait at once, unless `retry(error)` says the
// error means "not yet".
export async function until(t, check, what, options) {
  try { return await waitUntil(t, check, what, options) } catch (error) { throw failed(t, error) }
}
async function waitUntil(t, check, what, { retry = () => false } = {}) {
  const signal = boundSignal(t, 'until')
  const bound = typeof t.bound === 'string' ? t.bound : "the test's bound"
  if (typeof check !== 'function') throw new TypeError('until needs a check function')
  if (typeof what !== 'string' && typeof what !== 'function') throw new TypeError('until needs the name of what it waits for')
  let lastError, cut, timer
  const describe = () => { try { return typeof what === 'function' ? what() : what } catch (error) { return `a wait whose description failed: ${error.message}` } }
  const ended = new Promise((resolve, reject) => {
    cut = () => {
      const name = describe()
      const message = `still waiting for ${name} when ${signal.aborted ? bound : fileEndName} ended` + (lastError ? `; the last check failed with: ${lastError.message}` : '')
      // node:test reports a timed-out test with its own message, so the wait
      // names itself in the test's report as it is cut.
      note(t, message)
      reject(Object.assign(new Error(message), { cause: lastError }))
    }
  })
  ended.catch(() => {})
  const stop = onEnd(signal, () => cut())
  const entry = { toString: describe }
  pending.add(entry)
  try {
    for (;;) {
      let value
      const attempt = Promise.resolve().then(check)
      attempt.catch(() => {})
      try { value = await Promise.race([attempt, ended]) } catch (error) {
        if (signal.aborted || fileEnd.signal.aborted || !retry(error)) throw error
        lastError = error
      }
      if (value) return value
      await Promise.race([new Promise(resolve => { timer = setTimeout(resolve, pause) }), ended])
      clearTimeout(timer)
    }
  } finally {
    clearTimeout(timer)
    stop()
    pending.delete(entry)
  }
}

const cleanups = new WeakMap()

// Registers a cleanup that runs after test `t` under a bound of its own, named
// `what`. node:test hands an after hook the test's own context, whose signal
// has already aborted once the test's bound ended, so a wait there would end
// before its first check; and a failing after hook skips every hook registered
// after it. The cleanups of one test run in one after hook instead, in the
// order they were registered, each one even when an earlier one failed, and
// each ends when its own `timeout` ends. `fn` gets the cleanup's context for
// until(). The hook then fails naming every cleanup that failed.
export function cleanup(t, what, fn, { timeout } = {}) {
  if (typeof t?.after !== 'function' || typeof t.diagnostic !== 'function') throw failed(t, new TypeError('cleanup needs the test context it cleans up after'))
  if (typeof what !== 'string' || !what) throw failed(t, new TypeError('cleanup needs a name'))
  if (typeof fn !== 'function') throw failed(t, new TypeError('cleanup needs a function'))
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw failed(t, new TypeError(`the ${what} cleanup needs its timeout`))
  let list = cleanups.get(t)
  if (!list) {
    list = []
    cleanups.set(t, list)
    t.after(async () => {
      const failed = []
      for (const item of list) {
        const ended = new AbortController()
        const context = { signal: ended.signal, diagnostic: message => t.diagnostic(message), bound: `the bound of the ${item.what} cleanup` }
        cleanupContexts.add(context)
        let timer
        const cut = new Promise((resolve, reject) => {
          timer = setTimeout(() => { ended.abort(); reject(new Error(`the ${item.what} cleanup did not finish within its bound of ${item.timeout} ms`)) }, item.timeout)
        })
        cut.catch(() => {})
        const run = Promise.resolve().then(() => item.fn(context))
        run.catch(() => {})
        try { await Promise.race([run, cut]) } catch (error) { failed.push(`${item.what}: ${error.message}`) } finally { clearTimeout(timer) }
      }
      if (failed.length) throw new Error(`cleanup failed after the test: ${failed.join('; ')}`)
    })
  }
  list.push({ what, fn, timeout })
}

// Resolves with [code, signal] once `child` has exited, or rejects on its
// 'error' event. It reads an exit already recorded, so a wait that starts
// after the child exited still ends: a listener added only then would wait
// for an event that has already passed. Like until(), it ends at the bound of
// the context `t`, naming the child it waited on. Every test waits on a
// child's exit through it; test/support/check-waits.js refuses an 'exit'
// listener.
export function exited(t, child) {
  let signal
  try { signal = boundSignal(t, 'exited') } catch (error) { throw failed(t, error) }
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve([child.exitCode, child.signalCode])
  const bound = typeof t.bound === 'string' ? t.bound : "the test's bound"
  const name = `process ${child.pid ?? 'that never started'} (${child.spawnargs?.join(' ').slice(0, 120) ?? 'a child'}) to exit`
  return new Promise((resolve, reject) => {
    let stop = () => {}
    const finish = () => { child.off('exit', done); child.off('error', errored); stop(); pending.delete(name) }
    const done = (code, signalName) => { finish(); resolve([code, signalName]) }
    const errored = error => { finish(); reject(failed(t, error)) }
    const cut = () => {
      finish()
      const message = `still waiting for ${name} when ${signal.aborted ? bound : fileEndName} ended`
      note(t, message)
      reject(failed(t, new Error(message)))
    }
    if (signal.aborted || fileEnd.signal.aborted) { cut(); return }
    child.once('exit', done)
    child.once('error', errored)
    pending.add(name)
    stop = onEnd(signal, cut)
  })
}

// Resolves once `child` has exited and its output streams have closed, the
// moment its 'close' event marks, reading both from what is already recorded
// and ending at the bound of the context `t`, like exited().
export async function closed(t, child) {
  await exited(t, child)
  const open = (child.stdio || []).filter(stream => stream && typeof stream.once === 'function')
  await until(t, () => open.every(stream => stream.closed || stream.destroyed), `the output of process ${child.pid} to close`)
}

// A check's error that means the thing it reads is not there yet: a file or
// socket still missing, or a socket not yet listening.
export const notYetThere = error => ['ENOENT', 'ECONNREFUSED'].includes(error?.code)
