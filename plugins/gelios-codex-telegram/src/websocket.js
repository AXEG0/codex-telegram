import { createHash, randomBytes } from 'node:crypto'
import { chmodSync } from 'node:fs'
import net from 'node:net'
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME = 8 * 1024 * 1024
function encodeFrame(opcode, payload = Buffer.alloc(0), masked = false) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  let header
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length])
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  if (!masked) return Buffer.concat([header, body])
  header[1] |= 0x80
  const mask = randomBytes(4), encoded = Buffer.from(body)
  for (let index = 0; index < encoded.length; index++) encoded[index] ^= mask[index % 4]
  return Buffer.concat([header, mask, encoded])
}
export class WebSocketPeer {
  constructor(socket, initial = Buffer.alloc(0), { maskOutgoing = false } = {}) {
    this.maskOutgoing = maskOutgoing
    this.socket = socket; this.buffer = initial; this.fragments = []
    this.fragmentOpcode = null; this.fragmentBytes = 0; this.closed = false
    this.onText = () => {}; this.onClose = () => {}
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]); this.consume()
    })
    socket.on('close', () => this.finish())
    socket.on('error', () => this.finish())
    if (initial.length) queueMicrotask(() => this.consume())
  }
  finish() {
    if (this.closed) return
    this.closed = true; this.onClose()
  }
  sendText(text) {
    if (!this.closed && this.socket.writable) this.socket.write(encodeFrame(0x1, Buffer.from(text), this.maskOutgoing))
  }
  sendPong(payload) {
    if (!this.closed && this.socket.writable) this.socket.write(encodeFrame(0xa, payload, this.maskOutgoing))
  }
  close(code = 1000, reason = '') {
    if (this.closed) return
    const reasonBytes = Buffer.from(String(reason)).subarray(0, 123)
    const body = Buffer.alloc(2 + reasonBytes.length); body.writeUInt16BE(code, 0); reasonBytes.copy(body, 2)
    this.socket.write(encodeFrame(0x8, body, this.maskOutgoing)); this.socket.end(); this.finish()
  }
  consume() {
    while (!this.closed) {
      if (this.buffer.length < 2) return
      const first = this.buffer[0], second = this.buffer[1]
      const fin = Boolean(first & 0x80), opcode = first & 0x0f, masked = Boolean(second & 0x80)
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2); offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const longLength = this.buffer.readBigUInt64BE(2)
        if (longLength > BigInt(MAX_FRAME)) return this.close(1009, 'frame too large')
        length = Number(longLength); offset = 10
      }
      if (length > MAX_FRAME) return this.close(1009, 'frame too large')
      const maskBytes = masked ? 4 : 0
      if (this.buffer.length < offset + maskBytes + length) return
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null
      offset += maskBytes
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length)); this.buffer = this.buffer.subarray(offset + length)
      if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
      if (opcode === 0x8) {
        this.socket.end(encodeFrame(0x8, payload, this.maskOutgoing)); this.finish(); return
      }
      if (opcode === 0x9) {
        this.sendPong(payload); continue
      }
      if (opcode === 0xa) continue
      if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragmentOpcode !== null) return this.close(1002, 'unexpected data frame')
        if (fin) {
          if (opcode === 0x1) this.onText(payload.toString('utf8'))
          continue
        }
        this.fragmentOpcode = opcode; this.fragments = [payload]; this.fragmentBytes = payload.length; continue
      }
      if (opcode === 0x0) {
        if (this.fragmentOpcode === null) return this.close(1002, 'unexpected continuation')
        if (this.fragmentBytes + payload.length > MAX_FRAME) {
          this.fragments = []; this.fragmentOpcode = null; this.fragmentBytes = 0
          return this.close(1009, 'message too large')
        }
        this.fragmentBytes += payload.length; this.fragments.push(payload)
        if (fin) {
          const complete = Buffer.concat(this.fragments, this.fragmentBytes), originalOpcode = this.fragmentOpcode
          this.fragments = []; this.fragmentOpcode = null; this.fragmentBytes = 0
          if (originalOpcode === 0x1) this.onText(complete.toString('utf8'))
        }
        continue
      }
      this.close(1002, 'unsupported opcode')
    }
  }
}
export function createUnixWebSocketServer(path, onPeer) {
  const server = net.createServer(socket => {
    let pending = Buffer.alloc(0)
    const onData = chunk => {
      pending = Buffer.concat([pending, chunk])
      if (pending.length > 16 * 1024) return socket.destroy()
      const end = pending.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', onData)
      const headerText = pending.subarray(0, end).toString('latin1'), extra = pending.subarray(end + 4)
      const lines = headerText.split('\r\n'), request = lines.shift() || ''
      const headers = Object.fromEntries(lines.map(line => {
        const split = line.indexOf(':')
        return split < 0 ? ['', ''] : [line.slice(0, split).trim().toLowerCase(), line.slice(split + 1).trim()]
      }))
      if (!request.startsWith('GET ') || headers.upgrade?.toLowerCase() !== 'websocket' || !headers['sec-websocket-key']) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return
      }
      const accept = createHash('sha1').update(headers['sec-websocket-key'] + MAGIC).digest('base64')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      onPeer(new WebSocketPeer(socket, extra))
    }
    socket.on('data', onData)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject); chmodSync(path, 0o600); resolve(server)
    })
  })
}
