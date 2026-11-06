#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { installLaunchers } from '../src/bootstrap.js'
import { defaultStateDir } from '../src/core.js'
import { followMcpBuild } from '../src/mcp-lifecycle.js'
import { requestControl as requestBridge } from '../src/control.js'
import { telegramInstructions as instructions } from '../src/telegram-guidance.js'
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const controlSocket = process.env.GELIOS_TELEGRAM_CONTROL_SOCKET || join(defaultStateDir(), 'control.sock')
// Native configuration keeps this namespace out of deferred tool discovery.
// Channel envelopes retain the same canonical delivery contract for recovery.
const FORMAT = { type: 'string', enum: ['rich', 'text', 'markdownv2'],
  description: "Optional rendering. 'rich' (default) sends GitHub Markdown as a Telegram rich message; 'text' is plain text as written; 'markdownv2' uses Telegram MarkdownV2, whose special characters the caller escapes. Any other value sends nothing. A paired bot always gets plain text." }
const ROWS = { type: 'array', items: { type: 'array', items: { type: 'string' } } }
const tools = [
  {
    name: 'telegram_react', title: 'React on Telegram',
    description: 'Set an ordinary emoji reaction on a message in a paired private chat or added group. Use chat_id and message_id from trusted Telegram metadata. An empty emoji removes the bot reaction. Unsupported Telegram reaction emoji are rejected.',
    inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' }, emoji: { type: 'string' } },
      required: ['chat_id', 'message_id', 'emoji'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'telegram_edit_message', title: 'Edit a Telegram reply',
    description: 'Edit one message recorded as sent by this bot in a paired chat or added group: its text, its question buttons, or both. Markdown renders as in telegram_reply unless format says otherwise. The text must fit one rich message. Editing does not send a new notification. Text on a file whose caption holds a reply\'s text edits that caption, 1 to 1024 characters; text on a file with no text is refused, and nothing is edited.',
    inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' },
        text: { type: 'string', description: 'Replacement text. Text without buttons also removes the message\'s buttons.' }, format: FORMAT,
        buttons: { ...ROWS, description: 'Replacement question buttons, as in telegram_reply. Buttons without text keep the text; an empty list removes the buttons. Give text, buttons or both.' } },
      required: ['chat_id', 'message_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'telegram_reply', title: 'Reply on Telegram',
    description: 'Send a message chosen by Codex to a paired private Telegram chat or an added group. Use chat_id, and optionally reply_to and message_thread_id, from trusted Telegram message metadata. Files must be in the active workspace or the session inbox/outbox. With files, the answer also says what each message holds: text, a file, or a file with a text caption.',
    inputSchema: { type: 'object', properties: {
        chat_id: { type: 'string', description: 'Paired private chat ID or added group chat ID from inbound Telegram metadata.' },
        text: { type: 'string', description: 'GitHub Markdown message text, sent as a Telegram rich message (tables, headings, task lists, code, details). Long text is split between blocks; a paired bot gets the text as written.' },
        reply_to: { type: 'string', description: 'Optional inbound Telegram message_id for native threading.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional absolute paths, at most ten. To bots, files go first as documents (an album for multiple files), with short text in a caption or longer text after. To people and groups, images use photo previews and other files are documents. Documents: 50 MiB each; photos: 10 MiB.' },
        format: FORMAT,
        message_thread_id: { type: 'string', description: 'Optional group topic ID from inbound message_thread_id metadata; the reply stays in that topic.' },
        buttons: { ...ROWS, description: 'Optional question buttons under the reply\'s last message: 1 to 4 rows of 1 to 4 distinct labels, each 1 to 40 characters. The first admitted press arrives as input marked button=<label>, and the buttons then show the choice. Refused for a paired bot.' },
      }, required: ['chat_id', 'text'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'telegram_download_attachment', title: 'Download Telegram attachment',
    description: 'Recover one authorized Telegram attachment, including a retained photo after compaction, into the owner-only session inbox. Pass only attachment_file_id from trusted inbound metadata; fabricated or expired handles are rejected.',
    inputSchema: { type: 'object',
      properties: { attachment_file_id: { type: 'string', description: 'Opaque attachment_file_id from an inbound Telegram message.' } },
      required: ['attachment_file_id'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
]
const pending = new Map()
const requestKey = id => `${typeof id}:${String(id)}`
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`) }
function controlRequest(action, args, signal, timeoutMs = 60_000) {
  // Retry only a refused/missing connection, before any request can be accepted.
  // A lost response is ambiguous and is never replayed.
  return requestBridge(controlSocket, action, args, { signal, timeoutMs, connectWaitMs: Math.min(10_000, timeoutMs) })
    .catch(error => { throw error.refused ? error : new Error(`Gelios Telegram bridge is unavailable: ${error.message}`) })
}
// The printed label of each value the bridge stores for what a sent message holds.
const HOLDS = { text: 'text', file: 'file', caption: 'file with text caption' }
// Optional arguments need a bridge that honors them: an older bridge would drop them and send anyway.
// A bridge without the capabilities action predates every optional argument.
const OPTIONAL = { format: 'format', message_thread_id: 'topics', buttons: 'buttons' }
// Asked on each such call, since the bridge can restart on another version while this client runs.
async function requireFeatures(args, signal) {
  const needed = Object.entries(OPTIONAL).filter(([name]) => args[name] !== undefined).map(([, feature]) => feature)
  if (!needed.length) return
  let features
  try { features = (await controlRequest('capabilities', {}, signal)).features || [] } catch (error) {
    if (!/unknown bridge action/.test(error.message)) throw error
    features = []
  }
  const missing = needed.filter(feature => !features.includes(feature))
  if (missing.length) throw new Error(`the running Telegram bridge does not support ${missing.join(', ')}; nothing was sent. Restart the bridge on this plugin version to use it.`)
}
async function callTool(name, args, signal) {
  if (['telegram_reply', 'telegram_edit_message'].includes(name)) await requireFeatures(args, signal)
  if (name === 'telegram_react') {
    const result = await controlRequest('react', args, signal)
    return `Telegram reaction updated for message ${result.message_id}`
  }
  if (name === 'telegram_edit_message') {
    const result = await controlRequest('edit_message', args, signal)
    return `Telegram message edited: ${result.message_id}${result.caption === true ? '; its caption holds the new text' : ''}`
  }
  if (name === 'telegram_reply') {
    // Leave room for every upload in an album; the HTTP layer budgets each file.
    const count = Array.isArray(args.files) ? args.files.length : 0
    const result = await controlRequest('reply', args, signal, 60_000 * Math.max(1, Math.min(10, count)))
    const ids = result.message_ids || [], sent = `Telegram sent message IDs: ${ids.join(', ')}; event=${result.event_id}; time=${result.timestamp}`
    // A reply with files says what each message holds, when the bridge says it for every message; an older bridge does not.
    if (!count || !Array.isArray(result.holds) || result.holds.length !== ids.length) return sent
    return `${sent}; what each holds: ${ids.map((id, index) => `${id} ${HOLDS[result.holds[index]]}`).join(', ')}`
  }
  if (name === 'telegram_download_attachment') {
    const result = await controlRequest('download_attachment', args, signal)
    return result.path
  }
  throw new Error(`unknown tool: ${name}`)
}
async function handle(message) {
  if (!message || typeof message !== 'object') return
  if (message.method === 'notifications/cancelled') { pending.get(requestKey(message.params?.requestId))?.abort(); return }
  if (message.method === 'notifications/initialized') return
  if (message.id === undefined) return
  try {
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0', id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'telegram', version },
          instructions,
        },
      })
      return
    }
    if (message.method === 'ping') return send({ jsonrpc: '2.0', id: message.id, result: {} })
    if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools } })
    if (message.method === 'tools/call') {
      const controller = new AbortController(); pending.set(requestKey(message.id), controller)
      try {
        const text = await callTool(message.params?.name, message.params?.arguments || {}, controller.signal)
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } })
      } catch (error) { send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: error.message }], isError: true } })
      } finally { pending.delete(requestKey(message.id)) }
      return
    }
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
  } catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } }) }
}
// Native MCP starts with an allowlist. Retrieve only the bridge's already-filtered
// environment over its owner-only socket; ordinary standalone MCP startup needs no bridge.
if (process.env.GELIOS_TELEGRAM_CONTROL_SOCKET) {
  try { Object.assign(process.env, await controlRequest('runtime_environment', {}, undefined, 1000)) }
  catch (error) { process.stderr.write(`Codex Telegram environment: ${error.message}\n`) }
}
try { installLaunchers() } catch (error) { process.stderr.write(`Codex Telegram launcher: ${error.message}\n`) }
const input = readline.createInterface({ input: process.stdin })
const selected = process.env.GELIOS_TELEGRAM_MCP_ROOT
if (selected && lstatSync(selected).isSymbolicLink()) {
  followMcpBuild(defaultStateDir(), selected, realpathSync(fileURLToPath(new URL('../', import.meta.url))),
    () => pending.size === 0, () => { input.close(); process.stdin.destroy(); process.stdout.end(() => process.exit(0)) })
}
input.on('close', () => { for (const controller of pending.values()) controller.abort() })
input.on('line', line => { try { void handle(JSON.parse(line)) }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) } })
