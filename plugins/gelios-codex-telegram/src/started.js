import { closeSync, constants, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { processInfo } from './core.js'

// Every process the plugin starts for a state folder gets a line in its started.jsonl: pid, start identity
// (core.js processInfo), role and starter. Only a folder that already holds the file gets one: it is opened to
// append without creating it, before any identity is read, so a host, which keeps no record, writes nothing and
// pays one failed open per start; a test's folder creates it (test/support/app-server.js). The starter writes
// its line in the tick of the spawn, before the event loop can reap the child; the bridge, runtime supervisor,
// updater and command supervisor also write their own as they start, before starting anything, so a starter
// killed before its line loses none. Each line is one write to a file opened for appending, which POSIX never
// lets another write overwrite. A write is cut short when there is no room for it (the process's file size
// limit or a full medium) or when a signal interrupts it after some data is written (write(2)); each line
// starts with a newline, so a cut line never joins the next, and ends with one, so a reader that stops at the
// last newline reads every whole line. Nothing renames, trims or syncs it: a host crash ends every process a
// line could name. A failed write changes nothing; the plugin never reads it.
export const START_RECORD = 'started.jsonl'

export function recordStart(stateDir, pid, role, identity = null) {
  if (typeof stateDir !== 'string' || !stateDir || !Number.isSafeInteger(pid) || pid <= 0) return
  let fd
  try { fd = openSync(join(stateDir, START_RECORD), constants.O_WRONLY | constants.O_APPEND) } catch { return }
  try {
    writeSync(fd, `\n${JSON.stringify({ pid, identity: identity || processInfo(pid)?.identity || null, role, by: process.pid, at: Date.now() })}\n`)
  } catch {} finally { try { closeSync(fd) } catch {} }
}
