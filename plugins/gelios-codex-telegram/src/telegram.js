import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { MAX_DOWNLOAD_BYTES, MAX_INBOX_BYTES, MAX_SEND_BYTES, chunkText, processInfo, safeDisplayName, safeFilename, safeMetadataValue } from './core.js'
import { formatTelegramMarkdown } from './telegram-format.js'
import { TRANSCRIPT_PREFIX } from './transcription.js'
import { ReactionQueue } from './reactions.js'
import { BurstBatcher } from './batching.js'
const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const MAX_PHOTO_SEND_BYTES = 10 * 1024 * 1024
class TelegramError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'TelegramError'
    this.code = code
  }
}
function permanentError(message) {
  const error = new Error(message)
  error.permanent = true
  return error
}
function formParams(params) {
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  return form
}
function messageMediaKind(message = {}) { return ['photo', 'document', 'voice', 'audio', 'video', 'video_note', 'sticker', 'animation', 'contact', 'location', 'venue', 'poll', 'dice']
  .find(kind => message[kind] != null) }
function messageBody(message = {}) {
  if (typeof message.text === 'string') return message.text
  if (typeof message.caption === 'string') return message.caption
  const kind = messageMediaKind(message); if (!kind) return undefined
  if (kind === 'document' && message.document?.file_name) return `(document: ${safeFilename(message.document.file_name)})`
  return `(${kind.replace('_', ' ')})` }
function messageSender(message = {}, { external = false } = {}) {
  const from = message.from; if (!from || typeof from !== 'object') return undefined
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id || '')
  return { ...(from.id == null ? {} : { userId: String(from.id) }),
    name: safeDisplayName(name, from.is_bot ? 'bot' : 'user'),
    ...(from.username ? { username: safeDisplayName(from.username) } : {}),
    isBot: Boolean(from.is_bot), isSelf: Boolean(from.is_bot) && !external } }
function quoteEntities(entities) {
  if (!Array.isArray(entities)) return []
  return entities.slice(0, 100).flatMap(entity => {
    const offset = Number(entity?.offset); const length = Number(entity?.length)
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) return []
    const normalized = { type: safeMetadataValue(entity.type, 'unknown', 64), offset, length }
    if (entity.language) normalized.language = safeMetadataValue(entity.language, 'unknown', 64)
    if (entity.custom_emoji_id) normalized.customEmojiId = safeMetadataValue(entity.custom_emoji_id)
    return [normalized] })
}
const procStartTime = pid => processInfo(pid)?.identity || null
// Resolves after ms, or as soon as any of the given signals aborts.
const sleep = (ms, ...signals) => new Promise(resolve => { const live = signals.filter(Boolean)
  const done = () => { clearTimeout(timer); for (const signal of live) signal.removeEventListener('abort', done); resolve() }
  const timer = setTimeout(done, ms); for (const signal of live) signal.addEventListener('abort', done, { once: true })
  if (live.some(signal => signal.aborted)) done() })
export class TelegramApi {
  constructor(token, { hold = null, onHold = () => {} } = {}) {
    this.token = token
    const apiRoot = (process.env.GELIOS_TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '')
    this.base = `${apiRoot}/bot${token}`
    this.fileBase = `${(process.env.GELIOS_TELEGRAM_FILE_BASE || apiRoot).replace(/\/$/, '')}/file/bot${token}`
    // A 429 holds every call until its retry_after has passed. A saved hold is capped at its own length, so a clock step cannot stretch it.
    this.now = () => Date.now(); this.onHold = onHold; this.stopped = new AbortController()
    this.holdUntil = Math.min(Number(hold?.until) || 0, this.now() + (Number(hold?.ms) || 0))
  }
  holdMs() { return Math.max(0, this.holdUntil - this.now()) }
  hold(method, seconds) {
    const ms = Math.ceil(Number(seconds) * 1000); if (!(ms > 0)) return undefined
    const until = this.now() + ms; if (until > this.holdUntil) { this.holdUntil = until; this.onHold(method, ms, until) }
    return ms
  }
  // Waits out a hold; a best-effort call is skipped instead, and close() ends every wait.
  async waitForHold({ signal, skipWhileHeld = false } = {}) {
    for (let wait = this.holdMs(); wait > 0; wait = this.holdMs()) {
      if (skipWhileHeld) throw new TelegramError(`Telegram rate limit holds calls for ${Math.ceil(wait / 1000)}s more`, 429)
      signal?.throwIfAborted(); if (this.stopped.signal.aborted) throw new Error('Telegram channel stopped')
      await sleep(wait, signal, this.stopped.signal)
    }
  }
  close() { this.stopped.abort() }
  async request(url, options, { signal, timeoutMs = 30_000, skipWhileHeld, beforeSend } = {}) {
    await this.waitForHold({ signal, skipWhileHeld })
    beforeSend?.()
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('Telegram request timed out')), timeoutMs)
    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  async result(method, response) {
    const data = await response.json().catch(() => null)
    if (response.ok && data?.ok) return data.result
    const error = new TelegramError(data?.description || `Telegram ${method} failed with HTTP ${response.status}`, data?.error_code || response.status)
    if (error.code === 429) error.retryAfterMs = this.hold(method, data?.parameters?.retry_after ?? response.headers?.get('retry-after') ?? /retry after (\d+)/i.exec(data?.description)?.[1])
    throw error
  }
  async call(method, params = {}, options = {}) {
    return this.result(method, await this.request(`${this.base}/${method}`, { method: 'POST', body: formParams(params) }, options))
  }
  async multipart(method, fields, fieldName, file, { signal } = {}) {
    const data = new FormData()
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue
      data.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
    data.set(fieldName, new Blob([file.bytes]), file.name)
    return this.result(method, await this.request(`${this.base}/${method}`, { method: 'POST', body: data }, { signal, timeoutMs: 55_000 }))
  }
  async download(fileId, maxBytes = MAX_DOWNLOAD_BYTES, { signal } = {}) {
    const file = await this.call('getFile', { file_id: fileId }, { signal })
    if (!file?.file_path) throw new Error('Telegram returned no file path')
    const response = await this.request(`${this.fileBase}/${file.file_path}`, {}, { signal, timeoutMs: 55_000 })
    if (response.status === 429) this.hold('file download', response.headers.get('retry-after'))
    if (!response.ok) throw new Error(`Telegram attachment download failed with HTTP ${response.status}`)
    const advertised = Number(response.headers.get('content-length') || 0)
    if (advertised > maxBytes) throw permanentError(`Telegram attachment exceeds ${maxBytes} bytes`)
    const chunks = []
    let size = 0
    for await (const chunk of response.body || []) {
      size += chunk.byteLength
      if (size > maxBytes) throw permanentError(`Telegram attachment exceeds ${maxBytes} bytes`)
      chunks.push(Buffer.from(chunk))
    }
    const bytes = Buffer.concat(chunks, size)
    return { bytes, file }
  }
}
const POLL_DEADLINE_MS = 35_000, UPDATE_ATTEMPTS = 8, CONFLICT_LIMIT = 8
const formatDuration = ms => { const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` }
export class TelegramChannel {
  constructor({ store, token, workspaceRoot, onInbound, onControl = async () => null, onStatus = () => ({}), transcriber = null, log = console.error }) {
    this.store = store; this.workspaceRoot = workspaceRoot
    this.api = new TelegramApi(token, { hold: store.loadRuntime().telegramHold, onHold: (method, ms, until) => {
      const runtime = store.loadRuntime(); runtime.telegramHold = { until, ms }; store.saveRuntime(runtime)
      this.log(`telegram: ${method} was rate limited (429); holding every Telegram call for ${formatDuration(ms)}, until ${new Date(until).toISOString()}`) } })
    this.onInbound = onInbound; this.onControl = onControl; this.transcriber = transcriber
    this.onStatus = onStatus; this.log = log; this.stopping = false
    this.abortController = null; this.pollPromise = null; this.retentionTimer = null
    this.typing = new Map(); this.typingIntervalMs = 4000
    this.retryDelay = attempt => Math.min(attempt * 1000, 15_000)
    this.now = () => Date.now()
    this.lockPath = join(store.dir, 'poller.lock'); this.lockIdentity = null
    this.reactions = new ReactionQueue({ store, authorize: chat => store.authorizedChat(chat),
      send: (chatId, messageId, emoji) => this.api.call('setMessageReaction', {
        chat_id: chatId, message_id: Number(messageId), reaction: emoji ? [{ type: 'emoji', emoji }] : [],
      }, { beforeSend: () => store.authorizedChat(chatId) }), log: message => this.log(message) })
    this.batcher = new BurstBatcher({ publish: events => this.publishBatch(events) })
  }
  errorText(error) { const text = String(error?.message || error); return this.api.token ? text.split(this.api.token).join('[redacted]') : text }
  startTyping(chatId) {
    const key = String(chatId); if (this.typing.has(key)) return
    const pulse = () => { try { this.store.authorizedChat(key) } catch { clearInterval(this.typing.get(key)); this.typing.delete(key); return }
      this.api.call('sendChatAction', { chat_id: key, action: 'typing' }, { skipWhileHeld: true }).catch(() => {}) }
    const timer = setInterval(pulse, this.typingIntervalMs); timer.unref(); this.typing.set(key, timer) }
  stopTyping(chatId) {
    if (chatId !== undefined) { const key = String(chatId); clearInterval(this.typing.get(key)); this.typing.delete(key); return }
    for (const timer of this.typing.values()) clearInterval(timer); this.typing.clear() }
  acquireLock() {
    const identity = { pid: process.pid, startTime: procStartTime(process.pid), createdAt: Date.now() }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeFileSync(this.lockPath, `${JSON.stringify(identity)}\n`, { flag: 'wx', mode: 0o600 })
        this.lockIdentity = identity
        return
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        let existing
        try { existing = JSON.parse(readFileSync(this.lockPath, 'utf8')) } catch { existing = null }
        const live = existing?.pid > 1 && procStartTime(existing.pid) && procStartTime(existing.pid) === existing.startTime
        if (live) throw new Error(`Telegram poller is already running as pid ${existing.pid}`)
        try { unlinkSync(this.lockPath) } catch {}
      }
    }
    throw new Error('could not acquire Telegram poller lock')
  }
  releaseLock() {
    try { const current = JSON.parse(readFileSync(this.lockPath, 'utf8'))
      if (current.pid === process.pid && current.startTime === this.lockIdentity?.startTime) unlinkSync(this.lockPath) } catch {}
  }
  start({ lockHeld = false } = {}) {
    if (!lockHeld) this.acquireLock()
    this.cleanupInbox(); this.retentionTimer = setInterval(() => this.cleanupInbox(), 60 * 60 * 1000); this.retentionTimer.unref()
    this.reactions.start()
    for (const event of Object.values(this.store.loadRuntime().events).sort((a, b) => a.sequence - b.sequence)) {
      if (event.status === 'staged' && event.payload) this.batcher.add(event.payload)
    }
    void this.batcher.flush().catch(error => this.log(`restored batch retained: ${this.errorText(error)}`))
    this.pollPromise = this.poll()
    return this.pollPromise
  }
  async stop({ releaseLock = true } = {}) {
    this.batcher.stop()
    this.reactions.stop()
    this.stopping = true; this.api.close(); this.abortController?.abort(); clearInterval(this.retentionTimer); this.stopTyping()
    await this.pollPromise?.catch(() => {}); if (releaseLock) this.releaseLock()
  }
  async poll() {
    // Consecutive failed getUpdates calls form one numbered streak that any successful call ends; delivery retries count per update.
    let pollFailures = 0, conflicts = 0, streakStartedAt = 0, failingUpdate = null, updateFailures = 0
    try {
      await this.api.call('setMyCommands', {
        commands: [
          { command: 'start', description: 'Pair with the active Gelios session' },
          { command: 'help', description: 'Show channel help' },
          { command: 'status', description: 'Show pairing status' },
          { command: 'new', description: 'Start a fresh Codex chat (admin)' },
          { command: 'model', description: 'Choose the Codex model (admin)' },
          { command: 'reasoning', description: 'Choose reasoning effort (admin)' },
        ],
        scope: { type: 'all_private_chats' },
      }).catch(error => this.log(`telegram: could not set commands: ${this.errorText(error)}`))
      while (!this.stopping) {
        const offset = this.store.loadRuntime().updateOffset || 0
        this.abortController = new AbortController(); let timer
        try {
          // A hold is waited out before the poll deadline starts, so a long retry_after never reads as a hung poll.
          await this.api.waitForHold({ signal: this.abortController.signal })
          timer = setTimeout(() => this.abortController.abort(), POLL_DEADLINE_MS)
          const updates = await this.api.call('getUpdates', {
            offset,
            timeout: 25,
            allowed_updates: ['message', 'edited_message', 'callback_query'],
          }, { signal: this.abortController.signal, timeoutMs: POLL_DEADLINE_MS })
          clearTimeout(timer)
          if (pollFailures) this.log(`telegram: polling recovered after ${pollFailures} consecutive failure${pollFailures === 1 ? '' : 's'} over ${formatDuration(this.now() - streakStartedAt)} (first at ${new Date(streakStartedAt).toISOString()})`)
          pollFailures = 0; conflicts = 0
          for (const update of updates) {
            try {
              await this.handleUpdate(update)
              this.store.updateOffset(update.update_id + 1)
              failingUpdate = null; updateFailures = 0
            } catch (error) {
              if (error.retryWithoutAdvancing) {
                this.log(`telegram: update ${update.update_id} paused at a bridge boundary`)
                await sleep(this.retryDelay(1), this.api.stopped.signal)
                break
              }
              if (failingUpdate !== update.update_id) { failingUpdate = update.update_id; updateFailures = 0 }
              updateFailures += 1
              this.log(`telegram: update ${update.update_id} failed (attempt ${updateFailures} of ${UPDATE_ATTEMPTS}): ${this.errorText(error)}`)
              if (error.permanent || updateFailures >= UPDATE_ATTEMPTS) {
                this.store.updateOffset(update.update_id + 1)
                failingUpdate = null; updateFailures = 0
                continue
              }
              await sleep(this.retryDelay(updateFailures), this.api.stopped.signal)
              break
            }
          }
        } catch (error) {
          clearTimeout(timer)
          if (this.stopping) continue
          // Only stop() and the poll deadline abort this controller, and stop() sets stopping first.
          const reason = error?.name === 'AbortError' ? `getUpdates did not answer within ${POLL_DEADLINE_MS / 1000}s` : this.errorText(error)
          if (!pollFailures) streakStartedAt = this.now()
          pollFailures += 1
          conflicts = error instanceof TelegramError && error.code === 409 ? conflicts + 1 : 0
          if (conflicts >= CONFLICT_LIMIT) {
            throw new Error('Telegram 409 Conflict persists; another process is polling this bot token')
          }
          const delay = Math.max(this.retryDelay(pollFailures), Math.ceil(this.api.holdMs() / 1000) * 1000)
          this.log(`telegram: polling error (${reason}); consecutive failure ${pollFailures}, retrying in ${delay / 1000}s`)
          await sleep(delay, this.api.stopped.signal)
        }
      }
    } finally {
      clearInterval(this.retentionTimer)
      this.releaseLock()
    }
  }
  async handleUpdate(update) {
    if (update.callback_query) { await this.batcher.flush(); return this.handleCallback(update.callback_query) }
    const message = update.edited_message || update.message
    if (!message) return
    const edited = Boolean(update.edited_message)
    if (message.chat?.type !== 'private') return
    const text = message.text || message.caption || ''
    let gate
    if (edited) {
      let authorized
      try { authorized = this.store.authorizedChat(String(message.chat.id)) } catch { return }
      if (String(authorized.userId) !== String(message.from?.id)) return
      if (!message.text && message.caption == null) return
      const previous = this.store.message(String(message.chat.id), String(message.message_id))
      if ((previous?.rawText ?? previous?.text) === text) return
      gate = { action: 'deliver', user: authorized, senderId: String(message.from.id), chatId: String(message.chat.id) }
      await this.batcher.flush()
    } else gate = this.store.gatePrivateMessage(message.from, message.chat)
    if (!edited && text.startsWith('/')) {
      await this.batcher.flush()
      if (gate.action === 'drop') return
      const handled = await this.handleCommand(message, text.split(/\s/, 1)[0].split('@', 1)[0], gate)
      if (handled) return
    }
    if (gate.action === 'drop') return
    if (gate.action === 'pair') {
      await this.sendMessage(gate.chatId || String(message.chat.id),
        `${gate.resend ? 'Still pending' : 'Pairing required'} — invoke in the local Codex terminal:\n\n$telegram:access pair ${gate.code}`)
      return
    }
    const messageId = String(message.message_id)
    const eventId = edited ? `telegram-edit-${gate.chatId}-${messageId}-${update.update_id ?? message.edit_date}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}` : `telegram-${gate.chatId}-${messageId}`
    if (this.store.loadRuntime().events[eventId]?.status === 'delivered') {
      return
    }
    const baseEvent = {
      source: 'Telegram',
      eventId,
      chatId: gate.chatId,
      messageId,
      userId: gate.senderId,
      name: gate.user.alias,
      role: gate.user.role,
      timestamp: ((edited ? message.edit_date : message.date) || Math.floor(Date.now() / 1000)) * 1000,
      ...(edited ? { edited: true } : {}),
      text: text || '(Telegram attachment)',
      rawMessage: message,
    }
    const accepted = this.store.acceptEvent(eventId, { source: 'Telegram', chatId: gate.chatId, messageId,
      sourceTimestamp: baseEvent.timestamp, payload: baseEvent })
    if (accepted.duplicate && accepted.event.status !== 'staged') {
      const prior = accepted.event.parentEventId ? this.store.loadRuntime().events[accepted.event.parentEventId] : accepted.event
      if (prior?.payload && prior.retryable !== false) return this.onInbound(prior.payload, () => this.preparePersisted(prior.payload))
      return
    }
    this.store.markEvent(eventId, 'staged', { payload: baseEvent })
    await this.batcher.add(baseEvent)
  }
  publishBatch(events) {
    if (!events.length) return Promise.resolve()
    const runtime = this.store.loadRuntime()
    const eventId = events.length === 1 ? events[0].eventId : `telegram-batch-${createHash('sha256').update(events.map(item => item.eventId).join('\n')).digest('hex').slice(0, 24)}`
    const event = { ...events.at(-1), eventId, journaledOnly: true, ...(events.length > 1 ? { members: events } : {}) }
    if (!runtime.events[eventId]) runtime.events[eventId] = { source: 'Telegram', eventId, sequence: ++runtime.sequence, createdAt: Date.now() }
    Object.assign(runtime.events[eventId], { status: 'received', updatedAt: Date.now(), payload: event })
    for (const member of events) if (member.eventId !== eventId) Object.assign(runtime.events[member.eventId], { status: 'batched', parentEventId: eventId, payload: null })
    this.store.saveRuntime(runtime)
    return Promise.resolve(this.onInbound(event, () => this.preparePersisted(event)))
      .catch(error => { this.log(`batch delivery retained event=${eventId}: ${this.errorText(error)}`); throw error })
  }
  async preparePersisted(event) {
    if (event.members) {
      const members = []
      for (const member of event.members) members.push(await this.preparePersisted(member))
      let text = ''
      for (let i = 0; i < members.length; i += 1) text += `${i ? (members[i - 1].text.length >= 4000 ? '' : '\n') : ''}${members[i].text}`
      return { ...event, rawMessage: undefined, members: members.map(({ rawMessage, ...member }) => member), text,
        replyContext: members.find(member => member.replyContext)?.replyContext,
        localImages: members.map(member => member.localImage).filter(Boolean),
        attachments: members.map(member => member.attachment).filter(Boolean) }
    }
    let authorized
    try { authorized = this.store.authorizedChat(event.chatId) } catch (error) {
      if (/not paired|disabled/i.test(error.message)) error.permanent = true
      throw error
    }
    if (String(authorized.userId) !== String(event.userId)) throw permanentError('Telegram sender authorization changed')
    await this.api.call('sendChatAction', { chat_id: event.chatId, action: 'typing' }, { skipWhileHeld: true }).catch(() => {})
    const gate = { chatId: event.chatId, senderId: event.userId }
    const extracted = await this.extractMessage(event.rawMessage, event.eventId, gate)
    const replyContext = this.replyContext(event.rawMessage, event.chatId)
    this.rememberInboundMessage(event.rawMessage, event.chatId, extracted.text)
    this.startTyping(event.chatId)
    return { ...event, rawMessage: undefined, ...extracted, ...(replyContext ? { replyContext } : {}) }
  }
  rememberInboundMessage(message, chatId, extractedText) {
    if (message?.message_id == null) return
    this.store.rememberMessage(chatId, message.message_id, { rawText: message.text || message.caption || '', text: typeof extractedText === 'string' ? extractedText : messageBody(message),
      mediaKind: messageMediaKind(message), sender: messageSender(message), sourceTimestamp: Number(message.date) * 1000 })
  }
  replyContext(message, chatId) {
    const parent = message?.reply_to_message; if (!parent || parent.message_id == null) return undefined
    const parentId = String(parent.message_id)
    const cached = this.store.message(chatId, parentId); const nativeText = messageBody(parent)
    const nativeMediaKind = messageMediaKind(parent); const sender = messageSender(parent)
    this.store.rememberMessage(chatId, parentId, {
      ...(nativeText === undefined ? {} : { text: nativeText }),
      ...(nativeMediaKind ? { mediaKind: nativeMediaKind } : {}),
      ...(sender ? { sender } : {}),
      sourceTimestamp: Number(parent.date) * 1000,
    })
    const hasQuote = message.quote && typeof message.quote === 'object' && !Array.isArray(message.quote)
    const context = {
      schema: 'telegram_reply_context_v1',
      mode: hasQuote ? 'selected_quote' : 'parent_message',
      parentMessageId: parentId,
      ...(sender || cached?.sender ? { parentSender: sender || cached.sender } : {}),
      ...(Number.isFinite(Number(parent.date)) ? { parentTimestamp: Number(parent.date) * 1000 }
        : cached?.sourceTimestamp != null ? { parentTimestamp: cached.sourceTimestamp } : {}),
      ...(nativeMediaKind || cached?.mediaKind ? { media: { kind: nativeMediaKind || cached.mediaKind } } : {}),
    }
    if (hasQuote) {
      context.text = typeof message.quote.text === 'string' ? message.quote.text : ''
      context.quote = { ...(Number.isInteger(message.quote.position) && message.quote.position >= 0 ? { position: message.quote.position } : {}),
        isManual: Boolean(message.quote.is_manual), entities: quoteEntities(message.quote.entities) }
      return context
    }
    context.text = nativeText === undefined ? cached?.text ?? '' : nativeText
    if (nativeText === undefined && cached?.text !== undefined) context.recoveredFromCache = true
    return context
  }
  async handleCommand(message, command, gate) {
    const chatId = String(message.chat.id)
    if (command === '/start' || command === '/help') {
      if (gate.action === 'pair') {
        await this.sendMessage(chatId, `${gate.resend ? 'Still pending' : 'Pairing required'} — invoke in the local Codex terminal:\n\n$telegram:access pair ${gate.code}`)
      } else {
        await this.sendMessage(chatId,
          `Paired as ${gate.user.alias} (${gate.user.role}).\n\n` +
          'Messages steer the active Gelios Codex session. Codex replies only when it explicitly chooses the Telegram tool.\n' +
          '/status — show pairing state' + (gate.user.role === 'admin'
            ? '\n/new — start a fresh chat\n/model — choose the model\n/reasoning — choose reasoning effort'
            : ''))
      }
      return true
    }
    if (command === '/status' && gate.action === 'deliver') {
      const health = await this.onStatus()
      const settings = health.model ? `; model=${health.model}; reasoning=${health.effort || 'default'}` : ''
      await this.sendMessage(chatId, `Paired as ${gate.user.alias} (${gate.user.role}). Bridge: ${health.ready ? 'ready' : 'starting'}; thread=${health.threadId || 'none'}; turn=${health.turnId || 'idle'}${settings}.`)
      return true
    }
    if (command === '/status') {
      await this.sendMessage(chatId, `Pairing pending. Invoke in the local Codex terminal:\n\n$telegram:access pair ${gate.code}`)
      return true
    }
    if (!['/new', '/model', '/reasoning'].includes(command)) return false
    if (gate.action !== 'deliver') {
      await this.sendMessage(chatId, `Pairing pending. Invoke in the local Codex terminal:\n\n$telegram:access pair ${gate.code}`)
      return true
    }
    if (gate.user.role !== 'admin') {
      await this.sendMessage(chatId, 'This command is restricted to paired administrators.')
      return true
    }
    const result = await this.onControl({
      controlId: `telegram-command-${chatId}-${message.message_id}`,
      action: command.slice(1),
      chatId,
      userId: gate.senderId,
      messageId: String(message.message_id),
    })
    await this.presentControlResult(result, {
      chatId,
      userId: gate.senderId,
      messageId: String(message.message_id),
      edit: false,
    })
    return true
  }
  pickerKeyboard(capabilities, columns) {
    const rows = []
    for (let index = 0; index < capabilities.length; index += columns) {
      rows.push(capabilities.slice(index, index + columns).map(capability => ({
        text: capability.label,
        callback_data: capability.callbackData,
      })))
    }
    return { inline_keyboard: rows }
  }
  async presentControlResult(result, context) {
    if (!result || typeof result !== 'object') throw new Error('Telegram control returned no result')
    if (result.type === 'message') {
      const formatting = Array.isArray(result.entities) && result.entities.length
        ? { entities: result.entities }
        : {}
      if (context.edit) {
        await this.api.call('editMessageText', {
          chat_id: context.chatId,
          message_id: Number(context.messageId),
          text: result.text,
          ...formatting,
          reply_markup: { inline_keyboard: [] },
        })
      } else {
        await this.sendMessage(context.chatId, result.text, {
          ...formatting,
          reply_parameters: { message_id: Number(context.messageId) },
        })
      }
      return
    }
    if (!['modelPicker', 'reasoningPicker'].includes(result.type)) throw new Error('Telegram control returned an unknown result')
    const action = result.type === 'modelPicker' ? 'selectModel' : 'selectEffort'
    const choices = result.choices.map(choice => ({ value: choice.value, label: choice.label }))
    const group = this.store.createCallbackGroup({
      chatId: context.chatId,
      userId: context.userId,
      threadId: result.threadId,
      action,
      ...(result.model ? { model: result.model } : {}),
    }, choices, context.edit ? context.messageId : null)
    const replyMarkup = this.pickerKeyboard(group.capabilities, result.type === 'modelPicker' ? 1 : 2)
    if (context.edit) {
      await this.api.call('editMessageText', {
        chat_id: context.chatId,
        message_id: Number(context.messageId),
        text: result.text,
        reply_markup: replyMarkup,
      })
      return
    }
    const sent = await this.sendMessage(context.chatId, result.text, {
      reply_parameters: { message_id: Number(context.messageId) },
      reply_markup: replyMarkup,
    })
    this.store.bindCallbackGroup(group.groupId, sent[0].message_id)
  }
  async handleCallback(query) {
    const chatId = String(query.message?.chat?.id || '')
    const messageId = String(query.message?.message_id || '')
    const userId = String(query.from?.id || '')
    if (query.message?.chat?.type !== 'private' || !query.data?.startsWith('gct:')) return
    let capability
    try {
      const authorized = this.store.authorizedChat(chatId)
      if (String(authorized.userId) !== userId || authorized.role !== 'admin') throw new Error('This picker is restricted to paired administrators')
      capability = this.store.consumeCallback(query.data.slice(4), { chatId, userId, messageId })
    } catch (error) {
      await this.api.call('answerCallbackQuery', {
        callback_query_id: query.id,
        text: error.message,
        show_alert: false,
      }).catch(() => {})
      return
    }
    await this.api.call('answerCallbackQuery', {
      callback_query_id: query.id,
      text: capability.action === 'selectModel' ? 'Loading reasoning levels…' : 'Applying setting…',
    }).catch(() => {})
    try {
      const result = await this.onControl({
        controlId: `telegram-callback-${query.id}`,
        action: capability.action,
        chatId,
        userId,
        messageId,
        threadId: capability.threadId,
        value: capability.value,
        model: capability.model,
      })
      await this.presentControlResult(result, { chatId, userId, messageId, edit: true })
    } catch (error) {
      await this.api.call('editMessageText', {
        chat_id: chatId,
        message_id: Number(messageId),
        text: `Control failed: ${this.errorText(error)}\n\nRun the command again to retry.`,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {})
    }
  }
  async extractMessage(message, eventId, gate) {
    const caption = message.caption
    const variants = [
      ['photo', message.photo?.at(-1), 'photo.jpg'],
      ['document', message.document, message.document?.file_name],
      ['voice', message.voice, 'voice.ogg'],
      ['audio', message.audio, message.audio?.file_name || message.audio?.title],
      ['video', message.video, message.video?.file_name || 'video.mp4'],
      ['video_note', message.video_note, 'video-note.mp4'],
      ['sticker', message.sticker, `sticker${message.sticker?.emoji ? `-${message.sticker.emoji}` : ''}.webp`],
      ['animation', message.animation, message.animation?.file_name || 'animation.gif'],
    ]
    const found = variants.find(([, value]) => value?.file_id)
    if (!found) return { text: message.text || caption || '(unsupported Telegram message)' }
    const [kind, media, rawName] = found
    const handle = `att_${createHash('sha256').update(`${eventId}:${media.file_unique_id || media.file_id}`).digest('hex').slice(0, 24)}`
    const meta = {
      kind,
      rawFileId: media.file_id,
      chatId: gate.chatId,
      userId: gate.senderId,
      messageId: String(message.message_id),
      size: media.file_size || null,
      mime: kind === 'photo' ? 'image/jpeg' : media.mime_type || null,
      name: safeFilename(rawName, kind),
    }
    this.store.rememberAttachment(handle, meta)
    const label = kind === 'document' ? `(document: ${meta.name})` : `(${kind.replace('_', ' ')})`
    let text = caption || message.text || label
    if (kind === 'photo') return { text, localImage: await this.downloadAttachment(handle, { signal: this.abortController?.signal }),
      attachment: { ...meta, handle, rawFileId: undefined } }
    if (this.transcriber && (kind === 'voice' || kind === 'audio')) try {
      const path = await this.downloadAttachment(handle, { signal: this.abortController?.signal })
      const result = await this.transcriber.transcribe({ path, name: meta.name, mime: meta.mime, duration: media.duration, signal: this.abortController?.signal })
      if (result?.text) text = `${text}\n\n${TRANSCRIPT_PREFIX}\n${result.text}`
    } catch { this.log('telegram: transcription status=fallback reason=preparation') }
    return { text, attachment: { ...meta, handle, rawFileId: undefined } }
  }
  inboxUsage() {
    return readdirSync(this.store.inboxDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .reduce((total, entry) => total + statSync(join(this.store.inboxDir, entry.name)).size, 0)
  }
  cleanupInbox() {
    const cutoff = Date.now() - this.store.loadConfig().inboxRetentionHours * 60 * 60 * 1000
    const runtime = this.store.loadRuntime()
    const retained = new Set([
      ...Object.values(runtime.events).filter(event => event.status !== 'delivered').map(event => event.payload?.localImage),
      ...Object.values(runtime.attachments).map(attachment => attachment.localPath),
    ].filter(Boolean))
    for (const entry of readdirSync(this.store.inboxDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(this.store.inboxDir, entry.name)
      if (!retained.has(path) && statSync(path).mtimeMs < cutoff) try { unlinkSync(path) } catch {}
    }
  }
  async downloadRaw(fileId, suggestedName, advertisedSize, { signal } = {}) {
    this.cleanupInbox()
    if (advertisedSize && advertisedSize > MAX_DOWNLOAD_BYTES) throw permanentError('attachment exceeds Telegram download limit')
    if (this.inboxUsage() + Number(advertisedSize || 0) > MAX_INBOX_BYTES) throw permanentError('Telegram inbox quota exceeded')
    const { bytes, file } = await this.api.download(fileId, MAX_DOWNLOAD_BYTES, { signal })
    if (this.inboxUsage() + bytes.length > MAX_INBOX_BYTES) throw permanentError('Telegram inbox quota exceeded')
    const rawExtension = file.file_path?.includes('.') ? file.file_path.split('.').pop() : ''
    const extension = String(rawExtension || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 10)
    const base = safeFilename(suggestedName).replace(/\.[^.]+$/, '')
    const path = join(this.store.inboxDir, `${base}-${randomBytes(4).toString('hex')}${extension ? `.${extension}` : ''}`)
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
    chmodSync(path, 0o600)
    return path
  }
  async downloadAttachment(handle, options = {}) {
    const meta = this.store.attachment(handle)
    const authorized = this.store.authorizedChat(meta.chatId)
    if (String(authorized.userId) !== String(meta.userId)) throw new Error('Telegram attachment owner is no longer paired')
    if (meta.size && meta.size > MAX_DOWNLOAD_BYTES) throw new Error('attachment exceeds Telegram download limit')
    if (meta.localPath && existsSync(meta.localPath)) return meta.localPath
    const path = await this.downloadRaw(meta.rawFileId, meta.name || meta.kind, meta.size, options)
    this.store.rememberAttachment(handle, { ...meta, localPath: path })
    return path
  }
  async reply({ chat_id, text, reply_to, files = [] }, { signal, source = 'Codex' } = {}) {
    this.store.authorizedChat(chat_id)
    if (typeof text !== 'string' || text.length === 0) throw new Error('telegram_reply text must be a non-empty string')
    if (!Array.isArray(files)) throw new Error('telegram_reply files must be an array')
    if (files.length > 10) throw new Error('telegram_reply accepts at most 10 files')
    if (reply_to !== undefined && !/^[0-9]+$/.test(String(reply_to))) throw new Error('reply_to must be a Telegram message ID')
    const eventId = `telegram-out-${randomBytes(12).toString('hex')}`
    const timestamp = new Date().toISOString()
    const outbound = this.store.acceptEvent(eventId, {
      source,
      chatId: String(chat_id),
      sourceTimestamp: timestamp,
    }).event
    const config = this.store.loadConfig()
    let chunks
    try {
      chunks = formatTelegramMarkdown(text)
    } catch (error) {
      this.log(`telegram: markdown rendering failed; sending plain text: ${this.errorText(error)}`)
      chunks = chunkText(text).map(part => ({ text: part, entities: [] }))
    }
    const ids = []
    try {
      const outboundFiles = files.map(requested => {
        const file = this.store.resolveOutboundFile(requested, this.workspaceRoot, MAX_SEND_BYTES)
        const photo = PHOTO_EXTENSIONS.has(extname(file.path).toLowerCase())
        if (photo && file.size > MAX_PHOTO_SEND_BYTES) throw new Error(`photo exceeds ${MAX_PHOTO_SEND_BYTES} bytes`)
        return { file, photo }
      })
      for (let index = 0; index < chunks.length; index += 1) {
        this.store.authorizedChat(chat_id)
        const shouldThread = reply_to && config.replyToMode !== 'off' && (config.replyToMode === 'all' || index === 0)
        const sent = await this.api.call('sendMessage', {
          chat_id,
          text: chunks[index].text,
          ...(chunks[index].entities.length ? { entities: chunks[index].entities } : {}),
          ...(shouldThread ? { reply_parameters: { message_id: Number(reply_to) } } : {}),
        }, { signal })
        ids.push(sent.message_id)
        this.store.rememberMessage(chat_id, sent.message_id, { text: chunks[index].text,
          sender: { name: 'Codex', isBot: true, isSelf: true }, sourceTimestamp: Date.now() })
      }
      for (const { file, photo } of outboundFiles) {
        this.store.authorizedChat(chat_id)
        const sent = await this.api.multipart(photo ? 'sendPhoto' : 'sendDocument', {
          chat_id,
          ...(reply_to && config.replyToMode !== 'off' ? { reply_parameters: { message_id: Number(reply_to) } } : {}),
        }, photo ? 'photo' : 'document', file, { signal })
        ids.push(sent.message_id)
        this.store.rememberMessage(chat_id, sent.message_id, { text: photo ? '(photo)' : `(document: ${file.name})`,
          mediaKind: photo ? 'photo' : 'document', sender: { name: 'Codex', isBot: true, isSelf: true }, sourceTimestamp: Date.now() })
      }
    } catch (error) {
      this.store.markEvent(eventId, 'failed', { sentMessageIds: ids })
      throw new Error(`reply failed after ${ids.length} Telegram messages: ${error.message}`)
    }
    this.store.markEvent(eventId, 'delivered', { sentMessageIds: ids })
    return { message_ids: ids, event_id: eventId, timestamp, sequence: outbound.sequence }
  }
  async sendMessage(chatId, text, extra = {}) {
    const sent = []
    for (const part of chunkText(text)) {
      const message = await this.api.call('sendMessage', { chat_id: chatId, text: part, ...extra })
      sent.push(message)
      if (message?.message_id != null) this.store.rememberMessage(chatId, message.message_id, { text: part,
        sender: { name: 'Codex', isBot: true, isSelf: true }, sourceTimestamp: Date.now() })
    }
    return sent
  }
  async react(chatId, messageId, emoji) {
    return this.api.call('setMessageReaction', {
      chat_id: chatId,
      message_id: Number(messageId),
      reaction: [{ type: 'emoji', emoji }],
    }, { skipWhileHeld: true })
  }
  async agentReact({ chat_id, message_id, emoji }) {
    return this.reactions.explicit(chat_id, message_id, emoji)
  }
  async editMessage({ chat_id, message_id, text }, { signal } = {}) {
    this.store.authorizedChat(chat_id)
    if (!/^\d+$/.test(String(message_id))) throw new Error('message_id must be a Telegram message ID')
    if (typeof text !== 'string' || !text.length) throw new Error('message text must be nonempty')
    const known = this.store.message(chat_id, message_id)
    if (!known?.sender?.isSelf) throw new Error('only messages recorded as sent by this bot can be edited')
    const parts = formatTelegramMarkdown(text)
    if (parts.length !== 1) throw new Error('an edited message must fit one Telegram message; send a new reply for longer text')
    const part = parts[0]
    try {
      await this.api.call('editMessageText', { chat_id, message_id: Number(message_id), text: part.text,
        entities: part.entities }, { signal, beforeSend: () => this.store.authorizedChat(chat_id) })
    } catch (error) {
      if (error.code !== 400 || !/message is not modified/i.test(error.message)) throw error
    }
    this.store.rememberMessage(chat_id, message_id, { ...known, text: part.text })
    return { message_id: String(message_id) }
  }
  async notifyPaired(chatId, alias, role) {
    await this.sendMessage(chatId, `Paired as ${alias} (${role}). Messages now reach the active Gelios session.`)
  }
}
export { TelegramError }
