// Starts the real Codex app-servers the tests run, and stops everything each
// one started. Codex starts some processes in a session of their own, such as
// the login shell that takes a shell snapshot (codex-rs/core/src/shell_snapshot.rs,
// ProcessMode::NewSession, from rust-v0.160.0 to rust-v0.164.0), so neither the
// app-server's process group nor its exit reaches them. Every process an
// app-server starts inherits its TMPDIR, in whatever session it runs. So each
// app-server gets a folder of its own inside the test file's folder as its
// TMPDIR, and the folder's teardown stops, in turn: what the test names to stop
// first (such as the runtime a bridge started, through stopRuntime), the
// process group of each app-server started here, then every process that still
// carries the folder's mark (test/support/leftovers.js). The test fails only
// when one does not exit. The file-level hook in test/fixtures.js is unchanged:
// it still stops and names what a test file leaves running anywhere else.
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processInfo } from '../../src/core.js'
import { mkdtempSync, spawn, stopGroup } from '../fixtures.js'
import { processesIn, stopProcessesIn } from './leftovers.js'
import { cleanup } from './wait.js'

const TEMPORARY = ['TMPDIR', 'TMP', 'TEMP']
const named = list => list.map(({ pid, command }) => `${pid} (${command.length > 240 ? command.slice(0, 240) + '...' : command})`).join('; ')

// A folder for the app-servers of one test, with its teardown registered on `t`
// now: it runs after the cleanups registered before it and before those
// registered after it. `stop` stops what started an app-server elsewhere, such
// as a bridge's runtime; `env(base)` is `base` with the folder as its TMPDIR,
// for a runtime or a launcher that starts the app-server; `within(fn)` runs
// `fn` with the folder as this test process's own TMPDIR, for a bridge that
// starts its runtime from process.env; `start` starts
// `codex app-server --listen stdio://` there itself.
export function appServerFolder(t, { what = 'the app server', stop } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'a-'))
  const started = []
  cleanup(t, what, async hook => {
    // Every step runs even when an earlier one fails, so one failed stop leaves nothing else behind.
    const problems = []
    const step = async run => { try { await run() } catch (error) { problems.push(error.message) } }
    if (stop) await step(() => stop(hook))
    for (const app of started) if (app.pid) await step(() => stopGroup(app.pid))
    const { left, remaining, problems: stopping } = await stopProcessesIn(folder)
    problems.push(...stopping)
    if (left.length) hook.diagnostic(`${what}: its teardown stopped ${left.length} process(es) it started: ${named(left)}`)
    if (remaining?.length) problems.push(`still running in ${folder} after its teardown: ${named(remaining)}`)
    if (problems.length) throw new Error(problems.join('; '))
  }, { timeout: 30_000 })
  const env = (base = process.env) => ({ ...base, ...Object.fromEntries(TEMPORARY.map(name => [name, folder])) })
  return {
    folder,
    env,
    async within(fn) {
      const saved = TEMPORARY.map(name => [name, process.env[name]])
      Object.assign(process.env, env({}))
      try { return await fn() } finally { for (const [name, value] of saved) if (value === undefined) delete process.env[name]; else process.env[name] = value }
    },
    start(codexBin, { cwd, env: base = process.env } = {}) {
      const app = spawn(codexBin, ['app-server', '--listen', 'stdio://'], { cwd, env: env(base), stdio: ['pipe', 'pipe', 'pipe'] })
      started.push(app)
      return app
    },
  }
}

// One app-server in a folder of its own.
export const startAppServer = (t, codexBin, { what, stop, ...options } = {}) => appServerFolder(t, { what, stop }).start(codexBin, options)

// `base` with a HOME inside `root` whose shell startup files sleep 5 seconds,
// so every shell snapshot an app-server takes with it outlives a short test,
// and without what would point bash or zsh at other startup files. Codex's
// snapshot sources ~/.bashrc in bash and $ZDOTDIR/.zshrc or ~/.zshrc in zsh
// (codex-rs/shell-command/src/startup.rs), whichever shell the account uses.
export function slowShellEnv(root, base = process.env) {
  const home = join(root, 'slow-shell-home')
  mkdirSync(home)
  for (const name of ['.bashrc', '.zshrc']) writeFileSync(join(home, name), 'sleep 5\n')
  const env = { ...base, HOME: home }
  delete env.ZDOTDIR; delete env.BASH_ENV; delete env.ENV
  return env
}

// Whether a shell snapshot runs its startup file in `folder`: a process outside
// the process group of the app-server `pid`, started in a session of its own,
// with a child of its own, the startup file's command. When Codex ends, it
// kills only the shell it started, by its pid (Drop for NativeChild in
// codex-rs/utils/pty/src/posix_child.rs at rust-v0.162.0), so that command
// outlives it, and only the folder's teardown reaches it.
export function snapshotRunning(folder, pid) {
  const group = processInfo(pid)?.pgid
  const outside = processesIn(folder).filter(entry => processInfo(entry.pid)?.pgid !== group)
  const shells = new Set(outside.map(entry => entry.pid))
  return outside.some(entry => shells.has(processInfo(entry.pid)?.ppid))
}
