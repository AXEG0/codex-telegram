import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mkdtempSync } from './fixtures.js'
import { resolveLauncher } from '../../../launcher.js'
import { installLaunchers } from '../src/bootstrap.js'

function installation() {
  const codexHome = mkdtempSync(join(tmpdir(), 'launcher-package-'))
  const root = join(codexHome, 'plugins/cache/codex-telegram/telegram/0.4.2')
  mkdirSync(join(root, '.codex-plugin'), { recursive: true }); mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'telegram', version: '0.4.2' }))
  writeFileSync(join(root, 'bin/codex-telegram'), '')
  writeFileSync(join(root, 'bin/gelios-codex-telegram'), '')
  const selected = { name: 'telegram', marketplaceName: 'codex-telegram', enabled: true, version: '0.4.2' }
  return { codexHome, root, selected }
}

test('the installer reuses the native selection and never rewrites an existing installation', () => {
  const fix = installation(), calls = []
  const launcher = resolveLauncher({ codexHome: fix.codexHome, run: args => { calls.push(args); return { installed: [fix.selected] } } })
  assert.equal(launcher, join(fix.root, 'bin/codex-telegram'))
  assert.deepEqual(calls, [['plugin', 'list']])
  fix.selected.enabled = false
  assert.throws(() => resolveLauncher({ codexHome: fix.codexHome, run: () => ({ installed: [fix.selected] }) }), /disabled/)
})

test('a missing native plugin is reported without installing or enabling anything', () => {
  const calls = []
  assert.throws(() => resolveLauncher({ run: args => { calls.push(args); return { installed: [] } } }), /native Codex plugin commands/)
  assert.deepEqual(calls, [['plugin', 'list']])
})

test('invalid or ambiguous native selections never launch an unrelated executable', () => {
  const fix = installation()
  assert.throws(() => resolveLauncher({ run: () => ({}) }), /invalid installed-plugin list/)
  assert.throws(() => resolveLauncher({ run: () => ({ installed: [fix.selected, fix.selected] }) }), /exactly one/)
  assert.throws(() => resolveLauncher({ codexHome: fix.codexHome, run: () => ({ installed: [{ ...fix.selected, version: '../other' }] }) }), /version/)
  writeFileSync(join(fix.root, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'another-plugin', version: '0.4.2' }))
  assert.throws(() => resolveLauncher({ codexHome: fix.codexHome, run: () => ({ installed: [fix.selected] }) }), /identity mismatch/)
})

test('npm command links execute the dispatcher and survive managed launcher preparation', () => {
  const fix = installation(), directory = join(fix.codexHome, 'bin'); mkdirSync(directory)
  const installer = fileURLToPath(new URL('../../../launcher.js', import.meta.url))
  const command = join(directory, 'codex-telegram'); symlinkSync(installer, command)
  const help = spawnSync(process.execPath, [command, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /Usage: codex-telegram/)
  const links = installLaunchers({ root: fix.root, directory })
  assert.equal(links.launcher, command)
  assert.equal(readlinkSync(command), installer)
  assert.equal(readlinkSync(links.managedLauncher), join(fix.root, 'bin/gelios-codex-telegram'))
})
