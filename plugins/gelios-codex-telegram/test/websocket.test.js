import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createUnixWebSocketServer, WebSocketPeer } from '../src/websocket.js'

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

function maskedFrame(opcode, value, { fin = true } = {}) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
  let header
  if (payload.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length])
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = (fin ? 0x80 : 0) | opcode
    header[1] = 0xfe
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = (fin ? 0x80 : 0) | opcode
    header[1] = 0xff
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
  return Buffer.concat([header, mask, masked])
}

function maskedText(value) {
  return maskedFrame(0x1, value)
}

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.writable = true
    this.writes = []
    this.ended = false
  }

  write(value) {
    this.writes.push(Buffer.from(value))
    return true
  }

  end(value) {
    if (value) this.write(value)
    this.ended = true
  }
}

test('Unix WebSocket server accepts masked JSON and emits unmasked text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gelios-ws-'))
  const path = join(dir, 'bridge.sock')
  let receivedResolve
  const received = new Promise(resolve => { receivedResolve = resolve })
  const server = await createUnixWebSocketServer(path, peer => {
    peer.onText = text => {
      receivedResolve(text)
      peer.sendText('{"ok":true}')
    }
  })
  const client = net.createConnection(path)
  const key = randomBytes(16).toString('base64')
  let buffer = Buffer.alloc(0)
  const response = new Promise((resolve, reject) => {
    client.on('error', reject)
    client.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      if (!buffer.subarray(0, headerEnd).toString().includes('101 Switching Protocols')) return reject(new Error('upgrade failed'))
      const frame = buffer.subarray(headerEnd + 4)
      if (frame.length < 2) return
      const length = frame[1] & 0x7f
      if (frame.length >= length + 2) resolve(frame.subarray(2, 2 + length).toString())
    })
  })
  await new Promise(resolve => client.once('connect', resolve))
  client.write(
    'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  )
  await new Promise(resolve => setTimeout(resolve, 10))
  client.write(maskedText('{"hello":"world"}'))
  assert.equal(await received, '{"hello":"world"}')
  assert.equal(await response, '{"ok":true}')
  client.destroy()
  await new Promise(resolve => server.close(resolve))
  try { unlinkSync(path) } catch {}
})

test('fragmented messages are rejected as soon as their cumulative size exceeds the limit', () => {
  const socket = new FakeSocket()
  const peer = new WebSocketPeer(socket)
  let received = false
  peer.onText = () => { received = true }

  socket.emit('data', maskedFrame(0x1, Buffer.alloc(MAX_MESSAGE_BYTES / 2), { fin: false }))
  assert.equal(peer.closed, false)

  socket.emit('data', maskedFrame(0x0, Buffer.alloc(MAX_MESSAGE_BYTES / 2 + 1), { fin: false }))

  assert.equal(received, false)
  assert.equal(peer.closed, true)
  assert.equal(socket.ended, true)
  assert.equal(peer.fragments.length, 0)
  const closeFrame = socket.writes.at(-1)
  assert.equal(closeFrame[0] & 0x0f, 0x8)
  assert.equal(closeFrame.readUInt16BE(2), 1009)
})
