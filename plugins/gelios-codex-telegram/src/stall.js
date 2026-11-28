// Codex's Telegram sends of unknown outcome, and the one event that names them once Telegram answers again (#88,
// after the design of AXEG0/claude-telegram's issue 112). Telegram's cloud Bot API can leave one bot's calls
// unanswered for minutes to an hour, a 502 after about 15 s or no answer at all, while other bots work; a reply or
// edit sent then may or may not have arrived, and nothing else tells Codex when Telegram answers again.
//
// The record holds each telegram_reply and telegram_edit_message call of Codex's own whose request left and got a
// 5xx or no answer. The bridge's notices and Codex's async messages keep the notice journal's retries and never join
// it. It closes on the first write Telegram answers, ok or with a 4xx of its own, that left after the last of its
// sends ended. Polls and reads never open, hold or close it: polls have answered while sends still failed, and a
// reply looks a chat up before it sends. While it is open, setMyCommands goes as a probe a minute after it opened and
// a minute after each probe settles, so a conversation that writes nothing still gets its event. The record lives in
// memory, so a restart loses it; its event, once journaled, is delivered as any journaled input is.
export const STALL_EVENT = 'telegram_stall'
export const PROBE_MS = 60_000
// Calls that send or change nothing.
export const READS = new Set(['getUpdates', 'getMe', 'getFile', 'getChat', 'getChatMember'])
const iso = ms => new Date(ms).toISOString()
export class StallRecord {
  // probe() makes the probe's call; closed(record) gets { since, until, entries, by, probe } once the record closes.
  constructor({ probe, closed, log = () => {} }) {
    Object.assign(this, { probe, closed, log })
    this.entries = []; this.since = null; this.last = 0; this.timer = null; this.probing = false; this.stopped = false; this.probeMs = PROBE_MS
  }
  // A send of unknown outcome, with began and ended as its handler took them and after, how many calls had left by
  // its end. It opens the record or joins it; the result is the record's since, the earliest start among its sends.
  add(entry) {
    const opened = !this.entries.length
    this.entries.push(entry); this.since = Math.min(this.since ?? entry.began, entry.began); this.last = Math.max(this.last, entry.after)
    if (opened) { this.log(`telegram: stall record opened: since=${iso(this.since)}; by ${described(entry)}`); this.schedule() }
    return this.since
  }
  // Every call that left, once it settled: order is its place among the calls that left, at when it settled.
  settled(call) {
    if (!this.entries.length || !call.answered || READS.has(call.method) || call.order <= this.last) return
    const record = { since: this.since, until: call.at, entries: this.entries, by: call.method, probe: call.probe === true }
    this.entries = []; this.since = null; clearTimeout(this.timer); this.timer = null
    this.closed(record)
  }
  schedule() {
    if (this.timer || this.probing || this.stopped || !this.entries.length) return
    this.timer = setTimeout(() => {
      this.timer = null; this.probing = true
      Promise.resolve().then(() => this.probe()).catch(() => {}).finally(() => { this.probing = false; this.schedule() })
    }, this.probeMs)
    this.timer.unref()
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null }
}
// One send as the bridge log names it: no words, only where it went and when its handler began and ended.
function described(entry) {
  const what = entry.kind === 'edit' ? `edit of message ${entry.messageId} in chat ${entry.chatId}` : `reply to chat ${entry.chatId}`
  return `${what} began ${iso(entry.began)} ended ${iso(entry.ended)}`
}
// The close line's values: the record's bounds, the write whose answer closed it and each send its event names.
export const stallBounds = record => `since=${iso(record.since)}; until=${iso(record.until)}; closed by ${record.by}${record.probe ? ' (probe)' : ''}; ${record.entries.map(described).join('; ')}`
// The event's text. Each line after the first shows only when it has an entry.
export function stallText({ since, until, entries }) {
  const reply = entry => `chat ${entry.chatId} at ${iso(entry.began)}: "${entry.words}"${entry.files ? ` with ${entry.files} file${entry.files === 1 ? '' : 's'}` : ''}${entry.sent ? `, after ${entry.sent} of its Telegram messages were sent` : ''}`
  const line = (head, items, tail) => items.length ? [`${head}: ${items.join('; ')}. ${tail}`] : []
  const replies = entries.filter(entry => entry.kind !== 'edit')
  return [
    `Telegram left these sends of this bot unanswered from ${iso(since)} and answered a write begun after them at ${iso(until)}. Telegram says it keeps a bot's updates up to 24 hours and gives no sign when a message it held will come, so messages sent to this bot in the 24 hours before this note may still arrive, each with its own send time; ${iso(until)} is when Telegram answered this bot's writes again, not when messages to it stopped waiting.`,
    ...line('To people, delivery unknown', replies.filter(entry => !entry.toBot && !entry.card).map(reply), 'Send again what still matters, its first line saying it may repeat an earlier message; for what went stale, send a short note that it replaces any earlier copy.'),
    ...line('To bots, delivery unknown', replies.filter(entry => entry.toBot).map(reply), 'Ask that bot whether it arrived, and send it again only if it says no.'),
    ...line('Cards, delivery unknown', replies.filter(entry => entry.card).map(reply), 'Its buttons still count if it arrived. If a press on it has reached you, there is nothing to send. Otherwise, if it went stale, send a short note that it replaces any earlier copy; if it still matters, send its text again without buttons, its first line saying it may repeat an earlier message, and ask for the answer in words or on the earlier copy\'s buttons. If its reader says the earlier copy never came, send it again with buttons, as today.'),
    ...line('Edits, outcome unknown', entries.filter(entry => entry.kind === 'edit').map(entry => `chat ${entry.chatId}, message ${entry.messageId} at ${iso(entry.began)}`), 'Repeat each as it stands.'),
  ].join('\n')
}
