import { existsSync, readFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { durableJson, trustedDirectory, trustedFile } from './builds.js'
import { bootIdentity, ensurePrivateDir, processInfo } from './core.js'

const directory = stateDir => join(stateDir, 'mcp-clients')
const live = record => record.bootId === bootIdentity() && processInfo(record.pid)?.identity === record.identity

// Each native MCP client belongs to the runtime, outside the messaging service.
// On a build change it drains tool calls before closing its native connection.
export function followMcpBuild(stateDir, selected, root, idle, retire) {
  const parent = directory(stateDir)
  ensurePrivateDir(parent); trustedDirectory(parent, 'MCP client registry')
  const path = join(parent, `${process.pid}.json`)
  durableJson(path, { pid: process.pid, identity: processInfo(process.pid)?.identity, bootId: bootIdentity(), root })
  let retired = false
  const timer = setInterval(() => {
    if (retired || !idle()) return
    try {
      if (realpathSync(selected) === root) return
      retired = true; clearInterval(timer); retire()
    } catch { /* A partial installer cannot retire a working tool connection. */ }
  }, 100)
  timer.unref()
  const clean = () => { clearInterval(timer); try { unlinkSync(path) } catch {} }
  process.once('exit', clean)
  return clean
}

export async function waitForMcpBuild(stateDir, root, timeoutMs = 65_000) {
  const parent = directory(stateDir)
  if (!existsSync(parent)) return
  trustedDirectory(parent, 'MCP client registry')
  const deadline = Date.now() + timeoutMs
  while (true) {
    let waiting = false
    for (const name of readdirSync(parent)) {
      if (!/^\d+\.json$/.test(name)) continue
      const path = join(parent, name)
      let record
      try { record = JSON.parse(readFileSync(trustedFile(path, 'MCP client record'), 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      if (!live(record)) { try { unlinkSync(path) } catch {} }
      else if (record.root !== root) waiting = true
    }
    if (!waiting) return
    if (Date.now() >= deadline) throw new Error('Telegram tool calls have not drained; the native runtime was left running')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
