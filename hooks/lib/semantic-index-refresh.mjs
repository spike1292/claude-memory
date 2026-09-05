// SessionStart: keep the semantic vault index current, in the background — the logic half. The
// CLI entry is hooks/semantic-index-refresh.mjs. Why a hook rather than a convention, and why
// SessionStart rather than SessionEnd: docs/architecture.md's Flow 1.
//
// Cost when nothing changed: the indexer compares mtimes and exits before loading the model, so
// a no-op costs a stat pass. Either way the child is detached, so session start never waits.

import fs from 'node:fs';
import path from 'node:path';
import { vault, projectKey, legacyKey, stateDir, scriptsDir, pluginRoot } from './paths.mjs';
import { detach, logBanner } from './hook-io.mjs';

// Constants, not literals — outcomeOf() below decides on them too; see CLAUDE.md's
// "reason string that an outcome mapper decides on" rule.
export const REASONS = {
  noVault: 'no vault memory for this project',
  noScript: 'indexer script missing',
  noRuntime: 'embedding runtime not installed',
};

/**
 * @typedef {{ run: false, reason: string, warn?: string }} SkipPlan
 * @typedef {{
 *   run: true, slug: string, script: string, args: string[], logFile: string, spawned?: boolean,
 * }} RunPlan
 * @typedef {SkipPlan | RunPlan} RefreshPlan
 */

/** @param {string} p */
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The slug whose vault memory actually exists on disk, or null.
 * Falls back to the legacy slug for this one session: vault-memory-sync's legacy_key ->
 * project_key rename may not have run yet, since SessionStart hook order is not guaranteed.
 * @param {string} cwd
 * @param {string} [vaultRoot]
 * @returns {string | null}
 */
export function resolveSlug(cwd, vaultRoot = vault()) {
  let slug;
  try {
    slug = projectKey(cwd);
  } catch {
    slug = legacyKey(cwd);
  }
  if (isDir(path.join(vaultRoot, 'Memory', slug))) return slug;
  const legacy = legacyKey(cwd);
  if (legacy !== slug && isDir(path.join(vaultRoot, 'Memory', legacy))) return legacy;
  return null;
}

/**
 * Is the embedding runtime actually installed?
 * `existsSync` dereferences on purpose: node_modules is a symlink into $CLAUDE_MEMORY_HOME
 * (scripts/share-modules.mjs), and lstat-ing the link instead of the target is the bug that made
 * /memory:doctor report 0 MB on 2026-08-18.
 * @param {string} [root]
 * @returns {boolean}
 */
export function runtimeInstalled(root = pluginRoot) {
  return isDir(path.join(root, 'node_modules', '@huggingface', 'transformers'));
}

/**
 * Decide without acting — reads the filesystem, spawns and writes nothing, so it's testable
 * against a temp vault.
 * @param {string} cwd
 * @param {{ vaultRoot?: string }} [options]
 * @returns {RefreshPlan}
 */
export function plan(cwd, { vaultRoot = vault() } = {}) {
  const slug = resolveSlug(cwd, vaultRoot);
  if (!slug) return { run: false, reason: REASONS.noVault };

  const script = path.join(scriptsDir, 'memory-semantic.mjs');
  if (!fs.existsSync(script)) return { run: false, reason: REASONS.noScript };

  // `npm ci` skips lifecycle scripts (docs/architecture.md, Flow 5), so the native binary can be
  // missing even when the package dir exists. Say so once instead of failing at query time.
  if (!runtimeInstalled())
    return {
      run: false,
      reason: REASONS.noRuntime,
      warn: '⚠ memory: embedding runtime not installed — semantic recall is off. Run /memory:install',
    };

  return {
    run: true,
    slug,
    script,
    args: [script, '--index', cwd],
    logFile: path.join(stateDir('logs'), 'semantic-index.log'),
  };
}

/**
 * The environment the detached indexer runs under.
 * Two variables, not one — the session id alone is inherited by the distiller's own re-index too;
 * see CLAUDE.md's "indexer's line is guarded by MEMORY_INDEX_HOOK" note.
 * @param {string} [session]
 * @returns {Record<string, string | undefined>}
 */
export function workerEnv(session) {
  return { MEMORY_HOOK_SESSION: session, MEMORY_INDEX_HOOK: '1' };
}

/**
 * Plan, then act.
 * No lock here — the indexer takes its own cross-process, per-model lock (db/.index-<model>.lock).
 * This hook used to take a second, coarser one on the same file; its only effect was a silent
 * skip on contention (exit 0, no output), so a session that indexed nothing looked like one with
 * nothing to index.
 * @param {string} cwd
 * @param {Date} [now]
 * @param {string} [session] forwarded to the detached indexer so its own log line and this hook's
 *   gate line read as one background run
 * @returns {RefreshPlan}
 */
export function refresh(cwd, now = new Date(), session) {
  const p = plan(cwd);
  if (!p.run) {
    if (p.warn) console.error(p.warn);
    return p;
  }
  logBanner(p.logFile, p.slug, now.toISOString().replace(/\.\d+Z$/, 'Z'));
  // Null pid is the only signal the spawn failed (it fails async) — see CLAUDE.md's
  // "gate that detaches decides its outcome on detach()'s pid" note.
  const pid = detach(process.execPath, p.args, {
    cwd,
    logFile: p.logFile,
    env: workerEnv(session),
  });
  return { ...p, spawned: pid != null };
}

// Same objects plan() returns, not copies of their text — a permanently-dead hook must not read
// as one that ran and found nothing to do.
const MISSING_DEP = new Set([REASONS.noRuntime, REASONS.noScript]);

/**
 * @param {RefreshPlan} p
 * @returns {import('./hook-io.mjs').HookOutcome}
 */
export function outcomeOf(p) {
  // Absent `spawned` means nobody acted; report the loud reading rather than claiming success.
  if (p.run) return p.spawned ? 'spawned' : 'error';
  return MISSING_DEP.has(p.reason) ? 'noop-missing-dep' : 'ran';
}
