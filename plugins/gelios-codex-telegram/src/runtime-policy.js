import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { trustedDirectory, trustedFile } from './builds.js'
import { runSystemctl } from './systemd.js'

const marker = '# Managed Codex runtime policy; no environment or credentials.\n'
// Lifecycle, descriptors and credential delivery belong to the independent
// supervisor. Other Service directives retain the operator's execution policy.
const owned = /^(Exec.*|Environment.*|PassEnvironment|UnsetEnvironment|LoadCredential.*|SetCredential.*|ImportCredential.*|Type|BusName|PIDFile|RemainAfterExit|Restart.*|RuntimeMaxSec|RuntimeRandomizedExtraSec|SuccessExitStatus|Watchdog.*|NotifyAccess|Kill.*|SendSIGKILL|Timeout.*|Standard.*|WorkingDirectory|UMask|RuntimeDirectory.*|StateDirectory.*|CacheDirectory.*|LogsDirectory.*|ConfigurationDirectory.*)$/
export function inheritedPolicy(source) {
  let section = '', continuation = '', lines = [], runtimeDirectories = [], preserveDirectories = 'no'
  for (const physical of source.split('\n')) {
    const line = continuation + physical.trim()
    if (/\\$/.test(line)) { continuation = line.slice(0, -1) + ' '; continue }
    continuation = ''
    if (!line || /^[#;]/.test(line)) continue
    if (/^\[.*\]$/.test(line)) { section = line; continue }
    if (section !== '[Service]') continue
    const at = line.indexOf('='); if (at < 1) throw new Error('cannot read the bridge execution policy')
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (key === 'RuntimeDirectory') runtimeDirectories = value ? [...runtimeDirectories, value] : []
    if (key === 'RuntimeDirectoryPreserve') preserveDirectories = value
    if (owned.test(key)) continue
    if (/(^|[^%])(?:%%)*%[nNpPiIjJf]/.test(line.slice(at + 1)))
      throw new Error(`bridge policy ${key} uses a unit-specific specifier; replace it with a literal value in the bridge unit before migration`)
    lines.push(line)
  }
  if (continuation) throw new Error('bridge execution policy has an unfinished continuation')
  if (runtimeDirectories.length && preserveDirectories !== 'yes')
    throw new Error('bridge RuntimeDirectory is removed on stop; make runtime data persistent before separating its native process')
  return marker + '[Service]\n' + lines.join('\n') + '\n'
}
function pathFor(unit) {
  const root = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`
  return join(root, 'systemd/user', unit + '.d', '50-codex-inherited.conf')
}
export async function prepareRuntimePolicy(bridgeUnit, runtimeUnit, run = runSystemctl) {
  const result = await run(['cat', bridgeUnit], 5000, 1024 * 1024)
  if (result.code !== 0) throw new Error(`cannot inspect the bridge execution policy (systemctl exit ${result.code})`)
  const policy = inheritedPolicy(result.output), path = pathFor(runtimeUnit), directory = join(path, '..')
  mkdirSync(directory, { recursive: true, mode: 0o700 }); trustedDirectory(directory, 'runtime policy directory')
  if (existsSync(path)) {
    trustedFile(path, 'runtime inherited policy')
    if (!readFileSync(path, 'utf8').startsWith(marker)) throw new Error('runtime inherited policy is not managed by this launcher')
  }
  writeFileSync(path, policy, { mode: 0o600 }); chmodSync(path, 0o600)
  const reload = await run(['daemon-reload'], 5000)
  if (reload.code !== 0) throw new Error(`cannot load the inherited runtime policy (systemctl exit ${reload.code})`)
}
export function cleanupRuntimePolicy(unit) {
  const path = pathFor(unit)
  if (!existsSync(path)) return
  trustedFile(path, 'runtime inherited policy')
  if (!readFileSync(path, 'utf8').startsWith(marker)) throw new Error('runtime inherited policy is not managed by this launcher')
  unlinkSync(path)
  try { rmdirSync(join(path, '..')) } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error }
}
