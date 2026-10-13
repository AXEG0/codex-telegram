import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultStateDir } from './core.js'
import { requestControl } from './control.js'
import { installLaunchers } from './bootstrap.js'

export const nativeServerSocket = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock')
export async function ensureNativeBridge({ cwd, stateDir = defaultStateDir() }) {
  const profilePath = join(stateDir, 'launch-profile.json')
  const saved = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, 'utf8')) : null
  const controlSocket = saved?.controlSocket || join(stateDir, 'control.sock')
  try {
    const status = await requestControl(controlSocket, 'status')
    if (!status.nativeRuntime) throw new Error('the running installation requires native-runtime migration before this terminal can attach')
    return { controlSocket, status }
  } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error }
  const socket = nativeServerSocket()
  if (!existsSync(socket)) throw new Error('the native shared Codex server is unavailable; this entry flow requires codex --yolo with its shared server enabled')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const codex = (process.env.PATH || '').split(delimiter).map(directory => join(directory, 'codex')).find(path => existsSync(path))
  if (!codex) throw new Error('Codex must be installed on PATH')
  const args = saved?.bridgeArgs ? [...saved.bridgeArgs] : ['--state-dir', stateDir, '--workspace', resolve(cwd), '--codex-bin', realpathSync(codex)]
  if (!args.includes('--native-server')) args.push('--native-server', socket)
  const child = spawn(process.execPath, [join(root, 'scripts/bridge.js'), '--detach', ...args], {
    env: { ...process.env, GELIOS_TELEGRAM_LAUNCHER_LINK: installLaunchers().managedLauncher }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let error = ''; child.stdout.resume(); child.stderr.on('data', part => { error = (error + part).slice(-16_384) })
  await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error(error || 'native Telegram bridge could not start'))) })
  const status = await requestControl(controlSocket, 'status')
  if (!status.nativeRuntime) throw new Error('another installation owns the Telegram controller')
  return { controlSocket, status }
}
