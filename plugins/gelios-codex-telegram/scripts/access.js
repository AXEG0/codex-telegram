#!/usr/bin/env node
import { requestControl } from '../src/control.js'
import { join } from 'node:path'
import { StateStore, defaultStateDir, processInfo, safeDisplayName } from '../src/core.js'
const MUTATING_COMMANDS = new Set(['pair', 'deny', 'revoke', 'role', 'policy'])
function launchedByCodex() {
  if (process.env.GELIOS_CODEX_CHILD === '1') return true
  let pid = process.ppid
  for (let depth = 0; pid > 1 && depth < 64; depth += 1) {
    const info = processInfo(pid); if (!info) return false
    if (/^codex/i.test(info.name)) return true
    pid = info.ppid
  }
  return false
}
function usage() { process.stderr.write('Usage: gelios-codex-telegram access {list|pair|deny|revoke|role|policy} [arguments...]\nAccess changes are local-terminal-only.\n') }
function parse(argv) {
  const positional = [], options = {}
  for (let index = 0; index < argv.length; index += 1) if (argv[index].startsWith('--')) options[argv[index].slice(2)] = argv[++index]
  else positional.push(argv[index])
  return { positional, options }
}
async function notify(controlSocket, args) {
  try { await requestControl(controlSocket, 'notify_paired', args, { timeoutMs: 10_000 }); return true }
  catch { return false }
}
const { positional, options } = parse(process.argv.slice(2)); const [command, first, second] = positional
const stateDir = options['state-dir'] || defaultStateDir()
if (MUTATING_COMMANDS.has(command) && (process.stdin.isTTY !== true || launchedByCodex())) {
  process.stderr.write(`gelios-codex-telegram access: ${command} requires an interactive local terminal (TTY) outside Codex\n`)
  process.exit(1)
}
const store = new StateStore(stateDir)
let release
try {
  if (MUTATING_COMMANDS.has(command)) release = store.lockAccess()
  const access = store.loadAccess()
  if (command === 'list') {
    process.stdout.write(`policy: ${access.dmPolicy}\npaired users: ${Object.keys(access.users).length}\n`)
    for (const [userId, user] of Object.entries(access.users)) process.stdout.write(`  ${userId}  ${user.alias}  ${user.role}  chat=${user.chatId}\n`)
    process.stdout.write(`pending pairings: ${Object.keys(access.pending).length}\n`)
    for (const [code, pending] of Object.entries(access.pending)) process.stdout.write(`  ${code}  ${pending.displayName}  user=${pending.senderId}  expires=${new Date(pending.expiresAt).toISOString()}\n`)
  } else if (command === 'pair') {
    if (!/^[a-f0-9]{6}$/.test(first || '')) throw new Error('pair requires the exact six-character code')
    const pending = access.pending[first]
    if (!pending || pending.expiresAt <= Date.now()) throw new Error('pairing code is unknown or expired')
    const role = options.role || (Object.keys(access.users).length === 0 ? 'admin' : 'contributor')
    if (!['admin', 'contributor'].includes(role)) throw new Error('role must be admin or contributor')
    const alias = safeDisplayName(options.alias || pending.displayName, pending.senderId)
    access.users[pending.senderId] = { chatId: pending.chatId, alias, role, pairedAt: new Date().toISOString() }
    delete access.pending[first]; store.saveAccess(access)
    process.stdout.write(`paired ${alias} (${pending.senderId}) as ${role}\n`)
    release(); release = null
    await notify(process.env.GELIOS_TELEGRAM_CONTROL_SOCKET || join(stateDir, 'control.sock'), { chatId: pending.chatId, alias, role })
  } else if (command === 'deny') {
    if (!first || !access.pending[first]) throw new Error('pending pairing code not found')
    delete access.pending[first]; store.saveAccess(access)
    process.stdout.write(`denied pairing ${first}\n`)
  } else if (command === 'revoke') {
    if (!first || !access.users[first]) throw new Error('paired user ID not found')
    const alias = access.users[first].alias
    delete access.users[first]; store.saveAccess(access)
    process.stdout.write(`revoked ${alias} (${first})\n`)
  } else if (command === 'role') {
    if (!first || !access.users[first]) throw new Error('paired user ID not found')
    if (!['admin', 'contributor'].includes(second)) throw new Error('role must be admin or contributor')
    access.users[first].role = second; store.saveAccess(access)
    process.stdout.write(`set ${access.users[first].alias} (${first}) to ${second}\n`)
  } else if (command === 'policy') {
    if (!['pairing', 'allowlist', 'disabled'].includes(first)) throw new Error('policy must be pairing, allowlist, or disabled')
    access.dmPolicy = first; store.saveAccess(access)
    process.stdout.write(`Telegram DM policy set to ${first}\n`)
  } else {
    usage(); process.exitCode = 2
  }
} catch (error) { process.stderr.write(`gelios-codex-telegram access: ${error.message}\n`); process.exitCode = 1 }
finally { release?.() }
