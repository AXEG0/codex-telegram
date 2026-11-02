import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { processGroupMembers, processInfo } from './core.js'

// An old embedded runtime cannot be adopted in place. Inspect the processes
// its shutdown would own, rather than treating "no active turn" as "no work".
export function migrationJobs(status, profile, root, { info = processInfo, read = readFileSync, list = readdirSync, members = processGroupMembers, platform = process.platform } = {}) {
  if (status.runtime) return []
  const bridge = info(status.pid)
  if (!bridge || bridge.identity !== status.identity) throw new Error('cannot verify the embedded runtime before migration')
  const allowed = new Set([status.pid, status.appPid])
  // Validation itself can run under the old service. Exempt only its ancestry,
  // never all descendants of the native process (those include the jobs).
  for (let pid = process.pid; pid > 1 && !allowed.has(pid); pid = info(pid)?.ppid || 0) allowed.add(pid)
  let pids = [status.pid, ...members(bridge.pgid)]
  const args = pid => {
    try {
      return platform === 'linux' ? read(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean)
        : execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/)
    } catch { return [] }
  }
  if (platform === 'linux' && profile.systemdUnit) {
    const group = read(`/proc/${status.pid}/cgroup`, 'utf8')
    // A real systemd unit owns detached groups too. The process-group fallback
    // is only for stand-in managers with no corresponding kernel cgroup.
    const serviceGroups = group.trim().split('\n').filter(line => line.split(':').slice(2).join(':').split('/').includes(profile.systemdUnit))
    if (serviceGroups.length) {
      pids = list('/proc').filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
        try { return read(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n').some(line =>
          serviceGroups.some(parent => line === parent || line.startsWith(parent + '/'))) } catch { return false }
      })
    }
  }
  const manifest = join(root, '.mcp.json')
  const servers = existsSync(manifest) ? Object.values(JSON.parse(read(manifest, 'utf8')).mcpServers || {}) : []
  return pids.filter(pid => {
    if (allowed.has(pid)) return false
    const process = info(pid); if (!process) return false
    if (platform === 'linux') {
      try { const stat = read(`/proc/${pid}/stat`, 'utf8'); if (stat.slice(stat.lastIndexOf(') ') + 2).startsWith('Z ')) return false } catch {}
    }
    const argv = args(pid)
    // Native infrastructure and the exact shipped MCP entry are not work.
    // Unknown helpers are retained conservatively until the operator finishes
    // them; grandchildren of these servers are still inspected independently.
    if (process.ppid === status.appPid && basename(argv[0] || '') === 'codex-code-mode-host') return false
    if (process.ppid === status.appPid && servers.some(server =>
      basename(argv[0] || '') === basename(server.command || '') && JSON.stringify(argv.slice(1)) === JSON.stringify(server.args || []))) return false
    return true
  }).map(pid => ({ pid, identity: info(pid)?.identity, name: info(pid)?.name }))
}

export function assertMigrationSafe(status, profile, root, dependencies) {
  const jobs = migrationJobs(status, profile, root, dependencies)
  if (jobs.length) throw new Error(`Embedded runtime migration is waiting for owned processes: ${jobs.map(job => `${job.pid} (${job.name})`).join(', ')}. Finish that work before upgrading; the running bridge and jobs were left intact.`)
}
