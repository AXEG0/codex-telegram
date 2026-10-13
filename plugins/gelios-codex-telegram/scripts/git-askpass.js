#!/usr/bin/env node
const prompt = String(process.argv[2] || '')
const expectedHost = String(process.env.GELIOS_GIT_AUTH_HOST || '').toLowerCase()
let host = ''
try { host = new URL(prompt.match(/https:\/\/[^'"\s]+/i)?.[0] || '').hostname.toLowerCase() } catch {}
if (!expectedHost || host !== expectedHost) process.exitCode = 1
else if (prompt.startsWith('Username for ')) process.stdout.write('x-access-token\n')
else if (prompt.startsWith('Password for ') && process.env.GH_TOKEN) process.stdout.write(`${process.env.GH_TOKEN}\n`)
else process.exitCode = 1
