// Question buttons: telegram_reply and telegram_edit_message put fixed answers under a message, and the
// first admitted press reaches Codex once, as input marked button=<label>; the keyboard then shows the
// choice. Label rules, keyboard shapes and press checks are ported from AXEG0/claude-telegram's
// buttons.ts. Its file lock is replaced by the bridge: every change below runs in one synchronous step
// on runtime.json, the bridge's single journal, so no two changes interleave and nothing waits for
// Telegram or Codex while one is open. A record is prepared while its send or edit is in flight, live
// once Telegram took it, uncertain when Telegram never answered, and taken once a press is accepted.
// A record that ends is deleted, so a press on it, or on an evicted one, reads as closed.
import { randomBytes } from 'node:crypto'
export const QUESTION_PREFIX = 'gcq:'
export const MAX_ROWS = 4, MAX_PER_ROW = 4, MAX_LABEL = 40, MAX_QUESTIONS = 1000, QUESTIONS_VERSION = 1
export const NOT_ON_MESSAGE = 'This button is not on its message.'
export const CLOSED = 'This question is closed.'
export const REPLACED = 'These buttons were replaced.'
export const ANSWERED = 'This question was already answered.'
const STATUSES = ['prepared', 'live', 'uncertain', 'taken']
const SHAPE = `buttons must be 1 to ${MAX_ROWS} rows of 1 to ${MAX_PER_ROW} labels`

// Why a label would not come back to Codex exactly as set, if so, as in the reference: Telegram strips or
// changes some characters, and a label goes into the input's metadata line as written, so it may not hold
// that line's delimiters.
export function labelProblem(label) {
  const points = [...label].length
  if (points < 1 || points > MAX_LABEL) return `is ${points} characters; a label is 1 to ${MAX_LABEL}`
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(label)) return 'holds a lone surrogate'
  if (/[\u0000-\u001F\u007F-\u009F]/.test(label)) return 'holds a control character'
  if (/^[ \u180E\u200B-\u200F\u2800\uFFFC\u{E0000}-\u{E007F}]*$/u.test(label)) return 'is blank once Telegram strips its invisible characters'
  if (/[^\S ]|^ | $| {2}/.test(label)) return 'holds whitespace other than single spaces between words'
  if (/[\u2028-\u202E]|[\u200E\u200F]{2}|[\u030A\u0333\u033F]/.test(label)) return 'holds a character Telegram changes (U+2028 to U+202E, two or more of U+200E and U+200F in a row, U+030A, U+0333 or U+033F)'
  if (/["<>[\];=]/.test(label)) return 'holds a double quote, an angle bracket, a square bracket, a semicolon or an equals sign'
  return undefined
}
// The rows a call asked for. A reply's buttons are never empty; an edit's empty list removes them.
export function parseButtons(input, allowEmpty) {
  if (!Array.isArray(input)) throw new Error(SHAPE)
  if (!input.length) { if (allowEmpty) return []; throw new Error(`${SHAPE}; an empty list is refused`) }
  if (input.length > MAX_ROWS) throw new Error(SHAPE)
  const seen = new Set()
  for (const row of input) {
    if (!Array.isArray(row) || row.length < 1 || row.length > MAX_PER_ROW) throw new Error(SHAPE)
    for (const label of row) {
      if (typeof label !== 'string') throw new Error(`${SHAPE}, each a string`)
      const problem = labelProblem(label)
      if (problem) throw new Error(`button label ${JSON.stringify(label)} ${problem}`)
      if (seen.has(label)) throw new Error(`button label ${JSON.stringify(label)} appears twice; labels differ across the keyboard`)
      seen.add(label)
    }
  }
  return input.map(row => [...row])
}
// Callback data names the question record, its revision and the button's place, never the label,
// so it stays far inside Telegram's 64 bytes.
export const questionData = (id, revision, index) => `${QUESTION_PREFIX}${id}:${revision}:${index}`
export function parseQuestionData(data) {
  const match = /^gcq:([a-f0-9]{16}):([1-9][0-9]{0,8}):([0-9]{1,2})$/.exec(String(data ?? ''))
  return match ? { id: match[1], revision: Number(match[2]), index: Number(match[3]) } : null
}
export function keyboardOf(rows, id, revision) {
  let index = 0
  return { inline_keyboard: rows.map(row => row.map(text => ({ text, callback_data: questionData(id, revision, index++) }))) }
}
// One disabled button showing the choice.
export const chosenKeyboard = label => ({ inline_keyboard: [[{ text: label, disabled: {} }]] })
// The text of the button with this data on the message's own keyboard; undefined when Telegram returned
// the press without that keyboard, as for a button written into a message's body.
export function onKeyboard(message, data) {
  for (const row of message?.reply_markup?.inline_keyboard ?? []) {
    if (!Array.isArray(row)) continue
    for (const button of row) if (button?.callback_data === data && typeof button.text === 'string') return button.text
  }
  return undefined
}
// A 400 refusing the keyboard itself: the call fails at once, with no plain copy without buttons.
export const keyboardRefused = error => error?.code === 400 && /button|keyboard|reply markup|reply_markup/i.test(error?.message ?? '')
// Telegram answered: the call is settled either way. Without an answer (a timeout, a lost connection)
// it may still have landed, so its outcome is unknown.
// A 5xx may come from a proxy after the request reached Telegram, so it counts as no answer.
export const answered = error => error?.name === 'TelegramError' && error.code >= 400 && error.code < 500
export const messageGone = error => error?.code === 400 && /message to edit not found|message not found/i.test(error?.message ?? '')
export const notModified = error => /message is not modified/i.test(error?.message ?? '')

// The question journal inside runtime.json: { version, records }. A newer version is refused, never reset.
export function questionsOf(runtime) {
  const value = runtime.questions
  if (value === undefined) return (runtime.questions = { version: QUESTIONS_VERSION, records: {} })
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.records !== 'object' || !value.records) throw new Error('question journal is corrupt; refusing to continue')
  if (value.version > QUESTIONS_VERSION) throw new Error(`question journal version ${value.version} is newer than this build reads (${QUESTIONS_VERSION}); refusing to continue`)
  for (const [id, record] of Object.entries(value.records)) {
    if (!record || record.id !== id || typeof record.chatId !== 'string' || !Number.isInteger(record.revision) || !STATUSES.includes(record.status)) throw new Error('question journal is corrupt; refusing to continue')
  }
  return value
}
// An answered question whose input event has not reached Codex holds its slot; nothing evicts it.
const protectedRecord = (runtime, record) => {
  const event = record.status === 'taken' ? runtime.events[record.answer?.eventId] : undefined
  return Boolean(event) && event.status !== 'delivered' && event.retryable !== false
}
// Room for one more record: answered questions already delivered go first, then the oldest open ones,
// whose later presses are refused as closed. A send or edit in flight is never evicted.
export function makeRoom(runtime) {
  const { records } = questionsOf(runtime)
  const all = Object.values(records)
  if (all.length < MAX_QUESTIONS) return
  const evictable = all.filter(record => record.status !== 'prepared' && !protectedRecord(runtime, record))
    .sort((a, b) => (a.status === 'taken' ? 0 : 1) - (b.status === 'taken' ? 0 : 1) || a.updatedAt - b.updatedAt)
  if (all.length - evictable.length >= MAX_QUESTIONS) throw new Error(`all ${MAX_QUESTIONS} question slots hold answers still being delivered or sends in flight; nothing was sent`)
  for (const record of evictable.slice(0, all.length - MAX_QUESTIONS + 1)) delete records[record.id]
}
export const recordFor = (runtime, chatId, messageId) => Object.values(questionsOf(runtime).records)
  .find(record => record.chatId === String(chatId) && record.messageId === String(messageId)) || null

// A new question, recorded before the call that sends its keyboard. An edit that adds buttons to a
// message without them names the message at once; a reply's message is bound once Telegram returns it.
export function openQuestion(runtime, { chatId, threadId, messageId, rows }) {
  makeRoom(runtime)
  const now = Date.now(), id = randomBytes(8).toString('hex')
  return (questionsOf(runtime).records[id] = { id, chatId: String(chatId), ...(threadId ? { threadId: String(threadId) } : {}),
    ...(messageId ? { messageId: String(messageId) } : {}), revision: 1, rows, status: 'prepared', previous: null, createdAt: now, updatedAt: now })
}
// An edit that sets, replaces or removes a message's keyboard: a new revision before the call, so every
// earlier keyboard is replaced at once; what was there comes back only if Telegram refuses the edit.
export function reviseQuestion(record, rows) {
  const { revision, rows: was, status, answer, swap } = record
  Object.assign(record, { previous: { revision, rows: was, status, answer, swap }, revision: revision + 1, rows, status: 'prepared', swap: undefined, updatedAt: Date.now() })
  return record
}
// A reply's send ended: sent binds the message, refused ends the record, unknown leaves it for a press to
// bind. A press that already took the record keeps it.
export function settleSend(runtime, id, outcome, messageId) {
  const records = questionsOf(runtime).records, record = records[id]
  if (record?.status !== 'prepared') return
  if (outcome === 'sent') Object.assign(record, { messageId: String(messageId), status: 'live', updatedAt: Date.now() })
  else if (outcome === 'unknown') Object.assign(record, { status: 'uncertain', updatedAt: Date.now() })
  else delete records[id]
}
// An edit ended. Only the revision it set is settled, and only while no press took it.
export function settleEdit(runtime, chatId, messageId, revision, outcome) {
  const records = questionsOf(runtime).records, record = recordFor(runtime, chatId, messageId)
  if (!record || record.revision !== revision) return
  if (outcome === 'gone') { delete records[record.id]; return }
  if (record.status !== 'prepared') return
  if (outcome === 'refused') {
    if (record.previous?.rows?.length || record.previous?.status === 'taken') Object.assign(record, record.previous, { previous: null, updatedAt: Date.now() })
    else delete records[record.id]
  } else if (outcome === 'unknown') Object.assign(record, { status: 'uncertain', previous: null, updatedAt: Date.now() })
  else if (record.rows.length) Object.assign(record, { status: 'live', previous: null, updatedAt: Date.now() })
  else delete records[record.id]
}
// The judgment of a press, made in the same step that commits it. True when the press is the first
// accepted answer: the record is taken and the caller writes the answer's input event in this step.
// Otherwise the text the press is answered with. A press can bind a reply or edit whose outcome is not
// known yet only with the record's own chat, message, revision and label.
export function takeQuestion(runtime, press) {
  const record = questionsOf(runtime).records[press.id]
  if (!record) return CLOSED
  if (record.chatId !== press.chatId || (record.messageId && record.messageId !== press.messageId)) return NOT_ON_MESSAGE
  // A question not yet bound to its message never takes one another question already names, so one message
  // never holds two open questions and never collects two answers.
  if (!record.messageId && recordFor(runtime, press.chatId, press.messageId)) return NOT_ON_MESSAGE
  if (record.threadId && record.threadId !== String(press.threadId ?? '')) return NOT_ON_MESSAGE
  if (record.revision !== press.revision) return REPLACED
  if (record.status === 'taken') return ANSWERED
  if (record.rows.flat()[press.index] !== press.label) return NOT_ON_MESSAGE
  Object.assign(record, { messageId: press.messageId, status: 'taken', rows: undefined, previous: null, swap: true, updatedAt: Date.now(),
    answer: { label: press.label, senderId: press.senderId, eventId: press.eventId, at: Date.now() } })
  return true
}
// The keyboard now shows the choice, or can no longer be changed.
export function swapDone(runtime, id, revision) {
  const record = questionsOf(runtime).records[id]
  if (record?.status === 'taken' && record.revision === revision) delete record.swap
}
// After a restart no send or edit is in flight, so one still prepared has an unknown outcome.
export function settleInterrupted(runtime) {
  for (const record of Object.values(questionsOf(runtime).records)) if (record.status === 'prepared') Object.assign(record, { status: 'uncertain', previous: null })
}
