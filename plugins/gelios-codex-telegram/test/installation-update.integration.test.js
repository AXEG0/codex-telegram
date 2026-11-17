import assert from 'node:assert/strict'
import { once } from 'node:events'
import { execFileSync } from './fixtures.js'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mkdtempSync, spawn } from './fixtures.js'
import { controlRequest } from '../scripts/update.js'
import { processInfo } from '../src/core.js'
import { runtimeSocket, stopRuntime } from '../src/runtime.js'
import { appServerFolder } from './support/app-server.js'
import { cleanup, notYetThere, until } from './support/wait.js'

const enabled = process.platform === 'linux' && process.env.GELIOS_REAL_MODEL === '1' && process.env.GELIOS_REAL_CODEX_AUTH && process.env.GELIOS_PACKAGE_TEST_REF
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const releaseVersion = JSON.parse(readFileSync(join(repo, 'package.json'))).version
function files(root) { return readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(root, e.name)) : [join(root, e.name)]) }

test('the packaged combined updater upgrades real Codex and recovers partial installation and process loss on the same conversation', { skip: enabled ? false : 'enable real model/auth and a Git package ref', timeout: 600_000 }, async t => {
  // A file or socket that is not there yet means "not yet".
  const eventually = (check, what, context = t) => until(context, check, what, { retry: notYetThere })
  const root = mkdtempSync(join(tmpdir(), 'iu-')), owner = join(root, 'o'), home = join(root, 'c'), workspace = join(root, 'w'), prefix = join(owner, '.local'), state = join(root, 's'), tools = join(root, 'tools')
  for (const path of [owner, home, workspace, state, tools]) mkdirSync(path, { mode: 0o700 })
  copyFileSync(process.env.GELIOS_REAL_CODEX_AUTH, join(home, 'auth.json'))
  const npm = realpathSync(execFileSync('/bin/sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim())
  const cli = join(prefix, 'bin/codex'), launcher = join(prefix, 'bin/codex-telegram'), managed = join(prefix, 'bin/gelios-codex-telegram'), socket = join(state, 'control.sock')
  const nativeRelease = join(root, 'native-release'); writeFileSync(nativeRelease, '0.162.0')
  const fail = join(root, 'fail-cli'), block = join(root, 'block-launcher'), blocked = join(root, 'launcher-blocked'), release = join(root, 'release-launcher')
  const env = { PATH: `${join(prefix, 'bin')}:${tools}:${process.env.PATH}`, HOME: owner, CODEX_HOME: home, NODE_DISABLE_COMPILE_CACHE: '1', GELIOS_TELEGRAM_STATE_DIR: state, TMPDIR: process.env.TMPDIR || tmpdir(), TMP: process.env.TMPDIR || tmpdir(), TEMP: process.env.TMPDIR || tmpdir() }
  const run = (command, args, options = {}) => {
    const child = spawn(command, args, { env, cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    const item = { child, output: '', stdout: '', closed: false, code: null }
    child.stdout.on('data', b => { item.stdout += b; item.output = (item.output + b).slice(-200_000) }); child.stderr.on('data', b => { item.output = (item.output + b).slice(-200_000) })
    item.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { item.closed = true; item.code = code ?? 128; resolve(item) }) })
    return item
  }
  const must = async (command, args, options) => { const result = await run(command, args, options).done; assert.equal(result.code, 0, result.output); return result.output }
  const native = async args => { const result = await run(cli, [...args, '--json']).done; assert.equal(result.code, 0, result.output); return JSON.parse(result.stdout) }
  const status = () => controlRequest(socket, { action: 'status' })
  const updates = [], calls = []; let queued = null, updateId = 0
  const api = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    const params = Object.fromEntries(new URLSearchParams(body)), method = request.url.split('/').at(-1); calls.push({ method, params })
    let result = method === 'getMe' ? { id: 123456789, is_bot: true, username: 'fixture_bot' } : method === 'sendMessage' || method === 'sendRichMessage' ? { message_id: calls.length } : true
    if (method === 'getUpdates') { result = queued ? [queued] : []; queued = null; if (!result.length) await wait(100) }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, result }))
  })
  api.listen(0, '127.0.0.1'); await once(api, 'listening'); env.GELIOS_TELEGRAM_API_BASE = `http://127.0.0.1:${api.address().port}`
  const send = text => { const id = ++updateId; queued = { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: 123, type: 'private' }, from: { id: 123 }, text } } }
  // What each message the bridge sent says: plain text, or a rich message's Markdown.
  const messages = () => calls.filter(c => c.method === 'sendMessage' || c.method === 'sendRichMessage')
    .map(c => c.method === 'sendMessage' ? c.params.text : JSON.parse(c.params.rich_message).markdown)
  cleanup(t, 'owned bridge and runtime', async hook => {
    writeFileSync(release, 'release')
    for (const item of updates) if (!item.closed) { try { process.kill(-item.child.pid, 'SIGKILL') } catch {} }
    const journal = join(state, 'update-transaction.json')
    if (existsSync(journal)) { const command = JSON.parse(readFileSync(journal)).command; if (command && processInfo(command.pid)?.identity === command.identity) { try { process.kill(-command.pid, 'SIGTERM') } catch {} } }
    try {
      const current = await status()
      await eventually(async () => !(await status()).turnId, () => 'last fixture turn completes', hook)
      await controlRequest(socket, { action: 'shutdown_instance', instanceId: current.instanceId })
      await eventually(() => !processInfo(current.pid), () => 'owned bridge stops', hook)
      if (existsSync(runtimeSocket(state))) await stopRuntime(state)
    } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error }
    finally { api.closeAllConnections?.(); await new Promise(resolve => api.close(resolve)) }
  }, { timeout: 120_000 })
  // The seed's codex exec, the bridge and the updates start a real Codex (the
  // runtime and app-server), all with a folder of their own as TMPDIR. Once the
  // cleanup above has stopped the bridge and the runtime with stopRuntime, this
  // folder's teardown stops what is still running in it.
  const servers = appServerFolder(t, { what: 'the bridge, runtime and app servers' })
  // A transport fixture pins actual native package installations. No native command,
  // installer success, version response, or backend is simulated.
  writeFileSync(join(tools, 'npm'), `#!${process.execPath}\nconst fs=require('node:fs'),{spawn}=require('node:child_process');const a=process.argv.slice(2),native=a.some(x=>x==='@openai/codex'||x==='@openai/codex@latest'),launcher=a[0]==='install'&&a.some(x=>x.endsWith('.tgz'));for(let i=0;i<a.length;i++)if(a[i]==='@openai/codex'||a[i]==='@openai/codex@latest')a[i]='@openai/codex@'+fs.readFileSync(${JSON.stringify(nativeRelease)},'utf8');async function main(){if(launcher&&fs.existsSync(${JSON.stringify(block)})){fs.writeFileSync(${JSON.stringify(blocked)},'blocked');while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,25));}const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(npm)},...a],{stdio:'inherit',env:process.env});child.on('error',e=>{console.error(e.message);process.exitCode=1});child.on('close',c=>{process.exitCode=native&&fs.existsSync(${JSON.stringify(fail)})?75:c});}main();\n`, { mode: 0o700 })
  await must(process.execPath, [npm, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '@openai/codex@0.160.0'])
  assert.match(await must(cli, ['--version']), /0\.160\.0/)
  const marker = `UPGRADE-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`
  writeFileSync(join(home, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`)
  const seed = await must(cli, ['--no-daemon', 'exec', '--skip-git-repo-check', '--json', `Remember the exact marker ${marker}. Reply READY.`], { env: servers.env(env) })
  const started = seed.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return {} } }).find(v => v.type === 'thread.started')
  assert.ok(started?.thread_id, seed); const threadId = started.thread_id
  await native(['plugin', 'marketplace', 'add', 'AXEG0/codex-telegram', '--ref', 'ced2b242347176a6a8968f253fba925048d1c274'])
  const old = await native(['plugin', 'add', 'telegram@codex-telegram']), frozen = join(root, 'old-runtime'); cpSync(old.installedPath, frozen, { recursive: true })
  mkdirSync(dirname(managed), { recursive: true }); symlinkSync(join(frozen, 'bin/gelios-codex-telegram'), managed)
  writeFileSync(join(state, '.env'), `TELEGRAM_BOT_TOKEN=123456789:${'a'.repeat(32)}\n`, { mode: 0o600 })
  writeFileSync(join(state, 'access.json'), JSON.stringify({ version: 1, dmPolicy: 'allowlist', users: { '123': { chatId: '123', alias: 'Fixture owner', role: 'admin' } }, pending: {} }), { mode: 0o600 })
  writeFileSync(join(state, 'binding.json'), JSON.stringify({ version: 1, threadId, workspace, permissions: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }, initialize: { clientInfo: { name: 'installation-fixture', title: 'installation fixture', version: '0' }, capabilities: { experimentalApi: true } } }), { mode: 0o600 })
  // No released npm predecessor contained this new command. Build a genuine
  // predecessor package with prerelease metadata and the coordinator bootstrap.
  const previous = join(root, 'previous-launcher'); mkdirSync(previous)
  const archive = join(root, 'previous.tar')
  execFileSync('git', ['archive', '--format=tar', '--output', archive, process.env.GELIOS_PACKAGE_TEST_REF], { cwd: repo })
  execFileSync('tar', ['-xf', archive, '-C', previous])
  const metadata = JSON.parse(readFileSync(join(previous, 'package.json'))); metadata.version = '0.4.4-test-previous'; writeFileSync(join(previous, 'package.json'), JSON.stringify(metadata))
  const packageOutput = join(root, 'previous-package'); mkdirSync(packageOutput)
  await must(process.execPath, [npm, 'pack', '--ignore-scripts', '--pack-destination', packageOutput, previous])
  const tarballs = readdirSync(packageOutput).filter(name => name.endsWith('.tgz')); assert.equal(tarballs.length, 1)
  await must(process.execPath, [npm, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(packageOutput, tarballs[0])])
  const packagePath = join(prefix, 'lib/node_modules/@axeg0/codex-telegram/package.json')
  assert.equal(JSON.parse(readFileSync(packagePath)).version, '0.4.4-test-previous')
  await must(managed, ['bridge', '--detach', '--state-dir', state, '--workspace', workspace, '--codex-bin', cli], { env: servers.env({ ...env, GELIOS_TELEGRAM_LAUNCHER_LINK: managed }) })
  await eventually(async () => { const v = await status(); return v.ready && v.threadId === threadId }, () => 'old conversation restored')
  const before = await status(), protectedPaths = [join(state, '.env'), join(state, 'access.json'), join(home, 'auth.json')], protectedBefore = protectedPaths.map(hash)
  await native(['plugin', 'marketplace', 'remove', 'codex-telegram'])
  await native(['plugin', 'marketplace', 'add', 'AXEG0/codex-telegram', '--ref', process.env.GELIOS_PACKAGE_TEST_REF])
  await native(['plugin', 'add', 'telegram@codex-telegram'])
  send('Run a shell command that sleeps for 3 seconds and then runs codex --version. Send the stored marker and that version to this Telegram chat.')
  await eventually(async () => Boolean((await status()).turnId), () => 'old agent starts its own version check')
  const refused = run(launcher, ['update'], { env: servers.env(env) }); updates.push(refused); await refused.done
  assert.notEqual(refused.code, 0, refused.output)
  assert.match(refused.output, /First migration requires an explicit stop of the embedded Codex runtime/)
  assert.equal((await status()).pid, before.pid, 'migration admission keeps the predecessor and its work')
  await eventually(() => messages().some(text => text.includes(marker) && text.includes('0.160.0')), () => 'the predecessor sends its own marker and version')
  await eventually(async () => !(await status()).turnId, () => 'the predecessor finishes its work')
  await controlRequest(socket, { action: 'shutdown_instance', instanceId: before.instanceId })
  await eventually(() => !processInfo(before.pid), () => 'the fixture explicitly stops its embedded predecessor')
  const cold = run(launcher, ['update'], { env: servers.env(env) }); updates.push(cold); await cold.done
  assert.equal(cold.code, 0, cold.output)
  assert.equal((await status()).threadId, threadId)
  assert.match(await must(cli, ['--version']), /0\.162\.0/)
  assert.equal(JSON.parse(readFileSync(packagePath)).version, releaseVersion)
  // A distinct installed release makes this restoration assertion fail red if
  // package recovery never ran after the successful cold migration.
  writeFileSync(nativeRelease, '0.162.1'); writeFileSync(fail, 'fail after native installation')
  send('Run a shell command that sleeps for 3 seconds, then send the stored marker to this Telegram chat.')
  await eventually(async () => Boolean((await status()).turnId), () => 'the supported runtime starts its turn')
  const partial = run(launcher, ['update'], { env: servers.env(env) }); updates.push(partial); await partial.done
  assert.notEqual(partial.code, 0, partial.output); assert.match(partial.output, /Waiting for the current Codex turn/)
  assert.match(partial.output, /pinned recovery launcher and bridge were restored/)
  assert.match(await must(cli, ['--version']), /0\.162\.0/)
  assert.equal(JSON.parse(readFileSync(packagePath)).version, releaseVersion)
  assert.equal((await status()).threadId, threadId); assert.deepEqual(protectedPaths.map(hash), protectedBefore)
  rmSync(fail); writeFileSync(nativeRelease, '0.163.0')
  const complete = run(launcher, ['update'], { env: servers.env(env) }); updates.push(complete); await complete.done; assert.equal(complete.code, 0, complete.output)
  const after = await status(); assert.notEqual(after.pid, before.pid); assert.equal(after.threadId, threadId); assert.equal(after.workspace, workspace)
  assert.match(await must(cli, ['--version']), /0\.163\.0/); assert.equal(JSON.parse(readFileSync(packagePath)).version, releaseVersion)
  assert.deepEqual(protectedPaths.map(hash), protectedBefore)
  send('Run codex --version, then send the marker you remember and the CLI version to this Telegram chat.')
  await eventually(() => messages().some(text => text.includes(marker) && text.includes('0.163.0')), () => 'upgraded agent replies with retained marker and its own version')
  await eventually(async () => !(await status()).turnId, () => 'upgraded model turn completes')
  writeFileSync(block, 'block launcher installation')
  const interrupted = run(launcher, ['update'], { env: servers.env(env) }); updates.push(interrupted)
  await eventually(() => existsSync(blocked), () => interrupted.output)
  const transaction = JSON.parse(readFileSync(join(state, 'update-transaction.json'))), lockDirectory = join(state, 'update-locks')
  const lock = JSON.parse(readFileSync(join(lockDirectory, readdirSync(lockDirectory).filter(n => n.endsWith('.lock')).sort().at(-1))))
  assert.equal(processInfo(lock.pid)?.identity, lock.identity)
  process.kill(lock.pid, 'SIGKILL'); writeFileSync(release, 'release')
  await eventually(() => processInfo(transaction.command.pid)?.identity !== transaction.command.identity, () => 'independent installer finishes after updater loss')
  await interrupted.done; assert.notEqual(interrupted.code, 0)
  rmSync(cli); rmSync(block)
  const recovery = run(launcher, ['update'], { env: servers.env(env) }); updates.push(recovery); await recovery.done; assert.equal(recovery.code, 0, recovery.output)
  assert.equal((await status()).threadId, threadId); assert.deepEqual(protectedPaths.map(hash), protectedBefore)
  assert.match(await must(cli, ['--version']), /0\.163\.0/); assert.equal(existsSync(join(state, 'update-transaction.json')), false)
  const sent = messages().length
  send('Run codex --version again and send the retained marker and CLI version to this Telegram chat.')
  await eventually(() => messages().slice(sent).some(text => text.includes(marker) && text.includes('0.163.0')), () => 'agent replies from the same conversation after interrupted recovery')
  await eventually(async () => !(await status()).turnId, () => 'recovery model turn completes')
  const rollout = files(join(home, 'sessions')).find(path => path.includes(threadId) && path.endsWith('.jsonl')); assert.ok(rollout)
  const records = readFileSync(rollout, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  const toolOutputs = records.filter(v => v.type === 'response_item' && /tool_call_output|function_call_output/.test(v.payload?.type || ''))
  if (process.env.GELIOS_INSTALLATION_EVIDENCE) writeFileSync(process.env.GELIOS_INSTALLATION_EVIDENCE, JSON.stringify({ marker, threadId, before, after, recovered: await status(), previousLauncherFixture: '0.4.4-test-previous', cliBefore: '0.160.0', cliAfter: '0.163.0', launcherAfter: JSON.parse(readFileSync(packagePath)).version, transcript: records.filter(v => v.type !== 'response_item' || !['reasoning'].includes(v.payload?.type)), calls, outputs: updates.map(u => u.output), protectedFilesPreserved: protectedPaths.every((p, i) => hash(p) === protectedBefore[i]) }, null, 2), { mode: 0o600 })
  assert.ok(toolOutputs.some(v => JSON.stringify(v).includes('codex-cli 0.163.0')), 'the agent executed the updated CLI through its own tools')
})
