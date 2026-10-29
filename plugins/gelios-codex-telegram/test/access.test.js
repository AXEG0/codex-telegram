import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { StateStore } from '../src/core.js'

// util-linux script takes `-c COMMAND FILE`; macOS script takes `FILE COMMAND...`, returns its status, and needs a non-socket stdin.
const scriptArgs = command => process.platform === 'linux' ? ['-qec', command, '/dev/null'] : ['-q', '/dev/null', '/bin/sh', '-c', command]

const accessScript = fileURLToPath(new URL('../scripts/access.js', import.meta.url))

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'gelios-access-'))
  const store = new StateStore(stateDir)
  store.saveAccess({
    version: 1,
    dmPolicy: 'pairing',
    users: {
      '42': { chatId: '42', alias: 'Jake', role: 'admin', pairedAt: '2026-08-05T00:00:00.000Z' },
    },
    pending: {
      abcdef: {
        senderId: '84',
        chatId: '84',
        displayName: 'Jenna',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        replies: 1,
      },
    },
  })
  return { stateDir, store }
}

function runAccess(stateDir, args) {
  return spawnSync(process.execPath, [accessScript, ...args, '--state-dir', stateDir], {
    encoding: 'utf8',
  })
}

test('every mutating access command rejects non-interactive invocation without changing state', () => {
  const { stateDir, store } = fixture()
  const before = readFileSync(store.accessPath, 'utf8')
  const cases = [
    ['pair', 'abcdef', '--alias', 'Jenna'],
    ['deny', 'abcdef'],
    ['revoke', '42'],
    ['role', '42', 'contributor'],
    ['policy', 'disabled'],
  ]

  for (const args of cases) {
    const result = runAccess(stateDir, args)
    assert.equal(result.status, 1, `${args[0]} should fail`)
    assert.match(result.stderr, /matching request from the local Codex terminal/)
    assert.equal(readFileSync(store.accessPath, 'utf8'), before)
  }
})

test('access list remains available without a TTY', () => {
  const { stateDir } = fixture()
  const result = runAccess(stateDir, ['list'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /policy: pairing/)
  assert.match(result.stdout, /42  Jake  admin  chat=42/)
  assert.match(result.stdout, /abcdef  Jenna  user=84/)
})

test('a Codex child marker blocks mutations even through a forged pseudo-TTY', () => {
  const { stateDir, store } = fixture()
  const before = readFileSync(store.accessPath, 'utf8')
  const command = `${process.execPath} ${accessScript} policy disabled --state-dir ${stateDir}`
  const result = spawnSync('script', scriptArgs(command), {
    encoding: 'utf8', env: { ...process.env, GELIOS_CODEX_CHILD: '1' },
    ...(process.platform === 'linux' ? {} : { stdio: ['ignore', 'pipe', 'pipe'] }),
  })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /matching request from the local Codex terminal/)
  assert.equal(readFileSync(store.accessPath, 'utf8'), before)
})

test('setting alertChat from a terminal asks Telegram with the saved token, and refuses a chat Telegram calls a bot', async () => {
  const { createServer } = await import('node:http')
  const { spawn } = await import('node:child_process')
  const token = `4321:${'t'.repeat(32)}`, asked = []
  let bot = true
  const server = createServer((request, response) => {
    asked.push(request.url.split('/').pop())
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ ok: true, result: { status: 'member', user: { id: 555, is_bot: bot } } }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const stateDir = mkdtempSync(join(tmpdir(), 'codex-tg-access-alert-')), store = new StateStore(stateDir)
    store.saveAccess({ version: 2, dmPolicy: 'allowlist', pending: {}, groups: {}, mentionPatterns: [], users: { '555': { chatId: '555', alias: 'Sam', role: 'admin' } } })
    const command = `${process.execPath} ${accessScript} set alertChat 555 --state-dir ${stateDir}`
    const env = { ...process.env, TELEGRAM_BOT_TOKEN: token, GELIOS_TELEGRAM_API_BASE: `http://127.0.0.1:${server.address().port}` }
    delete env.GELIOS_CODEX_CHILD
    const run = () => new Promise(done => {
      const child = spawn('script', scriptArgs(command), { env, stdio: process.platform === 'linux' ? 'pipe' : ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
      child.on('close', status => done({ status, output }))
    })
    const refused = await run()
    assert.equal(refused.status, 1)
    assert.match(refused.output, /administrator who is not a bot/)
    assert.equal(store.loadConfig().alertChat, undefined)
    assert.deepEqual(asked, ['getChatMember'])
    bot = false
    const accepted = await run()
    assert.equal(accepted.status, 0, accepted.output)
    assert.equal(store.loadConfig().alertChat, '555')
  } finally { server.close() }
})
