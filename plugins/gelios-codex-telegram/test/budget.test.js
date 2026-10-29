import { mkdtempSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// The Markdown parser is generated, not written here: a bundle of the MIT packages
// AXEG0/claude-telegram parses rich messages with, kept out of the line count.
const vendored = ['src/markdown-parser.js']
// Every authored module counts, in any directory under src and scripts, so new module directories cannot
// leave the budget. Node 18 has no recursive readdirSync, so the walk is explicit.
function modules(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry =>
    entry.isDirectory() ? modules(join(dir, entry.name)) : entry.name.endsWith('.js') ? [`${dir}/${entry.name}`] : [])
}
const runtimeFiles = ['../../launch.sh', '../../launcher.js'].filter(existsSync).concat('bin/gelios-codex-telegram', 'bin/codex-telegram',
  ...['src', 'scripts'].flatMap(modules)).filter(path => !vendored.includes(path))
// 6,750 lines through release 0.4.18. Release 0.4.19 adds stage 1 of the Claude feature parity design (#35),
// the native turn activity module and its wiring: 172 lines on a 6,744-line runtime. Each later stage of that
// design raises this budget again in its own review.
const BUDGET = 6916

test('the line count discovers module directories recursively and leaves only the generated parser out', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-telegram-budget-'))
  mkdirSync(join(root, 'feature', 'nested'), { recursive: true })
  for (const name of ['top.js', 'feature/inner.js', 'feature/nested/deep.js', 'feature/notes.md']) writeFileSync(join(root, name), '\n')
  assert.deepEqual(modules(root), ['feature/inner.js', 'feature/nested/deep.js', 'top.js'].map(name => `${root}/${name}`))
  assert.ok(runtimeFiles.includes('src/turn-activity.js') && runtimeFiles.includes('scripts/bridge.js'))
  assert.equal(runtimeFiles.some(path => vendored.includes(path)), false)
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
