import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { processInfo } from './core.js'
import { runSystemctl } from './systemd.js'

const procedure = 'First migration requires an explicit stop of the embedded Codex runtime. Finish its jobs, stop its bridge service (or standalone bridge), then run the current codex-telegram updater. The saved conversation is retained; no running embedded runtime was stopped.'
// Old releases did not record enough process provenance to separate arbitrary
// native/MCP infrastructure from work a turn detached. Never guess or stop it.
export function assertMigrationSafe(status) {
  if (status && !status.runtime) throw new Error(procedure)
}

export async function assertMigrationStopped(profile, { info = processInfo, read = readFileSync, list = readdirSync, run = runSystemctl, platform = process.platform } = {}) {
  const lock = join(profile.stateDir, 'poller.lock')
  if (existsSync(lock)) {
    const owner = JSON.parse(read(lock, 'utf8'))
    if (owner.pid > 1 && info(owner.pid)?.identity === owner.startTime) throw new Error(procedure)
  }
  if (!profile.systemdUnit) return
  const result = await run(['show', profile.systemdUnit, '--property=ActiveState', '--value'], 5000)
  if (result.code !== 0 || !/^(inactive|failed)$/.test(result.output)) throw new Error(procedure)
  // A service can report inactive under KillMode=process while children remain.
  // Require its entire cgroup to be empty, without assigning roles to processes.
  if (platform === 'linux') for (const name of list('/proc').filter(name => /^\d+$/.test(name))) {
    let group
    try { group = read(`/proc/${name}/cgroup`, 'utf8') } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error }
    if (!group.trim().split('\n').some(line => line.split(':').slice(2).join(':').split('/').includes(profile.systemdUnit))) continue
    try { const stat = read(`/proc/${name}/stat`, 'utf8'); if (stat.slice(stat.lastIndexOf(') ') + 2).startsWith('Z ')) continue }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error }
    throw new Error(procedure)
  }
}
