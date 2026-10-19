import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, lstatSync, linkSync, unlinkSync, writeFileSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { bootIdentity, processInfo } from './core.js'
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

function buildLock(parent) {
  trustedDirectory(parent, 'durable build store')
  const deadline = Date.now() + 5000
  while (true) {
    try { return acquireLock(join(parent, '.locks')) } catch (error) {
      if (!error.message.includes('already running') || Date.now() > deadline) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
}
export function pinBuild(root, stateDir) {
  const parent = join(stateDir, 'runtime-builds')
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const release = buildLock(parent)
  try {
    const build = copyBuild(root, stateDir)
    durableJson(join(parent, `.lease-${process.pid}-${build.contentDigest}.json`), { root: build.root, pid: process.pid, identity: processInfo(process.pid)?.identity, bootId: bootIdentity() })
    return build
  } finally { release() }
}
function copyBuild(root, stateDir) {
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

// Pinning and collection share a lock, so a live consumer cannot lose a build
// between validation and registering its process-identity lease.
export function pruneBuilds(stateDir, references) {
  const parent = join(stateDir, 'runtime-builds'), release = buildLock(parent)
  try {
    const keep = new Set(references.filter(Boolean).map(path => resolve(path)))
    const journal = join(stateDir, 'update-transaction.json')
    const visit = value => {
      if (typeof value === 'string' && isAbsolute(value)) keep.add(resolve(value))
      else if (value && typeof value === 'object') Object.values(value).forEach(visit)
    }
    if (existsSync(journal)) visit(JSON.parse(readFileSync(journal, 'utf8')))
    for (const entry of readdirSync(parent)) {
      if (!/^\.lease-\d+-[a-f0-9]{64}\.json$/.test(entry)) continue
      const path = trustedFile(join(parent, entry), 'build lease'), lease = JSON.parse(readFileSync(path))
      if (lease.bootId === bootIdentity() && lease.identity && processInfo(lease.pid)?.identity === lease.identity) keep.add(lease.root)
      else unlinkSync(path)
    }
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const path = join(parent, entry.name)
      if (/^[a-f0-9]{64}$/.test(entry.name) && entry.isDirectory() && ![...keep].some(ref => ref === path || ref.startsWith(path + sep))) {
        trustedDirectory(path, 'unreferenced build'); rmSync(path, { recursive: true }); syncPath(parent)
      }
    }
  } finally { release() }
}

const processIdentity = pid => processInfo(pid)?.identity || null
const processExists = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
export function acquireLock(path) {
  try { mkdirSync(path, { mode: 0o700 }) } catch (error) { if (error?.code !== 'EEXIST') throw error }
  const directory = lstatSync(path)
  if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700 ||
      (process.getuid && directory.uid !== process.getuid())) {
    throw new Error(`update lock directory at ${path} must be owner-only (mode 0700)`)
  }
  const identity = processIdentity(process.pid)
  if (!/^\d+$/.test(identity || '')) throw new Error('could not verify the updater process identity')
  const owner = {
    pid: process.pid, identity, bootId: bootIdentity(), createdAt: Date.now(),
    nonce: randomBytes(8).toString('hex'), released: false,
  }
  const serialized = `${JSON.stringify(owner)}\n`
  const candidate = join(path, `.candidate-${process.pid}-${owner.nonce}`)
  writeFileSync(candidate, serialized, { flag: 'wx', mode: 0o600 })
  chmodSync(candidate, 0o600); syncPath(candidate)
  try {
    while (true) {
      const generations = readdirSync(path).filter(name => /^\d{20}\.lock$/.test(name)).sort()
      const latestName = generations.at(-1)
      if (latestName) {
        const latestPath = join(path, latestName)
        let info; let current
        try { info = lstatSync(latestPath); current = JSON.parse(readFileSync(latestPath, 'utf8')) } catch {
          throw new Error(`update lock generation at ${latestPath} is invalid`)
        }
        if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid()) ||
            !Number.isSafeInteger(current.pid) || current.pid <= 1 || !/^\d+$/.test(current.identity || '') ||
            !/^[a-f0-9-]{16,64}$/.test(current.bootId || '') || typeof current.released !== 'boolean') {
          throw new Error(`update lock generation at ${latestPath} is invalid`)
        }
        if (!current.released && current.bootId === owner.bootId &&
            processIdentity(current.pid) === current.identity && processExists(current.pid)) {
          throw new Error('another Telegram plugin update is already running')
        }
      }
      const generation = latestName ? BigInt(latestName.slice(0, 20)) + 1n : 1n
      if (generation > 99_999_999_999_999_999_999n) throw new Error('update lock generations are exhausted')
      const generationPath = join(path, `${generation.toString().padStart(20, '0')}.lock`)
      try { linkSync(candidate, generationPath) } catch (error) {
        if (error?.code === 'EEXIST') continue
        throw error
      }
      syncPath(path)
      return () => {
        try {
          if (readFileSync(generationPath, 'utf8') !== serialized) return
          durableJson(generationPath, { ...owner, released: true, releasedAt: Date.now() })
        } catch {}
      }
    }
  } finally {
    try { unlinkSync(candidate) } catch {}
  }
}

export function durableJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temporary, 0o600); syncPath(temporary); renameSync(temporary, path); syncPath(dirname(path))
  } finally { try { if (existsSync(temporary)) unlinkSync(temporary) } catch {} }
}
