#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

process.chdir(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim())
const manifest = 'plugins/gelios-codex-telegram/.codex-plugin/plugin.json'
const records = [manifest, 'plugins/gelios-codex-telegram/package.json', 'package.json']
const versions = records.map(path => JSON.parse(readFileSync(path, 'utf8')).version)
if (!versions[0] || versions.some(version => version !== versions[0])) throw new Error('Plugin and launcher release versions differ')
const base = process.argv[2]
if (base && !/^0+$/.test(base)) {
  if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error('Invalid release baseline commit')
  const paths = ['plugins/gelios-codex-telegram', 'package.json', 'launcher.js', 'LICENSE', 'AUTHORS.md', 'README.md']
  const changed = execFileSync('git', ['diff', '--name-only', base, 'HEAD', '--', ...paths], { encoding: 'utf8' }).trim()
  const previous = JSON.parse(execFileSync('git', ['show', `${base}:${manifest}`], { encoding: 'utf8' })).version
  if (changed && previous === versions[0]) throw new Error(`Packaged contents changed under unchanged release version ${versions[0]}`)
}
console.log(JSON.stringify({ version: versions[0], releaseMetadataValid: true }))
