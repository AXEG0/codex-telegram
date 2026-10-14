import { spawn, execFileSync } from 'node:child_process'
import { requestControl } from './control.js'
import { join } from 'node:path'
import { nativeInvocation, nativeMetadata, nativeYoloIndices } from './native-cli.js'

export function nativeTuiArgs(status, original, metadata, { continuing = false, cwd = process.cwd(), managedYolo = false } = {}) {
  const invocation = nativeInvocation(original, metadata)
  const options = [], values = new Map()
  for (let i = 0; i < original.length; i++) {
    const word = original[i]
    if (word === '--') break
    if (!word.startsWith('-')) continue
    const name = word.startsWith('--') ? word.split('=')[0] : word.slice(0, 2)
    const value = word.startsWith('--') && word.includes('=') ? word.slice(word.indexOf('=') + 1)
      : metadata.values.has(name) ? (word.length > 2 && !word.startsWith('--') ? word.slice(2) : original[++i]) : null
    values.set(name, value)
    if (metadata.options.has(name) && !['-i', '--image', '--worktree', '--yolo', '--dangerously-bypass-approvals-and-sandbox', '-s', '--sandbox', '-a', '--ask-for-approval', '--approve-for-me', '--remote', '--remote-auth-token-env'].includes(name)) {
      options.push(word)
      if (metadata.values.has(name) && !word.includes('=') && (word.startsWith('--') || word.length === 2)) options.push(value)
    }
  }
  if (values.has('--remote') || values.has('--remote-auth-token-env')) throw new Error('An explicit remote endpoint cannot be combined with the managed Telegram connection')
  const hasCwd = values.has('-C') || values.has('--cd')
  const prefix = ['--remote', `unix://${status.socket}`, ...(hasCwd ? [] : ['-C', cwd])]
  if (continuing) return [...prefix, ...options, 'resume', status.threadId]
  const yoloIndices = new Set(managedYolo ? nativeYoloIndices(original, metadata) : [])
  const args = original.filter((_, index) => !yoloIndices.has(index))
  if (!invocation.command && invocation.promptIndex < 0 && status.threadId) {
    const filtered = args
    const position = filtered.indexOf('--')
    filtered.splice(position < 0 ? filtered.length : position, 0, 'resume', status.threadId)
    return [...prefix, ...filtered]
  }
  return [...prefix, ...args]
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
// Only the native UI process is replaced when another interface selects a thread.
// The app-server, conversation history, credentials and running agent remain owned
// by the bridge. No keyboard commands or synthetic protocol notifications are used.
export async function runSharedTui({ stateDir, noAltScreen = false, nativeArgs, signal }, {
  control = request => requestControl(process.env.GELIOS_TELEGRAM_CONTROL_SOCKET || join(stateDir, 'control.sock'), request.action, request.args), launch = spawn,
  terminal = process.stdin, output = process.stdout,
  terminalMode = () => execFileSync('stty', ['-g'], { stdio: [0, 'pipe', 'ignore'], encoding: 'utf8' }).trim(),
  restoreMode = mode => execFileSync('stty', [mode], { stdio: [0, 'ignore', 'ignore'] }),
  pollMs = 150,
} = {}) {
  if (!terminal.isTTY || !output.isTTY) throw new Error('tui requires an interactive terminal')
  let status = await control({ action: 'status' })
  if (status.tuiAttached) throw new Error('this bridge already has an attached TUI')
  const mode = terminalMode()
  const metadata = nativeArgs ? nativeMetadata(status.codexBin) : null
  const managedYolo = Boolean(nativeArgs && nativeYoloIndices(nativeArgs, metadata).length)
  if (nativeArgs) nativeTuiArgs(status, nativeArgs, metadata)
  let continuing = false
  while (true) {
    const launched = status
    const prepared = nativeArgs ? await control({ action: 'prepare_tui_launch', args: { yolo: managedYolo } }) : null
    const args = nativeArgs ? nativeTuiArgs({ ...status, socket: prepared.socket }, nativeArgs, metadata, { continuing, managedYolo })
      : ['--remote', `unix://${status.socket}`, ...(noAltScreen ? ['--no-alt-screen'] : []), '-C', status.workspace, ...(status.threadId ? ['resume', status.threadId] : [])]
    const child = launch(status.codexBin, args, { cwd: status.workspace, stdio: 'inherit' })
    let finished = false, switching = false, polling = false, cancelled = false, killing = false, killTimer
    const stop = () => {
      if (finished || killing) return
      killing = true; child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
    }
    const abort = () => { cancelled = true; stop() }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setInterval(async () => {
      if (polling || finished) return
      polling = true
      try {
        status = await control({ action: 'status' })
        if ((status.tuiAttached && status.threadId !== status.tuiThreadId) || status.instanceId !== launched.instanceId) {
          switching = true; stop()
        }
      } catch { /* The native UI handles an ordinary temporary transport loss. */ }
      finally { polling = false }
    }, pollMs)
    let code
    try {
      code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (value, signal) => resolve(value ?? (switching ? 0 : signal ? 1 : 0)))
      })
    } finally {
      finished = true; clearInterval(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort)
      if (prepared) await control({ action: 'release_tui_launch', args: { token: prepared.token } }).catch(() => {})
      restoreMode(mode)
      // SIGTERM does not run Rust's terminal guard; restore terminal presentation
      // after this frontend only. The parent's terminal settings are preserved.
      if (killing) output.write('\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h' + (noAltScreen ? '' : '\x1b[?1049l'))
    }
    if (cancelled) return 1
    if (!switching) return code
    continuing = true
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) return 1
      try {
        status = await control({ action: 'status' })
        if (!status.tuiAttached && status.ready) break
      } catch (error) { if (attempt >= 100) throw error }
      if (attempt >= 100) throw new Error('the shared session did not release the previous TUI')
      await wait(pollMs)
    }
  }
}
