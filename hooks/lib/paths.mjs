// THE resolver. Vault path, $CLAUDE_MEMORY_HOME, recall arming, project_key and legacy_key are
// resolved here and nowhere else. Everything resolves relative to this file, so the plugin works
// from its version-pinned cache dir, from a dev checkout, and via symlink.
//
// Single implementation since 2026-08-18 (previously mirrored in vault-env.sh, which forked bash
// for project_key) — docs/decisions/2026-08-18-single-resolver.md.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const libDir = path.dirname(fileURLToPath(import.meta.url));
export const hooksDir = path.dirname(libDir);
export const pluginRoot = path.dirname(hooksDir);
export const scriptsDir = path.join(pluginRoot, 'scripts');

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

/**
 * @typedef {object} MemoryConfig
 * @property {string} [vault]
 * @property {boolean} [recall]
 * @property {string} [model]
 * @property {number} [modelIdleMs]
 * @property {number} [serveIdleMs]
 * @property {number} [logRetentionDays]
 * @property {boolean} [gitAutoCommit]
 */

/** @type {MemoryConfig|undefined} */
let _config;

/** @returns {MemoryConfig} */
export function config() {
  if (_config) return _config;
  try {
    _config = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    _config = {};
  }
  return /** @type {MemoryConfig} */ (_config);
}

/** Vault root. Mirrors resolve_vault(): env var, then config.json, then the default. */
export function vault() {
  return (
    process.env.CLAUDE_VAULT ||
    config().vault ||
    path.join(os.homedir(), 'Documents', 'ClaudeVault')
  );
}

/**
 * Vault root for a WRITE path: env var or config.json only, never the built-in default.
 *
 * A write that falls through to the default scaffolds an empty vault and can move one project's
 * notes into another's — the 2026-08-15 incident CLAUDE.md's "Machine-specific configuration"
 * section records. A read that falls back gives a bad answer; a write that falls back writes to
 * the wrong place, so only writers call this. Names every place it looked, since the error is the
 * only thing standing in for the write.
 *
 * @returns {string}
 */
export function requireVault() {
  if (process.env.CLAUDE_VAULT) return process.env.CLAUDE_VAULT;
  if (config().vault) return /** @type {string} */ (config().vault);
  throw new Error(
    `no vault configured for a write — checked $CLAUDE_VAULT and "vault" in ${configFile()}`,
  );
}

/**
 * Which source decided the vault — for /memory:doctor, so "wrong vault" is diagnosable.
 * Must stay in step with vault(): same order, same branches.
 */
export function vaultSource() {
  if (process.env.CLAUDE_VAULT) return 'CLAUDE_VAULT env';
  if (config().vault) return configFile();
  return 'built-in default';
}

/** Per-prompt recall is off unless explicitly armed. */
export function recallEnabled() {
  return process.env.MEMORY_RECALL_ENABLED === '1' || config().recall === true;
}

/** Auto-commit is off unless explicitly armed — a hook writing git history unattended must
 *  never be the default. */
export function gitAutoCommitEnabled() {
  return process.env.MEMORY_GIT_AUTO_COMMIT === '1' || config().gitAutoCommit === true;
}

// env -> config.json -> default, the order every setting resolves in. Anything unparseable or
// non-positive falls through to the default rather than disabling a timer: a typo'd env var must
// not leave a 1.3GB model resident forever.
/**
 * @param {string} envName
 * @param {keyof MemoryConfig} configKey
 * @param {number} fallback
 * @returns {number}
 */
const positiveMs = (envName, configKey, fallback) => {
  const n = Number(process.env[envName] ?? config()[configKey]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * How long a resident --serve sits idle before dropping the MODEL (but staying alive).
 * See CLAUDE.md's "modelIdleMs (5 min) unloads the model" note for the two-timer rationale.
 */
export function modelIdleMs() {
  return positiveMs('MEMORY_MODEL_IDLE_MS', 'modelIdleMs', 5 * 60 * 1000);
}

/**
 * How long a resident --serve sits idle before exiting entirely.
 * Reads config.json, not just the env var — hooks set this, and a value written to
 * settings.json's `env` block does not reach the session that wrote it.
 */
export function serveIdleMs() {
  return positiveMs('MEMORY_SERVE_IDLE_MS', 'serveIdleMs', 30 * 60 * 1000);
}

/**
 * How many days of dated JSONL logs (`recall-<date>`, `hooks-<date>`) are kept under `logs/`.
 * 0 is legitimate (keep today only), so this cannot use `positiveMs`'s `> 0` guard. A non-digit
 * value falls back to 30; a digits-only value is CLAMPED to a century rather than falling back,
 * since an oversized value means "keep everything" and an Invalid Date would otherwise throw
 * inside `pruneDatedLogs()` (found in review, 2026-08-21).
 */
const MAX_RETENTION_DAYS = 36500;
export function logRetentionDays() {
  // An EXPORTED-BUT-EMPTY env var is unset, not a value — `??` alone keeps '' and shadows
  // config.json (found by this function's own test).
  const env = process.env.MEMORY_LOG_RETENTION_DAYS;
  const raw = env === undefined || env.trim() === '' ? config().logRetentionDays : env;
  // Digits only, not Number() — a stray space would otherwise cast to 0 and delete every log but
  // today's, silently (2026-08-21, the same defect the vault pruner records).
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) return 30;
  return Math.min(Number(s), MAX_RETENTION_DAYS);
}

/**
 * Mutable state root — never inside the plugin, which is wiped on update.
 * Mirrors memory_home(). Subdirs: db/ models/ logs/ run/ eval/
 */
export function memoryHome() {
  return process.env.CLAUDE_MEMORY_HOME || path.join(os.homedir(), '.claude-memory');
}

/**
 * memoryHome()/<name>, created if absent.
 *
 * @param {string} name
 * @returns {string}
 */
export function stateDir(name) {
  const d = path.join(memoryHome(), name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** @type {Map<string, string>} */
const keyCache = new Map();

/**
 * Locate the git config that decides this dir's project key, for cache validation only.
 *
 * Returns the config path (cacheable, validated by its mtime), `undefined` when there is no repo
 * at all (cacheable — the key is then a pure function of the path), or `null` when `.git` is a
 * FILE, i.e. a worktree or submodule, whose config lives somewhere this walk cannot cheaply
 * confirm (not cacheable — always recompute).
 *
 * This is NOT a second implementation of project_key: it never derives a key, only answers
 * "has anything that could change the key been touched?". Getting it wrong costs a cache miss,
 * never a wrong answer, because computeProjectKey() below is the only thing that derives one.
 *
 * @param {string} dir
 * @returns {string|null|undefined}
 */
function gitConfigFor(dir) {
  let d = path.resolve(dir);
  for (;;) {
    const g = path.join(d, '.git');
    try {
      return fs.statSync(g).isDirectory() ? path.join(g, 'config') : null;
    } catch {
      /* not here — walk up */
    }
    const parent = path.dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}

const KEY_CACHE_FILE = () => path.join(memoryHome(), 'cache', 'project-keys.json');

/** @typedef {{ key: string, stamp: string|null }} KeyCacheEntry */

/** @returns {Record<string, KeyCacheEntry>} */
function readKeyCache() {
  try {
    return JSON.parse(fs.readFileSync(KEY_CACHE_FILE(), 'utf8'));
  } catch {
    return {};
  }
}

/** @param {Record<string, KeyCacheEntry>} all */
function writeKeyCache(all) {
  // Atomic: several hooks can fire at once, and a half-written cache must not become a parse
  // error every session afterwards. A failed write is fine — it just costs the next lookup.
  try {
    const f = KEY_CACHE_FILE();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, f);
  } catch {
    /* best effort */
  }
}

// Normalise a git remote URL into a project key. Each step below is the `sed -e` expression it
// replaced in vault-env.sh, in the same order sed applied them.
// ASCII lowercase on purpose, not toLowerCase() — toLowerCase() is unicode-aware and would key a
// non-ASCII capital differently, silently splitting one project's vault folder in two.
/** @param {string} t */
const asciiLower = (t) => t.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/**
 * @param {string} url
 * @returns {string}
 */
export function normaliseRemote(url) {
  return asciiLower(
    String(url)
      .replace(/^[a-z+][a-z+]*:\/\//, '') // s#^[a-z+][a-z+]*://##   scheme
      .replace(/^[^@/]*@/, '') // s#^[^@/]*@##            credentials, never keyed on
      .replace(':', '/') // s#:#/#                  FIRST colon only: scp syntax
      .replace(/\.git$/, '') // s#\.git$##
      .replace(/\/*$/, ''), // s#/*$##                 trailing slashes
  ).replace(/\//g, '-'); // s#/#-#g
}

/**
 * @param {string} dir
 * @param {string[]} args
 * @returns {string}
 */
const gitOut = (dir, args) => {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
};

/**
 * The project key for a directory, computed for real.
 *
 * Identifies the PROJECT, not the checkout path, so one repo maps to one vault folder on every
 * machine. Falls back to the repo directory name, then to the legacy cwd-slug for non-git dirs.
 *
 * @param {string} dir
 * @returns {string}
 */
export function computeProjectKey(dir) {
  const url = gitOut(dir, ['remote', 'get-url', 'origin']);
  if (url) {
    const key = normaliseRemote(url);
    if (key) return key;
  }
  const top = gitOut(dir, ['rev-parse', '--show-toplevel']);
  // asciiLower ONLY, not normaliseRemote() — the full pipeline on this branch silently re-keys a
  // no-origin repo (`foo.git/` -> `foo`); see docs/architecture.md's "Known hacks" H1.
  if (top) return asciiLower(path.basename(top));
  return legacyKey(dir);
}

/**
 * Stable per-project identifier, cached on disk.
 * The cache is why this is not just `computeProjectKey`: short-lived hooks can't reuse the
 * in-process Map, and forking git per hook was the largest cost in the per-prompt recall hook —
 * 72 ms measured 2026-08-17, most of it a bash fork wrapping a git fork (the bash half is gone
 * since 2026-08-18; the git half is what this still saves). Validated against a stamp on the git
 * config that decides the key, so `git remote set-url` is a miss next call, not a stale key forever.
 *
 * @param {string} [dir]
 * @returns {string}
 */
export function projectKey(dir = process.cwd()) {
  if (keyCache.has(dir)) return /** @type {string} */ (keyCache.get(dir));

  const cfg = gitConfigFor(dir);
  /** @type {string|null} */
  let stamp = null; // null => do not cache (worktree/submodule)
  if (cfg === undefined) {
    stamp = '0'; // no repo: key is a pure function of the path
  } else if (typeof cfg === 'string') {
    // "<whole seconds>:<size>:<inode>" — all three load-bearing; see CLAUDE.md's
    // "project-key cache ... is now Node's alone" note, and the derivation in
    // docs/decisions/2026-08-17-shell-vs-node-hooks.md.
    try {
      const st = fs.statSync(cfg);
      stamp = `${Math.floor(st.mtimeMs / 1000)}:${st.size}:${st.ino}`;
    } catch {
      stamp = null;
    }
  }

  const all = stamp === null ? null : readKeyCache();
  const hit = all?.[dir];
  if (hit && hit.stamp === stamp && typeof hit.key === 'string') {
    keyCache.set(dir, hit.key);
    return hit.key;
  }

  const out = computeProjectKey(dir);
  keyCache.set(dir, out);
  if (all) writeKeyCache({ ...all, [dir]: { key: out, stamp } });
  return out;
}

/**
 * Pre-2026-08-08 naming, still what Claude Code names ~/.claude/projects/<slug>/ after.
 * Every character outside `[A-Za-z0-9_-]`, not just `/` — a `/`-only replace left a dotted-path
 * checkout's `memory` symlink pointing at a slug Claude Code never wrote transcripts into
 * (CHANGELOG.md, fixed alongside #125).
 *
 * @param {string} [dir]
 * @returns {string}
 */
export function legacyKey(dir = process.cwd()) {
  return dir.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * Points transformers.js at $CLAUDE_MEMORY_HOME/models rather than its default cache inside the
 * plugin dir (see CLAUDE.md's "paths.useModelCache() exists because..." note — v4 ignores
 * HF_HOME/TRANSFORMERS_CACHE, so mutating `env.cacheDir` is the only way). Call before pipeline().
 * @param {{ env: { cacheDir: string|null } }} transformers
 * @returns {string}
 */
export function useModelCache(transformers) {
  const d = stateDir('models');
  transformers.env.cacheDir = d;
  return d;
}
