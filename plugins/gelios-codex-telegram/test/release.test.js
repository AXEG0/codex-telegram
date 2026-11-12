import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from './fixtures.js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mkdtempSync } from './fixtures.js'

const check = fileURLToPath(new URL('./support/check-release.js', import.meta.url))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-contract-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init'); git('config', 'user.name', 'Aleksandr'); git('config', 'user.email', 'axegggl@gmail.com')
  const manifest = 'plugins/gelios-codex-telegram/.codex-plugin/plugin.json'
  mkdirSync(join(root, 'plugins/gelios-codex-telegram/.codex-plugin'), { recursive: true })
  const versions = value => { for (const path of [manifest, 'plugins/gelios-codex-telegram/package.json', 'package.json']) writeFileSync(join(root, path), JSON.stringify({ version: value })) }
  versions('0.4.4'); git('add', '.'); git('commit', '-m', 'Published fixture'); const base = git('rev-parse', 'HEAD')
  const commit = () => { git('add', '.'); git('commit', '-m', 'Candidate fixture') }
  const run = () => spawnSync(process.execPath, [check, base], { cwd: root, encoding: 'utf8' })
  return { root, versions, commit, run }
}

test('packaged test changes require a new release identity', () => {
  const f = fixture(); mkdirSync(join(f.root, 'plugins/gelios-codex-telegram/test'))
  writeFileSync(join(f.root, 'plugins/gelios-codex-telegram/test/fixture.js'), 'changed'); f.commit()
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /unchanged release version/)
})

test('a coordinated new plugin and launcher release passes', () => {
  const f = fixture(); f.versions('0.4.5'); f.commit(); assert.equal(f.run().status, 0)
})

test('mismatched launcher metadata fails even when the plugin version changes', () => {
  const f = fixture(); f.versions('0.4.5'); writeFileSync(join(f.root, 'package.json'), JSON.stringify({ version: '0.4.4' })); f.commit()
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /release versions differ/)
})

test('unpackaged operations documentation can change without a release', () => {
  const f = fixture(); mkdirSync(join(f.root, 'docs')); writeFileSync(join(f.root, 'docs/operations.md'), 'Documentation'); f.commit()
  assert.equal(f.run().status, 0)
})

// Codex installs a plugin by copying its folder alone, so the folder carries
// the license and security policy, each the same as the repository's own.
test('the plugin folder Codex installs carries the repository license and security policy unchanged', () => {
  const plugin = fileURLToPath(new URL('../', import.meta.url)), repository = fileURLToPath(new URL('../../../', import.meta.url))
  for (const name of ['LICENSE', 'SECURITY.md']) assert.equal(readFileSync(join(plugin, name), 'utf8'), readFileSync(join(repository, name), 'utf8'), name)
})
