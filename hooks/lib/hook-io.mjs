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
import { stateDir } from './paths.mjs';

/** Claude Code sends hook input as one JSON object on stdin. A hook must never die on bad input. */
export function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Parse a hook payload. Anything unparseable is an empty payload, never a throw. */
export function payload(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** The cwd a hook should act on. Claude Code always sends it; `process.cwd()` is the safety net. */
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
 */
export function markerPath(name) {
  return path.join(stateDir('cache'), `${name}.ts`);
}

export function readMarker(file) {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function writeMarker(file, seconds) {
  try {
    fs.writeFileSync(file, `${seconds}\n`);
  } catch {
    /* a marker we cannot write means we run again next session — never a reason to fail the hook */
  }
}

/**
 * Is a run still inside its debounce window?
 *
 * `last === 0` means no marker, which must NOT count as recent — the missing-marker case is the
 * first run, and suppressing it would mean the feature never fires at all.
 */
export function withinDebounce(last, windowSeconds, now) {
  return last > 0 && now - last < windowSeconds;
}

/** Whole seconds since the epoch — the unit every marker file is written in. */
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
 */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The pid holding `file`, or null when the lock is free, stale or unreadable. */
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

/** `wx` claims a lock that must not already exist; the default `w` hands an existing one over. */
export function writeLock(file, pid, seconds, flag = 'w') {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${pid} ${seconds}\n`, { flag });
    return true;
  } catch {
    return false; // a lock we cannot write degrades to the old behaviour: another run may start
  }
}

export function releaseLock(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone, or never ours */
  }
}

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
 */
export function takeLock(file, pid, seconds, maxSeconds, now = nowSeconds()) {
  const claim = () => writeLock(file, pid, seconds, 'wx');
  if (claim()) return true;

  const stale = inode(file);
  if (lockHolder(file, maxSeconds, now)) return false;
  if (stale === null || inode(file) !== stale) return false; // reclaimed by someone else already

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
    // unhandled 'error' would take the hook down after it had already decided to succeed.
    child.on('error', () => {});
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

/** Timestamped log banner, so one log file can be read as a sequence of runs. */
export function logBanner(file, label, iso) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    trimLog(file);
    fs.appendFileSync(file, `\n=== ${iso} ${label} ===\n`);
  } catch {
    /* best effort */
  }
}

/** Count lines the way `wc -l` does: newline bytes, no string allocation for a large transcript. */
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

/** A hook's one line of stdout: Claude Code renders `systemMessage` to the user. */
export function systemMessage(text) {
  return JSON.stringify({ systemMessage: text });
}
