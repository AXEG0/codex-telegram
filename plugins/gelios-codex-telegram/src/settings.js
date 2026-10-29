// The owner's optional channel settings in config.json, each set only through the local access controller.
// Delivery settings are checked before a reply sends anything; an invalid one refuses the reply. The keys
// follow AXEG0/claude-telegram's delivery settings, with Codex's existing defaults kept.
import { REACTION_EMOJI } from './reactions.js'
import { transcriptionPlan } from './transcription.js'
export const FORMATS = ['rich', 'text', 'markdownv2']
export const MAX_CHUNK = 4096
const CHECKS = {
  replyToMode: [value => ['first', 'all', 'off'].includes(value), 'first, all or off'],
  textChunkLimit: [value => Number.isInteger(value) && value >= 1 && value <= MAX_CHUNK, `a whole number from 1 to ${MAX_CHUNK}`],
  chunkMode: [value => ['newline', 'length'].includes(value), 'newline or length'],
  receiptReaction: [value => value === '' || REACTION_EMOJI.has(value), 'a supported Telegram reaction emoji, or off for none'],
  accessMode: [value => ['dynamic', 'static'].includes(value), 'dynamic or static'],
  inboxRetentionHours: [value => Number.isFinite(value) && value > 0 && value <= 24 * 30, 'hours from above 0 to 720'],
  transcriptionModel: [value => typeof value === 'string', 'a transcription model name'],
  transcriptionLanguages: [value => Array.isArray(value), 'a list of language codes'],
  // Typing and alerts (alerts.js): the stuck and idle notices' minutes, and the owner's private chat for the idle
  // notice and a paired bot's notices; local-setup.js checks that chat against the policy when it is set.
  stuckMinutes: [value => Number.isFinite(value) && value > 0 && value <= 10_080, 'minutes from above 0 to 10080'],
  idleMinutes: [value => Number.isFinite(value) && value > 0 && value <= 10_080, 'minutes from above 0 to 10080'],
  alertChat: [value => value === '' || /^[1-9][0-9]*$/.test(value), "the owner's numeric private chat ID, or off for none"],
}
export const SETTING_KEYS = Object.keys(CHECKS)
// The format a reply or edit asked for: rich by default, else exactly one of FORMATS; any other value,
// null included, is refused before anything is sent.
export function formatOf(value, undone) {
  if (value === undefined) return 'rich'
  if (FORMATS.includes(value)) return value
  throw new Error(`format ${JSON.stringify(value)} is not one of ${FORMATS.join(', ')}, so ${undone}`)
}
const DEFAULTS = { replyToMode: 'first', textChunkLimit: MAX_CHUNK, chunkMode: 'newline', receiptReaction: '', accessMode: 'dynamic' }
// The delivery settings in force, or an error naming the first invalid one.
export function deliverySettings(config = {}) {
  const settings = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) if (config[key] !== undefined) {
    if (!CHECKS[key][0](config[key])) throw new Error(`channel config ${key} must be ${CHECKS[key][1]}; nothing was sent`)
    settings[key] = config[key]
  }
  return settings
}
// The value a local `set KEY VALUE` command stores: numbers and lists are parsed, the rest stays text.
export function parseSetting(key, raw) {
  if (!Object.hasOwn(CHECKS, key)) throw new Error(`unknown setting ${key}; settings are ${SETTING_KEYS.join(', ')} and mentionPatterns`)
  let value = raw
  if (['textChunkLimit', 'inboxRetentionHours', 'stuckMinutes', 'idleMinutes'].includes(key)) value = Number(raw)
  if (key === 'transcriptionLanguages') value = raw.split(',').map(code => code.trim()).filter(Boolean)
  if (['receiptReaction', 'alertChat'].includes(key) && ['off', '""', "''"].includes(raw)) value = ''
  if (!CHECKS[key][0](value)) throw new Error(`${key} must be ${CHECKS[key][1]}`)
  return value
}
// A config whose transcription model and languages fit together; checked when either one is set.
export function checkTranscription(config) {
  transcriptionPlan({ model: config.transcriptionModel, languages: config.transcriptionLanguages })
}
// The owner's mention patterns: at most 16 case-insensitive regular expressions, none longer than 200 characters.
export function parsePatterns(raw) {
  let patterns
  try { patterns = JSON.parse(raw) } catch { throw new Error('mentionPatterns takes a JSON list of patterns') }
  if (!Array.isArray(patterns) || patterns.length > 16 || patterns.some(item => typeof item !== 'string' || !item || item.length > 200)) {
    throw new Error('mentionPatterns takes a JSON list of at most 16 patterns of 1 to 200 characters')
  }
  for (const pattern of patterns) try { new RegExp(pattern, 'i') } catch (error) { throw new Error(`mention pattern ${JSON.stringify(pattern)} is invalid: ${error.message}`) }
  return patterns
}
