// Archive session logs older than N days into <logs-dir>/Archive/. Ported from prune-logs.sh
// on 2026-08-19 (backlog #9): a per-file loop with per-file date parsing, which is what the
// fork-count rule sends to Node — and the shell version's date arm was unportable, `date -j -f`
// on this machine and `date -d` on CI, so the branch CI could run was never the branch that ran.
//
// Three rules the shell version established and this one keeps:
//   * DATES COME FROM THE FILENAME (`YYYY-MM-DD-*.md`), NEVER mtime — Synology sync rewrites
//     mtime without touching a byte, so mtime would archive notes that were never old.
//   * MOVE ONLY. Nothing here unlinks anything; an archive is reversible with `mv` back.
//   * A name that is not a real date is skipped, not guessed at.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ moved: string[], skipped: string[], collisions: string[] }} PruneResult
 * @typedef {Error & { partial?: PruneResult }} PrunePartialError
 */

/**
 * The date encoded in a log filename, as `YYYY-MM-DD`, or null when there is none.
 * The round-trip is the validation: `2026-02-31` is a pattern match but not a date, and BSD
 * `date -j -f` silently normalised it to 2026-03-03. Guessing at a malformed name is how a
 * note gets moved for the wrong reason, so it is skipped instead.
 *
 * @param {string} basename
 * @returns {string | null}
 */
export function logDate(basename) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(basename);
  if (!m) return null;
  const [, y, mo, d] = m;
  // Local, not UTC: `toISOString()` would shift the day for anyone east or west of Greenwich,
  // and these filenames are dates (CLAUDE.md records this exact trap from the python port).
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  return dt.getFullYear() === Number(y) &&
    dt.getMonth() === Number(mo) - 1 &&
    dt.getDate() === Number(d)
    ? m[0]
    : null;
}

// The YEAR is padded too, not just month and day. Every comparison in here is a LEXICAL
// compare of `YYYY-MM-DD` strings, which is only chronological while the years are the same
// width: `days = 375000` puts the cutoff in year 999, and unpadded `999-12-01` loses
// `'2026-…' >= cutoff` for every real date ('2' < '9'), so asking to keep a millennium of
// logs archived the whole directory while printing a success line — the same shape as the
// 'NaN-NaN-NaN' defect below, surviving both of its guards (measured 2026-08-19).
/** @type {(dt: Date) => string} */
const iso = (dt) =>
  `${String(dt.getFullYear()).padStart(4, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

/**
 * `PRUNE_DAYS` as a whole number of days, or NaN when it is not one. An empty/unset value is
 * the 90-day default the shell had.
 *
 * Here rather than in the entry because it is logic, and logic in an entry is logic `node --test`
 * cannot reach — two of the defects found reviewing this port were this one expression. Digits
 * only, because `Number()` is far too permissive for the one value a human types: measured
 * 2026-08-19, `PRUNE_DAYS=" "` cast to 0 and archived everything but today, and `PRUNE_DAYS=1e9`
 * passed a `Number.isFinite && >= 0` guard and archived the directory whole. Both printed a
 * cheerful `archived N log(s)`. `cutoffDate` re-checks the range and throws before moving anything.
 *
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
 * Date arithmetic, not `now - days * 86400`, so a DST change cannot move the boundary by a day.
 * This reproduces the BSD arm the shell used on this machine: `date -j -f "%Y-%m-%d"` fills the
 * unspecified time-of-day from *now*, so both sides of its comparison carried the same clock time
 * and it compared calendar days. (The GNU arm parsed midnight and so archived one day more —
 * that divergence is exactly what the port removes.)
 *
 * @param {Date} now
 * @param {number} days
 * @returns {string}
 */
export function cutoffDate(now, days) {
  // Validated HERE, not only in the entry, because the cutoff is what decides deletion-shaped
  // behaviour and every caller goes through it. Measured 2026-08-19: `days = 1e9` makes an
  // Invalid Date, `iso()` then returns the string 'NaN-NaN-NaN', and the keep-test
  // `date >= cutoff` is false for every real date because '2' (0x32) < 'N' (0x4E) — so asking to
  // keep MORE logs archived the whole directory, today's and future-dated files included. A
  // negative `days` put the cutoff in the future for the same effect. Both throw now, and both
  // throw before the loop moves anything.
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
 *
 * @param {string} dir
 * @param {{ days?: number, now?: Date }} [options]
 * @returns {PruneResult}
 */
export function pruneLogs(dir, { days = 90, now = new Date() } = {}) {
  const cutoff = cutoffDate(now, days);
  const archive = path.join(dir, 'Archive');
  /** @type {PruneResult} */
  const result = { moved: [], skipped: [], collisions: [] };

  // `!isDirectory()`, not `isFile()`: a Dirent is lstat-based, so `isFile()` drops a SYMLINKED
  // log — which is then never archived AND never reported, i.e. invisible rather than skipped
  // (measured 2026-08-19). The shell's `for f in "$dir"/*.md` moved it, and `renameSync` moves
  // the link itself just as `mv` did. Directories stay excluded, which the glob did not do.
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
      // Overwrite is data loss and there is no safe rename to invent, so a collision leaves BOTH
      // copies alone and is reported. The file stays in Logs/ and every later run says so again,
      // which is the point: it is a name clash a human has to look at, not a prune failure.
      // lstat, not `existsSync`: existsSync follows the link, so a DANGLING symlink at the
      // destination read as "free" and the rename silently replaced it (2026-08-19).
      if (fs.lstatSync(dest, { throwIfNoEntry: false })) {
        result.collisions.push(name);
        continue;
      }
      // Created lazily, where the shell ran `mkdir -p "$dir/Archive"` once before the loop: a
      // prune that moves nothing now leaves no trace at all, rather than an empty directory the
      // next reader has to interpret. Third deliberate difference from the shell version.
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(path.join(dir, name), dest);
      result.moved.push(name);
    }
  } catch (err) {
    // "Moving only, reversible" is only true if the human learns WHICH files moved, and a
    // rename can fail part-way through: EACCES on a read-only Archive/, EEXIST when `Archive`
    // is a regular file (both measured 2026-08-19). Throwing bare would strand files 1..N-1 as
    // unreported moves, so the partial result rides on the error for the entry to print.
    /** @type {PrunePartialError} */ (err).partial = result;
    throw err;
  }
  return result;
}
