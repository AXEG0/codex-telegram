import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function syncPath(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function pluginFiles(root) {
  const found = []
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(directory, entry.name), name)
      else if (entry.isFile()) found.push(name)
      else throw new Error('plugin snapshot contains an unsupported file type')
    }
  }
  walk(root)
  return found.sort()
}

function pluginDigest(root, expectedFiles = null, modeMask = 0o777) {
  const found = pluginFiles(root)
  if (expectedFiles && JSON.stringify(found.sort()) !== JSON.stringify([...expectedFiles].sort())) throw new Error('plugin snapshot has an unexpected file set')
  const hash = createHash('sha256')
  for (const name of found.sort()) {
    const path = trustedFile(join(root, name), `plugin file ${name}`, { root, executable: name === 'bin/gelios-codex-telegram' || name === 'scripts/git-askpass.js' })
    const info = statSync(path); hash.update(`${name}\0${info.mode & modeMask}\0`); hash.update(readFileSync(path))
  }
  return hash.digest('hex')
}

function trustedOwner(info, allowRoot = false) {
  const uid = process.getuid?.()
  return uid === undefined || info.uid === uid || (allowRoot && info.uid === 0)
}

function validateAncestors(path, label) {
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const info = statSync(parent)
    const stickyRoot = info.uid === 0 && Boolean(info.mode & 0o1000)
    if (!info.isDirectory() || (!stickyRoot && (info.mode & 0o022)) || !trustedOwner(info, true)) {
      throw new Error(`${label} has an untrusted parent directory`)
    }
    if (parent === dirname(parent)) break
  }
}

function trustedDirectory(path, label, { allowRoot = false } = {}) {
  const canonical = realpathSync(path)
  const info = statSync(canonical)
  if (!info.isDirectory() || (info.mode & 0o022) || !trustedOwner(info, allowRoot)) {
    throw new Error(`${label} is not in a trusted directory`)
  }
  validateAncestors(canonical, label)
  return canonical
}

function trustedFile(path, label, { root = null, executable = false, allowRoot = false } = {}) {
  const canonical = realpathSync(path)
  const escaped = root && (relative(root, canonical).startsWith(`..${sep}`) || isAbsolute(relative(root, canonical)))
  if (escaped) throw new Error(`${label} escapes the plugin directory`)
  const info = statSync(canonical)
  if (!info.isFile() || (info.mode & 0o022) || !trustedOwner(info, allowRoot) || (executable && !(info.mode & 0o111))) {
    throw new Error(`${label} is not a trusted${executable ? ' executable' : ' file'}`)
  }
  validateAncestors(canonical, label)
  return canonical
}

// Complete, content-addressed artifacts live outside Codex's replaceable cache.
export function copyPluginTree(root, destination) {
  const files = pluginFiles(root), directories = new Set(['.'])
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const name of files) {
    const source = trustedFile(join(root, name), `plugin file ${name}`, { root })
    const path = join(destination, name)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    copyFileSync(source, path); chmodSync(path, statSync(source).mode & 0o700); syncPath(path)
    for (let directory = dirname(name); directory !== '.'; directory = dirname(directory)) directories.add(directory)
  }
  for (const directory of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
    const path = resolve(destination, directory); chmodSync(path, 0o700); syncPath(path)
  }
  return files
}

export function pinBuild(root, stateDir) {
  root = trustedDirectory(root, 'plugin build')
  const contentDigest = pluginDigest(root, null, 0o700)
  const parent = join(stateDir, 'runtime-builds'), destination = join(parent, contentDigest)
  mkdirSync(parent, { recursive: true, mode: 0o700 }); trustedDirectory(parent, 'durable build store')
  if (!existsSync(destination)) {
    const temporary = join(parent, `.build-${process.pid}-${randomBytes(8).toString('hex')}`)
    try {
      copyPluginTree(root, temporary)
      if (pluginDigest(temporary, null, 0o700) !== contentDigest) throw new Error('plugin build changed while being copied')
      try { renameSync(temporary, destination); syncPath(parent) }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error }
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  }
  trustedDirectory(destination, 'durable plugin build')
  if (pluginDigest(destination, null, 0o700) !== contentDigest) throw new Error('durable plugin build changed')
  return { root: destination, contentDigest, launcher: join(destination, 'bin', 'gelios-codex-telegram') }
}

export { pluginFiles, pluginDigest, trustedDirectory, trustedFile, syncPath }
