#!/usr/bin/env node
import { defaultStateDir } from '../src/core.js'
import { runSharedTui } from '../src/tui.js'
let stateDir = defaultStateDir(), noAltScreen = false
const cancellation = new AbortController()
const cancel = () => cancellation.abort()
const interrupt = () => {}
process.on('SIGTERM', cancel); process.on('SIGHUP', cancel); process.on('SIGINT', interrupt)
try {
  const args = process.argv.slice(2)
  while (args.length) {
    const arg = args.shift()
    if (arg === '--state-dir' && args[0]) stateDir = args.shift()
    else if (arg === '--no-alt-screen') noAltScreen = true
    else throw new Error('usage: gelios-codex-telegram tui [--state-dir PATH] [--no-alt-screen]')
  }
  process.exitCode = await runSharedTui({ stateDir, noAltScreen, signal: cancellation.signal })
} catch (error) {
  process.stderr.write(`gelios-codex-telegram tui: ${error.message}\n`)
  process.exitCode = 1
} finally {
  process.off('SIGTERM', cancel); process.off('SIGHUP', cancel); process.off('SIGINT', interrupt)
}
