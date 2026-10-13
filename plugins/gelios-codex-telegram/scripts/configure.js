#!/usr/bin/env node
import { chmodSync, existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StateStore, atomicWriteJson, defaultAccess, defaultStateDir, ensurePrivateDir } from '../src/core.js'
function readSecret() {
  if (!process.stdin.isTTY || process.env.GELIOS_CODEX_CHILD === '1') throw new Error('configuration requires an interactive local terminal outside Codex')
  return new Promise((resolve, reject) => {
    let value = ''
    process.stdout.write('Telegram bot token: ')
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    const onData = char => {
      if (char === '\u0003') {
        process.stdin.setRawMode(false); process.stdout.write('\n')
        reject(new Error('cancelled')); return
      }
      if (char === '\r' || char === '\n') {
        process.stdin.off('data', onData); process.stdin.setRawMode(false)
        process.stdin.pause(); process.stdout.write('\n'); resolve(value); return
      }
      if (char === '\u007f') value = value.slice(0, -1)
      else value += char
    }
    process.stdin.on('data', onData)
  })
}
const args = process.argv.slice(2)
const stateIndex = args.indexOf('--state-dir')
const stateDir = stateIndex >= 0 ? args[stateIndex + 1] : defaultStateDir()
const force = args.includes('--force')
const envPath = join(stateDir, '.env')
try {
  ensurePrivateDir(stateDir)
  if (existsSync(envPath) && !force) throw new Error(`${envPath} already exists; use --force to rotate it`)
  const token = await readSecret()
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('token has an invalid shape')
  const temp = `${envPath}.tmp-${process.pid}`
  writeFileSync(temp, `TELEGRAM_BOT_TOKEN=${token}\n`, { mode: 0o600 })
  chmodSync(temp, 0o600); renameSync(temp, envPath)
  const store = new StateStore(stateDir)
  if (!existsSync(store.accessPath)) atomicWriteJson(store.accessPath, defaultAccess())
  if (!existsSync(store.configPath)) atomicWriteJson(store.configPath, { replyToMode: 'first', inboxRetentionHours: 24 })
  process.stdout.write(`Telegram state configured at ${stateDir}. Token contents were not displayed.\n`)
} catch (error) {
  process.stderr.write(`gelios-codex-telegram configure: ${error.message}\n`)
  process.exitCode = 1
}
