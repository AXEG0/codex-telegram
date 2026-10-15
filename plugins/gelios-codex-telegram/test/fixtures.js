import { spawn as spawnChild } from 'node:child_process'
import { mkdtempSync as createDirectory, realpathSync, rmSync } from 'node:fs'
import { after } from 'node:test'

const directories = new Set()
const children = new Set()

// The file-level hook runs after individual test teardown, including failures.
// Only resources allocated through this module belong to this test process.
export function mkdtempSync(prefix, options) {
  // macOS aliases /tmp to /private/tmp. Give every test the same canonical
  // root used by the runtime's path ownership and installation checks.
  const directory = realpathSync(createDirectory(prefix, options))
  directories.add(directory)
  return directory
}

export function spawn(...args) {
  const child = spawnChild(...args)
  children.add(child)
  const forget = () => children.delete(child)
  child.once('exit', forget)
  child.once('error', forget)
  return child
}

async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const finished = () => { clearTimeout(timer); child.off('exit', finished); resolve() }
    child.once('exit', finished)
    const timer = setTimeout(() => child.kill('SIGKILL'), 500)
    if (!child.kill('SIGTERM')) finished()
  })
}

after(async () => {
  try {
    await Promise.all([...children].map(stop))
  } finally {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  }
})
