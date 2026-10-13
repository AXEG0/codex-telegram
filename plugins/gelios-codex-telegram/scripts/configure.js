#!/usr/bin/env node
import { chmodSync, existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StateStore, atomicWriteJson, defaultAccess, defaultStateDir, ensurePrivateDir, processInfo } from '../src/core.js'
import { TelegramApi } from '../src/telegram.js'
function readSecret() {
  if (!process.stdin.isTTY || process.env.GELIOS_CODEX_CHILD === '1') throw new Error('configuration requires an interactive local terminal outside Codex')
  for (let pid = process.ppid, depth = 0; pid > 1 && depth < 64; depth++) {
    const info = processInfo(pid); if (!info) break
    if (/^codex/i.test(info.name)) throw new Error('configuration requires an interactive local terminal outside Codex')
    pid = info.ppid
  }
  return new Promise((resolve, reject) => {
    let value = ''
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    const finish = () => {
      process.stdin.off('data', onData); process.stdin.setRawMode(false)
      process.stdin.pause(); process.stdout.write('\n')
    }
    const onData = chunk => { for (const char of chunk) {
      if (char === '\u0003') {
        finish()
        reject(new Error('cancelled')); return
      }
      if (char === '\r' || char === '\n') {
        finish(); resolve(value); return
      }
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
      else value += char
    } }
    process.stdin.on('data', onData)
    process.stdout.write('Telegram bot token: ')
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
  const api = new TelegramApi(token)
  try {
    const bot = await api.call('getMe')
    if (bot?.is_bot !== true) throw new Error('Telegram did not confirm this bot')
  } catch (error) { throw new Error(`bot validation failed: ${String(error.message).split(token).join('[redacted]')}`) }
  finally { api.close() }
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
