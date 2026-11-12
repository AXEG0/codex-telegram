// Starts the real Codex app-servers the tests run, and stops everything each
// one started. Codex starts some processes in a session of their own, such as
// the login shell that takes a shell snapshot (codex-rs/core/src/shell_snapshot.rs,
// ProcessMode::NewSession, from rust-v0.160.0 to rust-v0.164.0), so neither the
// app-server's process group nor its exit reaches them. Every process an
// app-server starts inherits its TMPDIR, in whatever session it runs. So each
// app-server gets a folder of its own inside the test file's folder as its
// TMPDIR, and the folder's teardown stops, in turn: what the test names to stop
// first (such as the runtime a bridge started, through stopRuntime), the
// process group of each app-server started here, then every process that still
// carries the folder's mark (test/support/leftovers.js). Before that last stop,
// the test fails naming whatever the test's own stop had to end and did not:
// each process the plugin recorded starting for the state folder, mark or not,
// and what still runs in the sessions they lead. What the last stop
// then ends runs in a session Codex started, such as its shell snapshot's, or
// in one the folder holds no record of. The test also fails when one does not
// exit. The file-level hook in test/fixtures.js is unchanged: it still stops
// and names what a test file leaves running anywhere else.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processInfo } from '../../src/core.js'
import { START_RECORD } from '../../src/started.js'
import { liveGroupMembers, mkdtempSync, spawn, stopGroup } from '../fixtures.js'
import { controlRequest } from '../../scripts/update.js'
import { inLiveSessions, processesIn, runningAs, sessionsOf, sight, sightAsync, stopProcessesIn } from './leftovers.js'
import { cleanup, until } from './wait.js'

const TEMPORARY = ['TMPDIR', 'TMP', 'TEMP']
const named = list => list.map(({ pid, command }) => `${pid} (${command.length > 240 ? command.slice(0, 240) + '...' : command})`).join('; ')
// A command by the names of its program and first argument, without their folders.
const brief = list => list.map(({ pid, command }) => `${pid} (${command.split(' ').slice(0, 2).map(word => word.split('/').pop()).join(' ')})`).join(', ')

// How often the timer reads the records and takes a sighting while a recorded
// leader runs. The timer's sightings do not block the event loop (sightAsync in
// leftovers.js); on macOS each starts a ps and a python3, so they run less
// often there. Only the sighting at a point the test chose, `read()` or a new
// bridge from `bridge()`, runs at once, blocking.
const SIGHTING_MS = process.platform === 'linux' ? 100 : 500

// The processes the plugin starts with `stateDir` as their state folder, each
// by pid and start identity, from the plugin's own record of them,
// started.jsonl (src/started.js), which the plugin writes only where the file
// already exists and which prepareRecord below creates: every bridge, runtime
// supervisor and its app-server, automatic cutover, command supervisor and the
// command it runs, updater, systemd client, ffmpeg and Codex TUI, each written
// by its starter in the tick that started it, and the bridge, runtime
// supervisor, updater and command supervisor by themselves as they start.
// Nothing renames or trims the record, so the timer, `read()` and the teardown
// each read on from where the last read ended, and nothing written between two
// reads is lost. An older release writes no such record: for the
// processes its code starts, such as the released bridge the packaged test
// starts first, they also read the files that release replaces:
// a runtime's native-runtime.json, a bridge from its own status reply at the
// control socket its status.json names, a cutover's automatic-build.json and
// the update command whose receipt update-transaction.json holds; one written
// and replaced between two reads is not read. `bridge(reply)` records a bridge
// the test read through its control socket. The timer also takes a sighting of
// every record whose leader still runs (test/support/leftovers.js), so a
// session whose leader exits is known by a process seen in it. A bridge or an
// updater in this test process records this process's pid, which is no
// process the test left.
// Waits for `promise`, which never rejects, or until `signal`, a cleanup's
// own, ends at its bound.
async function untilBound(promise, signal) {
  if (!signal) return promise
  let ended
  const bound = new Promise(resolve => { ended = resolve; if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })
  try { await Promise.race([promise, bound]) } finally { signal.removeEventListener('abort', ended) }
}

// The record file, made empty and owner-only before the test's first start,
// in a state folder made owner-only when it is not there yet. A state folder
// an earlier folder in this test file already prepared keeps its file as it
// is: adopted with its inode, never truncated, and read from its size at
// adoption, so this folder never names what an earlier folder's test started.
// Returns the file's inode and where its reading starts.
function prepareRecord(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const path = join(stateDir, START_RECORD)
  let fd
  try { fd = openSync(path, 'wx', 0o600) } catch (error) { if (error.code !== 'EEXIST') throw error; fd = openSync(path, 'r') }
  try { const { ino, size } = fstatSync(fd); return { ino, size } } finally { closeSync(fd) }
}

function recorder(stateDir, folder) {
  const seen = new Map(), notes = new Set(), unreadable = new Set(), bridges = new Map(), asked = new Map()
  // What fails the test at the teardown's check: a record line that is not
  // JSON, or a record file gone or replaced. The timer only collects them: a
  // throw there would end the test process instead of failing the test.
  const broken = new Set(), { ino, size: adopted } = prepareRecord(stateDir), path = join(stateDir, START_RECORD)
  let sighting = null, again = false, closed = false, longest = 0, blocking = 0, longestBlocking = 0
  // One sighting at a time; a record that arrives during one gets the next,
  // which starts once that one ends. None starts once the recorder is closed,
  // after the teardown's stops: its own listings sight what follows.
  const sightNow = () => {
    if (closed) return null
    if (sighting) { again = true; return sighting }
    const begun = Date.now()
    sighting = sightAsync(folder, [...seen.values()]).catch(error => { notes.add(`a sighting failed: ${error.message}`) })
      .finally(() => { longest = Math.max(longest, Date.now() - begun); sighting = null; if (again) { again = false; sightNow() } })
    return sighting
  }
  // A sighting at a point the test chose runs then, before the test goes on,
  // even into a synchronous call that replaces what it read.
  const sightHere = () => {
    const begun = Date.now()
    try { sight(folder, [...seen.values()]) } catch (error) { notes.add(`a sighting failed: ${error.message}`) }
    blocking++; longestBlocking = Math.max(longestBlocking, Date.now() - begun)
  }
  // Returns whether the record is new. `how` says where it was first certain:
  // the plugin's record, a read at a point the test chose, or only the timer.
  const RANK = { record: 3, read: 2, timer: 1 }
  const note = (name, pid, identity, how) => {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false
    const key = `${pid} ${identity ?? ''}`
    // The first read names it: an update command's phase moves on while its receipt stays.
    if (seen.has(key)) { const item = seen.get(key); if (RANK[how] > RANK[item.how]) item.how = how; return false }
    seen.set(key, { name, pid, identity: identity ?? null, how, members: new Set() })
    sightNow()
    return true
  }
  const parse = name => {
    let text
    try { text = readFileSync(join(stateDir, name), 'utf8') } catch { unreadable.delete(name); return null }
    try { const value = JSON.parse(text); unreadable.delete(name); return value } catch { unreadable.add(name); return null }
  }
  // A bridge status.json names is asked for its status, which only reads, at
  // the control socket the file names, and recorded from its reply. One that
  // does not answer is not recorded; the diagnostic names it.
  const ask = (pid, socket, how) => {
    const key = `${pid} ${socket}`, known = asked.get(key)
    if (known && known.state !== 'unanswered') return known.done
    const entry = { state: 'asking', pid, socket }
    entry.done = controlRequest(socket, { action: 'status' }, 1000).then(reply => {
      if (Number.isSafeInteger(reply?.pid) && reply.identity) { entry.state = 'answered'; note('the bridge', reply.pid, reply.identity, how) }
      else { entry.state = 'unanswered'; entry.error = 'its reply held no pid and start identity' }
    }, error => { entry.state = 'unanswered'; entry.error = error.message })
    asked.set(key, entry)
    return entry.done
  }
  const readAll = how => {
    const runtime = parse('native-runtime.json'), bridge = parse('status.json'), cutover = parse('automatic-build.json'), update = parse('update-transaction.json')
    let added = false
    if (runtime?.identity) added = note('the runtime supervisor', runtime.pid, runtime.identity, how) || added
    if (bridge?.pid && bridge.pid !== process.pid && typeof bridge.controlSocket === 'string') ask(bridge.pid, bridge.controlSocket, how)
    if (cutover?.pid && cutover.identity) added = note('the automatic cutover', cutover.pid, cutover.identity, how) || added
    if (update?.command?.pid && update.command.identity) added = note(`the update command supervisor (${update.phase})`, update.command.pid, update.command.identity, how) || added
    return added
  }
  // The record is read on from where the last read ended, starting where
  // prepareRecord left it; the bytes after its last newline, a line still
  // being written, are read next time. Only the file prepareRecord made or
  // adopted is read.
  let offset = adopted
  const readRecord = () => {
    let fd
    try { fd = openSync(path, 'r') } catch (error) { broken.add(error.code === 'ENOENT' ? `${path} is gone` : `${path} could not be read: ${error.message}`); return }
    try {
      const { ino: now, size } = fstatSync(fd)
      if (now !== ino) { broken.add(`${path} is no longer the file the folder made`); return }
      if (size <= offset) return
      const buffer = Buffer.alloc(size - offset), length = readSync(fd, buffer, 0, buffer.length, offset)
      const end = buffer.subarray(0, length).lastIndexOf(10) + 1
      offset += end
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        if (!line) continue
        let value
        try { value = JSON.parse(line) } catch { broken.add(`a line of ${path} is not JSON: ${line.slice(0, 120)}`); continue }
        if (value?.identity) note(typeof value.role === 'string' ? value.role : 'a recorded start', value.pid, String(value.identity), 'record')
        else notes.add(`${START_RECORD} records ${value?.role} ${value?.pid} without a start identity`)
      }
    } catch (error) { broken.add(`${path} could not be read: ${error.message}`) } finally { closeSync(fd) }
  }
  const readEvery = how => { readRecord(); readAll(how) }
  readEvery('timer')
  const stop = () => { closed = true; clearInterval(timer) }
  const timer = setInterval(() => {
    readEvery('timer')
    if ([...seen.values()].some(item => item.identity && !item.gone)) sightNow()
  }, SIGHTING_MS)
  timer.unref()
  return {
    seen, notes, bridges, broken,
    // How long the sightings took: the longest off the event loop, and how many
    // blocked it at a point the test chose, with the longest of those.
    timings: () => ({ longest, blocking, longestBlocking }),
    // At a point the test chose a sighting runs whatever the read added: a
    // timer's sighting under way when the test blocks next would end too late.
    read() { readEvery('read'); sightHere() },
    bridge(reply) {
      if (Number.isSafeInteger(reply?.pid) && reply.pid !== process.pid) {
        bridges.set(reply.pid, reply.identity ?? null)
        if (note('the bridge', reply.pid, reply.identity ?? null, 'read')) sightHere()
      }
      return reply
    },
    // Lets the bridge requests under way end (each within 1 s), before the
    // teardown's last read: a bridge's shutdown removes its status.json.
    settle: signal => untilBound(Promise.all([...asked.values()].map(entry => entry.done)), signal),
    // Stops following: no timer read or sighting starts after it.
    stop,
    // Stops following, then lets the sighting under way end; the teardown
    // closes it once its stops have returned, and at its bound.
    // A last read of the record then takes what the stops started.
    async close(signal) { stop(); await untilBound(sighting, signal); readRecord() },
    // The last read, after which every bridge it asked for has answered or not.
    // The files an older release replaces are replaced by rename, so a read
    // never sees them partial; status.json is read only for its control socket.
    async readLast() {
      readEvery('read')
      await Promise.all([...asked.values()].map(entry => entry.done))
      for (const entry of asked.values()) if (entry.state === 'unanswered' && ![...seen.values()].some(item => item.name === 'the bridge' && item.pid === entry.pid)) notes.add(`the bridge ${entry.pid} that status.json named did not answer at ${entry.socket} (${entry.error}), so it is not recorded`)
      if (unreadable.size) notes.add(`${[...unreadable].join(', ')} could not be parsed at the teardown's read`)
    },
  }
}

// What a test's own stop had to end and did not, in one listing: each process
// `owned` names by its pid and start identity that still runs, whatever
// TMPDIR it inherited, other than this test process (a process systemd starts
// for the plugin carries no mark), and among the processes still running in
// `root`, each member of a session one of them leads. An owned
// process the plugin started detached leads a session, and everything it
// starts stays in that session unless it calls setsid: its own process groups
// too, such as the MCP servers Codex starts in groups of their own. Codex
// starts its shell snapshot and its shell commands with setsid, so those are
// in none of these sessions. While a leader runs with its start identity, its
// session is the recorded one. Once it is gone, its session id is given out
// again only after the session has emptied (Linux frees a pid number only
// when no task holds it as a pid, group or session id; XNU's pid allocation
// skips any id a live process, group or session holds), so a session with
// that id is the recorded one only when a process now in it was seen in it at
// a sighting while its leader ran; otherwise none of it is named and
// `unnamed` says why. A process the plugin started itself needs no sighting:
// its own record names it by pid and start identity.
function stillRunning(root, owned) {
  const entries = processesIn(root), sessions = sessionsOf(entries.map(entry => entry.pid))
  const live = sight(root, owned, { entries, sessions })
  const found = [], unnamed = [], holders = new Map()
  const holderOf = session => { if (!holders.has(session)) holders.set(session, processInfo(session)); return holders.get(session) }
  const same = item => other => other.pid === item.pid && other.identity === item.identity
  const recorded = owned.filter(item => item.identity && item.pid !== process.pid)
  const unmarked = runningAs(recorded.filter(item => !entries.some(same(item))))
  for (const item of recorded) {
    const entry = entries.find(same(item)) ?? unmarked.find(same(item))
    if (entry) found.push({ ...entry, role: item.name })
  }
  for (const entry of entries) {
    if (found.some(item => item.pid === entry.pid)) continue
    const session = sessions.get(entry.pid), records = owned.filter(item => item.pid === session)
    if (!records.length) continue
    const leader = live.find(item => item.pid === session)
    if (leader) { found.push({ ...entry, role: `in the session of ${leader.name} ${leader.pid}` }); continue }
    // A process holds the id: the leader itself, or another process, and
    // then that session ended before the id was given out again.
    const holder = holderOf(session)
    if (holder) {
      const same = records.find(item => item.identity && item.identity === holder.identity)
      if (same) found.push({ ...entry, role: `in the session of ${same.name} ${same.pid}` })
      continue
    }
    const company = entries.filter(other => sessions.get(other.pid) === session)
    const witness = records.find(item => company.some(other => item.members.has(`${other.pid} ${other.identity}`)))
    if (witness) found.push({ ...entry, role: `in the session of ${witness.name} ${witness.pid}` })
    else unnamed.push({ ...entry, role: `in a session with the id of ${records[0].name} ${session}` })
  }
  return { found, unnamed }
}
const roles = list => list.map(entry => `${entry.role}: ${named([entry])}`).join('; ')
const notNamed = list => `not named, since no process now in its session was seen there while its leader ran: ${roles(list)}`

// A folder for the app-servers of one test, with its teardown registered on `t`
// now, as two cleanup items: they run after the cleanups registered before
// them and before those registered after them. `stop` stops what started an
// app-server elsewhere, such as a bridge's runtime; `env(base)` is `base` with
// the folder as its TMPDIR, for a runtime or a launcher that starts the
// app-server; `within(fn)` runs `fn` with the folder as this test process's
// own TMPDIR, for a bridge that starts its runtime from process.env; `start`
// starts `codex app-server --listen stdio://` there itself.
// `stateDir` is the state folder of the runtimes, bridges and updates the test
// starts there, made here with the record file before the test's first start,
// so the folder comes before anything the test starts there. Each one recorded
// there (see recorder above), mark or not, and what runs in
// its session, must be gone before the first item reaches its bound, once
// `stop` and the group stops have run, or the test fails naming it. `read()`
// records what the state folder holds now and takes a sighting; `bridge(reply)`
// records a bridge from its status reply and returns the reply. The test also
// fails when the teardown's read finds no runtime record, when a bridge it
// read has no start identity, when a record line is not JSON, or when the
// record file is gone or replaced.
export function appServerFolder(t, { what = 'the app server', stop, stateDir } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'a-'))
  const started = new Set()
  const records = stateDir ? recorder(stateDir, folder) : null
  // The first item: the stops, then the check. Every step runs even when an
  // earlier one fails, so one failed stop leaves nothing else behind.
  // The labels drop a leading article: cleanup() reports "the <label> cleanup".
  cleanup(t, `stop and check of ${what}`, async hook => {
    const problems = []
    // Once this item's bound ends, cleanup() goes on to the folder stop
    // without ending this function (test/support/wait.js:284-286), so from
    // then on it starts no further step and sends no further signal.
    const step = async run => { if (hook.signal.aborted) return; try { await run() } catch (error) { problems.push(error.message) } }
    // Taken before the stops: every runtime, bridge, cutover and update command
    // recorded (a runtime's app-server and Codex's MCP servers run in the
    // runtime's session), with a last sighting of each: what their sessions
    // hold right before the stop is named in the diagnostic below. The timer
    // keeps reading and sighting through the stops, and closes once they have
    // returned, or at this item's bound.
    const owned = []
    let before = []
    if (records) {
      hook.signal.addEventListener('abort', records.stop, { once: true })
      await records.settle(hook.signal)
      await records.readLast()
      owned.push(...records.seen.values())
      try { before = inLiveSessions(folder, owned) } catch (error) { records.notes.add(`the sighting before the stop failed: ${error.message}`) }
      if (!owned.some(item => item.name === 'the runtime supervisor')) problems.push(`no runtime record in ${stateDir} at the teardown's read, so its stop could not be checked`)
      for (const [pid, identity] of records.bridges) if (!identity) problems.push(`the bridge ${pid} the test read has no record: its start identity could not be read`)
    }
    if (stop) await step(() => stop(hook))
    for (const app of started) if (app.pid) await step(() => stopGroup(app.pid, { signal: hook.signal }))
    if (records) {
      await records.close(hook.signal)
      hook.signal.removeEventListener('abort', records.stop)
      // A record read while the stops ran is checked too.
      for (const item of records.seen.values()) if (!owned.includes(item)) owned.push(item)
      problems.push(...records.broken)
    }
    if (owned.length && !hook.signal.aborted) {
      // Written before the wait, so they reach the report when its bound cuts it.
      const held = before.length ? `; before it their sessions held ${brief(before)}` : ''
      const { longest, blocking, longestBlocking } = records.timings()
      const timed = `; the longest sighting off the event loop took ${longest} ms` + (blocking ? `, and the longest of the ${blocking} at a point the test chose, which block it, ${longestBlocking} ms` : ', and none ran at a point the test chose')
      hook.diagnostic(`${what}: checked after its stop: ${owned.map(item => `${item.name} ${item.pid}${item.how === 'timer' ? ' (read by the timer only)' : ''}`).join(', ')}${held}${timed}`)
      if (records.notes.size) hook.diagnostic(`${what}: ${[...records.notes].join('; ')}`)
      if (problems.length) hook.diagnostic(`${what}: before the check: ${problems.join('; ')}`)
      // What the stops above had to end and still runs is waited for through
      // until() on this item's context: the wait ends when none of it is left,
      // or at this item's bound, never on a clock of its own. When the bound
      // cuts it, until writes this description, so what is left is named in
      // the report; the folder stop is the next item, so it runs either way.
      // What that stop ends runs in a session Codex started or one the folder
      // holds no record of.
      let last = null, first = null
      const begun = Date.now()
      await step(async () => {
        await until(hook, () => { last = stillRunning(folder, owned); first ??= last.found; return !last.found.length },
          () => !last ? "the test's own stop to end what it had to end, before the first listing" : `the test's own stop to end what is still running after its stop: ${roles(last.found)}${last.unnamed.length ? `; ${notNamed(last.unnamed)}` : ''}`)
        hook.diagnostic(`${what}: ${first.length ? `waited ${Date.now() - begun} ms for ${named(first)}` : 'none of theirs was left at the first look after it'}`)
        if (last.unnamed.length) hook.diagnostic(`${what}: ${notNamed(last.unnamed)}`)
      })
    }
    if (problems.length) throw new Error(problems.join('; '))
  // Its stop's bounded parts take 29 s at most: the waits for bridge replies
  // (1 s each), the bridge's 2 s for its app, and stopRuntime's 5 s status,
  // 10 s stop request and 10 s exit (src/runtime.js:22, :164-167).
  }, { timeout: 60_000 })
  // The second item, under main's bound: every process that still carries the
  // folder's mark, after a failed or cut check too.
  cleanup(t, what.replace(/^the /, ''), async hook => {
    const { left, remaining, problems } = await stopProcessesIn(folder)
    if (left.length) hook.diagnostic(`${what}: its teardown stopped ${left.length} process(es) it started: ${named(left)}`)
    if (remaining?.length) problems.push(`still running in ${folder} after its teardown: ${named(remaining)}`)
    if (problems.length) throw new Error(problems.join('; '))
  }, { timeout: 30_000 })
  const env = (base = process.env) => ({ ...base, ...Object.fromEntries(TEMPORARY.map(name => [name, folder])) })
  return {
    folder,
    env,
    read: () => records?.read(),
    bridge: reply => records ? records.bridge(reply) : reply,
    async within(fn) {
      const saved = TEMPORARY.map(name => [name, process.env[name]])
      Object.assign(process.env, env({}))
      try { return await fn() } finally { for (const [name, value] of saved) if (value === undefined) delete process.env[name]; else process.env[name] = value }
    },
    start(codexBin, { cwd, env: base = process.env } = {}) {
      const app = spawn(codexBin, ['app-server', '--listen', 'stdio://'], { cwd, env: env(base), stdio: ['pipe', 'pipe', 'pipe'] })
      started.add(app)
      // An app-server whose group has no live member left at close is forgotten,
      // as spawn in test/fixtures.js forgets its group, so the teardown never
      // signals a group id the system has given out again since.
      app.once('close', () => { if (app.pid && !liveGroupMembers(app.pid).length) started.delete(app) })
      return app
    },
  }
}

// One app-server in a folder of its own.
export const startAppServer = (t, codexBin, { what, stop, stateDir, ...options } = {}) => appServerFolder(t, { what, stop, stateDir }).start(codexBin, options)

// `base` with a HOME inside `root` whose shell startup files sleep 5 seconds,
// so every shell snapshot an app-server takes with it outlives a short test,
// and without what would point bash or zsh at other startup files. Codex's
// snapshot sources ~/.bashrc in bash and $ZDOTDIR/.zshrc or ~/.zshrc in zsh
// (codex-rs/shell-command/src/startup.rs), whichever shell the account uses.
export function slowShellEnv(root, base = process.env) {
  const home = join(root, 'slow-shell-home')
  mkdirSync(home)
  for (const name of ['.bashrc', '.zshrc']) writeFileSync(join(home, name), 'sleep 5\n')
  const env = { ...base, HOME: home }
  delete env.ZDOTDIR; delete env.BASH_ENV; delete env.ENV
  return env
}

// Whether a shell snapshot runs its startup file in `folder`: a `sleep` whose
// parent is a process outside the process group of the app-server `pid`, the
// shell started in a session of its own. Before it reads the startup file, a
// login shell starts other short-lived children, forks of itself and the system
// profile's scripts, so only the `sleep` itself counts. When Codex ends, it
// kills only the shell it started, by its pid (Drop for NativeChild in
// codex-rs/utils/pty/src/posix_child.rs at rust-v0.162.0), so the `sleep`
// outlives it, and only the folder's teardown reaches it.
export function snapshotRunning(folder, pid) {
  const group = processInfo(pid)?.pgid
  const outside = processesIn(folder).filter(entry => processInfo(entry.pid)?.pgid !== group)
  const shells = new Set(outside.map(entry => entry.pid))
  return outside.some(entry => { const info = processInfo(entry.pid); return shells.has(info?.ppid) && info?.name === 'sleep' })
}
