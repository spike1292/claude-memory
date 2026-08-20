// SessionStart: if a GRAPH_REPORT exists but the repo has commits newer than it, regenerate it in
// the background and tell the user — the logic half. The CLI entry is hooks/graph-staleness-check.mjs.
//
// Zero repo footprint: replaces per-repo git post-commit hooks. Guards, in order:
//   - CBM_GRAPHGEN_CHILD set -> we ARE the background run; never recurse
//   - no report yet          -> stay silent (never auto-generate the first one)
//   - not a git work tree    -> nothing to compare against
//   - report >= HEAD         -> fresh
//   - debounced (24h/repo)   -> nudge, don't respawn while stale
//   - another run in flight  -> nudge; the lock is machine-wide, the debounce is only per-repo
//   - claude CLI missing     -> nudge

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { vault, projectKey, legacyKey, stateDir } from './paths.mjs';
import {
  detach,
  findClaude,
  markerPath,
  readMarker,
  writeMarker,
  withinDebounce,
  lockPath,
  lockHolder,
  takeLock,
  writeLock,
  releaseLock,
  nowSeconds,
  systemMessage,
} from './hook-io.mjs';

export const DEBOUNCE_SECONDS = 86_400; // 24h — caps the cost of an otherwise heavy unattended run

// The debounce is keyed by repo, so N stale repos opened together were N legal parallel runs, each
// a headless `claude` plus an MCP server plus a full index (#34). One machine-wide lock, because a
// full index is already CPU-bound: a second concurrent run buys nothing and costs everything.
export const LOCK_NAME = 'graphgen';
export const LOCK_MAX_SECONDS = 3600; // a full index is minutes; an hour means gone or wedged

export const STALE_MESSAGE =
  'Graph report is stale — regenerating in the background (full re-index, takes a few minutes). ' +
  'It will be current for your next session.';
export const NUDGE_MESSAGE =
  'Graph report is stale (commits newer than the report) — run /memory:graph-report to refresh.';
export const BUSY_MESSAGE =
  'Graph report is stale — a background regeneration is already running for another repo. ' +
  'It will pick this one up on a later session, or run /memory:graph-report to refresh now.';

// Full index mode preserves clone/semantic edges, which an incremental pass drops.
export const REGEN_PROMPT =
  '/memory:graph-report This is an automated background refresh — re-index in full mode ' +
  "(index_repository mode='full') so similarity/semantic edges are preserved.";

/**
 * The commit a report records in its YAML frontmatter, or null.
 *
 * Staleness is judged by RECORDED COMMIT, not mtime: the vault syncs via Synology CloudStorage,
 * where mtimes are set by the sync rather than by the write and are therefore meaningless.
 */
export function recordedCommit(text) {
  const m = /^commit:[ \t]*(\S+)/m.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** Fresh when HEAD begins with the recorded sha — the report records a SHORT sha. */
export function isFresh(head, recorded) {
  return Boolean(head && recorded && head.startsWith(recorded));
}

const git = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
};

/** The GRAPH_REPORT path for this cwd, honouring the pre-migration legacy slug. */
export function reportFor(cwd, vaultRoot = vault()) {
  let slug;
  try {
    slug = projectKey(cwd);
  } catch {
    slug = legacyKey(cwd);
  }
  const at = (s) => path.join(vaultRoot, 'Graph', s, 'GRAPH_REPORT.md');
  if (fs.existsSync(at(slug))) return { slug, report: at(slug) };
  const legacy = legacyKey(cwd);
  if (legacy !== slug && fs.existsSync(at(legacy))) return { slug: legacy, report: at(legacy) };
  return { slug, report: null };
}

/**
 * Decide, without spawning or writing. Returns one of:
 *   {action:'silent'}                     nothing to say
 *   {action:'nudge',  message}            stale, but we will not regenerate it ourselves
 *   {action:'regen',  message, claude, …} stale, and a background run is warranted
 */
export function plan(cwd, { vaultRoot = vault(), now = nowSeconds() } = {}) {
  if (process.env.CBM_GRAPHGEN_CHILD) return { action: 'silent', reason: 'child run' };

  const { slug, report } = reportFor(cwd, vaultRoot);
  // Never auto-generate the FIRST report: that is a minutes-long unattended run the user never
  // asked for. Absence is a choice, not a gap.
  if (!report) return { action: 'silent', reason: 'no report yet' };
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true')
    return { action: 'silent', reason: 'not a git work tree' };

  let recorded = null;
  try {
    recorded = recordedCommit(fs.readFileSync(report, 'utf8'));
  } catch {
    /* unreadable report -> cannot judge -> stay silent */
  }
  if (!recorded) return { action: 'silent', reason: 'no recorded commit' };

  const head = git(cwd, ['rev-parse', 'HEAD']);
  if (!head) return { action: 'silent', reason: 'no HEAD' };
  if (isFresh(head, recorded)) return { action: 'silent', reason: 'fresh' };

  const marker = markerPath(`graphgen-${slug}`);
  if (withinDebounce(readMarker(marker), DEBOUNCE_SECONDS, now))
    return { action: 'nudge', message: NUDGE_MESSAGE, reason: 'debounced', slug };

  const claude = findClaude();
  if (!claude) return { action: 'nudge', message: NUDGE_MESSAGE, reason: 'no claude CLI', slug };

  const lock = lockPath(LOCK_NAME);
  if (lockHolder(lock, LOCK_MAX_SECONDS, now))
    return { action: 'nudge', message: BUSY_MESSAGE, reason: 'another run in flight', slug };

  return {
    action: 'regen',
    message: STALE_MESSAGE,
    slug,
    claude,
    marker,
    lock,
    now,
    logFile: path.join(stateDir('logs'), 'graphgen.log'),
  };
}

/**
 * Plan, then act. Returns the line to print, or ''.
 *
 * `--dangerously-skip-permissions`: a headless run must call MCP tools and Write with no prompt.
 * `CBM_GRAPHGEN_CHILD=1`: the background run fires SessionStart too, and without this it would
 * schedule another one of itself.
 *
 * The lock is claimed HERE and not in plan(): plan()'s check is advisory and racy, and the atomic
 * create is the only thing that picks one winner out of two sessions starting in the same second.
 * It is then rewritten to hold the CHILD's pid, since the child is what the next session must wait
 * on — this process is about to exit.
 */
export function check(cwd) {
  const p = plan(cwd);
  if (p.action === 'silent') return '';
  if (p.action === 'nudge') return systemMessage(p.message);
  if (!takeLock(p.lock, process.pid, p.now, LOCK_MAX_SECONDS, p.now))
    return systemMessage(BUSY_MESSAGE);

  writeMarker(p.marker, p.now);
  const pid = detach(
    p.claude,
    ['-p', REGEN_PROMPT, '--permission-mode', 'acceptEdits', '--dangerously-skip-permissions'],
    { cwd, logFile: p.logFile, env: { CBM_GRAPHGEN_CHILD: '1' } },
  );
  if (!pid) {
    releaseLock(p.lock);
    return systemMessage(NUDGE_MESSAGE);
  }
  writeLock(p.lock, pid, p.now);
  return systemMessage(p.message);
}
