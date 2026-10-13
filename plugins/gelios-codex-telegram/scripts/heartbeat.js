#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultStateDir } from '../src/core.js'
import { requestControl } from '../src/control.js'

function parse(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--every', '--prompt-file', '--state-dir'].includes(rest[i]) || rest[i + 1] === undefined) throw new Error('invalid heartbeat arguments')
    options[rest[i].slice(2)] = rest[i + 1]
  }
  const path = process.env.GELIOS_TELEGRAM_CONTROL_SOCKET || join(options['state-dir'] || defaultStateDir(), 'control.sock')
  if (command === 'status') return { path, action: 'heartbeat_status', args: {} }
  if (command === 'disable') return { path, action: 'heartbeat_configure', args: { enabled: false } }
  if (command !== 'enable') throw new Error('Usage: gelios-codex-telegram heartbeat {status|disable|enable --every <1s..365d> --prompt-file <path>} [--state-dir <path>]')
  const match = /^(\d+)(s|m|h|d)$/.exec(options.every || '')
  if (!match || !options['prompt-file']) throw new Error('enable requires --every (e.g. 1h) and --prompt-file')
  const intervalMs = Number(match[1]) * ({ s: 1000, m: 60_000, h: 3600_000, d: 86400_000 })[match[2]]
  const prompt = readFileSync(options['prompt-file'], 'utf8')
  return { path, action: 'heartbeat_configure', args: { enabled: true, intervalMs, prompt } }
}
try {
  const { path, action, args } = parse(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(await requestControl(path, action, args), null, 2)}\n`)
} catch (error) { process.stderr.write(`heartbeat: ${error.message}\n`); process.exitCode = 1 }
