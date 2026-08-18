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

const which = (cmd) => {
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
 */
function openLog(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
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
    child.unref();
    return true;
  } catch {
    return false; // a hook never fails because its background work could not start
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

/** Timestamped log banner, so one log file can be read as a sequence of runs. */
export function logBanner(file, label, iso) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
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
