#!/usr/bin/env node
import { randomBytes, createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import net from 'node:net'
import readline from 'node:readline'
import { WebSocketPeer } from '../src/websocket.js'
const socket = net.createConnection(realpathSync(process.argv[2]))
const key = randomBytes(16).toString('base64')
const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
let pending = Buffer.alloc(0), peer
const timer = setTimeout(() => { process.stderr.write('native Codex handshake timed out\n'); socket.destroy(); process.exitCode = 1 }, 10_000)
socket.on('error', error => { clearTimeout(timer); process.stderr.write(`native Codex socket: ${error.message}\n`); process.exitCode = 1 })
socket.on('close', () => { clearTimeout(timer); input.close(); process.stdin.destroy() })
socket.once('connect', () => socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`))
const lines = [], input = readline.createInterface({ input: process.stdin })
input.on('line', text => peer ? peer.sendText(text) : lines.push(text))
input.on('close', () => { peer?.close(); socket.end() })
function handshake(chunk) {
  pending = Buffer.concat([pending, chunk]); const end = pending.indexOf('\r\n\r\n')
  if (pending.length > 16_384 && end < 0) { socket.destroy(); return }
  if (end < 0) return
  socket.off('data', handshake); clearTimeout(timer)
  const header = pending.subarray(0, end).toString('latin1')
  const accepted = /sec-websocket-accept:\s*([^\r\n]+)/i.exec(header)?.[1].trim()
  if (!/^HTTP\/1\.1 101 /.test(header) || accepted !== expected) {
    process.stderr.write('native Codex rejected the WebSocket handshake\n'); socket.destroy(); process.exitCode = 1; return
  }
  peer = new WebSocketPeer(socket, pending.subarray(end + 4), { maskOutgoing: true })
  peer.onText = text => process.stdout.write(text + '\n')
  peer.onClose = () => { input.close(); process.stdin.destroy() }
  for (const text of lines.splice(0)) peer.sendText(text)
}
socket.on('data', handshake)
