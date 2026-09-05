// Archive session logs older than N days into <logs-dir>/Archive/. Ported from prune-logs.sh
// (backlog #9); the port rationale and the five review-found defects fixed in it are in
// CHANGELOG.md's 0.4.0 entry.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ moved: string[], skipped: string[], collisions: string[] }} PruneResult
 * @typedef {Error & { partial?: PruneResult }} PrunePartialError
 */

/**
 * The date encoded in a log filename, as `YYYY-MM-DD`, or null when there is none.
 * The round-trip is the validation: `2026-02-31` matches the pattern but is not a real date.
 * @param {string} basename
 * @returns {string | null}
 */
export function logDate(basename) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(basename);
  if (!m) return null;
  const [, y, mo, d] = m;
  // Local, not UTC — toISOString() would shift the day (CLAUDE.md's porting-traps convention).
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  return dt.getFullYear() === Number(y) &&
    dt.getMonth() === Number(mo) - 1 &&
    dt.getDate() === Number(d)
    ? m[0]
    : null;
}

// Year padded to 4 digits — unpadded, the lexical YYYY-MM-DD compare breaks past a three-digit
// PRUNE_DAYS (CHANGELOG.md 0.4.0).
/** @type {(dt: Date) => string} */
const iso = (dt) =>
  `${String(dt.getFullYear()).padStart(4, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

/**
 * `PRUNE_DAYS` as a whole number of days, or NaN when it is not one (empty/unset defaults to 90).
 * Digits only — `Number()` accepts far too much for a human-typed value (CHANGELOG.md 0.4.0).
 * @param {unknown} raw
 * @returns {number}
 */
export function parseDays(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return 90;
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

/**
 * The oldest date that is kept, as `YYYY-MM-DD`. Strictly older is archived.
 * Date arithmetic, not `now - days * 86400`, so a DST change cannot move the boundary a day.
 * @param {Date} now
 * @param {number} days
 * @returns {string}
 */
export function cutoffDate(now, days) {
  // Re-checked here, not only by the caller — every path to a deletion-shaped move goes through
  // this (CHANGELOG.md 0.4.0).
  if (!Number.isInteger(days) || days < 0)
    throw new RangeError(`days must be a non-negative whole number of days, got: ${days}`);
  const c = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  if (Number.isNaN(c.getTime())) throw new RangeError(`days is too large to be a date: ${days}`);
  return iso(c);
}

/**
 * Move every `YYYY-MM-DD-*.md` older than the cutoff into `<dir>/Archive/`.
 * Returns { moved, skipped, collisions }: `skipped` are names with no parseable date,
 * `collisions` are files whose archive destination already exists.
 * @param {string} dir
 * @param {{ days?: number, now?: Date }} [options]
 * @returns {PruneResult}
 */
export function pruneLogs(dir, { days = 90, now = new Date() } = {}) {
  const cutoff = cutoffDate(now, days);
  const archive = path.join(dir, 'Archive');
  /** @type {PruneResult} */
  const result = { moved: [], skipped: [], collisions: [] };

  // !isDirectory(), not isFile() — isFile() is lstat-based and drops a symlinked log silently
  // (CHANGELOG.md 0.4.0).
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.isDirectory() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();

  try {
    for (const name of entries) {
      const date = logDate(name);
      if (!date) {
        result.skipped.push(name);
        continue;
      }
      if (date >= cutoff) continue; // lexical compare is chronological for YYYY-MM-DD
      const dest = path.join(archive, name);
      // lstat, not existsSync — existsSync follows a link, so a dangling one at dest read as free
      // space (CHANGELOG.md 0.4.0). A collision leaves both copies alone and is reported.
      if (fs.lstatSync(dest, { throwIfNoEntry: false })) {
        result.collisions.push(name);
        continue;
      }
      // Created lazily: a prune that moves nothing leaves no empty Archive/ behind.
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(path.join(dir, name), dest);
      result.moved.push(name);
    }
  } catch (err) {
    // Partial result rides on the error, so a rename failing part-way still reports what moved.
    /** @type {PrunePartialError} */ (err).partial = result;
    throw err;
  }
  return result;
}
