// The one wait every test uses. A wait ends when its check holds or when the
// bound of the test or hook running it ends, never on a clock of its own: a
// slow machine makes a test slower, never red. The bound is the `timeout` the
// test or hook declares to node:test, which aborts the context's signal when
// it ends; test/support/check-waits.js refuses a test file that polls on its
// own or waits under a test or hook that declares no timeout.

// Each poll pauses this long; the pause paces the checks and ends nothing.
const pause = 20

// Waits for `check` (sync or async) to return a truthy value and returns it.
// `t` is the test context. `what` names the wait, or is a function that
// describes it when the bound ends. A check that throws fails the wait at
// once, unless `retry(error)` says the error means "not yet".
export async function until(t, check, what, { retry = () => false } = {}) {
  const signal = t?.signal
  if (!(signal instanceof AbortSignal) || typeof t.diagnostic !== 'function') throw new TypeError('until needs the test context whose bound ends the wait')
  if (typeof check !== 'function') throw new TypeError('until needs a check function')
  if (typeof what !== 'string' && typeof what !== 'function') throw new TypeError('until needs the name of what it waits for')
  let lastError, cut, timer
  const ended = new Promise((resolve, reject) => {
    cut = () => {
      let name
      try { name = typeof what === 'function' ? what() : what } catch (error) { name = `a wait whose description failed: ${error.message}` }
      const message = `still waiting for ${name} when the test's bound ended` + (lastError ? `; the last check failed with: ${lastError.message}` : '')
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

// A check's error that means the thing it reads is not there yet: a file or
// socket still missing, or a socket not yet listening.
export const notYetThere = error => ['ENOENT', 'ECONNREFUSED'].includes(error?.code)
