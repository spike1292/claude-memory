// Shared plumbing for the hooks that are GATES: read a JSON payload on stdin, decide cheaply,
// then detach the real work and exit. Exists because three hooks had each grown their own copy
// of stdin parsing, a debounce marker, findClaude() and detach() — see the "Duplication" bullet
// in docs/decisions/2026-08-18-node-hooks.md.
//
// Everything here is either pure (and tested) or a three-line wrapper over one node: API. The
// split is deliberate: the decisions are pure functions the tests can drive with plain values,
// and the I/O is thin enough to read at a glance.

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
 * The cwd for a WRITE path: the payload's own field only, never `process.cwd()`.
 *
 * `process.cwd()` is right for a hook Claude Code spawned in the project, and wrong for a detached
 * worker or an agent-spawned subprocess — the same silent-fallback shape as `requireVault()` in
 * paths.mjs, and for the same reason: a write that guesses scope can write into the wrong project.
 *
 * @param {HookPayload | null} [p]
 * @returns {string}
 */
export function requireHookCwd(p) {
  if (p?.cwd) return p.cwd;
  throw new Error('hook payload has no cwd — refusing to infer scope for a write');
}

/**
 * Debounce markers, and the timestamps in them.
 *
 * They live under $CLAUDE_MEMORY_HOME/cache/ rather than ~/.cache/claude-*, which is where the
 * shell versions kept them. Same rule as db/, models/ and logs/: one machine-local root, so there
 * is one directory to inspect, size and clear. The cost of moving them is one missed debounce per
 * marker at upgrade time — a single extra background run, never a wrong one.
 *
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
 *
 * `wx` is the whole mechanism: create-if-absent is one syscall and one atomic decision, where a
 * read-then-write stamp is two and loses the race between them. EEXIST means someone else has
 * today; ANY other error means we could not claim it and therefore must not prune — a read-only
 * `logs/` cannot be pruned either, so declining is the honest answer rather than a pass that
 * unlinks nothing and repeats on the next append.
 *
 * The marker is named by the day, so the sweep it authorises removes yesterday's along with the
 * logs (`pruneDatedLogs()` below). Nothing else in `logs/` starts with a dot.
 *
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
 * Is a run still inside its debounce window?
 *
 * `last === 0` means no marker, which must NOT count as recent — the missing-marker case is the
 * first run, and suppressing it would mean the feature never fires at all.
 *
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
 *
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
 * A machine-wide lock for background work too heavy to run twice at once.
 *
 * Ownership is a LIVE PID, not a release call. A detached child cannot be trusted to clean up
 * after itself — it is killed, the machine sleeps, the parent hook exited minutes ago — so the
 * lock frees itself the moment its process is gone. `maxSeconds` is the backstop for the two
 * cases a pid check cannot see: a pid recycled onto an unrelated process, and a child that wedged.
 *
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
 *
 * `at` is a TIMESTAMP, and is named to match lockHolder's destructured `at` — `maxSeconds` next to
 * it is a duration, and one edit blurring the two would silently change what "stale" means.
 *
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
 * Claim the lock. True only for the caller that created the file.
 *
 * `wx` is atomic, so two sessions racing for a FREE lock always pick one winner. Reclaiming a
 * STALE one cannot be atomic — unlink and create are two syscalls — and a plain unlink-then-create
 * is wrong: the loser's unlink deletes the winner's fresh lock and it then claims the empty path,
 * so both believe they hold it and both start a re-index (the thing this exists to prevent).
 *
 * The inode is therefore captured before the staleness verdict and re-checked after it: a lock
 * that has been replaced in the meantime is somebody else's, and we stand down rather than unlink
 * it.
 *
 * ponytail: that narrows the race to the gap between the re-check and the unlink and does not
 * close it. Closing it needs an OS-level lock, which Node's `fs` does not expose — the upgrade is
 * a native `flock` binding, and the residual cost is one extra re-index in an interleaving of
 * microseconds that also requires the previous owner to be dead.
 *
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
  // Vanished between the failed claim and here — released by its owner, not reclaimed by a rival.
  // `wx` settles it atomically, so retry rather than reporting busy while nothing is running. It
  // must NOT unlink first: the file it would remove could be a lock created since.
  if (stale === null) return claim();
  if (inode(file) !== stale) return false; // replaced: the lock we judged is somebody else's now

  releaseLock(file);
  return claim();
}

/**
 * Locate the `claude` CLI.
 *
 * PATH first, then the install locations a GUI-launched session may not have on PATH. One list,
 * because two lists drift and the failure is silent: the hook simply stops doing its job.
 *
 * Both Homebrew prefixes are here because the list was Apple-Silicon-only until 2026-08-21, which
 * made every hook a no-op on a Linux install that README claims to support — silently, since a
 * missing `claude` is indistinguishable from a hook that had nothing to do.
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
 * Append-open a log file, returning a writable fd or null.
 *
 * Detached children write straight to the fd. Piping instead would keep this process alive to
 * shuttle bytes, which is the one thing a gate must not do.
 *
 * This is where distill.log and graphgen.log are opened, and each carries a headless `claude`
 * child's whole stdout+stderr, so the cap has to be applied HERE and not only in `logBanner()` —
 * those two logs never go through the banner helper.
 *
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
 * Spawn background work and forget it.
 *
 * detached + unref + stdio to a file (or /dev/null) is the whole contract: this process must be
 * free to exit immediately, and the child must survive it. A child that inherited a pipe would
 * hold the event loop open; one that inherited stderr would print into the session transcript.
 *
 * Returns the child pid, or null. The pid is what a caller writes into its lock file.
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
    // spawn() reports a missing binary ASYNCHRONOUSLY, so the throw below never sees it and an
    // unhandled 'error' would take the hook down after it had already decided to succeed. It is
    // recorded rather than swallowed: by this point a pid has been returned and the caller has
    // written it into a lock and a 24h marker, so a child that dies moments later leaves state
    // behind that only this line explains. Same reason as the LOCK HANDOVER FAILED banner.
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

// The only unbounded appends in the system: semantic-index.log, distill.log and graphgen.log —
// numbers and retention policy in CLAUDE.md's logging section. Two doors write to them —
// `logBanner()` for semantic-index.log, `openLog()` handing the other two straight to a detached
// child — so both call trimLog() below; neither alone is enough.
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_KEEP_BYTES = 256 * 1024;

/**
 * Keep only the tail of an oversized log.
 *
 * The read is POSITIONED — one fs.readSync at `size - LOG_KEEP_BYTES` — so a log that has run away
 * to hundreds of MB never enters memory; readFileSync + slice would be the bug, not the fix.
 *
 * The retained tail starts mid-line, so everything up to the first newline is dropped: a truncated
 * first line reads as corrupt output rather than as a partial one, and the cost is at most one lost
 * line. (A tail with no newline at all keeps its partial line — a single runaway line is the one
 * case where dropping it would discard the whole tail.) The banner about to be appended follows
 * immediately, so the caller's own record of this run survives the trim.
 *
 * NOT ATOMIC, and deliberately not made so (2026-08-19, raised twice in review of #24).
 * `openLog()` hands detached children an `O_APPEND` fd that they hold for the whole run — minutes,
 * for a headless `claude`. Two hooks can therefore be writing while a third trims, and anything
 * appended between the `readSync` and the `writeFileSync` below is overwritten. That window is
 * microseconds, fires only past 1 MB, and costs debug-log lines.
 *
 * The obvious fix — write a temp file and `rename()` — is strictly worse HERE. Truncating in place
 * keeps the inode, so every held `O_APPEND` fd goes on landing in the file a reader opens; the loss
 * is bounded by that one window. A rename leaves those fds pointing at an unlinked inode, so every
 * child holding one writes the rest of its output into a file nothing can open — seconds of racy
 * overlap traded for minutes of silently discarded output. Atomicity is the wrong property to buy
 * when the writers outlive the swap.
 *
 * Best effort throughout, like everything else here: a log we cannot trim is a log that keeps
 * growing, never a hook that fails.
 *
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
 * Append one record to a daily-dated log family under `$CLAUDE_MEMORY_HOME/logs/`.
 *
 * The record is stamped with an ISO timestamp and the project slug and written verbatim after
 * them, so a caller controls every field and their order. `slug` is the scoping key: the logs are
 * MACHINE-WIDE — every project appends to the same daily file — and a reader that ignored it would
 * report one project's numbers against another's (measured for recall, 5 slugs in one 7-file
 * window).
 *
 * An unresolvable key logs `null` rather than throwing or guessing; `projectKey` memoises per
 * process, so a caller that already resolved it pays nothing here.
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
    // ONE ATOMIC CLAIM PER DAY, not a stamp anyone can read as stale. `wx` create-if-absent
    // semantics and the fail-closed reasoning are in CLAUDE.md's retention section; the sweep of
    // the two weaker guards it replaced (a herd measured both ways) is
    // docs/decisions/2026-08-21-log-retention-day-claim.md.
    //
    // Claim taken BEFORE the pass: a process killed mid-pass leaves the rest of the backlog
    // until tomorrow — bounded, and the alternative is a lock this path must not wait on.
    const day = t.slice(0, 10);
    /** @type {number | undefined} */
    let pruned;
    if (claimDay(dir, day)) {
      pruned = pruneDatedLogs(new Date(t)).length;
    }
    // Deleting is work, so it logs itself — on the line the caller was already writing, AFTER the
    // caller's own fields, because their order is a contract this must not reach into. Omitted
    // when nothing was deleted, never zero, like the cost fields. `/memory:doctor --hooks` sums it
    // over the window, so the deletion is visible where the logs it deleted are read.
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
 *
 * DELETES, where the vault's log prune only ever moves. These are machine-local debug lines that
 * no release replaces and nothing else reads — the same class of file `trimLog()` already
 * truncates in place. An Archive/ here would be the unbounded directory again under another name.
 *
 * The date comes from the FILENAME, and the cutoff is built in UTC by the SAME producer that
 * writes those names — `toISOString()`. The vault pruner's `cutoffDate()` was used here first and
 * was wrong for it: that one is local by design (vault note filenames are local-dated), and these
 * names are UTC. East of Greenwich, between local and UTC midnight, the two disagree by a day —
 * measured 2026-08-21, `TZ=Pacific/Kiritimati` with a retention of 0 deleted the file the OTHER
 * family was appending to, on every single append, because the guard below never held either.
 * Sharing the comparison was worth less than sharing the clock.
 *
 * First run after a long gap is the slow one and it is synchronous inside a hook: measured
 * 2026-08-21, macOS/APFS, 150 ms to unlink 1095 stale files and 882 ms for 4686, against the 10 s
 * timeout `hooks.json` declares for the hooks that append. Steady state is free — 300 appends into
 * an already-pruned directory ran at 5.96 ms each here against 6.51 ms on `main`, i.e. inside the
 * noise of `appendFileSync` itself.
 * ponytail: uncapped. Cap the pass at N unlinks and let the next day finish it if a machine ever
 * arrives with a backlog big enough to be felt.
 *
 * Best effort, like everything on this path: a file we cannot unlink is one that stays.
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
    // Date arithmetic, not `now - days * 86400`: only the day count is meaningful here, and UTC
    // days are all the same length anyway. An out-of-range `days` makes an Invalid Date, whose
    // `toISOString()` THROWS — caught below, so the failure keeps every file rather than ranking
    // them against a `NaN-NaN-NaN` string that sorts above every real date and deletes the lot.
    // (That is not hypothetical: it is what `cutoffDate()`'s own comment records costing it.)
    const cutoff = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days),
    )
      .toISOString()
      .slice(0, 10);
    const today = now.toISOString().slice(0, 10);
    for (const name of fs.readdirSync(dir)) {
      // Anchored on the two families BY NAME. An `[a-z-]+` prefix was not the same thing: it
      // matched `backup-2026-01-01.jsonl` and `my-notes-export-2026-01-01.jsonl` and unlinked
      // both without trace (measured 2026-08-21). This directory is machine-local and a human
      // may well have put something in it; only what we write is ours to delete.
      // Yesterday's day-claim goes with yesterday's logs — the pass that this marker authorised
      // is the pass that cleans it up, so the directory does not accumulate one dotfile per day
      // in the name of not accumulating one log file per day.
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
 * The closed set of hook outcomes.
 *
 * The point of the set is that a hook which did nothing is DISTINGUISHABLE from one that ran —
 * hooks are best-effort and degrade silently by design, so a permanently dead hook and a healthy
 * one look identical from outside. `spawned` is a gate line only: it says the work was handed to a
 * detached child, whose own line arrives later under the same session id.
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
 * One line per hook invocation.
 *
 * `extra` is one generic slot rather than a named parameter per measurement. Everything through it
 * is OPTIONAL and omitted when not measured — never written as zero — because a reader must be able
 * to tell "this hook injected nothing" from "nobody was counting yet", and log files predating each
 * field stay in the window for a week.
 *
 * `ms` is `performance.now()`, which is measured from PROCESS START and not from the top of the
 * hook — the same reasoning recall's own line documents. A hook's timeout in `hooks.json` applies
 * to the whole process, so node's startup and the entry's static import graph have to be inside
 * the number for a near-miss to mean anything.
 *
 * @param {HookLogInput} input
 */
export function logHook({ hook, event = '', cwd, session, outcome, reason, extra }) {
  // The heavy hooks spawn a headless `claude`, which fires SessionStart and runs FOUR of these
  // hooks again (their `*_CHILD` guards suppress only their OWN hook). Marked rather than
  // suppressed: what a hook costs inside a background run is a real number, just not the same
  // number as a user session's.
  const child = Boolean(process.env.CLAUDE_DISTILL_CHILD || process.env.CBM_GRAPHGEN_CHILD);
  appendJsonl('hooks', cwd, {
    // `extra` FIRST, so the named fields below always win. Spread last, a caller could overwrite
    // `outcome`, `ms`, `session` or `hook` — the four the reader groups, filters and judges by —
    // and the log would be corrupt in exactly the way nothing downstream could detect.
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
