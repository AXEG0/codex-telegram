import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { mkdtempSync, spawn, stopGroup } from './fixtures.js'
import { cleanup, exited } from './support/wait.js'
import { StateStore } from '../src/core.js'
import { captureInstallation, packageContents, packageDigest, restoreInstallation, validateInstallation } from '../src/installation.js'
import { runtimeOwnership, savedConversation, sweepTransactions, waitForPreservation } from '../scripts/update.js'

const owner = { pid: 123, identity: '1234', instanceId: 'a'.repeat(32) }
const conversation = { threadId: 'saved', workspace: '/workspace' }
const yolo = { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }
const status = patch => ({ ...owner, ...conversation, appRunning: true, ready: true, restoration: null, permissions: yolo, ...patch })
const identityOf = pid => pid === owner.pid ? owner.identity : null

test('the saved expectation uses only a binding the bridge can restore, with its workspace fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'preservation-binding-')), profile = { stateDir: root, workspace: '/default' }
  const store = new StateStore(root)
  assert.deepEqual(savedConversation(profile), { threadId: null, workspace: '/default' })
  store.saveBinding({ threadId: 'saved', initialize: null, workspace: '/other' })
  assert.deepEqual(savedConversation(profile), { threadId: null, workspace: '/default' })
  store.saveBinding({ initialize: {}, workspace: '' })
  assert.deepEqual(savedConversation(profile), { threadId: 'saved', workspace: '/default' })
  writeFileSync(store.bindingPath, '{broken')
  const warnings = []
  assert.deepEqual(savedConversation(profile, s => warnings.push(s)), { threadId: null, workspace: '/default' })
  assert.equal(warnings.length, 1)
})

test('restoration keeps answering beyond a fixed clock and tolerates separate consecutive control failures', async () => {
  let clock = 0, reads = 0, checked = 0
  const control = async () => {
    reads++
    if (reads % 4 === 0 && clock < 300_000) throw new Error('transient control error')
    return status({ ready: clock >= 300_000, threadId: clock >= 300_000 ? 'saved' : null })
  }
  let result
  await assert.doesNotReject(async () => { result = await waitForPreservation(control, 'socket', owner, conversation, {
    identityOf: pid => { checked++; return identityOf(pid) }, now: () => clock, sleep: async () => { clock += 5_000 },
  }) })
  assert.equal(result.threadId, 'saved')
  assert.ok(clock >= 300_000 && checked >= reads * 2)
})

test('consecutive unavailable reads stop at their own bound, without treating recovery as settled', async () => {
  let clock = 0
  await assert.rejects(waitForPreservation(async () => { throw new Error('unavailable') }, 'socket', owner, conversation,
    { identityOf, timeoutMs: 15_000, now: () => clock, sleep: async () => { clock += 5_000 } }),
  error => /remains unavailable/.test(error.message) && !error.preservationFailed)
  assert.equal(clock, 15_000)
})

test('restoration ends immediately on a reported error or a non-restoring answer', async () => {
  for (const [patch, pattern] of [
    [{ restoration: { error: 'missing conversation', permanent: true } }, /permanent.*missing conversation/],
    [{ restoration: { error: 'MCP temporarily unavailable', permanent: false } }, /temporary.*MCP/],
    [{ ready: true, threadId: 'other' }, /different conversation/],
    [{ ready: true, workspace: '/other' }, /different conversation/],
    [{ ready: true, permissions: null }, /outside YOLO/],
    [{ ready: false, restoration: undefined }, /status is missing/],
  ]) {
    const value = status(patch)
    if (patch.restoration === undefined && Object.hasOwn(patch, 'restoration')) delete value.restoration
    let reads = 0
    await assert.rejects(waitForPreservation(async () => { reads++; return value }, 'socket', owner, conversation,
      { identityOf, policy: true, sleep: async () => assert.fail('must not retry a verdict') }), pattern)
    assert.equal(reads, 1)
  }
})

test('the barrier refuses a dead or replaced owner and a missing native process', async () => {
  for (const patch of [{ pid: 456 }, { identity: 'different' }, { instanceId: 'b'.repeat(32) }, { appRunning: false }]) {
    await assert.rejects(waitForPreservation(async () => status(patch), 'socket', owner, conversation,
      { identityOf, sleep: async () => assert.fail('must end') }), error => !error.preservationFailed)
  }
  await assert.rejects(waitForPreservation(async () => assert.fail('dead owner must not be contacted'), 'socket', owner, conversation,
    { identityOf: () => null }), /lost the expected bridge/)
})

test('unbound and found-live checks preserve their separate contracts and old-code policy compatibility', async () => {
  const unbound = status({ threadId: null, ready: false, permissions: null })
  assert.equal(await waitForPreservation(async () => unbound, 'socket', owner, { ...conversation, threadId: null }, { identityOf }), unbound)
  const terminal = status({ threadId: 'terminal-selected', permissions: null })
  assert.equal(await waitForPreservation(async () => terminal, 'socket', owner, conversation, { identityOf, live: true }), terminal)
  assert.equal((await waitForPreservation(async () => status({ permissions: null }), 'socket', owner, conversation, { identityOf })).threadId, 'saved')
})

function installation(layout = 'npm', prepare = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'installation-recovery-')), transactionRoot = join(root, 'transaction')
  const stateDir = join(root, 'state'), prefix = join(root, 'prefix'), installerRoot = join(prefix, 'lib/node_modules/@axeg0/codex-telegram')
  const codexRoot = layout === 'npm' ? join(prefix, 'lib/node_modules/@openai/codex') : join(root, 'releases/old')
  for (const directory of [stateDir, transactionRoot, installerRoot, join(codexRoot, 'bin'), join(prefix, 'bin')]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(installerRoot, 'package.json'), JSON.stringify({ name: '@axeg0/codex-telegram', version: '1.0.0' }))
  writeFileSync(join(installerRoot, 'launcher.js'), 'original launcher', { mode: 0o700 })
  symlinkSync(join(installerRoot, 'launcher.js'), join(prefix, 'bin/codex-telegram'))
  writeFileSync(join(codexRoot, 'bin/codex'), 'original executable', { mode: 0o700 })
  writeFileSync(join(codexRoot, layout === 'npm' ? 'package.json' : 'codex-package.json'), JSON.stringify(layout === 'npm'
    ? { name: '@openai/codex', version: '1.0.0' } : { layoutVersion: 1, entrypoint: 'bin/codex', version: '1.0.0' }))
  symlinkSync(join(codexRoot, 'bin/codex'), join(codexRoot, 'absolute-link'))
  symlinkSync('bin/codex', join(codexRoot, 'relative-link'))
  const entry = join(prefix, 'bin/codex'); symlinkSync(join(codexRoot, 'bin/codex'), entry)
  const profile = { stateDir, codexBin: entry }
  prepare(codexRoot)
  const record = captureInstallation(profile, installerRoot, transactionRoot, {})
  const suffix = createHash('sha256').update(record.codex.backup || '').digest('hex').slice(0, 16)
  return { root, profile, record, codexRoot, installerRoot, transactionRoot,
    temporary: `${codexRoot}.restore-${suffix}`, displaced: `${codexRoot}.restore-${suffix}.displaced` }
}

test('unchanged npm packages compare captured internal links and retain both executable and launcher inodes', () => {
  const f = installation(), native = statSync(join(f.codexRoot, 'bin/codex')).ino, launcher = statSync(join(f.installerRoot, 'launcher.js')).ino
  validateInstallation(f.record, f.profile, f.transactionRoot)
  assert.equal(packageContents(f.codexRoot), packageContents(f.record.codex.backup))
  restoreInstallation(f.record)
  assert.equal(statSync(join(f.codexRoot, 'bin/codex')).ino, native)
  assert.equal(statSync(join(f.installerRoot, 'launcher.js')).ino, launcher)
  symlinkSync('/outside/package', join(f.codexRoot, 'outside'))
  assert.throws(() => restoreInstallation(f.record), /link leaves its package/)
})

test('changed, missing and partly removed npm packages restore from the validated backup', () => {
  for (const change of [f => writeFileSync(join(f.codexRoot, 'bin/codex'), 'changed'), f => rmSync(f.codexRoot, { recursive: true }), f => rmSync(join(f.codexRoot, 'package.json'))]) {
    const f = installation(); change(f); restoreInstallation(f.record)
    assert.equal(readFileSync(f.profile.codexBin, 'utf8'), 'original executable')
    assert.equal(existsSync(f.temporary), false); assert.equal(existsSync(f.displaced), false)
  }
})

test('an interrupted restore returns the displaced original only to its identified old runtime, and is repeatable', () => {
  for (const ownership of ['previous', 'gone', 'unknown']) {
    const f = installation(), inode = statSync(join(f.codexRoot, 'bin/codex')).ino
    renameSync(f.codexRoot, f.displaced); cpSync(f.record.codex.backup, f.codexRoot, { recursive: true, verbatimSymlinks: true })
    const replacement = statSync(join(f.codexRoot, 'bin/codex')).ino
    assert.notEqual(inode, replacement)
    if (ownership === 'unknown') {
      assert.throws(() => restoreInstallation(f.record), /Cannot classify/)
      assert.ok(existsSync(f.displaced) && existsSync(f.codexRoot)); continue
    }
    restoreInstallation(f.record, { runtimeOwnership: ownership })
    assert.equal(statSync(join(f.codexRoot, 'bin/codex')).ino, ownership === 'previous' ? inode : replacement)
    restoreInstallation(f.record, { runtimeOwnership: ownership })
    assert.equal(existsSync(f.temporary), false); assert.equal(existsSync(f.displaced), false)
  }
  const f = installation(), inode = statSync(join(f.codexRoot, 'bin/codex')).ino
  renameSync(f.codexRoot, f.displaced)
  restoreInstallation(f.record, { runtimeOwnership: 'previous' })
  assert.equal(statSync(join(f.codexRoot, 'bin/codex')).ino, inode)
})

test('standalone capture has no native backup and recovery leaves native selection and the old executable intact', () => {
  const f = installation('standalone'), inode = statSync(join(f.codexRoot, 'bin/codex')).ino
  assert.equal(f.record.codex.backup, undefined)
  assert.equal(existsSync(join(f.transactionRoot, 'previous-codex')), false)
  const next = join(f.root, 'releases/new'); mkdirSync(next); writeFileSync(join(next, 'codex'), 'new release')
  rmSync(f.profile.codexBin); symlinkSync(join(next, 'codex'), f.profile.codexBin)
  const current = join(f.root, 'current'); symlinkSync(next, current)
  validateInstallation(f.record, f.profile, f.transactionRoot)
  restoreInstallation(f.record)
  assert.equal(realpathSync(f.profile.codexBin), join(realpathSync(current), 'codex'))
  assert.equal(statSync(join(f.codexRoot, 'bin/codex')).ino, inode)
})

test('a failed removal after returning the original leaves its whole root usable for the next recovery', { skip: process.getuid?.() === 0 }, t => {
  const f = installation('npm', root => {
    mkdirSync(join(root, 'locked')); writeFileSync(join(root, 'locked/file'), 'retained'); chmodSync(join(root, 'locked'), 0o555)
  })
  const inode = statSync(join(f.codexRoot, 'bin/codex')).ino
  renameSync(f.codexRoot, f.displaced); cpSync(f.record.codex.backup, f.codexRoot, { recursive: true, verbatimSymlinks: true })
  chmodSync(join(f.codexRoot, 'locked'), 0o555)
  t.after(() => {
    for (const root of [f.codexRoot, f.displaced, f.temporary, f.record.codex.backup]) if (existsSync(join(root, 'locked'))) chmodSync(join(root, 'locked'), 0o755)
  })
  assert.equal(packageContents(f.displaced, f.codexRoot), packageContents(f.record.codex.backup), 'the displaced original is equivalent')
  assert.equal(packageContents(f.codexRoot), packageContents(f.record.codex.backup), 'the restored root is equivalent')
  assert.throws(() => restoreInstallation(f.record, { runtimeOwnership: 'previous' }), /EACCES|EPERM|ENOTEMPTY/)
  let executable
  assert.doesNotThrow(() => { executable = statSync(join(f.codexRoot, 'bin/codex')) })
  assert.equal(executable.ino, inode)
  assert.equal(readFileSync(join(f.codexRoot, 'locked/file'), 'utf8'), 'retained')
  chmodSync(join(f.temporary, 'locked'), 0o755)
  restoreInstallation(f.record, { runtimeOwnership: 'previous' })
  assert.equal(existsSync(f.temporary), false)
  for (const root of [f.codexRoot, f.record.codex.backup]) chmodSync(join(root, 'locked'), 0o755)
})

test('new recovery reads an old standalone backup without rewriting an already inconsistent native selection', () => {
  const f = installation('standalone'), native = f.record.codex
  native.backup = join(f.transactionRoot, 'previous-codex')
  cpSync(native.root, native.backup, { recursive: true, verbatimSymlinks: true })
  rmSync(join(native.backup, 'absolute-link')); symlinkSync('bin/codex', join(native.backup, 'absolute-link'))
  native.digest = packageDigest(native.backup); delete native.layout; delete native.version
  validateInstallation(f.record, f.profile, f.transactionRoot)
  const next = join(f.root, 'releases/new'); mkdirSync(join(next, 'bin'), { recursive: true }); writeFileSync(join(next, 'bin/codex'), 'new native')
  symlinkSync(next, join(f.root, 'current'))
  const inode = statSync(join(f.codexRoot, 'bin/codex')).ino
  assert.match(restoreInstallation(f.record).join('\n'), /Legacy standalone selection mismatch/)
  assert.equal(statSync(join(f.codexRoot, 'bin/codex')).ino, inode)
  assert.equal(realpathSync(join(f.root, 'current')), next)
})

test('recovery preserves the executable file of a real retained native process', { skip: process.platform !== 'linux' }, async t => {
  for (const layout of ['standalone', 'npm']) {
    const f = installation(layout, root => cpSync('/bin/sleep', join(root, 'bin/codex')))
    const app = spawn(join(f.codexRoot, 'bin/codex'), ['60'], { stdio: 'ignore', detached: true })
    const end = exited(t, app)
    cleanup(t, `the retained ${layout} executable`, async () => { if (app.exitCode === null) { await stopGroup(app.pid); await end } }, { timeout: 10_000 })
    const inode = statSync(join(f.codexRoot, 'bin/codex')).ino
    if (layout === 'npm') {
      renameSync(f.codexRoot, f.displaced); cpSync(f.record.codex.backup, f.codexRoot, { recursive: true, verbatimSymlinks: true })
    } else {
      const next = join(f.root, 'releases/new'); mkdirSync(next); cpSync('/bin/sleep', join(next, 'codex'))
      rmSync(f.profile.codexBin); symlinkSync(join(next, 'codex'), f.profile.codexBin)
    }
    restoreInstallation(f.record, { runtimeOwnership: 'previous' })
    assert.equal(statSync(join(f.codexRoot, 'bin/codex')).ino, inode)
    assert.equal(readlinkSync(`/proc/${app.pid}/exe`), join(f.codexRoot, 'bin/codex'))
    assert.equal(app.exitCode, null)
  }
})

test('runtime ownership requires both a classified socket and the old Codex child gone on the same boot', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'restore-owner-')), transaction = { bootId: 'boot', previousRuntime: { instanceId: 'old', appPid: 111 } }
  const deps = { bootOf: () => 'boot', exists: () => true, runtimeStatus: async () => ({ instanceId: 'new', appPid: 222 }) }
  assert.equal(await runtimeOwnership(stateDir, transaction, deps), 'unknown')
  assert.equal(await runtimeOwnership(stateDir, transaction, { ...deps, exists: () => false }), 'gone')
  assert.equal(await runtimeOwnership(stateDir, transaction, { ...deps, bootOf: () => 'new-boot' }), 'gone', 'PID reuse after a reboot does not retain the old owner')
  assert.equal(await runtimeOwnership(stateDir, transaction, { ...deps, runtimeStatus: async () => ({ instanceId: 'old', appPid: 111 }) }), 'previous')
  for (const code of ['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT']) {
    const runtimeStatus = async () => { throw Object.assign(new Error(code), { code }) }
    assert.equal(await runtimeOwnership(stateDir, transaction, { ...deps, runtimeStatus }), 'unknown')
    assert.equal(await runtimeOwnership(stateDir, transaction, { ...deps, runtimeStatus, exists: () => false }), code === 'ETIMEDOUT' ? 'unknown' : 'gone')
  }
  writeFileSync(join(stateDir, 'runtime.sock'), 'regular file', { mode: 0o600 })
  assert.equal(await runtimeOwnership(stateDir, transaction, { ...deps, exists: () => false, runtimeStatus: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) } }), 'unknown')
})

test('transaction sweep preserves all active references, including the recovered command supervisor', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'transaction-sweep-')), parent = join(stateDir, 'update-transactions')
  mkdirSync(parent, { mode: 0o700 })
  const roots = Array.from('abcdef', letter => join(parent, letter.repeat(32)))
  for (const root of roots) { mkdirSync(root, { mode: 0o700 }); writeFileSync(join(root, 'file'), 'held') }
  const launcherLink = join(stateDir, 'launcher'); symlinkSync(join(roots[0], 'file'), launcherLink)
  writeFileSync(join(stateDir, 'update-transaction.json'), JSON.stringify({ id: 'b'.repeat(32) }))
  const messages = [], profile = { launcherLink }, status = { pluginRoot: roots[2] }
  sweepTransactions(stateDir, profile, status, [roots[3]], s => messages.push(s))
  for (const root of roots.slice(0, 4)) assert.ok(existsSync(root))
  for (const root of roots.slice(4)) assert.equal(existsSync(root), false)
  rmSync(join(stateDir, 'update-transaction.json'))
  sweepTransactions(stateDir, profile, status, [], s => messages.push(s))
  assert.equal(existsSync(roots[1]), false); assert.equal(existsSync(roots[3]), false)
  assert.deepEqual(messages, [])
})


test('an old standalone backup keeps both the command and native current on the new selected release', () => {
  const f = installation('standalone'), native = f.record.codex
  native.backup = join(f.transactionRoot, 'previous-codex')
  cpSync(native.root, native.backup, { recursive: true, verbatimSymlinks: true })
  rmSync(join(native.backup, 'absolute-link')); symlinkSync('bin/codex', join(native.backup, 'absolute-link'))
  native.digest = packageDigest(native.backup); delete native.layout; delete native.version
  validateInstallation(f.record, f.profile, f.transactionRoot)
  const next = join(f.root, 'releases/new'), executable = join(next, 'bin/codex')
  mkdirSync(dirname(executable), { recursive: true }); writeFileSync(executable, 'new native')
  symlinkSync(next, join(f.root, 'current'))
  rmSync(f.profile.codexBin); symlinkSync(executable, f.profile.codexBin)
  const oldInode = statSync(join(f.codexRoot, 'bin/codex')).ino, newInode = statSync(executable).ino
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.deepEqual(restoreInstallation(f.record), [])
    assert.equal(realpathSync(f.profile.codexBin), join(realpathSync(join(f.root, 'current')), 'bin/codex'))
    assert.equal(realpathSync(f.profile.codexBin), executable)
    assert.equal(statSync(executable).ino, newInode)
    assert.equal(statSync(join(f.codexRoot, 'bin/codex')).ino, oldInode)
  }
})
