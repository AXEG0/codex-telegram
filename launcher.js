#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeInvocation, nativeMetadata, recoveryUpdater, runNative } from './plugins/gelios-codex-telegram/src/native-cli.js'

export function resolveLauncher({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), run = args => JSON.parse(execFileSync('codex', [...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })) } = {}) {
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

export async function launch(argv = process.argv.slice(2)) {
  const args = [...argv]
  if (args[0] === 'update') {
    if (args.slice(1).some(arg => ['--help', '-h'].includes(arg))) { console.log('Usage: codex-telegram update [--state-dir PATH]\nUpdate Codex CLI, the Telegram plugin and launcher; preserve the existing conversation.'); return 0 }
    const index = args.indexOf('--state-dir')
    if (index >= 0 && !args[index + 1]) throw new Error('Usage: codex-telegram update [--state-dir PATH]')
    const state = resolve(index >= 0 ? args[index + 1] : process.env.GELIOS_TELEGRAM_STATE_DIR || join(homedir(), '.local/state/gelios-codex-telegram'))
    const recovery = recoveryUpdater(state), root = dirname(fileURLToPath(import.meta.url))
    return recovery ? runNative(process.execPath, [recovery, '--all', '--installer-root', root, ...args.slice(1)])
      : runNative(process.execPath, [resolveLauncher(), ...args, '--installer-root', root])
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
