import { cpSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function candidateAt(source, destination, version, changedEntry = false) {
  cpSync(source, destination, { recursive: true })
  for (const name of ['package.json', '.codex-plugin/plugin.json']) {
    const path = join(destination, name), value = JSON.parse(readFileSync(path)); value.version = version
    writeFileSync(path, JSON.stringify(value))
  }
  if (changedEntry) {
    // This following release owns both a new server entry and its validation.
    // The running release has no knowledge of the new path or bootstrap text.
    renameSync(join(destination, 'scripts/mcp.js'), join(destination, 'scripts/channel.js'))
    for (const name of ['src/bootstrap.js', 'scripts/update.js', '.mcp.json']) {
      const path = join(destination, name)
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('scripts/mcp.js', 'scripts/channel.js'))
    }
    const path = join(destination, 'scripts/update.js')
    writeFileSync(path, readFileSync(path, 'utf8').replace("join(root, 'scripts', 'mcp.js')", "join(root, 'scripts', 'channel.js')"))
  }
  return { name: 'telegram', marketplaceName: 'codex-telegram', version, installedPath: destination, enabled: true, installed: true }
}
