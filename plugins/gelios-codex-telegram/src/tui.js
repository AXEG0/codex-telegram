import { spawn, execFileSync } from 'node:child_process'
import { requestControl } from './control.js'
import { join } from 'node:path'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
// Only the native UI process is replaced when another interface selects a thread.
// The app-server, conversation history, credentials and running agent remain owned
// by the bridge. No keyboard commands or synthetic protocol notifications are used.
export async function runSharedTui({ stateDir, noAltScreen = false, signal }, {
  control = request => requestControl(process.env.GELIOS_TELEGRAM_CONTROL_SOCKET || join(stateDir, 'control.sock'), request.action), launch = spawn,
  terminal = process.stdin, output = process.stdout,
  terminalMode = () => execFileSync('stty', ['-g'], { stdio: [0, 'pipe', 'ignore'], encoding: 'utf8' }).trim(),
  restoreMode = mode => execFileSync('stty', [mode], { stdio: [0, 'ignore', 'ignore'] }),
  pollMs = 150,
} = {}) {
  if (!terminal.isTTY || !output.isTTY) throw new Error('tui requires an interactive terminal')
  let status = await control({ action: 'status' })
  if (status.tuiAttached) throw new Error('this bridge already has an attached TUI')
  const mode = terminalMode()
  while (true) {
    const launched = status
    const args = ['--remote', `unix://${status.socket}`, ...(noAltScreen ? ['--no-alt-screen'] : []),
      '-C', status.workspace, ...(status.threadId ? ['resume', status.threadId] : [])]
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
      restoreMode(mode)
      // SIGTERM does not run Rust's terminal guard; restore terminal presentation
      // after this frontend only. The parent's terminal settings are preserved.
      if (killing) output.write('\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h' + (noAltScreen ? '' : '\x1b[?1049l'))
    }
    if (cancelled) return 1
    if (!switching) return code
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
