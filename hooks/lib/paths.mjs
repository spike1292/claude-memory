// Node-side mirror of vault-env.sh. Everything resolves relative to this file, so the
// plugin works from its version-pinned cache dir, from a dev checkout, and via symlink.
//
// vault-env.sh stays the single source of truth for project_key (non-trivial sed over
// git remote URLs); this module shells out to it once and caches the answer. resolve_vault
// and memory_home are two lines each, so they are reimplemented here rather than paying a
// subprocess for them.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const libDir = path.dirname(fileURLToPath(import.meta.url));
export const hooksDir = path.dirname(libDir);
export const pluginRoot = path.dirname(hooksDir);
export const scriptsDir = path.join(pluginRoot, 'scripts');
export const vaultEnvSh = path.join(libDir, 'vault-env.sh');

/**
 * Vault root. Mirrors resolve_vault(): env var, then the machine-local config file,
 * then the default. The file is load-bearing — `env` in settings.local.json does not
 * reach hook subprocesses, so nothing may depend on the variable being present.
 */
export function vault() {
  if (process.env.CLAUDE_VAULT) return process.env.CLAUDE_VAULT;
  try {
    const v = fs.readFileSync(path.join(memoryHome(), 'vault'), 'utf8').split('\n')[0].trim();
    if (v) return v;
  } catch { /* not configured yet — fall through to the default */ }
  return path.join(os.homedir(), 'Documents', 'ClaudeVault');
}

/**
 * Mutable state root — never inside the plugin, which is wiped on update.
 * Mirrors memory_home(). Subdirs: db/ models/ logs/ run/ eval/
 */
export function memoryHome() {
  return process.env.CLAUDE_MEMORY_HOME || path.join(os.homedir(), '.claude-memory');
}

/** memoryHome()/<name>, created if absent. */
export function stateDir(name) {
  const d = path.join(memoryHome(), name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const keyCache = new Map();

/** Stable per-project identifier. Delegates to vault-env.sh so there is one implementation. */
export function projectKey(dir = process.cwd()) {
  if (keyCache.has(dir)) return keyCache.get(dir);
  const out = execFileSync('bash', ['-c', `. "$0"; project_key "$1"`, vaultEnvSh, dir], {
    encoding: 'utf8',
  }).trim();
  keyCache.set(dir, out);
  return out;
}

/** Pre-2026-08-08 naming, still what Claude Code names ~/.claude/projects/<slug>/ after. */
export function legacyKey(dir = process.cwd()) {
  return dir.replace(/\//g, '-');
}

/**
 * Point transformers.js at $CLAUDE_MEMORY_HOME/models instead of its default cache inside
 * node_modules/@huggingface/transformers/.cache. Without this the ~722 MB of ONNX weights sit
 * in the plugin's version-pinned dir and are re-downloaded on every `/plugin update`.
 *
 * It must be done by mutating the library's own `env`, NOT via HF_HOME/TRANSFORMERS_CACHE:
 * transformers.js v4 ignores both (verified 2026-08-15 — env.cacheDir still resolved to the
 * package dir with them set). Call this with the imported module, before the first pipeline().
 */
export function useModelCache(transformers) {
  const d = stateDir('models');
  transformers.env.cacheDir = d;
  return d;
}
