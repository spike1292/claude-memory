// SessionStart: keep the semantic vault index current, in the background — the logic half.
// The CLI entry is hooks/semantic-index-refresh.mjs.
//
// Why a hook and not a convention: the index only refreshed if someone ran /memory:prune. Every
// convention in this system has eventually failed that way (MOC-only notes recurred through four
// audits, path drift through two), and a stale vector index is worse than none — it answers with
// notes that were merged away hours ago.
//
// Why SessionStart and not SessionEnd: the SessionEnd distiller writes new Insight notes *during*
// shutdown, so a SessionEnd refresh races it. Refreshing at the start of the next session picks up
// everything the previous one wrote, whatever order it landed in.
//
// Cost when nothing changed: the indexer compares mtimes and exits before loading the model, so a
// no-op costs a stat pass. Either way the child is detached, so session start never waits.

import fs from 'node:fs';
import path from 'node:path';
import { vault, projectKey, legacyKey, stateDir, scriptsDir, pluginRoot } from './paths.mjs';
import { detach, logBanner } from './hook-io.mjs';

/**
 * @typedef {{ run: false, reason: string, warn?: string }} SkipPlan
 * @typedef {{ run: true, slug: string, script: string, args: string[], logFile: string }} RunPlan
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
  if (!slug) return { run: false, reason: 'no vault memory for this project' };

  const script = path.join(scriptsDir, 'memory-semantic.mjs');
  if (!fs.existsSync(script)) return { run: false, reason: 'indexer script missing' };

  // The embedding runtime is an npm install, and Claude Code's plugin auto-install skips lifecycle
  // scripts — so onnxruntime-node's native binary may be missing even when the package dir exists.
  // Say so once instead of failing silently at query time.
  if (!runtimeInstalled())
    return {
      run: false,
      reason: 'embedding runtime not installed',
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
 * Plan, then act.
 *
 * No lock here. The indexer takes its own cross-process, per-model lock (`db/.index-<model>.lock`),
 * which is the one that guards the corruption it was born from — a table holding 384-dim and
 * 1024-dim vectors at once. The second lock this hook used to take guarded the same file at a
 * coarser scope, and its only observable effect was a SILENT skip: on contention it exited 0 with
 * no output, so a session that indexed nothing looked identical to one that had nothing to index.
 *
 * @param {string} cwd
 * @param {Date} [now]
 * @returns {RefreshPlan}
 */
export function refresh(cwd, now = new Date()) {
  const p = plan(cwd);
  if (!p.run) {
    if (p.warn) console.error(p.warn);
    return p;
  }
  logBanner(p.logFile, p.slug, now.toISOString().replace(/\.\d+Z$/, 'Z'));
  detach(process.execPath, p.args, { cwd, logFile: p.logFile });
  return p;
}
