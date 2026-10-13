#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  if (['--help', 'help'].includes(args[0])) {
    console.log('Usage: codex-telegram [--yolo] [setup|start|configure|access|status|update|heartbeat|tui|bridge] [arguments]\nInstall telegram@codex-telegram through native Codex commands first. Setup starts the shared terminal/Telegram conversation.')
    return 0
  }
  const launcher = resolveLauncher()
  const child = spawn(process.execPath, [launcher, ...args], { stdio: 'inherit' })
  return await new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('exit', code => accept(code ?? 1))
  })
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launch().then(code => { process.exitCode = code }).catch(error => { console.error(`codex-telegram: ${error.message}`); process.exitCode = 1 })
}
