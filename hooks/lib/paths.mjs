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

/**
 * Locate the git config that decides this dir's project key, for cache validation only.
 *
 * Returns the config path (cacheable, validated by its mtime), `undefined` when there is no repo
 * at all (cacheable — the key is then a pure function of the path), or `null` when `.git` is a
 * FILE, i.e. a worktree or submodule, whose config lives somewhere this walk cannot cheaply
 * confirm (not cacheable — always ask the shell).
 *
 * This is NOT a second implementation of project_key: it never derives a key, only answers
 * "has anything that could change the key been touched?". Getting it wrong costs a cache miss,
 * never a wrong answer, because vault-env.sh remains the only thing that computes the key.
 */
function gitConfigFor(dir) {
  let d = path.resolve(dir);
  for (;;) {
    const g = path.join(d, '.git');
    try {
      return fs.statSync(g).isDirectory() ? path.join(g, 'config') : null;
    } catch { /* not here — walk up */ }
    const parent = path.dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}

const KEY_CACHE_FILE = () => path.join(memoryHome(), 'cache', 'project-keys.json');

function readKeyCache() {
  try { return JSON.parse(fs.readFileSync(KEY_CACHE_FILE(), 'utf8')); } catch { return {}; }
}

function writeKeyCache(all) {
  // Atomic: several hooks can fire at once, and a half-written cache must not become a parse
  // error every session afterwards. A failed write is fine — it just costs the next lookup.
  try {
    const f = KEY_CACHE_FILE();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, f);
  } catch { /* best effort */ }
}

/**
 * Stable per-project identifier. Delegates to vault-env.sh so there is one implementation.
 *
 * That delegation costs a bash+git subprocess — measured 72ms on 2026-08-17, which was the single
 * largest cost in the per-prompt recall hook and in the per-write validate-note hook, and three
 * times what switching the whole runtime to Bun would have saved. Short-lived hooks cannot reuse
 * the in-process Map, so the answer is cached on disk and validated against a stamp taken from the
 * git config that determines it: `git remote set-url` rewrites that file, so a changed remote is a
 * miss on the next call rather than a stale key forever.
 *
 * `hooks/lib/vault-env.sh` reads this same cache, which is why the stamp is a string both `stat`
 * and `fs.statSync` can produce identically. See the stamp construction below.
 */
export function projectKey(dir = process.cwd()) {
  if (keyCache.has(dir)) return keyCache.get(dir);

  const cfg = gitConfigFor(dir);
  let stamp = null;                       // null => do not cache (worktree/submodule)
  if (cfg === undefined) {
    stamp = '0';                          // no repo: key is a pure function of the path
  } else if (typeof cfg === 'string') {
    // "<whole seconds>:<size>:<inode>", because vault-env.sh reads this same file and must compute
    // the identical value: `stat` yields whole seconds on both BSD and GNU, and a float millisecond
    // stamp would mismatch every time, silently making the shell side a permanent cache miss.
    //
    // Seconds alone are not enough, and the hole they leave is permanent rather than momentary: a
    // `git remote set-url` in the same second as the cached stamp is never noticed, because nothing
    // touches .git/config again afterwards. Size covers most of that; **inode covers the rest**,
    // since git rewrites config atomically (temp file + rename) and so hands out a new inode on
    // every write — verified 2026-08-17 for a same-second, byte-identical-length URL change, where
    // mtime and size were both unchanged and the inode still moved.
    try {
      const st = fs.statSync(cfg);
      stamp = `${Math.floor(st.mtimeMs / 1000)}:${st.size}:${st.ino}`;
    } catch { stamp = null; }
  }

  const all = stamp === null ? null : readKeyCache();
  const hit = all?.[dir];
  if (hit && hit.stamp === stamp && typeof hit.key === 'string') {
    keyCache.set(dir, hit.key);
    return hit.key;
  }

  const out = execFileSync('bash', ['-c', `. "$0"; project_key "$1"`, vaultEnvSh, dir], {
    encoding: 'utf8',
  }).trim();
  keyCache.set(dir, out);
  if (all) writeKeyCache({ ...all, [dir]: { key: out, stamp } });
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
