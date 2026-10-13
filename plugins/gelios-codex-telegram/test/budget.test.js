import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const runtimeFiles = [...(existsSync('../../launch.sh') ? ['../../launch.sh'] : []), 'bin/gelios-codex-telegram', 'bin/codex-telegram', ...['src', 'scripts'].flatMap(dir =>
  readdirSync(dir).filter(name => name.endsWith('.js')).map(name => `${dir}/${name}`))]

test('runtime stays within 6,000 physical lines with zero dependencies', () => {
  const lines = runtimeFiles.reduce((total, path) => total + readFileSync(path, 'utf8').split('\n').length - 1, 0)
  assert.ok(lines <= 6000, `runtime is ${lines} lines`)
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.deepEqual(pkg.dependencies || {}, {})
})
