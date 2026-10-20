import { execFileSync, spawn as spawnChild } from 'node:child_process'
import { mkdtempSync as createDirectory, realpathSync, rmSync } from 'node:fs'
import { after } from 'node:test'
import { processGroupMembers } from '../src/core.js'

const directories = new Set()
const children = new Set()
const groups = new Set()

// The file-level hook runs after individual test teardown, including failures.
// Only resources allocated through this module belong to this test process.
export function mkdtempSync(prefix, options) {
  // macOS aliases /tmp to /private/tmp. Give every test the same canonical
  // root used by the runtime's path ownership and installation checks.
  const directory = realpathSync(createDirectory(prefix, options))
  directories.add(directory)
  return directory
}

export function spawn(command, args = [], options = {}) {
  const detached = options.detached ?? process.platform !== 'win32'
  const child = spawnChild(command, args, { ...options, detached })
  children.add(child)
  if (detached && process.platform !== 'win32') {
    child.once('spawn', () => groups.add(child.pid))
    // A leader can exit while a background clone still owns its process group.
    child.once('close', () => { if (groups.has(child.pid) && !liveGroupMembers(child.pid).length) groups.delete(child.pid) })
  }
  const forget = () => children.delete(child)
  child.once('exit', forget)
  child.once('error', forget)
  return child
}

export function liveGroupMembers(groupId) {
  const pids = processGroupMembers(groupId)
  if (!pids.length) return []
  try {
    // Exited children cannot write fixtures. Darwin rejects a signal to a
    // zombie-only group with EPERM, even when every child belongs to us.
    return execFileSync('/bin/ps', ['-o', 'pid=,pgid=,stat=', '-p', pids.join(',')], { encoding: 'utf8' }).trim().split('\n')
      .map(line => line.trim().split(/\s+/)).filter(([, group, state]) => Number(group) === groupId && state && !state.startsWith('Z')).map(([pid]) => Number(pid))
  } catch (error) { if (error.status === 1) return []; throw error }
}

export async function stopGroup(pid, { readMembers = liveGroupMembers, kill = process.kill } = {}) {
  const members = () => readMembers(pid)
  const signal = name => { try { kill(-pid, name) } catch (error) {
    if (error.code !== 'ESRCH' && !(error.code === 'EPERM' && !members().length)) throw error
  } }
  if (!members().length) return
  signal('SIGTERM')
  const grace = Date.now() + 500
  while (members().length && Date.now() < grace) await new Promise(resolve => setTimeout(resolve, 20))
  if (members().length) signal('SIGKILL')
  const deadline = Date.now() + 2000
  while (members().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  if (members().length) throw new Error(`owned fixture process group ${pid} did not exit`)
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
  const results = await Promise.allSettled([...groups].map(pid => stopGroup(pid)).concat([...children].map(stop)))
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'owned fixture processes did not exit; retaining directories')
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})
