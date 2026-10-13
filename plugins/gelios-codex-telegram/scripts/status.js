#!/usr/bin/env node
import net from 'node:net'
import { join } from 'node:path'
import { defaultStateDir } from '../src/core.js'
const stateDir = process.env.GELIOS_TELEGRAM_STATE_DIR || defaultStateDir()
const socketPath = process.env.GELIOS_TELEGRAM_CONTROL_SOCKET || join(stateDir, 'control.sock')
const socket = net.createConnection(socketPath)
let buffer = ''
let finished = false
const fail = message => {
  if (finished) return
  finished = true; process.exitCode = 1
  process.stderr.write(`gelios-codex-telegram status: bridge unavailable (${message})\n`)
  socket.destroy()
}
socket.setTimeout(1000, () => fail('timed out'))
socket.setEncoding('utf8')
socket.on('connect', () => socket.write(`${JSON.stringify({ action: 'status' })}\n`))
socket.on('data', chunk => {
  buffer += chunk
  const newline = buffer.indexOf('\n')
  if (newline < 0) return
  try {
    const response = JSON.parse(buffer.slice(0, newline))
    if (!response.ok) return fail(response.error || 'request rejected')
    finished = true; process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`); socket.end()
  } catch (error) { fail(error.message) }
})
socket.on('error', error => fail(error.message))
