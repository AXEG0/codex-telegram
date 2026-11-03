// Every member is journaled before this window; the adapter publishes atomically. A burst is one chat,
// one topic and one sender, so a batch never mixes them.
export class BurstBatcher {
  constructor({ publish, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { publish, now, setTimer, clearTimer }); this.current = null; this.timer = null; this.closed = false; this.tail = Promise.resolve()
  }
  pending() { return Boolean(this.current) }
  key(event) { return `${event.chatId}:${event.threadId || ''}:${event.userId}` }
  gap(event) {
    if (event.edited) return 0
    const m = event.rawMessage || {}
    const bot = m.from?.is_bot === true
    if (m.photo?.length || m.document) return bot ? 3000 : 500
    if (['voice', 'audio', 'video', 'video_note', 'animation', 'sticker'].some(key => m[key])) return 0
    if (!m.text || (!bot && m.text.startsWith('/'))) return 0
    return m.text.length >= 4000 ? 1500 : 300
  }
  add(event) {
    const gap = this.gap(event), key = this.key(event)
    const reply = event.rawMessage?.reply_to_message?.message_id || null, chars = event.text?.length || 0
    // A bot's following text may omit the album's reply target. Preserve its
    // context, but never combine conflicting explicit targets or human replies.
    const changedReply = this.current && (event.rawMessage?.from?.is_bot === true
      ? reply && this.current.events.some(item => { const other = item.rawMessage?.reply_to_message?.message_id; return other && other !== reply })
      : this.current.reply !== reply)
    if (this.current && (this.current.key !== key || changedReply || this.current.chars + chars > 50_000 || !gap)) void this.flush().catch(() => {})
    if (!gap || this.closed) return this.publishTracked([event])
    if (!this.current) this.current = { key, reply, first: this.now(), chars: 0, events: [] }
    if (this.current.events.some(item => item.eventId === event.eventId)) return
    this.current.events.push(event); this.current.chars += chars
    if (this.current.events.length >= 12) return this.flush()
    this.clearTimer(this.timer)
    this.timer = this.setTimer(() => { void this.flush().catch(() => {}) }, Math.max(0, Math.min(gap, this.current.first + 7500 - this.now())))
    this.timer?.unref?.()
  }
  flush() {
    this.clearTimer(this.timer); this.timer = null
    const current = this.current; this.current = null
    return current ? this.publishTracked(current.events) : this.tail
  }
  publishTracked(events) {
    // Publication enters the controller synchronously, ahead of later TUI input.
    // Its completion also waits for any earlier publication still preparing media.
    const previous = this.tail.catch(() => {})
    let delivery; try { delivery = Promise.resolve(this.publish(events)) } catch (error) { delivery = Promise.reject(error) }
    this.tail = Promise.all([previous, delivery]).then(() => undefined)
    return this.tail
  }
  stop() { this.closed = true; this.clearTimer(this.timer); this.timer = null; this.current = null }
}
