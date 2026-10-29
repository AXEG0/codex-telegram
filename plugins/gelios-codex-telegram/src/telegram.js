import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { MAX_DOWNLOAD_BYTES, MAX_INBOX_BYTES, MAX_SEND_BYTES, addEvent, atomicWriteJson, chunkText, processInfo, safeDisplayName, safeFilename, safeMetadataValue } from './core.js'
import { editRichParsed, richEditParse, richText, sendRich } from './rich.js'
import { TRANSCRIPT_PREFIX } from './transcription.js'
import { ReactionQueue } from './reactions.js'
import { BurstBatcher } from './batching.js'
import { admitGroupMessage } from './policy.js'
import { deliverySettings, formatOf } from './settings.js'
import { ANSWERED, answered, chosenKeyboard, keyboardOf, keyboardRefused, messageGone, notModified, onKeyboard, openQuestion, parseButtons,
  parseQuestionData, questionsOf, recordFor, reviseQuestion, settleEdit, settleInterrupted, settleSend, swapDone, takeQuestion, NOT_ON_MESSAGE, QUESTION_PREFIX } from './questions.js'
const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const MAX_PHOTO_SEND_BYTES = 10 * 1024 * 1024
// The whole preparation of one voice or audio message: lookup, download, conversion, upload and the answer.
export const AUDIO_DEADLINE_MS = 30_000
// Journaled updates whose preparation and delivery may wait at once before polling pauses.
const MAX_PENDING_WORK = 64
// Commands are private-chat controls; in a group they are neither run nor passed on as input.
const COMMANDS = new Set(['/start', '/help', '/status', '/model', '/reasoning', '/new'])
// The fixed first message to a pinned bot that has not written yet; see openBotRoute.
export const BOT_OPENER = 'Opening this chat. Reply with any message so the next ones can follow.'
const BOT_BUTTONS = "buttons are refused in a bot's chat: a bot cannot press one"
// How much of a message an answer or a reaction quotes, as AXEG0/claude-telegram's reaction.ts does.
const OPENING_CHARS = 100
const opening = text => { const points = [...String(text).replace(/\s+/g, ' ').trim()]; return points.length > OPENING_CHARS ? `${points.slice(0, OPENING_CHARS - 1).join('')}…` : points.join('') }
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
  const rich = richText(message); if (rich !== undefined) return rich
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
// A pin's first contact is keyed by its time, so pinning the bot again starts a new one.
const botRouteKey = (chatId, user) => `${chatId}:${user.botUsername}:${user.botPinnedAt || ''}`
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
    if (data?.parameters?.migrate_to_chat_id != null) error.migrateTo = String(data.parameters.migrate_to_chat_id)
    if (error.code === 429) error.retryAfterMs = this.hold(method, data?.parameters?.retry_after ?? response.headers?.get('retry-after') ?? /retry after (\d+)/i.exec(data?.description)?.[1])
    throw error
  }
  async call(method, params = {}, options = {}) {
    return this.result(method, await this.request(`${this.base}/${method}`, { method: 'POST', body: formParams(params) }, options))
  }
  async multipart(method, fields, fieldName, file, { signal, beforeSend } = {}) {
    const data = new FormData()
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue
      data.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
    data.set(fieldName, new Blob([file.bytes]), file.name)
    return this.result(method, await this.request(`${this.base}/${method}`, { method: 'POST', body: data }, { signal, timeoutMs: 55_000, beforeSend }))
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
// Telegram's own answer on whether a private chat is a bot's: the user getChatMember returns for it.
export async function askBotChat(api, chatId, { signal } = {}) {
  let member
  try { member = await api.call('getChatMember', { chat_id: String(chatId), user_id: String(chatId) }, { signal }) } catch (error) {
    throw new Error(`could not tell whether chat ${chatId} is a bot: ${error.message}`)
  }
  return member?.user?.is_bot === true
}
export class TelegramChannel {
  constructor({ store, token, workspaceRoot, onInbound, onControl = async () => null, onStatus = () => ({}), transcriber = null, log = console.error, atBoundary = () => false }) {
    this.store = store; this.workspaceRoot = workspaceRoot
    this.api = new TelegramApi(token, { hold: store.loadRuntime().telegramHold, onHold: (method, ms, until) => {
      const runtime = store.loadRuntime(); runtime.telegramHold = { until, ms }; store.saveRuntime(runtime)
      this.log(`telegram: ${method} was rate limited (429); holding every Telegram call for ${formatDuration(ms)}, until ${new Date(until).toISOString()}`) } })
    this.onInbound = onInbound; this.onControl = onControl; this.transcriber = transcriber
    this.onStatus = onStatus; this.log = log; this.stopping = false; this.atBoundary = atBoundary
    // The bot's own ID, from its token until getMe answers, and its username, for mentions in groups.
    this.botId = String(token || '').split(':', 1)[0]; this.botUsername = null
    this.pending = new Set(); this.maxPendingWork = MAX_PENDING_WORK; this.audioDeadlineMs = AUDIO_DEADLINE_MS
    this.abortController = null; this.pollPromise = null; this.retentionTimer = null
    this.typing = new Map(); this.typingIntervalMs = 4000
    this.retryDelay = attempt => Math.min(attempt * 1000, 15_000)
    this.now = () => Date.now()
    this.lockPath = join(store.dir, 'poller.lock'); this.lockIdentity = null
    this.reactions = new ReactionQueue({ store, authorize: chat => store.destination(chat),
      send: (chatId, messageId, emoji) => this.api.call('setMessageReaction', {
        chat_id: chatId, message_id: Number(messageId), reaction: emoji ? [{ type: 'emoji', emoji }] : [],
      }, { beforeSend: () => store.destination(chatId) }), log: message => this.log(message) })
    this.batcher = new BurstBatcher({ publish: events => this.publishBatch(events) })
    // Whether a chat is a bot's, by chat id. See botChat.
    this.botChats = new Map()
    // Presses reach whichever process polls: buttons need this bridge polling, with no 409 since its last poll.
    this.polling = false; this.pollConflict = false
    // Keyboard changes to one message run one at a time, so a late swap never lands over a newer keyboard.
    this.keyboardChains = new Map(); this.swapAttempts = new Map()
  }
  // A paired bot gets a reply or an edit as plain text, as written: the
  // receiving plugin hands its agent a message's text, caption or media, and a
  // rich message carries none of them. Whether a chat is a bot's comes from
  // Telegram's own is_bot: on the sender of a message the access check let
  // through, or, for a private chat not heard from since the bridge started,
  // on the user getChatMember returns for it.
  learnPeer(from) { if (from?.id != null) this.botChats.set(String(from.id), from.is_bot === true) }
  async botChat(chatId, { signal } = {}) {
    const key = String(chatId)
    // A group's chat ID is negative, and a group is never classified as a bot.
    if (key.startsWith('-')) return false
    if (this.botChats.has(key)) return this.botChats.get(key)
    const isBot = await askBotChat(this.api, key, { signal })
    this.botChats.set(key, isBot)
    return isBot
  }
  errorText(error) { const text = String(error?.message || error); return this.api.token ? text.split(this.api.token).join('[redacted]') : text }
  // Typing runs per chat and topic, each route with the time it began; the bridge's monitor (alerts.js) ends it
  // with the turn and pauses it while Codex waits on the user. Stopping a chat alone stops all of its topics.
  startTyping(chatId, threadId) {
    const chat = String(chatId), key = `${chat}:${threadId || ''}`; if (this.typing.has(key)) return
    const pulse = () => { try { this.store.destination(chat) } catch { this.stopTyping(chat, threadId || ''); return }
      if (!this.typingPaused) this.api.call('sendChatAction', { chat_id: chat, action: 'typing', ...(threadId ? { message_thread_id: Number(threadId) } : {}) }, { skipWhileHeld: true }).catch(() => {}) }
    const timer = setInterval(pulse, this.typingIntervalMs); timer.unref()
    this.typing.set(key, { timer, chatId: chat, ...(threadId ? { threadId: String(threadId) } : {}), began: this.now() }) }
  typingRoutes() { return this.typing.values() }
  stopTyping(chatId, threadId) {
    for (const [key, route] of this.typing) if (chatId === undefined || (threadId === undefined ? key.startsWith(`${chatId}:`) : key === `${chatId}:${threadId}`)) {
      clearInterval(route.timer); this.typing.delete(key) } }
  // Proof, readable from outside, that getUpdates completes: written only after one returns ok, never for a failed
  // poll, getMe, setMyCommands or the work an update starts. A pause for backpressure or a bridge boundary runs no
  // getUpdates, so the record stops advancing then. It is separate from heartbeat.json, the scheduled prompts.
  recordPoll(updates) {
    this.lastPollAt = this.now()
    try { atomicWriteJson(join(this.store.dir, 'poll-health.json'), { version: 1, pid: process.pid, completedAt: new Date(this.lastPollAt).toISOString(), updates }); this.pollRecordFailed = false }
    catch (error) { if (!this.pollRecordFailed) this.log(`telegram: poll health record not written: ${error.message}`); this.pollRecordFailed = true }
  }
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
  // resumed: an earlier channel of this process ran, so its sends may still be in flight.
  start({ lockHeld = false, resumed = false } = {}) {
    if (!lockHeld) this.acquireLock()
    this.cleanupInbox(); this.retentionTimer = setInterval(() => this.cleanupInbox(), 60 * 60 * 1000); this.retentionTimer.unref()
    this.reactions.start()
    if (!resumed) this.questions(settleInterrupted)
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
    const stopped = new Promise(resolve => { this.api.stopped.signal.addEventListener('abort', resolve, { once: true }); if (this.api.stopped.signal.aborted) resolve() })
    this.polling = true
    try {
      // The bot's username lets a group message mention it; without it only replies to the bot count.
      const me = await this.api.call('getMe').catch(error => { this.log(`telegram: getMe failed; group mentions by username are off: ${this.errorText(error)}`); return null })
      if (me?.id != null) this.botId = String(me.id)
      if (typeof me?.username === 'string') this.botUsername = me.username
      this.later(this.retrySwaps(), true)
      await this.api.call('setMyCommands', {
        commands: [
          { command: 'start', description: 'Pair with the active Gelios session' },
          { command: 'help', description: 'Show channel help' },
          { command: 'status', description: 'Show pairing status' },
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
            // Telegram sends reactions only to a bot that asks for them.
            allowed_updates: ['message', 'edited_message', 'callback_query', 'message_reaction'],
          }, { signal: this.abortController.signal, timeoutMs: POLL_DEADLINE_MS })
          clearTimeout(timer); this.pollConflict = false; this.recordPoll(updates.length)
          if (pollFailures) this.log(`telegram: polling recovered after ${pollFailures} consecutive failure${pollFailures === 1 ? '' : 's'} over ${formatDuration(this.now() - streakStartedAt)} (first at ${new Date(streakStartedAt).toISOString()})`)
          pollFailures = 0; conflicts = 0
          for (const update of updates) {
            // Backpressure: polling pauses while too much journaled input still waits; nothing committed is dropped.
            if (this.pending.size >= this.maxPendingWork) {
              this.log(`telegram: ${this.pending.size} journaled updates are still being prepared or delivered; polling pauses until one finishes`)
              while (this.pending.size >= this.maxPendingWork && !this.stopping) await Promise.race([...this.pending, stopped])
              if (this.stopping) break
            }
            try {
              // An update prepared for a bridge boundary waits there unjournaled, and Telegram keeps it.
              if (this.atBoundary()) throw Object.assign(new Error('the bridge is preparing for an update'), { retryWithoutAdvancing: true })
              await this.handleUpdate(update, { background: true })
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
          if (conflicts) this.pollConflict = true
          if (conflicts >= CONFLICT_LIMIT) {
            throw new Error('Telegram 409 Conflict persists; another process is polling this bot token')
          }
          const delay = Math.max(this.retryDelay(pollFailures), Math.ceil(this.api.holdMs() / 1000) * 1000)
          this.log(`telegram: polling error (${reason}); consecutive failure ${pollFailures}, retrying in ${delay / 1000}s`)
          await sleep(delay, this.api.stopped.signal)
        }
      }
    } finally {
      this.polling = false
      clearInterval(this.retentionTimer)
      this.releaseLock()
    }
  }
  // The poll loop passes background: the update is journaled or judged before this returns, and the slow
  // part, media preparation and delivery to Codex, goes on in the bridge's ordered queue (see later()).
  async handleUpdate(update, { background = false } = {}) {
    if (update.callback_query) {
      await this.flushBursts(background)
      if (String(update.callback_query.data ?? '').startsWith(QUESTION_PREFIX)) return this.handlePress(update.callback_query, { background })
      return this.handleCallback(update.callback_query, { background })
    }
    if (update.message_reaction) return this.handleReaction(update.message_reaction, update.update_id, { background })
    const message = update.edited_message || update.message
    if (!message) return
    const edited = Boolean(update.edited_message)
    const group = ['group', 'supergroup'].includes(message.chat?.type)
    if (!group && message.chat?.type !== 'private') return
    const text = message.text || message.caption || ''
    const command = text.startsWith('/') ? text.split(/\s/, 1)[0].split('@', 1)[0] : null
    let gate
    if (group || edited) {
      // Read-only admission: a group message, or an edit, never pairs anyone.
      const route = group ? admitGroupMessage(this.store.loadAccess(), message, { botId: this.botId, botUsername: this.botUsername })
        : this.store.admitPrivate(message.from, message.chat)
      if (!route || (group && !edited && COMMANDS.has(command))) return
      if (edited) {
        if (!message.text && message.caption == null) return
        const previous = this.store.message(route.chatId, String(message.message_id))
        if ((previous?.rawText ?? previous?.text) === text) return
      }
      gate = { action: 'deliver', senderId: route.senderId, chatId: route.chatId, ...(route.threadId ? { threadId: route.threadId } : {}),
        user: group ? { alias: messageSender(message).name, role: 'contributor' } : route.user, group }
      if (edited) await this.flushBursts(background)
    } else gate = this.store.gatePrivateMessage(message.from, message.chat)
    if (gate.action === 'deliver') { this.learnPeer(message.from); this.proveBotRoute(gate, message.from); if (!group) this.lastPrivateChat = gate.chatId }
    if (!edited && !group && command) {
      await this.flushBursts(background)
      if (gate.action === 'drop') return
      // Model and reasoning pickers wait for Codex; every other command answers at once.
      if (['/model', '/reasoning'].includes(command) && gate.action === 'deliver') return this.later(background ? this.retrying(() => this.handleCommand(message, command, gate)) : this.handleCommand(message, command, gate), background)
      const handled = await this.handleCommand(message, command, gate)
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
      ...(gate.group ? { chatType: message.chat.type } : {}),
      ...(gate.threadId ? { threadId: gate.threadId } : {}),
      receivedAt: Date.now(),
      text: text || '(Telegram attachment)',
      rawMessage: message,
    }
    // The topic stays on the journal record after delivery, for the bridge's own reports about this input.
    const accepted = this.store.acceptEvent(eventId, { source: 'Telegram', chatId: gate.chatId, messageId, ...(gate.threadId ? { topicId: gate.threadId } : {}),
      sourceTimestamp: baseEvent.timestamp, payload: baseEvent })
    if (accepted.duplicate && accepted.event.status !== 'staged') {
      const prior = accepted.event.parentEventId ? this.store.loadRuntime().events[accepted.event.parentEventId] : accepted.event
      if (prior?.payload && prior.retryable !== false) return this.later(this.onInbound(prior.payload, () => this.preparePersisted(prior.payload)), background)
      return
    }
    this.store.markEvent(eventId, 'staged', { payload: baseEvent })
    if (!edited) this.acknowledge(gate.chatId, messageId)
    return this.later(this.batcher.add(baseEvent), background)
  }
  // A picker command off the poll loop keeps the retries the loop gave it: its control is journaled, so a retry
  // returns the saved result and only presents it again.
  async retrying(work) {
    for (let attempt = 1; ; attempt += 1) {
      try { return await work() } catch (error) {
        if (error.permanent || attempt >= UPDATE_ATTEMPTS || this.stopping) throw error
        this.log(`telegram: command attempt ${attempt} of ${UPDATE_ATTEMPTS} failed: ${this.errorText(error)}`)
        await sleep(this.retryDelay(attempt), this.api.stopped.signal)
      }
    }
  }
  // Earlier bursts enter the journal, in order, before what follows; outside the poll loop this waits for their delivery.
  async flushBursts(background) { const flushed = this.batcher.flush(); if (background) this.later(flushed, true); else await flushed }
  // Work that runs after an update is journaled: awaited by a direct caller, tracked for the poll loop's backpressure.
  later(work, background) {
    if (!background) return work
    const task = Promise.resolve(work).catch(error => this.log(`telegram: work after a handled update failed: ${this.errorText(error)}`))
      .finally(() => this.pending.delete(task))
    this.pending.add(task)
  }
  // The optional receipt reaction: off unless the owner set receiptReaction locally; never over a reaction
  // already chosen. The ackReaction key older builds read stays ignored, so no old setting turns it back on.
  acknowledge(chatId, messageId) {
    let emoji; try { emoji = deliverySettings(this.store.loadConfig()).receiptReaction } catch (error) { this.log(`telegram: receipt reaction skipped: ${error.message}`); return }
    if (emoji) try { this.reactions.ack(chatId, messageId, emoji) } catch (error) { this.log(`telegram: receipt reaction skipped: ${error.message}`) }
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
    // Access is checked again here: a revoked sender or a removed group stops queued input for good.
    this.store.destination(event.chatId)
    if (!this.store.senderAdmitted(event.chatId, event.userId)) throw permanentError('Telegram sender authorization changed')
    const topic = event.threadId ? { message_thread_id: Number(event.threadId) } : {}
    await this.api.call('sendChatAction', { chat_id: event.chatId, action: 'typing', ...topic }, { skipWhileHeld: true }).catch(() => {})
    const gate = { chatId: event.chatId, senderId: event.userId, receivedAt: event.receivedAt }
    const extracted = await this.extractMessage(event.rawMessage, event.eventId, gate)
    const replyContext = this.replyContext(event.rawMessage, event.chatId)
    this.rememberInboundMessage(event.rawMessage, event.chatId, extracted.text)
    this.startTyping(event.chatId, event.threadId)
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
            ? '\n/model — choose the model\n/reasoning — choose reasoning effort'
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
    if (command === '/new') {
      await this.sendMessage(chatId, '/new has been removed. This conversation is unchanged.')
      return true
    }
    if (!['/model', '/reasoning'].includes(command)) return false
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
  async handleCallback(query, { background = false } = {}) {
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
    // The press is answered at once; the control it journals then waits for Codex off the poll loop.
    void this.api.call('answerCallbackQuery', {
      callback_query_id: query.id,
      text: capability.action === 'selectModel' ? 'Loading reasoning levels…' : 'Applying setting…',
    }).catch(() => {})
    return this.later(this.applyControl(query, capability, { chatId, userId, messageId }), background)
  }
  async applyControl(query, capability, { chatId, userId, messageId }) {
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
  // A press on a question button; see questions.js. Its judgment and, for the first accepted answer, the
  // answer's input event are one journal write, after earlier bursts entered the journal. Telegram's
  // answer, delivery to Codex and the keyboard swap follow it; the poll loop waits for none of them.
  async handlePress(query, { background = false } = {}) {
    const answer = text => void this.api.call('answerCallbackQuery', { callback_query_id: query.id, ...(text ? { text } : {}) })
      .catch(error => this.log(`telegram: press answer not sent: ${this.errorText(error)}`))
    const button = parseQuestionData(query.data), message = query.message
    // An inline-mode press, or one on a message Telegram no longer shows, carries no message to check.
    const label = message?.date ? onKeyboard(message, query.data) : undefined
    if (!button || !message?.chat || label === undefined || String(message.from?.id) !== this.botId) return answer(NOT_ON_MESSAGE)
    const group = ['group', 'supergroup'].includes(message.chat.type), from = query.from
    // A group member answers without mentioning the bot again; access is checked as for a message.
    const route = from?.is_bot ? null : group ? admitGroupMessage(this.store.loadAccess(), { chat: message.chat, from }, { mention: false })
      : this.store.admitPrivate(from, message.chat)
    if (!route) return answer()
    if (!group) this.lastPrivateChat = route.chatId
    const chatId = route.chatId, messageId = String(message.message_id), eventId = `telegram-answer-${button.id}-${button.revision}`
    const threadId = message.is_topic_message && Number.isInteger(message.message_thread_id) ? String(message.message_thread_id) : undefined
    const words = message.text ?? message.caption ?? richText(message), quoted = words?.trim() ? words : this.store.message(chatId, messageId)?.text
    const payload = { source: 'Telegram', eventId, chatId, messageId, userId: route.senderId, name: group ? messageSender({ from }).name : route.user.alias,
      role: group ? 'contributor' : route.user.role, timestamp: Date.now(), ...(group ? { chatType: message.chat.type } : {}), ...(threadId ? { threadId } : {}),
      receivedAt: Date.now(), text: `Pressed "${label}" on message ${messageId}${quoted ? `: "${opening(quoted)}"` : ''}`, button: label, prepared: true, journaledOnly: true }
    const runtime = this.store.loadRuntime()
    const verdict = takeQuestion(runtime, { ...button, chatId, messageId, threadId, label, senderId: route.senderId, eventId })
    if (verdict !== true) {
      // A press on an answered question shows the choice again, in case its swap never landed.
      if (verdict === ANSWERED) this.later(this.swapKeyboard(button.id), background)
      return answer(verdict)
    }
    addEvent(runtime, eventId, { source: 'Telegram', chatId, messageId, ...(threadId ? { topicId: threadId } : {}), sourceTimestamp: payload.timestamp, payload })
    this.store.saveRuntime(runtime)
    answer()
    this.startTyping(chatId, threadId)
    const delivered = this.later(this.onInbound(payload, async () => payload), background), swapped = this.later(this.swapKeyboard(button.id), background)
    if (!background) return Promise.all([delivered, swapped])
  }
  // A reaction the sender adds reaches Codex as its own input, marked reaction=<emoji>, as in AXEG0/claude-telegram's
  // reaction.ts. Only a paired private sender counts, through the read-only check, so a reaction never pairs anyone
  // or changes access. Only standard emoji the update adds count; a removal, a custom or paid reaction, or one on the
  // sender's own known message delivers nothing. A message the bridge does not remember is marked reacted_message=unknown.
  async handleReaction(reaction, updateId, { background = false } = {}) {
    if (reaction?.chat?.type !== 'private' || !reaction.user || reaction.user.is_bot) return
    const route = this.store.admitPrivate(reaction.user, reaction.chat); if (!route) return
    this.lastPrivateChat = route.chatId
    const emoji = list => (Array.isArray(list) ? list : []).filter(item => item?.type === 'emoji' && typeof item.emoji === 'string').map(item => item.emoji)
    const before = new Set(emoji(reaction.old_reaction)), added = emoji(reaction.new_reaction).filter(item => !before.has(item))
    if (!added.length) return
    const chatId = route.chatId, messageId = String(reaction.message_id), known = this.store.message(chatId, messageId)
    if (known?.sender && !known.sender.isSelf) return
    const own = known?.sender?.isSelf === true, eventId = `telegram-reaction-${chatId}-${messageId}-${updateId ?? reaction.date}`
    const payload = { source: 'Telegram', eventId, chatId, messageId, userId: route.senderId, name: route.user.alias, role: route.user.role,
      timestamp: (Number(reaction.date) || Math.floor(Date.now() / 1000)) * 1000, receivedAt: Date.now(),
      text: `${added.join(' ')} on message ${messageId}${own && known.text ? `: "${opening(known.text)}"` : ''}`, reaction: added.join(' '),
      reactedMessage: own ? 'bot' : 'unknown', prepared: true, journaledOnly: true }
    // Like an edit, it goes alone, after every burst waiting before it.
    await this.flushBursts(background)
    const accepted = this.store.acceptEvent(eventId, { source: 'Telegram', chatId, messageId, sourceTimestamp: payload.timestamp, payload })
    if (accepted.duplicate && (accepted.event.status === 'delivered' || accepted.event.retryable === false || !accepted.event.payload)) return
    this.startTyping(chatId)
    return this.later(this.onInbound(accepted.event.payload, async () => accepted.event.payload), background)
  }
  // One journal step on the question records.
  questions(change) { const runtime = this.store.loadRuntime(); const result = change(runtime); this.store.saveRuntime(runtime); return result }
  serialKeyboard(chatId, messageId, work) {
    const key = `${chatId}:${messageId}`, run = (this.keyboardChains.get(key) || Promise.resolve()).then(work, work)
    const tail = run.catch(() => {}); this.keyboardChains.set(key, tail)
    void tail.then(() => { if (this.keyboardChains.get(key) === tail) this.keyboardChains.delete(key) })
    return run
  }
  assertPressesReachHere() {
    if (!this.polling) throw new Error('buttons are refused here: this bridge is not polling the bot, so a press would reach whichever process polls; nothing was sent')
    if (this.pollConflict) throw new Error('buttons are refused here: a poll ended in a conflict (409) with no poll completed since, so a press would reach whichever process polls; nothing was sent')
  }
  // Swaps an answered question's keyboard for one disabled button showing the choice. The swap ends once it lands
  // or Telegram refuses it (400 or 403); a rate limit or no answer leaves it pending (see retrySwap).
  async swapKeyboard(id) {
    const record = questionsOf(this.store.loadRuntime()).records[id]
    if (!record?.swap || !record.messageId) return
    return this.serialKeyboard(record.chatId, record.messageId, async () => {
      const current = questionsOf(this.store.loadRuntime()).records[id]
      if (!current?.swap || current.status !== 'taken') return
      try {
        await this.api.call('editMessageReplyMarkup', { chat_id: current.chatId, message_id: Number(current.messageId), reply_markup: chosenKeyboard(current.answer.label) },
          { beforeSend: () => this.store.destination(current.chatId) })
      } catch (error) {
        const ends = notModified(error) || [400, 403].includes(error.code) || error.permanent === true
        this.log(`telegram: keyboard swap on message ${current.messageId} in chat ${current.chatId} ${ends ? 'refused; it ends' : 'still pending'}: ${this.errorText(error)}`)
        if (!ends) return this.retrySwap(id)
      }
      this.swapAttempts.delete(id)
      this.questions(runtime => swapDone(runtime, id, current.revision))
    })
  }
  // A swap Telegram did not take is tried again after a growing wait, up to UPDATE_ATTEMPTS times; after
  // that the next press or start tries it.
  retrySwap(id) {
    const attempt = (this.swapAttempts.get(id) || 0) + 1
    if (attempt > UPDATE_ATTEMPTS || this.stopping) { this.swapAttempts.delete(id); return }
    this.swapAttempts.set(id, attempt)
    const timer = setTimeout(() => this.later(this.swapKeyboard(id), true), Math.max(this.retryDelay(attempt), this.api.holdMs())); timer.unref()
  }
  async retrySwaps() { for (const record of Object.values(questionsOf(this.store.loadRuntime()).records)) if (record.swap) await this.swapKeyboard(record.id) }
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
    if (kind === 'photo') return { text, localImage: await this.downloadAttachment(handle, { signal: this.api.stopped.signal }),
      attachment: { ...meta, handle, rawFileId: undefined } }
    if (this.transcriber && (kind === 'voice' || kind === 'audio')) text = await this.transcribe(handle, meta, media, text, gate)
    return { text, attachment: { ...meta, handle, rawFileId: undefined } }
  }
  // One job per voice or audio message: AUDIO_DEADLINE_MS from the start of its preparation covers the
  // file lookup, download, conversion, upload and answer, and bridge shutdown ends it too; a later poll
  // never does. Waiting in the queue before this starts is logged apart. Every failure keeps the attachment.
  async transcribe(handle, meta, media, text, gate) {
    const started = Date.now(); const job = new AbortController()
    const timer = setTimeout(() => job.abort(Object.assign(new Error('transcription deadline'), { category: 'timeout' })), this.audioDeadlineMs)
    const stop = () => job.abort(Object.assign(new Error('bridge stopping'), { category: 'cancelled' }))
    this.api.stopped.signal.addEventListener('abort', stop, { once: true }); if (this.api.stopped.signal.aborted) stop()
    let status = 'fallback', reason = ''
    try {
      const path = await this.downloadAttachment(handle, { signal: job.signal })
      const config = this.store.loadConfig()
      const result = await this.transcriber.transcribe({ path, name: meta.name, mime: meta.mime, duration: media.duration, signal: job.signal,
        settings: { model: config.transcriptionModel, languages: config.transcriptionLanguages } })
      if (result?.text) { text = `${text}\n\n${TRANSCRIPT_PREFIX}\n${result.text}`; status = 'transcribed' }
    } catch { reason = ` reason=${job.signal.aborted ? job.signal.reason?.category || 'cancelled' : 'preparation'}` }
    finally { clearTimeout(timer); this.api.stopped.signal.removeEventListener('abort', stop) }
    const queued = Number.isFinite(gate.receivedAt) ? ` queuedMs=${Math.max(0, started - gate.receivedAt)}` : ''
    this.log(`telegram: transcription status=${status}${reason}${queued} preparationMs=${Date.now() - started}`)
    return text
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
    this.store.destination(meta.chatId)
    if (!this.store.senderAdmitted(meta.chatId, meta.userId)) throw new Error('Telegram attachment owner is no longer paired')
    if (meta.size && meta.size > MAX_DOWNLOAD_BYTES) throw new Error('attachment exceeds Telegram download limit')
    if (meta.localPath && existsSync(meta.localPath)) return meta.localPath
    const path = await this.downloadRaw(meta.rawFileId, meta.name || meta.kind, meta.size, options)
    this.store.rememberAttachment(handle, { ...meta, localPath: path })
    return path
  }
  async trackReply(work) {
    this.pendingReplies = (this.pendingReplies || 0) + 1
    try { return await work() } finally { this.pendingReplies -= 1 }
  }
  reply(args, options) { return this.trackReply(() => this.sendReply(args, options)) }
  async sendReply({ chat_id, text, reply_to, files = [], format, message_thread_id, buttons }, { signal, source = 'Codex' } = {}) {
    const route = this.store.destination(chat_id)
    if (typeof text !== 'string' || text.length === 0) throw new Error('telegram_reply text must be a non-empty string')
    if (!Array.isArray(files)) throw new Error('telegram_reply files must be an array')
    if (files.length > 10) throw new Error('telegram_reply accepts at most 10 files')
    if (reply_to !== undefined && !/^[0-9]+$/.test(String(reply_to))) throw new Error('reply_to must be a Telegram message ID')
    if (message_thread_id !== undefined && !/^[1-9][0-9]*$/.test(String(message_thread_id))) throw new Error('message_thread_id must be a Telegram topic ID')
    // The format and the delivery settings are checked before anything is journaled or sent.
    const style = formatOf(format, 'nothing was sent')
    const config = this.store.loadConfig(); const settings = deliverySettings(config)
    // Buttons are checked before anything is journaled or sent; see questions.js.
    // reached: whether the latest call left the process, so an error after it may hide a delivered message.
    let rows, question, carry, reached = false
    if (buttons !== undefined) {
      try { rows = parseButtons(buttons, false) } catch (error) { throw permanentError(`${error.message}; nothing was sent`) }
      this.assertPressesReachHere()
      if (route.kind === 'private' && (route.user.botUsername || await this.botChat(chat_id, { signal }))) throw permanentError(`${BOT_BUTTONS}; nothing was sent`)
    }
    const eventId = `telegram-out-${randomBytes(12).toString('hex')}`
    const timestamp = new Date().toISOString()
    const outbound = this.store.acceptEvent(eventId, {
      source,
      chatId: String(chat_id),
      sourceTimestamp: timestamp,
    }).event
    const ids = []
    // Rich parts and their plain fallback, as AXEG0/claude-telegram sends them. See rich.js.
    const progress = { ids, rich: [], done: 0, total: 0 }
    try {
      // The question is recorded before its keyboard goes out on the reply's last message: the last file, or
      // else the last text part. Telegram's answer binds that message; without an answer it stays uncertain.
      if (rows) {
        question = this.questions(runtime => openQuestion(runtime, { chatId: chat_id, threadId: message_thread_id, rows }))
        // attempted stays set only when the carrying request left and Telegram never answered it.
        carry = { markup: keyboardOf(rows, question.id, 1), attempted: false, done: false, refused: keyboardRefused, wrap: async (last, call) => {
          if (!last) return call({})
          carry.attempted = true
          try {
            const sent = await call({ reply_markup: carry.markup })
            carry.done = true; this.questions(runtime => settleSend(runtime, question.id, 'sent', sent.message_id))
            return sent
          } catch (error) { if (answered(error) || !reached) carry.attempted = false; throw error }
        } }
      }
      const outboundFiles = files.map(requested => {
        const file = this.store.resolveOutboundFile(requested, this.workspaceRoot, MAX_SEND_BYTES)
        const photo = PHOTO_EXTENSIONS.has(extname(file.path).toLowerCase())
        if (photo && file.size > MAX_PHOTO_SEND_BYTES) throw new Error(`photo exceeds ${MAX_PHOTO_SEND_BYTES} bytes`)
        return { file, photo }
      })
      // A pinned bot that has not written gets only the fixed opener; the reply waits for its answer.
      if (route.kind === 'private' && route.user.botUsername) await this.openBotRoute(route, { signal })
      const toBot = route.kind === 'private' && await this.botChat(chat_id, { signal })
      // A group reply stays in its topic, and a missing reply target fails it rather than moving it.
      const topic = message_thread_id === undefined ? {} : { message_thread_id: Number(message_thread_id) }
      const replyTo = sent => reply_to && settings.replyToMode !== 'off' && (settings.replyToMode === 'all' || sent === 0) ? Number(reply_to) : undefined
      const replyParams = to => to === undefined ? {} : { reply_parameters: { message_id: to, ...(route.kind === 'private' ? { allow_sending_without_reply: true } : {}) } }
      const send = (method, params) => { reached = false; this.store.destination(chat_id); return this.api.call(method, { ...params, ...topic }, { signal, beforeSend: () => { reached = true } }) }
      const remember = (messageId, words) => this.store.rememberMessage(chat_id, messageId, { text: words,
        sender: { name: 'Codex', isBot: true, isSelf: true }, sourceTimestamp: Date.now() })
      const chunks = part => chunkText(part, settings.textChunkLimit, settings.chunkMode)
      // The keyboard rides on the reply's last message: the last file, or else the last text part.
      const carried = (last, call) => carry ? carry.wrap(last, call) : call({})
      if (toBot) {
        for (const chunk of chunks(text)) {
          const to = replyTo(ids.length)
          const sent = await send('sendMessage', { chat_id, text: chunk, ...(to !== undefined ? { reply_parameters: { message_id: to } } : {}) })
          ids.push(sent.message_id)
          remember(sent.message_id, chunk)
        }
      } else if (style !== 'rich') {
        // MarkdownV2 cannot be cut safely: an entity or escape split across messages fails part way.
        if (style === 'markdownv2' && text.length > settings.textChunkLimit) throw permanentError(`markdownv2 text must fit one message of ${settings.textChunkLimit} characters; nothing was sent`)
        const parts = chunks(text)
        for (const [index, chunk] of parts.entries()) {
          const params = { chat_id, text: chunk, ...(style === 'markdownv2' ? { parse_mode: 'MarkdownV2' } : {}), ...replyParams(replyTo(ids.length)) }
          const sent = await carried(!outboundFiles.length && index === parts.length - 1, extra => send('sendMessage', { ...params, ...extra }))
          ids.push(sent.message_id)
          remember(sent.message_id, chunk)
        }
      } else {
        await sendRich({ send, chatId: chat_id, text, replyTo, plainChunks: chunks, progress, sent: remember, carry: outboundFiles.length ? undefined : carry,
          allowMissingReply: route.kind === 'private', log: line => this.log(line) })
      }
      for (const [index, { file, photo }] of outboundFiles.entries()) {
        const upload = extra => { reached = false; this.store.destination(chat_id); return this.api.multipart(photo ? 'sendPhoto' : 'sendDocument', {
          chat_id, ...topic,
          ...(reply_to && settings.replyToMode !== 'off' ? { reply_parameters: { message_id: Number(reply_to) } } : {}), ...extra,
        }, photo ? 'photo' : 'document', file, { signal, beforeSend: () => { reached = true } }) }
        const sent = await carried(index === outboundFiles.length - 1, upload)
        ids.push(sent.message_id)
        this.store.rememberMessage(chat_id, sent.message_id, { text: photo ? '(photo)' : `(document: ${file.name})`,
          mediaKind: photo ? 'photo' : 'document', sender: { name: 'Codex', isBot: true, isSelf: true }, sourceTimestamp: Date.now() })
      }
    } catch (error) {
      this.store.markEvent(eventId, 'failed', { sentMessageIds: ids, richMessageIds: progress.rich })
      // A keyboard that may have arrived stays open to a matching press; one refused or never sent ends. It is never sent again.
      if (question && !carry.done) this.questions(runtime => settleSend(runtime, question.id, carry.attempted ? 'unknown' : 'refused'))
      const unsure = question && !carry.done && carry.attempted ? '; whether the message with the buttons arrived is unknown, and a press on it still counts' : ''
      // Telegram moved the group to a new chat ID: only the owner's local policy may follow it.
      const moved = error.migrateTo ? `; Telegram moved this group to chat ${error.migrateTo}, which only the owner can add locally` : ''
      throw Object.assign(new Error(`reply failed after ${ids.length} Telegram messages: ${error.message}${moved}${unsure}`), { permanent: error.permanent, code: error.code, retryAfterMs: error.retryAfterMs })
    }
    this.store.markEvent(eventId, 'delivered', { sentMessageIds: ids, richMessageIds: progress.rich })
    return { message_ids: ids, event_id: eventId, timestamp, sequence: outbound.sequence }
  }
  // First contact with a pinned bot that has not written to this one. Telegram accepts a message to a
  // bot's numeric ID before any message by @username has passed between the two and never delivers it,
  // and a username can change hands, so a check after sending cannot protect a reply's own text. Only a
  // fixed opener goes by the pinned username, after Telegram resolves it to the pinned ID and calls that
  // chat a bot; the reply waits until the bot answers from its ID (proveBotRoute). A reply's text never
  // goes by username. The checks follow AXEG0/claude-telegram's bots.ts.
  async openBotRoute(route, { signal } = {}) {
    if (this.botChats.get(route.chatId) === true) return
    const key = botRouteKey(route.chatId, route.user); const state = this.store.loadRuntime().botRoutes?.[key] || {}
    if (state.provenAt) return
    const name = route.user.botUsername; const held = `nothing from this reply was sent; send it again once bot ${route.chatId} has answered`
    if (state.stoppedAt) throw permanentError(`first contact with bot ${route.chatId} stopped: ${state.reason}; nothing from this reply was sent, and the owner must pin the bot again`)
    if (state.openerAt) throw permanentError(`bot ${route.chatId} has not answered the opener sent to @${name} at ${new Date(state.openerAt).toISOString()}; ${held}`)
    const chat = await this.api.call('getChat', { chat_id: `@${name}` }, { signal })
    if (String(chat?.id) !== route.chatId) throw permanentError(`@${name} is chat ${chat?.id}, not ${route.chatId}; nothing was sent`)
    const member = await this.api.call('getChatMember', { chat_id: route.chatId, user_id: route.chatId }, { signal })
    if (member?.user?.is_bot !== true) throw permanentError(`chat ${route.chatId} is not a bot; nothing was sent`)
    // Recorded before the call: a lost answer, or a 5xx that may come after Telegram took the message, leaves
    // the opener possibly sent, and it is never sent twice. Only a refusal Telegram answered (4xx) clears it.
    this.saveBotRoute(key, { openerAt: Date.now() })
    let sent
    try { sent = await this.api.call('sendMessage', { chat_id: `@${name}`, text: BOT_OPENER }, { signal }) } catch (error) {
      if (error instanceof TelegramError && error.code >= 400 && error.code < 500) this.saveBotRoute(key, null)
      throw error
    }
    if (String(sent?.chat?.id) !== route.chatId) {
      this.saveBotRoute(key, { stoppedAt: Date.now(), reason: `the opener sent to @${name} reached chat ${sent?.chat?.id}` })
      throw permanentError(`the opener sent to @${name} reached chat ${sent?.chat?.id}, not ${route.chatId}; first contact stopped, and nothing else was sent`)
    }
    throw permanentError(`first contact with bot ${route.chatId}: a fixed opener went to @${name}; ${held}`)
  }
  // A pinned bot's own message, from its numeric ID in its private chat, proves the numeric route.
  proveBotRoute(gate, from) {
    if (!gate.user?.botUsername || from?.is_bot !== true || String(from.id) !== String(gate.chatId)) return
    const key = botRouteKey(gate.chatId, gate.user)
    if (!this.store.loadRuntime().botRoutes?.[key]?.provenAt) this.saveBotRoute(key, { provenAt: Date.now() })
  }
  saveBotRoute(key, state) {
    const runtime = this.store.loadRuntime(); const routes = runtime.botRoutes ||= {}
    if (state) routes[key] = { ...routes[key], ...state, updatedAt: Date.now() }; else delete routes[key]
    const keys = Object.keys(routes); for (const old of keys.slice(0, Math.max(0, keys.length - 64))) delete routes[old]
    this.store.saveRuntime(runtime)
  }
  sendMessage(chatId, text, extra = {}) { return this.trackReply(() => this.sendText(chatId, text, extra)) }
  // A notice of the bridge's own about queued input: sent only while the chat may still receive output,
  // and in the input's topic. A revoked chat or a removed group gets nothing.
  async notice(chatId, text, threadId) {
    try { this.store.destination(chatId) } catch (error) { this.log(`telegram: notice to chat ${chatId} withheld: ${error.message}`); return [] }
    return this.sendMessage(chatId, text, threadId ? { message_thread_id: Number(threadId) } : {})
  }
  async sendText(chatId, text, extra) {
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
  // An edit is the whole change: text alone removes the keyboard, buttons alone keep the text, and an empty
  // list removes the keyboard. Everything is checked before the journal or Telegram is touched.
  async editMessage({ chat_id, message_id, text, format, buttons }, { signal } = {}) {
    const route = this.store.destination(chat_id)
    if (!/^\d+$/.test(String(message_id))) throw new Error('message_id must be a Telegram message ID')
    if (text === undefined && buttons === undefined) throw new Error('an edit needs text, buttons or both; nothing was edited')
    if (text !== undefined && (typeof text !== 'string' || !text.length)) throw new Error('message text must be nonempty')
    if (text === undefined && format !== undefined) throw new Error('format applies only to text; nothing was edited')
    const style = formatOf(format, 'nothing was edited')
    let rows
    if (buttons !== undefined) try { rows = parseButtons(buttons, true) } catch (error) { throw new Error(`${error.message}; nothing was edited`) }
    const known = this.store.message(chat_id, message_id)
    if (!known?.sender?.isSelf) throw new Error('only messages recorded as sent by this bot can be edited')
    const toBot = route.kind === 'private' && await this.botChat(chat_id, { signal })
    if (rows?.length) { if (toBot) throw new Error(`${BOT_BUTTONS}; nothing was edited`); this.assertPressesReachHere() }
    const log = line => this.log(line)
    // The rich parse runs before the edit; text too long for one rich message fails here.
    const rich = text === undefined || toBot || style !== 'rich' ? undefined : await richEditParse(text, log)
    // reached: whether the latest call left the process; an edit that never left changed nothing.
    let reached = false
    const send = (method, params) => { reached = false; return this.api.call(method, params, { signal, beforeSend: () => { this.store.destination(chat_id); reached = true } }) }
    return this.serialKeyboard(String(chat_id), String(message_id), async () => {
      // A new revision, or the removal, is recorded before the call; Telegram's answer settles it (see questions.js).
      const question = this.questions(runtime => {
        const record = recordFor(runtime, chat_id, message_id)
        return record ? reviseQuestion(record, rows ?? []) : rows?.length ? openQuestion(runtime, { chatId: chat_id, messageId: message_id, rows }) : null
      })
      const markup = rows?.length ? { reply_markup: keyboardOf(rows, question.id, question.revision) } : {}
      try {
        if (text === undefined) await send('editMessageReplyMarkup', { chat_id, message_id: Number(message_id), ...markup })
        else if (style === 'markdownv2' && !toBot) await send('editMessageText', { chat_id, message_id: Number(message_id), text, parse_mode: 'MarkdownV2', ...markup })
        else await editRichParsed({ send, chatId: chat_id, messageId: Number(message_id), text, rich, markup: markup.reply_markup, refused: keyboardRefused, log })
      } catch (error) {
        if (!notModified(error)) {
          const outcome = messageGone(error) ? 'gone' : answered(error) || !reached ? 'refused' : 'unknown'
          if (question) this.questions(runtime => settleEdit(runtime, chat_id, message_id, question.revision, outcome))
          if (question && outcome === 'unknown') error.message += '; whether the edit landed is unknown, and only its own buttons count'
          throw error
        }
      }
      if (question) this.questions(runtime => settleEdit(runtime, chat_id, message_id, question.revision, 'ok'))
      if (text !== undefined) this.store.rememberMessage(chat_id, message_id, { ...known, text })
      return { message_id: String(message_id) }
    })
  }
  async notifyPaired(chatId, alias, role) {
    await this.sendMessage(chatId, `Paired as ${alias} (${role}). Messages now reach the active Gelios session.`)
  }
}
export { TelegramError }
