import { mkdtempSync, spawn } from './fixtures.js'
import assert from 'node:assert/strict'

import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ATTACHMENT_TTL_MS,
  CALLBACK_TTL_MS,
  MAX_MESSAGE_CACHE_ENTRIES,
  MESSAGE_CACHE_TTL_MS,
  MAX_SEND_BYTES,
  StateStore,
  bootIdentity,
  chunkText,
  processGroupMembers,
  processInfo,
  safeDisplayName,
  sanitizeAttachmentMeta,
  sourceLabel,
} from '../src/core.js'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gelios-core-')))
  const state = join(root, 'state')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  return { root, state, workspace, store: new StateStore(state) }
}

test('labels include sanitized source, UTC time, sequence, and event id', () => {
  const label = sourceLabel({ source: 'Telegram', name: 'Ja|ke\n[x]', timestamp: 0, sequence: 42, eventId: 'tg-1' })
  assert.equal(label, '[Telegram/Ja_ke__x_ | 1970-01-01T00:00:00.000Z | #42 | event=tg-1]')
  assert.equal(safeDisplayName('  Jenna  '), 'Jenna')
  assert.equal(safeDisplayName('A/B\u202eC'), 'A_B_C')
})

test('text chunks never exceed the Telegram hard limit', () => {
  const chunks = chunkText(`${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}\n${'c'.repeat(3000)}`)
  assert.ok(chunks.length >= 3)
  assert.ok(chunks.every(chunk => chunk.length <= 4096))
  assert.equal(chunks.join('').replace(/\s/g, ''), `${'a'.repeat(3000)}${'b'.repeat(3000)}${'c'.repeat(3000)}`)
})

test('pairing is explicit, bounded, numeric-ID based, and first user can be promoted locally', () => {
  const { store } = fixture()
  const from = { id: 123, username: 'jake' }
  const chat = { id: 123, type: 'private' }
  const first = store.gatePrivateMessage(from, chat)
  assert.equal(first.action, 'pair')
  assert.equal(existsSync(`${store.accessPath}.lock`), false)
  assert.match(first.code, /^[a-f0-9]{6}$/)
  assert.equal(store.gatePrivateMessage(from, chat).action, 'pair')
  assert.equal(store.gatePrivateMessage(from, chat).action, 'drop')

  const access = store.loadAccess()
  access.users['123'] = { chatId: '123', alias: 'Jake', role: 'admin' }
  delete access.pending[first.code]
  store.saveAccess(access)
  assert.equal(store.gatePrivateMessage({ id: 123, username: 'renamed' }, chat).action, 'deliver')
  assert.equal(store.gatePrivateMessage({ id: 124 }, chat).action, 'pair')
})

test('disabled policy fails closed for inbound and outbound routing', () => {
  const { store } = fixture()
  const access = store.loadAccess()
  access.dmPolicy = 'disabled'
  access.users['123'] = { chatId: '123', alias: 'Jake', role: 'admin' }
  store.saveAccess(access)

  assert.equal(store.gatePrivateMessage({ id: 123 }, { id: 123, type: 'private' }).action, 'drop')
  assert.throws(() => store.authorizedChat('123'), /access is disabled/)
})

test('corrupt access state fails closed', () => {
  const { store } = fixture()
  writeFileSync(store.accessPath, '{nope', { mode: 0o600 })
  assert.throws(() => store.loadAccess(), /refusing to continue/)
})

test('event journal gives stable ordering and deduplicates source ids', () => {
  const { store } = fixture()
  const one = store.acceptEvent('tg-1', { name: 'Jake' })
  const duplicate = store.acceptEvent('tg-1', { name: 'Other' })
  const two = store.acceptEvent('tg-2', { name: 'Jenna' })
  assert.equal(one.event.sequence, 1)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.event.name, 'Jake')
  assert.equal(two.event.sequence, 2)
  assert.equal(lstatSync(store.runtimePath).mode & 0o777, 0o600)
})

test('callback capabilities are message-bound, expiring, and one-time by group', () => {
  const { store } = fixture()
  const group = store.createCallbackGroup({ chatId: '123', userId: '123', threadId: 'thread-1', action: 'selectModel' }, [
    { value: 'model-a', label: 'Model A' },
    { value: 'model-b', label: 'Model B' },
  ])
  assert.ok(group.capabilities.every(value => value.callbackData.length <= 64))
  store.bindCallbackGroup(group.groupId, '55')
  assert.throws(() => store.consumeCallback(group.capabilities[0].token, { chatId: '999', userId: '123', messageId: '55' }), /does not belong/)
  const selected = store.consumeCallback(group.capabilities[0].token, { chatId: '123', userId: '123', messageId: '55' })
  assert.equal(selected.threadId, 'thread-1')
  assert.equal(selected.value, 'model-a')
  assert.throws(() => store.consumeCallback(group.capabilities[1].token, { chatId: '123', userId: '123', messageId: '55' }), /already used/)
  const runtime = store.loadRuntime()
  runtime.callbacks[group.capabilities[0].token].expiresAt = Date.now() - 1
  store.saveRuntime(runtime)
  assert.equal(store.loadRuntime().callbacks[group.capabilities[0].token], undefined)
  assert.equal(CALLBACK_TTL_MS, 10 * 60 * 1000)
})

test('the journal bounds permanent failures while retaining retryable ingress', () => {
  const { store } = fixture()
  const runtime = store.loadRuntime()
  runtime.events.retryable = { eventId: 'retryable', status: 'failed', retryable: true, createdAt: 0 }
  for (let index = 0; index < 1100; index += 1) runtime.events[`permanent-${index}`] = {
    eventId: `permanent-${index}`, status: 'failed', retryable: false, createdAt: index + 1, payload: { text: 'rejected' },
  }
  store.saveRuntime(runtime)
  const retained = store.loadRuntime().events
  assert.ok(Object.keys(retained).length <= 1024)
  assert.ok(retained.retryable)
  assert.equal(retained['permanent-0'], undefined)
  assert.ok(retained['permanent-1099'])
})

test('terminal client message identity is stable while the legacy API remains unique', () => {
  const { store } = fixture()
  const first = store.nextTerminalEvent('Alex', { timestamp: 1000, clientUserMessageId: 'client-message-1' })
  const duplicate = store.nextTerminalEvent('Renamed', { timestamp: 2000, clientUserMessageId: 'client-message-1' })
  const thirdArgument = store.nextTerminalEvent('Alex', 3000, 'client-message-2')
  const legacyOne = store.nextTerminalEvent('Alex', 4000)
  const legacyTwo = store.nextTerminalEvent('Alex', 5000)
  const request = { timestamp: 6000, requestId: 9, method: 'turn/start', params: {
    threadId: 'thread-1', clientUserMessageId: null, input: [{ type: 'text', text: 'retry me' }],
  } }
  const derived = store.nextTerminalEvent('Alex', request)
  const derivedDuplicate = store.nextTerminalEvent('Alex', structuredClone(request))
  const derivedOtherRequest = store.nextTerminalEvent('Alex', { ...request, requestId: 10 })
  const nextTuiSession = store.nextTerminalEvent('Alex', { ...request, sessionId: 'next-tui-session' })

  assert.equal(duplicate.eventId, first.eventId)
  assert.equal(duplicate.sequence, first.sequence)
  assert.equal(duplicate.sourceTimestamp, 1000)
  assert.equal(first.clientUserMessageId, 'client-message-1')
  assert.equal(thirdArgument.clientUserMessageId, 'client-message-2')
  assert.notEqual(thirdArgument.eventId, first.eventId)
  assert.notEqual(legacyOne.eventId, legacyTwo.eventId)
  assert.equal(derivedDuplicate.eventId, derived.eventId)
  assert.equal(derived.payload.clientId, derived.eventId)
  assert.notEqual(derivedOtherRequest.eventId, derived.eventId)
  assert.notEqual(nextTuiSession.eventId, derived.eventId)
})

test('attachment metadata is sanitized and authorization expires deterministically', () => {
  const { store } = fixture()
  const meta = {
    kind: 'document;\nforged=true',
    mime: 'text/plain;\nchat_id=999',
    name: '../bad\nname.txt',
    size: '12',
    rawFileId: 'telegram_raw-id',
  }
  const sanitized = sanitizeAttachmentMeta(meta)
  assert.doesNotMatch(`${sanitized.kind}${sanitized.mime}`, /[;\r\n=]/)
  assert.equal(sanitized.name, 'bad_name.txt')
  assert.equal(sanitized.size, 12)

  store.rememberAttachment('att_fresh', meta)
  const fresh = store.attachment('att_fresh')
  assert.equal(meta.mime, sanitized.mime)
  assert.equal(fresh.rawFileId, 'telegram_raw-id')
  assert.equal(fresh.expiresAt - fresh.createdAt, ATTACHMENT_TTL_MS)

  const runtime = store.loadRuntime()
  runtime.attachments.att_expired = {
    kind: 'document',
    rawFileId: 'expired',
    createdAt: 1,
    expiresAt: 2,
  }
  store.saveRuntime(runtime)
  assert.throws(() => store.attachment('att_expired'), /Unknown or expired/)
  assert.equal(store.loadRuntime().attachments.att_expired, undefined)
})

test('Telegram message cache is private, persistent, bounded, and expiring', () => {
  const { state, store } = fixture()
  store.rememberMessage('123', '7', {
    text: 'parent body', mediaKind: 'photo', sourceTimestamp: 7000,
    sender: { userId: '123', name: 'Ja|ke\n[x]', username: 'jake', isBot: false, isSelf: false },
  })
  const restarted = new StateStore(state)
  assert.deepEqual(restarted.message('123', '7'), {
    text: 'parent body',
    mediaKind: 'photo',
    sender: { userId: '123', name: 'Ja_ke__x_', username: 'jake', isBot: false, isSelf: false },
    sourceTimestamp: 7000,
    createdAt: restarted.message('123', '7').createdAt,
    updatedAt: restarted.message('123', '7').updatedAt,
    expiresAt: restarted.message('123', '7').createdAt + MESSAGE_CACHE_TTL_MS,
  })
  assert.equal(lstatSync(restarted.runtimePath).mode & 0o777, 0o600)
  assert.throws(() => restarted.message('not-a-chat', '7'), /numeric chat and message IDs/)

  const runtime = restarted.loadRuntime()
  const now = Date.now()
  runtime.messages['123:7'].expiresAt = now - 1
  for (let index = 0; index < MAX_MESSAGE_CACHE_ENTRIES + 10; index += 1) {
    runtime.messages[`123:${index + 100}`] = {
      text: `message ${index}`, createdAt: now, updatedAt: now + index, expiresAt: now + MESSAGE_CACHE_TTL_MS,
    }
  }
  restarted.saveRuntime(runtime)
  const retained = restarted.loadRuntime().messages
  assert.equal(Object.keys(retained).length, MAX_MESSAGE_CACHE_ENTRIES)
  assert.equal(retained['123:7'], undefined)
  assert.equal(retained['123:100'], undefined)
  assert.equal(retained[`123:${MAX_MESSAGE_CACHE_ENTRIES + 99}`].text, `message ${MAX_MESSAGE_CACHE_ENTRIES - 1}`)
})

test('outbound files stay inside allowed roots and cannot escape through links', () => {
  const { root, store, workspace } = fixture()
  const allowed = join(workspace, 'report.txt')
  const outside = join(root, 'secret.txt')
  const link = join(workspace, 'link.txt')
  const hardLink = join(workspace, 'hard-link.txt')
  writeFileSync(allowed, 'ok')
  writeFileSync(outside, 'secret')
  symlinkSync(outside, link)
  linkSync(outside, hardLink)
  const snapshot = store.resolveOutboundFile(allowed, workspace)
  assert.equal(snapshot.path, allowed)
  assert.equal(snapshot.bytes.toString(), 'ok')
  assert.throws(() => store.resolveOutboundFile(outside, workspace), /outside allowed roots/)
  assert.throws(() => store.resolveOutboundFile(link, workspace), /outside allowed roots/)
  assert.throws(() => store.resolveOutboundFile(hardLink, workspace), /hard-linked file/)
  writeFileSync(store.accessPath, '{}')
  assert.throws(() => store.resolveOutboundFile(store.accessPath, root), /refusing to send plugin state/)
  assert.throws(() => store.resolveOutboundFile(workspace, workspace), /not a regular file/)
  const large = join(workspace, 'large.bin')
  writeFileSync(large, '')
  truncateSync(large, MAX_SEND_BYTES + 1)
  assert.throws(() => store.resolveOutboundFile(large, workspace), /file exceeds/)
  chmodSync(store.dir, 0o700)
})

test('process helpers report parentage, stable start identity, process groups, and boot identity', t => {
  const self = processInfo(process.pid)
  assert.equal(self.ppid, process.ppid)
  assert.match(self.identity, /^\d+$/)
  assert.equal(processInfo(process.pid).identity, self.identity)
  // Linux reports the kernel thread name, which Node can set to MainThread.
  if (process.platform === 'linux') assert.equal(self.name, readFileSync(`/proc/${process.pid}/comm`, 'utf8').trimEnd())
  else assert.match(self.name, /node/i)
  assert.equal(processInfo(999_999_999), null)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  assert.deepEqual(processGroupMembers(child.pid), [child.pid])
  assert.equal(processGroupMembers(self.pgid).includes(process.pid), false)
  assert.match(bootIdentity(), /^[a-f0-9-]{16,64}$/)
  assert.equal(bootIdentity(), bootIdentity())
})
