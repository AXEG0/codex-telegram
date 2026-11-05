// A node:test reporter test/support/run-tests.js adds to every test file's run:
// it writes one line for each failure node:test reports, a todo test aside.
// node:test's exit code alone can miss one: on Node 22 a describe whose body
// throws is reported as failed, yet its tests never register and the run
// exits 0.
export default async function * failures(source) {
  for await (const event of source) if (event.type === 'test:fail' && !event.data.todo) yield `${event.data.name}\n`
}
