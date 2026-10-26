import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
// `bridge --detach --systemd-unit` allows a unit's process this long to answer as a running bridge.
export const SUPERVISED_START_MS = 20_000

export function runSystemctl(args, timeoutMs = 30_000) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(HOME|PATH|USER|LOGNAME|XDG_RUNTIME_DIR|TMPDIR|TMP|TEMP|NODE_DISABLE_COMPILE_CACHE)$/.test(name)))
  env.LC_ALL = 'C'
  if (!env.XDG_RUNTIME_DIR && process.getuid && existsSync(`/run/user/${process.getuid()}`)) env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`
  return new Promise(resolve => {
    let output = '', settled = false
    const finish = code => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, output: output.trim() }) }
    const child = spawn('systemctl', ['--user', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null) }, timeoutMs)
    const append = chunk => { output = (output + chunk).slice(-4000) }
    child.stdout.on('data', append); child.stderr.on('data', append)
    child.once('error', error => { append(error.message); finish(null) })
    child.once('close', code => finish(code))
  })
}
export async function unitState(unit, run = runSystemctl) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,120}\.service$/.test(unit)) throw new Error('restart requires a configured systemd service unit')
  const result = await run(['show', unit, ...['MainPID', 'ActiveState', 'LoadState', 'CanStart', 'CanStop', 'RefuseManualStop', 'Result', 'Job'].map(name => `--property=${name}`)], 5000)
  if (result.code !== 0) throw new Error(`systemd unit is unavailable: ${result.output || result.code}`)
  return Object.fromEntries(result.output.split('\n').filter(line => line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
}
