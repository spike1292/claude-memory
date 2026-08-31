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

// The reasons are constants because outcomeOf() below decides on them. Two literals — one here,
// one there — is a drift that no test written against a literal can see: reword this string and a
// dead dependency starts reporting as a healthy hook, with the suite green.
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
 *
 * Tolerates a not-yet-migrated vault the same way insights-surface does: vault-memory-sync performs
 * the legacy_key -> project_key rename, but SessionStart hook order is not guaranteed, so fall back
 * for this one session rather than indexing nothing.
 *
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
 *
 * `existsSync` DEREFERENCES, which is what this check needs: since 0.3.1 the plugin's node_modules
 * is a symlink into $CLAUDE_MEMORY_HOME (scripts/share-modules.mjs), and a check that stats the
 * link instead of the target is exactly the bug that made /memory:doctor report 0 MB on 2026-08-18.
 * Do not "optimise" this to lstat.
 *
 * @param {string} [root]
 * @returns {boolean}
 */
export function runtimeInstalled(root = pluginRoot) {
  return isDir(path.join(root, 'node_modules', '@huggingface', 'transformers'));
}

/**
 * Decide, without doing anything. Pure enough to test against a temp vault: it reads the
 * filesystem and returns a verdict, but spawns nothing and writes nothing.
 *
 * @param {string} cwd
 * @param {{ vaultRoot?: string }} [options]
 * @returns {RefreshPlan}
 */
export function plan(cwd, { vaultRoot = vault() } = {}) {
  const slug = resolveSlug(cwd, vaultRoot);
  if (!slug) return { run: false, reason: REASONS.noVault };

  const script = path.join(scriptsDir, 'memory-semantic.mjs');
  if (!fs.existsSync(script)) return { run: false, reason: REASONS.noScript };

  // The embedding runtime is an npm install, and Claude Code's plugin auto-install skips lifecycle
  // scripts — so onnxruntime-node's native binary may be missing even when the package dir exists.
  // Say so once instead of failing silently at query time.
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
 *
 * TWO variables, not one. The session id alone would be INHERITED by any indexer further down the
 * tree — the distiller runs one of its own at the end of every distillation — and that run would
 * then be logged as THIS hook's worker, filing a SessionEnd re-index under SessionStart. Observed
 * 2026-08-21, in the end-to-end check for this change. The marker says "this indexer is this hook's
 * worker"; the session id only says which run it belongs to.
 *
 * `MEMORY_INDEX_HOOK` is read by scripts/memory-semantic.mjs and nowhere else; a test pins the two
 * spellings together, since a rename on one side would silently stop the worker line being written.
 *
 * @param {string} [session]
 * @returns {Record<string, string | undefined>}
 */
export function workerEnv(session) {
  return { MEMORY_HOOK_SESSION: session, MEMORY_INDEX_HOOK: '1' };
}

/**
 * Plan, then act.
 *
 * No lock here. The indexer takes its own cross-process, per-model lock (`db/.index-<model>.lock`),
 * which is the one that guards the corruption it was born from — a table holding 384-dim and
 * 1024-dim vectors at once. The second lock this hook used to take guarded the same file at a
 * coarser scope, and its only observable effect was a SILENT skip: on contention it exited 0 with
 * no output, so a session that indexed nothing looked identical to one that had nothing to index.
 *
 * @param {string} cwd
 * `session` is forwarded to the detached indexer through the environment, so the line IT writes
 * when the re-index finishes and the gate line written here read as one background run.
 *
 * @param {Date} [now]
 * @param {string} [session]
 * @returns {RefreshPlan}
 */
export function refresh(cwd, now = new Date(), session) {
  const p = plan(cwd);
  if (!p.run) {
    if (p.warn) console.error(p.warn);
    return p;
  }
  logBanner(p.logFile, p.slug, now.toISOString().replace(/\.\d+Z$/, 'Z'));
  // A null pid is the only signal that the spawn failed — it fails asynchronously — and reporting
  // `spawned` for a re-index that never started is the healthy-looking lie this log exists to end.
  const pid = detach(process.execPath, p.args, {
    cwd,
    logFile: p.logFile,
    env: workerEnv(session),
  });
  return { ...p, spawned: pid != null };
}

// A hook that is permanently dead because its runtime was never installed must not read as a hook
// that ran and found nothing to do — that is the whole point of logging an outcome rather than a
// duration. These are the same objects plan() returns, not copies of their text.
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
