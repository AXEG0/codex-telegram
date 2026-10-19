import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
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
  writeFileSync(join(root, 'bin/gelios-codex-telegram'), '', { mode: 0o700 })
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
  writeFileSync(join(directory, 'codex'), `#!/usr/bin/env node\nif(process.argv[2]==='completion'){console.log('        codex)\\n            opts="--help [PROMPT] resume fork"\\n        codex__resume)')}else{console.log('Codex CLI')}\n`, { mode: 0o700 })
  const help = spawnSync(process.execPath, [command, '--help'], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /Codex CLI/)
  const links = installLaunchers({ root: fix.root, directory, stateDir: join(fix.codexHome, 'state') })
  assert.equal(links.launcher, command)
  assert.equal(readlinkSync(command), installer)
  assert.equal(readlinkSync(links.managedLauncher), join(links.root, 'bin/gelios-codex-telegram'))
})

function updateFixture(mode = 'success') {
  const fix = installation(), directory = join(fix.codexHome, 'tools'), state = join(fix.codexHome, 'state')
  mkdirSync(directory); mkdirSync(state, { mode: 0o700 })
  const upgraded = join(fix.codexHome, 'upgraded'), calls = join(fix.codexHome, 'calls'), launched = join(fix.codexHome, 'launched')
  const next = join(fix.codexHome, 'plugins/cache/codex-telegram/telegram/0.4.3')
  mkdirSync(join(next, '.codex-plugin'), { recursive: true }); mkdirSync(join(next, 'bin'))
  writeFileSync(join(next, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'telegram', version: '0.4.3' }))
  writeFileSync(join(next, 'bin/codex-telegram'), `require('node:fs').writeFileSync(${JSON.stringify(launched)},JSON.stringify(process.argv.slice(2)))`)
  writeFileSync(join(fix.root, 'bin/codex-telegram'), 'throw new Error("BROKEN_OLD_UPDATER")')
  writeFileSync(join(state, 'launch-profile.json'), JSON.stringify({ marketplaceAuthEnv: 'TEST_MARKET_AUTH', transcriptionApiKeyEnv: 'TEST_AUDIO_KEY' }), { mode: 0o600 })
  writeFileSync(join(directory, 'codex'), `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,auth:process.env.GH_TOKEN,audio:process.env.TEST_AUDIO_KEY,runtime:process.env.TEST_RUNTIME_KEY,bot:process.env.TELEGRAM_BOT_TOKEN})+'\\n');
if(args.join(' ')==='plugin marketplace upgrade codex-telegram --json'){
  if(${JSON.stringify(mode)}==='exit'){console.error(process.env.GH_TOKEN);process.exit(73)}
  fs.writeFileSync(${JSON.stringify(upgraded)},'yes');console.log(JSON.stringify({errors:${mode === 'errors' ? '["failed"]' : '[]'},selectedMarketplaces:['codex-telegram'],upgradedRoots:['fixture']}));
}else if(args.join(' ')==='plugin list --json')console.log(JSON.stringify({installed:[{name:'telegram',marketplaceName:'codex-telegram',enabled:true,version:fs.existsSync(${JSON.stringify(upgraded)})?'0.4.3':'0.4.2'}]}));else process.exit(74)
`, { mode: 0o700 })
  const env = { ...process.env, HOME: fix.codexHome, CODEX_HOME: fix.codexHome, PATH: `${directory}:${process.env.PATH}`, GELIOS_CODEX_CHILD: '',
    TEST_MARKET_AUTH: 'fixture-market-auth', TEST_AUDIO_KEY: 'fixture-audio', TEST_RUNTIME_KEY: 'fixture-runtime', TELEGRAM_BOT_TOKEN: 'fixture-bot' }
  const command = args => spawnSync(process.execPath, [fileURLToPath(new URL('../../../launcher.js', import.meta.url)), ...args], { env, encoding: 'utf8' })
  return { ...fix, state, env, calls, launched, command }
}

test('update replaces a broken installed updater before resolving it and scopes refresh credentials', () => {
  const fix = updateFixture(), result = fix.command(['update', '--state-dir', fix.state])
  assert.equal(result.status, 0, result.stderr)
  const calls = readFileSync(fix.calls, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(calls.map(call => call.args), [['plugin', 'marketplace', 'upgrade', 'codex-telegram', '--json'], ['plugin', 'list', '--json']])
  assert.equal(calls[0].auth, fix.env.TEST_MARKET_AUTH); assert.equal(calls[1].auth, undefined)
  for (const call of calls) for (const name of ['audio', 'runtime', 'bot']) assert.equal(call[name], undefined)
  assert.deepEqual(JSON.parse(readFileSync(fix.launched)).slice(0, 3), ['update', '--state-dir', fix.state])
})

test('failed or incomplete native refresh never dispatches an installed updater or reveals its credential', () => {
  for (const mode of ['exit', 'errors']) {
    const fix = updateFixture(mode), result = fix.command(['telegram', 'update', '--state-dir', fix.state])
    assert.equal(result.status, 1); assert.match(result.stderr, /marketplace refresh/)
    assert.doesNotMatch(result.stderr, /fixture-market-auth|BROKEN_OLD_UPDATER/)
    assert.equal(existsSync(fix.launched), false)
    assert.equal(readFileSync(fix.calls, 'utf8').trim().split('\n').length, 1)
  }
})

test('update rejects in-Codex calls, invalid arguments, aliased credentials and non-private profiles before refresh', () => {
  const fix = updateFixture()
  for (const args of [['update', '--unknown'], ['update', '--state-dir']]) assert.equal(fix.command(args).status, 1)
  fix.env.GELIOS_CODEX_CHILD = '1'
  assert.match(fix.command(['update', '--state-dir', fix.state]).stderr, /parent terminal/)
  fix.env.GELIOS_CODEX_CHILD = ''; fix.env.TEST_MARKET_AUTH = fix.env.TEST_AUDIO_KEY
  assert.match(fix.command(['update', '--state-dir', fix.state]).stderr, /aliased marketplace credential/)
  fix.env.TEST_MARKET_AUTH = 'fixture-market-auth'; chmodSync(join(fix.state, 'launch-profile.json'), 0o644)
  assert.match(fix.command(['update', '--state-dir', fix.state]).stderr, /owner-only/)
  assert.equal(existsSync(fix.calls), false)
})
