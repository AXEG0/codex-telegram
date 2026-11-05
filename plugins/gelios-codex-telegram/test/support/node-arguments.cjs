// test/support/run-tests.js starts node --test with --expose-internals and
// this loaded first, ahead of every module the options preload, to learn the options node itself takes, from every source node
// reads them from, before any test file runs. It records them in the file
// GELIOS_TEST_ARGUMENTS names, and exits. Unless that variable is set, it
// does nothing.
const record = process.env.GELIOS_TEST_ARGUMENTS
if (record) {
  const { getOptionValue } = require('internal/options')
  const value = name => { try { return getOptionValue(name) } catch { return undefined } }
  require('node:fs').writeFileSync(record, JSON.stringify({
    reporters: value('--test-reporter') ?? [],
    destinations: value('--test-reporter-destination') ?? [],
    watch: Boolean(value('--watch')) || (value('--watch-path') ?? []).length > 0,
    timeout: value('--test-timeout') ?? 0,
    coverage: Boolean(value('--experimental-test-coverage')),
    isolation: value('--test-isolation') ?? value('--experimental-test-isolation') ?? 'process',
  }))
  process.exit(0)
}
