#!/usr/bin/env node
import { join } from 'node:path'
import { defaultStateDir } from '../src/core.js'
import { requestControl } from '../src/control.js'
import { offlineRestartStatus } from '../src/restart.js'
const stateDir = defaultStateDir()
const path = process.env.GELIOS_TELEGRAM_CONTROL_SOCKET || join(stateDir, 'control.sock')
try { process.stdout.write(JSON.stringify(await requestControl(path, 'status', {}, { timeoutMs: 1000 }), null, 2) + '\n') }
catch (error) {
  process.exitCode = 1
  try { process.stdout.write(JSON.stringify(await offlineRestartStatus(stateDir), null, 2) + '\n') }
  catch { process.stderr.write(`gelios-codex-telegram status: bridge unavailable (${error.message})\n`) }
}
