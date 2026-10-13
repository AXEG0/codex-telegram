#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'gct-tests-'))
const env = { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory }
// A regression test can invoke this runner from another Node test process.
delete env.NODE_TEST_CONTEXT
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.once('error', error => { console.error(error.message); process.exitCode = 1 })
child.once('close', code => {
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
