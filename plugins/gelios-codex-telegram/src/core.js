import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { ACCESS_VERSION, admitPrivate, destination, normalizeAccess, senderAdmitted } from './policy.js'
import { questionsOf } from './questions.js'
export const MAX_TEXT = 4096
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
export const MAX_SEND_BYTES = 50 * 1024 * 1024
export const MAX_INBOX_BYTES = 200 * 1024 * 1024
export const PAIRING_TTL_MS = 60 * 60 * 1000
export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000
export const CALLBACK_TTL_MS = 10 * 60 * 1000
export const MESSAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000, MAX_MESSAGE_CACHE_ENTRIES = 2048
// Every bridge.log line, each line of a multi-line message included, starts with the UTC time it was written.
export const logLines = (message, now = new Date()) => String(message).replace(/\r?\n$/, '').split(/\r?\n/).map(line => `${now.toISOString()} gelios-codex-telegram: ${line}\n`).join('')
export function defaultStateDir() {
  return process.env.GELIOS_TELEGRAM_STATE_DIR || join(homedir(), '.local', 'state', 'gelios-codex-telegram')
}
// The static access snapshot is shared by every check, so it cannot be changed by one of them.
function deepFreeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value) } return value }
export function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}
// Linux reads /proc; macOS asks the system ps, pgrep, and sysctl binaries with a fixed locale and zone.
const systemTool = (path, args) => execFileSync(path, args, { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'] })
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function processInfo(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
      return { ppid: Number(fields[1]), pgid: Number(fields[2]), identity: fields[19] || null, name: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')) }
    }
    const [ppid, pgid, , month, day, time, year, ...name] = systemTool('/bin/ps', ['-o', 'ppid=,pgid=,lstart=,ucomm=', '-p', String(pid)]).trim().split(/\s+/)
    const start = Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), ...time.split(':').map(Number)) / 1000
    return { ppid: Number(ppid), pgid: Number(pgid), identity: Number.isInteger(start) && start > 0 ? String(start) : null, name: name.join(' ') }
  } catch { return null }
}
export function processGroupMembers(groupId) {
  if (process.platform === 'linux') return readdirSync('/proc').filter(value => /^\d+$/.test(value)).map(Number).filter(pid => pid !== process.pid && processInfo(pid)?.pgid === groupId)
  try { return systemTool('/usr/bin/pgrep', ['-g', String(groupId)]).split('\n').filter(Boolean).map(Number).filter(pid => pid !== process.pid) } catch (error) { if (error?.status === 1) return []; throw error }
}
export function bootIdentity() {
  const value = (process.platform === 'linux' ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8') : systemTool('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])).trim().toLowerCase()
  if (!/^[a-f0-9-]{16,64}$/.test(value)) throw new Error('could not verify the host boot identity')
  return value
}
// Without /proc/self/fd, accept the re-resolved path only while it still names the opened inode.
function descriptorPath(descriptor, path) {
  const candidate = realpathSync(path); const opened = fstatSync(descriptor); const current = statSync(candidate)
  if (opened.dev !== current.dev || opened.ino !== current.ino) throw new Error(`file changed while opening: ${path}`)
  return candidate
}
export function atomicWriteJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}
export function readJson(path, fallback, label = basename(path)) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback)
    throw new Error(`${label} is unreadable or corrupt; refusing to continue`)
  }
}
export function parseEnvFile(path) {
  const values = {}
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
    chmodSync(path, 0o600)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
    if (!match) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}
export function loadToken(stateDir) {
  const token = process.env.TELEGRAM_BOT_TOKEN || parseEnvFile(join(stateDir, '.env')).TELEGRAM_BOT_TOKEN
  if (!token) throw new Error(`TELEGRAM_BOT_TOKEN is not configured in the environment or ${join(stateDir, '.env')}`)
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('TELEGRAM_BOT_TOKEN has an invalid shape')
  return token
}
export function defaultAccess() {
  return { version: ACCESS_VERSION, dmPolicy: 'pairing', users: {}, pending: {}, groups: {}, mentionPatterns: [] }
}
export const RUNTIME_VERSION = 1
export function defaultRuntime() { return { version: RUNTIME_VERSION, sequence: 0, updateOffset: 0, events: {}, controls: {}, callbacks: {}, attachments: {}, messages: {}, emptyThreads: {} } }
function privatePathContains(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}
// A new event in a runtime the caller holds, saved with whatever else the caller changes in the same step.
export function addEvent(runtime, eventId, details) {
  runtime.sequence += 1
  if (typeof details === 'function') details = details(runtime.sequence)
  return (runtime.events[eventId] = { ...details, eventId, sequence: runtime.sequence, status: 'received', createdAt: Date.now(), updatedAt: Date.now() })
}
export function safeDisplayName(value, fallback = 'user') {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[\/\\[\]{}<>|;\r\n\t\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
  return cleaned || fallback
}
export function safeFilename(value, fallback = 'attachment') {
  const cleaned = basename(String(value || ''))
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return cleaned || fallback
}
export function safeMetadataValue(value, fallback = 'unknown', limit = 128) {
  const cleaned = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f\[\]{}<>|;=]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
  return cleaned || fallback
}
export function sanitizeAttachmentMeta(meta = {}) {
  const sanitized = { ...meta }
  if (meta.kind != null) sanitized.kind = safeMetadataValue(meta.kind, 'attachment', 64)
  if (meta.mime != null) sanitized.mime = safeMetadataValue(meta.mime, 'application/octet-stream', 128)
  if (meta.name != null) sanitized.name = safeFilename(meta.name)
  if (meta.size != null) {
    const size = Number(meta.size)
    sanitized.size = Number.isFinite(size) && size >= 0 ? Math.trunc(size) : null
  }
  return sanitized
}
function messageCacheKey(chatId, messageId) { const chat = String(chatId); const message = String(messageId)
  if (!/^-?[0-9]+$/.test(chat) || !/^[0-9]+$/.test(message)) throw new Error('Telegram message cache requires numeric chat and message IDs')
  return `${chat}:${message}` }
function sanitizeCachedSender(sender) {
  if (!sender || typeof sender !== 'object' || Array.isArray(sender)) return undefined
  const value = { name: safeDisplayName(sender.name, sender.isBot ? 'bot' : 'user'),
    isBot: Boolean(sender.isBot), isSelf: Boolean(sender.isSelf) }
  if (sender.userId != null && /^-?[0-9]+$/.test(String(sender.userId))) value.userId = String(sender.userId)
  if (sender.username) value.username = safeDisplayName(sender.username)
  return value }
export function sanitizeCachedMessage(message = {}) {
  const sanitized = {}
  if (typeof message.rawText === 'string') sanitized.rawText = message.rawText.slice(0, 16_384)
  if (typeof message.text === 'string') sanitized.text = message.text.slice(0, 16_384)
  if (message.mediaKind != null) sanitized.mediaKind = safeMetadataValue(message.mediaKind, 'attachment', 64)
  const sender = sanitizeCachedSender(message.sender); if (sender) sanitized.sender = sender
  const timestamp = Number(message.sourceTimestamp); if (Number.isFinite(timestamp) && timestamp >= 0) sanitized.sourceTimestamp = Math.trunc(timestamp)
  return sanitized }
export function sourceLabel({ source, name, timestamp, sequence, eventId }) {
  const iso = new Date(timestamp).toISOString()
  return `[${safeDisplayName(source, 'Source')}/${safeDisplayName(name)} | ${iso} | #${sequence} | event=${safeDisplayName(eventId, 'unknown')}]`
}
// Splits text into messages of at most limit UTF-16 units, never inside a surrogate pair. newline mode
// prefers a paragraph, then a line, then a space in the second half of the window; length mode cuts at the limit.
export function chunkText(text, limit = MAX_TEXT, mode = 'newline') {
  const value = String(text)
  if (!value) return ['']
  const chunks = []
  let rest = value
  while (rest.length > limit) {
    let cut = -1
    if (mode === 'newline') {
      cut = rest.lastIndexOf('\n\n', limit)
      if (cut < Math.floor(limit / 2)) cut = rest.lastIndexOf('\n', limit)
      if (cut < Math.floor(limit / 2)) cut = rest.lastIndexOf(' ', limit)
    }
    if (cut < 1) cut = limit
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut += cut > 1 ? -1 : 1
    chunks.push(rest.slice(0, cut))
    rest = mode === 'newline' ? rest.slice(cut).replace(/^\s+/, '') : rest.slice(cut)
  }
  if (rest || !chunks.length) chunks.push(rest)
  // A part of only whitespace is one Telegram has nothing to show for; it goes, unless it is all there is.
  const shown = chunks.filter(chunk => /\S/.test(chunk))
  return shown.length ? shown : chunks.slice(0, 1)
}
export class StateStore {
  constructor(stateDir = defaultStateDir()) {
    this.dir = resolve(stateDir); this.accessPath = join(this.dir, 'access.json')
    this.runtimePath = join(this.dir, 'runtime.json'); this.configPath = join(this.dir, 'config.json')
    this.bindingPath = join(this.dir, 'binding.json')
    this.inboxDir = join(this.dir, 'inbox'); this.outboxDir = join(this.dir, 'outbox')
    ensurePrivateDir(this.dir); ensurePrivateDir(this.inboxDir); ensurePrivateDir(this.outboxDir)
  }
  loadAccess({ prune = true } = {}) {
    if (this.frozenAccess) return this.frozenAccess
    const access = normalizeAccess(readJson(this.accessPath, defaultAccess(), 'access state'))
    if (prune) for (const [code, pending] of Object.entries(access.pending))
      if (!pending || pending.expiresAt <= Date.now()) delete access.pending[code]
    return access
  }
  saveAccess(access) {
    if (this.frozenAccess) throw new Error('static access mode: the bridge reads access only at startup, so this change waits for a restart')
    atomicWriteJson(this.accessPath, access)
  }
  // Static access mode: every check reads the policy as it was at startup, and pairing, which writes at
  // runtime, is off. A change the owner saves on disk takes effect when the bridge next starts.
  freezeAccess() {
    if (this.frozenAccess) return
    const access = this.loadAccess()
    if (access.dmPolicy === 'pairing') access.dmPolicy = 'allowlist'
    access.pending = {}; this.frozenAccess = deepFreeze(access)
  }
  destination(chatId) { return destination(this.loadAccess(), chatId) }
  senderAdmitted(chatId, senderId) { return senderAdmitted(this.loadAccess(), chatId, senderId) }
  admitPrivate(from, chat) { return admitPrivate(this.loadAccess(), from, chat) }
  lockAccess() {
    const path = `${this.accessPath}.lock`
    const owner = `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce: randomBytes(8).toString('hex') })}\n`
    for (let attempt = 0; attempt < 200; attempt += 1) try {
      writeFileSync(path, owner, { flag: 'wx', mode: 0o600 })
      return () => { try { if (readFileSync(path, 'utf8') === owner) unlinkSync(path) } catch {} }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let live = false
      try { const current = JSON.parse(readFileSync(path, 'utf8')); process.kill(current.pid, 0)
        live = Number(current.createdAt) > Date.now() - 5 * 60 * 1000 } catch {}
      if (!live) try { unlinkSync(path) } catch {}
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    throw new Error('access state is busy; retry the local command')
  }
  loadRuntime() {
    const runtime = readJson(this.runtimePath, defaultRuntime(), 'runtime journal')
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) throw new Error('runtime journal is not an object; refusing to continue')
    if ((runtime.version ?? 1) > RUNTIME_VERSION) throw new Error(`runtime journal version ${runtime.version} is newer than this build reads (${RUNTIME_VERSION}); refusing to continue`)
    // The question journal carries its own version; a newer or damaged one is refused, never reset.
    if (runtime.questions !== undefined) questionsOf(runtime)
    runtime.events ||= {}; runtime.controls ||= {}; runtime.callbacks ||= {}; runtime.attachments ||= {}; runtime.messages ||= {}; if (!runtime.emptyThreads || typeof runtime.emptyThreads !== 'object' || Array.isArray(runtime.emptyThreads)) runtime.emptyThreads = {}
    runtime.sequence ||= 0; runtime.updateOffset ||= 0
    const now = Date.now()
    let changed = false
    for (const [token, callback] of Object.entries(runtime.callbacks)) {
      if (!callback || typeof callback !== 'object' || Array.isArray(callback) || Number(callback.expiresAt) <= now) {
        delete runtime.callbacks[token]; changed = true
      }
    }
    for (const [handle, attachment] of Object.entries(runtime.attachments)) {
      if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
        delete runtime.attachments[handle]; changed = true; continue
      }
      const storedCreatedAt = Number(attachment.createdAt)
      const createdAt = Number.isFinite(storedCreatedAt) ? storedCreatedAt : now
      const maximumExpiry = createdAt + ATTACHMENT_TTL_MS
      const storedExpiry = Number(attachment.expiresAt)
      const expiresAt = Number.isFinite(storedExpiry) ? Math.min(storedExpiry, maximumExpiry) : maximumExpiry
      if (expiresAt <= now) {
        delete runtime.attachments[handle]; changed = true; continue
      }
      if (attachment.createdAt !== createdAt || attachment.expiresAt !== expiresAt) {
        attachment.createdAt = createdAt; attachment.expiresAt = expiresAt; changed = true
      }
    }
    for (const [key, message] of Object.entries(runtime.messages)) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) { delete runtime.messages[key]; changed = true; continue }
      const storedCreatedAt = Number(message.createdAt); const createdAt = Number.isFinite(storedCreatedAt) ? storedCreatedAt : now
      const maximumExpiry = createdAt + MESSAGE_CACHE_TTL_MS
      const storedExpiry = Number(message.expiresAt); const expiresAt = Number.isFinite(storedExpiry) ? Math.min(storedExpiry, maximumExpiry) : maximumExpiry
      if (expiresAt <= now) { delete runtime.messages[key]; changed = true; continue }
      const sanitized = sanitizeCachedMessage(message)
      const normalized = { ...sanitized, createdAt, updatedAt: Number(message.updatedAt) || createdAt, expiresAt }
      if (JSON.stringify(message) !== JSON.stringify(normalized)) { runtime.messages[key] = normalized; changed = true }
    }
    if (changed) this.saveRuntime(runtime)
    return runtime
  }
  saveRuntime(runtime) {
    const byAge = entries => entries.sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))
    const events = Object.entries(runtime.events)
    const unresolved = events.filter(([, event]) => event.status !== 'delivered' && event.retryable !== false)
    const remaining = Math.max(0, 1024 - unresolved.length)
    const completed = remaining ? byAge(events.filter(([, event]) => event.status === 'delivered' || event.retryable === false)).slice(-remaining) : []
    runtime.events = Object.fromEntries([...unresolved, ...completed])
    const controls = Object.entries(runtime.controls || {})
    if (controls.length > 256) {
      const pendingControls = controls.filter(([, control]) => control.status !== 'completed' && control.retryable !== false)
      const completedControls = byAge(controls.filter(([, control]) => control.status === 'completed' || control.retryable === false))
        .slice(-Math.max(0, 256 - pendingControls.length))
      runtime.controls = Object.fromEntries([...pendingControls, ...completedControls])
    }
    const callbacks = Object.entries(runtime.callbacks || {})
    if (callbacks.length > 512) runtime.callbacks = Object.fromEntries(byAge(callbacks).slice(-512))
    const attachments = Object.entries(runtime.attachments)
    if (attachments.length > 512) runtime.attachments = Object.fromEntries(byAge(attachments).slice(-512))
    const messages = Object.entries(runtime.messages || {})
    if (messages.length > MAX_MESSAGE_CACHE_ENTRIES) runtime.messages = Object.fromEntries(messages
      .sort((a, b) => (a[1].updatedAt || a[1].createdAt || 0) - (b[1].updatedAt || b[1].createdAt || 0)).slice(-MAX_MESSAGE_CACHE_ENTRIES))
    const emptyThreads = Object.entries(runtime.emptyThreads || {}); if (emptyThreads.length > 64) runtime.emptyThreads = Object.fromEntries(emptyThreads.slice(-64))
    const reactions = Object.entries(runtime.acknowledgements || {})
    if (reactions.length > MAX_MESSAGE_CACHE_ENTRIES) {
      const pending = reactions.filter(([, entry]) => entry.pending)
      const complete = reactions.filter(([, entry]) => !entry.pending).sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      runtime.acknowledgements = Object.fromEntries([...pending, ...complete.slice(-Math.max(1, MAX_MESSAGE_CACHE_ENTRIES - pending.length))])
    }
    atomicWriteJson(this.runtimePath, runtime)
  }
  emptyThreads() { return structuredClone(this.loadRuntime().emptyThreads) }
  rememberEmptyThread(threadId, result) { const runtime = this.loadRuntime(); runtime.emptyThreads[threadId] = structuredClone(result); this.saveRuntime(runtime) }
  forgetEmptyThread(threadId) { const runtime = this.loadRuntime(); delete runtime.emptyThreads[threadId]; this.saveRuntime(runtime) }
  // The retry of a failed Telegram turn outlives a bridge restart, so an update during its wait resumes it.
  turnRetry() {
    const value = this.loadRuntime().turnRetry
    return value && typeof value === 'object' && !Array.isArray(value) && typeof value.threadId === 'string' ? structuredClone(value) : null
  }
  saveTurnRetry(value) {
    const runtime = this.loadRuntime()
    if (value) runtime.turnRetry = structuredClone(value); else delete runtime.turnRetry
    this.saveRuntime(runtime)
  }
  // The Telegram conversation the bridge routes to, with the terminal's app-server handshake, so a
  // restarted bridge can restore both without waiting for a terminal to attach.
  loadBinding() {
    const value = readJson(this.bindingPath, null)
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return null
    const threadId = typeof value.threadId === 'string' && value.threadId ? value.threadId : null
    const initialize = value.initialize && typeof value.initialize === 'object' && !Array.isArray(value.initialize) ? value.initialize : null
    return { threadId, initialize, ...(typeof value.workspace === 'string' ? { workspace: value.workspace } : {}),
      ...(value.permissions && typeof value.permissions === 'object' && !Array.isArray(value.permissions) ? { permissions: value.permissions } : {}) }
  }
  saveBinding(update) {
    const current = this.loadBinding() || { threadId: null, initialize: null }
    const content = { ...current, ...update }
    if (JSON.stringify(content) === JSON.stringify(current)) return
    const next = { version: 1, ...content, updatedAt: new Date().toISOString() }
    atomicWriteJson(this.bindingPath, next)
  }
  loadConfig() {
    return {
      replyToMode: 'first',
      inboxRetentionHours: 24,
      ...readJson(this.configPath, {}, 'channel config'),
    }
  }
  gatePrivateMessage(from, chat, locked = false) {
    if (!from || !chat || chat.type !== 'private') return { action: 'drop' }
    const senderId = String(from.id)
    const chatId = String(chat.id)
    const access = this.loadAccess()
    if (access.dmPolicy === 'disabled') return { action: 'drop' }
    const user = access.users[senderId]
    if (user && String(user.chatId) === chatId) return { action: 'deliver', user, senderId, chatId }
    if (access.dmPolicy !== 'pairing') return { action: 'drop' }
    if (!locked) {
      const release = this.lockAccess()
      try { return this.gatePrivateMessage(from, chat, true) } finally { release() }
    }
    for (const [code, pending] of Object.entries(access.pending)) {
      if (pending.senderId === senderId) {
        pending.replies = Number(pending.replies || 0) + 1
        this.saveAccess(access)
        return pending.replies <= 2 ? { action: 'pair', code, resend: true } : { action: 'drop' }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }
    const code = randomBytes(3).toString('hex')
    access.pending[code] = {
      senderId,
      chatId,
      displayName: safeDisplayName(from.username || from.first_name || senderId, senderId),
      createdAt: Date.now(),
      expiresAt: Date.now() + PAIRING_TTL_MS,
      replies: 1,
    }
    this.saveAccess(access)
    return { action: 'pair', code, resend: false }
  }
  // A paired private chat and its user; groups are refused here. See destination() for both.
  authorizedChat(chatId) {
    const route = this.destination(chatId)
    if (route.kind !== 'private') throw new Error('Telegram destination is not a paired private chat')
    return { userId: route.userId, ...route.user }
  }
  acceptEvent(eventId, details) {
    const runtime = this.loadRuntime()
    if (runtime.events[eventId]) return { duplicate: true, event: runtime.events[eventId] }
    const event = addEvent(runtime, eventId, details)
    this.saveRuntime(runtime)
    return { duplicate: false, event }
  }
  markEvent(eventId, status, extra = {}) {
    const runtime = this.loadRuntime()
    if (!runtime.events[eventId]) return
    Object.assign(runtime.events[eventId], extra, { status, updatedAt: Date.now() })
    this.saveRuntime(runtime)
  }
  acceptControl(controlId, details) {
    const runtime = this.loadRuntime()
    if (runtime.controls[controlId]) return { duplicate: true, control: runtime.controls[controlId] }
    runtime.sequence += 1
    runtime.controls[controlId] = {
      ...structuredClone(details),
      controlId,
      sequence: runtime.sequence,
      status: 'received',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.saveRuntime(runtime)
    return { duplicate: false, control: runtime.controls[controlId] }
  }
  control(controlId) {
    return this.loadRuntime().controls[controlId] || null
  }
  markControl(controlId, status, extra = {}) {
    const runtime = this.loadRuntime()
    if (!runtime.controls[controlId]) return
    Object.assign(runtime.controls[controlId], structuredClone(extra), { status, updatedAt: Date.now() })
    this.saveRuntime(runtime)
  }
  createCallbackGroup(details, choices, messageId = null) {
    const runtime = this.loadRuntime()
    const groupId = randomBytes(12).toString('hex')
    const createdAt = Date.now()
    const expiresAt = createdAt + CALLBACK_TTL_MS
    const capabilities = choices.map(choice => {
      const token = randomBytes(12).toString('hex')
      runtime.callbacks[token] = {
        ...structuredClone(details),
        ...structuredClone(choice),
        token,
        groupId,
        messageId: messageId == null ? null : String(messageId),
        createdAt,
        expiresAt,
      }
      return { ...choice, token, callbackData: `gct:${token}` }
    })
    this.saveRuntime(runtime)
    return { groupId, capabilities }
  }
  bindCallbackGroup(groupId, messageId) {
    const runtime = this.loadRuntime()
    let found = false
    for (const callback of Object.values(runtime.callbacks)) if (callback.groupId === groupId && !callback.consumedAt) {
      callback.messageId = String(messageId); found = true
    }
    if (!found) throw new Error('Telegram picker expired before it could be bound')
    this.saveRuntime(runtime)
  }
  consumeCallback(token, { chatId, userId, messageId }) {
    const runtime = this.loadRuntime()
    const callback = runtime.callbacks[token]
    if (!callback || callback.expiresAt <= Date.now()) throw new Error('Telegram picker expired')
    if (callback.consumedAt) throw new Error('Telegram picker was already used')
    if (String(callback.chatId) !== String(chatId) || String(callback.userId) !== String(userId) ||
        String(callback.messageId) !== String(messageId)) throw new Error('Telegram picker does not belong to this chat')
    const consumedAt = Date.now()
    for (const sibling of Object.values(runtime.callbacks)) if (sibling.groupId === callback.groupId) {
      sibling.consumedAt = consumedAt
      sibling.consumedToken = token
    }
    this.saveRuntime(runtime)
    return structuredClone(callback)
  }
  rememberAttachment(handle, meta) {
    const runtime = this.loadRuntime()
    const now = Date.now()
    const existing = runtime.attachments[handle]
    const sanitized = sanitizeAttachmentMeta(meta)
    const suppliedCreatedAt = Number(sanitized.createdAt)
    const existingCreatedAt = Number(existing?.createdAt)
    const createdAt = Number.isFinite(existingCreatedAt)
      ? existingCreatedAt
      : Number.isFinite(suppliedCreatedAt) ? suppliedCreatedAt : now
    const maximumExpiry = createdAt + ATTACHMENT_TTL_MS
    const suppliedExpiry = Number(existing?.expiresAt ?? sanitized.expiresAt)
    const expiresAt = Number.isFinite(suppliedExpiry) ? Math.min(suppliedExpiry, maximumExpiry) : maximumExpiry
    if (expiresAt <= now) throw new Error('Telegram attachment authorization has expired')
    Object.assign(meta, sanitized)
    runtime.attachments[handle] = { ...existing, ...sanitized, createdAt, expiresAt }
    this.saveRuntime(runtime)
  }
  attachment(handle) {
    const value = this.loadRuntime().attachments[handle]
    if (!value) throw new Error('Unknown or expired Telegram attachment')
    return value
  }
  rememberMessage(chatId, messageId, message) {
    const runtime = this.loadRuntime(); const key = messageCacheKey(chatId, messageId); const now = Date.now()
    const existing = runtime.messages[key]; const createdAt = Number(existing?.createdAt) || now
    runtime.messages[key] = { ...existing, ...sanitizeCachedMessage(message), createdAt, updatedAt: now,
      expiresAt: Math.min(Number(existing?.expiresAt) || createdAt + MESSAGE_CACHE_TTL_MS, createdAt + MESSAGE_CACHE_TTL_MS),
    }
    this.saveRuntime(runtime)
    return structuredClone(runtime.messages[key])
  }
  message(chatId, messageId) { const value = this.loadRuntime().messages[messageCacheKey(chatId, messageId)]
    return value ? structuredClone(value) : null }
  updateOffset(offset) {
    const runtime = this.loadRuntime()
    runtime.updateOffset = Math.max(runtime.updateOffset || 0, offset)
    this.saveRuntime(runtime)
  }
  nextTerminalEvent(name, timestampOrOptions = Date.now(), clientUserMessageId) {
    const options = timestampOrOptions && typeof timestampOrOptions === 'object'
      ? timestampOrOptions
      : { timestamp: timestampOrOptions, clientUserMessageId }
    const timestamp = options.timestamp ?? Date.now()
    const clientId = options.clientUserMessageId == null ? null : String(options.clientUserMessageId)
    const requestKey = clientId || (options.requestId == null ? null
      : JSON.stringify([options.sessionId || null, typeof options.requestId, String(options.requestId), options.params?.threadId || null, options.params?.input || []]))
    const id = requestKey == null
      ? `terminal-${randomBytes(8).toString('hex')}`
      : `terminal-${createHash('sha256').update(requestKey).digest('hex').slice(0, 32)}`
    const accepted = this.acceptEvent(id, sequence => {
      const details = { source: 'Terminal', name, sourceTimestamp: timestamp,
        ...(!requestKey ? {} : { clientUserMessageId: clientId || id }) }
      if (!options.params) return details
      const params = structuredClone(options.params)
      params.clientUserMessageId ||= clientId || id
      params.input = Array.isArray(params.input) ? params.input : []
      const label = sourceLabel({ source: 'Terminal', name, timestamp, sequence, eventId: id })
      const textItem = params.input.find(item => item.type === 'text')
      if (textItem) textItem.text = `${label}\n${textItem.text}`
      else params.input.unshift({ type: 'text', text: label })
      return { ...details, payload: { prepared: true, source: 'Terminal', eventId: id,
        clientId: params.clientUserMessageId, method: options.method, params, input: params.input } }
    })
    return { ...accepted.event, duplicate: accepted.duplicate }
  }
  resolveOutboundFile(path, workspaceRoot, maxBytes = MAX_SEND_BYTES) {
    const roots = [workspaceRoot, this.inboxDir, this.outboxDir].map(root => realpathSync(resolve(root)))
    const allowed = candidate => roots.some(root => privatePathContains(root, candidate))
    const requested = realpathSync(resolve(path)); if (!allowed(requested)) throw new Error(`file is outside allowed roots: ${path}`)
    let descriptor
    try {
      descriptor = openSync(requested, constants.O_RDONLY | constants.O_NOFOLLOW)
      const candidate = process.platform === 'linux' ? realpathSync(`/proc/self/fd/${descriptor}`) : descriptorPath(descriptor, requested)
      if (!allowed(candidate)) throw new Error(`file is outside allowed roots: ${path}`)
      if (privatePathContains(realpathSync(this.dir), candidate) && ![this.inboxDir, this.outboxDir]
        .some(root => privatePathContains(realpathSync(root), candidate))) throw new Error(`refusing to send plugin state: ${path}`)
      const info = fstatSync(descriptor); if (!info.isFile()) throw new Error(`not a regular file: ${path}`)
      if (info.nlink !== 1) throw new Error(`refusing to send hard-linked file: ${path}`)
      if (info.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${path}`)
      const bytes = readFileSync(descriptor); if (bytes.length > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${path}`)
      return { path: candidate, size: bytes.length, name: safeFilename(candidate), bytes }
    } finally { if (descriptor !== undefined) closeSync(descriptor) }
  }
  removeSocket(path) {
    if (!existsSync(path)) return
    const info = lstatSync(path)
    if (!info.isSocket()) throw new Error(`refusing to replace non-socket path: ${path}`)
    unlinkSync(path)
  }
}
