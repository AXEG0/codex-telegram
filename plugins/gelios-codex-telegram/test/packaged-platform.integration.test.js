import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mkdtempSync, spawn } from './fixtures.js'
import { controlRequest } from '../scripts/update.js'
import { processInfo } from '../src/core.js'

const enabled = process.env.GELIOS_PACKAGED_PLATFORM_TEST === '1'
const predecessor = 'b0424b01ca98bfa2955ba0f1f513537151a5b271'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, detail, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (true) {
    try { if (await check()) return } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error }
    if (Date.now() > deadline) throw new Error(`packaged platform acceptance timed out: ${detail()}`)
    await wait(50)
  }
}
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])

test('packaged native installation, terminal and combined update preserve the conversation on the host platform', {
  skip: enabled ? false : 'set GELIOS_PACKAGED_PLATFORM_TEST=1 and GELIOS_PACKAGE_TEST_REF', timeout: 600_000,
}, async t => {
  assert.ok(process.env.GELIOS_PACKAGE_TEST_REF, 'a published Git commit is required')
  const root = mkdtempSync(join(tmpdir(), 'p-')), ownerHome = join(root, 'o'), codexHome = join(root, 'c'), workspace = join(root, 'w')
  const prefix = join(ownerHome, '.local'), state = join(root, 's'), tools = join(root, 'tools')
  for (const directory of [ownerHome, codexHome, workspace, state, tools]) mkdirSync(directory, { mode: 0o700 })
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  const version = JSON.parse(readFileSync(join(repository, 'package.json'))).version
  const npm = realpathSync(execFileSync('/bin/sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim())
  const cli = join(prefix, 'bin/codex'), launcher = join(prefix, 'bin/codex-telegram'), socket = join(state, 'control.sock')
  const fail = join(root, 'fail-native-update'), operators = [], modelRequests = []
  let verified = false
  const env = { PATH: `${join(prefix, 'bin')}:${tools}:${process.env.PATH}`, HOME: ownerHome, CODEX_HOME: codexHome,
    TERM: 'xterm-256color', NODE_DISABLE_COMPILE_CACHE: '1', GELIOS_TELEGRAM_STATE_DIR: state,
    GELIOS_TELEGRAM_LAUNCHER_DIR: join(prefix, 'bin'), TMPDIR: process.env.TMPDIR || tmpdir(), TMP: process.env.TMPDIR || tmpdir(), TEMP: process.env.TMPDIR || tmpdir() }
  const run = (command, args, options = {}) => {
    const child = spawn(command, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    const result = { child, output: '', stdout: '', closed: false, code: null }
    child.stdout.on('data', data => { result.stdout += data; result.output = (result.output + data).slice(-100_000) })
    child.stderr.on('data', data => { result.output = (result.output + data).slice(-100_000) })
    result.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => { result.closed = true; result.code = code; resolve(result) }) })
    return result
  }
  const must = async (command, args, options) => { const result = await run(command, args, options).done; assert.equal(result.code, 0, result.output); return result.stdout }
  const native = async args => JSON.parse(await must(cli, [...args, '--json']))
  const status = () => controlRequest(socket, { action: 'status' })
  // Only Responses and Telegram are local fixtures. The CLI, native plugin
  // manager, npm packages, PTY and complete combined updater are real.
  const provider = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    if (request.method !== 'POST' || !body) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [], models: [] })); return
    }
    modelRequests.push(JSON.parse(body))
    const item = { id: 'msg_platform', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PACKAGE-REPLY', annotations: [] }] }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const event of [
      { type: 'response.created', response: { id: 'resp_platform', status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_platform', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  const telegram = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    const method = request.url.split('/').at(-1)
    if (method === 'getUpdates') await wait(100)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, result: method === 'getMe' ? { id: 123456789, is_bot: true, username: 'fixture_bot' } : method === 'getUpdates' ? [] : true }))
  })
  for (const server of [provider, telegram]) { server.listen(0, '127.0.0.1'); await once(server, 'listening') }
  t.after(async () => {
    if (!verified) {
      for (const operator of operators) console.error(operator.output.slice(-12_000))
      for (const path of [join(state, 'bridge.log'), join(codexHome, 'log/codex-tui.log'), join(root, 'node-stderr.log')]) if (existsSync(path)) console.error(path + '\n' + readFileSync(path, 'utf8').slice(-12000))
      for (const path of files(codexHome).filter(path => /logs.*\.sqlite$/.test(path))) {
        const query = `import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(c.execute("SELECT name,sql FROM sqlite_master WHERE type='table'").fetchall()); print(c.execute("SELECT * FROM logs WHERE target LIKE '%mcp%' OR level IN ('ERROR','WARN') ORDER BY rowid DESC LIMIT 150").fetchall())`
        try { console.error(execFileSync('python3', ['-c', query, path], { encoding: 'utf8' }).slice(-18000)) } catch {}
      }
    }
    for (const operator of operators) if (!operator.closed) operator.child.stdin.end()
    try {
      await until(() => operators.every(operator => operator.closed), () => 'owned terminal processes exit')
    } finally {
      try {
        const current = await status(), backend = processInfo(current.appPid)
        await controlRequest(socket, { action: 'shutdown_instance', instanceId: current.instanceId })
        await until(() => !processInfo(current.pid) && (!backend || processInfo(current.appPid)?.identity !== backend.identity), () => 'owned bridge and backend exit')
      } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error }
      finally { for (const server of [provider, telegram]) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)) } }
    }
    console.log(JSON.stringify({ ownedFixtureCleanupComplete: true }))
  })
  env.GELIOS_TELEGRAM_API_BASE = `http://127.0.0.1:${telegram.address().port}`
  writeFileSync(join(codexHome, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "fixture"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\ncheck_for_update_on_startup = false\nsandbox_mode = "danger-full-access"\n[model_providers.fixture]\nname = "Local platform fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`)
  writeFileSync(join(codexHome, 'auth.json'), '{}\n', { mode: 0o600 })
  writeFileSync(join(state, '.env'), `TELEGRAM_BOT_TOKEN=123456789:${'a'.repeat(32)}\n`, { mode: 0o600 })
  writeFileSync(join(state, 'access.json'), JSON.stringify({ version: 1, dmPolicy: 'allowlist', users: { '123': { chatId: '123', alias: 'Fixture owner', role: 'admin' } }, pending: {} }), { mode: 0o600 })
  writeFileSync(join(state, 'config.json'), JSON.stringify({ heartbeat: { enabled: false } }), { mode: 0o600 })
  // Pin the installer transport to a real released CLI instead of a moving latest.
  // A failure is injected only after npm has actually installed that package.
  writeFileSync(join(tools, 'npm'), `#!${process.execPath}\nconst fs=require('node:fs'),{spawn}=require('node:child_process');const args=process.argv.slice(2);const native=args.some(a=>a==='@openai/codex'||a==='@openai/codex@latest');for(let i=0;i<args.length;i++)if(args[i]==='@openai/codex'||args[i]==='@openai/codex@latest')args[i]='@openai/codex@0.162.0';const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(npm)},...args],{stdio:'inherit',env:process.env});child.on('error',e=>{console.error(e.message);process.exitCode=1});child.on('close',code=>{process.exitCode=native&&fs.existsSync(${JSON.stringify(fail)})?75:code});\n`, { mode: 0o700 })
  const audit = join(root, 'mcp-audit.cjs'), auditLog = join(root, 'node-stderr.log')
  writeFileSync(audit, `const fs=require('node:fs');const log=(event,extra={})=>fs.appendFileSync(${JSON.stringify(auditLog)},JSON.stringify({event,pid:process.pid,ppid:process.ppid,argv:process.argv,cwd:process.cwd(),...extra})+'\\n');log('start');process.on('uncaughtExceptionMonitor',e=>log('uncaught',{stack:e.stack}));process.on('exit',code=>log('exit',{code}));process.stdin.on('end',()=>log('stdin-end'));process.stdin.on('close',()=>log('stdin-close'));`)
  writeFileSync(join(tools, 'node'), '#!/bin/sh\ncase "$1" in *mcp.js) NODE_OPTIONS="--require ' + audit + '" exec ' + JSON.stringify(process.execPath) + ' "$@" 2>>' + JSON.stringify(auditLog) + ';; *) exec ' + JSON.stringify(process.execPath) + ' "$@";; esac\n', { mode: 0o700 })
  await must(process.execPath, [npm, 'install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', '@openai/codex@0.160.0'])
  assert.match(await must(cli, ['--version']), /0\.160\.0/)
  await native(['plugin', 'marketplace', 'add', 'AXEG0/codex-telegram', '--ref', predecessor])
  const installed = await native(['plugin', 'add', 'telegram@codex-telegram'])
  symlinkSync(join(installed.installedPath, 'bin/gelios-codex-telegram'), join(prefix, 'bin/gelios-codex-telegram'))
  // The new independent npm entry must replace a broken released updater
  // before dispatching; the bridge/plugin still starts from released 0.4.6.
  const packed = JSON.parse(await must(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', root, repository]))
  await must(process.execPath, [npm, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(root, packed[0].filename)])
  const open = () => {
    const operator = run('python3', [fileURLToPath(new URL('./support/operator.py', import.meta.url)), launcher, '--yolo', '--no-alt-screen'], { stdio: ['pipe', 'pipe', 'pipe'] })
    operators.push(operator); return operator
  }
  const submit = async (operator, text) => {
    await until(() => operator.output.includes('GPT-'), () => operator.output)
    const offset = operator.output.length
    operator.child.stdin.write(text)
    await until(() => operator.output.slice(offset).includes(text), () => operator.output)
    await wait(250); operator.child.stdin.write('\r')
  }
  const close = async operator => {
    await submit(operator, '/quit')
    await until(() => operator.closed, () => operator.output)
    assert.equal(operator.code, 0, operator.output)
    await until(async () => !(await status()).tuiAttached, () => 'native terminal detaches')
  }
  const first = open()
  await until(async () => { const current = await status(); return current.ready && current.tuiAttached && current.threadId }, () => first.output)
  const before = await status(), marker = 'PACKAGE-HISTORY-' + createHash('sha256').update(root).digest('hex').slice(0, 12)
  await submit(first, marker)
  await until(async () => modelRequests.length > 0 && !(await status()).turnId && first.output.includes('PACKAGE-REPLY'), () => first.output)
  await close(first)
  const rollout = files(join(codexHome, 'sessions')).find(path => path.includes(before.threadId) && path.endsWith('.jsonl'))
  assert.ok(rollout)
  const history = readFileSync(rollout, 'utf8'); assert.ok(history.includes(marker))
  const protectedPaths = ['.env', 'access.json', 'config.json'].map(name => join(state, name)).concat(join(codexHome, 'auth.json'))
  const protectedBefore = protectedPaths.map(hash), previousVersion = version
  const configPath = join(codexHome, 'config.toml'), brokenRelease = '5f25bf0792fb1bbfed03daf2b479c9b2aa122775'
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(`ref = "${predecessor}"`, `ref = "${brokenRelease}"`))
  await native(['plugin', 'marketplace', 'upgrade', 'codex-telegram'])
  assert.equal(existsSync(installed.installedPath), false)
  assert.equal(existsSync(join(prefix, 'bin/gelios-codex-telegram')), false, 'the managed launcher dangles')
  const broken = await run(process.execPath, [join(codexHome, 'plugins/cache/codex-telegram/telegram/0.4.7/bin/codex-telegram'), 'update']).done
  assert.notEqual(broken.code, 0); assert.match(broken.output, /ENOENT/)
  assert.equal((await status()).pid, before.pid, 'the actual released bridge stays running')
  // Model the configured branch moving to the candidate release. Only the
  // npm update command may refresh it and replace the broken installed updater.
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(`ref = "${brokenRelease}"`, `ref = "${process.env.GELIOS_PACKAGE_TEST_REF}"`))
  writeFileSync(fail, 'fail after actual CLI installation')
  const partial = await run(launcher, ['update']).done
  assert.notEqual(partial.code, 0, partial.output)
  assert.match(partial.output, /durable snapshot launcher and bridge were restored/)
  assert.match(await must(cli, ['--version']), /0\.160\.0/)
  assert.equal(JSON.parse(readFileSync(join(prefix, 'lib/node_modules/@axeg0/codex-telegram/package.json'))).version, previousVersion)
  assert.equal((await status()).threadId, before.threadId)
  assert.deepEqual(protectedPaths.map(hash), protectedBefore)
  rmSync(fail)
  await must(launcher, ['update'])
  const after = await status()
  assert.equal(after.threadId, before.threadId); assert.equal(after.workspace, before.workspace)
  assert.deepEqual(after.permissions, before.permissions)
  assert.match(await must(cli, ['--version']), /0\.162\.0/)
  assert.equal(JSON.parse(readFileSync(join(prefix, 'lib/node_modules/@axeg0/codex-telegram/package.json'))).version, version)
  assert.equal(JSON.parse(readFileSync(join(realpathSync(join(prefix, 'bin/gelios-codex-telegram')), '../../.codex-plugin/plugin.json'))).version, version)
  assert.deepEqual(protectedPaths.map(hash), protectedBefore)
  assert.equal(existsSync(join(state, 'update-transaction.json')), false)
  const second = open(), requestCount = modelRequests.length
  await until(async () => (await status()).tuiAttached, () => second.output)
  await until(() => second.output.includes('PACKAGE-REPLY'), () => second.output)
  await submit(second, marker + '-AFTER')
  await until(async () => modelRequests.length > requestCount && !(await status()).turnId, () => second.output)
  await close(second)
  const afterHistory = readFileSync(rollout, 'utf8')
  assert.ok(afterHistory.startsWith(history), 'the original transcript remains intact')
  assert.ok(afterHistory.includes(marker + '-AFTER'))
  console.log(JSON.stringify({ platform: process.platform, architecture: process.arch, cliBefore: '0.160.0', cliAfter: '0.162.0', pluginBefore: '0.4.6', pluginAfter: version,
    threadId: before.threadId, conversationPreserved: true, protectedFilesPreserved: true, failedUpdateRecovered: true, brokenReleasedUpdaterReplaced: true, modelEndpoint: 'local fixture' }))
  verified = true
  assert.notEqual(process.env.GELIOS_PLATFORM_TEST_FORCE_FAILURE, '1', 'forced platform acceptance failure')
})
