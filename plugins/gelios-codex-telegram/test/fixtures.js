import { execFile as execFileChild, execFileSync as execFileSyncChild, spawn as spawnChild, spawnSync as spawnSyncChild } from 'node:child_process'
import { existsSync, mkdtempSync as createDirectory, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { after } from 'node:test'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { processGroupMembers, processInfo } from '../src/core.js'
import { runtimeSocket, stopRuntime } from '../src/runtime.js'

const directories = new Set()
const children = new Set()
const groups = new Set()

// This test file's own temporary folder, and the mark of every process the
// file starts. A test file starts processes only through the starters below
// (test/support/check-waits.js refuses one it imports from node:child_process),
// and each sets TMPDIR to this folder, or keeps a folder inside it, in the
// environment it hands the child, whatever environment the test built. Where
// that environment cannot reach, the starter puts the mark in the arguments:
// systemd-run gets --setenv=TMPDIR=..., and env -i gets TMPDIR=... A unit a
// test writes itself carries `mark` in its environment. The plugin keeps
// TMPDIR in what it hands its own children, so its detached bridges, update
// jobs and runtimes carry the mark too, except a runtime it starts through
// systemd-run, which gets the service manager's environment: the runtimes
// walk in the teardown below stops that one through its control socket. The
// teardown finds what the file left running by the mark, never by what a
// command line names.
// The folder adds as few characters as it can to the paths inside it, since a
// Unix socket path a test makes there has a short limit.
const owner = realpathSync(createDirectory(tmpdir() + '/'))
directories.add(owner)
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = owner
export const mark = Object.freeze({ TMPDIR: owner })
const inside = value => value === owner || value.startsWith(owner + '/')

// The environment and arguments a starter hands a child: the test's own, with
// this file's mark added where they lack it.
export function marked(command, args = [], options = {}) {
  const env = { ...(options.env ?? process.env) }
  if (env.TMPDIR === undefined) env.TMPDIR = owner
  else if (!inside(String(env.TMPDIR))) throw new Error(`a test started ${command} with TMPDIR=${env.TMPDIR}, outside this test file's folder ${owner}, so the teardown could not find what it leaves running`)
  const list = [...args]
  const assignment = `TMPDIR=${env.TMPDIR}`
  // A service manager starts the command with only the environment it is given.
  if (basename(String(command)) === 'systemd-run' && !list.includes('--scope') && !list.some(arg => String(arg).startsWith('--setenv=TMPDIR='))) list.unshift(`--setenv=${assignment}`)
  // env -i clears the environment before it starts the command.
  const words = [command, ...list]
  for (let k = 0; k < words.length; k++) {
    if (basename(String(words[k])) !== 'env' || !['-i', '--ignore-environment', '-'].includes(words[k + 1])) continue
    if (!words.slice(k + 2).some(word => String(word).startsWith('TMPDIR='))) words.splice(k + 2, 0, assignment)
  }
  return [words[0], words.slice(1), { ...options, env }]
}

// The file-level hook runs after individual test teardown, including failures.
// Only resources allocated through this module belong to this test process.
export function mkdtempSync(prefix, options) {
  // macOS aliases /tmp to /private/tmp. Give every test the same canonical
  // root used by the runtime's path ownership and installation checks.
  const directory = realpathSync(createDirectory(prefix, options))
  directories.add(directory)
  return directory
}

// Starters split their optional arguments the way node:child_process does.
const split = rest => {
  const args = Array.isArray(rest[0]) ? rest.shift() : []
  const options = rest[0] && typeof rest[0] === 'object' ? rest.shift() : {}
  return [args, options, rest[0]]
}

export function spawnSync(command, ...rest) {
  const [args, options] = split(rest)
  return spawnSyncChild(...marked(command, args, options))
}
export function execFileSync(command, ...rest) {
  const [args, options] = split(rest)
  return execFileSyncChild(...marked(command, args, options))
}
export function execFile(command, ...rest) {
  const [args, options, callback] = split(rest)
  return execFileChild(...marked(command, args, options), callback)
}
// promisify(execFile) resolves with { stdout, stderr }, as node:child_process's own does.
execFile[promisify.custom] = (command, ...rest) => {
  const [args, options] = split(rest)
  return promisify(execFileChild)(...marked(command, args, options))
}

export function spawn(command, ...rest) {
  const [args, options] = split(rest)
  const detached = options.detached ?? process.platform !== 'win32'
  const child = spawnChild(...marked(command, args, { ...options, detached }))
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
    return execFileSyncChild('/bin/ps', ['-o', 'pid=,pgid=,stat=', '-p', pids.join(',')], { encoding: 'utf8' }).trim().split('\n')
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

// The TMPDIR a process inherited, read between two reads of its start
// identity, so the value belongs to the process that identity names: a pid
// reused between the reads changes the identity and is skipped.
function inherited(pid, listed, within) {
  const linux = process.platform === 'linux'
  // Elsewhere ps prints the environment after the arguments, so the last
  // TMPDIR it prints is the environment's.
  const tmpdirIn = text => [...(text || '').matchAll(/(?:^|\s)TMPDIR=(\S+)/g)].at(-1)?.[1] ?? null
  if (!linux && !within(tmpdirIn(listed) ?? '')) return null
  const before = processInfo(pid)?.identity
  if (!before) return null
  let value = null
  try {
    if (linux) {
      const entry = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find(item => item.startsWith('TMPDIR='))
      value = entry ? entry.slice('TMPDIR='.length) : null
    } else value = tmpdirIn(execFileSyncChild('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }))
  } catch { return null }
  return value && within(value) && processInfo(pid)?.identity === before ? { value, identity: before } : null
}

// Processes this test file caused that still run: each inherited this file's
// own temporary folder as TMPDIR, or a folder inside it. A process the file
// did not cause, such as a viewer someone opened on a fixture log, inherited
// another TMPDIR and is never listed, whatever its command line names. Each
// entry carries the start identity read with its TMPDIR, and its command
// line without its environment.
export function processesIn(root = owner) {
  const ps = args => execFileSyncChild('/bin/ps', args, { encoding: 'utf8' })
  const rows = (text, shape) => text.split('\n').map(line => line.match(shape)).filter(Boolean)
  // Without /proc, ps prints each environment, which only picks the candidates.
  const environments = process.platform === 'linux' ? null : new Map(rows(ps(['-A', '-E', '-ww', '-o', 'pid=,command=']), /^\s*(\d+)\s+(.*)$/).map(([, pid, text]) => [Number(pid), text]))
  return rows(ps(['-A', '-ww', '-o', 'pid=,stat=,command=']), /^\s*(\d+)\s+(\S+)\s+(.*)$/)
    .map(([, pid, state, command]) => ({ pid: Number(pid), state, command }))
    .filter(({ pid, state }) => pid !== process.pid && !state.startsWith('Z'))
    .map(entry => ({ ...entry, inherited: inherited(entry.pid, environments?.get(entry.pid), value => value === root || value.startsWith(root + '/')) }))
    .filter(({ inherited: found }) => found)
    .map(({ pid, state, command, inherited: found }) => ({ pid, state, command, identity: found.identity }))
}

// Signals a listed process only while it is still the process that was
// listed: its start identity is read again right before each signal.
export async function stopLeftover({ pid, identity }, { info = processInfo, kill = process.kill } = {}) {
  const same = () => info(pid)?.identity === identity
  const signal = name => {
    if (!same()) return
    try { kill(pid, name) } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  signal('SIGTERM')
  const grace = Date.now() + 500
  while (same() && Date.now() < grace) await new Promise(resolve => setTimeout(resolve, 20))
  signal('SIGKILL')
  const deadline = Date.now() + 2000
  while (same() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  if (same()) throw new Error(`left process ${pid} did not exit`)
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
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch (error) { problems.push(`the runtimes in ${directory} could not be read: ${error.message}`); return }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'runtime-builds') await runtimes(join(directory, entry.name))
      if (entry.isFile() && entry.name === 'native-runtime.json' && existsSync(runtimeSocket(directory))) {
        let record; try { record = JSON.parse(readFileSync(join(directory, entry.name), 'utf8')) } catch { continue }
        if (record.component === 'codex-telegram-runtime') {
          try { await stopRuntime(directory) } catch (error) { problems.push(`the runtime in ${directory} did not stop: ${error.message}`) }
        }
      }
    }
  }
  for (const directory of directories) {
    try { await runtimes(directory) } catch (error) { problems.push(`the runtimes in ${directory} could not be read: ${error.message}`) }
  }
  // A process this file caused that still runs was left by a cleanup that
  // failed, such as a bridge a timed-out test never stopped, and it can keep
  // this file running. Each is named and stopped by its pid while its start
  // identity is still the one listed. One can start another while it is
  // stopped, so the listing repeats until it comes back empty, a few times at
  // most; a listing that fails keeps the directories.
  const left = []
  let remaining = null
  for (let round = 0; round < 4; round++) {
    try { remaining = processesIn() } catch (error) { problems.push(`the processes this file left could not be listed: ${error.message}`); remaining = null; break }
    if (!remaining.length || round === 3) break
    left.push(...remaining)
    for (const result of await Promise.allSettled(remaining.map(entry => stopLeftover(entry)))) {
      if (result.status === 'rejected') problems.push(result.reason.message)
    }
  }
  if (remaining?.length === 0 && !ownedStuck) {
    for (const directory of directories) {
      try { rmSync(directory, { recursive: true, force: true }) } catch (error) { problems.push(`${directory} could not be removed: ${error.message}`) }
    }
  }
  if (left.length) problems.unshift(`stopped ${left.length} process(es) this test file left running: ` +
    left.map(({ pid, command }) => `${pid} (${command.length > 240 ? command.slice(0, 240) + '...' : command})`).join('; '))
  if (remaining?.length !== 0 || ownedStuck) problems.push('owned fixture processes did not exit; retaining directories')
  if (problems.length) throw new Error(`the fixture cleanup hook in test/fixtures.js: ${problems.join('; ')}`)
})
