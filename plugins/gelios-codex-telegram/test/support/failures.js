// The node:test reporter test/support/run-tests.js puts in the place of one
// reporter node takes, the one GELIOS_TEST_REPORTER names: it hands every
// event on to that reporter, so the run has exactly the reporters node takes,
// and writes one line for each failure node:test reports, a todo test aside,
// to the file GELIOS_TEST_FAILURES names. node:test's exit code alone can
// miss one: on Node 22 a describe whose body throws is reported as failed,
// yet its tests never register and the run exits 0.
import { appendFileSync } from 'node:fs'
import Module from 'node:module'
import { pipeline } from 'node:stream'
import * as builtins from 'node:test/reporters'

const name = process.env.GELIOS_TEST_REPORTER
const record = process.env.GELIOS_TEST_FAILURES
appendFileSync(record, '')

// The reporter, loaded as node loads one: a built-in by its name, any other
// name imported against the working folder. A module named for that folder
// makes the import, so it goes through node's own loader from the same place.
async function load() {
  if (Object.hasOwn(builtins, name)) return builtins[name]
  const folder = `${process.cwd()}/`
  const importer = new Module(folder)
  importer._compile('module.exports = name => import(name)', folder)
  return importer.exports(name)
}
let reporter = await load()
if (reporter?.default) reporter = reporter.default
if (reporter?.prototype && Object.getOwnPropertyDescriptor(reporter.prototype, 'constructor')) reporter = new reporter()
if (!reporter) throw Object.assign(new TypeError(`The argument 'Reporter' is not a valid reporter. Received '${name}'`), { code: 'ERR_INVALID_ARG_VALUE' })

async function * watched(source) {
  for await (const event of source) {
    if (event.type === 'test:fail' && !event.data.todo) appendFileSync(record, `${event.data.name}\n`)
    yield event
  }
}
// node hands a reporter function the events and its pipeline's options, and
// pipes the events through a reporter stream; this does the same.
export default async function * failures(source, options) {
  if (typeof reporter === 'function') yield * reporter(watched(source), options)
  else yield * pipeline(watched(source), reporter, () => {})
}
