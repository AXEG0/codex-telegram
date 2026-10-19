#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defaultStateDir, parseEnvFile, processInfo } from '../src/core.js'
import { installLaunchers } from '../src/bootstrap.js'
import { controlRequest } from './update.js'
import { nativeInvocation, nativeMetadata, runNative } from '../src/native-cli.js'

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
  const nativeArgs = argv[0] === '--native' ? argv.splice(0).slice(1) : null
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
  const links = installLaunchers({ stateDir })
  const { runUpdate } = await import(pathToFileURL(join(links.root, 'scripts/update.js')).href)
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
  const legacy = join(links.root, 'bin', 'gelios-codex-telegram')
  if (status && !status.appRunning) throw new Error('the existing bridge has no running Codex backend; use status to inspect it before restarting')
  if (!status) {
    const existing = existsSync(join(stateDir, 'launch-profile.json'))
    const profile = existing ? JSON.parse(readFileSync(join(stateDir, 'launch-profile.json'), 'utf8')) : null
    const args = profile?.bridgeArgs || ['--state-dir', stateDir, '--workspace', workspace, '--codex-bin', executable('codex'), ...extra]
    process.env.GELIOS_TELEGRAM_LAUNCHER_LINK = profile?.launcherLink || links.managedLauncher
    const selection = nativeArgs && nativeInvocation(nativeArgs, nativeMetadata(executable('codex')))
    const deferBinding = selection && (selection.command || selection.promptIndex >= 0)
    run(legacy, ['bridge', '--detach', ...args, ...(deferBinding ? ['--defer-binding-resume'] : [])])
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
    const current = JSON.parse(readFileSync(join(links.root, '.codex-plugin', 'plugin.json'), 'utf8'))
    if (status.pluginVersion !== current.version || status.pluginRoot !== links.root) {
      if (status.busy || status.tuiAttached) throw new Error('wait for the current turn to finish and exit the attached TUI before migrating this installation')
      await runUpdate({ stateDir, installed: true }, { targetPlugin: { name: 'telegram', marketplaceName: 'codex-telegram' } })
      status = await controlRequest(controlSocket, { action: 'status' })
    }
  }
  if (status.telegramConfigured === false) console.log('In Codex, invoke $telegram:configure with your BotFather token, then $telegram:access pair CODE. The token enters your local CLI conversation.')
  console.log('Paired Telegram users share this Codex conversation. --yolo selects full filesystem access and no approval prompts.')
  return runNative(legacy, ['tui', '--state-dir', stateDir, ...(noAltScreen ? ['--no-alt-screen'] : []), ...(nativeArgs ? ['--', ...nativeArgs] : [])])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup().then(code => { process.exitCode = code ?? 0 }).catch(error => { console.error(`codex-telegram setup: ${error.message}`); process.exitCode = 1 })
}
