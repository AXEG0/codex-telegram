#!/usr/bin/env node
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultStateDir } from '../src/core.js'
import { requestControl } from '../src/control.js'

export function parseRestart(argv, env = process.env) {
  let stateDir = env.GELIOS_TELEGRAM_STATE_DIR || defaultStateDir(), id, timeoutMs, explicitState = false
  const seen = new Set()
  for (let i = 0; i < argv.length; i += 2) {
    if (seen.has(argv[i])) throw new Error('duplicate restart option')
    seen.add(argv[i])
    const value = argv[i + 1]
    if (!value) throw new Error('restart options require a value')
    if (argv[i] === '--state-dir') { stateDir = resolve(value); explicitState = true }
    else if (argv[i] === '--cancel') id = value
    else if (argv[i] === '--timeout') {
      const match = /^(\d+)(ms|s|m|h|d)$/.exec(value)
      if (!match) throw new Error('--timeout must be a positive duration such as 15m')
      timeoutMs = Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86400_000 })[match[2]]
    } else throw new Error('unknown restart option')
  }
  if (Boolean(id) === (timeoutMs !== undefined) || (id && !/^[a-f0-9]{24}$/.test(id)) || (!id && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 365 * 86400_000))) throw new Error('Usage: codex-telegram telegram restart {--timeout 15m|--cancel <request-id>} [--state-dir <path>]')
  return { path: (!explicitState && env.GELIOS_TELEGRAM_CONTROL_SOCKET) || join(stateDir, 'control.sock'), action: id ? 'restart_cancel' : 'restart_request', args: id ? { id } : { timeoutMs } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') === '--help') process.stdout.write('Usage: codex-telegram telegram restart {--timeout 15m|--cancel <request-id>} [--state-dir <path>]\n')
  else try {
    const { path, action, args } = parseRestart(process.argv.slice(2))
    process.stdout.write(JSON.stringify(await requestControl(path, action, args), null, 2) + '\n')
  } catch (error) { process.stderr.write(`restart: ${error.message}\n`); process.exitCode = 1 }
}
