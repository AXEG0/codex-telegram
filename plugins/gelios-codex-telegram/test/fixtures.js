// wait.js registers its file-end hook as it loads, so importing it first puts
// that hook ahead of this file's teardown in every test file, whatever order
// the test file imports the two in.
import { stopAtBound } from './support/wait.js'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdtempSync as createDirectory, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { after } from 'node:test'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { liveGroupMembers } from '../src/core.js'
import { runtimeSocket, stopRuntime } from '../src/runtime.js'
import { processesIn as listIn, stopLeftover, stopProcessesIn } from './support/leftovers.js'

const directories = new Set()
const children = new Set()
const groups = new Set()

// This test file's own temporary folder, and the mark of every process the
// file starts: each child this test process starts gets TMPDIR set to this
// folder, or keeps a folder inside it, at the point node:child_process starts
// it (below), whichever code starts it. Where the child's environment cannot
// reach what it starts, the arguments carry the mark: systemd-run gets
// --setenv=TMPDIR=..., and env -i gets TMPDIR=... A unit a test writes itself
// carries `mark` in its environment. A process the plugin starts outside this
// test process, such as from a bridge it detached, gets TMPDIR from the process
// that starts it: the plugin keeps TMPDIR in the environment of every child it
// starts, except ps, pgrep and sysctl, which end before their call returns, and
// the runtime supervisor it starts through systemd-run, which gets the service
// manager's environment. The runtimes walk in the teardown below stops that
// supervisor through its control socket. The teardown finds everything else
// the file left running by the mark, never by what a command line names.
// The folder adds as few characters as it can to the paths inside it, since a
// Unix socket path a test makes there has a short limit.
const owner = realpathSync(createDirectory(tmpdir() + '/'))
directories.add(owner)
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = owner
export const mark = Object.freeze({ TMPDIR: owner })
// What the file left running when its bound ends it is stopped by this mark.
stopAtBound(owner)
const inside = value => value === owner || value.startsWith(owner + '/')

// The command, arguments and environment a child starts with: the given ones,
// with this file's mark added where they lack it. A TMPDIR outside this file's
// folder, in the environment or the arguments, is refused.
function launch(command, args, env) {
  const name = String(command)
  if (env.TMPDIR === undefined) env.TMPDIR = owner
  else if (!inside(String(env.TMPDIR))) throw new Error(`a test started ${name} with TMPDIR=${env.TMPDIR}, outside this test file's folder ${owner}, so the teardown could not find what it leaves running`)
  const words = [command, ...args]
  for (const word of words) {
    const value = /^(?:--setenv=|-E)?TMPDIR=(.*)$/.exec(String(word))?.[1]
    if (value !== undefined && !inside(value)) throw new Error(`a test started ${name} with TMPDIR=${value} in its arguments, outside this test file's folder ${owner}`)
  }
  const assignment = `TMPDIR=${env.TMPDIR}`
  // A service manager starts the command with only the environment it is given.
  if (basename(name) === 'systemd-run' && !words.includes('--scope') && !words.some(word => /^(?:--setenv=|-E)?TMPDIR=/.test(String(word)))) words.splice(1, 0, `--setenv=${assignment}`)
  // env -i clears the environment before it starts the command.
  for (let k = 0; k < words.length; k++) {
    if (basename(String(words[k])) !== 'env' || !['-i', '--ignore-environment', '-'].includes(words[k + 1])) continue
    if (!words.slice(k + 2).some(word => String(word).startsWith('TMPDIR='))) words.splice(k + 2, 0, assignment)
  }
  return [words[0], words.slice(1), env]
}
export function marked(command, args = [], options = {}) {
  const [file, list, env] = launch(command, [...args], { ...(options.env ?? process.env) })
  return [file, list, { ...options, env }]
}

// Every child this test process starts carries the mark, whatever code starts
// it (a test, a support module or the plugin's own code run in this process)
// and however that code reached node:child_process. spawn, exec, execFile and
// fork all start their child through ChildProcess.prototype.spawn, which gets
// the environment as name=value pairs; the synchronous starters are wrapped
// one by one, and the named exports of node:child_process follow.
const original = { spawnSync: childProcess.spawnSync, execSync: childProcess.execSync, execFileSync: childProcess.execFileSync }
const startChild = childProcess.ChildProcess.prototype.spawn
childProcess.ChildProcess.prototype.spawn = function (options) {
  if (options && Array.isArray(options.envPairs)) {
    const env = Object.fromEntries(options.envPairs.map(pair => [String(pair).slice(0, String(pair).indexOf('=')), String(pair).slice(String(pair).indexOf('=') + 1)]))
    const [, list, marks] = launch(options.file, (options.args || []).slice(1), env)
    options = { ...options, args: [(options.args || [options.file])[0], ...list], envPairs: Object.entries(marks).map(([name, value]) => `${name}=${value}`) }
  }
  return startChild.call(this, options)
}
// spawnSync and execFileSync take (file, args, options) or (file, options), and
// read args that are null or undefined as an empty list, as node does.
const fileArgs = (args, options) => Array.isArray(args) ? [args, options] : args == null ? [[], options] : [[], args]
childProcess.spawnSync = function spawnSync(file, args, options) {
  const [list, given = {}] = fileArgs(args, options)
  const [, words, env] = launch(file, [...list], { ...(given.env ?? process.env) })
  return original.spawnSync(file, words, { ...given, env })
}
childProcess.execFileSync = function execFileSync(file, args, options) {
  const [list, given = {}] = fileArgs(args, options)
  const [, words, env] = launch(file, [...list], { ...(given.env ?? process.env) })
  return original.execFileSync(file, words, { ...given, env })
}
childProcess.execSync = function execSync(command, options = {}) {
  const [, , env] = launch(command, [], { ...(options?.env ?? process.env) })
  return original.execSync(command, { ...options, env })
}
syncBuiltinESMExports()
export const { spawnSync, execFileSync, execFile } = childProcess

// The file-level hook runs after individual test teardown, including failures.
// Only resources allocated through this module belong to this test process.
export function mkdtempSync(prefix, options) {
  // macOS aliases /tmp to /private/tmp. Give every test the same canonical
  // root used by the runtime's path ownership and installation checks.
  const directory = realpathSync(createDirectory(prefix, options))
  directories.add(directory)
  return directory
}

// spawn splits its optional arguments the way node:child_process does: args
// that are null or undefined are an empty list, and the options follow.
const split = rest => {
  const list = [...rest]
  const args = Array.isArray(list[0]) ? list.shift() : list[0] == null && list.length > 1 ? (list.shift(), []) : []
  const options = list[0] && typeof list[0] === 'object' ? list.shift() : {}
  return [args, options]
}

// A child a test starts through spawn is detached into a process group of its
// own, and the teardown stops the group.
export function spawn(command, ...rest) {
  const [args, options] = split(rest)
  const detached = options.detached ?? process.platform !== 'win32'
  const child = childProcess.spawn(command, args, { ...options, detached })
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

// Exited children cannot write fixtures, so a group whose members are all
// zombies is stopped: the plugin's own kill paths read a group this way too.
export { liveGroupMembers }

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

// Processes this test file caused that still run: each inherited this file's
// own temporary folder as TMPDIR, or a folder inside it (test/support/leftovers.js).
export const processesIn = (root = owner) => listIn(root)
export { stopLeftover }

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
        if (record?.component === 'codex-telegram-runtime') {
          try { await stopRuntime(directory) } catch (error) { problems.push(`the runtime in ${directory} did not stop: ${error.message}`) }
        }
      }
    }
  }
  for (const directory of directories) await runtimes(directory)
  // A process this file caused that still runs was left by a cleanup that
  // failed, such as a bridge a timed-out test never stopped, and it can keep
  // this file running. Each is named and stopped by its pid while its start
  // identity is still the one listed. One can start another while it is
  // stopped, so the listing repeats until it comes back empty, a few times at
  // most; a listing that fails keeps the directories.
  const { left, remaining, problems: stopping } = await stopProcessesIn(owner)
  problems.push(...stopping)
  if (remaining?.length === 0 && !ownedStuck) {
    for (const directory of directories) {
      if (directory === owner) continue
      try { rmSync(directory, { recursive: true, force: true }) } catch (error) { problems.push(`${directory} could not be removed: ${error.message}`) }
    }
    // Once every folder a fixture made is gone, what is left in this file's
    // folder was left by a test or by the plugin: the file fails naming it, and
    // the folder stays, so the test runner's own check names it too.
    let entries = null
    try { entries = readdirSync(owner) } catch (error) { problems.push(`${owner} could not be read: ${error.message}`) }
    if (entries?.length) problems.push(`left temporary entries in ${owner}: ${entries.join(', ')}`)
    else if (entries) { try { rmSync(owner, { recursive: true, force: true }) } catch (error) { problems.push(`${owner} could not be removed: ${error.message}`) } }
  }
  if (left.length) problems.unshift(`stopped ${left.length} process(es) this test file left running: ` +
    left.map(({ pid, command }) => `${pid} (${command.length > 240 ? command.slice(0, 240) + '...' : command})`).join('; '))
  if (remaining?.length !== 0 || ownedStuck) problems.push('owned fixture processes did not exit; retaining directories')
  // node --test reports a failed file-level hook at this file's line, so the
  // message names the test file it ran for: from the working folder when the
  // file is inside it, else whole.
  const file = process.argv[1] && (relative(process.cwd(), process.argv[1]).startsWith('..') ? process.argv[1] : relative(process.cwd(), process.argv[1]))
  if (problems.length) throw new Error(`the fixture cleanup hook in test/fixtures.js, for ${file || 'this test process'}: ${problems.join('; ')}`)
})
