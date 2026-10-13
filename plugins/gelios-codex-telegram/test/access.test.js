import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
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
    assert.match(result.stderr, new RegExp(`${args[0]} requires an interactive local terminal \\(TTY\\)`))
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
  assert.match(result.stdout, /outside Codex/)
  assert.equal(readFileSync(store.accessPath, 'utf8'), before)
})
