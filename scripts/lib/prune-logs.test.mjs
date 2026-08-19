import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { logDate, cutoffDate, parseDays, pruneLogs } from './prune-logs.mjs';

// This module moves files inside the vault. Every test here is about what it leaves alone.
const NOW = new Date(2026, 7, 19, 15, 30); // 2026-08-19 local; 90d back is 2026-05-21

// Cleaned up at the end, not left behind: the loops below make several worlds per test and
// this file leaked 166 `prune-logs-*` directories into $TMPDIR per run before the hook was
// added (measured 2026-08-19). `after`, not `t.after`, so the chmod-0 case is undone once for
// the whole file rather than per test.
const worlds = [];
after(() => {
  for (const dir of worlds) {
    try {
      fs.chmodSync(dir, 0o755);
      fs.chmodSync(path.join(dir, 'Archive'), 0o755);
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function vault(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-logs-'));
  worlds.push(dir);
  for (const n of names) fs.writeFileSync(path.join(dir, n), `# ${n}\n`);
  return dir;
}

// Relative PATH plus content hash, not `e.name`: a Dirent's `name` is the bare basename, so a
// basename-only oracle cannot tell `Archive/x.md` from `x.md`, cannot see a file moved to the
// wrong subdirectory, and cannot see one truncated to zero bytes (checked 2026-08-19).
const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const full = path.join(e.parentPath, e.name);
      return `${path.relative(dir, full)}\t${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
    })
    .sort();

/** Just the content hashes — the oracle for "a move, never an unlink" across a path change. */
const hashes = (ls) => ls.map((l) => l.split('\t')[1]).sort();

test('the date comes from the filename, and a name that is not a real date is skipped', () => {
  assert.equal(logDate('2026-05-01-session.md'), '2026-05-01');
  assert.equal(logDate('2026-02-31-session.md'), null); // pattern, but not a calendar date
  assert.equal(logDate('2026-13-01-session.md'), null);
  assert.equal(logDate('notes.md'), null);
  assert.equal(logDate('session-2026-05-01.md'), null); // date must lead
});

test('the cutoff is date arithmetic in local time, not toISOString', () => {
  assert.equal(cutoffDate(NOW, 90), '2026-05-21');
  assert.equal(cutoffDate(new Date(2026, 0, 1, 0, 30), 1), '2025-12-31'); // 00:30 local stays Jan 1
  assert.equal(cutoffDate(new Date(2026, 0, 1, 23, 30), 1), '2025-12-31'); // and so does 23:30
});

test('exactly the files older than the cutoff move, and nothing is deleted', () => {
  const old = ['2026-01-02-a.md', '2026-05-20-b.md'];
  const kept = ['2026-05-21-c.md', '2026-08-18-d.md', '2026-12-01-future.md'];
  const dir = vault([...old, ...kept]);
  const before = walk(dir);

  const r = pruneLogs(dir, { days: 90, now: NOW });

  assert.deepEqual(r.moved, old);
  assert.deepEqual(
    fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.md'))
      .sort(),
    kept,
  );
  assert.deepEqual(fs.readdirSync(path.join(dir, 'Archive')).sort(), old);
  // Every byte that existed still exists, at some path: a move, never an unlink. A test that
  // only asserted the old ones left would also pass for a script that ate the recent ones.
  assert.deepEqual(hashes(walk(dir)), hashes(before));
});

test('the boundary is strict: the cutoff day itself is kept', () => {
  const dir = vault(['2026-05-21-on-cutoff.md']);
  assert.deepEqual(pruneLogs(dir, { days: 90, now: NOW }).moved, []);
});

test('an undated or non-.md file is reported and left in place', () => {
  const dir = vault(['notes.md', '2026-02-31-impossible.md', 'archive.txt']);
  fs.mkdirSync(path.join(dir, '2026-01-01-a-directory.md'));
  const before = walk(dir);

  const r = pruneLogs(dir, { days: 90, now: NOW });

  assert.deepEqual(r.moved, []);
  assert.deepEqual(r.skipped, ['2026-02-31-impossible.md', 'notes.md']);
  assert.deepEqual(walk(dir), before);
  assert.ok(fs.statSync(path.join(dir, '2026-01-01-a-directory.md')).isDirectory());
});

test('a name already present in Archive/ is left in place, never overwritten', () => {
  const dir = vault(['2026-01-02-a.md', '2026-01-03-b.md']);
  fs.mkdirSync(path.join(dir, 'Archive'));
  fs.writeFileSync(path.join(dir, 'Archive', '2026-01-02-a.md'), 'the archived copy\n');
  const before = walk(dir);

  const r = pruneLogs(dir, { days: 90, now: NOW });

  assert.deepEqual(r.collisions, ['2026-01-02-a.md']);
  assert.deepEqual(r.moved, ['2026-01-03-b.md']);
  assert.equal(
    fs.readFileSync(path.join(dir, 'Archive', '2026-01-02-a.md'), 'utf8'),
    'the archived copy\n',
  );
  assert.equal(fs.existsSync(path.join(dir, '2026-01-02-a.md')), true);
  assert.deepEqual(hashes(walk(dir)), hashes(before));
});

test('Archive/ is created only when something moves', () => {
  const dir = vault(['2026-08-18-recent.md']);
  pruneLogs(dir, { days: 90, now: NOW });
  assert.equal(fs.existsSync(path.join(dir, 'Archive')), false);
});

test('PRUNE_DAYS is parsed as digits or not at all', () => {
  // Lived in the entry until 2026-08-19, where `node --test` could not see it — and it is the
  // expression two of this port's defects were in. Unset and empty mean the shell's 90-day
  // default; everything else that is not a run of digits is NaN, which the entry rejects before
  // pruneLogs() is called at all.
  assert.equal(parseDays(undefined), 90);
  assert.equal(parseDays(''), 90);
  assert.equal(parseDays('  '), 90);
  assert.equal(parseDays('30'), 30);
  assert.equal(parseDays(' 30 '), 30);
  assert.equal(parseDays('0'), 0);
  for (const bad of ['1e9', '-5', '0.5', '30d', 'ninety', '0x10', '+7'])
    assert.ok(Number.isNaN(parseDays(bad)), `${bad} must not parse`);
});

test('a hostile PRUNE_DAYS throws instead of archiving the whole directory', () => {
  // The regression this pins: `cutoffDate(now, 1e9)` used to return the string 'NaN-NaN-NaN',
  // which loses `date >= cutoff` for every real date, so ASKING TO KEEP MORE archived
  // everything — today's and future-dated logs included. Measured 2026-08-19 against a synthetic
  // dir: `PRUNE_DAYS=1000000000` moved all four files, where the shell it replaced moved none.
  for (const bad of [1e9, 1e15, -5, 0.5, NaN]) {
    const dir = vault(['2026-01-02-a.md', '2026-08-19-today.md']);
    const before = walk(dir);
    assert.throws(() => pruneLogs(dir, { days: bad, now: NOW }), RangeError, `days=${bad}`);
    assert.deepEqual(walk(dir), before, `days=${bad} must move nothing`);
  }
  assert.equal(cutoffDate(NOW, 0), '2026-08-19'); // 0 is legitimate: keep only today
});

test('a cutoff before year 1000 keeps everything instead of archiving everything', () => {
  // A `days` large enough to be a plausible "keep it all" (375000d ~= 1027 years) is a VALID
  // Date, so it clears both of cutoffDate()'s guards and reaches the lexical keep-test. With an
  // unpadded year it returned '999-12-01' and '2026-01-02' >= '999-12-01' is false, so every
  // log moved while the entry printed a success line — measured 2026-08-19 against a synthetic
  // dir, where the shell version this replaces archived nothing. Only the padding stops it.
  assert.equal(cutoffDate(NOW, 375000), '0999-12-01');
  for (const days of [375000, 1e6, 1e7]) {
    const dir = vault(['2020-01-01-old.md', '2026-01-02-a.md', '2026-08-19-today.md']);
    const before = walk(dir);
    const r = pruneLogs(dir, { days, now: NOW });
    assert.deepEqual(r.moved, [], `days=${days} must move nothing`);
    assert.deepEqual(walk(dir), before, `days=${days} must leave the directory alone`);
  }
});

test('a symlinked log is archived, not silently invisible', () => {
  // `Dirent.isFile()` is lstat-based, so filtering on it dropped a symlinked log from BOTH the
  // moved and the skipped list — it was never archived and never reported (2026-08-19).
  const dir = vault(['2026-08-18-target.md']);
  fs.symlinkSync(path.join(dir, '2026-08-18-target.md'), path.join(dir, '2026-01-02-link.md'));

  const r = pruneLogs(dir, { days: 90, now: NOW });

  assert.deepEqual(r.moved, ['2026-01-02-link.md']);
  assert.ok(fs.lstatSync(path.join(dir, 'Archive', '2026-01-02-link.md')).isSymbolicLink());
});

test('a DANGLING symlink at the destination is a collision, not free space', () => {
  // `fs.existsSync(dest)` follows the link, so a broken link read as absent and the rename
  // destroyed it. The collision guard is the never-overwrite boundary, so it must be lstat-blind
  // to nothing (2026-08-19).
  const dir = vault(['2026-01-02-a.md']);
  fs.mkdirSync(path.join(dir, 'Archive'));
  fs.symlinkSync('/nonexistent/gone.md', path.join(dir, 'Archive', '2026-01-02-a.md'));

  const r = pruneLogs(dir, { days: 90, now: NOW });

  assert.deepEqual(r.collisions, ['2026-01-02-a.md']);
  assert.deepEqual(r.moved, []);
  assert.ok(fs.lstatSync(path.join(dir, 'Archive', '2026-01-02-a.md')).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(dir, '2026-01-02-a.md')), true);
});

test('a failure part-way through still reports what already moved', () => {
  // Without this the entry cannot honour "moving only, reversible": reversing a move requires
  // knowing which files moved, and a bare throw discards the whole result object. Reproduced
  // 2026-08-19 with a read-only Archive/ and with `Archive` existing as a regular file.
  const dir = vault(['2026-01-02-a.md', '2026-01-03-b.md']);
  fs.mkdirSync(path.join(dir, 'Archive'));
  fs.renameSync(path.join(dir, '2026-01-02-a.md'), path.join(dir, 'Archive', '2026-01-02-a.md'));
  fs.writeFileSync(path.join(dir, '2026-01-02-a.md'), 'a clashing copy\n'); // collision, not fatal
  fs.chmodSync(path.join(dir, 'Archive'), 0o555);
  try {
    let err;
    try {
      pruneLogs(dir, { days: 90, now: NOW });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'a read-only Archive/ must fail loudly');
    assert.ok(err.partial, 'the partial result must ride on the error');
    assert.deepEqual(err.partial.collisions, ['2026-01-02-a.md']);
  } finally {
    fs.chmodSync(path.join(dir, 'Archive'), 0o755);
  }
});
