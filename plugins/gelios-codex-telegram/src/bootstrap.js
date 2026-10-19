import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pinBuild } from './builds.js'
import { defaultStateDir } from './core.js'

export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// This inline entry point and its cwd survive deletion of the native plugin cache.
export const mcpBootstrap = `import net from 'node:net';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const state = process.env.GELIOS_TELEGRAM_STATE_DIR || join(homedir(), '.local/state/gelios-codex-telegram');
const root = process.env.GELIOS_TELEGRAM_MCP_ROOT || await new Promise((resolve, reject) => {
  const socket = net.createConnection(process.env.GELIOS_TELEGRAM_CONTROL_SOCKET || join(state, 'control.sock'));
  const timer = setTimeout(() => socket.destroy(new Error('Telegram build selection timed out')), 1000);
  let buffer = '';
  socket.setEncoding('utf8'); socket.on('error', reject); socket.on('close', () => { clearTimeout(timer); reject(new Error('Telegram build selection closed')); });
  socket.on('connect', () => socket.write(JSON.stringify({ action: 'status' }) + '\\n'));
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 1048576) { socket.destroy(new Error('Telegram build selection is too large')); return; }
    if (!buffer.includes('\\n')) return;
    socket.end();
    try { const response = JSON.parse(buffer.split('\\n')[0]); if (!response.ok) throw new Error(response.error); resolve(response.result.pluginRoot); }
    catch (error) { reject(error); }
  });
});
if (!root || !isAbsolute(root)) throw new Error('Start Codex with codex-telegram to select its durable Telegram build');
const selected = realpathSync(root), cache = join(realpathSync(process.env.CODEX_HOME || join(homedir(), '.codex')), 'plugins/cache');
if (selected === cache || selected.startsWith(cache + sep)) throw new Error('Telegram MCP must run outside the Codex plugin cache');
await import(pathToFileURL(join(selected, 'scripts/mcp.js')).href);`
const identities = new Set(['telegram', 'gelios-codex-telegram'])

export function installLaunchers({ root = pluginRoot, directory = process.env.GELIOS_TELEGRAM_LAUNCHER_DIR || join(homedir(), '.local', 'bin'), stateDir = defaultStateDir() } = {}) {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('launcher directory must be owned by you and not writable by other users')
  }
  root = pinBuild(root, stateDir).root
  for (const name of ['codex-telegram', 'gelios-codex-telegram']) {
    const path = join(directory, name), target = join(root, 'bin', name)
    let entry
    try { entry = lstatSync(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (entry) {
      if (!entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid())) throw new Error(`${path} already belongs to another program`)
      if (name === 'codex-telegram') {
        // Keep the npm entry point: it resolves the current native package on
        // every launch, instead of pinning this link to one cache version.
        try {
          const selected = realpathSync(path)
          const installer = JSON.parse(readFileSync(join(dirname(selected), 'package.json'), 'utf8'))
          if (basename(selected) === 'launcher.js' && installer.name === '@axeg0/codex-telegram' && installer.bin?.['codex-telegram'] === 'launcher.js') continue
        } catch {}
      }
      let previous
      try { previous = JSON.parse(readFileSync(join(dirname(dirname(realpathSync(path))), '.codex-plugin', 'plugin.json'), 'utf8')) } catch {}
      // Native upgrades prune old package caches; recover only a recognizable
      // dangling plugin launcher owned by the same user.
      const oldRoot = dirname(dirname(resolve(directory, readlinkSync(path))))
      const missingTarget = !existsSync(path) && !previous && (identities.has(basename(oldRoot)) || identities.has(basename(dirname(oldRoot))))
      if (!identities.has(previous?.name) && !missingTarget) throw new Error(`${path} already belongs to another program`)
      if (resolve(directory, readlinkSync(path)) === target) continue
      // A usable managed launcher changes only through the transactional updater.
      if (name === 'gelios-codex-telegram' && !missingTarget) continue
    }
    const temporary = `${path}.tmp-${process.pid}`
    try { symlinkSync(target, temporary); renameSync(temporary, path) }
    finally { try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  }
  return { root, launcher: join(directory, 'codex-telegram'), managedLauncher: join(directory, 'gelios-codex-telegram') }
}
