// Shared plumbing for the hooks that are GATES: read a JSON payload on stdin, decide cheaply,
// then detach the real work and exit. Three hooks had each grown their own copy of this —
// docs/decisions/2026-08-18-node-hooks.md, "Duplication".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stateDir, projectKey, logRetentionDays } from './paths.mjs';

/** Claude Code sends hook input as one JSON object on stdin. A hook must never die on bad input. */
export function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * @typedef {{
 *   cwd?: string,
 *   prompt?: string,
 *   session_id?: string,
 *   transcript_path?: string,
 *   hook_event_name?: string,
 *   tool_name?: string,
 *   tool_input?: Record<string, unknown>,
 *   stop_hook_active?: boolean,
 * } & Record<string, unknown>} HookPayload
 */

/**
 * Parse a hook payload. Anything unparseable is an empty payload, never a throw.
 *
 * @param {string} [raw]
 * @returns {HookPayload}
 */
export function payload(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * The cwd a hook should act on. Claude Code always sends it; `process.cwd()` is the safety net.
 *
 * @param {HookPayload} [p]
 * @returns {string}
 */
export function hookCwd(p) {
  return p?.cwd || process.cwd();
}

/**
 * Debounce markers, and the timestamps in them. Live under $CLAUDE_MEMORY_HOME/cache/, not
 * ~/.cache/claude-* — CLAUDE.md's "all mutable state lives in $CLAUDE_MEMORY_HOME" rule.
 * @param {string} name
 * @returns {string}
 */
export function markerPath(name) {
  return path.join(stateDir('cache'), `${name}.ts`);
}

/**
 * @param {string} file
 * @returns {number}
 */
export function readMarker(file) {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * @param {string} file
 * @param {number} seconds
 */
export function writeMarker(file, seconds) {
  try {
    fs.writeFileSync(file, `${seconds}\n`);
  } catch {
    /* a marker we cannot write means we run again next session — never a reason to fail the hook */
  }
}

// The day-claim marker `logs/.retention-<day>`: written by `claimDay()`, swept by
// `pruneDatedLogs()`. Anchored on a DATE — `.startsWith('.retention-')` also matched
// `.retention-notes.md` and a bare `.retention-`, which are not ours to delete.
const CLAIM = /^\.retention-(\d{4}-\d{2}-\d{2})$/;

/**
 * Claim today's retention pass, machine-wide. True for exactly one caller per day.
 * `wx` create-if-absent is the whole mechanism; any error (including EEXIST) means don't prune.
 * See CLAUDE.md's retention section and docs/decisions/2026-08-21-log-retention-day-claim.md.
 * @param {string} dir
 * @param {string} day  `YYYY-MM-DD`
 * @returns {boolean}
 */
function claimDay(dir, day) {
  try {
    fs.closeSync(fs.openSync(path.join(dir, `.retention-${day}`), 'wx'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Is a run still inside its debounce window? `last === 0` (no marker) must NOT count as recent,
 * or the first run would suppress itself forever.
 * @param {number} last
 * @param {number} windowSeconds
 * @param {number} now
 * @returns {boolean}
 */
export function withinDebounce(last, windowSeconds, now) {
  return last > 0 && now - last < windowSeconds;
}

/**
 * Whole seconds since the epoch — the unit every marker file is written in.
 * @param {number} [d]
 * @returns {number}
 */
export function nowSeconds(d = Date.now()) {
  return Math.floor(d / 1000);
}

// Exported since 2026-08-19 — kept here, not copied locally, after a local copy in
// distill-session.mjs silently broke distillation (ReferenceError, caught before any release
// shipped it). Full incident: CHANGELOG.md's 0.4.0 entry ("reindex() called a bare `which`").
/**
 * @param {string} cmd
 * @returns {string|null}
 */
export const which = (cmd) => {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return null;
};

/**
 * A machine-wide lock for background work too heavy to run twice at once. Ownership is a LIVE
 * PID, not a release call — a detached child cannot be trusted to clean up after itself, so the
 * lock frees itself once its process is gone. `maxSeconds` backstops a recycled pid or a wedged
 * child, the two cases a pid check alone can't see.
 * @param {number} pid
 */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The pid holding `file`, or null when the lock is free, stale or unreadable.
 *
 * @param {string} file
 * @param {number} maxSeconds
 * @param {number} [now]
 * @returns {number|null}
 */
export function lockHolder(file, maxSeconds, now = nowSeconds()) {
  try {
    const [pid, at] = fs.readFileSync(file, 'utf8').trim().split(/\s+/).map(Number);
    // pid 0 is the one value the finite check lets through and `kill(0, 0)` accepts: POSIX reads
    // it as "my own process group", so a lock truncated to `0 <ts>` would read as held for an hour.
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(at)) return null;
    if (now - at >= maxSeconds) return null;
    return alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * `wx` claims a lock that must not already exist; the default `w` hands an existing one over.
 * `at` names lockHolder's destructured `at` — a TIMESTAMP, not the `maxSeconds` duration beside it.
 * @param {string} file
 * @param {number} pid
 * @param {number} at
 * @param {string} [flag]
 * @returns {boolean}
 */
export function writeLock(file, pid, at, flag = 'w') {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${pid} ${at}\n`, { flag });
    return true;
  } catch {
    return false; // a lock we cannot write degrades to the old behaviour: another run may start
  }
}

/** @param {string} file */
export function releaseLock(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone, or never ours */
  }
}

/**
 * @param {string} file
 * @returns {number|null}
 */
const inode = (file) => {
  try {
    return fs.statSync(file).ino;
  } catch {
    return null;
  }
};

/**
 * Claim the lock. True only for the caller that created the file. The inode is captured before
 * the staleness verdict and re-checked after it, narrowing (not closing) a reclaim race — full
 * reasoning and the unlink-then-create bug it replaced: docs/architecture.md, "H16".
 * @param {string} file
 * @param {number} pid
 * @param {number} at
 * @param {number} maxSeconds
 * @param {number} [now]
 * @returns {boolean}
 */
export function takeLock(file, pid, at, maxSeconds, now = nowSeconds()) {
  const claim = () => writeLock(file, pid, at, 'wx');
  if (claim()) return true;

  const stale = inode(file);
  if (lockHolder(file, maxSeconds, now)) return false;
  // Vanished between the failed claim and here — released by its owner, not a rival. Retry via
  // `wx` rather than unlinking first: the file it would remove could be a lock created since.
  if (stale === null) return claim();
  if (inode(file) !== stale) return false; // replaced: the lock we judged is somebody else's now

  releaseLock(file);
  return claim();
}

/**
 * Locate the `claude` CLI.
 * PATH first, then the install locations a GUI-launched session may not have — one list, because
 * two lists drift and the failure is silent (CHANGELOG.md's `findClaude()` Homebrew/Linux fix).
 */
export function findClaude() {
  for (const cand of [
    which('claude'),
    path.join(os.homedir(), '.claude/local/claude'),
    path.join(os.homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/home/linuxbrew/.linuxbrew/bin/claude',
    '/usr/local/bin/claude',
  ]) {
    if (cand && fs.existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Append-open a log file, returning a writable fd or null. Detached children write straight to
 * the fd — piping would keep this process alive to shuttle bytes, the one thing a gate must not
 * do. Trims here too: distill.log/graphgen.log never go through `logBanner()`.
 * @param {string} file
 * @returns {number|null}
 */
function openLog(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    trimLog(file);
    return fs.openSync(file, 'a');
  } catch {
    return null;
  }
}

/**
 * Spawn background work and forget it. detached + unref + stdio to a file (or /dev/null) is the
 * whole contract — a child that inherited a pipe would hold the event loop open, one that
 * inherited stderr would print into the session transcript. Returns the child pid (a caller's
 * lock-file value), or null.
 *
 * @typedef {object} DetachOptions
 * @property {Record<string, string|undefined>} [env]
 * @property {string} [cwd]
 * @property {string} [logFile]
 */

/**
 * @param {string} cmd
 * @param {readonly string[]} args
 * @param {DetachOptions} [opts]
 * @returns {number|null}
 */
export function detach(cmd, args, { env, cwd, logFile } = {}) {
  const fd = logFile ? openLog(logFile) : null;
  try {
    const child = spawn(cmd, args, {
      cwd,
      detached: true,
      stdio: fd == null ? 'ignore' : ['ignore', fd, fd],
      env: env ? { ...process.env, ...env } : process.env,
    });
    // spawn() reports a missing binary ASYNCHRONOUSLY, so the throw below never sees it — recorded
    // here rather than swallowed, since a pid may already be written into a lock (same reason as
    // the LOCK HANDOVER FAILED banner).
    child.on('error', (e) => {
      if (logFile) logBanner(logFile, `spawn failed: ${e.message}`, new Date().toISOString());
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null; // a hook never fails because its background work could not start
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the child holds its own copy */
      }
    }
  }
}

// The only unbounded appends: semantic-index.log, distill.log, graphgen.log (CLAUDE.md's logging
// section). Two doors write to them, so both call trimLog() below — neither alone is enough.
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_KEEP_BYTES = 256 * 1024;

/**
 * Keep only the tail of an oversized log. NOT ATOMIC, deliberately — do not "fix" it with a
 * temp-file rename, that is worse here. Full reasoning: docs/architecture.md, "H15".
 * @param {string} file
 */
function trimLog(file) {
  try {
    const size = fs.statSync(file).size;
    if (size <= LOG_MAX_BYTES) return;
    const fd = fs.openSync(file, 'r');
    let tail;
    try {
      const buf = Buffer.allocUnsafe(LOG_KEEP_BYTES);
      const read = fs.readSync(fd, buf, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES);
      tail = buf.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
    const nl = tail.indexOf(0x0a);
    fs.writeFileSync(file, nl === -1 ? tail : tail.subarray(nl + 1));
  } catch {
    /* best effort */
  }
}

/**
 * Timestamped log banner, so one log file can be read as a sequence of runs.
 *
 * @param {string} file
 * @param {string} label
 * @param {string} iso
 */
export function logBanner(file, label, iso) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    trimLog(file);
    fs.appendFileSync(file, `\n=== ${iso} ${label} ===\n`);
  } catch {
    /* best effort */
  }
}

// One JSONL appender, two families — shape, retention and error-swallowing contract are in
// CLAUDE.md's logging section. The `logHook()` cost sweep (adding this call, six hooks, before
// and after medians) is in docs/decisions/2026-08-20-hook-startup-cost.md.
//
// ponytail: `projectKey()` is left uncached for a checkout whose `.git` is a FILE (worktree or
// submodule) — measured 14.6 ms per call in a worktree of this repo, 2026-08-21, on every
// Write/Edit through validate-note. Fixing it means resolving the `.git` file to the real config
// path and stamping THAT, a change to project identity that belongs in its own commit with its
// own test.

/**
 * Append one record to a daily-dated log family under `$CLAUDE_MEMORY_HOME/logs/`. Stamps `t` and
 * the project slug, then writes the caller's record verbatim after them (CLAUDE.md's "exactly one
 * JSONL appender" note). `slug` is the scoping key: the logs are MACHINE-WIDE, every project
 * appends to the same daily file. An unresolvable key logs `null` rather than throwing.
 *
 * @param {string} family
 * @param {string | undefined} cwd
 * @param {Record<string, unknown>} record
 */
export function appendJsonl(family, cwd, record) {
  try {
    const t = new Date().toISOString();
    /** @type {string | null} */
    let slug = null;
    try {
      slug = projectKey(cwd);
    } catch {
      /* no repo, or a key we cannot resolve — the line is still worth writing */
    }
    const dir = stateDir('logs');
    const file = path.join(dir, `${family}-${t.slice(0, 10)}.jsonl`);
    // One atomic wx claim per day, taken BEFORE the pass — CLAUDE.md's retention section and
    // docs/decisions/2026-08-21-log-retention-day-claim.md have the fail-closed reasoning.
    const day = t.slice(0, 10);
    /** @type {number | undefined} */
    let pruned;
    if (claimDay(dir, day)) {
      pruned = pruneDatedLogs(new Date(t)).length;
    }
    // Deleting is work, so it logs itself, AFTER the caller's own fields (CLAUDE.md's "a pass that
    // deleted anything reports it" note) — omitted when nothing was deleted, never zero.
    fs.appendFileSync(
      file,
      JSON.stringify({ t, slug, ...record, ...(pruned && { pruned }) }) + '\n',
    );
  } catch {
    /* a log that cannot be written must never fail or delay a hook */
  }
}

// The dated families, and the only basenames retention may delete. `scripts/doctor.sh` names the
// same two in a `sed -E` — a shell cannot import this, so keep them in step. A wildcard prefix
// deleted `backup-2026-01-01.jsonl` here and misread one there (2026-08-21).
const DATED_LOG = /^(recall|hooks)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Retention for the dated JSONL families: keep `logRetentionDays()` days, delete the rest.
 * DELETES, where the vault's log prune only moves — see CLAUDE.md's retention section for why.
 *
 * Cutoff is UTC, from `toISOString()`, the same producer that writes the filenames — the vault
 * pruner's local-by-design `cutoffDate()` was wrong here: `TZ=Pacific/Kiritimati` with retention 0
 * deleted the OTHER family's in-progress file on every append (measured 2026-08-21).
 *
 * First run after a gap is synchronous inside a hook: 150 ms to unlink 1095 stale files, 882 ms
 * for 4686 (macOS/APFS, 2026-08-21), against `hooks.json`'s 10 s timeout. Steady state is free —
 * 5.96 ms/append into an already-pruned dir, inside the noise of `appendFileSync` itself.
 * ponytail: uncapped — cap at N unlinks if a machine ever arrives with a backlog big enough to feel.
 *
 * @param {Date} [now]
 * @returns {string[]} the basenames removed
 */
export function pruneDatedLogs(now = new Date()) {
  /** @type {string[]} */
  const removed = [];
  try {
    const dir = stateDir('logs');
    const days = logRetentionDays();
    // Date arithmetic, not `now - days * 86400` — an out-of-range `days` makes an Invalid Date
    // whose toISOString() THROWS, caught below, rather than a `NaN-NaN-NaN` string that sorts
    // above every date and deletes the lot (what cutoffDate()'s own comment records costing it).
    const cutoff = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days),
    )
      .toISOString()
      .slice(0, 10);
    const today = now.toISOString().slice(0, 10);
    for (const name of fs.readdirSync(dir)) {
      // Anchored on the two families BY NAME, not `[a-z-]+` — that matched and unlinked
      // `backup-*`/`my-notes-export-*` too (measured 2026-08-21); only what we write is ours.
      // Yesterday's day-claim goes with yesterday's logs, so the dotfile doesn't accumulate in
      // the name of not accumulating the log file.
      const claim = CLAIM.exec(name);
      if (claim) {
        if (claim[1] >= today) continue; // today's own claim, or a future one from a wrong clock
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          /* best effort, same as the logs */
        }
        continue;
      }
      const m = DATED_LOG.exec(name);
      if (!m || m[2] >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
        removed.push(name);
      } catch {
        /* a log we cannot delete is a log that stays */
      }
    }
  } catch {
    /* best effort */
  }
  return removed;
}

/**
 * The closed set of hook outcomes — a hook that did nothing must be DISTINGUISHABLE from one that
 * ran, since hooks degrade silently by design. `spawned` is a gate line only: the detached child's
 * own line arrives later under the same session id.
 *
 * @typedef {'ran' | 'noop-missing-dep' | 'debounced' | 'child-guard' | 'spawned' | 'error'} HookOutcome
 */

/**
 * @typedef {{
 *   hook: string,
 *   event?: string,
 *   cwd?: string,
 *   session?: string,
 *   outcome: HookOutcome,
 *   reason?: unknown,
 *   extra?: Record<string, unknown>,
 * }} HookLogInput
 */

/**
 * One line per hook invocation. `extra` is one generic slot, always optional and omitted (never
 * zero) when not measured. `ms` is PROCESS START (CLAUDE.md's "logHook()'s ms" note).
 * @param {HookLogInput} input
 */
export function logHook({ hook, event = '', cwd, session, outcome, reason, extra }) {
  // *_CHILD guards suppress only their OWN hook, so a heavy hook's headless `claude` re-firing
  // SessionStart is marked, not suppressed — its cost is real, just not a user session's.
  const child = Boolean(process.env.CLAUDE_DISTILL_CHILD || process.env.CBM_GRAPHGEN_CHILD);
  appendJsonl('hooks', cwd, {
    // extra FIRST — spread last, a caller could overwrite the four fields the reader judges by.
    ...(extra ?? {}),
    hook,
    event,
    ms: +performance.now().toFixed(1),
    outcome,
    ...(child ? { child: true } : {}),
    // Omitted rather than null when absent, so a reader can tell "not recorded" from "recorded as
    // empty" — the same omission rule recall's records already follow.
    ...(reason == null || reason === '' ? {} : { reason: String(reason).slice(0, 200) }),
    ...(session ? { session } : {}),
  });
}

/**
 * Count lines the way `wc -l` does: newline bytes, no string allocation for a large transcript.
 *
 * @param {string} file
 * @returns {number}
 */
export function countLines(file) {
  try {
    const buf = fs.readFileSync(file);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    return n;
  } catch {
    return 0;
  }
}

/**
 * A hook's one line of stdout: Claude Code renders `systemMessage` to the user.
 *
 * @param {string} text
 * @returns {string}
 */
export function systemMessage(text) {
  return JSON.stringify({ systemMessage: text });
}
