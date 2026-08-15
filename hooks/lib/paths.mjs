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
 * User settings: $CLAUDE_MEMORY_HOME/config.json — the same convention ponytail and
 * context-mode use. Env vars override it. Returns {} when absent or unparseable;
 * a broken config must degrade to defaults, never throw inside a hook.
 *
 *   { "vault": "/path/to/vault", "recall": true, "model": "bge-m3" }
 */
export function configFile() {
  return path.join(memoryHome(), 'config.json');
}

let _config;
export function config() {
  if (_config) return _config;
  try {
    _config = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    _config = {};
  }
  return _config;
}

/** Vault root. Mirrors resolve_vault(): env var, then config.json, then the default. */
export function vault() {
  return process.env.CLAUDE_VAULT || config().vault
    || path.join(os.homedir(), 'Documents', 'ClaudeVault');
}

/** Per-prompt recall is off unless explicitly armed. Mirrors recall_enabled(). */
export function recallEnabled() {
  return process.env.MEMORY_RECALL_ENABLED === '1' || config().recall === true;
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
