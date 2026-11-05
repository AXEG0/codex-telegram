import { execFileSync, spawn as spawnChild } from 'node:child_process'
import { existsSync, mkdtempSync as createDirectory, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { after } from 'node:test'
import { join } from 'node:path'
import { processGroupMembers } from '../src/core.js'
import { runtimeSocket, stopRuntime } from '../src/runtime.js'

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

// Processes still running whose command line names a folder this test
// process created: only this test file can have started them.
export function processesIn(roots, { list = () => execFileSync('/bin/ps', ['-A', '-ww', '-o', 'pid=,stat=,command='], { encoding: 'utf8' }) } = {}) {
  const prefixes = [...roots].map(root => root.endsWith('/') ? root : root + '/')
  return list().split('\n').map(line => line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, state, command]) => ({ pid: Number(pid), state, command }))
    .filter(({ pid, state, command }) => pid !== process.pid && !state.startsWith('Z') &&
      prefixes.some(prefix => command.includes(prefix) || command.endsWith(prefix.slice(0, -1))))
}

async function stopLeftover({ pid, command }, roots) {
  const running = () => processesIn(roots).some(entry => entry.pid === pid && entry.command === command)
  const signal = name => { try { process.kill(pid, name) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  signal('SIGTERM')
  const grace = Date.now() + 500
  while (running() && Date.now() < grace) await new Promise(resolve => setTimeout(resolve, 20))
  if (running()) signal('SIGKILL')
  const deadline = Date.now() + 2000
  while (running() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  if (running()) throw new Error(`left process ${pid} did not exit`)
}

after(async () => {
  // Every step runs even when an earlier one fails, so one failed stop leaves
  // nothing else behind; the hook fails at the end, naming what went wrong.
  const problems = []
  const results = await Promise.allSettled([...groups].map(pid => stopGroup(pid)).concat([...children].map(stop)))
  for (const result of results) if (result.status === 'rejected') problems.push(result.reason.message)
  const ownedStuck = problems.length > 0
  // Runtime supervisors deliberately outlive the bridge process group. Stop
  // only supervisors recorded inside roots this test process allocated.
  async function runtimes(directory) {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'runtime-builds') await runtimes(join(directory, entry.name))
      if (entry.isFile() && entry.name === 'native-runtime.json' && existsSync(runtimeSocket(directory))) {
        let record; try { record = JSON.parse(readFileSync(join(directory, entry.name), 'utf8')) } catch { continue }
        if (record.component === 'codex-telegram-runtime') {
          try { await stopRuntime(directory) } catch (error) { problems.push(`the runtime in ${directory} did not stop: ${error.message}`) }
        }
      }
    }
  }
  for (const directory of directories) await runtimes(directory)
  // A process still running from a folder this test process created was left
  // by a cleanup that failed, such as a bridge a timed-out test never stopped,
  // and it can keep this file running. Each is named and stopped by its pid.
  const left = processesIn(directories)
  for (const result of await Promise.allSettled(left.map(entry => stopLeftover(entry, directories)))) {
    if (result.status === 'rejected') problems.push(result.reason.message)
  }
  const remaining = processesIn(directories)
  if (!remaining.length && !ownedStuck) for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  if (left.length) problems.unshift(`stopped ${left.length} process(es) this test file left running: ` +
    left.map(({ pid, command }) => `${pid} (${command.length > 240 ? command.slice(0, 240) + '...' : command})`).join('; '))
  if (remaining.length || ownedStuck) problems.push('owned fixture processes did not exit; retaining directories')
  if (problems.length) throw new Error(`the fixture cleanup hook in test/fixtures.js: ${problems.join('; ')}`)
})
