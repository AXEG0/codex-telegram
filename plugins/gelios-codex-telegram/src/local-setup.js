import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { atomicWriteJson, defaultAccess, defaultStateDir, parseEnvFile, readJson, safeDisplayName } from './core.js'
import { requestControl } from './control.js'
import { BOT_USERNAME, CHAT_ID, USER_ID } from './policy.js'
import { checkTranscription, parsePatterns, parseSetting } from './settings.js'

export function setupFingerprint(action) {
  const values = action.kind === 'configure'
    ? ['configure', String(action.token || '').trim(), Boolean(action.rotate)]
    : ['access', action.command, action.first || null, action.second || null, ...(action.rest === undefined ? [] : [action.rest])]
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
  return accessAction(args, match[2].trim())
}
// The access action named by a command's words. `set KEY VALUE` keeps VALUE exactly as written, spaces
// included; `group add|rm CHAT_ID` keeps its flags, joined by single spaces, as the rest.
export function accessAction(args, line = args.join(' ')) {
  const [command, first, second] = args
  if (command === 'set') {
    const value = /^set\s+\S+\s+(.+)$/.exec(line)?.[1]
    return value === undefined ? null : { kind: 'access', command, first, rest: value.trim() }
  }
  if (command === 'group') return ['add', 'rm'].includes(first) && second ? { kind: 'access', command, first, second, rest: args.slice(3).join(' ') } : null
  const lengths = { pair: 2, deny: 2, revoke: 2, role: 3, policy: 2, bot: 3 }
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
// A group's flags: --no-mention lets every admitted message through, --allow limits it to listed members.
function groupPolicy(rest) {
  const words = rest ? rest.split(' ') : []; const policy = { requireMention: true, allowFrom: [] }
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] === '--no-mention') policy.requireMention = false
    else if (words[index] === '--allow' && words[index + 1]) {
      policy.allowFrom = words[++index].split(',').filter(Boolean)
      if (!policy.allowFrom.length || policy.allowFrom.some(id => !USER_ID.test(id))) throw new Error('--allow takes numeric user IDs separated by commas')
    } else throw new Error(`unknown group flag ${words[index]}; use --no-mention or --allow ID,ID`)
  }
  return policy
}
// `set KEY VALUE`: mention patterns are access policy; every other key is a channel setting in config.json.
function changeSetting(store, access, key, raw) {
  if (key === 'mentionPatterns') { access.mentionPatterns = parsePatterns(raw); return true }
  const config = readJson(store.configPath, {}, 'channel config'); config[key] = parseSetting(key, raw)
  if (['transcriptionModel', 'transcriptionLanguages'].includes(key)) checkTranscription(config)
  atomicWriteJson(store.configPath, config)
  return false
}
export function changeAccess(store, { command, first, second, rest, alias, role }) {
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
    } else if (command === 'group') {
      if (!CHAT_ID.test(second || '') || !second.startsWith('-')) throw new Error('group takes the group\'s negative numeric chat ID')
      if (first === 'add') access.groups[second] = groupPolicy(rest)
      else if (!access.groups[second]) throw new Error('group not found')
      else delete access.groups[second]
    } else if (command === 'bot') {
      const username = String(second || '').replace(/^@/, '')
      if (!USER_ID.test(first || '') || !BOT_USERNAME.test(username)) throw new Error('bot takes the bot\'s numeric ID and its @username ending in bot')
      // A new pin time starts a new first contact, so pinning again clears a stopped one.
      const now = new Date().toISOString()
      access.users[first] = { chatId: first, alias: safeDisplayName(username), role: 'contributor', pairedAt: now, ...access.users[first], botUsername: username, botPinnedAt: now }
      store.saveAccess(access)
      return { message: `pinned bot ${first} to @${username}; a reply reaches it once it has answered from ${first}` }
    } else if (command === 'set') {
      if (!changeSetting(store, access, first, rest)) return { message: `set ${first}` }
    } else throw new Error('unknown access command')
    store.saveAccess(access)
    return { message: `${command} ${first}${second ? ` ${second}` : ''}${rest ? ` ${rest}` : ''}` }
  } finally { release() }
}
