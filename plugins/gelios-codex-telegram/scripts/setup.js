#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultStateDir, parseEnvFile, processInfo } from '../src/core.js'
import { installLaunchers, pluginRoot } from '../src/bootstrap.js'
import { controlRequest, runUpdate } from './update.js'

function outsideCodex() {
  if (process.env.GELIOS_CODEX_CHILD === '1') return false
  for (let pid = process.ppid, depth = 0; pid > 1 && depth < 64; depth++) {
    const info = processInfo(pid); if (!info) break
    if (/^codex/i.test(info.name)) return false
    pid = info.ppid
  }
  return true
}
function executable(name) {
  const path = (process.env.PATH || '').split(delimiter).map(directory => join(directory, name)).find(path => {
    try { accessSync(path, constants.X_OK); return true } catch { return false }
  })
  if (!path) throw new Error(`${name} must be installed and on PATH`)
  return resolve(path)
}
function run(path, args) {
  const result = spawnSync(path, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${args[0] || path} exited with status ${result.status}`)
}

export async function setup(argv = process.argv.slice(2)) {
  argv = [...argv]
  let stateDir = defaultStateDir(), workspace = process.cwd(), prepare = false, noAltScreen = false, explicitState = false
  const extra = []
  while (argv.length) {
    const flag = argv.shift()
    if (flag === '--prepare') prepare = true
    else if (flag === '--yolo') continue
    else if (flag === '--no-alt-screen') noAltScreen = true
    else if (flag === '--state-dir' && argv[0]) { stateDir = resolve(argv.shift()); explicitState = true }
    else if (flag === '--workspace' && argv[0]) workspace = resolve(argv.shift())
    else if (['--codex-runtime-env', '--transcription-api-key-env', '--marketplace-auth-env'].includes(flag) && argv[0]) extra.push(flag, argv.shift())
    else throw new Error(`Unknown setup argument: ${flag}`)
  }
  const links = installLaunchers()
  const saved = existsSync(join(stateDir, 'launch-profile.json')) ? JSON.parse(readFileSync(join(stateDir, 'launch-profile.json'), 'utf8')) : null
  const controlSocket = saved?.controlSocket || (!explicitState && process.env.GELIOS_TELEGRAM_CONTROL_SOCKET) || join(stateDir, 'control.sock')
  let status
  try { status = await controlRequest(controlSocket, { action: 'status' }, 1000) }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error }
  if (prepare) {
    console.log(JSON.stringify({ launcher: links.launcher, stateDir, configured: status?.telegramConfigured ?? Boolean(process.env.TELEGRAM_BOT_TOKEN || parseEnvFile(join(stateDir, '.env')).TELEGRAM_BOT_TOKEN), running: Boolean(status), localSetupRequired: !status }))
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || !outsideCodex()) throw new Error('setup requires an interactive local terminal outside Codex; use --prepare for nonsecret setup information')
  const legacy = join(pluginRoot, 'bin', 'gelios-codex-telegram')
  if (status && !status.appRunning) throw new Error('the existing bridge has no running Codex backend; use status to inspect it before restarting')
  if (!status) {
    const existing = existsSync(join(stateDir, 'launch-profile.json'))
    const profile = existing ? JSON.parse(readFileSync(join(stateDir, 'launch-profile.json'), 'utf8')) : null
    const args = profile?.bridgeArgs || ['--state-dir', stateDir, '--workspace', workspace, '--codex-bin', executable('codex'), ...extra]
    process.env.GELIOS_TELEGRAM_LAUNCHER_LINK = profile?.launcherLink || links.managedLauncher
    run(legacy, ['bridge', '--detach', ...args])
    status = await controlRequest(controlSocket, { action: 'status' })
  }
  if (existsSync(join(stateDir, 'binding.json')) && !status.ready) {
    const deadline = Date.now() + 30_000
    while (!status.ready && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100)); status = await controlRequest(controlSocket, { action: 'status' })
    }
    if (!status.ready) throw new Error('the existing conversation has not finished restoring; setup did not replace it')
  }
  if (existsSync(join(stateDir, 'launch-profile.json'))) {
    const profile = JSON.parse(readFileSync(join(stateDir, 'launch-profile.json'), 'utf8'))
    const recorded = dirname(dirname(realpathSync(profile.launcherLink)))
    const previous = JSON.parse(readFileSync(join(recorded, '.codex-plugin', 'plugin.json'), 'utf8'))
    const current = JSON.parse(readFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'))
    if (previous.name !== current.name || previous.version !== current.version) {
      if (status.busy || status.tuiAttached) throw new Error('wait for the current turn to finish and exit the attached TUI before migrating this installation')
      await runUpdate({ stateDir }, { pluginRoot: recorded, targetPlugin: { name: 'telegram', marketplaceName: 'codex-telegram' } })
      status = await controlRequest(controlSocket, { action: 'status' })
    }
  }
  if (status.telegramConfigured === false) console.log('In Codex, invoke $telegram:configure with your BotFather token, then $telegram:access pair CODE. The token enters your local CLI conversation.')
  console.log('Paired Telegram users operate this Codex session with full filesystem access and no approval prompts.')
  run(legacy, ['tui', '--state-dir', stateDir, ...(noAltScreen ? ['--no-alt-screen'] : [])])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup().catch(error => { console.error(`codex-telegram setup: ${error.message}`); process.exitCode = 1 })
}
