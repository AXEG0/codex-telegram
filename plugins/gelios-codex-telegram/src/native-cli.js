import { execFileSync, spawn } from 'node:child_process'
import { constants } from 'node:os'
import { lstatSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export function recoveryUpdater(stateDir) {
  const path = join(stateDir, 'update-transaction.json')
  if (!existsSync(path)) return null
  const info = lstatSync(path), directory = lstatSync(stateDir)
  if (!info.isFile() || info.mode & 0o077 || directory.isSymbolicLink() || directory.mode & 0o077 ||
      (process.getuid && (info.uid !== process.getuid() || directory.uid !== process.getuid()))) throw new Error('Update recovery state must be owner-only')
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  if (!saved.installation) return null
  if (saved.version !== 1 || !/^[a-f0-9]{32}$/.test(saved.id || '')) throw new Error('Invalid update recovery identity')
  const root = join(stateDir, 'update-transactions', saved.id, 'coordinator'), files = [], hash = createHash('sha256')
  const walk = (dir, prefix = '') => {
    if (lstatSync(dir).isSymbolicLink()) throw new Error('Update recovery contains a directory link')
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), name)
      else if (entry.isFile()) files.push(name)
      else throw new Error('Update recovery contains an unsupported file')
    }
  }
  walk(root)
  for (const name of files.sort()) {
    const file = join(root, name), stat = lstatSync(file)
    if (stat.mode & 0o022 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Update recovery ownership changed')
    hash.update(`${name}\0${stat.mode & 0o777}\0`); hash.update(readFileSync(file))
  }
  if (hash.digest('hex') !== saved.snapshot?.coordinatorDigest) throw new Error('Update recovery code changed')
  return join(root, 'scripts', 'update.js')
}

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

export function nativeYoloIndices(args, metadata) {
  const result = []
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    if (word === '--') break
    if (['--yolo', '--dangerously-bypass-approvals-and-sandbox'].includes(word)) { result.push(i); continue }
    const name = word.startsWith('--') ? word.split('=')[0] : word.slice(0, 2)
    if (metadata.values.has(name) && !word.includes('=') && (word.startsWith('--') || word.length === 2)) i++
  }
  return result
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
