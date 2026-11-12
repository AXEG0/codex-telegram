// Finds and stops the processes a test file left running, by the mark every
// one of them carries: the TMPDIR it inherited lies inside a given folder.
// test/fixtures.js stops what its test file left, and test/support/run-tests.js
// what a test file it ended left. Loading this module changes nothing.
import childProcess from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { processInfo } from '../../src/core.js'

// The starter test/fixtures.js has not wrapped: ps needs no mark.
const execFileSync = childProcess.execFileSync
const execFileAsync = (file, args, options = {}) => new Promise((resolve, reject) => {
  childProcess.execFile(file, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options }, (error, stdout) => error ? reject(error) : resolve(stdout))
})
// The session of each pid it is given, 0 for one that is gone, in one python3 call.
const GETSID = 'import os, sys\ndef sid(pid):\n    try: return os.getsid(int(pid))\n    except OSError: return 0\nprint(*[sid(pid) for pid in sys.argv[1:]])'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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
    } else value = tmpdirIn(execFileSync('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }))
  } catch { return null }
  return value && within(value) && processInfo(pid)?.identity === before ? { value, identity: before } : null
}

// Processes that still run and inherited `root` as TMPDIR, or a folder inside
// it. A process that inherited another TMPDIR, such as a viewer someone opened
// on a fixture log, is never listed, whatever its command line names. Each
// entry carries the start identity read with its TMPDIR, and its command line
// without its environment.
export function processesIn(root) {
  const ps = args => execFileSync('/bin/ps', args, { encoding: 'utf8' })
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

// The session and start identity of a process from one read of
// /proc/<pid>/stat (fields 6 and 22), or null once it is gone or a zombie.
const parseStat = stat => { const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' '); return fields[0] === 'Z' ? null : { session: Number(fields[3]), identity: fields[19] || null } }
function procStat(pid) {
  try { return parseStat(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return null }
}

// Each of `items` ({ pid, identity }) that still runs with its start identity,
// whatever TMPDIR it inherited, with its command line; a zombie counts as gone.
// The plugin's record names some processes that carry no mark, such as one
// systemd started. On Linux each command line is read between two reads of its
// stat; elsewhere one ps call lists every pid, its start time read as
// processInfo in src/core.js reads it.
export function runningAs(items) {
  const wanted = items.filter(item => item.identity && Number.isSafeInteger(item.pid) && item.pid > 0)
  if (!wanted.length) return []
  if (process.platform === 'linux') return wanted.flatMap(({ pid, identity }) => {
    if (procStat(pid)?.identity !== identity) return []
    let command = ''
    try { command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') } catch {}
    return procStat(pid)?.identity === identity ? [{ pid, identity, command: command || '(no command line)' }] : []
  })
  let text
  // ps exits 1 when a pid it was given is gone, after listing the others.
  try { text = execFileSync('/bin/ps', ['-ww', '-o', 'pid=,stat=,lstart=,command=', '-p', wanted.map(item => item.pid).join(',')], { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'] }) }
  catch (error) { text = String(error.stdout || '') }
  const rows = new Map(text.split('\n').map(line => line.match(/^\s*(\d+)\s+(\S+)\s+\S+\s+(\S+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, state, month, day, hour, minute, second, year, command]) => [Number(pid), { state, command,
      identity: String(Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), Number(hour), Number(minute), Number(second)) / 1000) }]))
  return wanted.flatMap(({ pid, identity }) => { const row = rows.get(pid); return row && !row.state.startsWith('Z') && row.identity === identity ? [{ pid, identity, command: row.command }] : [] })
}

// The session each of `pids` runs in, as a map from pid to session id, 0 for
// one that is gone: field 6 of /proc/<pid>/stat on Linux. macOS ps prints no
// session id (its sess column is a kernel address) and its pgrep has no
// session match, so there one python3 call reads getsid(2) for every pid at
// once, whatever their number.
export function sessionsOf(pids) {
  if (process.platform === 'linux') return new Map(pids.map(pid => [pid, procStat(pid)?.session || 0]))
  if (!pids.length) return new Map()
  const sids = execFileSync('python3', ['-c', GETSID, ...pids.map(String)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).map(Number)
  return new Map(pids.map((pid, index) => [pid, sids[index] || 0]))
}

// One sighting of the records `owned` (each { pid, identity, members }): for
// each one whose leader still runs with its recorded start identity, the
// processes in `root` that run in its session are added to its `members` by
// pid and start identity. A leader seen gone is marked `gone` and never
// checked again: a pid with that start identity cannot run again. Returns the
// records whose leader ran. `sight` runs it at once, blocking, for a point
// the test chose; `sightAsync` runs the same pass without blocking the event
// loop, for the sightings taken while the test runs, since some tests run the
// bridge in the test process. With `listing`, the entries of processesIn(root)
// and their sessions that the teardown's poll has read already, `sight` uses
// them and checks each leader after them: one that still runs with its start
// identity ran throughout, so what the listing found in its session was there
// while it led it.
export function sight(root, owned, listing = null) {
  if (!listing) return drive(sighting(root, owned))
  const running = item => {
    if (!item.identity || item.gone) return false
    if (processInfo(item.pid)?.identity === item.identity) return true
    item.gone = true
    return false
  }
  // Nothing to read while no leader runs.
  if (!owned.some(item => item.identity && !item.gone && (listing.entries.some(entry => entry.pid === item.pid && entry.identity === item.identity) || running(item)))) return []
  const ids = new Set(owned.filter(item => !item.gone).map(item => item.pid))
  const members = listing.entries.filter(entry => ids.has(listing.sessions.get(entry.pid))).map(entry => ({ pid: entry.pid, identity: entry.identity, session: listing.sessions.get(entry.pid) }))
  const live = owned.filter(running)
  for (const item of live) for (const member of members) if (member.session === item.pid) item.members.add(`${member.pid} ${member.identity}`)
  return live
}
export const sightAsync = (root, owned) => driveAsync(sighting(root, owned))

// The pass both run, written once: it yields what it needs, { run: [file,
// args, options] } for a command's output or { read: [paths] } for files
// (null for one that cannot be read), and gets it back. One pass reads every
// leader and the sessions. On Linux one ps listing of every pid's session
// picks the processes in the recorded sessions, then one batch of reads takes
// the /proc/<pid>/stat of each leader and each of them, then the environment
// of those in a live leader's session, for the mark, then their stat again.
// Elsewhere one ps listing carries each pid, its start time (read as
// processInfo in src/core.js reads it, so identities compare) and its
// environment, then one python3 call reads the sessions of the marked ones.
// A leader found in that pass with its start identity ran then, and a
// process can leave a session only for one of its own, so a marked process
// whose session id is that leader's was in the recorded session then.
function* sighting(root, owned) {
  const leaders = owned.filter(item => item.identity && !item.gone)
  if (!leaders.length) return []
  const within = value => value === root || value.startsWith(root + '/')
  let live, members
  if (process.platform === 'linux') {
    const ids = new Set(leaders.map(item => item.pid))
    const listing = yield { run: ['/bin/ps', ['-A', '-o', 'pid=,sess=,stat=']] }
    const candidates = listing.split('\n').map(line => line.trim().split(/\s+/)).filter(([pid, session, state]) => /^\d+$/.test(pid || '') && ids.has(Number(session)) && !state?.startsWith('Z') && Number(pid) !== process.pid).map(([pid]) => Number(pid))
    const pids = [...new Set([...ids, ...candidates])]
    const stats = new Map((yield { read: pids.map(pid => `/proc/${pid}/stat`) }).map((text, index) => [pids[index], text === null ? null : parseStat(text)]))
    for (const item of leaders) if (stats.get(item.pid)?.identity !== item.identity) item.gone = true
    live = leaders.filter(item => !item.gone)
    if (!live.length) return []
    const liveIds = new Set(live.map(item => item.pid))
    const inSessions = candidates.filter(pid => liveIds.has(stats.get(pid)?.session))
    // The environment read after the pass only tells which of them carry the
    // mark; the stat read after it shows the pid still names the same process.
    const environments = yield { read: inSessions.map(pid => `/proc/${pid}/environ`) }
    const again = yield { read: inSessions.map(pid => `/proc/${pid}/stat`) }
    members = inSessions.flatMap((pid, index) => {
      const value = environments[index]?.split('\0').find(entry => entry.startsWith('TMPDIR='))?.slice('TMPDIR='.length)
      const stat = stats.get(pid), now = again[index] === null ? null : parseStat(again[index])
      return value && within(value) && now?.identity === stat.identity ? [{ pid, identity: stat.identity, session: stat.session }] : []
    })
  } else {
    const text = yield { run: ['/bin/ps', ['-A', '-E', '-ww', '-o', 'pid=,stat=,lstart=,command='], { env: { LC_ALL: 'C', TZ: 'UTC' } }] }
    const rows = text.split('\n').map(line => line.match(/^\s*(\d+)\s+(\S+)\s+\S+\s+(\S+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
      .filter(([, pid, state]) => Number(pid) !== process.pid && !state.startsWith('Z'))
      .map(([, pid, , month, day, hour, minute, second, year, rest]) => {
        const start = Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), Number(hour), Number(minute), Number(second)) / 1000
        // ps prints the environment after the arguments, so the last TMPDIR it prints is the environment's.
        const tmpdir = [...rest.matchAll(/(?:^|\s)TMPDIR=(\S+)/g)].at(-1)?.[1] ?? null
        return { pid: Number(pid), identity: Number.isInteger(start) && start > 0 ? String(start) : null, marked: Boolean(tmpdir && within(tmpdir)) }
      })
    const listed = new Map(rows.map(row => [row.pid, row]))
    for (const item of leaders) if (listed.get(item.pid)?.identity !== item.identity) item.gone = true
    live = leaders.filter(item => !item.gone)
    if (!live.length) return []
    const marked = rows.filter(row => row.marked)
    const sids = marked.length ? (yield { run: ['python3', ['-c', GETSID, ...marked.map(row => String(row.pid))]] }).trim().split(/\s+/).map(Number) : []
    members = marked.map((row, index) => ({ pid: row.pid, identity: row.identity, session: sids[index] || 0 }))
  }
  for (const item of live) for (const member of members) if (member.session === item.pid) item.members.add(`${member.pid} ${member.identity}`)
  return live
}
const readOrNull = path => { try { return readFileSync(path, 'utf8') } catch { return null } }
function drive(steps) {
  let step = steps.next()
  while (!step.done) step = steps.next(step.value.run ? execFileSync(step.value.run[0], step.value.run[1], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], ...step.value.run[2] }) : step.value.read.map(readOrNull))
  return step.value
}
async function driveAsync(steps) {
  let step = steps.next()
  while (!step.done) step = steps.next(step.value.run ? await execFileAsync(...step.value.run) : await Promise.all(step.value.read.map(path => readFile(path, 'utf8').catch(() => null))))
  return step.value
}

// The processes in `root` that run in the session of a record whose leader
// still runs with its recorded start identity, each with its command line.
export function inLiveSessions(root, owned) {
  const entries = processesIn(root), sessions = sessionsOf(entries.map(entry => entry.pid))
  const live = sight(root, owned, { entries, sessions })
  return entries.filter(entry => live.some(item => item.pid === sessions.get(entry.pid)))
}

// Stops every process listed in `root`, each by its pid while its start
// identity is still the one listed. One can start another while it is
// stopped, so the listing repeats until it comes back empty, a few times at
// most. Returns what it stopped, what the last listing still found (null when
// a listing failed) and what went wrong.
export async function stopProcessesIn(root) {
  const left = [], problems = []
  let remaining = null
  for (let round = 0; round < 4; round++) {
    try { remaining = processesIn(root) } catch (error) { problems.push(`the processes left in ${root} could not be listed: ${error.message}`); remaining = null; break }
    if (!remaining.length || round === 3) break
    left.push(...remaining)
    for (const result of await Promise.allSettled(remaining.map(entry => stopLeftover(entry)))) {
      if (result.status === 'rejected') problems.push(result.reason.message)
    }
  }
  return { left, remaining, problems }
}
