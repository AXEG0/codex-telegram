// The one wait every test uses. A wait ends when its check holds or when the
// bound of the test or cleanup running it ends, never on a clock of its own: a
// slow machine makes a test slower, never red. A test's bound is the `timeout`
// it declares to node:test, which aborts the test's signal when it ends; a
// cleanup's bound is the `timeout` it declares to cleanup() below.
// test/support/check-waits.js refuses a test file that polls on its own, waits
// under a test that declares no timeout, or waits in a plain after hook.

// Each poll pauses this long; the pause paces the checks and ends nothing.
const pause = 20

// Waits for `check` (sync or async) to return a truthy value and returns it.
// `t` is the test context, or the context cleanup() hands its function. `what`
// names the wait, or is a function that describes it when the bound ends. A
// check that throws fails the wait at once, unless `retry(error)` says the
// error means "not yet".
export async function until(t, check, what, { retry = () => false } = {}) {
  const signal = t?.signal
  if (!(signal instanceof AbortSignal) || typeof t.diagnostic !== 'function') throw new TypeError('until needs the test context whose bound ends the wait')
  const bound = typeof t.bound === 'string' ? t.bound : "the test's bound"
  if (typeof check !== 'function') throw new TypeError('until needs a check function')
  if (typeof what !== 'string' && typeof what !== 'function') throw new TypeError('until needs the name of what it waits for')
  let lastError, cut, timer
  const ended = new Promise((resolve, reject) => {
    cut = () => {
      let name
      try { name = typeof what === 'function' ? what() : what } catch (error) { name = `a wait whose description failed: ${error.message}` }
      const message = `still waiting for ${name} when ${bound} ended` + (lastError ? `; the last check failed with: ${lastError.message}` : '')
      // node:test reports a timed-out test with its own message, so the wait
      // names itself in the test's report as it is cut.
      t.diagnostic(message)
      reject(Object.assign(new Error(message), { cause: lastError }))
    }
  })
  ended.catch(() => {})
  if (signal.aborted) cut()
  else signal.addEventListener('abort', cut, { once: true })
  try {
    for (;;) {
      let value
      const attempt = Promise.resolve().then(check)
      attempt.catch(() => {})
      try { value = await Promise.race([attempt, ended]) } catch (error) {
        if (signal.aborted || !retry(error)) throw error
        lastError = error
      }
      if (value) return value
      await Promise.race([new Promise(resolve => { timer = setTimeout(resolve, pause) }), ended])
      clearTimeout(timer)
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cut)
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
  if (typeof t?.after !== 'function' || typeof t.diagnostic !== 'function') throw new TypeError('cleanup needs the test context it cleans up after')
  if (typeof what !== 'string' || !what) throw new TypeError('cleanup needs a name')
  if (typeof fn !== 'function') throw new TypeError('cleanup needs a function')
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new TypeError(`the ${what} cleanup needs its timeout`)
  let list = cleanups.get(t)
  if (!list) {
    list = []
    cleanups.set(t, list)
    t.after(async () => {
      const failed = []
      for (const item of list) {
        const ended = new AbortController()
        const context = { signal: ended.signal, diagnostic: message => t.diagnostic(message), bound: `the bound of the ${item.what} cleanup` }
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
// for an event that has already passed. Every test waits on a child's exit
// through it; test/support/check-waits.js refuses an 'exit' listener.
export function exited(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve([child.exitCode, child.signalCode])
  return new Promise((resolve, reject) => {
    const done = (code, signal) => { child.off('error', failed); resolve([code, signal]) }
    const failed = error => { child.off('exit', done); reject(error) }
    child.once('exit', done)
    child.once('error', failed)
  })
}

// Resolves once `child` has exited and its output streams have closed, the
// moment its 'close' event marks, reading both from what is already recorded.
export async function closed(child) {
  await exited(child)
  await Promise.all((child.stdio || []).filter(stream => stream && typeof stream.once === 'function' && !stream.closed && !stream.destroyed)
    .map(stream => new Promise(resolve => stream.once('close', resolve))))
}

// A check's error that means the thing it reads is not there yet: a file or
// socket still missing, or a socket not yet listening.
export const notYetThere = error => ['ENOENT', 'ECONNREFUSED'].includes(error?.code)
