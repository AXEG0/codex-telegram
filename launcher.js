#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeInvocation, nativeMetadata, recoveryUpdater, runNative } from './plugins/gelios-codex-telegram/src/native-cli.js'

const nativeEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_(ALL|CTYPE|MESSAGES)|TZ|CODEX_HOME|XDG_(CONFIG_HOME|CACHE_HOME|DATA_HOME|STATE_HOME|RUNTIME_DIR)|TMPDIR|TMP|TEMP|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|GIT_SSL_CAINFO|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(name)))
export function resolveLauncher({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), run = args => JSON.parse(execFileSync('codex', [...args, '--json'], { env: nativeEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })) } = {}) {
  const result = run(['plugin', 'list'])
  if (!Array.isArray(result.installed)) throw new Error('Codex returned an invalid installed-plugin list')
  const candidates = result.installed.filter(item => item.name === 'telegram' && item.marketplaceName === 'codex-telegram')
  if (candidates.length === 0) throw new Error('Install telegram@codex-telegram using the native Codex plugin commands before launching')
  if (candidates.length !== 1) throw new Error('Expected exactly one installed telegram@codex-telegram plugin')
  const selected = candidates[0]
  if (!selected.enabled) throw new Error('telegram@codex-telegram is disabled; enable it in Codex before launching')
  if (!/^[A-Za-z0-9._+-]+$/.test(selected.version)) throw new Error('Invalid installed plugin version')
  const cache = join(codexHome, 'plugins/cache', 'codex-telegram', 'telegram', selected.version)
  const path = existsSync(cache) ? cache : selected.marketplaceSource?.sourceType === 'local' ? selected.source?.path : cache
  const root = realpathSync(path), manifest = JSON.parse(readFileSync(join(root, '.codex-plugin/plugin.json'), 'utf8'))
  if (manifest.name !== 'telegram' || manifest.version !== selected.version) throw new Error('Installed plugin identity mismatch')
  const launcher = join(root, 'bin/codex-telegram')
  if (!existsSync(launcher)) throw new Error('The installed plugin has no guided launcher; update telegram@codex-telegram before launching')
  return launcher
}

function refreshMarketplace(state) {
  const env = nativeEnvironment()
  const path = join(state, 'launch-profile.json')
  let profile = {}
  if (existsSync(path)) {
    const file = lstatSync(path), directory = lstatSync(state)
    if (!file.isFile() || file.mode & 0o077 || directory.isSymbolicLink() || directory.mode & 0o077 ||
        (process.getuid && (file.uid !== process.getuid() || directory.uid !== process.getuid()))) throw new Error('Update launch profile must be owner-only')
    profile = JSON.parse(readFileSync(path, 'utf8'))
  }
  const slot = profile.marketplaceAuthEnv
  if (slot && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(slot)) throw new Error('Invalid marketplace authentication slot')
  const key = slot ? process.env[slot] : process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (slot && !key) throw new Error('Marketplace authentication slot is unavailable')
  if (key && (/[\u0000-\u001f\u007f]/.test(key) || [process.env.TELEGRAM_BOT_TOKEN, process.env[profile.transcriptionApiKeyEnv]].filter(Boolean).includes(key))) throw new Error('Invalid or aliased marketplace credential')
  if (key) env.GH_TOKEN = key
  let result
  try { result = JSON.parse(execFileSync('codex', ['plugin', 'marketplace', 'upgrade', 'codex-telegram', '--json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })) }
  catch { throw new Error('Codex marketplace refresh failed; no updater was started') }
  if (!Array.isArray(result.errors) || result.errors.length || !result.selectedMarketplaces?.includes('codex-telegram') || !Array.isArray(result.upgradedRoots)) throw new Error('Codex marketplace refresh did not complete cleanly; no updater was started')
}

export async function launch(argv = process.argv.slice(2)) {
  const args = [...argv]
  if (args[0] === 'telegram' && args[1] === 'update') args.shift()
  if (args[0] === 'update') {
    if (args.slice(1).some(arg => ['--help', '-h'].includes(arg))) { console.log('Usage: codex-telegram update [--state-dir PATH]\nUpdate Codex CLI, the Telegram plugin and launcher; preserve the existing conversation.'); return 0 }
    if (args.length !== 1 && !(args.length === 3 && args[1] === '--state-dir' && args[2])) throw new Error('Usage: codex-telegram update [--state-dir PATH]')
    if (process.env.GELIOS_CODEX_CHILD === '1') throw new Error('run update from the parent terminal, not from inside Codex')
    const state = resolve(args[2] || process.env.GELIOS_TELEGRAM_STATE_DIR || join(homedir(), '.local/state/gelios-codex-telegram'))
    const recovery = recoveryUpdater(state), root = dirname(fileURLToPath(import.meta.url))
    if (recovery) return runNative(process.execPath, [recovery, '--all', '--installer-root', root, ...args.slice(1)])
    refreshMarketplace(state)
    return runNative(process.execPath, [resolveLauncher(), ...args, '--installer-root', root])
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { const code = await runNative('codex', args); console.log('\nWrapper commands: codex-telegram update updates Codex, plugin and launcher together; codex-telegram telegram manages the bridge.'); return code }
  const invocation = args[0] !== 'telegram' ? nativeInvocation(args, nativeMetadata()) : null
  if (invocation?.command === 'update') throw new Error('Use codex-telegram update [--state-dir PATH] for the combined updater; use codex update for native update options')
  if (invocation && !invocation.interactive) return runNative('codex', args)
  const launcher = resolveLauncher()
  return runNative(process.execPath, [launcher, ...args])
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launch().then(code => { process.exitCode = code }).catch(error => { console.error(`codex-telegram: ${error.message}`); process.exitCode = 1 })
}
