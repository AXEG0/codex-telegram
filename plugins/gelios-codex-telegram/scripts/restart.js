#!/usr/bin/env node
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultStateDir } from '../src/core.js'
import { requestControl } from '../src/control.js'
import { waitForRestart } from '../src/restart.js'

const usage = 'Usage: codex-telegram telegram restart {--timeout 15m [--wait]|--cancel <request-id>} [--state-dir <path>]'
export function parseRestart(argv, env = process.env) {
  let stateDir = env.GELIOS_TELEGRAM_STATE_DIR || defaultStateDir(), id, timeoutMs, explicitState = false, wait = false
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    if (seen.has(argv[i])) throw new Error('duplicate restart option')
    seen.add(argv[i])
    if (argv[i] === '--wait') { wait = true; continue }
    const value = argv[i + 1]
    if (!value) throw new Error('restart options require a value')
    if (argv[i] === '--state-dir') { stateDir = resolve(value); explicitState = true }
    else if (argv[i] === '--cancel') id = value
    else if (argv[i] === '--timeout') {
      const match = /^(\d+)(ms|s|m|h|d)$/.exec(value)
      if (!match) throw new Error('--timeout must be a positive duration such as 15m')
      timeoutMs = Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86400_000 })[match[2]]
    } else throw new Error('unknown restart option')
    i++
  }
  if (Boolean(id) === (timeoutMs !== undefined) || (id && (wait || !/^[a-f0-9]{24}$/.test(id))) || (!id && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 365 * 86400_000))) throw new Error(usage)
  return { path: (!explicitState && env.GELIOS_TELEGRAM_CONTROL_SOCKET) || join(stateDir, 'control.sock'), stateDir, wait, action: id ? 'restart_cancel' : 'restart_request', args: id ? { id } : { timeoutMs } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') === '--help') process.stdout.write(`${usage}\n`)
  else try {
    const { path, stateDir, wait, action, args } = parseRestart(process.argv.slice(2))
    let result = await requestControl(path, action, args)
    if (wait) ({ code: process.exitCode, restart: result } = await waitForRestart(result, { path, stateDir }))
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (error) { process.stderr.write(`restart: ${error.message}\n`); process.exitCode = 1 }
}
