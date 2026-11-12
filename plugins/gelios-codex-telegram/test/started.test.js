import { mkdtempSync, spawn, spawnSync } from './fixtures.js'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { processInfo } from '../src/core.js'
import { ensureRuntime, runtimeStatus } from '../src/runtime.js'
import { recordStart, START_RECORD } from '../src/started.js'
import { runSystemctl } from '../src/systemd.js'
import { runSharedTui } from '../src/tui.js'
import { GeliosBridge, parseArgs, profileFor } from '../scripts/bridge.js'
import { appServerFolder } from './support/app-server.js'
import { candidateAt } from './support/candidate.js'
import { closed, notYetThere, until } from './support/wait.js'

const source = fileURLToPath(new URL('../', import.meta.url))
const bridgeScript = join(source, 'scripts', 'bridge.js')
// A state folder holding an empty record, as test/support/app-server.js makes it: the plugin writes only there.
function recordIn(dir = mkdtempSync(join(tmpdir(), 'codex-telegram-started-'))) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, START_RECORD), '', { flag: 'wx', mode: 0o600 })
  return dir
}
const lines = dir => readFileSync(join(dir, START_RECORD), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
// The lines a case checks, by the fields it checks: the record's lines that name `pid`.
const linesOf = (dir, pid) => lines(dir).filter(line => line.pid === pid).map(({ pid, identity, role, by }) => ({ pid, identity, role, by }))

// A process that writes its pid, then runs until the test writes its release file, then exits with `code`: the
// test reads its start identity while it runs. `program` is for `node -e` and `shim(dir, name)` a command of
// that name; `preload(dir, when)` holds a Node process before its own code runs, when the condition holds in it.
function holder(root, name, code = 0) {
  const pidFile = join(root, `${name}.pid`), release = join(root, `${name}.release`)
  const program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(${code})},20)`
  return {
    program,
    shim(dir, command) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, command), `#!${process.execPath}\n${program}\n`, { mode: 0o700 }); return dir },
    preload(when) {
      const path = join(root, `${name}.cjs`)
      writeFileSync(path, `if (${when}) {\nconst fs=require('node:fs'),pause=new Int32Array(new SharedArrayBuffer(4));fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));\nwhile(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(pause,0,0,20);process.exit(${code})\n}\n`)
      return `--require ${path}`
    },
    // The pid, once the whole number is written, and the start identity read while the process runs.
    async running(t) {
      const pid = await until(t, () => { try { return Number(readFileSync(pidFile, 'utf8')) || false } catch { return false } }, `${name} to start`)
      return { pid, identity: processInfo(pid)?.identity }
    },
    release: () => writeFileSync(release, ''),
  }
}
// Runs `fn` with `dir` first on this process's PATH, for a starter that finds its command there.
function onPath(dir, fn) {
  const saved = process.env.PATH
  process.env.PATH = `${dir}:${saved}`
  try { return fn() } finally { process.env.PATH = saved }
}

test('a start is recorded with the start identity read in the tick that started it', async t => {
  const dir = recordIn()
  // The child runs until its input ends, so the identity is read from a running process on every platform.
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] })
  const identity = processInfo(child.pid)?.identity
  recordStart(dir, child.pid, 'a child')
  child.stdin.end()
  await closed(t, child)
  assert.match(identity, /^\d+$/)
  assert.deepEqual(linesOf(dir, child.pid), [{ pid: child.pid, identity, role: 'a child', by: process.pid }])
})

test('lines that many processes append at once all land whole and apart', async t => {
  const dir = recordIn()
  const module = new URL('../src/started.js', import.meta.url).href
  const writer = `const { recordStart } = await import(${JSON.stringify(module)})\nfor (let i = 0; i < 500; i++) recordStart(process.argv[1], process.pid, 'concurrent writer line ' + i, '1')`
  const writers = Array.from({ length: 12 }, () => spawn(process.execPath, ['--input-type=module', '-e', writer, dir], { stdio: 'inherit' }))
  await Promise.all(writers.map(child => closed(t, child)))
  const read = lines(dir)
  assert.equal(read.length, 6000)
  assert.equal(new Set(read.map(line => `${line.pid} ${line.role}`)).size, 6000)
})

test('a state folder without the record gets no file, no line and no throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-telegram-started-'))
  assert.doesNotThrow(() => recordStart(dir, process.pid, 'a host start'))
  assert.equal(existsSync(join(dir, START_RECORD)), false)
})

test('a record that cannot be written changes nothing for its starter', () => {
  assert.doesNotThrow(() => recordStart(join(tmpdir(), `codex-telegram-missing-${process.pid}`, 'state'), process.pid, 'nowhere'))
})

test('a folder that adopts a state folder\'s record reads it from its size at adoption', { timeout: 30_000 }, async t => {
  const stateDir = recordIn()
  // A line an earlier folder's test left, naming a live process without this test's mark: this file's parent.
  recordStart(stateDir, process.ppid, 'an earlier test\'s leftover')
  appServerFolder(t, { what: 'the adopting folder', stateDir })
  // This test's own runtime record: a child it starts and ends itself.
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  recordStart(stateDir, child.pid, 'the runtime supervisor')
  await closed(t, child)
})

// The check's own failures, one case each: a scratch test file whose folder holds that failure and nothing else
// the check fails on, run through test/support/run-tests.js, as npm test runs a test file. The spec reporter
// gives the failure the same line on every Node.
const runner = fileURLToPath(new URL('./support/run-tests.js', import.meta.url))
const href = path => pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href
async function checkedRun(t, stateDir, body) {
  const scratch = join(mkdtempSync(join(tmpdir(), 'codex-telegram-check-')), 'check.test.mjs')
  writeFileSync(scratch, `import { appendFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { spawn } from ${JSON.stringify(href('./fixtures.js'))}
import { appServerFolder } from ${JSON.stringify(href('./support/app-server.js'))}
import { closed } from ${JSON.stringify(href('./support/wait.js'))}
import { recordStart, START_RECORD } from ${JSON.stringify(href('../src/started.js'))}
const stateDir = ${JSON.stringify(stateDir)}, record = join(stateDir, START_RECORD)
// The runtime record a test's start leaves: a child this test starts and ends itself.
async function runtime(t) {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  recordStart(stateDir, child.pid, 'the runtime supervisor')
  await closed(t, child)
}
test('a folder whose check fails', { timeout: 20_000 }, async t => {
  const folder = appServerFolder(t, { what: 'the checked folder', stateDir })
${body}
})
`)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, [runner, '--test-reporter=spec', scratch], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', part => { output += part }); child.stderr.on('data', part => { output += part })
  await closed(t, child)
  return { code: child.exitCode, output }
}
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// The scratch fails, and its teardown's failure names `problem` alone.
function failsWith({ code, output }, problem) {
  assert.notEqual(code, 0, output)
  assert.match(output, new RegExp(`^\\s*Error: cleanup failed after the test: stop and check of the checked folder: ${problem}$`, 'm'), output)
}

test('the check fails a test whose state folder holds no runtime record at the teardown\'s read', { timeout: 30_000 }, async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-telegram-started-'))
  failsWith(await checkedRun(t, stateDir, ''), literal(`no runtime record in ${stateDir} at the teardown's read, so its stop could not be checked`))
})

test('the check fails a test that read a bridge with no start identity', { timeout: 30_000 }, async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-telegram-started-'))
  // A bridge's status reply without its start identity, from a process that has ended.
  failsWith(await checkedRun(t, stateDir, `  await runtime(t)
  const bridge = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await closed(t, bridge)
  folder.bridge({ pid: bridge.pid })`), 'the bridge \\d+ the test read has no record: its start identity could not be read')
})

test('the check fails a test whose record file is gone', { timeout: 30_000 }, async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-telegram-started-'))
  failsWith(await checkedRun(t, stateDir, `  await runtime(t)
  folder.read()
  rmSync(record)`), literal(`${join(stateDir, START_RECORD)} is gone`))
})

test('the check fails a test whose record file is replaced', { timeout: 30_000 }, async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-telegram-started-'))
  failsWith(await checkedRun(t, stateDir, `  await runtime(t)
  folder.read()
  writeFileSync(record + '.new', '')
  renameSync(record + '.new', record)`), literal(`${join(stateDir, START_RECORD)} is no longer the file the folder made`))
})

test('the check fails a test whose record holds a line that is not JSON', { timeout: 30_000 }, async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-telegram-started-'))
  failsWith(await checkedRun(t, stateDir, `  await runtime(t)
  appendFileSync(record, 'not json\\n')`), literal(`a line of ${join(stateDir, START_RECORD)} is not JSON: not json`))
})

// One case per line the plugin writes, each through the code that starts the process it names.

test('the detached launcher records the bridge it starts', { timeout: 30_000 }, async t => {
  const dir = recordIn(), workspace = join(dir, 'w'); mkdirSync(workspace)
  // The bridge is held before its own code runs, so only the launcher's line can name it.
  const bridge = holder(dir, 'bridge', 3)
  const launcher = spawn(process.execPath, [bridgeScript, '--detach', '--state-dir', dir, '--workspace', workspace],
    { env: { ...process.env, NODE_OPTIONS: bridge.preload("process.env.GELIOS_TELEGRAM_OWN_GROUP === '1'") }, stdio: ['ignore', 'ignore', 'inherit'] })
  try {
    const { pid, identity } = await bridge.running(t)
    assert.match(identity, /^\d+$/)
    assert.deepEqual(linesOf(dir, pid), [{ pid, identity, role: 'the bridge', by: launcher.pid }])
  } finally { bridge.release() }
  await closed(t, launcher)
})

test('a bridge records itself as it starts', { timeout: 30_000 }, async t => {
  const dir = recordIn(), workspace = join(dir, 'w'); mkdirSync(workspace)
  // A channel config the bridge refuses ends its start before it starts a runtime.
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ accessMode: 'refused by this case' }), { mode: 0o600 })
  const child = spawn(process.execPath, [bridgeScript, '--state-dir', dir, '--workspace', workspace], { stdio: 'ignore' })
  const identity = processInfo(child.pid)?.identity
  await closed(t, child)
  assert.match(identity, /^\d+$/)
  assert.deepEqual(linesOf(dir, child.pid), [{ pid: child.pid, identity, role: 'the bridge', by: child.pid }])
})

test('the bridge records the ffmpeg it starts for a transcription', { timeout: 30_000 }, async t => {
  const dir = recordIn(), workspace = join(dir, 'w'); mkdirSync(workspace)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ accessMode: 'refused by this case' }), { mode: 0o600 })
  const ffmpeg = holder(dir, 'ffmpeg', 1), bin = ffmpeg.shim(join(dir, 'bin'), 'ffmpeg')
  const bridge = new GeliosBridge({ stateDir: dir, workspace, transcriptionKeyEnv: 'STARTED_TEST_AUDIO_KEY' }); bridge.log = () => {}
  // The bridge builds its transcriber early in its start; the refused config ends the start right after.
  // Its failed start sets this process's exit code, which the case puts back.
  const saved = { key: process.env.STARTED_TEST_AUDIO_KEY, path: process.env.PATH, exitCode: process.exitCode }
  Object.assign(process.env, { STARTED_TEST_AUDIO_KEY: 'started-test-audio-key', PATH: `${bin}:${saved.path}` })
  try { await assert.rejects(bridge.start(), /accessMode/) } finally {
    if (saved.key === undefined) delete process.env.STARTED_TEST_AUDIO_KEY; else process.env.STARTED_TEST_AUDIO_KEY = saved.key
    process.env.PATH = saved.path; process.exitCode = saved.exitCode
  }
  const converting = bridge.transcriber.remux(join(dir, 'voice.ogg'))
  converting.catch(() => {})
  try {
    const { pid, identity } = await ffmpeg.running(t)
    assert.match(identity, /^\d+$/)
    assert.deepEqual(linesOf(dir, pid), [{ pid, identity, role: 'ffmpeg', by: process.pid }])
  } finally { ffmpeg.release() }
  await assert.rejects(converting)
})

test('the bridge records the automatic cutover it starts', { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-telegram-started-')), dir = recordIn(join(root, 'state'))
  const candidate = candidateAt(source, join(root, 'candidate'), '0.5.0', true)
  const codex = join(root, 'codex')
  writeFileSync(codex, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ installed: [candidate] }))})\n`, { mode: 0o700 })
  // The cutover is held before the updater's own code runs, so only the bridge's line can name it.
  const cutover = holder(root, 'cutover', 3)
  const options = parseArgs(['--state-dir', dir, '--workspace', root, '--codex-bin', codex])
  const bridge = new GeliosBridge(options), logs = []; bridge.log = line => logs.push(line)
  writeFileSync(join(dir, 'launch-profile.json'), JSON.stringify(profileFor(options)), { mode: 0o600 })
  // A new bridge is idle once its empty ingress, set as it is made, has settled.
  bridge.appReady = true; await bridge.ingress
  bridge.updateEnvironment = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: cutover.preload("process.argv.includes('--automatic')") }
  let started
  try {
    assert.equal(await bridge.reconcileInstalledBuild(), true, logs.join('\n'))
    started = await cutover.running(t)
    assert.match(started.identity, /^\d+$/)
    assert.deepEqual(linesOf(dir, started.pid), [{ pid: started.pid, identity: started.identity, role: 'the automatic cutover', by: process.pid }])
  } finally { cutover.release() }
  await until(t, () => processInfo(started.pid)?.identity !== started.identity, 'the held cutover to exit')
})

test('a runtime supervisor records itself as it starts', { timeout: 30_000 }, async t => {
  const dir = recordIn()
  const child = spawn(process.execPath, [join(source, 'scripts', 'runtime.js'), '--state-dir', dir], { stdio: 'ignore' })
  const identity = processInfo(child.pid)?.identity
  try {
    // It answers status only once its socket listens, which comes after its own line.
    await until(t, () => runtimeStatus(dir), 'the runtime supervisor to answer status', { retry: notYetThere })
    assert.match(identity, /^\d+$/)
    assert.deepEqual(linesOf(dir, child.pid), [{ pid: child.pid, identity, role: 'the runtime supervisor', by: child.pid }])
  } finally { child.kill('SIGTERM') }
  await closed(t, child)
})

test('the runtime start records the runtime supervisor it starts', { timeout: 30_000 }, async t => {
  const dir = recordIn(), supervisor = holder(dir, 'supervisor', 3)
  const starting = ensureRuntime({ stateDir: dir }, process.env, { launch: (_command, _args, options) => spawn(process.execPath, ['-e', supervisor.program], options) })
  starting.catch(() => {})
  try {
    const { pid, identity } = await supervisor.running(t)
    assert.match(identity, /^\d+$/)
    assert.deepEqual(linesOf(dir, pid), [{ pid, identity, role: 'the runtime supervisor', by: process.pid }])
  } finally { supervisor.release() }
  await assert.rejects(starting, /runtime supervisor start failed \(3\)/)
})

test('the runtime start records the systemd-run that starts its unit', { timeout: 30_000 }, async t => {
  const dir = recordIn(), unitStart = holder(dir, 'systemd-run', 3)
  const starting = ensureRuntime({ stateDir: dir, systemdUnit: 'codex-telegram-started-test.service' }, process.env, {
    launch: (_command, _args, options) => spawn(process.execPath, ['-e', unitStart.program], options), policy: async () => {},
  })
  starting.catch(() => {})
  try {
    const { pid, identity } = await unitStart.running(t)
    assert.match(identity, /^\d+$/)
    assert.deepEqual(linesOf(dir, pid), [{ pid, identity, role: 'the runtime unit start (systemd-run)', by: process.pid }])
  } finally { unitStart.release() }
  await assert.rejects(starting, /runtime supervisor start failed \(3\)/)
})

// The coordinator runs only inside a user namespace that maps no host root (src/runtime.js unmappedHostRoot).
const namespaces = process.platform === 'linux' && spawnSync('unshare', ['--user', 'true'], { stdio: 'ignore' }).status === 0
test('a runtime start inside a user namespace records the coordinator it starts', {
  skip: namespaces ? false : 'needs Linux and unshare --user', timeout: 30_000,
}, async t => {
  const dir = recordIn(), coordinator = holder(dir, 'coordinator', 0), bin = coordinator.shim(join(dir, 'bin'), 'systemd-run')
  const runtime = new URL('../src/runtime.js', import.meta.url).href
  const code = `import {ensureRuntime} from ${JSON.stringify(runtime)};await ensureRuntime(${JSON.stringify({ stateDir: dir, systemdUnit: 'codex-telegram-started-test.service' })},{...process.env,PATH:${JSON.stringify(`${bin}:${process.env.PATH}`)}})`
  const client = spawn('unshare', ['--user', process.execPath, '--input-type=module', '-e', code], { stdio: 'ignore' })
  try {
    const { pid, identity } = await coordinator.running(t)
    assert.match(identity, /^\d+$/)
    assert.deepEqual(linesOf(dir, pid), [{ pid, identity, role: 'the runtime coordinator (systemd-run)', by: client.pid }])
  } finally { coordinator.release() }
  await closed(t, client)
})

test('runSystemctl records the systemctl it starts', { timeout: 30_000 }, async t => {
  const dir = recordIn(), systemctl = holder(dir, 'systemctl', 0), bin = systemctl.shim(join(dir, 'bin'), 'systemctl')
  const running = onPath(bin, () => runSystemctl(['is-active', 'codex-telegram-started-test.service'], 20_000, 4000, dir))
  try {
    const { pid, identity } = await systemctl.running(t)
    assert.match(identity, /^\d+$/)
    assert.deepEqual(linesOf(dir, pid), [{ pid, identity, role: 'systemctl', by: process.pid }])
  } finally { systemctl.release() }
  assert.equal((await running).code, 0)
})

test('the shared TUI records the Codex TUI it starts', { timeout: 30_000 }, async t => {
  const dir = recordIn(), tui = holder(dir, 'tui', 0)
  const running = runSharedTui({ stateDir: dir }, {
    terminal: { isTTY: true }, output: { isTTY: true, write: () => {} }, terminalMode: () => 'saved', restoreMode: () => {}, pollMs: 20,
    control: async () => ({ socket: join(dir, 'app.sock'), codexBin: process.execPath, workspace: dir, threadId: 'kept', instanceId: 'same' }),
    // The terminal stays the test runner's: the TUI's own stdio is not inherited here.
    launch: (_command, _args, options) => spawn(process.execPath, ['-e', tui.program], { ...options, stdio: 'ignore' }),
  })
  running.catch(() => {})
  try {
    const { pid, identity } = await tui.running(t)
    assert.match(identity, /^\d+$/)
    assert.deepEqual(linesOf(dir, pid), [{ pid, identity, role: 'the Codex TUI', by: process.pid }])
  } finally { tui.release() }
  assert.equal(await running, 0)
})
