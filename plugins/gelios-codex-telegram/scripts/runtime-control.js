#!/usr/bin/env node
import { resolve } from 'node:path'
import { defaultStateDir } from '../src/core.js'
import { runtimeStatus, stopRuntime } from '../src/runtime.js'

const args = process.argv.slice(2)
try {
  const command = args.shift()
  let stateDir = defaultStateDir()
  if (args[0] === '--state-dir' && args[1]) { args.shift(); stateDir = resolve(args.shift()) }
  if (args.length || !['status', 'stop'].includes(command)) throw new Error('Usage: codex-telegram telegram runtime {status|stop} [--state-dir PATH]')
  const result = command === 'stop' ? await stopRuntime(stateDir) : await runtimeStatus(stateDir)
  console.log(JSON.stringify({ ...result, ...(command === 'stop' ? { stopped: true } : {}) }, null, 2))
} catch (error) { console.error(`codex-telegram runtime: ${error.message}`); process.exitCode = 1 }
