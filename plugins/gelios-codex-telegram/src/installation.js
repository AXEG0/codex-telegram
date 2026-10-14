import { accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const names = { codex: '@openai/codex', launcher: '@axeg0/codex-telegram' }
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const inside = (root, path) => path === root || path.startsWith(root + sep)
function packageRoot(entry, component) {
  const path = realpathSync(entry)
  for (let root = dirname(path); dirname(root) !== root; root = dirname(root)) {
    if (component === 'codex' && existsSync(join(root, 'codex-package.json'))) {
      const m = json(join(root, 'codex-package.json'))
      if (m.layoutVersion === 1 && resolve(root, m.entrypoint) === path) return root
    }
    if (existsSync(join(root, 'package.json')) && json(join(root, 'package.json')).name === names[component]) return root
  }
  throw new Error(`Cannot identify the installed ${component} package`)
}
export function packageDigest(root, visit) {
  const hash = createHash('sha256')
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name, path = join(dir, entry.name), stat = lstatSync(path)
      if (!entry.isSymbolicLink() && stat.mode & 0o022) throw new Error(`Package entry is writable by other users: ${name}`)
      if (entry.isDirectory()) { walk(path, name); visit?.(path, name, stat); continue }
      hash.update(`${name}\0${stat.mode & 0o777}\0`)
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(path)
        if (!inside(root, resolve(dirname(path), target))) throw new Error(`Package link leaves its package: ${name}`)
        hash.update(target)
      } else if (entry.isFile()) hash.update(readFileSync(path))
      else throw new Error(`Unsupported package entry: ${name}`)
      visit?.(path, name, stat)
    }
  }
  walk(root); return hash.digest('hex')
}
function copyPackage(root, destination) {
  packageDigest(root)
  cpSync(root, destination, { recursive: true, dereference: false, verbatimSymlinks: true })
  // Absolute internal links must continue to refer to the copied package.
  packageDigest(root, (path, name, stat) => {
    if (stat.isSymbolicLink() && isAbsolute(readlinkSync(path))) {
      const copied = join(destination, name), target = join(destination, relative(root, readlinkSync(path)))
      rmSync(copied); symlinkSync(relative(dirname(copied), target), copied)
    }
  })
}
function npmPrefix(root, name) {
  const suffix = `${sep}lib${sep}node_modules${sep}${name.replace('/', sep)}`
  if (!root.endsWith(suffix)) throw new Error(`The ${name} launcher must be installed with npm --global`)
  return root.slice(0, -suffix.length)
}
export function captureInstallation(profile, installerRoot, transactionRoot, env) {
  const launcher = realpathSync(join(installerRoot, 'launcher.js')), prefix = npmPrefix(dirname(launcher), names.launcher)
  const entries = { codex: profile.codexBin, launcher: join(prefix, 'bin', 'codex-telegram') }, result = {}
  for (const [component, entry] of Object.entries(entries)) {
    const root = packageRoot(entry, component), backup = join(transactionRoot, `previous-${component}`)
    if (component === 'launcher' && root !== dirname(launcher)) throw new Error('The installed launcher changed before update')
    accessSync(dirname(entry), constants.W_OK); accessSync(dirname(root), constants.W_OK)
    copyPackage(root, backup)
    result[component] = { entry, root, relativeEntry: relative(root, realpathSync(entry)), backup, digest: packageDigest(backup) }
  }
  result.prefix = prefix
  result.protected = [join(profile.stateDir, '.env'), join(profile.stateDir, 'access.json'), join(profile.stateDir, 'config.json'), ...(env?.CODEX_HOME ? [join(env.CODEX_HOME, 'auth.json')] : [])]
    .filter(existsSync).map(path => ({ path, users: basename(path) === 'access.json', digest: fingerprint(path, basename(path) === 'access.json') }))
  return result
}
function fingerprint(path, users) { return createHash('sha256').update(users ? JSON.stringify(json(path).users || {}) : readFileSync(path)).digest('hex') }
export function verifyInstallationState(data) {
  if (data.protected.some(p => !existsSync(p.path) || fingerprint(p.path, p.users) !== p.digest)) throw new Error('Credentials, pairing or channel settings changed during installation update')
}
export function validateInstallation(data, profile, transactionRoot) {
  if (!data || data.codex?.entry !== profile.codexBin) throw new Error('Installation snapshot does not match the recorded Codex command')
  for (const component of ['codex', 'launcher']) {
    const p = data[component]
    if (!isAbsolute(p?.root || '') || dirname(p.root) === p.root || !isAbsolute(p.entry || '') ||
        p.backup !== join(transactionRoot, `previous-${component}`) || !p.relativeEntry ||
        !inside(p.backup, resolve(p.backup, p.relativeEntry)) || packageRoot(join(p.backup, p.relativeEntry), component) !== p.backup ||
        !/^[a-f0-9]{64}$/.test(p.digest || '') || packageDigest(p.backup) !== p.digest) throw new Error('Invalid installation recovery snapshot')
  }
  if (npmPrefix(data.launcher.root, names.launcher) !== data.prefix || data.launcher.entry !== join(data.prefix, 'bin', 'codex-telegram')) throw new Error('Invalid launcher installation prefix')
}
export function restoreInstallation(data) {
  for (const component of ['codex', 'launcher']) {
    const p = data[component], suffix = createHash('sha256').update(p.backup).digest('hex').slice(0, 16), temporary = `${p.root}.restore-${suffix}`, displaced = `${temporary}.displaced`
    mkdirSync(dirname(p.root), { recursive: true })
    try {
      rmSync(temporary, { recursive: true, force: true }); copyPackage(p.backup, temporary)
      if (existsSync(p.root)) { rmSync(displaced, { recursive: true, force: true }); renameSync(p.root, displaced) }
      renameSync(temporary, p.root)
      if (p.entry !== join(p.root, p.relativeEntry)) {
        const link = `${p.entry}.restore-${suffix}`
        try { rmSync(link, { force: true }); symlinkSync(join(p.root, p.relativeEntry), link); renameSync(link, p.entry) } finally { rmSync(link, { force: true }) }
      }
      rmSync(displaced, { recursive: true, force: true })
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  }
}
export function nativeUpdateEnvironment(data, env) {
  return data.codex.root.endsWith(`${sep}lib${sep}node_modules${sep}@openai${sep}codex`) && existsSync(join(data.codex.root, 'package.json')) && json(join(data.codex.root, 'package.json')).name === names.codex
    ? { ...env, npm_config_prefix: npmPrefix(data.codex.root, names.codex) } : env
}
export async function installLauncher(data, marketplaceRoot, version, directory, run, invocation) {
  let root = realpathSync(marketplaceRoot)
  while (dirname(root) !== root && (!existsSync(join(root, 'package.json')) || json(join(root, 'package.json')).name !== names.launcher)) root = dirname(root)
  const manifest = json(join(root, 'package.json'))
  if (manifest.name !== names.launcher || manifest.version !== version || manifest.bin?.['codex-telegram'] !== 'launcher.js' || Object.keys(manifest.dependencies || {}).length) throw new Error('Marketplace launcher does not match the plugin version or package contract')
  const packed = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory, root], invocation)).stdout)
  const filename = packed[0]?.filename
  if (packed.length !== 1 || typeof filename !== 'string' || basename(filename) !== filename || !filename.endsWith('.tgz')) throw new Error('npm returned an invalid launcher package')
  await run('npm', ['install', '--global', '--prefix', data.prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(directory, filename)], invocation)
  const installed = json(join(packageRoot(data.launcher.entry, 'launcher'), 'package.json'))
  if (installed.version !== version) throw new Error('The installed launcher version does not match the plugin')
  return installed.version
}
