import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const runtimeFiles = ['bin/gelios-codex-telegram', ...['src', 'scripts'].flatMap(dir =>
  readdirSync(dir).filter(name => name.endsWith('.js')).map(name => `${dir}/${name}`))]

test('runtime stays within 5,200 physical lines with zero dependencies', () => {
  const lines = runtimeFiles.reduce((total, path) => total + readFileSync(path, 'utf8').split('\n').length - 1, 0)
  assert.ok(lines <= 5200, `runtime is ${lines} lines`)
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.deepEqual(pkg.dependencies || {}, {})
})
