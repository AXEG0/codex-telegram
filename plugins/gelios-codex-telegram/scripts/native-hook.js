#!/usr/bin/env node
import { ensureNativeBridge } from '../src/native-bootstrap.js'
import { defaultStateDir } from '../src/core.js'
import { setupSocket } from '../src/local-setup.js'
import { requestControl } from '../src/control.js'
let raw = ''
for await (const part of process.stdin) { raw += part; if (raw.length > 1024 * 1024) throw new Error('native hook input is too large') }
try {
  const input = JSON.parse(raw)
  if (process.env.GELIOS_CODEX_CHILD === '1') process.exit(0)
  if (!['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'].includes(input.hook_event_name)) throw new Error('unknown native lifecycle hook')
  if (!/^[a-f0-9-]{36}$/.test(input.session_id || '') || typeof input.cwd !== 'string') throw new Error('invalid native session context')
  const ending = ['Stop', 'SessionEnd'].includes(input.hook_event_name)
  const controlSocket = ending ? setupSocket(defaultStateDir()) : (await ensureNativeBridge({ cwd: input.cwd })).controlSocket
  await requestControl(controlSocket, 'native_hook', { ...input, transcript_path: undefined, model: undefined, last_assistant_message: undefined })
} catch (error) {
  if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) process.exit(0)
  process.stderr.write(`Telegram native startup: ${error.message}\n`)
  process.exitCode = 2
}
