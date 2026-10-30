import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// The Markdown parser is generated, not written here: a bundle of the MIT packages
// AXEG0/claude-telegram parses rich messages with, kept out of the line count.
const vendored = ['src/markdown-parser.js']
// Every authored module counts wherever it sits in the plugin, so a new directory or module extension cannot
// leave the budget. Tests and installed dependencies are not runtime. Node 18 has no recursive readdirSync,
// so the walk is explicit. The bin launchers carry no extension and are named.
function modules(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (entry.isDirectory()) return entry.name === 'node_modules' || (dir === root && entry.name === 'test') ? [] : modules(root, join(dir, entry.name))
    return /\.[cm]?js$/.test(entry.name) ? [join(dir, entry.name)] : []
  })
}
const runtimeFiles = ['../../launch.sh', '../../launcher.js'].filter(existsSync).concat('bin/gelios-codex-telegram', 'bin/codex-telegram',
  ...modules('.')).filter(path => !vendored.includes(path))
// 6,750 lines through release 0.4.18. Release 0.4.19 adds stage 1 of the Claude feature parity design (#35),
// the native turn activity module and its wiring: 191 lines on a 6,744-line runtime. Each later stage of that
// design raises this budget again in its own review. Release 0.4.20 adds stage 2's access and delivery
// half: the destination policy, groups, static mode, pinned bots, formats, delivery settings and the audio deadline.
// Release 0.4.21 adds stage 2's other half: question buttons with their journal, and incoming reactions.
// Release 0.4.22 adds stage 3, typing and alerts: the monitor and its notice journal, starter routes and the poll record.
const BUDGET = 8209

test('the line count walks the whole plugin for .js, .mjs and .cjs modules, leaving out only tests, node_modules and the generated parser', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-telegram-budget-'))
  for (const dir of ['src/node_modules/dependency', 'scripts', 'lib/nested', 'test/support', 'node_modules/dependency']) mkdirSync(join(root, dir), { recursive: true })
  for (const name of ['top.js', 'src/a.js', 'src/node_modules/dependency/index.js', 'scripts/b.mjs', 'lib/nested/c.cjs', 'lib/notes.md',
    'test/fixture.test.js', 'test/support/helper.js', 'node_modules/dependency/index.js']) writeFileSync(join(root, name), '\n')
  assert.deepEqual(modules(root), ['lib/nested/c.cjs', 'scripts/b.mjs', 'src/a.js', 'top.js'].map(name => join(root, name)))
  assert.ok(runtimeFiles.includes('src/turn-activity.js') && runtimeFiles.includes('scripts/bridge.js') && runtimeFiles.includes('bin/codex-telegram'))
  assert.equal(runtimeFiles.some(path => vendored.includes(path) || path.startsWith('test/')), false)
})

test(`runtime stays within ${BUDGET.toLocaleString('en-US')} physical lines with zero dependencies`, () => {
  const lines = runtimeFiles.reduce((total, path) => total + readFileSync(path, 'utf8').split('\n').length - 1, 0)
  assert.ok(lines <= BUDGET, `runtime is ${lines} lines`)
  for (const path of vendored) assert.match(readFileSync(path, 'utf8'), /^\/\/ Generated file: do not edit\./)
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.deepEqual(pkg.dependencies || {}, {})
  const installer = JSON.parse(readFileSync('../../package.json', 'utf8'))
  assert.deepEqual(installer.dependencies || {}, {})
})
