#!/usr/bin/env node
import { requestControl } from '../src/control.js'
import { join } from 'node:path'
import { StateStore, defaultStateDir, processInfo } from '../src/core.js'
import { changeAccess, requestLocalSetup } from '../src/local-setup.js'
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
const store = new StateStore(stateDir)
try {
  if (command === 'list') {
    const access = store.loadAccess()
    process.stdout.write(`policy: ${access.dmPolicy}\npaired users: ${Object.keys(access.users).length}\n`)
    for (const [userId, user] of Object.entries(access.users)) process.stdout.write(`  ${userId}  ${user.alias}  ${user.role}  chat=${user.chatId}\n`)
    process.stdout.write(`pending pairings: ${Object.keys(access.pending).length}\n`)
    for (const [code, pending] of Object.entries(access.pending)) process.stdout.write(`  ${code}  ${pending.displayName}  user=${pending.senderId}  expires=${new Date(pending.expiresAt).toISOString()}\n`)
  } else if (MUTATING_COMMANDS.has(command)) {
    const action = { kind: 'access', command, first, second }
    const localAgent = process.stdin.isTTY !== true || launchedByCodex()
    const result = localAgent ? await requestLocalSetup(stateDir, action)
      : changeAccess(store, { ...action, alias: options.alias, role: options.role })
    process.stdout.write(`${result.message}\n`)
    if (!localAgent && result.chatId) await notify(join(stateDir, 'control.sock'), result)
  } else { usage(); process.exitCode = 2 }
} catch (error) { process.stderr.write(`gelios-codex-telegram access: ${error.message}\n`); process.exitCode = 1 }
