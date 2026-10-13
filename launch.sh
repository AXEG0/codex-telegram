#!/bin/sh
set -eu
# Resolve the native installed selection and its versioned package cache.
# Reopen the terminal because this bootstrap can arrive through curl's stdin.
exec node --input-type=module -e '
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const plugins = JSON.parse(execFileSync("codex", ["plugin", "list", "--json"], { encoding: "utf8" })).installed;
const candidates = plugins.filter(p => p.name === "telegram" && p.marketplaceName === "codex-telegram" && p.enabled);
if (candidates.length !== 1) throw new Error("Install telegram@codex-telegram before launching");
const selected = candidates[0];
if (!/^[A-Za-z0-9._+-]+$/.test(selected.version)) throw new Error("Invalid installed version");
const cache = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "plugins/cache", selected.marketplaceName, selected.name, selected.version);
const path = existsSync(cache) ? cache : selected.marketplaceSource.sourceType === "local" ? selected.source.path : cache;
const root = realpathSync(path), manifest = JSON.parse(readFileSync(join(root, ".codex-plugin/plugin.json")));
if (manifest.name !== "telegram" || manifest.version !== selected.version) throw new Error("Installed plugin identity mismatch");
const child = spawn(process.execPath, [join(root, "bin/codex-telegram"), ...process.argv.slice(1)], { stdio: "inherit" });
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
' -- "$@" </dev/tty
