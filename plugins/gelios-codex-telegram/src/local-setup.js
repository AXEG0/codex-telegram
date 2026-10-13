import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { atomicWriteJson, defaultAccess, defaultStateDir, parseEnvFile, safeDisplayName } from './core.js'
import { requestControl } from './control.js'

export function setupFingerprint(action) {
  const values = action.kind === 'configure'
    ? ['configure', String(action.token || '').trim(), Boolean(action.rotate)]
    : ['access', action.command, action.first || null, action.second || null]
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}
// Only the controller calls this on authenticated terminal input, before it
// adds its own source label. Text delivered by Telegram never reaches it.
export function localSetupInput(input = []) {
  const text = input.filter(item => item.type === 'text').map(item => item.text || '').join('\n').trim()
  const match = /^\$telegram:(configure|access)(?:\s+([^\r\n]+))?$/.exec(text)
  if (!match?.[2]) return null
  const args = match[2].trim().split(/\s+/)
  if (match[1] === 'configure') {
    const rotate = args[0] === 'rotate'
    const token = args[rotate ? 1 : 0]
    return args.length === (rotate ? 2 : 1) && /^\d+:[A-Za-z0-9_-]{20,}$/.test(token || '')
      ? { kind: 'configure', token, rotate } : null
  }
  const [command, first, second] = args
  const lengths = { pair: 2, deny: 2, revoke: 2, role: 3, policy: 2 }
  if (args.length !== lengths[command]) return null
  return { kind: 'access', command, first, second }
}
export function setupSocket(stateDir) {
  const profile = join(stateDir, 'launch-profile.json')
  if (existsSync(profile)) return JSON.parse(readFileSync(profile, 'utf8')).controlSocket || join(stateDir, 'control.sock')
  return resolve(stateDir) === resolve(defaultStateDir()) && process.env.GELIOS_TELEGRAM_CONTROL_SOCKET
    ? process.env.GELIOS_TELEGRAM_CONTROL_SOCKET : join(stateDir, 'control.sock')
}
export async function requestLocalSetup(stateDir, action) {
  try { return await requestControl(setupSocket(stateDir), 'local_setup', action, { timeoutMs: 30_000 }) }
  catch (error) { throw new Error(`setup requires a matching request from the local Codex terminal: ${error.message}`) }
}
export function saveConfiguredToken(store, token, { rotate = false } = {}) {
  const path = join(store.dir, '.env')
  if (parseEnvFile(path).TELEGRAM_BOT_TOKEN && !rotate) throw new Error('bot token already configured; invoke $telegram:configure rotate TOKEN locally to rotate it')
  const existing = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(line => !line.startsWith('TELEGRAM_BOT_TOKEN=') && line) : []
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    writeFileSync(temporary, `${[...existing, `TELEGRAM_BOT_TOKEN=${token}`].join('\n')}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally { try { unlinkSync(temporary) } catch {} }
  if (!existsSync(store.accessPath)) atomicWriteJson(store.accessPath, defaultAccess())
  if (!existsSync(store.configPath)) atomicWriteJson(store.configPath, { replyToMode: 'first', inboxRetentionHours: 24 })
}
export function changeAccess(store, { command, first, second, alias, role }) {
  const release = store.lockAccess()
  try {
    const access = store.loadAccess()
    if (command === 'pair') {
      if (!/^[a-f0-9]{6}$/.test(first || '')) throw new Error('pair requires the exact six-character code')
      const pending = access.pending[first]
      if (!pending || pending.expiresAt <= Date.now()) throw new Error('pairing code is unknown or expired')
      role ||= Object.keys(access.users).length ? 'contributor' : 'admin'
      if (!['admin', 'contributor'].includes(role)) throw new Error('role must be admin or contributor')
      alias = safeDisplayName(alias || pending.displayName, pending.senderId)
      access.users[pending.senderId] = { chatId: pending.chatId, alias, role, pairedAt: new Date().toISOString() }
      delete access.pending[first]; store.saveAccess(access)
      return { message: `paired ${alias} (${pending.senderId}) as ${role}`, chatId: pending.chatId, alias, role }
    }
    if (command === 'deny') {
      if (!first || !access.pending[first]) throw new Error('pending pairing code not found')
      delete access.pending[first]
    } else if (command === 'revoke') {
      if (!first || !access.users[first]) throw new Error('paired user ID not found')
      delete access.users[first]
    } else if (command === 'role') {
      if (!access.users[first]) throw new Error('paired user ID not found')
      if (!['admin', 'contributor'].includes(second)) throw new Error('role must be admin or contributor')
      access.users[first].role = second
    } else if (command === 'policy') {
      if (!['pairing', 'allowlist', 'disabled'].includes(first)) throw new Error('policy must be pairing, allowlist, or disabled')
      access.dmPolicy = first
    } else throw new Error('unknown access command')
    store.saveAccess(access)
    return { message: `${command} ${first}${second ? ` ${second}` : ''}` }
  } finally { release() }
}
