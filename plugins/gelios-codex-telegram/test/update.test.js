import { mkdtempSync, spawn, stopGroup } from './fixtures.js'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from './fixtures.js'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  acquireLock, controlRequest, controlStatus, environments, parseArgs as parseUpdateArgs, readProfile,
  pluginDigest, runCommand, runUpdate, validateCandidate,
} from '../scripts/update.js'
import { bootIdentity, liveProcesses, processInfo } from '../src/core.js'
import { packageDigest } from '../src/installation.js'
import { GeliosBridge } from '../scripts/bridge.js'
import { automaticAttempt } from '../src/builds.js'
import { recoveryUpdater } from '../src/native-cli.js'
import { connectRuntime, runtimeStatus, stopRuntime } from '../src/runtime.js'
import { once } from 'node:events'
import { cleanup, closed, exited, until } from './support/wait.js'

// macOS tmpdir() is a symlink (/var -> /private/var); the updater compares canonical paths.
const tmp = realpathSync(tmpdir())

const AUDIO_SECRET = 'audio-secret-value-example'
const AUTH_SECRET = 'marketplace-secret-value-example'
const BOT_SECRET = `123456789:${'z'.repeat(32)}`
const OTHER_PAT = 'other-runtime-pat'
const OLD_INSTANCE = 'a'.repeat(32)
const CANDIDATE_INSTANCE = 'b'.repeat(32)
const ROLLBACK_INSTANCE = 'c'.repeat(32)
const IDENTITIES = new Map([[101, '101001'], [202, '202002'], [303, '303003'], [505, '505005']])

function pluginAt(root, version) {
  mkdirSync(join(root, '.codex-plugin'), { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), `${JSON.stringify({ name: 'portable-telegram', version, mcpServers: './.mcp.json' })}\n`)
  writeFileSync(join(root, '.mcp.json'), `${JSON.stringify({ mcpServers: { 'gelios-codex-telegram': {
    command: 'node', args: ['./scripts/mcp.js'], cwd: '.',
    env_vars: ['GELIOS_TELEGRAM_CONTROL_SOCKET', 'GELIOS_TELEGRAM_STATE_DIR'],
    startup_timeout_sec: 10, tool_timeout_sec: 60, required: true,
  } } })}\n`)
  writeFileSync(join(root, 'bin', 'gelios-codex-telegram'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  writeFileSync(join(root, 'scripts', 'git-askpass.js'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(root, 'README.md'), 'portable Telegram plugin\n')
  for (const name of ['access', 'bridge', 'configure', 'mcp', 'status', 'update']) {
    writeFileSync(join(root, 'scripts', `${name}.js`), 'export {}\n')
  }
  mkdirSync(join(root, 'src'))
  for (const name of ['core', 'telegram', 'rich', 'transcription', 'websocket']) writeFileSync(join(root, 'src', `${name}.js`), 'export {}\n')
}

function fixture() {
  const root = mkdtempSync(join(tmp, 'telegram-update-'))
  const stateDir = join(root, 'state'); const workspace = join(root, 'workspace')
  const oldRoot = join(root, 'old'); const candidateRoot = join(root, 'candidate')
  const codexBin = join(root, 'codex'); const launcherLink = join(root, 'launcher')
  mkdirSync(stateDir, { mode: 0o700 }); mkdirSync(workspace)
  pluginAt(oldRoot, '1.0.0'); pluginAt(candidateRoot, '2.0.0')
  writeFileSync(codexBin, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  symlinkSync(join(oldRoot, 'bin', 'gelios-codex-telegram'), launcherLink)
  const profile = {
    version: 1, cwd: workspace, stateDir,
    socket: join(stateDir, 'app.sock'), controlSocket: join(stateDir, 'control.sock'),
    codexBin, workspace, terminalName: 'Operator',
    bridgeArgs: [
      '--state-dir', stateDir, '--socket', join(stateDir, 'app.sock'),
      '--control-socket', join(stateDir, 'control.sock'), '--workspace', workspace,
      '--codex-bin', codexBin, '--terminal-name', 'Operator',
      '--transcription-api-key-env', 'TEST_AUDIO_SLOT', '--marketplace-auth-env', 'TEST_MARKET_SLOT',
      '--codex-runtime-env', 'TEST_MARKET_SLOT', '--codex-runtime-env', 'TEST_OTHER_PAT',
    ],
    transcriptionApiKeyEnv: 'TEST_AUDIO_SLOT', marketplaceAuthEnv: 'TEST_MARKET_SLOT',
    codexRuntimeEnvs: ['TEST_MARKET_SLOT', 'TEST_OTHER_PAT'], launcherLink,
  }
  writeFileSync(join(stateDir, 'launch-profile.json'), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  return { root, stateDir, workspace, oldRoot, candidateRoot, codexBin, launcherLink, profile }
}

function candidateLauncher(fix) { return join(fix.stateDir, 'runtime-builds', pluginDigest(fix.candidateRoot, null, 0o700), 'bin', 'gelios-codex-telegram') }

function harness(fix, options = {}) {
  // The conversation the bridge reports bound, `threadId: null` for none; with none it reports no policy, as the bridge does.
  const conversation = Object.hasOwn(options, 'threadId') ? options.threadId : 'kept-thread'
  if (options.runtimeIdentity && !options.downgrade) for (const path of ['src/runtime.js', 'scripts/runtime.js']) writeFileSync(join(fix.candidateRoot, path), 'export {}\n')
  const calls = []; const output = []
  let runtime = 'old'; let oldPrepared = false
  let candidateInstance = CANDIDATE_INSTANCE; let snapshotInstance = ROLLBACK_INSTANCE
  const alive = new Map([[101, true], [202, false], [303, false]])
  const selectedName = options.targetPlugin?.name || 'portable-telegram'
  const selectedMarket = options.targetPlugin?.marketplaceName || 'test-market'
  const installed = options.installed ?? [{
    pluginId: 'portable-telegram@test-market', name: 'portable-telegram', marketplaceName: 'test-market',
    version: '1.0.0', installed: true, enabled: true,
  }]
  const marketplaceEntries = options.marketplaces ?? [{ name: 'test-market', root: '/snapshot' }]
  const run = async (command, args, invocation) => {
    calls.push({ command, args, invocation, launcherTarget: existsSync(fix.launcherLink) ? readlinkSync(fix.launcherLink) : null })
    const joined = args.join(' ')
    if (options.all && command === fix.codexBin && joined === 'update') {
      writeFileSync(fix.codexBin, '#!/bin/sh\necho updated-native\n', { mode: 0o700 })
      if (options.fail === 'codex') throw new Error('native installation failed after replacement')
      return { stdout: 'native update completed', stderr: '' }
    }
    if (options.all && command === fix.codexBin && joined === '--version') return { stdout: 'codex-cli 0.162.0\n', stderr: '' }
    if (options.all && command === 'npm' && args[0] === 'pack') { writeFileSync(join(fix.stateDir, 'packed'), 'packed'); return { stdout: '[{"filename":"launcher.tgz"}]', stderr: '' } }
    if (options.all && command === 'npm' && args[0] === 'install') {
      const manifest = JSON.parse(readFileSync(join(fix.installerRoot, 'package.json'))); manifest.version = options.candidateVersion || '2.0.0'
      writeFileSync(join(fix.installerRoot, 'package.json'), JSON.stringify(manifest)); writeFileSync(join(fix.installerRoot, 'launcher.js'), 'updated launcher\n')
      if (options.fail === 'launcher') { unlinkSync(fix.installerEntry); throw new Error('launcher installation failed after replacement') }
      return { stdout: 'launcher installed', stderr: '' }
    }
    if (invocation.onSpawn) {
      alive.set(505, true); invocation.onSpawn({ pid: 505, identity: IDENTITIES.get(505), deadline: Date.now() + 60_000 })
      if (options.commandStuck && joined.includes('marketplace upgrade')) throw new Error('updater disappeared while refresh continued')
      alive.set(505, false)
    }
    if (options.fail === 'discovery' && joined === 'plugin list --json') throw new Error('discovery unavailable')
    if (command === fix.codexBin && joined === 'plugin list --json') return { stdout: JSON.stringify({ installed, available: [] }), stderr: '' }
    if (command === fix.codexBin && joined === 'plugin marketplace list --json') {
      return { stdout: JSON.stringify({ marketplaces: marketplaceEntries }), stderr: '' }
    }
    if (command === fix.codexBin && joined === `plugin marketplace upgrade ${selectedMarket} --json`) {
      if (options.fail === 'upgrade') return { stdout: JSON.stringify({ selectedMarketplaces: [selectedMarket], upgradedRoots: [], errors: [{}] }), stderr: '' }
      return { stdout: JSON.stringify({ selectedMarketplaces: [selectedMarket], upgradedRoots: ['/snapshot'], errors: [] }), stderr: '' }
    }
    if (command === fix.codexBin && joined === `plugin add ${selectedName}@${selectedMarket} --json`) {
      rmSync(fix.oldRoot, { recursive: true, force: true })
      if (options.fail === 'install') throw new Error('install failed safely')
      return { stdout: JSON.stringify({
        pluginId: `${selectedName}@${selectedMarket}`, name: selectedName, marketplaceName: selectedMarket,
        version: options.candidateVersion || '2.0.0', installedPath: fix.candidateRoot, authPolicy: 'ON_INSTALL',
      }), stderr: '' }
    }
    if (joined.startsWith('plugin remove ')) return { stdout: '{}', stderr: '' }
    if (command === process.execPath && args[1] === '--validate-candidate') {
      if (options.fail === 'validation') throw new Error('candidate syntax invalid')
      const input = JSON.parse(args[2])
      return { stdout: JSON.stringify(validateCandidate(input.result, input.pluginName, input.marketplaceName)), stderr: '' }
    }
    if (command === candidateLauncher(fix)) {
      candidateInstance = invocation.env.GELIOS_TELEGRAM_INSTANCE_ID
      if (options.fail === 'candidate') {
        if (options.unknownCandidateOnFailure) { runtime = 'unknown'; alive.set(404, true) }
        throw new Error('candidate did not start')
      }
      runtime = options.fastCrash ? 'stopped' : 'candidate'; oldPrepared = false; alive.set(202, !options.fastCrash)
      return { stdout: `${JSON.stringify({
        pid: 202, identity: IDENTITIES.get(202), instanceId: candidateInstance, socket: fix.profile.controlSocket,
      })}\n`, stderr: '' }
    }
    if (command.includes('/previous-plugin/bin/gelios-codex-telegram') || command.includes('/runtime-builds/')) {
      snapshotInstance = invocation.env.GELIOS_TELEGRAM_INSTANCE_ID
      runtime = 'rollback'; oldPrepared = false; alive.set(303, true)
      return { stdout: `${JSON.stringify({
        pid: 303, identity: IDENTITIES.get(303), instanceId: snapshotInstance, socket: fix.profile.controlSocket,
      })}\n`, stderr: '' }
    }
    throw new Error(`unexpected command: ${command} ${joined}`)
  }
  const control = async (_path, request, timeoutMs) => {
    calls.push({ control: request.action, request, runtime, timeoutMs })
    const receipt = runtime === 'candidate'
      ? { pid: 202, identity: IDENTITIES.get(202), instanceId: candidateInstance }
      : runtime === 'rollback'
        ? { pid: 303, identity: IDENTITIES.get(303), instanceId: snapshotInstance }
        : runtime === 'unknown'
          ? { pid: 404, identity: '404004', instanceId: 'd'.repeat(32) }
          : { pid: 101, identity: IDENTITIES.get(101), instanceId: options.oldInstance || OLD_INSTANCE }
    if (request.action === 'status') {
      if (options.socketFault && runtime === options.socketFaultRuntime) throw Object.assign(new Error(options.socketFault), { code: options.socketFault })
      if (runtime === 'stopped') throw Object.assign(new Error('socket unavailable'), { code: 'ENOENT' })
      return { ...receipt, appRunning: runtime === 'candidate' ? options.healthFail !== true : runtime === 'rollback' ? options.rollbackHealthFail !== true : true,
        ...(options.runtimeIdentity ? { runtime: { instanceId: runtime === 'candidate' && options.changedRuntime ? 'changed-runtime' : options.nativeReceipt?.instanceId || 'kept-runtime' }, appPid: runtime === 'candidate' && options.changedRuntime ? 998 : options.nativeReceipt?.appPid || 999 } : {}),
        ready: true, turnId: options.turnId || null, tuiAttached: options.tuiAttached || false, updatePrepared: oldPrepared,
        ...(options.all ? { threadId: conversation, workspace: fix.workspace, permissions: !conversation ? null : options.policies && Object.hasOwn(options.policies, runtime) ? options.policies[runtime] : { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } } : {}) }
    }
    if (!['stop_for_update', 'shutdown_instance'].includes(request.action)) throw new Error(`unexpected control ${request.action}`)
    if (request.instanceId !== receipt.instanceId) throw new Error('instance mismatch')
    if (runtime === 'old' && request.action === 'stop_for_update' && options.stopError === 'healthy') throw new Error('active work appeared')
    oldPrepared = true
    const cannotStop = (runtime === 'old' && options.shutdownTimeout) || (runtime === 'candidate' && options.terminationTimeout)
    if (!cannotStop) { alive.set(receipt.pid, false); runtime = 'stopped' }
    if (options.stopError === 'ambiguous' && receipt.pid === 101) throw new Error('control response lost')
    return { ...receipt, stopping: true }
  }
  return {
    calls, output, runtime: () => runtime,
    setRuntime: value => { runtime = value; if (value === 'stopped') for (const pid of alive.keys()) alive.set(pid, false) },
    setProcess: (pid, value) => alive.set(pid, value),
    dependencies: {
      assertMigrationSafe: () => {}, // This harness uses synthetic PIDs; migration owns separate process tests.
      pluginRoot: fix.oldRoot, recoveryRoot: fix.oldRoot, targetPlugin: options.targetPlugin, run, control,
      waitForExit: async pid => !alive.get(pid),
      waitForStatus: async (request, path, pid, instanceId) => {
        const status = await request(path, { action: 'status' })
        if (status.pid !== pid || status.instanceId !== instanceId || status.appRunning !== true) throw new Error('replacement bridge health check failed')
        return status
      },
      processIdentity: pid => alive.get(pid) && options.identityMissing !== pid ? (pid === 404 ? '404004' : IDENTITIES.get(pid)) : null,
      processExists: pid => Boolean(alive.get(pid)),
      write: message => output.push(message),
      atomicSymlink: (path, target) => {
        if (options.fail === 'symlink' && target === candidateLauncher(fix)) throw new Error('launcher cutover failed')
        try { unlinkSync(path) } catch {} symlinkSync(target, path)
      },
    },
  }
}

function updateEnv(overrides = {}) {
  return {
    HOME: '/home/test', PATH: process.env.PATH, TEST_AUDIO_SLOT: AUDIO_SECRET,
    TEST_MARKET_SLOT: AUTH_SECRET, TEST_OTHER_PAT: OTHER_PAT, TELEGRAM_BOT_TOKEN: BOT_SECRET,
    GELIOS_OPENROUTER_CODEX_API_KEY: 'openrouter-secret-example',
    GH_TOKEN: 'ambient-gh-secret-example', GITHUB_TOKEN: 'ambient-github-secret-example',
    MARKET_ALIAS: AUTH_SECRET, GITHUB_ALIAS: 'ambient-github-secret-example',
    HTTPS_PROXY: 'http://proxy-user:p%40ss@proxy.example', LC_DATABASE_PASSWORD: 'fake-locale-secret-example',
    XDG_SESSION_TOKEN: 'fake-xdg-secret-example', LD_PRELOAD: '/tmp/never-load.so', ...overrides,
  }
}

test('update CLI accepts only its optional state-directory override', () => {
  const fix = fixture()
  assert.equal(parseUpdateArgs(['--state-dir', fix.stateDir]).stateDir, fix.stateDir)
  assert.throws(() => parseUpdateArgs(['--unknown']), /usage: gelios-codex-telegram update/)
})

test('runCommand executes an explicitly selected durable supervisor', async () => {
  const root = mkdtempSync(join(tmp, 'telegram-durable-supervisor-'))
  const supervisor = join(root, 'supervisor.mjs')
  const marker = join(root, 'used-supervisor')
  writeFileSync(supervisor, `
    import { spawn } from 'node:child_process'
    import { writeFileSync } from 'node:fs'
    const [mode, timeout, command, ...args] = process.argv.slice(2)
    if (mode !== '--supervise' || !Number.isSafeInteger(Number(timeout))) process.exit(125)
    writeFileSync(${JSON.stringify(marker)}, 'used')
    const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('error', error => { process.stderr.write(error.message); process.exitCode = 125 })
    child.once('close', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1) })
  `)
  const result = await runCommand(process.execPath, ['-e', "process.stdout.write('durable')"], {
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, supervisorPath: supervisor,
  })
  assert.equal(result.stdout, 'durable')
  assert.equal(readFileSync(marker, 'utf8'), 'used')
})

test('plugin content identity is path- and timestamp-independent and covers the complete trusted tree', () => {
  const fix = fixture()
  const candidateManifest = join(fix.candidateRoot, '.codex-plugin', 'plugin.json')
  const manifest = JSON.parse(readFileSync(candidateManifest, 'utf8')); manifest.version = '1.0.0'
  writeFileSync(candidateManifest, `${JSON.stringify(manifest)}\n`)
  utimesSync(join(fix.oldRoot, 'README.md'), new Date(0), new Date(0))
  assert.equal(pluginDigest(fix.oldRoot), pluginDigest(fix.candidateRoot))
  writeFileSync(join(fix.candidateRoot, 'README.md'), 'changed documentation\n')
  assert.notEqual(pluginDigest(fix.oldRoot), pluginDigest(fix.candidateRoot))
  symlinkSync(join(fix.candidateRoot, 'README.md'), join(fix.candidateRoot, 'linked-readme'))
  assert.throws(() => pluginDigest(fix.candidateRoot), /unsupported file type/)
})

test('same-version updates require byte-identical content and refresh the runtime for Codex binary changes', async () => {
  let fix = fixture()
  let manifestPath = join(fix.candidateRoot, '.codex-plugin', 'plugin.json')
  let manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.version = '1.0.0'
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)
  writeFileSync(fix.codexBin, '#!/bin/sh\necho codex-cli 0.155.1\n', { mode: 0o700 })
  let run = harness(fix, { candidateVersion: '1.0.0' })
  assert.deepEqual(await runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), {
    updated: false, refreshed: true, version: '1.0.0', marketplace: 'test-market', pid: 202,
  })
  assert.equal(run.calls.some(call => call.control === 'stop_for_update'), true)
  assert.equal(run.runtime(), 'candidate')
  assert.equal(readlinkSync(fix.launcherLink), candidateLauncher(fix))
  const refreshCall = run.calls.find(call => call.command === candidateLauncher(fix))
  assert.deepEqual(refreshCall.args.slice(0, 3), ['bridge', '--detach', '--json'])
  assert.deepEqual(refreshCall.args.slice(refreshCall.args.indexOf('--codex-bin'), refreshCall.args.indexOf('--codex-bin') + 2),
    ['--codex-bin', fix.codexBin])
  assert.match(run.output.join(''), /Refreshed portable-telegram 1\.0\.0.*bridge pid 202/)

  fix = fixture(); manifestPath = join(fix.candidateRoot, '.codex-plugin', 'plugin.json')
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.version = '1.0.0'
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)
  writeFileSync(join(fix.candidateRoot, 'README.md'), 'same version, different artifact\n')
  run = harness(fix, { candidateVersion: '1.0.0' })
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies),
    /content changed without a new manifest version.*durable snapshot launcher and bridge were restored/)
  assert.equal(run.runtime(), 'old')
  assert.equal(run.calls.some(call => call.control === 'stop_for_update'), false)
  assert.match(readlinkSync(fix.launcherLink), /previous-plugin\/bin\/gelios-codex-telegram$/)
  assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), false)
})

test('successful update scopes secrets, waits for shutdown, health-checks, and atomically switches the launcher', async () => {
  const fix = fixture(); const run = harness(fix)
  const result = await runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies)
  assert.deepEqual(result, { updated: true, version: '2.0.0', marketplace: 'test-market', pid: 202 })
  assert.equal(readlinkSync(fix.launcherLink), candidateLauncher(fix))
  assert.equal(existsSync(fix.oldRoot), false)
  assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), false)
  const installCall = run.calls.find(call => call.args?.join(' ') === 'plugin add portable-telegram@test-market --json')
  assert.match(installCall.launcherTarget, /update-transactions\/[a-f0-9]{32}\/previous-plugin\/bin\/gelios-codex-telegram$/)
  assert.equal(installCall.invocation.env.GH_TOKEN, undefined)
  assert.equal(installCall.invocation.env.TEST_MARKET_SLOT, undefined)
  assert.equal(installCall.invocation.env.HTTPS_PROXY, undefined)
  const candidateCall = run.calls.find(call => call.command === candidateLauncher(fix))
  assert.match(candidateCall.invocation.supervisorPath, /coordinator\/scripts\/update\.js$/)
  assert.deepEqual(candidateCall.args.slice(0, 3), ['bridge', '--detach', '--json'])
  assert.equal(candidateCall.invocation.env.TEST_AUDIO_SLOT, AUDIO_SECRET)
  assert.equal(candidateCall.invocation.env.TEST_MARKET_SLOT, AUTH_SECRET)
  assert.equal(candidateCall.invocation.env.TEST_OTHER_PAT, OTHER_PAT)
  assert.equal(candidateCall.invocation.env.GELIOS_OPENROUTER_CODEX_API_KEY, 'openrouter-secret-example')
  assert.equal(candidateCall.invocation.env.GH_TOKEN, 'ambient-gh-secret-example')
  assert.equal(candidateCall.invocation.env.GITHUB_TOKEN, 'ambient-github-secret-example')
  assert.equal(candidateCall.invocation.env.MARKET_ALIAS, AUTH_SECRET)
  assert.equal(candidateCall.invocation.env.GITHUB_ALIAS, 'ambient-github-secret-example')
  assert.equal(candidateCall.invocation.env.HTTPS_PROXY, 'http://proxy-user:p%40ss@proxy.example')
  assert.equal(candidateCall.invocation.env.LC_DATABASE_PASSWORD, 'fake-locale-secret-example')
  assert.equal(candidateCall.invocation.env.XDG_SESSION_TOKEN, 'fake-xdg-secret-example')
  assert.equal(candidateCall.invocation.env.LD_PRELOAD, '/tmp/never-load.so')
  assert.match(candidateCall.invocation.env.GELIOS_TELEGRAM_INSTANCE_ID, /^[a-f0-9]{32}$/)
  const upgradeCall = run.calls.find(call => call.args?.join(' ') === 'plugin marketplace upgrade test-market --json')
  assert.equal(upgradeCall.invocation.supervisorPath, candidateCall.invocation.supervisorPath)
  assert.equal(upgradeCall.invocation.env.GH_TOKEN, AUTH_SECRET)
  assert.equal(upgradeCall.invocation.env.GELIOS_GIT_AUTH_HOST, 'github.com')
  assert.equal(upgradeCall.invocation.env.GIT_ASKPASS.endsWith('/scripts/git-askpass.js'), true)
  assert.equal(upgradeCall.invocation.env.GIT_ASKPASS_REQUIRE, 'force')
  assert.equal(upgradeCall.invocation.env.TEST_MARKET_SLOT, undefined)
  assert.equal(upgradeCall.invocation.env.TEST_OTHER_PAT, undefined)
  assert.equal(upgradeCall.invocation.env.GELIOS_OPENROUTER_CODEX_API_KEY, undefined)
  assert.equal(upgradeCall.invocation.env.TEST_AUDIO_SLOT, undefined)
  assert.equal(upgradeCall.invocation.env.TELEGRAM_BOT_TOKEN, undefined)
  assert.equal(upgradeCall.invocation.env.HTTPS_PROXY, 'http://proxy-user:p%40ss@proxy.example')
  const discoveryCall = run.calls.find(call => call.args?.join(' ') === 'plugin list --json')
  assert.equal(discoveryCall.invocation.env.GH_TOKEN, undefined)
  const serializedCalls = JSON.stringify(run.calls.map(call => ({ command: call.command, args: call.args })))
  assert.doesNotMatch(serializedCalls, new RegExp(`${AUDIO_SECRET}|${AUTH_SECRET}|${BOT_SECRET}`))
  assert.equal(readFileSync(join(fix.stateDir, 'launch-profile.json'), 'utf8').includes(AUTH_SECRET), false)
  assert.equal(run.calls.find(call => call.control === 'stop_for_update').timeoutMs, 180_000)
  assert.equal(run.calls.find(call => call.control === 'stop_for_update').request.instanceId, OLD_INSTANCE)
})

test('update retains working supervision, MCP instructions and bridge imports when refresh prunes the original cache', async () => {
  const fix = fixture(); const state = harness(fix)
  for (const directory of ['scripts', 'src']) for (const target of [fix.oldRoot, fix.candidateRoot]) {
    cpSync(new URL(`../${directory}/`, import.meta.url), join(target, directory), { recursive: true })
  }
  writeFileSync(join(fix.candidateRoot, 'README.md'), 'changed without a manifest version\n')
  const candidateManifestPath = join(fix.candidateRoot, '.codex-plugin', 'plugin.json')
  const candidateManifest = JSON.parse(readFileSync(candidateManifestPath, 'utf8'))
  candidateManifest.version = '1.0.0'
  writeFileSync(candidateManifestPath, `${JSON.stringify(candidateManifest)}\n`)
  writeFileSync(fix.codexBin, `#!${process.execPath}
const { rmSync } = require('node:fs')
const args = process.argv.slice(2).join(' ')
const send = value => process.stdout.write(JSON.stringify(value))
if (args === 'plugin list --json') send({ installed: [{ name: 'portable-telegram', marketplaceName: 'test-market', version: '1.0.0', installed: true, enabled: true }], available: [] })
else if (args === 'plugin marketplace list --json') send({ marketplaces: [{ name: 'test-market', root: '/marketplace' }] })
else if (args === 'plugin marketplace upgrade test-market --json') {
  rmSync(${JSON.stringify(fix.oldRoot)}, { recursive: true, force: true })
  send({ selectedMarketplaces: ['test-market'], upgradedRoots: ['/marketplace'], errors: [] })
} else if (args === 'plugin add portable-telegram@test-market --json') send({
  name: 'portable-telegram', marketplaceName: 'test-market', version: '1.0.0',
  installedPath: ${JSON.stringify(fix.candidateRoot)}, authPolicy: 'ON_INSTALL',
})
else { process.stderr.write('unexpected fake Codex command: ' + args); process.exitCode = 2 }
`, { mode: 0o700 })
  const originalUpdater = join(fix.oldRoot, 'scripts', 'update.js')
  const invocations = []
  const cacheBoundRun = (command, args, options = {}) => {
    const supervisorPath = options.supervisorPath || originalUpdater
    invocations.push({ command, args, supervisorPath })
    if (!existsSync(supervisorPath)) throw new Error(`supervisor disappeared: ${supervisorPath}`)
    return runCommand(command, args, { ...options, supervisorPath })
  }
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, {
    ...state.dependencies, run: cacheBoundRun,
  }), /content changed without a new manifest version.*durable snapshot launcher and bridge were restored/)
  assert.equal(existsSync(fix.oldRoot), false)
  assert.match(readlinkSync(fix.launcherLink), /previous-plugin\/bin\/gelios-codex-telegram$/)
  const snapshot = realpathSync(join(readlinkSync(fix.launcherLink), '../..'))
  const initialized = JSON.parse(execFileSync(process.execPath, [join(snapshot, 'scripts/mcp.js')], {
    env: { ...process.env, GELIOS_TELEGRAM_LAUNCHER_DIR: join(fix.root, 'bin'), GELIOS_TELEGRAM_STATE_DIR: fix.stateDir },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`, encoding: 'utf8', timeout: 5000,
  }))
  assert.equal(initialized.result.instructions, readFileSync(new URL('../src/telegram-instructions.md', import.meta.url), 'utf8').trim())
  const bridge = pathToFileURL(join(snapshot, 'scripts/bridge.js')).href
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e',
    `const module = await import(${JSON.stringify(bridge)}); console.log(typeof module.GeliosBridge)`,
  ], { encoding: 'utf8', timeout: 5000 }).trim(), 'function')
  assert.equal(state.runtime(), 'old')
  assert.equal(state.calls.some(call => call.control === 'stop_for_update'), false)
  const destructiveBoundary = invocations.filter(call =>
    call.args.join(' ').includes('marketplace upgrade') || call.args.join(' ').includes('plugin add') || call.args[1] === '--validate-candidate')
  assert.equal(destructiveBoundary.length, 3)
  assert.ok(destructiveBoundary.every(call => /update-transactions\/[a-f0-9]{32}\/previous-plugin\/scripts\/update\.js$/.test(call.supervisorPath)))
})

test('plugin discovery rejects zero or ambiguous installed matches without touching the bridge', async () => {
  for (const installed of [[], [
    { name: 'portable-telegram', marketplaceName: 'one', installed: true, enabled: true },
    { name: 'portable-telegram', marketplaceName: 'two', installed: true, enabled: true },
  ]]) {
    const fix = fixture(); const run = harness(fix, { installed })
    await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /expected one installed/)
    assert.equal(readlinkSync(fix.launcherLink), join(fix.oldRoot, 'bin', 'gelios-codex-telegram'))
  }
})

test('marketplace discovery rejects zero or duplicate named matches before authentication', async () => {
  for (const marketplaces of [[], [
    { name: 'test-market', root: '/one' }, { name: 'test-market', root: '/two' },
  ]]) {
    const fix = fixture(); const run = harness(fix, { marketplaces })
    await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /expected one test-market marketplace/)
    assert.equal(run.calls.some(call => call.control === 'stop_for_update'), false)
  }
})

test('authentication, refresh, install, and validation failures retain a live bridge and a durable launcher', async () => {
  for (const fail of ['upgrade', 'install', 'validation']) {
    const fix = fixture(); const run = harness(fix, { fail })
    await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies))
    assert.equal(run.runtime(), 'old', fail)
    assert.match(readlinkSync(fix.launcherLink), /previous-plugin\/bin\/gelios-codex-telegram$/)
    assert.equal(existsSync(readlinkSync(fix.launcherLink)), true)
    if (fail !== 'upgrade') assert.equal(existsSync(fix.oldRoot), false)
  }
  const fix = fixture(); const run = harness(fix)
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv({ TEST_MARKET_SLOT: '' }) }, run.dependencies), /unavailable for marketplace authentication/)

  const aliased = fixture(); const aliasedRun = harness(aliased)
  await assert.rejects(runUpdate({
    stateDir: aliased.stateDir, env: updateEnv({ TEST_MARKET_SLOT: AUDIO_SECRET }),
  }, aliasedRun.dependencies), /alias the same credential/)
  assert.equal(aliasedRun.calls.some(call => call.control === 'status'), false)
})

test('candidate validation rejects incomplete MCP wiring before touching the bridge', async () => {
  const fix = fixture(); const run = harness(fix)
  writeFileSync(join(fix.candidateRoot, '.mcp.json'), `${JSON.stringify({ mcpServers: { 'gelios-codex-telegram': {} } })}\n`)
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /invalid MCP manifest/)
  assert.equal(run.calls.some(call => call.control === 'stop_for_update'), false)
  assert.match(readlinkSync(fix.launcherLink), /previous-plugin\/bin\/gelios-codex-telegram$/)
})

test('candidate validation requires the declared MCP pointer and accepts compatible environment additions', async () => {
  let fix = fixture(); let run = harness(fix)
  writeFileSync(join(fix.candidateRoot, '.codex-plugin', 'plugin.json'), `${JSON.stringify({
    name: 'portable-telegram', version: '2.0.0', mcpServers: './wrong.json',
  })}\n`)
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /invalid manifest or launcher/)
  assert.equal(run.calls.some(call => call.control === 'stop_for_update'), false)

  fix = fixture(); run = harness(fix)
  const mcpPath = join(fix.candidateRoot, '.mcp.json')
  const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'))
  mcp.mcpServers['gelios-codex-telegram'].env_vars = [
    'FUTURE_COMPATIBLE_CONTEXT', 'GELIOS_TELEGRAM_STATE_DIR', 'GELIOS_TELEGRAM_CONTROL_SOCKET',
  ]
  writeFileSync(mcpPath, `${JSON.stringify(mcp)}\n`)
  const result = await runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies)
  assert.equal(result.updated, true)
})

test('candidate and current executables reject group-writable update surfaces', async () => {
  for (const mutate of [
    fix => chmodSync(fix.candidateRoot, 0o770),
    fix => chmodSync(join(fix.candidateRoot, 'scripts', 'bridge.js'), 0o660),
  ]) {
    const fix = fixture(); const run = harness(fix); mutate(fix)
    await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /trusted/)
    assert.equal(run.calls.some(call => call.control === 'stop_for_update'), false)
  }

  for (const pathFor of [
    fix => fix.codexBin,
    fix => join(fix.oldRoot, 'scripts', 'git-askpass.js'),
  ]) {
    const fix = fixture(); const run = harness(fix); chmodSync(pathFor(fix), 0o770)
    await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /trusted/)
    assert.equal(run.calls.some(call => call.control === 'status'), false)
  }
})

test('trusted update paths reject writable ancestors while accepting the root-owned sticky tmp ancestor', async () => {
  let fix = fixture(); let run = harness(fix)
  chmodSync(fix.root, 0o770)
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /untrusted parent directory/)
  assert.equal(run.calls.length, 0)

  fix = fixture()
  const launcherParent = join(fix.root, 'launcher-parent')
  mkdirSync(launcherParent, { mode: 0o770 })
  chmodSync(launcherParent, 0o770)
  const launcher = join(launcherParent, 'gelios-codex-telegram')
  symlinkSync(join(fix.oldRoot, 'bin', 'gelios-codex-telegram'), launcher)
  unlinkSync(fix.launcherLink); fix.launcherLink = launcher; fix.profile.launcherLink = launcher
  writeFileSync(join(fix.stateDir, 'launch-profile.json'), `${JSON.stringify(fix.profile)}\n`, { mode: 0o600 })
  run = harness(fix)
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /launcher directory.*trusted|untrusted parent/)
  assert.equal(run.calls.length, 0)

  fix = fixture()
  const codexParent = join(fix.root, 'codex-parent')
  mkdirSync(codexParent, { mode: 0o770 })
  chmodSync(codexParent, 0o770)
  const codex = join(codexParent, 'codex')
  writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  fix.profile.bridgeArgs = fix.profile.bridgeArgs.map(value => value === fix.codexBin ? codex : value)
  fix.codexBin = codex; fix.profile.codexBin = codex
  writeFileSync(join(fix.stateDir, 'launch-profile.json'), `${JSON.stringify(fix.profile)}\n`, { mode: 0o600 })
  run = harness(fix)
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /Codex binary.*untrusted parent/)
  assert.equal(run.calls.length, 0)
})

test('in-Codex, attached-TUI, and active-turn updates are rejected before staging', async () => {
  let fix = fixture(); let run = harness(fix)
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv({ GELIOS_CODEX_CHILD: '1' }) }, run.dependencies), /parent terminal/)
  assert.equal(run.calls.length, 0)
  for (const status of [{ tuiAttached: true }, { turnId: 'turn-live' }]) {
    fix = fixture(); run = harness(fix, status)
    await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /exit the attached|active Codex turn/)
    assert.equal(run.calls.some(call => call.args?.includes('upgrade')), false)
  }
})

test('candidate startup failure restores the bridge from the cache-independent snapshot', async () => {
  const fix = fixture()
  const run = harness(fix, { fail: 'candidate' })
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /durable snapshot launcher and bridge were restored/)
  const snapshotLauncher = readlinkSync(fix.launcherLink)
  assert.match(snapshotLauncher, /previous-plugin\/bin\/gelios-codex-telegram$/)
  assert.equal(existsSync(snapshotLauncher), true)
  assert.equal(existsSync(fix.oldRoot), false)
  const recoveryCall = run.calls.find(call => call.command === snapshotLauncher)
  assert.ok(recoveryCall)
  assert.match(recoveryCall.invocation.supervisorPath, /coordinator\/scripts\/update\.js$/)
  assert.equal(run.runtime(), 'rollback')
})

test('candidate health and launcher cutover failures request exact-instance shutdown and restore the snapshot', async () => {
  for (const options of [{ healthFail: true }, { fail: 'symlink' }]) {
    const fix = fixture(); const run = harness(fix, options)
    await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /durable snapshot launcher and bridge were restored/)
    const stop = run.calls.find(call => call.control === 'shutdown_instance' && call.request.instanceId !== OLD_INSTANCE)
    assert.match(stop.request.instanceId, /^[a-f0-9]{32}$/)
    assert.match(readlinkSync(fix.launcherLink), /previous-plugin\/bin\/gelios-codex-telegram$/)
    assert.equal(run.runtime(), 'rollback')
  }
})

test('a candidate that exits after its receipt is restored without any PID signal', async () => {
  const fix = fixture(); const run = harness(fix, { fastCrash: true })
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /exited before.*durable snapshot/)
  assert.equal(run.calls.some(call => call.control === 'shutdown_instance' && call.runtime === 'candidate'), false)
  assert.equal(run.runtime(), 'rollback')
})

test('an unknown bridge appearing during activation is never stopped or joined by recovery', async () => {
  const fix = fixture(); const run = harness(fix, { fail: 'candidate', unknownCandidateOnFailure: true })
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /unknown bridge.*recovery refused/)
  assert.equal(run.calls.some(call => call.control === 'shutdown_instance'), false)
  assert.equal(run.calls.some(call => call.command?.includes('/previous-plugin/bin/')), false)
  assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), true)
})

test('a later invocation recovers an interrupted journal through the snapshot and completes forward', async () => {
  const fix = fixture(); const options = { fail: 'candidate', unknownCandidateOnFailure: true }
  const run = harness(fix, options)
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /unknown bridge/)
  const snapshotLauncher = readlinkSync(fix.launcherLink)
  run.setRuntime('stopped'); options.fail = null; options.unknownCandidateOnFailure = false
  run.dependencies.pluginRoot = join(snapshotLauncher, '..', '..')
  const resumedAt = run.calls.length
  const result = await runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies)
  assert.equal(result.updated, true)
  const resumedDiscovery = run.calls.slice(resumedAt).find(call => call.args?.join(' ') === 'plugin list --json')
  assert.match(resumedDiscovery.invocation.supervisorPath, /coordinator\/scripts\/update\.js$/)
  assert.equal(readlinkSync(fix.launcherLink), candidateLauncher(fix))
  assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), false)
})

test('recovery waits for the exact supervised updater subprocess before continuing', async () => {
  const fix = fixture(); const options = { commandStuck: true }; const run = harness(fix, options)
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /exact update subprocess is still running/)
  const journal = readFileSync(join(fix.stateDir, 'update-transaction.json'), 'utf8')
  assert.match(journal, /"pid": 505/)
  assert.doesNotMatch(journal, /marketplace-secret|audio-secret|other-runtime/)
  const snapshotLauncher = readlinkSync(fix.launcherLink)
  run.setProcess(505, false); options.commandStuck = false
  run.dependencies.pluginRoot = join(snapshotLauncher, '..', '..')
  const result = await runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies)
  assert.equal(result.updated, true)
})

test('rollback rejects refused sockets while an exact recorded bridge is still live and fails closed on indeterminate faults', async () => {
  for (const fault of ['ECONNREFUSED', 'EACCES', 'ECONNRESET', 'malformed control response', 'bridge control request timed out']) {
    const fix = fixture(); const run = harness(fix, { healthFail: true, socketFault: fault, socketFaultRuntime: 'candidate' })
    await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /control socket could not be classified/)
    assert.equal(run.calls.some(call => call.command?.includes('/previous-plugin/bin/')), false, fault)
    assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), true, fault)
  }
})

test('host-loss recovery accepts an owner-controlled stale Unix socket after exact recorded processes are gone', { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmp, 'telegram-stale-socket-'))
  const socket = join(root, 'control.sock')
  const source = `
    const net = require('node:net')
    const server = net.createServer()
    server.listen(${JSON.stringify(socket)}, () => process.send({ ready: true }))
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  await new Promise((resolvePromise, reject) => {
    exited(t, child).then(([code]) => reject(new Error(`socket owner exited before startup (${code})`)), reject)
    child.on('message', message => { if (message?.ready) resolvePromise() })
  })
  const identity = processInfo(child.pid).identity
  child.kill('SIGKILL')
  await closed(t, child)
  assert.equal(statSync(socket).isSocket(), true)
  assert.equal(await controlStatus(controlRequest, socket, {
    allowStale: true, receipts: [{ pid: child.pid, identity }],
  }), null)
})

test('a bridge that cannot self-stop is never force-signaled and leaves its recovery journal', async () => {
  const fix = fixture(); const run = harness(fix, { shutdownTimeout: true })
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /did not stop itself.*recovery also failed/)
  assert.equal(run.calls.some(call => call.command === candidateLauncher(fix)), false)
  assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), true)
  assert.match(readlinkSync(fix.launcherLink), /previous-plugin\/bin\/gelios-codex-telegram$/)
})

test('a clear stop rejection leaves the bridge running, while a lost response proceeds after verified exit', async () => {
  let fix = fixture(); let run = harness(fix, { stopError: 'healthy' })
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /active work appeared.*durable snapshot/)
  assert.equal(run.runtime(), 'old')
  assert.equal(run.calls.some(call => call.command?.includes('/previous-plugin/bin/')), false)

  fix = fixture(); run = harness(fix, { stopError: 'ambiguous' })
  const result = await runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies)
  assert.equal(result.updated, true)
  assert.equal(run.runtime(), 'candidate')
})

test('recovery reports a candidate that cannot self-stop instead of starting a competing bridge', async () => {
  const fix = fixture(); const run = harness(fix, { healthFail: true, terminationTimeout: true })
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /recovery also failed: bridge 202 did not stop itself/)
  assert.equal(run.calls.some(call => call.command?.includes('/previous-plugin/bin/')), false)
  assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), true)
})

test('snapshot health failure retains the journal for a later exact recovery', async () => {
  const fix = fixture(); const run = harness(fix, { healthFail: true, rollbackHealthFail: true })
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /recovery also failed: replacement bridge health check failed/)
  assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), true)
})

test('an unverifiable candidate process is never stopped or replaced by a competing bridge', async () => {
  const fix = fixture(); const run = harness(fix, { identityMissing: 202 })
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /identity could not be verified.*unverifiable process identity/)
  assert.equal(run.calls.some(call => call.control === 'shutdown_instance'), false)
  assert.equal(run.calls.some(call => call.command?.includes('/previous-plugin/bin/')), false)
})

test('launch profile and update lock enforce owner-only state and concurrency', () => {
  const fix = fixture()
  assert.equal(statSync(join(fix.stateDir, 'launch-profile.json')).mode & 0o777, 0o600)
  assert.equal(readProfile(fix.stateDir).marketplaceAuthEnv, 'TEST_MARKET_SLOT')
  assert.deepEqual(readProfile(fix.stateDir).codexRuntimeEnvs, ['TEST_MARKET_SLOT', 'TEST_OTHER_PAT'])
  const lockPath = join(fix.stateDir, 'update-locks')
  const release = acquireLock(lockPath)
  assert.equal(statSync(lockPath).mode & 0o777, 0o700)
  assert.equal(statSync(join(lockPath, '00000000000000000001.lock')).mode & 0o777, 0o600)
  assert.throws(() => acquireLock(lockPath), /already running/)
  release()

  const reclaimed = acquireLock(lockPath)
  assert.deepEqual(readdirSync(lockPath).filter(name => /^\d{20}\.lock$/.test(name)).sort(), [
    '00000000000000000001.lock', '00000000000000000002.lock',
  ])
  reclaimed()

  writeFileSync(join(lockPath, '00000000000000000003.lock'), '{"pid":999999999}\n', { mode: 0o600 })
  assert.throws(() => acquireLock(lockPath), /generation.*invalid/)

  let invalid = fixture()
  chmodSync(join(invalid.stateDir, 'launch-profile.json'), 0o644)
  assert.throws(() => readProfile(invalid.stateDir), /owner-only regular file/)

  invalid = fixture()
  const profilePath = join(invalid.stateDir, 'launch-profile.json')
  const target = join(invalid.root, 'profile-target.json')
  writeFileSync(target, readFileSync(profilePath), { mode: 0o600 })
  unlinkSync(profilePath); symlinkSync(target, profilePath)
  assert.throws(() => readProfile(invalid.stateDir), /owner-only regular file/)

  for (const name of ['LD_PRELOAD', 'BASH_ENV', 'NODE_PATH', 'GIT_EXEC_PATH', 'LC_DATABASE_PASSWORD', 'XDG_SESSION_TOKEN']) {
    invalid = fixture()
    const path = join(invalid.stateDir, 'launch-profile.json')
    const profile = JSON.parse(readFileSync(path, 'utf8'))
    profile.codexRuntimeEnvs = [name]
    writeFileSync(path, `${JSON.stringify(profile)}\n`, { mode: 0o600 })
    assert.throws(() => readProfile(invalid.stateDir), /invalid Codex runtime environment slots/, name)
  }
})

test('concurrent stale-lock reclamation elects exactly one updater generation', { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmp, 'telegram-lock-race-'))
  const lockPath = join(root, 'update-locks')
  mkdirSync(lockPath, { mode: 0o700 })
  const bootId = bootIdentity()
  writeFileSync(join(lockPath, '00000000000000000001.lock'), `${JSON.stringify({
    pid: 999_999_999, identity: '123', bootId, createdAt: 0, nonce: 'dead', released: false,
  })}\n`, { mode: 0o600 })
  const updaterUrl = new URL('../scripts/update.js', import.meta.url).href
  const source = `
    import { acquireLock } from ${JSON.stringify(updaterUrl)}
    process.send({ ready: true })
    process.once('message', () => {
      try {
        const release = acquireLock(${JSON.stringify(lockPath)})
        process.send({ won: true })
        setTimeout(() => { release(); process.exit(0) }, 300)
      } catch (error) {
        process.send({ won: false, error: error.message })
        process.exit(0)
      }
    })
  `
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  }))
  await Promise.all(children.map(child => new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.on('message', message => { if (message?.ready) resolvePromise() })
  })))
  const results = children.map(child => new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.on('message', message => { if (typeof message?.won === 'boolean') resolvePromise(message) })
  }))
  for (const child of children) child.send({ go: true })
  const settled = await Promise.all(results)
  assert.equal(settled.filter(result => result.won).length, 1)
  assert.match(settled.find(result => !result.won).error, /already running/)
  await Promise.all(children.map(child => exited(t, child)))
})

test('command failures redact bridge credentials and leave unrelated settings visible', async () => {
  const fix = fixture()
  const commandEnvs = environments(fix.profile, updateEnv(), join(fix.oldRoot, 'scripts', 'git-askpass.js'))
  const marketplaceOnly = environments({ ...fix.profile, codexRuntimeEnvs: ['TEST_OTHER_PAT'] }, updateEnv(), join(fix.oldRoot, 'scripts', 'git-askpass.js'))
  assert.equal(marketplaceOnly.bridge.TEST_MARKET_SLOT, AUTH_SECRET)
  assert.equal(marketplaceOnly.bridge.TEST_OTHER_PAT, OTHER_PAT)
  assert.equal(commandEnvs.validation.HTTPS_PROXY, undefined)
  assert.equal(commandEnvs.validation.LC_DATABASE_PASSWORD, undefined)
  assert.equal(commandEnvs.secrets.includes('p@ss'), false)
  assert.throws(() => environments(fix.profile, updateEnv({ TEST_AUDIO_SLOT: 'bad\nsecret' }), join(fix.oldRoot, 'scripts', 'git-askpass.js')), /control characters/)
  const marker = [AUTH_SECRET, 'ambient-gh-secret-example', 'ambient-github-secret-example', 'openrouter-secret-example'].join('|')
  await assert.rejects(runCommand(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(marker)}); process.exit(1)`], {
    env: commandEnvs.authenticated, secrets: commandEnvs.secrets, label: 'redaction probe',
  }), error => {
    assert.match(error.message, /\[redacted\]/)
    assert.doesNotMatch(error.message, /marketplace-secret-value-example/)
    assert.match(error.message, /ambient-gh-secret-example\|ambient-github-secret-example\|openrouter-secret-example/)
    return true
  })
  await assert.rejects(runCommand(process.execPath, ['-e', "process.stderr.write('abcdef|abc|p@ss|proxy-user') ; process.exit(1)"], {
    env: commandEnvs.validation, secrets: ['abc', 'abcdef', ...commandEnvs.secrets], label: 'overlap probe',
  }), error => {
    assert.doesNotMatch(error.message, /abcdef|abc/)
    assert.match(error.message, /p@ss\|proxy-user/)
    return true
  })
})

// Each process that still runs, named with its state, as both kill paths name it.
const named = live => live.map(({ pid, state }) => `${pid} (${state})`).join(', ')
const readReceipt = (path, keys) => { try { const receipt = JSON.parse(readFileSync(path, 'utf8')); return keys.map(key => receipt[key]) } catch { return [] } }

test('the independent command supervisor bounds and removes credential-bearing process trees', { timeout: 45_000 }, async t => {
  const root = mkdtempSync(join(tmp, 'telegram-command-tree-'))
  const updater = new URL('../scripts/update.js', import.meta.url); const coreUrl = new URL('../src/core.js', import.meta.url).href
  // Each tree opens a named pipe, its gate, as the last step once all of it runs and its receipts are written. The
  // path that ends the run reads that gate once before it reads or signals the group, which waits with no clock until
  // then, so no bound can end or act on the run before the tree it must remove has started.
  // The plugin's own supervisor with a bound of its own of 3 s, not the 60 s it
  // is given, so only its path can end the run within the test's bound: the
  // runner's own path waits 61 s. Its 3 s stop timer, the only timer of that
  // length it sets, waits on the tree's gate before the stop reads the group,
  // so no signal goes to a list read before the whole tree ran.
  const ownBound = join(root, 'own-bound.mjs')
  writeFileSync(ownBound, `import { readFileSync } from 'node:fs'\nconst bound = 3000\nconst schedule = globalThis.setTimeout\nglobalThis.setTimeout = (callback, ms, ...rest) => schedule(ms === bound ? (...given) => { readFileSync(process.env.TREE_GATE); return callback(...given) } : callback, ms, ...rest)\nprocess.argv[1] = ${JSON.stringify(fileURLToPath(updater))}; process.argv[3] = String(bound)\nawait import(${JSON.stringify(updater.href)})\n`)
  // A supervisor that ignores SIGTERM and never exits, so only the runner's own
  // path, at timeoutMs + 1000, can end the run.
  const stuck = join(root, 'stuck.mjs')
  writeFileSync(stuck, `import { spawn } from 'node:child_process'\nprocess.on('SIGTERM', () => {})\nconst [command, ...args] = process.argv.slice(4)\nspawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] })\nsetInterval(() => {}, 1000)\n`)
  // The holder's child stays in the command's group and ignores SIGTERM, while
  // the holder leaves the group and never reaps it: once killed with the group,
  // the child stays a zombie that is not yet reaped. The holder starts last of
  // the tree, and opens and closes the gate once its receipt is written.
  const holder = join(root, 'holder.py')
  writeFileSync(holder, ['import json, os, signal, sys, time', 'child = os.fork()', 'if child == 0:',
    '    signal.signal(signal.SIGTERM, signal.SIG_IGN)', '    while True: time.sleep(1)', 'os.setsid()',
    "with open(sys.argv[1] + '.tmp', 'w') as receipt: json.dump({'holder': os.getpid(), 'zombie': child}, receipt)",
    "os.rename(sys.argv[1] + '.tmp', sys.argv[1])", "open(sys.argv[2], 'w').close()", 'time.sleep(600)', ''].join('\n'))
  const trees = []
  cleanup(t, 'the command trees', async () => {
    for (const { spawned, held } of trees) {
      const [group] = readReceipt(spawned, ['pid'])
      if (group) await stopGroup(group)
      for (const pid of readReceipt(held, ['holder'])) try { process.kill(pid, 'SIGKILL') } catch {}
    }
  }, { timeout: 10_000 })
  for (const [path, supervisorPath, timeoutMs, ended, runnerGated] of [
    ["the supervisor's own path", ownBound, 60_000, /^stubborn tree failed: command timed out$/, false],
    ["the runner's own path", stuck, 3000, /^stubborn tree failed: timed out$/, true],
  ]) {
    const dir = mkdtempSync(join(root, 'tree-'))
    const script = join(dir, 'stubborn.mjs'); const receiptPath = join(dir, 'receipt.json'); const gate = join(dir, 'gate')
    const workerScript = join(dir, 'worker.mjs'); const outcomePath = join(dir, 'outcome.json')
    const tree = { spawned: join(dir, 'spawned.json'), held: join(dir, 'holder.json') }; trees.push(tree)
    execFileSync('mkfifo', [gate])
    writeFileSync(script, `import { spawn } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\nprocess.on('SIGTERM',()=>{})\nconst child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'})\nwriteFileSync(${JSON.stringify(receiptPath)},JSON.stringify({pid:process.pid,child:child.pid}))\nspawn('python3',${JSON.stringify([holder, tree.held, gate])},{stdio:'ignore',env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR}})\nsetInterval(()=>{},1000)\n`)
    // The runner runs in a worker, so on the runner's own path its first signal to the group can wait on the gate
    // without blocking the test's own process.
    writeFileSync(workerScript, `
      import { atomicWriteJson } from ${JSON.stringify(coreUrl)}
      import { readFileSync } from 'node:fs'
      const kill = process.kill.bind(process)
      let opened = ${!runnerGated}
      process.kill = (pid, signal) => { if (!opened && pid < 0 && signal !== 0) { readFileSync(${JSON.stringify(gate)}); opened = true } return kill(pid, signal) }
      const { runCommand } = await import(${JSON.stringify(updater.href)})
      runCommand(process.execPath, [${JSON.stringify(script)}], {
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TREE_SECRET: 'never-persist-example', TREE_GATE: ${JSON.stringify(gate)} },
        timeoutMs: ${timeoutMs}, supervisorPath: ${JSON.stringify(supervisorPath)}, label: 'stubborn tree', secrets: ['never-persist-example'],
        onSpawn: receipt => atomicWriteJson(${JSON.stringify(tree.spawned)}, receipt),
      }).then(() => atomicWriteJson(${JSON.stringify(outcomePath)}, { message: null }), error => atomicWriteJson(${JSON.stringify(outcomePath)}, { message: error.message }))
    `)
    const worker = spawn(process.execPath, [workerScript], { stdio: ['ignore', 'ignore', 'inherit'] })
    const known = () => [...readReceipt(tree.spawned, ['pid']), ...readReceipt(receiptPath, ['pid', 'child']), ...readReceipt(tree.held, ['zombie'])].filter(Number.isInteger)
    // The worker publishes by rename; the wait reads its outcome, or ends when it has exited without one.
    const outcome = await until(t, () => (existsSync(outcomePath) && JSON.parse(readFileSync(outcomePath, 'utf8'))) ||
      (worker.exitCode !== null && { message: `the worker exited ${worker.exitCode} without settling` }),
    () => `runCommand to settle on ${path}; still running: ${named(liveProcesses(known())) || 'none'}`)
    const [supervisor, identity] = readReceipt(tree.spawned, ['pid', 'identity'])
    const [pid, child] = readReceipt(receiptPath, ['pid', 'child']); const [zombie] = readReceipt(tree.held, ['zombie'])
    assert.ok([supervisor, pid, child, zombie].every(Number.isInteger), `the tree on ${path} wrote its receipts`)
    // Every pid at once after the rejection: each is gone or a zombie.
    const running = liveProcesses([supervisor, pid, child, zombie])
    assert.deepEqual(running, [], `still running once runCommand settled on ${path}: ${named(running)}`)
    // A child reaped already prints nothing, so the assertion names it as gone rather than failing inside ps.
    const zombieState = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(zombie)], { encoding: 'utf8' }).stdout.trim() || 'gone'
    assert.match(zombieState, /^Z/, `the holder's killed child ${zombie} on ${path} is a zombie not yet reaped: ${zombieState}`)
    assert.match(outcome.message ?? 'runCommand resolved', ended)
    assert.match(String(identity), /^\d+$/)
  }
})

test('the independent supervisor removes descendants after the outer updater is killed', { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmp, 'telegram-orphan-tree-'))
  const directScript = join(root, 'direct.mjs')
  const workerScript = join(root, 'worker.mjs')
  const supervisorPath = join(root, 'supervisor.json')
  const descendantPath = join(root, 'descendant.json')
  const coreUrl = new URL('../src/core.js', import.meta.url).href
  writeFileSync(directScript, `
    import { spawn } from 'node:child_process'
    import { once } from 'node:events'
    import { atomicWriteJson } from ${JSON.stringify(coreUrl)}
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
    child.unref()
    // The descendant answers once it ignores SIGTERM, so only the drain's SIGKILL ends it.
    await once(child.stdout, 'data')
    atomicWriteJson(${JSON.stringify(descendantPath)}, { pid: child.pid })
    process.exit(0)
  `)
  const updaterUrl = new URL('../scripts/update.js', import.meta.url).href
  writeFileSync(workerScript, `
    import { atomicWriteJson } from ${JSON.stringify(coreUrl)}
    import { runCommand } from ${JSON.stringify(updaterUrl)}
    await runCommand(process.execPath, [${JSON.stringify(directScript)}], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TREE_SECRET: 'must-not-outlive-supervisor-example' },
      timeoutMs: 5000, label: 'outer-crash tree', secrets: ['must-not-outlive-supervisor-example'],
      onSpawn: receipt => atomicWriteJson(${JSON.stringify(supervisorPath)}, receipt),
    })
  `)
  const worker = spawn(process.execPath, [workerScript], { stdio: ['ignore', 'ignore', 'inherit'] })
  // Both writers publish by rename; the wait reads the receipts it needs.
  const [supervisor, descendant] = await until(t, () => existsSync(supervisorPath) && existsSync(descendantPath) &&
    [JSON.parse(readFileSync(supervisorPath, 'utf8')), JSON.parse(readFileSync(descendantPath, 'utf8'))], 'the supervisor and descendant receipts')
  worker.kill('SIGKILL')
  await closed(t, worker)
  await until(t, () => !liveProcesses([supervisor.pid, descendant.pid]).length,
    () => `the supervisor to remove the orphaned tree; still running: ${named(liveProcesses([supervisor.pid, descendant.pid]))}`)
})

// Each thread of a process that still runs, read per thread and apart from liveProcesses, the reader under test.
const runningThreads = pid => {
  try { return readdirSync(`/proc/${pid}/task`).filter(tid => { try { const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8'); return !/^[ZX]/.test(stat.slice(stat.lastIndexOf(') ') + 2)) } catch { return false } }) } catch { return [] }
}
const compiler = spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0
test('the independent supervisor removes a descendant whose main thread has exited while another thread runs', {
  timeout: 60_000, skip: process.platform !== 'linux' ? 'reads each thread through /proc' : !compiler && 'requires a C compiler',
}, async t => {
  const root = mkdtempSync(join(tmp, 'telegram-thread-tree-'))
  const lead = join(root, 'lead'); const directScript = join(root, 'direct.mjs'); const workerScript = join(root, 'worker.mjs')
  const supervisorPath = join(root, 'supervisor.json'); const descendantPath = join(root, 'descendant.json')
  // Its main thread exits while a second thread sleeps on, so /proc/<pid>/stat reads Z while the process runs.
  writeFileSync(`${lead}.c`, '#include <pthread.h>\n#include <stdio.h>\n#include <unistd.h>\nstatic void *work(void *arg) { (void)arg; for (;;) sleep(1); return 0; }\nint main(void) { pthread_t t; pthread_create(&t, 0, work, 0); printf("%d\\n", getpid()); fflush(stdout); pthread_exit(0); }\n')
  execFileSync('cc', ['-pthread', `${lead}.c`, '-o', lead])
  const coreUrl = new URL('../src/core.js', import.meta.url).href
  writeFileSync(directScript, `
    import { spawn } from 'node:child_process'
    import { once } from 'node:events'
    import { atomicWriteJson } from ${JSON.stringify(coreUrl)}
    const child = spawn(${JSON.stringify(lead)}, [], { stdio: ['ignore', 'pipe', 'ignore'] })
    const pid = Number(String((await once(child.stdout, 'data'))[0]).trim())
    atomicWriteJson(${JSON.stringify(descendantPath)}, { pid, direct: process.pid })
    setInterval(() => {}, 1000)
  `)
  const updaterUrl = new URL('../scripts/update.js', import.meta.url).href
  writeFileSync(workerScript, `
    import { atomicWriteJson } from ${JSON.stringify(coreUrl)}
    import { runCommand } from ${JSON.stringify(updaterUrl)}
    await runCommand(process.execPath, [${JSON.stringify(directScript)}], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, timeoutMs: 60_000, label: 'thread tree',
      onSpawn: receipt => atomicWriteJson(${JSON.stringify(supervisorPath)}, receipt),
    })
  `)
  const worker = spawn(process.execPath, [workerScript], { stdio: ['ignore', 'ignore', 'inherit'] })
  // Both writers publish by rename; the wait reads the receipts it needs.
  const [supervisor, descendant] = await until(t, () => existsSync(supervisorPath) && existsSync(descendantPath) &&
    [JSON.parse(readFileSync(supervisorPath, 'utf8')), JSON.parse(readFileSync(descendantPath, 'utf8'))], 'the supervisor and descendant receipts')
  t.after(() => { for (const pid of [supervisor.pid, descendant.direct, descendant.pid]) if (runningThreads(pid).length) try { process.kill(pid, 'SIGKILL') } catch {} })
  const mainThread = () => { const stat = readFileSync(`/proc/${descendant.pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(') ') + 2)[0] }
  await until(t, () => mainThread() === 'Z' && runningThreads(descendant.pid).length, "the descendant's main thread to exit while its other thread runs")
  worker.kill('SIGKILL')
  await closed(t, worker)
  // The command ends only now, so the supervisor's drain meets the descendant with its main thread exited.
  process.kill(descendant.direct, 'SIGKILL')
  const threads = pid => runningThreads(pid).join(', ') || 'none'
  await until(t, () => !runningThreads(supervisor.pid).length && !runningThreads(descendant.pid).length,
    () => `the supervisor to remove the orphaned tree; threads still running: supervisor ${threads(supervisor.pid)}, descendant ${threads(descendant.pid)}`)
})

// The runner's group signals are dropped inside a worker, so the group outlives the runner's SIGKILL with real
// processes, read by the plugin's own live check; each path then fails after the two-second wait, naming why the
// step stopped and each process that still runs. Each path is a test of its own, under a bound of its own.
// A holder that stays in the group beside its own child, which exits at once and is never reaped: a zombie. It
// publishes both pids by rename, then opens and closes the gate the worker reads at its first signal to the group.
const survivorHolder = ['import json, os, sys, time', 'zombie = os.fork()', 'if zombie == 0: os._exit(0)',
  "with open(sys.argv[1] + '.tmp', 'w') as receipt: json.dump({'holder': os.getpid(), 'zombie': zombie}, receipt)",
  "os.rename(sys.argv[1] + '.tmp', sys.argv[1])", "open(sys.argv[2], 'w').close()", 'time.sleep(600)'].join('\n')
// A supervisor that ignores SIGTERM and never exits, holding the runner's pipes. Its group holds its child, a member
// the worker stops one second into the wait, and, started last, the holder. It publishes by rename the pids it
// started, so the test knows which processes the failure must name and which it must not.
const survivorStuck = `import { spawn } from 'node:child_process'\nimport { renameSync, writeFileSync } from 'node:fs'\nprocess.on('SIGTERM', () => {})\nconst [command, ...args] = process.argv.slice(4)\nconst child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] })\nconst stopped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })\nconst { SURVIVOR_MEMBERS: members, SURVIVOR_HOLDER: holder, SURVIVOR_GATE: gate } = process.env\nwriteFileSync(members + '.tmp', JSON.stringify({ child: child.pid, stopped: stopped.pid })); renameSync(members + '.tmp', members)\nspawn('python3', ['-c', ${JSON.stringify(survivorHolder)}, holder, gate], { stdio: 'ignore' })\nsetInterval(() => {}, 1000)\n`
// A supervisor that exits 0 at once, leaving a process in its group that holds none of its pipes.
const survivorLeave = `import { spawn } from 'node:child_process'\nspawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref()\n`
// The same supervisor exiting 1, so the close path meets the group after a failed command.
const survivorFail = `${survivorLeave}process.exitCode = 1\n`
// A state as /proc or ps prints it for a process that still runs, such as S on Linux or Ss+ on macOS: its letter
// (Linux's R S D T t W P I K, and macOS ps's R U S I T H ?), then any of the marks macOS ps adds. A number or any
// other text in its place is not a state.
const runState = String.raw`[DHIKPRSTUWt?][+<>AELNSVWXs]*`
const survivorStill = String.raw`command process group (\d+) did not terminate: \d+ \(${runState}\)`
for (const [path, supervisor, refuse, ended] of [
  ['the timeout path', survivorStuck, false, new RegExp(String.raw`^survivor failed: timed out; ${survivorStill}(, \d+ \(${runState}\))*$`)],
  ['the close path', survivorLeave, false, new RegExp(`^survivor failed: exit 0; ${survivorStill}$`)],
  ['the close path of a failed command', survivorFail, false, new RegExp(`^survivor failed: exit 1; ${survivorStill}$`)],
  ['the spawn error path', survivorStuck, true, new RegExp(String.raw`^survivor failed: refused; ${survivorStill}(, \d+ \(${runState}\))*$`)],
]) {
  test(`a group that outlives the runner's SIGKILL fails ${path} after the two-second wait, naming why the step stopped and what still runs`, {
    timeout: 30_000, skip: process.platform === 'win32' && 'process groups',
  }, async t => {
    const root = mkdtempSync(join(tmp, 'telegram-survivor-'))
    const updaterUrl = new URL('../scripts/update.js', import.meta.url).href; const coreUrl = new URL('../src/core.js', import.meta.url).href
    const supervisorPath = join(root, 'supervisor.mjs'); const receiptPath = join(root, 'receipt.json')
    const groupPath = join(root, 'group.json'); const workerScript = join(root, 'worker.mjs')
    const membersPath = join(root, 'members.json'); const holderPath = join(root, 'holder.json'); const gatePath = join(root, 'gate')
    writeFileSync(supervisorPath, supervisor)
    cleanup(t, 'the surviving group', async () => {
      if (existsSync(groupPath)) await stopGroup(JSON.parse(readFileSync(groupPath, 'utf8')).group)
    }, { timeout: 15_000 })
    writeFileSync(workerScript, `
      import { atomicWriteJson } from ${JSON.stringify(coreUrl)}
      import { execFileSync } from 'node:child_process'
      import { readFileSync } from 'node:fs'
      const kill = process.kill.bind(process)
      const gated = ${supervisor === survivorStuck}
      let killed = null; let members = null
      if (gated) execFileSync('mkfifo', [${JSON.stringify(gatePath)}])
      process.kill = (pid, signal) => {
        if (pid >= 0) return kill(pid, signal)
        // The first signal to the group waits on the gate, with no clock, until the holder, started last, has opened
        // and closed it: every member then runs before any signal, so the wait's last read lists each that still runs.
        // The supervisor's child is then paused with SIGSTOP, which the dropped group signals never undo, so the
        // failure must name it with a stopped state while the others carry their own.
        if (gated && !members) { readFileSync(${JSON.stringify(gatePath)}); members = JSON.parse(readFileSync(${JSON.stringify(membersPath)}, 'utf8')); kill(members.child, 'SIGSTOP') }
        // The first SIGKILL to the group starts the window, so a path that kills and waits again cannot restart it.
        // One member stops one second into the wait, so the first read lists it and the last cannot.
        if (signal === 'SIGKILL' && killed === null) { killed = Date.now(); if (members) setTimeout(() => kill(members.stopped, 'SIGKILL'), 1000) }
        return true
      }
      const { runCommand } = await import(${JSON.stringify(updaterUrl)})
      runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, SURVIVOR_MEMBERS: ${JSON.stringify(membersPath)}, SURVIVOR_HOLDER: ${JSON.stringify(holderPath)}, SURVIVOR_GATE: ${JSON.stringify(gatePath)} }, timeoutMs: 500, label: 'survivor', supervisorPath: ${JSON.stringify(supervisorPath)},
        onSpawn: receipt => { atomicWriteJson(${JSON.stringify(groupPath)}, { group: receipt.pid }); if (${refuse}) throw new Error('refused') },
      }).then(() => atomicWriteJson(${JSON.stringify(receiptPath)}, { message: 'resolved', killed, settled: Date.now() }),
        error => atomicWriteJson(${JSON.stringify(receiptPath)}, { message: error.message, killed, settled: Date.now() }))
    `)
    const worker = spawn(process.execPath, [workerScript], { stdio: ['ignore', 'ignore', 'inherit'] })
    // Both writers publish by rename; the wait reads the receipt, or ends when the worker has exited without one.
    const settled = await until(t, () => (existsSync(receiptPath) && JSON.parse(readFileSync(receiptPath, 'utf8'))) ||
      (worker.exitCode !== null && { message: `the worker exited ${worker.exitCode} without settling` }), `runCommand to settle on ${path}`)
    const { group } = JSON.parse(readFileSync(groupPath, 'utf8'))
    const match = ended.exec(settled.message)
    assert.ok(match, `the rejection on ${path} names why the step stopped, its group and each process that runs: ${settled.message}`)
    assert.equal(Number(match[1]), group, `the rejection on ${path} names the command's group`)
    if (supervisor === survivorStuck) {
      // Every member ran before the first signal, so the failure names exactly those still running at the wait's last
      // read, each once: the supervisor, whose pid is the group's, its child and the holder; never the member stopped
      // one second into the wait, nor the holder's zombie.
      const { child, stopped } = JSON.parse(readFileSync(membersPath, 'utf8')); const { holder, zombie } = JSON.parse(readFileSync(holderPath, 'utf8'))
      const named = [...settled.message.matchAll(new RegExp(String.raw`(\d+) \(${runState}\)`, 'g'))].map(([, pid]) => Number(pid))
      const sorted = pids => [...pids].sort((a, b) => a - b)
      assert.deepEqual(sorted(named), sorted([group, child, holder]),
        `the rejection on ${path} names the supervisor ${group}, its child ${child} and the holder ${holder} once each, and neither the stopped ${stopped} nor the zombie ${zombie}: ${settled.message}`)
      // Each name carries its own process's state: the paused child's is stopped, T on Linux and macOS alike, and the
      // supervisor's and the holder's are not. Not T rather than S, since a sleeper can read R or D for an instant.
      const states = new Map([...settled.message.matchAll(new RegExp(String.raw`(\d+) \((${runState})\)`, 'g'))].map(([, pid, state]) => [Number(pid), state]))
      assert.match(states.get(child), /^T/, `the rejection on ${path} names the paused child ${child} with its stopped state: ${settled.message}`)
      for (const pid of [group, holder]) assert.doesNotMatch(states.get(pid), /^T/, `the rejection on ${path} names ${pid}, which was never paused, with its own state: ${settled.message}`)
    }
    assert.ok(Number.isInteger(settled.killed) && settled.settled - settled.killed >= 2000,
      `runCommand settled on ${path} ${settled.settled - settled.killed} ms after the SIGKILL, before the two-second wait ended`)
    // A bound that grows fails here: twice the wait leaves load its room.
    assert.ok(settled.settled - settled.killed < 4000,
      `runCommand settled on ${path} ${settled.settled - settled.killed} ms after the SIGKILL, past twice the two-second wait`)
  })
}

// The supervisor's own signals are dropped, so its drain meets a group that outlives its SIGKILL.
test("the supervisor's drain fails after its two-second wait, naming each process that runs, when its group outlives the SIGKILL", {
  timeout: 30_000, skip: process.platform === 'win32' && 'process groups',
}, async t => {
  const root = mkdtempSync(join(tmp, 'telegram-drain-survivor-'))
  const updater = new URL('../scripts/update.js', import.meta.url)
  const drop = join(root, 'drop.mjs')
  // It keeps in memory, by its own clock, when its drain sends the first SIGKILL it drops, the moment the drain's wait
  // counts from, and when it writes the drain's failure, the moment that wait gave up; it writes both only as it exits,
  // so nothing but the drain's own wait sits between the two stamps the floor reads.
  const stampsPath = join(root, 'stamps.json'); const coreUrl = new URL('../src/core.js', import.meta.url).href
  writeFileSync(drop, `import { atomicWriteJson } from ${JSON.stringify(coreUrl)}\nconst kill = process.kill.bind(process)\nlet killed = null; let failed = null\nconst write = process.stderr.write.bind(process.stderr)\nprocess.stderr.write = (chunk, ...rest) => { if (killed !== null && String(chunk).includes('did not terminate')) failed ??= Date.now(); return write(chunk, ...rest) }\nprocess.on('exit', () => atomicWriteJson(${JSON.stringify(stampsPath)}, { killed, failed }))\nprocess.kill = (pid, signal) => { if (signal === 0) return kill(pid, signal); if (signal === 'SIGKILL') killed ??= Date.now(); return true }\nprocess.argv[1] = ${JSON.stringify(fileURLToPath(updater))}\nawait import(${JSON.stringify(updater.href)})\n`)
  // The command exits 0 at once, leaving a process in its group that holds none of the supervisor's pipes.
  const command = join(root, 'leave.mjs')
  writeFileSync(command, `import { spawn } from 'node:child_process'\nspawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref()\n`)
  let group = null; let outcome
  cleanup(t, 'the surviving group', async () => { if (group) await stopGroup(group) }, { timeout: 15_000 })
  runCommand(process.execPath, [command], {
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, timeoutMs: 20_000, label: 'drain survivor', supervisorPath: drop,
    onSpawn: receipt => { group = receipt.pid },
  }).then(() => { outcome = { message: 'resolved', at: Date.now() } }, error => { outcome = { message: error.message, at: Date.now() } })
  await until(t, () => outcome, "runCommand to settle on the supervisor's drain")
  const match = new RegExp(String.raw`^drain survivor failed: command process group (\d+) did not terminate: \d+ \(${runState}\)$`).exec(outcome.message)
  assert.ok(match, `the supervisor's rejection names its group and each process that runs: ${outcome.message}`)
  assert.equal(Number(match[1]), group, "the rejection names the command's group")
  // The drain writes its failure only after its whole two-second wait; the runner settles under that wait twice and its own 250 ms grace.
  const { killed, failed } = JSON.parse(readFileSync(stampsPath, 'utf8'))
  assert.ok(Number.isInteger(killed) && Number.isInteger(failed), `the supervisor stamped the drain's SIGKILL (${killed}) and its failure (${failed})`)
  assert.ok(failed - killed >= 2000, `the drain wrote its failure ${failed - killed} ms after its SIGKILL, before its two-second wait ended`)
  assert.ok(outcome.at - killed < 4250, `runCommand settled ${outcome.at - killed} ms after the drain's SIGKILL, past 4250 ms`)
})

test('Git askpass releases the token only for the fixed github.com host', async () => {
  const fix = fixture(); const helper = join(fix.oldRoot, 'scripts', 'git-askpass.js')
  writeFileSync(helper, readFileSync(new URL('../scripts/git-askpass.js', import.meta.url)), { mode: 0o700 })
  const env = { PATH: process.env.PATH, GH_TOKEN: AUTH_SECRET, GELIOS_GIT_AUTH_HOST: 'github.com' }
  const username = await runCommand(process.execPath, [helper, "Username for 'https://github.com': "], { env })
  const password = await runCommand(process.execPath, [helper, "Password for 'https://x-access-token@github.com': "], { env })
  assert.equal(username.stdout, 'x-access-token\n'); assert.equal(password.stdout, `${AUTH_SECRET}\n`)
  await assert.rejects(runCommand(process.execPath, [helper, "Password for 'https://evil.example': "], {
    env, secrets: [AUTH_SECRET], label: 'askpass host check',
  }), /askpass host check failed/)
})


test('legacy migration selects the public package, retires only its old selection and preserves the saved profile', async () => {
  const fix = fixture(), targetPlugin = { name: 'telegram', marketplaceName: 'codex-telegram' }
  const manifestPath = join(fix.candidateRoot, '.codex-plugin', 'plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath)); manifest.name = 'telegram'; manifest.skills = './skills/'
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const mcpPath = join(fix.candidateRoot, '.mcp.json'), mcp = JSON.parse(readFileSync(mcpPath))
  mcp.mcpServers.telegram = mcp.mcpServers['gelios-codex-telegram']; delete mcp.mcpServers['gelios-codex-telegram']
  writeFileSync(mcpPath, JSON.stringify(mcp))
  for (const path of ['bin/codex-telegram','scripts/setup.js','src/bootstrap.js','src/local-setup.js','scripts/restart.js','src/restart.js','src/systemd.js','skills/configure/SKILL.md','skills/access/SKILL.md']) {
    const full = join(fix.candidateRoot, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, 'fixture')
  }
  const installed = [
    { name: 'portable-telegram', marketplaceName: 'test-market', enabled: true, installed: true },
    { ...targetPlugin, enabled: true, installed: true },
    { name: 'other-plugin', marketplaceName: 'test-market', enabled: true, installed: true },
  ]
  const run = harness(fix, { targetPlugin, installed, marketplaces: [{ name: 'test-market' }, { name: 'codex-telegram' }] })
  const result = await runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies)
  assert.equal(result.marketplace, 'codex-telegram')
  const removed = run.calls.filter(call => call.args?.[1] === 'remove')
  assert.deepEqual(removed.map(call => call.args[2]), ['portable-telegram@test-market'])
  const stop = run.calls.findIndex(call => call.control === 'stop_for_update')
  assert.ok(run.calls.indexOf(removed[0]) > stop)
  assert.match(removed[0].launcherTarget, /previous-plugin/)
  assert.deepEqual(JSON.parse(readFileSync(join(fix.stateDir, 'launch-profile.json'))), fix.profile)
})

function installationFixture() {
  const fix = fixture(), nativeRoot = join(fix.root, 'native'), nativeBin = join(nativeRoot, 'bin', 'codex')
  mkdirSync(dirname(nativeBin), { recursive: true }); writeFileSync(nativeBin, '#!/bin/sh\necho original-native\n', { mode: 0o700 })
  writeFileSync(join(nativeRoot, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, entrypoint: 'bin/codex' }))
  fix.profile.bridgeArgs = fix.profile.bridgeArgs.map(arg => arg === fix.codexBin ? nativeBin : arg)
  fix.codexBin = nativeBin; fix.profile.codexBin = nativeBin
  writeFileSync(join(fix.stateDir, 'launch-profile.json'), JSON.stringify(fix.profile), { mode: 0o600 })
  fix.installerRoot = join(fix.root, 'npm/lib/node_modules/@axeg0/codex-telegram')
  fix.installerEntry = join(fix.root, 'npm/bin/codex-telegram')
  mkdirSync(fix.installerRoot, { recursive: true }); mkdirSync(dirname(fix.installerEntry), { recursive: true })
  const manifest = { name: '@axeg0/codex-telegram', version: '1.0.0', bin: { 'codex-telegram': 'launcher.js' } }
  writeFileSync(join(fix.installerRoot, 'package.json'), JSON.stringify(manifest)); writeFileSync(join(fix.installerRoot, 'launcher.js'), 'original launcher\n', { mode: 0o700 }); symlinkSync(join(fix.installerRoot, 'launcher.js'), fix.installerEntry)
  fix.marketplaceRoot = join(fix.root, 'marketplace'); mkdirSync(fix.marketplaceRoot)
  writeFileSync(join(fix.marketplaceRoot, 'package.json'), JSON.stringify({ ...manifest, version: '2.0.0' }))
  return fix
}
function installationHarness(fix, options = {}) {
  return harness(fix, { all: true, marketplaces: [{ name: 'test-market', root: fix.marketplaceRoot }], ...options })
}
const allOptions = fix => ({ stateDir: fix.stateDir, env: updateEnv(), all: true, installerRoot: fix.installerRoot })

test('combined update alone repairs an already-pruned launcher and keeps the same conversation', async () => {
  const fix = installationFixture(), removed = join(fix.root, 'cache', 'telegram', '1.0.0')
  mkdirSync(dirname(removed), { recursive: true }); renameSync(fix.oldRoot, removed); fix.oldRoot = removed
  unlinkSync(fix.launcherLink); symlinkSync(join(removed, 'bin/gelios-codex-telegram'), fix.launcherLink)
  const run = installationHarness(fix)
  run.dependencies.recoveryRoot = fix.candidateRoot
  rmSync(removed, { recursive: true })
  assert.throws(() => realpathSync(fix.launcherLink), /ENOENT/)
  const result = await runUpdate(allOptions(fix), run.dependencies)
  assert.equal(result.version, '2.0.0'); assert.equal(result.launcherVersion, '2.0.0')
  assert.equal(realpathSync(fix.launcherLink), candidateLauncher(fix))
  assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), false)
  assert.ok(run.calls.some(call => call.args?.join(' ') === 'update'))
  const restarts = run.calls.filter(call => call.command?.includes('/runtime-builds/') && call.args?.[0] === 'bridge')
  assert.equal(restarts.length, 1)
  assert.equal(JSON.parse(readFileSync(join(fix.stateDir, 'launch-profile.json'))).launcherLink, fix.launcherLink)
})

test('combined update recovers a stopped service before upgrading without replacing its saved conversation', async () => {
  const fix = installationFixture(), run = installationHarness(fix)
  run.setRuntime('stopped')
  const result = await runUpdate(allOptions(fix), run.dependencies)
  assert.equal(result.version, '2.0.0')
  assert.equal(realpathSync(fix.launcherLink), candidateLauncher(fix))
  const recovery = run.calls.find(call => call.command?.includes('/runtime-builds/') && call.command !== candidateLauncher(fix) && call.args?.[0] === 'bridge')
  assert.ok(recovery, 'cold recovery uses a durable build and the existing profile')
  assert.deepEqual(recovery.args.slice(3), fix.profile.bridgeArgs)
})

test('dangling recovery never replaces an unrelated owner-controlled launcher', async () => {
  const fix = installationFixture(), run = installationHarness(fix)
  unlinkSync(fix.launcherLink); symlinkSync(join(fix.root, 'unrelated/bin/gelios-codex-telegram'), fix.launcherLink)
  await assert.rejects(runUpdate(allOptions(fix), run.dependencies), /not a recognized plugin installation/)
  assert.equal(readlinkSync(fix.launcherLink), join(fix.root, 'unrelated/bin/gelios-codex-telegram'))
  assert.equal(run.calls.length, 0)
})

test('combined update stages all components and restarts the original conversation', async () => {
  const fix = installationFixture(), run = installationHarness(fix)
  const result = await runUpdate(allOptions(fix), run.dependencies)
  assert.equal(result.codexVersion, 'codex-cli 0.162.0'); assert.equal(result.launcherVersion, '2.0.0')
  const native = run.calls.findIndex(c => c.args?.join(' ') === 'update'), stopped = run.calls.findIndex(c => c.control === 'stop_for_update'), restart = run.calls.findIndex(c => c.command === candidateLauncher(fix))
  assert.ok(stopped >= 0 && native > stopped)
  assert.ok(run.calls.findIndex(c => c.command === 'npm' && c.args[0] === 'install') < restart)
  assert.match(readFileSync(fix.codexBin, 'utf8'), /updated-native/)
  assert.equal(JSON.parse(readFileSync(join(fix.installerRoot, 'package.json'))).version, '2.0.0')
  for (const call of run.calls.filter(c => c.args?.join(' ') === 'update' || c.command === 'npm')) {
    assert.equal(call.invocation.env.TEST_AUDIO_SLOT, undefined); assert.equal(call.invocation.env.TEST_OTHER_PAT, undefined); assert.equal(call.invocation.env.GH_TOKEN, undefined)
  }
})

test('combined update restores native and launcher packages after partial component and activation failures', async () => {
  for (const fail of ['codex', 'upgrade', 'install', 'launcher', 'candidate']) {
    const fix = installationFixture(), nativeBefore = packageDigest(dirname(dirname(fix.codexBin))), launcherBefore = packageDigest(fix.installerRoot), run = installationHarness(fix, { fail })
    await assert.rejects(runUpdate(allOptions(fix), run.dependencies), /durable snapshot launcher and bridge were restored/)
    assert.equal(run.runtime(), 'rollback', fail)
    assert.equal(packageDigest(dirname(dirname(fix.codexBin))), nativeBefore, fail)
    assert.equal(packageDigest(fix.installerRoot), launcherBefore, fail)
    assert.equal(realpathSync(fix.installerEntry), join(fix.installerRoot, 'launcher.js'))
    assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), false)
  }
})

test('interrupted combined updates recover without a usable Codex command and reject changed recovery code', async () => {
  const fix = installationFixture(), run = installationHarness(fix, { commandStuck: true })
  await assert.rejects(runUpdate(allOptions(fix), run.dependencies), /exact update subprocess is still running/)
  const updater = recoveryUpdater(fix.stateDir); assert.match(updater, /coordinator\/scripts\/update\.js$/)
  unlinkSync(fix.codexBin)
  assert.equal(recoveryUpdater(fix.stateDir), updater)
  const original = readFileSync(updater); writeFileSync(updater, 'changed')
  assert.throws(() => recoveryUpdater(fix.stateDir), /recovery code changed/); writeFileSync(updater, original)
  run.setProcess(505, false)
  const recovered = installationHarness(fix); recovered.setRuntime('stopped')
  const result = await runUpdate(allOptions(fix), recovered.dependencies)
  assert.equal(result.codexVersion, 'codex-cli 0.162.0')
  assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), false)
})


test('combined activation commits a conversation with approvals on before the update that the update restored with approvals off', async () => {
  // Every conversation runs in YOLO mode: the replacement restores it so, whatever it ran with before.
  const yolo = { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, activePermissionProfile: { id: ':danger-full-access' } }
  const before = { approvalPolicy: { reject: { sandboxApproval: true, rules: true, mcpElicitations: true } }, sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: ['/project'] }, activePermissionProfile: { id: 'selected-profile' } }
  const fix = installationFixture(), run = installationHarness(fix, { policies: { old: before, candidate: yolo, rollback: before } })
  assert.equal((await runUpdate(allOptions(fix), run.dependencies)).launcherVersion, '2.0.0')
  assert.equal(run.runtime(), 'candidate')
})

test('combined activation rolls back a replacement that restored the conversation outside YOLO mode', async () => {
  const before = { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, activePermissionProfile: null }
  const outside = {
    approvals: { ...before, approvalPolicy: 'on-request' },
    sandbox: { ...before, sandboxPolicy: { type: 'readOnly' } },
    unknown: null,
  }
  for (const restored of Object.values(outside)) {
    const fix = installationFixture(), run = installationHarness(fix, { policies: { old: before, candidate: restored, rollback: before } })
    await assert.rejects(runUpdate(allOptions(fix), run.dependencies), /restored the conversation outside YOLO mode/)
    assert.equal(run.runtime(), 'rollback')
  }
})

test('combined activation commits an installation with no bound conversation, which reports no policy', async () => {
  const fix = installationFixture(), run = installationHarness(fix, { threadId: null })
  assert.equal((await runUpdate(allOptions(fix), run.dependencies)).launcherVersion, '2.0.0')
  assert.equal(run.runtime(), 'candidate')
})


test('same-version retry recognizes code retained in an owner-only recovery copy', async () => {
  const fix = installationFixture()
  cpSync(fix.oldRoot, fix.candidateRoot, { recursive: true })
  const restrict = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) restrict(path); else chmodSync(path, statSync(path).mode & 0o700) } }
  restrict(fix.oldRoot)
  const metadata = JSON.parse(readFileSync(join(fix.marketplaceRoot, 'package.json'))); metadata.version = '1.0.0'; writeFileSync(join(fix.marketplaceRoot, 'package.json'), JSON.stringify(metadata))
  const run = installationHarness(fix, { candidateVersion: '1.0.0' })
  assert.equal((await runUpdate(allOptions(fix), run.dependencies)).refreshed, true)
})

test('installed supervised cutover needs no runtime, transcription or marketplace credentials', () => {
  const fix = fixture()
  const profile = { ...fix.profile, systemdUnit: 'fixture.service' }
  const envs = environments(profile, { PATH: process.env.PATH }, join(fix.oldRoot, 'scripts/git-askpass.js'), { installed: true })
  for (const env of [envs.read, envs.authenticated, envs.validation, envs.installation]) {
    assert.equal(env.TEST_AUDIO_SLOT, undefined); assert.equal(env.TEST_RUNTIME_SLOT, undefined); assert.equal(env.GH_TOKEN, undefined)
  }
})

test('an automatic health failure is recorded and the same digest is never attempted again', async () => {
  const fix = fixture()
  cpSync(new URL('../', import.meta.url), fix.candidateRoot, { recursive: true, force: true })
  const selected = { name: 'telegram', marketplaceName: 'codex-telegram', version: JSON.parse(readFileSync(join(fix.candidateRoot, 'package.json'))).version,
    installed: true, enabled: true, installedPath: fix.candidateRoot }
  const digest = pluginDigest(fix.candidateRoot, null, 0o700)
  automaticAttempt(fix.stateDir, { digest, status: 'pending' })
  const state = harness(fix, { fail: 'candidate', installed: [selected], marketplaces: [{ name: 'codex-telegram', root: '/fixture' }], targetPlugin: { name: 'telegram', marketplaceName: 'codex-telegram' } })
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, installed: true, automatic: true, env: updateEnv() }, state.dependencies), /candidate did not start/)
  assert.equal(automaticAttempt(fix.stateDir).status, 'failed')
  assert.equal(statSync(join(fix.stateDir, 'automatic-build.json')).mode & 0o777, 0o600)
  const discovery = join(fix.root, 'discover')
  writeFileSync(discovery, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ installed: [selected] }))})\n`, { mode: 0o700 })
  const bridge = new GeliosBridge({ stateDir: fix.stateDir, workspace: fix.root, codexBin: discovery })
  bridge.appReady = true; bridge.updateEnvironment = { PATH: process.env.PATH }
  for (let tick = 0; tick < 3; tick++) assert.equal(await bridge.reconcileInstalledBuild(), false)
  assert.equal(state.calls.filter(call => call.command === candidateLauncher(fix)).length, 1)
  assert.equal(automaticAttempt(fix.stateDir).digest, digest)
})

test('manual update clears an automatic failure even when subsequent discovery fails', async () => {
  const fix = fixture(), state = harness(fix, { fail: 'discovery' })
  automaticAttempt(fix.stateDir, { digest: 'a'.repeat(64), status: 'failed' })
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, state.dependencies), /discovery unavailable/)
  assert.equal(automaticAttempt(fix.stateDir), null)
})

test('an automatic busy race stays deferred and can retry the same digest', async () => {
  for (const phase of ['preflight', 'stop']) {
    const fix = fixture(), digest = pluginDigest(fix.candidateRoot, null, 0o700)
    automaticAttempt(fix.stateDir, { digest, status: 'pending' })
    const state = harness(fix, phase === 'preflight' ? { turnId: 'became-busy' } : {})
    const original = state.dependencies.control
    if (phase === 'stop') state.dependencies.control = async (path, request, ...args) => {
      if (request.action === 'stop_for_update') throw Object.assign(new Error('became busy before shutdown'), { code: 'UPDATE_BUSY' })
      return original(path, request, ...args)
    }
    await assert.rejects(runUpdate({ stateDir: fix.stateDir, automatic: true, env: updateEnv() }, state.dependencies), error => error.code === 'UPDATE_BUSY')
    assert.equal(automaticAttempt(fix.stateDir), null, phase + ' must remain eligible for a later idle tick')
    assert.equal(state.runtime(), 'old', 'busy work was never stopped')
    const retry = harness(fix)
    retry.dependencies.pluginRoot = dirname(dirname(realpathSync(fix.launcherLink)))
    automaticAttempt(fix.stateDir, { digest, status: 'pending' })
    await runUpdate({ stateDir: fix.stateDir, automatic: true, env: updateEnv() }, retry.dependencies)
    assert.equal(automaticAttempt(fix.stateDir), null)
    assert.equal(retry.runtime(), 'candidate')
  }
})

test('activation refuses a replaced native runtime identity before committing the update', async () => {
  const fix = fixture(), run = harness(fix, { runtimeIdentity: true, changedRuntime: true })
  await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), /changed the persistent Codex runtime/)
  assert.equal(run.runtime(), 'rollback')
})

test('first-migration recovery keeps a compatible launcher and the original native owner', { timeout: 30_000 }, async t => {
  for (const failure of [null, 'recovery-health', 'missing-control']) {
    const fix = fixture(), options = { healthFail: true, rollbackHealthFail: failure === 'recovery-health' }
    for (const path of ['src/runtime.js', 'scripts/runtime.js']) writeFileSync(join(fix.candidateRoot, path), 'export {}\n')
    const nativeStarts = join(fix.root, 'native-starts'), jobDone = join(fix.root, 'job-done')
    writeFileSync(fix.codexBin, `#!${process.execPath}
const fs=require('node:fs'),{spawn}=require('node:child_process');
fs.appendFileSync(${JSON.stringify(nativeStarts)},String(process.pid)+'\\n');
const job=spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(jobDone)},'finished'),700)`)}],{detached:true,stdio:'ignore'});job.unref();
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{pid:process.pid}})+'\\n')});
`, { mode: 0o700 })
    let app
    cleanup(t, 'the runtime client', async hook => {
      if (app?.exitCode === null) { const end = exited(hook, app); app.kill(); await end }
      if (existsSync(join(fix.stateDir, 'runtime.sock'))) await stopRuntime(fix.stateDir)
    }, { timeout: 30_000 })
    const run = harness(fix, options), original = run.dependencies.run
    run.dependencies.run = async (command, args, invocation) => {
      if (command === candidateLauncher(fix)) {
        assert.ok(existsSync(join(dirname(dirname(realpathSync(fix.launcherLink))), 'src/runtime.js')), 'compatible launcher is armed before the first native starts')
        assert.match(recoveryUpdater(fix.stateDir), /coordinator\/scripts\/update\.js$/, 'interrupted first migration has a compatible coordinator')
        app = await connectRuntime({ stateDir: fix.stateDir, workspace: fix.workspace, codexBin: fix.codexBin }, process.env)
        const end = exited(t, app); app.kill(); await end
        options.runtimeIdentity = true; options.nativeReceipt = await runtimeStatus(fix.stateDir)
        if (failure === 'missing-control') { options.socketFault = 'ENOENT'; options.socketFaultRuntime = 'candidate' }
      }
      return original(command, args, invocation)
    }
    await assert.rejects(runUpdate({ stateDir: fix.stateDir, env: updateEnv() }, run.dependencies), failure === null
      ? /compatible messaging recovered over the preserved Codex runtime/
      : failure === 'missing-control' ? /still running without a classifiable control socket/ : /replacement bridge health check failed/)
    const selectedRoot = dirname(dirname(realpathSync(fix.launcherLink)))
    assert.ok(existsSync(join(selectedRoot, 'src/runtime.js')), 'a later service restart selects compatible messaging')
    assert.equal(run.calls.filter(call => call.command?.includes('/previous-plugin/bin/')).length, 0, 'no embedded snapshot is launched')
    assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), failure !== null)
    // The job creates its file before it writes it, so the wait reads the content.
    assert.equal(await until(t, () => existsSync(jobDone) && readFileSync(jobDone, 'utf8'), 'the job to reach its own end during recovery'), 'finished', 'work reaches its own end during recovery')
    assert.equal((await runtimeStatus(fix.stateDir)).appPid, options.nativeReceipt.appPid)
    assert.equal(readFileSync(nativeStarts, 'utf8').trim().split('\n').length, 1)
  }
})

// A combined update whose candidate fails its health check over a persistent runtime the snapshot cannot attach to,
// so recovery starts compatible messaging over that runtime; `options` sets what that messaging reports.
function compatibleRecoveryHarness(t, name, options) {
  const fix = installationFixture()
  const settings = { all: true, marketplaces: [{ name: 'test-market', root: fix.marketplaceRoot }], healthFail: true, ...options }
  for (const path of ['src/runtime.js', 'scripts/runtime.js']) writeFileSync(join(fix.candidateRoot, path), 'export {}\n')
  // The harness's native update rewrites the recorded Codex command, so the runtime runs an app-server of its own.
  const appServer = join(fix.root, 'app-server')
  writeFileSync(appServer, `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{pid:process.pid}})+'\\n')});
`, { mode: 0o700 })
  let app
  cleanup(t, `the runtime client (${name})`, async hook => {
    if (app?.exitCode === null) { const end = exited(hook, app); app.kill(); await end }
    if (existsSync(join(fix.stateDir, 'runtime.sock'))) await stopRuntime(fix.stateDir)
  }, { timeout: 30_000 })
  const run = harness(fix, settings), original = run.dependencies.run
  run.dependencies.run = async (command, args, invocation) => {
    if (command === candidateLauncher(fix)) {
      app = await connectRuntime({ stateDir: fix.stateDir, workspace: fix.workspace, codexBin: appServer }, process.env)
      const end = exited(t, app); app.kill(); await end
      settings.runtimeIdentity = true; settings.nativeReceipt = await runtimeStatus(fix.stateDir)
    }
    return original(command, args, invocation)
  }
  return { fix, run }
}

test('compatible recovery of a combined update accepts the saved conversation in YOLO mode and refuses it with approvals on, a read-only sandbox or no reported policy', { timeout: 60_000 }, async t => {
  const yolo = { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, activePermissionProfile: { id: ':danger-full-access' } }
  const refused = /snapshot recovery also failed: compatible recovery did not restore the conversation and workspace in YOLO mode/
  const restoredWith = {
    yolo: [yolo, /compatible messaging recovered over the preserved Codex runtime/],
    approvals: [{ ...yolo, approvalPolicy: 'on-request' }, refused],
    sandbox: [{ ...yolo, sandboxPolicy: { type: 'readOnly' } }, refused],
    unknown: [null, refused],
  }
  for (const [name, [policy, outcome]] of Object.entries(restoredWith)) {
    // The conversation compatible messaging restores runs with `policy`.
    const { fix, run } = compatibleRecoveryHarness(t, name, { policies: { rollback: policy } })
    await assert.rejects(runUpdate(allOptions(fix), run.dependencies), outcome, name)
    assert.equal(run.runtime(), 'rollback', `${name}: compatible messaging was started`)
    assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), name !== 'yolo', `${name}: a refused recovery keeps its transaction`)
  }
})

test('compatible recovery of a combined update commits an installation with no bound conversation, which reports no policy', { timeout: 60_000 }, async t => {
  const { fix, run } = compatibleRecoveryHarness(t, 'no conversation', { threadId: null })
  await assert.rejects(runUpdate(allOptions(fix), run.dependencies), /compatible messaging recovered over the preserved Codex runtime/)
  assert.equal(run.runtime(), 'rollback', 'compatible messaging was started')
  assert.equal(existsSync(join(fix.stateDir, 'update-transaction.json')), false, 'the recovery completed')
})
