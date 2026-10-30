// One destination policy for every Telegram path: input, edits, reactions, button presses, attachment
// recovery and each outgoing call. Private chats belong to paired numeric users; groups are only those
// the owner added locally, by signed numeric chat ID. Every check here is read-only: nothing an incoming
// event carries can pair a sender or widen access. Group rules follow AXEG0/claude-telegram's ACCESS.md.
export const ACCESS_VERSION = 2
export const CHAT_ID = /^-?[1-9][0-9]*$/
export const USER_ID = /^[1-9][0-9]*$/
// A bot's username: letters, digits and underscores, ending in "bot" (Telegram's rule).
export const BOT_USERNAME = /^[A-Za-z0-9_]{2,29}bot$/i
// Telegram's own service account, which posts on behalf of channels and Telegram itself.
const SERVICE_USER = '777000'
const policyError = message => Object.assign(new Error(message), { permanent: true })
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Reads access.json in any supported version. Version 1 files gain the version 2 keys in memory, so
// a build that predates them still reads what this one writes; a newer version is refused, never reset.
export function normalizeAccess(raw) {
  if (!plainObject(raw)) throw new Error('access state is not an object; refusing to continue')
  const version = raw.version ?? 1
  if (!Number.isInteger(version) || version < 1) throw new Error('access state has an invalid version; refusing to continue')
  if (version > ACCESS_VERSION) throw new Error(`access state version ${version} is newer than this build reads (${ACCESS_VERSION}); refusing to continue`)
  if (!['pairing', 'allowlist', 'disabled'].includes(raw.dmPolicy)) throw new Error('access state contains an invalid dmPolicy; refusing to continue')
  const access = { ...raw, version: ACCESS_VERSION, users: plainObject(raw.users) ? raw.users : {}, pending: plainObject(raw.pending) ? raw.pending : {},
    groups: plainObject(raw.groups) ? raw.groups : {}, mentionPatterns: Array.isArray(raw.mentionPatterns) ? raw.mentionPatterns : [] }
  return access
}

// Whether a group admits this sender: no list, or an empty one, admits every member; a list admits only
// the numeric IDs on it, and a list in any other shape admits nobody.
export function memberAllowed(group, senderId) {
  const list = group?.allowFrom
  if (list == null || (Array.isArray(list) && !list.length)) return true
  return Array.isArray(list) && list.some(entry => String(entry) === String(senderId))
}

// A message counts as a mention when it names the bot in an entity, replies to one of the bot's own
// messages, or matches one of the owner's case-insensitive patterns. A forum topic's first message,
// which every message in the topic replies to, is not a reply to the bot.
export function isMentioned(message, { botId, botUsername, patterns = [] } = {}) {
  const text = message?.text ?? message?.caption ?? ''
  const name = botUsername ? `@${String(botUsername).toLowerCase()}` : null
  for (const entity of message?.entities ?? message?.caption_entities ?? []) {
    if (entity?.type === 'mention' && name && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === name) return true
    if (entity?.type === 'text_mention' && botId && String(entity.user?.id) === String(botId)) return true
  }
  const parent = message?.reply_to_message
  if (parent && !parent.forum_topic_created && botId && String(parent.from?.id) === String(botId)) return true
  for (const pattern of patterns) {
    try { if (new RegExp(pattern, 'i').test(text)) return true } catch {}
  }
  return false
}

// The verified route of an admitted group message: chat, topic and sender, or null when the group, the
// sender or the mention rule does not let it through. Only a real user counts: a message sent as a chat
// (an anonymous admin or a channel carries sender_chat, from Telegram's stand-in bot), a bot, Telegram's
// service account or a message without a sender is never mapped to anyone.
export function admitGroupMessage(access, message, { mention = true, ...bot } = {}) {
  if (access.dmPolicy === 'disabled') return null
  const chat = message?.chat; const from = message?.from
  if (!['group', 'supergroup'].includes(chat?.type) || !CHAT_ID.test(String(chat.id))) return null
  if (message.sender_chat || !from || from.is_bot === true || !USER_ID.test(String(from.id)) || String(from.id) === SERVICE_USER) return null
  const group = Object.hasOwn(access.groups, String(chat.id)) ? access.groups[String(chat.id)] : null
  if (!plainObject(group) || !memberAllowed(group, from.id)) return null
  if (mention && group.requireMention !== false && !isMentioned(message, { ...bot, patterns: access.mentionPatterns })) return null
  return { kind: 'group', chatId: String(chat.id), senderId: String(from.id), group,
    ...(message.is_topic_message && Number.isInteger(message.message_thread_id) ? { threadId: String(message.message_thread_id) } : {}) }
}

// Whether a paired private sender is admitted from this chat now, without the pairing side effects.
export function admitPrivate(access, from, chat) {
  if (access.dmPolicy === 'disabled' || chat?.type !== 'private' || !from || !USER_ID.test(String(from.id))) return null
  const user = Object.hasOwn(access.users, String(from.id)) ? access.users[String(from.id)] : null
  if (!plainObject(user) || String(user.chatId) !== String(chat.id)) return null
  return { kind: 'private', chatId: String(chat.id), senderId: String(from.id), user }
}

// The destination of an outgoing call, checked before each call: a paired user's private chat or an
// added group. Anything else, or any destination while access is disabled, is refused.
export function destination(access, chatId) {
  const id = String(chatId ?? '')
  if (!CHAT_ID.test(id)) throw policyError('Telegram chat_id must be a numeric chat ID')
  if (access.dmPolicy === 'disabled') throw policyError('Telegram access is disabled')
  const found = Object.entries(access.users).find(([, user]) => plainObject(user) && String(user.chatId) === id)
  if (found) return { kind: 'private', chatId: id, userId: found[0], user: found[1] }
  if (Object.hasOwn(access.groups, id) && plainObject(access.groups[id])) return { kind: 'group', chatId: id, group: access.groups[id] }
  throw policyError('Telegram destination is not paired')
}

// Whether the sender recorded on queued input or an attachment may still use that chat: the same pairing
// for a private chat, and the same group membership, without a mention, for a group.
export function senderAdmitted(access, chatId, senderId) {
  let route; try { route = destination(access, chatId) } catch { return false }
  return route.kind === 'private' ? String(route.userId) === String(senderId) : memberAllowed(route.group, senderId)
}
