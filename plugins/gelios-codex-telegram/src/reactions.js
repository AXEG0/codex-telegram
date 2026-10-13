// Reactions are agent-chosen durable state; startup retires legacy receipts.
// Telegram permits one ordinary reaction per bot/message. Facts from ReactionTypeEmoji.
export const REACTION_EMOJI = new Set('❤ 👍 👎 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡'.split(' '))
export class ReactionQueue {
  constructor({ store, send, authorize, log }) {
    Object.assign(this, { store, send, authorize, log }); this.running = new Map(); this.timer = null; this.stopped = false
  }
  start() { if (!this.timer) { this.stopped = false; this.retireReceipts(); this.timer = setInterval(() => this.retry(), 1000); this.timer.unref(); this.retry() } }
  stop() { this.stopped = true; clearInterval(this.timer); this.timer = null }
  retireReceipts() {
    // Never replay old automatic receipts, even for input still awaiting delivery.
    const runtime = this.store.loadRuntime(); let changed = false
    for (const event of Object.values(runtime.events)) {
      if (event.status === 'batched' && runtime.events[event.parentEventId]?.status === 'delivered') {
        Object.assign(event, { status: 'delivered', payload: null, updatedAt: Date.now() }); changed = true
      }
    }
    for (const entry of Object.values(runtime.acknowledgements || {})) {
      if (entry.kind !== 'receipt') continue
      Object.assign(entry, { kind: 'clear', emoji: null, pending: true,
        revision: (entry.revision || 0) + 1, updatedAt: Date.now() })
      delete entry.error; changed = true
    }
    if (changed) this.store.saveRuntime(runtime)
  }
  key(chatId, messageId) {
    if (!/^-?\d+$/.test(String(chatId)) || !/^\d+$/.test(String(messageId))) throw new Error('reaction requires numeric chat and message IDs')
    return `${chatId}:${messageId}`
  }
  desired(chatId, messageId, emoji) {
    const key = this.key(chatId, messageId), runtime = this.store.loadRuntime()
    runtime.acknowledgements ||= {}
    const previous = runtime.acknowledgements[key]
    if (previous?.emoji === emoji && previous.kind === 'explicit') return key
    runtime.acknowledgements[key] = { chatId: String(chatId), messageId: String(messageId), emoji, kind: 'explicit', eventId: null,
      revision: (previous?.revision || 0) + 1, pending: true, updatedAt: Date.now() }
    this.store.saveRuntime(runtime)
    void this.flush(key).catch(() => {})
    return key
  }
  async explicit(chatId, messageId, emoji) {
    if (emoji !== '' && !REACTION_EMOJI.has(emoji)) throw new Error('unsupported Telegram reaction emoji')
    this.authorize(chatId)
    const key = this.desired(chatId, messageId, emoji || null)
    await this.flush(key)
    const saved = this.store.loadRuntime().acknowledgements?.[key]
    if (saved?.pending || saved?.error) throw new Error(saved?.error || 'reaction is pending retry')
    return { message_id: String(messageId), emoji }
  }
  retry() {
    for (const [key, entry] of Object.entries(this.store.loadRuntime().acknowledgements || {})) {
      if (entry.pending) void this.flush(key).catch(() => {})
    }
  }
  flush(key) {
    if (this.running.has(key)) return this.running.get(key)
    const task = (async () => {
      while (!this.stopped) {
        const entry = this.store.loadRuntime().acknowledgements?.[key]
        if (!entry?.pending) return
        try {
          this.authorize(entry.chatId)
          await this.send(entry.chatId, entry.messageId, entry.emoji, entry.kind)
          const runtime = this.store.loadRuntime(), current = runtime.acknowledgements?.[key]
          if (current?.revision === entry.revision) {
            current.pending = false; delete current.error; this.store.saveRuntime(runtime)
          }
        } catch (error) {
          const runtime = this.store.loadRuntime(), current = runtime.acknowledgements?.[key]
          if (current?.revision === entry.revision) {
            current.error = error.message
            if ([400, 403, 404].includes(error.code) || /not paired|disabled/.test(error.message)) current.pending = false
            this.store.saveRuntime(runtime)
            this.log(`reaction state=failed message=${key} kind=${entry.kind} error=${error.message}`)
          }
          throw error
        }
      }
    })().finally(() => this.running.delete(key))
    this.running.set(key, task)
    return task
  }
}
