import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { mkdtempSync } from './fixtures.js'
import { installLaunchers } from '../src/bootstrap.js'

test('launcher preparation preserves the active managed launcher and refuses unrelated programs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'launcher-')), root = resolve('.')
  const links = installLaunchers({ root, directory, stateDir: join(directory, 'state') })
  assert.equal(readlinkSync(links.launcher), join(links.root, 'bin/codex-telegram'))
  const old = join(directory, 'old'); mkdirSync(join(old, '.codex-plugin'), { recursive: true }); mkdirSync(join(old, 'bin'))
  writeFileSync(join(old, '.codex-plugin/plugin.json'), '{"name":"gelios-codex-telegram"}')
  writeFileSync(join(old, 'bin/gelios-codex-telegram'), 'old')
  rmSync(links.managedLauncher); symlinkSync(join(old, 'bin/gelios-codex-telegram'), links.managedLauncher)
  installLaunchers({ root, directory, stateDir: join(directory, 'state') })
  assert.equal(readlinkSync(links.managedLauncher), join(old, 'bin/gelios-codex-telegram'))
  rmSync(links.launcher); writeFileSync(links.launcher, 'unrelated')
  assert.throws(() => installLaunchers({ root, directory, stateDir: join(directory, 'state') }), /another program/)
  assert.equal(readFileSync(links.launcher, 'utf8'), 'unrelated')
})

test('nonsecret preparation is available inside Codex while local interactive setup is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-')), state = join(root, 'state')
  const env = { ...process.env, HOME: root, GELIOS_CODEX_CHILD: '1', GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin') }
  const prepared = spawnSync(process.execPath, ['scripts/setup.js', '--prepare', '--state-dir', state], { env, encoding: 'utf8' })
  assert.equal(prepared.status, 0, prepared.stderr)
  const result = JSON.parse(prepared.stdout)
  assert.equal(result.running, false); assert.equal(result.configured, false); assert.equal(result.stateDir, state)
  assert.equal(lstatSync(result.launcher).isSymbolicLink(), true)
  const started = spawnSync(process.execPath, ['scripts/setup.js', '--state-dir', state], { env, encoding: 'utf8' })
  assert.equal(started.status, 1); assert.match(started.stderr, /local terminal outside Codex/)
  assert.match(realpathSync(result.launcher), /runtime-builds\/[a-f0-9]{64}\/bin\/codex-telegram$/)
})
