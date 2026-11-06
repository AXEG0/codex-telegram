#!/usr/bin/env node
// Runs node --test with the arguments it is given, unchanged, in one run over
// every file, as plain node --test does. It adds nothing a run's options,
// reporters, output or NODE_OPTIONS show: what it changes is the run's
// temporary folder and the plugin's own settings below. Every bound on a wait
// lives in test/support/wait.js, in each test file's own process, and acts
// the same under plain node --test.
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, renameSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Each test file makes its own folder inside this one (test/fixtures.js), so
// the name stays short: a Unix socket a test makes under it has a short limit.
const directory = mkdtempSync(join(tmpdir(), 'gct'))
// A test that forgets to scope MCP bootstrap must never write to the user's
// real command directory. Unclaimed launchers remain visible to the leak check.
const env = { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory,
  GELIOS_TELEGRAM_LAUNCHER_DIR: join(directory, 'unclaimed-launchers'),
  GELIOS_TELEGRAM_STATE_DIR: join(directory, 'unclaimed-state') }
// Tests never inherit a running installation's launcher, socket or build binding.
for (const name of ['GELIOS_TELEGRAM_LAUNCHER_LINK', 'GELIOS_TELEGRAM_CONTROL_SOCKET', 'GELIOS_TELEGRAM_MCP_ROOT',
  'GELIOS_TELEGRAM_INSTANCE_ID', 'GELIOS_TELEGRAM_SUPERVISED_CHILD', 'GELIOS_TELEGRAM_OWN_GROUP']) delete env[name]
// A regression test can invoke this runner from another Node test process.
delete env.NODE_TEST_CONTEXT
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.once('error', error => { console.error(error.message); process.exitCode = 1 })
child.once('close', code => {
  // Node 18 leaves its coverage folder in the temporary folder it was given;
  // it goes where plain node --test leaves it, the one the runner was given.
  for (const name of readdirSync(directory)) if (name.startsWith('node-coverage-')) renameSync(join(directory, name), join(tmpdir(), name))
  const remaining = readdirSync(directory)
  if (remaining.length) {
    console.error(`Test run left temporary entries in ${directory}:`)
    for (const name of remaining) console.error(`  ${name}`)
    process.exitCode = code || 1
  } else {
    // Removing an empty runner directory cannot conceal a leaked fixture.
    rmdirSync(directory)
    process.exitCode = code ?? 1
  }
})
