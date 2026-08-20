// SessionStart: if a GRAPH_REPORT exists but the repo has commits newer than it, regenerate it in
// the background and tell the user — the logic half. The CLI entry is hooks/graph-staleness-check.mjs.
//
// Zero repo footprint: replaces per-repo git post-commit hooks. Guards, in order:
//   - CBM_GRAPHGEN_CHILD set -> we ARE the background run; never recurse
//   - no report yet          -> stay silent (never auto-generate the first one)
//   - not a git work tree    -> nothing to compare against
//   - report >= HEAD         -> fresh
//   - debounced (24h/repo)   -> nudge, don't respawn while stale
//   - claude CLI missing     -> nudge
// then check() claims the machine-wide lock, or nudges: the debounce above is only per-repo.

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
  logBanner,
  takeLock,
  writeLock,
  releaseLock,
  nowSeconds,
  systemMessage,
} from './hook-io.mjs';

/**
 * @typedef {{ vaultRoot?: string, now?: number }} PlanOptions
 * @typedef {{ action: 'silent', reason: string }} SilentPlan
 * @typedef {{ action: 'nudge', message: string, reason: string, slug: string }} NudgePlan
 * @typedef {{
 *   action: 'regen',
 *   message: string,
 *   slug: string,
 *   claude: string,
 *   marker: string,
 *   lock: string,
 *   now: number,
 *   logFile: string,
 * }} RegenPlan
 * @typedef {SilentPlan | NudgePlan | RegenPlan} GraphPlan
 * @typedef {{
 *   line: string,
 *   outcome: import('./hook-io.mjs').HookOutcome,
 *   reason?: string,
 * }} CheckResult
 */

// Constants because outcomeOf() decides on them. A reworded literal here and a stale literal there
// silently turns a missing `claude` back into an indistinguishable "ran".
export const REASONS = {
  child: 'child run',
  debounced: 'debounced',
  noClaude: 'no claude CLI',
};

export const DEBOUNCE_SECONDS = 86_400; // 24h — caps the cost of an otherwise heavy unattended run

// The debounce is keyed by repo, so N stale repos opened together were N legal parallel runs, each
// a headless `claude` plus an MCP server plus a full index (#34). One machine-wide lock, because a
// full index is already CPU-bound: a second concurrent run buys nothing and costs everything.
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
 *
 * @param {unknown} text
 * @returns {string | null}
 */
export function recordedCommit(text) {
  const m = /^commit:[ \t]*(\S+)/m.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * Fresh when HEAD begins with the recorded sha — the report records a SHORT sha.
 *
 * @param {string | null | undefined} head
 * @param {string | null | undefined} recorded
 * @returns {boolean}
 */
export function isFresh(head, recorded) {
  return Boolean(head && recorded && head.startsWith(recorded));
}

/**
 * @param {string} cwd
 * @param {readonly string[]} args
 * @returns {string}
 */
const git = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
};

/**
 * The GRAPH_REPORT path for this cwd, honouring the pre-migration legacy slug.
 *
 * @param {string} cwd
 * @param {string} [vaultRoot]
 * @returns {{ slug: string, report: string | null }}
 */
export function reportFor(cwd, vaultRoot = vault()) {
  let slug;
  try {
    slug = projectKey(cwd);
  } catch {
    slug = legacyKey(cwd);
  }
  const at = (/** @type {string} */ s) => path.join(vaultRoot, 'Graph', s, 'GRAPH_REPORT.md');
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
 *
 * @param {string} cwd
 * @param {PlanOptions} [options]
 * @returns {GraphPlan}
 */
export function plan(cwd, { vaultRoot = vault(), now = nowSeconds() } = {}) {
  if (process.env.CBM_GRAPHGEN_CHILD) return { action: 'silent', reason: REASONS.child };

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
    return { action: 'nudge', message: NUDGE_MESSAGE, reason: REASONS.debounced, slug };

  const claude = findClaude();
  if (!claude) return { action: 'nudge', message: NUDGE_MESSAGE, reason: REASONS.noClaude, slug };

  return {
    action: 'regen',
    message: STALE_MESSAGE,
    slug,
    claude,
    marker,
    lock: path.join(stateDir('run'), 'graphgen.lock'),
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
 * The lock is claimed HERE and not in plan(): an advisory read there would decide nothing the
 * atomic create does not, and the create is the only thing that picks one winner out of two
 * sessions starting in the same second. It is then rewritten to hold the CHILD's pid, since the
 * child is what the next session must wait on — this process is about to exit.
 *
 * `opts` is passed straight through to plan(); the entry never sets it. It exists so a test can
 * point this at a scratch vault instead of the real one — a check() that could only read the live
 * vault could not be tested at all, and this is the half with the lock sequence in it.
 *
 * This is the ONE detached hook that does NOT run under hooks/log-worker.mjs, and the reason is
 * the lock. `lockHolder()` frees a lock whose pid is dead, so the pid written into `graphgen.lock`
 * has to be a process that lives exactly as long as the work does. A supervisor breaks that: kill
 * it, or lose it to an OOM, and the headless `claude` keeps regenerating as an orphan while the
 * lock reads as free — so the next session starts a SECOND concurrent re-index, which is the one
 * thing this lock exists to prevent. A worker line is worth less than that, so this hook is
 * observed at its gate only and `--hooks` says so.
 *
 *
 * @param {string} cwd
 * @param {PlanOptions} [opts]
 * @returns {CheckResult}
 */
export function check(cwd, opts) {
  const p = plan(cwd, opts);
  if (p.action === 'silent') return { line: '', outcome: outcomeOf(p), reason: p.reason };
  if (p.action === 'nudge')
    return { line: systemMessage(p.message), outcome: outcomeOf(p), reason: p.reason };
  if (!takeLock(p.lock, process.pid, p.now, LOCK_MAX_SECONDS, p.now))
    return { line: systemMessage(BUSY_MESSAGE), outcome: 'ran', reason: 'lock held elsewhere' };

  const pid = detach(
    p.claude,
    ['-p', REGEN_PROMPT, '--permission-mode', 'acceptEdits', '--dangerously-skip-permissions'],
    { cwd, logFile: p.logFile, env: { CBM_GRAPHGEN_CHILD: '1' } },
  );
  // The marker is written only for a run that actually started. It used to be written first, to
  // stop a second session piling in while the spawn was still in flight; the lock does that now,
  // and writing it first meant a failed spawn muted this repo for 24h as if a regen had happened.
  if (!pid) {
    releaseLock(p.lock);
    return { line: systemMessage(NUDGE_MESSAGE), outcome: 'error', reason: 'spawn failed' };
  }
  writeMarker(p.marker, p.now);
  // The handover is the one write whose failure is WORSE than not locking at all: the file would
  // keep this process's pid, this process exits a line later, and the next session would then see
  // a dead owner and start a second re-index while the child is still indexing. Nothing better can
  // be done about it here — a filesystem that refused this write will refuse the next one too — so
  // it is made loud instead of silent. This repo's own list of past defects has "silent fail-open
  // from missing logging" on it.
  if (!writeLock(p.lock, pid, p.now))
    logBanner(
      p.logFile,
      `LOCK HANDOVER FAILED (child ${pid}) — another session may start a second re-index`,
      new Date().toISOString(),
    );
  return { line: systemMessage(p.message), outcome: 'spawned', reason: p.slug };
}

/**
 * @param {SilentPlan | NudgePlan} p
 * @returns {import('./hook-io.mjs').HookOutcome}
 */
function outcomeOf(p) {
  if (p.reason === REASONS.child) return 'child-guard';
  if (p.reason === REASONS.debounced) return 'debounced';
  // A missing `claude` CLI is the one dependency this hook has, and losing it is invisible from
  // outside: the nudge it prints instead is the same nudge a debounced run prints.
  if (p.reason === REASONS.noClaude) return 'noop-missing-dep';
  return 'ran';
}
