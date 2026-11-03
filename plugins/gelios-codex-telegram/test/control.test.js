import assert from 'node:assert/strict'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mkdtempSync } from './fixtures.js'
import { requestControl } from '../src/control.js'

test('a tool request waits for the replacement socket before sending once', async t => {
  const root = mkdtempSync(join(tmpdir(), 'control-reconnect-')), path = join(root, 'control.sock')
  const requests = [], server = net.createServer(socket => socket.once('data', data => {
    requests.push(JSON.parse(data)); socket.end(JSON.stringify({ ok: true, result: { delivered: true } }) + '\n')
  }))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = requestControl(path, 'reply', { text: 'once' }, { connectWaitMs: 1500, timeoutMs: 2000 })
  await new Promise(resolve => setTimeout(resolve, 150)); await new Promise(resolve => server.listen(path, resolve))
  assert.deepEqual(await response, { delivered: true })
  assert.deepEqual(requests, [{ action: 'reply', args: { text: 'once' } }])
})

test('a lost response after acceptance never repeats the tool request', async t => {
  const root = mkdtempSync(join(tmpdir(), 'control-ambiguous-')), path = join(root, 'control.sock')
  let requests = 0
  const server = net.createServer(socket => socket.once('data', () => { requests++; socket.end() }))
  await new Promise(resolve => server.listen(path, resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  await assert.rejects(requestControl(path, 'reply', {}, { connectWaitMs: 1000 }), /closed before returning/)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(requests, 1)
})
