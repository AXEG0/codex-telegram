import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { runSharedTui } from '../src/tui.js'

test('managed TUI follows an external switch, accepts local selection, and never launches a backend', { timeout: 3000 }, async () => {
  let status = { ready: true, instanceId: 'instance', codexBin: '/codex', socket: '/private/app.sock', workspace: '/work', threadId: 'a', tuiAttached: false }, index = 0
  const launches = [], restores = [], terminal = { isTTY: true }, output = { isTTY: true, write: () => {} }
  const code = await runSharedTui({ stateDir: '/private' }, {
    terminal, output, terminalMode: () => 'original', restoreMode: mode => restores.push(mode), pollMs: 5,
    control: async () => ({ ...status }),
    launch: (bin, args) => {
      launches.push({ bin, args }); const child = new EventEmitter(); index++
      status.tuiAttached = true; status.tuiThreadId = status.threadId
      child.kill = signal => { assert.equal(signal, 'SIGTERM'); status.tuiAttached = false; queueMicrotask(() => child.emit('exit', null, signal)) }
      if (index === 1) {
        // Native /resume selects the shared thread; it needs no frontend replacement.
        status.threadId = 'local'; status.tuiThreadId = 'local'
        setTimeout(() => { status.threadId = 'telegram' }, 20)
      } else setTimeout(() => child.emit('exit', 0, null), 20)
      return child
    },
  })
  assert.equal(code, 0); assert.equal(launches.length, 2)
  assert.deepEqual(launches.map(call => call.args.at(-1)), ['a', 'telegram'])
  assert.equal(launches.some(call => call.args.includes('app-server')), false)
  assert.deepEqual(restores, ['original', 'original'])
})
test('closing the launcher stops only its frontend and restores the parent terminal', async () => {
  const cancellation = new AbortController(), restores = [], kills = []
  const code = await runSharedTui({ stateDir: '/private', signal: cancellation.signal }, {
    terminal: { isTTY: true }, output: { isTTY: true, write: () => {} }, terminalMode: () => 'saved', restoreMode: value => restores.push(value),
    control: async () => ({ socket: '/private/app.sock', codexBin: '/codex', workspace: '/work', threadId: 'existing', instanceId: 'same' }),
    launch: () => {
      const child = new EventEmitter()
      child.kill = signal => { kills.push(signal); queueMicrotask(() => child.emit('exit', null, signal)) }
      queueMicrotask(() => cancellation.abort()); return child
    },
  })
  assert.equal(code, 1); assert.deepEqual(kills, ['SIGTERM']); assert.deepEqual(restores, ['saved'])
})
