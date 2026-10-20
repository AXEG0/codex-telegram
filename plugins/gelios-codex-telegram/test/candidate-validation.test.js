import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from './fixtures.js'
import { candidateAt } from './support/candidate.js'
import { automaticAttempt, observedPluginDigest, pluginDigest } from '../src/builds.js'
import { validateCandidate, validateNextBuild } from '../scripts/update.js'
import { GeliosBridge } from '../scripts/bridge.js'

const source = fileURLToPath(new URL('../', import.meta.url))
const options = stateDir => ({ stateDir, env: { PATH: process.env.PATH, HOME: process.env.HOME } })
function fixture(changed = false) {
  const root = mkdtempSync(join(tmpdir(), 'candidate-validation-')), stateDir = join(root, 'state')
  mkdirSync(stateDir, { mode: 0o700 })
  return { root, stateDir, candidate: candidateAt(source, join(root, 'candidate'), '0.5.0', changed) }
}

test('candidate validation comes from the pinned candidate, including a new MCP entry and file set', async () => {
  const { candidate, stateDir } = fixture(true)
  assert.throws(() => validateCandidate(candidate, 'telegram', 'codex-telegram'), /ENOENT|invalid MCP/)
  const result = await validateNextBuild(candidate, 'telegram', 'codex-telegram', options(stateDir))
  assert.equal(result.version, candidate.version)
  assert.equal(result.contentDigest, pluginDigest(candidate.installedPath, null, 0o700))
  assert.equal(existsSync(join(result.root, 'scripts/mcp.js')), false)
  assert.equal(existsSync(join(result.root, 'scripts/channel.js')), true)
  assert.equal(observedPluginDigest(result.root), result.contentDigest)
})

test('generic content inspection leaves release-specific executable paths to the candidate', async () => {
  const { candidate, stateDir } = fixture()
  const updater = join(candidate.installedPath, 'scripts/update.js')
  const previous = join(candidate.installedPath, 'scripts/git-askpass.js')
  const replacement = join(candidate.installedPath, 'scripts/credentials.js')
  writeFileSync(replacement, readFileSync(previous), { mode: 0o700 })
  chmodSync(previous, 0o600)
  writeFileSync(updater, readFileSync(updater, 'utf8').replaceAll("join(root, 'scripts', 'git-askpass.js')", "join(root, 'scripts', 'credentials.js')"))
  const result = await validateNextBuild(candidate, 'telegram', 'codex-telegram', options(stateDir))
  assert.equal(result.contentDigest, observedPluginDigest(candidate.installedPath))
})

test('stable validation rejects foreign identities, private snapshots and writable files before candidate execution', async () => {
  for (const kind of ['identity', 'marketplace', 'snapshot', 'writable']) {
    const { candidate, stateDir } = fixture()
    if (kind === 'identity') {
      const path = join(candidate.installedPath, '.codex-plugin/plugin.json'), manifest = JSON.parse(readFileSync(path))
      manifest.name = 'foreign'; writeFileSync(path, JSON.stringify(manifest))
    }
    if (kind === 'marketplace') candidate.marketplaceName = 'foreign'
    if (kind === 'snapshot') candidate.installedPath = candidateAt(candidate.installedPath, join(stateDir, 'update-transactions/fixture/previous-plugin'), candidate.version).installedPath
    if (kind === 'writable') chmodSync(join(candidate.installedPath, 'scripts/update.js'), 0o666)
    let executed = false
    await assert.rejects(validateNextBuild(candidate, 'telegram', 'codex-telegram', {
      ...options(stateDir), run: async () => { executed = true; throw new Error('must not execute') },
    }), /invalid|rollback snapshot|not a trusted/)
    assert.equal(executed, false, kind)
  }
})

test('validation receipts cannot escape or mutate the pinned build, and malformed receipts fail closed', async () => {
  for (const kind of ['digest', 'root', 'version', 'launcher', 'mutation', 'json']) {
    const { candidate, stateDir, root } = fixture()
    await assert.rejects(validateNextBuild(candidate, 'telegram', 'codex-telegram', {
      ...options(stateDir), run: async (_command, args) => {
        const request = JSON.parse(args[2]), value = validateCandidate(request.result, request.pluginName, request.marketplaceName)
        if (kind === 'digest') value.contentDigest = 'f'.repeat(64)
        if (kind === 'root') value.root = root
        if (kind === 'version') value.version = 'foreign'
        if (kind === 'launcher') value.launcher = process.execPath
        if (kind === 'mutation') writeFileSync(join(value.root, 'unexpected'), 'changed')
        return { stdout: kind === 'json' ? 'broken' : JSON.stringify(value) }
      },
    }), /receipt|escapes|invalid JSON/)
  }
})

test('every validation refusal is recorded once, shown by status and cleared by a different digest', async () => {
  const { candidate, stateDir, root } = fixture()
  const codex = join(root, 'codex'), selection = join(root, 'selection.json'), invoked = join(root, 'validator-invoked')
  writeFileSync(selection, JSON.stringify(candidate))
  writeFileSync(codex, `#!${process.execPath}\nconst{readFileSync}=require('node:fs');console.log(JSON.stringify({installed:[JSON.parse(readFileSync(${JSON.stringify(selection)}))]}))\n`, { mode: 0o700 })
  writeFileSync(join(stateDir, 'launch-profile.json'), '{}', { mode: 0o600 })
  const bridge = new GeliosBridge({ stateDir, workspace: root, codexBin: codex }), logs = []
  bridge.appReady = true; bridge.updateEnvironment = options(stateDir).env; bridge.log = line => logs.push(line)
  for (const kind of ['manifest', 'syntax', 'writable', 'symlink']) {
    candidateAt(source, candidate.installedPath, candidate.version)
    if (kind === 'manifest') writeFileSync(join(candidate.installedPath, '.mcp.json'), '{}')
    if (kind === 'syntax') writeFileSync(join(candidate.installedPath, 'scripts/mcp.js'), 'invalid syntax !')
    if (kind === 'writable') chmodSync(join(candidate.installedPath, 'scripts/update.js'), 0o666)
    if (kind === 'symlink') symlinkSync(join(root, 'missing'), join(candidate.installedPath, 'unsupported'))
    const updater = join(candidate.installedPath, 'scripts/update.js')
    const marker = `import {appendFileSync as recordAttempt} from 'node:fs'; if (process.argv[2] === '--validate-candidate') recordAttempt(${JSON.stringify(invoked)}, 'attempt\\n');\n`
    writeFileSync(updater, readFileSync(updater, 'utf8').replace('\n', '\n' + marker))
    const callsBefore = existsSync(invoked) ? readFileSync(invoked, 'utf8').split('\n').length - 1 : 0
    const digest = observedPluginDigest(candidate.installedPath)
    const prior = logs.length
    for (let tick = 0; tick < 3; tick++) assert.equal(await bridge.reconcileInstalledBuild(), false)
    const failed = automaticAttempt(stateDir)
    assert.equal(failed.digest, digest); assert.equal(failed.status, 'failed'); assert.ok(failed.reason)
    assert.equal(statSync(join(stateDir, 'automatic-build.json')).mode & 0o777, 0o600)
    assert.deepEqual((await bridge.handleControl('{"action":"status"}')).automaticBuild, failed)
    assert.equal(logs.length, prior + 1, kind)
    const callsAfter = existsSync(invoked) ? readFileSync(invoked, 'utf8').split('\n').length - 1 : 0
    assert.equal(callsAfter - callsBefore, ['writable', 'symlink'].includes(kind) ? 0 : 1, kind)
    // Replacing the rejected tree changes the digest, clearing the old refusal.
    if (kind === 'writable') chmodSync(join(candidate.installedPath, 'scripts/update.js'), 0o644)
    if (kind === 'symlink') break
  }
  writeFileSync(selection, JSON.stringify({ ...candidate, installedPath: source, version: JSON.parse(readFileSync(join(source, 'package.json'))).version }))
  assert.equal(await bridge.reconcileInstalledBuild(), false)
  assert.equal(automaticAttempt(stateDir), null)
})
