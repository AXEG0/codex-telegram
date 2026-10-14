import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mkdtempSync } from './fixtures.js'
import { nativeInvocation, nativeMetadata } from '../src/native-cli.js'
import { nativeTuiArgs } from '../src/tui.js'

const codex = process.env.GELIOS_REAL_CODEX_BIN || 'codex'
let metadata
try { metadata = nativeMetadata(codex) } catch {}
const dispatcher = fileURLToPath(new URL('../../../launcher.js', import.meta.url))

test('native command discovery preserves aliases, option values and explicit prompts', { skip: !metadata }, () => {
  for (const args of [['update'], ['plugin', 'list'], ['e', 'prompt'], ['--model', 'resume', 'exec', 'prompt'], ['-Csomewhere', 'login']]) assert.equal(nativeInvocation(args, metadata).interactive, false)
  for (const args of [[], ['--yolo'], ['resume', '--last'], ['--model=example', 'fork', '--last'], ['--', 'update'], ['a prompt with spaces']]) assert.equal(nativeInvocation(args, metadata).interactive, true)
  for (const args of [['resume', '--help'], ['--help'], ['-V'], ['--unknown-native-option']]) assert.equal(nativeInvocation(args, metadata).interactive, false)
})

test('native commands keep native output, errors and exit codes without plugin setup', { skip: !metadata }, () => {
  const root = mkdtempSync(join(tmpdir(), 'native-forward-')), env = { ...process.env, HOME: root, CODEX_HOME: join(root, 'codex'), GELIOS_TELEGRAM_LAUNCHER_DIR: join(root, 'bin') }
  for (const args of [['--version'], ['plugin', 'list', '--json'], ['resume', '--help'],  ['exec', '--help'], ['--unknown-native-option']]) {
    const expected = spawnSync(codex, args, { env, encoding: 'utf8' })
    const actual = spawnSync(process.execPath, [dispatcher, ...args], { env, encoding: 'utf8' })
    assert.equal(actual.status, expected.status, actual.stderr)
    assert.equal(actual.stdout, expected.stdout)
    assert.equal(actual.stderr, expected.stderr)
  }
})

test('future native commands are delegated with literal arguments and their own exit code', { skip: !metadata }, () => {
  const root = mkdtempSync(join(tmpdir(), 'future-native-')), directory = join(root, 'bin'); mkdirSync(directory)
  const output = join(root, 'argv.json'), completion = execFileSync(codex, ['completion', 'bash'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).replace('[PROMPT] agents', '[PROMPT] future-native agents')
  writeFileSync(join(directory, 'codex'), `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a[0]==='completion'){process.stdout.write(${JSON.stringify(completion)});}else{fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(a));process.exitCode=73;}\n`, { mode: 0o700 })
  const args = ['-c', 'custom="a b"', 'future-native', 'a $HOME `literal`', '--new-option=value']
  const result = spawnSync(process.execPath, [dispatcher, ...args], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CODEX_HOME: join(root, 'empty') }, encoding: 'utf8' })
  assert.equal(result.status, 73, result.stderr); assert.deepEqual(JSON.parse(readFileSync(output)), args)
})

test('managed startup preserves native selection and never replays a fork or prompt', { skip: !metadata }, () => {
  const status = { socket: '/private/app.sock', threadId: 'selected', permissions: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } }
  assert.deepEqual(nativeTuiArgs(status, ['resume', '--last'], metadata, { cwd: '/project' }), ['--remote', 'unix:///private/app.sock', '-C', '/project', 'resume', '--last'])
  assert.deepEqual(nativeTuiArgs(status, ['--yolo'], metadata, { cwd: '/project', managedYolo: true }), ['--remote', 'unix:///private/app.sock', '-C', '/project', 'resume', 'selected'])
  const args = ['-m', 'a model', 'fork', '--last', 'first prompt']
  const continued = nativeTuiArgs(status, args, metadata, { continuing: true, cwd: '/project' })
  assert.equal(continued.includes('fork'), false); assert.equal(continued.includes('first prompt'), false); assert.deepEqual(continued.slice(-2), ['resume', 'selected']); assert.ok(continued.includes('a model'))
  assert.throws(() => nativeTuiArgs(status, ['--remote', 'unix:///other.sock'], metadata), /explicit remote endpoint/)
  const readonly = { ...status, permissions: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } } }
  assert.ok(nativeTuiArgs(readonly, ['--yolo'], metadata).includes('--yolo'), 'a mismatched policy must reach native validation rather than being silently discarded')
})


test('combined update help is available without Codex or plugin discovery', () => {
  for (const command of [['update'], ['telegram', 'update']]) {
  const result = spawnSync(process.execPath, [dispatcher, ...command, '--help'], { env: { PATH: '', HOME: tmpdir() }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Codex CLI, the Telegram plugin and launcher/)
  }
})
