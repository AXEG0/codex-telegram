// test/support/run-tests.js loads this with --require ahead of everything else
// to learn what node makes of the arguments it was handed, and which test
// files node --test picks from them, so the runner reads neither itself.
// In node --test's own process it records node's options and the arguments
// left after them; a test file's process records the file and exits before
// the file runs. Unless GELIOS_TEST_ARGUMENTS names the record, it does nothing.
const { appendFileSync } = require('node:fs')
const record = process.env.GELIOS_TEST_ARGUMENTS
if (record) {
  if (process.env.NODE_TEST_CONTEXT) {
    appendFileSync(record, JSON.stringify({ file: process.argv[1] }) + '\n')
    process.exit(0)
  }
  appendFileSync(record, JSON.stringify({ execArgv: process.execArgv, argv: process.argv.slice(1) }) + '\n')
  if (process.env.GELIOS_TEST_ARGUMENTS_ONLY) process.exit(0)
}
