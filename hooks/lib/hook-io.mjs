// Shared plumbing for the hooks that are GATES: read a JSON payload on stdin, decide cheaply,
// then detach the real work and exit.
//
// This module exists because three hooks were three bash scripts that had each grown their own
// copy of the same four things — stdin parsing, a timestamp debounce marker, locating the `claude`
// CLI, and detaching a child. The copies had already drifted: graph-staleness-check.sh probed four
// candidate `claude` paths in shell while distill-session.mjs probed the same four in Node, and
// nothing kept the lists in step.
//
// Everything here is either pure (and tested) or a three-line wrapper over one node: API. The
// split is deliberate: the decisions are pure functions the tests can drive with plain values, and
// the I/O is thin enough to read at a glance.

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

// The day-claim marker `logs/.retention-<day>`. Declared here because `claimDay()` writes it and
// `pruneDatedLogs()` sweeps yesterday's.
const CLAIM_PREFIX = '.retention-';

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
    fs.closeSync(fs.openSync(path.join(dir, `${CLAIM_PREFIX}${day}`), 'wx'));
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

// Exported since 2026-08-19: distill-session.mjs's reindex() called a bare `which` with no import —
// a ReferenceError that aborted every distillation run right after the notes were written, so
// ctx_search never got refreshed and the child exited non-zero. Nothing noticed because the hook
// detaches and its stderr goes to distill.log. It was introduced by #20 (ee6c49a, 2026-08-18),
// which deleted distill-session.mjs's own local copy of `which` without adding an import, and it
// never shipped: v0.3.1 still defines the local copy (`hooks/lib/distill-session.mjs:299` in that
// tag), and no release followed it. Unreleased `main` only — not a user-facing regression.
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
 * PATH first, then the three install locations a GUI-launched session may not have on PATH. One
 * list, because two lists drift and the failure is silent: the hook simply stops doing its job.
 */
export function findClaude() {
  for (const cand of [
    which('claude'),
    path.join(os.homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
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

// The only unbounded appends in the system: semantic-index.log, distill.log and graphgen.log grew
// forever, and nothing anywhere truncated them (2026-08-18). There are two doors into those files —
// `logBanner()` writes the banner for semantic-index.log, `openLog()` hands the other two straight
// to a detached child — so both call trimLog and neither alone is enough. 1 MB is roughly a year of
// banners plus child output at this repo's rates; keeping 256 KB leaves the last few dozen runs,
// which is all anyone reads a hook log for.
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

// ---------------------------------------------------------------- structured logs
//
// One appender, one shape, two families: `recall-<date>.jsonl` (what recall decided) and
// `hooks-<date>.jsonl` (what every hook did). Recall's copy was inline in its entry and was the
// only structured log in the system; this is that copy, moved, and the reason the second family
// costs eight lines instead of eighty.
//
// Dated filenames ARE the rotation. A size cap would be the second mechanism for the same job, and
// the recall logs have settled the question already: a day is the unit anyone reads these in.
// Retention is therefore also counted in days, by `pruneDatedLogs()` below, and runs from here on
// the first append of a new day — the whole `logs/` policy is those two mechanisms and no third.
//
// Nothing here is allowed to throw, and nothing here is allowed to be slow — every call sits on a
// path that must exit in milliseconds, and one of them is per-prompt.
//
// It is not free, and the number comes from `node scripts/bench-hooks.mjs -n 40 --notes 50` run
// before and after, not from a hand-timed loop — synthetic vault, local disk, macOS, 2026-08-20.
// Medians, ms: insights-surface 41.3 -> 42.8, memory-link-lint 41.9 -> 45.5,
// semantic-index-refresh 36.1 -> 39.7, graph-staleness-check 36.7 -> 40.3, validate-note
// 41.1 -> 43.0, distill-session gate 36.9 -> 38.7. So **+1.5 to +3.6 ms per hook**, against a 31.5
// ms bare-node floor.
//
// Two of those rows are the design being confirmed rather than measured. `memory-recall (inert)`
// moved 36.7 -> 35.7 — no line is written at all when recall is disarmed, which is the whole point
// of logging below the arming gate rather than above it. And `memory-recall (armed)` is flat at
// the median (70.3 vs 73.2 over 30 runs of that row alone) even though it now writes TWO lines,
// because it had already resolved `projectKey` and paid one append.
//
// The write is the cost in the ordinary case: `stateDir()`'s mkdir is 0.015 ms and `projectKey()`
// on an already-resolved cwd is 0.0002 ms.
//
// The exception is worth knowing, because it is NOT once per repo. `projectKey()` refuses to cache
// a checkout whose `.git` is a FILE — a worktree or a submodule — since it cannot cheaply validate
// the stamp (paths.mjs: `stamp = null // do not cache`). The in-process Map dies with the hook, so
// in those checkouts every call forks git: measured 14.6 ms in a worktree of this repo, 2026-08-21,
// on EVERY Write/Edit through validate-note, which never resolved a key before this change. The
// bench numbers above were taken in an ordinary clone and do not include it.
//
// ponytail: left uncached. Fixing it means resolving the `.git` file to the real config path and
// stamping THAT, which is a change to project identity — the one thing in this repo that must not
// wobble — and belongs in its own commit with its own test.

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
    // ONE ATOMIC CLAIM PER DAY, not a stamp anyone can read as stale.
    //
    // Three guards were tried here and the first two each had a herd. `!existsSync(today's file)`
    // is check-then-act across PROCESSES — logs/ is machine-wide, five SessionStart hooks fire at
    // once, and each family has its own file: measured 2026-08-21, NINE of nine concurrent hooks
    // each ran a full pass. A read-then-write date stamp took the median to one but left a window
    // (up to eight of nine in 15 trials) and, worse, INVERTED when the stamp could not be written:
    // read never returned today, so every append pruned — 20 of 20, 146 ms each, forever.
    //
    // Measured after the change, 15 trials of nine concurrent hooks over a 300-file backlog:
    // EXACTLY ONE pass every trial, and zero passes when logs/ is read-only.
    //
    // `wx` has neither failure. The create either succeeds for exactly one process or throws
    // EEXIST, and a claim that cannot be created at all (read-only logs/, EACCES) means we do not
    // prune — which is right, because the unlinks would fail for the same reason. Fail-closed here
    // is a directory that keeps growing; fail-open was a full readdir on every prompt.
    //
    // The claim is taken BEFORE the pass, so a process killed mid-pass leaves the rest of the
    // backlog until tomorrow. Bounded, and the alternative is a lock this path must not wait on.
    const day = t.slice(0, 10);
    /** @type {number | undefined} */
    let pruned;
    if (claimDay(dir, day)) {
      const n = pruneDatedLogs(new Date(t)).length;
      if (n > 0) pruned = n;
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

/**
 * The dated JSONL families, and the only basenames retention may delete. A constant rather than a
 * pattern for the same reason `REASONS` is one: a literal here and a caller passing `family` are
 * two lists that drift, and this one decides what gets unlinked. `scripts/doctor.sh` names the same
 * two in a `sed -E`, because a shell cannot import a constant — keep them in step; a wildcard there
 * read a stray file as ours and reported retention as eight years overdue (2026-08-21).
 */
const LOG_FAMILIES = /** @type {const} */ (['recall', 'hooks']);
const DATED_LOG = new RegExp(`^(${LOG_FAMILIES.join('|')})-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);

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
      if (name.startsWith(CLAIM_PREFIX)) {
        if (name.slice(CLAIM_PREFIX.length) >= today) continue;
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
  // The heavy hooks spawn a headless `claude`, which fires SessionStart and so runs FOUR of these
  // hooks again, plus validate-note per write it makes. Their `*_CHILD` guards suppress only their
  // own hook, so without this flag a distillation's four extra lines are indistinguishable from a
  // user session's — inflating counts and skewing percentiles with a run whose vault state and
  // cache warmth are nothing like a real session's. Marked rather than suppressed: what a hook
  // costs inside a background run is a real number, it is just not the same number.
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
