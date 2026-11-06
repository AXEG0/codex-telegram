import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mkdtempSync, spawn } from './fixtures.js'
import { closed, until } from './support/wait.js'

// test/support/operator.py drives a program in a real terminal. These tests run
// it as it is, with os.killpg refusing the signals they name with
// PermissionError, as Darwin refuses a signal to a group with no member it can
// signal, and with every signal sent and every reap of the child recorded on
// the helper's stderr.
const operator = fileURLToPath(new URL('./support/operator.py', import.meta.url))
const wrapper = `import os, runpy, signal, sys
refused = {getattr(signal, name) for name in sys.argv[1].split(',') if name}
killpg, waitpid = os.killpg, os.waitpid
def refusing_killpg(group, signum):
    name = signal.Signals(signum).name
    if signum in refused:
        sys.stderr.write(f'killpg {group} {name} refused\\n'); sys.stderr.flush()
        raise PermissionError(1, 'Operation not permitted')
    killpg(group, signum)
    sys.stderr.write(f'killpg {group} {name} sent\\n'); sys.stderr.flush()
def recording_waitpid(pid, options):
    found, status = waitpid(pid, options)
    if found:
        how = f'signal {os.WTERMSIG(status)}' if os.WIFSIGNALED(status) else f'exit {os.WEXITSTATUS(status)}'
        sys.stderr.write(f'reaped {found} {how}\\n'); sys.stderr.flush()
    return found, status
os.killpg, os.waitpid = refusing_killpg, recording_waitpid
sys.argv = sys.argv[2:]
runpy.run_path(sys.argv[0], run_name='__main__')
`
// The program in the terminal: it writes its pid to the file it is given; it
// ignores SIGHUP and SIGTERM when told to; then it either closes its terminal
// or says it is ready on it; then it runs for the seconds it is given and
// exits 0.
const program = `import os, signal, sys, time
with open(sys.argv[1], 'w') as record:
    record.write(str(os.getpid()))
if 'ignore' in sys.argv[2]:
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
if 'hangup' in sys.argv[2]:
    empty = os.open(os.devnull, os.O_RDWR)
    for descriptor in (0, 1, 2):
        os.dup2(empty, descriptor)
else:
    print('ready', flush=True)
time.sleep(float(sys.argv[3]))
`

function start(refused, mode, seconds) {
  const record = join(mkdtempSync(join(tmpdir(), 'operator-')), 'pid')
  const child = spawn('python3', ['-B', '-c', wrapper, refused.join(','), operator, 'python3', '-B', '-c', program, record, mode, String(seconds)], { stdio: ['pipe', 'pipe', 'pipe'] })
  const run = { child, record, stdout: '', stderr: '' }
  child.stdout.on('data', data => { run.stdout += data })
  child.stderr.on('data', data => { run.stderr += data })
  return run
}

async function finish(t, run) {
  await closed(t, run.child)
  return { code: run.child.exitCode, pid: Number(readFileSync(run.record, 'utf8')), stderr: run.stderr }
}

// Gives the helper's stdin its end once the program says it is ready, as a
// test's cleanup ends a terminal it opened.
async function endInput(t, run) {
  await until(t, () => run.stdout.includes('ready'), 'the program in the terminal to start')
  run.child.stdin.end()
}

function assertKilledAndReaped(result) {
  assert.notEqual(result.code, 0, result.stderr)
  assert.match(result.stderr, new RegExp(`child ${result.pid} was not reaped within 3 s, so it was killed by its pid`), result.stderr)
  assert.match(result.stderr, new RegExp(`^reaped ${result.pid} signal 9$`, 'm'), result.stderr)
  assert.throws(() => process.kill(result.pid, 0), error => error.code === 'ESRCH')
}

test('a child that closes its terminal and exits half a second later passes though the group signal is refused', { timeout: 30_000 }, async t => {
  const result = await finish(t, start(['SIGTERM', 'SIGKILL'], 'hangup', 0.5))
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stderr, new RegExp(`^reaped ${result.pid} exit 0$`, 'm'), result.stderr)
  assert.doesNotMatch(result.stderr, /^killpg /m, result.stderr)
})

test('a child that closes its terminal and runs on is killed by its pid, reaped, and fails the run', { timeout: 30_000 }, async t => {
  const result = await finish(t, start(['SIGTERM', 'SIGKILL'], 'hangup ignore', 600))
  assert.match(result.stderr, new RegExp(`^killpg ${result.pid} SIGTERM refused$`, 'm'), result.stderr)
  assertKilledAndReaped(result)
})

test('a running child whose group refuses SIGTERM after the input ends is killed by its pid, reaped, and fails the run', { timeout: 30_000 }, async t => {
  const run = start(['SIGTERM', 'SIGKILL'], 'ignore', 600)
  await endInput(t, run)
  const result = await finish(t, run)
  assert.match(result.stderr, new RegExp(`^killpg ${result.pid} SIGTERM refused$`, 'm'), result.stderr)
  assertKilledAndReaped(result)
})

test('a running child whose group takes SIGTERM and refuses SIGKILL is killed by its pid, reaped, and fails the run', { timeout: 30_000 }, async t => {
  const run = start(['SIGKILL'], 'ignore', 600)
  await endInput(t, run)
  const result = await finish(t, run)
  assert.match(result.stderr, new RegExp(`^killpg ${result.pid} SIGTERM sent\\nkillpg ${result.pid} SIGKILL refused$`, 'm'), result.stderr)
  assertKilledAndReaped(result)
})

test('a refused group signal waits for a child that ends on its own within the bound', { timeout: 30_000 }, async t => {
  const run = start(['SIGTERM', 'SIGKILL'], 'ready', 2)
  await endInput(t, run)
  const result = await finish(t, run)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stderr, new RegExp(`^killpg ${result.pid} SIGTERM refused$`, 'm'), result.stderr)
  assert.match(result.stderr, new RegExp(`^reaped ${result.pid} exit 0$`, 'm'), result.stderr)
})
