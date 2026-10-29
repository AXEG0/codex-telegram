#!/usr/bin/env node
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'
import { installLaunchers } from '../src/bootstrap.js'
import { defaultStateDir } from '../src/core.js'
import { telegramInstructions as instructions } from '../src/telegram-guidance.js'
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const controlSocket = process.env.GELIOS_TELEGRAM_CONTROL_SOCKET || join(defaultStateDir(), 'control.sock')
// Native configuration keeps this namespace out of deferred tool discovery.
// Channel envelopes retain the same canonical delivery contract for recovery.
const FORMAT = { type: 'string', enum: ['rich', 'text', 'markdownv2'],
  description: "Optional rendering. 'rich' (default) sends GitHub Markdown as a Telegram rich message; 'text' is plain text as written; 'markdownv2' uses Telegram MarkdownV2, whose special characters the caller escapes. Any other value sends nothing. A paired bot always gets plain text." }
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
    description: 'Edit one text message recorded as sent by this bot in a paired chat or added group. Markdown renders as in telegram_reply unless format says otherwise. The text must fit one rich message. Editing does not send a new notification.',
    inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' }, text: { type: 'string' }, format: FORMAT },
      required: ['chat_id', 'message_id', 'text'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'telegram_reply', title: 'Reply on Telegram',
    description: 'Send a message chosen by Codex to a paired private Telegram chat or an added group. Use chat_id, and optionally reply_to and message_thread_id, from trusted Telegram message metadata. Files must be in the active workspace or the session inbox/outbox.',
    inputSchema: { type: 'object', properties: {
        chat_id: { type: 'string', description: 'Paired private chat ID or added group chat ID from inbound Telegram metadata.' },
        text: { type: 'string', description: 'GitHub Markdown message text, sent as a Telegram rich message (tables, headings, task lists, code, details). Long text is split between blocks; a paired bot gets the text as written.' },
        reply_to: { type: 'string', description: 'Optional inbound Telegram message_id for native threading.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional absolute paths. Images use photo preview; other regular files are documents. Maximum 50 MiB each.' },
        format: FORMAT,
        message_thread_id: { type: 'string', description: 'Optional group topic ID from inbound message_thread_id metadata; the reply stays in that topic.' },
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
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlSocket)
    let buffer = '', settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value)
    }
    const stop = message => { socket.destroy(); finish(reject, new Error(message)) }
    const abort = () => stop(`Gelios Telegram ${action} was cancelled`)
    const timer = setTimeout(() => stop(`Gelios Telegram bridge timed out during ${action}`), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ action, args })}\n`))
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 1024 * 1024) { stop('Gelios Telegram bridge response is too large'); return }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer); socket.end()
      try {
        const response = JSON.parse(buffer.slice(0, newline))
        if (!response.ok) finish(reject, new Error(response.error || 'Gelios Telegram bridge rejected the request'))
        else finish(resolve, response.result)
      } catch (error) { finish(reject, error) }
    })
    socket.on('error', error => finish(reject, new Error(`Gelios Telegram bridge is unavailable: ${error.message}`)))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
// Optional arguments need a bridge that honors them: an older bridge would drop them and send anyway.
// A bridge without the capabilities action predates every optional argument.
const OPTIONAL = { format: 'format', message_thread_id: 'topics' }
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
    return `Telegram message edited: ${result.message_id}`
  }
  if (name === 'telegram_reply') {
    const result = await controlRequest('reply', args, signal)
    return `Telegram sent message IDs: ${(result.message_ids || []).join(', ')}; event=${result.event_id}; time=${result.timestamp}`
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
input.on('close', () => { for (const controller of pending.values()) controller.abort() })
input.on('line', line => { try { void handle(JSON.parse(line)) }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) } })
