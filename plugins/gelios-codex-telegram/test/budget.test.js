import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

// The Markdown parser is generated, not written here: a bundle of the MIT packages
// AXEG0/claude-telegram parses rich messages with, kept out of the line count.
const vendored = ['src/markdown-parser.js']
const runtimeFiles = ['../../launch.sh', '../../launcher.js'].filter(existsSync).concat('bin/gelios-codex-telegram', 'bin/codex-telegram', ...['src', 'scripts'].flatMap(dir =>
  readdirSync(dir).filter(name => name.endsWith('.js')).map(name => `${dir}/${name}`))).filter(path => !vendored.includes(path))

test('runtime stays within 6,750 physical lines with zero dependencies', () => {
  const lines = runtimeFiles.reduce((total, path) => total + readFileSync(path, 'utf8').split('\n').length - 1, 0)
  assert.ok(lines <= 6750, `runtime is ${lines} lines`)
  for (const path of vendored) assert.match(readFileSync(path, 'utf8'), /^\/\/ Generated file: do not edit\./)
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.deepEqual(pkg.dependencies || {}, {})
  const installer = JSON.parse(readFileSync('../../package.json', 'utf8'))
  assert.deepEqual(installer.dependencies || {}, {})
})
