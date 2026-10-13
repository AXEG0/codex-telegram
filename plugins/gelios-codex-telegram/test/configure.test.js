import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const configureScript = fileURLToPath(new URL('../scripts/configure.js', import.meta.url))

test('configuration rejects non-interactive token input', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gelios-configure-'))
  const result = spawnSync(process.execPath, [configureScript, '--state-dir', stateDir, '--force'], {
    input: `123456789:${'a'.repeat(32)}\n`, encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /interactive local terminal outside Codex/)
  assert.equal(existsSync(join(stateDir, '.env')), false)
})
