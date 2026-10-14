import { execFileSync, spawn } from 'node:child_process'
import { constants } from 'node:os'

// Read routing metadata from the installed binary, including hidden commands and
// aliases. Codex still parses the original arguments; this only chooses transport.
export function nativeMetadata(codex = 'codex', run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 })) {
  const completion = run(codex, ['completion', 'bash'])
  const section = /^        codex\)\n([\s\S]*?)(?=^        codex__)/m.exec(completion)?.[1]
  const words = /opts="([^"]+)"/.exec(section || '')?.[1]?.split(/\s+/)
  if (!words?.includes('resume') || !words.includes('fork')) throw new Error('Cannot read command routing metadata from the installed Codex binary')
  return {
    commands: new Set(words.filter(word => /^[a-z][a-z0-9-]*$/.test(word))),
    options: new Set(words.filter(word => word.startsWith('-')).concat('--yolo')),
    values: new Set([...section.matchAll(/^                (-{1,2}[^)\s]+)\)/gm)].map(match => match[1])),
  }
}

export function nativeInvocation(args, metadata) {
  const separator = args.indexOf('--')
  if (args.slice(0, separator < 0 ? args.length : separator).some(arg => ['--help', '-h', '--version', '-V'].includes(arg))) return { interactive: false }
  let command = null, index = args.length, promptIndex = -1
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { promptIndex = i + 1 < args.length ? i + 1 : -1; index = i; break }
    if (['--help', '-h', '--version', '-V'].includes(arg)) return { interactive: false }
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0]
      if (!metadata.options.has(name)) return { interactive: false }
      if (metadata.values.has(name) && !arg.includes('=')) i++
    } else if (arg.startsWith('-') && arg !== '-') {
      for (let j = 1; j < arg.length; j++) {
        const name = `-${arg[j]}`
        if (!metadata.options.has(name)) return { interactive: false }
        if (['-h', '-V'].includes(name)) return { interactive: false }
        if (metadata.values.has(name)) { if (j === arg.length - 1) i++; break }
      }
    } else {
      index = i
      if (metadata.commands.has(arg)) command = arg
      else promptIndex = i
      break
    }
  }
  const interactive = command === null || ['resume', 'fork', 'agents'].includes(command)
  if (interactive && args.slice(index).some((arg, i, rest) => ['--help', '-h', '--version', '-V'].includes(arg) && !rest.slice(0, i).includes('--'))) return { interactive: false }
  return { interactive, command, index, promptIndex }
}

export function runNative(bin, args, launch = spawn) {
  const child = launch(bin, args, { stdio: 'inherit' })
  const handlers = new Map(['SIGTERM', 'SIGHUP'].map(signal => [signal, () => child.kill(signal)]))
  // The native child shares the terminal's foreground process group and receives
  // Ctrl-C itself. Keep the wrapper alive until Codex decides whether to exit.
  handlers.set('SIGINT', () => {})
  for (const [signal, handler] of handlers) process.on(signal, handler)
  return new Promise((resolve, reject) => {
    const clean = () => { for (const [signal, handler] of handlers) process.off(signal, handler) }
    child.once('error', error => { clean(); reject(error) })
    child.once('exit', (code, signal) => { clean(); resolve(code ?? (signal ? 128 + (constants.signals[signal] || 0) : 1)) })
  })
}
