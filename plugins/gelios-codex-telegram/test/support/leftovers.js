// Finds and stops the processes a test file left running, by the mark every
// one of them carries: the TMPDIR it inherited lies inside a given folder.
// test/fixtures.js stops what its test file left, and test/support/run-tests.js
// what a test file it ended left. Loading this module changes nothing.
import childProcess from 'node:child_process'
import { readFileSync } from 'node:fs'
import { processInfo } from '../../src/core.js'

// The starter test/fixtures.js has not wrapped: ps needs no mark.
const execFileSync = childProcess.execFileSync

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
