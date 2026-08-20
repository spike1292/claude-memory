// Tests for scripts/lib/recall-stats.mjs. Run: node --test scripts/lib/recall-stats.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_DAYS,
  logFiles,
  readLines,
  percentile,
  injectedNotes,
  summarize,
  render,
  report,
} from './recall-stats.mjs';

/** @param {readonly Record<string, unknown>[]} rows @returns {string} */
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** @type {string[]} */
const tmpDirs = [];
test.after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** @param {string} prefix @returns {string} */
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** @param {Record<string, string>} files @returns {string} */
function tmpLogs(files) {
  const dir = tmpDir('recall-stats-');
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

// The window is the last N FILES, not the last N days elapsed, so nothing here reads the clock and
// a machine that was off for a month still reports its last week of use.
test('logFiles: dated recall files only, oldest first, windowed from the end', () => {
  const dir = tmpLogs({
    'recall-2026-08-01.jsonl': '',
    'recall-2026-08-02.jsonl': '',
    'recall-2026-08-03.jsonl': '',
    'recall-nope.jsonl': '',
    'distill-2026-08-03.jsonl': '',
    'recall-2026-08-03.jsonl.bak': '',
  });
  assert.deepEqual(
    logFiles(dir, 2).map((f) => path.basename(f)),
    ['recall-2026-08-02.jsonl', 'recall-2026-08-03.jsonl'],
  );
  assert.equal(logFiles(dir, DEFAULT_DAYS).length, 3, 'a window wider than the history is fine');
  assert.deepEqual(
    logFiles(path.join(dir, 'gone')),
    [],
    'a missing directory is empty, not a throw',
  );
});

// The file is appended to by a hook that can be killed mid-write, so a torn last line is expected
// rather than exceptional.
test('readLines: skips a torn line instead of throwing the whole report away', () => {
  const dir = tmpLogs({
    'recall-2026-08-01.jsonl': jsonl([{ abstained: false }]) + '{"abstained":fal',
  });
  assert.deepEqual(readLines(logFiles(dir)), [{ abstained: false }]);
});

test('percentile: nearest rank, and empty is null rather than 0', () => {
  assert.equal(percentile([], 50), null, 'a measured 0 and no measurement must not print alike');
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([4, 1, 3, 2], 50), 2);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

// The injected notes are a PREFIX of the candidate list, because renderLines walks it in order and
// stops. Anything else here would credit a note the reader never saw.
test('injectedNotes: the rendered prefix, and `top` for lines that predate `notes`', () => {
  assert.deepEqual(injectedNotes({ abstained: false, notes: ['a', 'b', 'c'], injected: 2 }), [
    'a',
    'b',
  ]);
  assert.deepEqual(injectedNotes({ abstained: true, notes: ['a'], injected: 0 }), []);
  assert.deepEqual(injectedNotes({ abstained: false, top: 'old' }), ['old'], 'pre-change line');
  assert.deepEqual(
    injectedNotes({ abstained: true, top: 'old' }),
    [],
    'an abstention injects none',
  );
});

const LINES = [
  { t: '2026-08-01T09:00:00Z', abstained: false, via: 'server', score: 0.7, ms: 60, injected: 2, k: 3, notes: ['a', 'b', 'c'] }, // prettier-ignore
  { t: '2026-08-01T09:01:00Z', abstained: true, via: 'server', reason: 'low confidence (semantic)', score: 0.4, ms: 80 }, // prettier-ignore
  { t: '2026-08-01T09:02:00Z', abstained: false, score: 12.5, ms: 20, injected: 1, k: 1, notes: ['a'] }, // prettier-ignore
  { t: '2026-08-01T09:03:00Z', abstained: true, reason: 'low confidence', score: 3.1, ms: 25 },
];

test('summarize: rates, arms, reasons, injected counts and the trimmed renders', () => {
  const s = summarize(LINES, ['a', 'b', 'c', 'd']);
  assert.equal(s.decisions, 4);
  assert.equal(s.injected, 2);
  assert.equal(s.abstained, 2);
  assert.equal(s.untimed, 0);
  assert.equal(s.trimmed, 1, 'the first line offered 3 candidates and injected 2');
  assert.deepEqual(
    s.arms.map(([name, a]) => [name, a.decisions, a.injected]),
    [
      ['server', 2, 1],
      ['keyword', 2, 1],
    ],
    'the ABSENCE of `via` is the BM25 fallback — a contract of the log format',
  );
  assert.deepEqual(s.reasons, [
    ['low confidence (semantic)', 1],
    ['low confidence', 1],
  ]);
  assert.deepEqual(s.top, [
    ['a', 2],
    ['b', 1],
  ]);
  assert.deepEqual(
    s.never,
    ['c', 'd'],
    'c was a candidate but never rendered — that counts as never',
  );
  assert.equal(s.indexed, 4);
});

test('summarize: no index note set leaves never-injected unmeasured, not empty', () => {
  const s = summarize(LINES);
  assert.equal(s.never, null, 'an empty array here would claim every note has surfaced');
  assert.equal(s.indexed, null);
  assert.match(render(s), /never-injected notes: not measured/);
});

// Every metric is counted over the lines that HAVE the key. A missing `ms` is an unmeasured recall,
// not a fast one, and one old line must not drag a p50 to zero.
test('summarize: pre-change lines carry no ms and are reported as such, not as zero', () => {
  const old = { t: '2026-07-01T00:00:00Z', abstained: false, top: 'a', score: 9, injected: 1 };
  const s = summarize([...LINES, old], ['a']);
  assert.equal(s.untimed, 1);
  assert.equal(s.decisions, 5);
  const keyword = /** @type {[string, any]} */ (s.arms.find(([n]) => n === 'keyword'));
  assert.deepEqual(keyword[1].latencies, [20, 25], 'the untimed line contributes no latency');
  const body = render(s);
  assert.match(body, /1 of 5 decisions predate latency logging/);
  assert.doesNotMatch(body, /^\s*keyword\s+3\s+\S+\s+\S+\s+\S+\s+0\.0/m);
});

test('render: reports every metric the ticket asks for', () => {
  const body = render(summarize(LINES, ['a', 'b', 'c', 'd']));
  assert.match(body, /injected 2 \(50%\)\s+abstained 2 \(50%\)/);
  assert.match(body, /^server\s+2\s+1 \(50%\)\s+0\.40\s+0\.70\s+60\.0\s+80\.0$/m);
  assert.match(body, /^keyword\s+2\s+1 \(50%\)\s+3\.10\s+12\.50\s+20\.0\s+25\.0$/m);
  assert.match(body, /abstained by reason/);
  assert.match(body, /^1\s+low confidence$/m);
  assert.match(body, /^2\s+a$/m, 'most-injected notes');
  assert.match(body, /never injected: 2 of 4 indexed notes/);
});

test('render: no decisions is "not measured", never a page of zeroes', () => {
  assert.match(render(summarize([])), /^not measured:/);
});

// "Absent or empty logs are reported as not measured, not spawned into existence" — and the whole
// reader must be read-only, so running it twice leaves the directory byte-identical.
test('report: an empty state directory reports, writes nothing, and repeats itself', () => {
  const dir = tmpDir('recall-stats-empty-');
  const first = report({ logDir: path.join(dir, 'logs') });
  assert.match(first, /no recall logs in/);
  assert.deepEqual(fs.readdirSync(dir), [], 'the reader creates nothing — not even the log dir');
  assert.equal(report({ logDir: path.join(dir, 'logs') }), first);
});

test('report: names the files it read and indents its body under one heading', () => {
  const dir = tmpLogs({ 'recall-2026-08-01.jsonl': jsonl(LINES) });
  const out = report({ logDir: dir, days: 1, indexNotes: ['a', 'b', 'c', 'd'] });
  assert.match(out, /^\nrecall analytics\n/);
  assert.match(out, /recall-2026-08-01\.jsonl/);
  assert.ok(
    out
      .split('\n')
      .slice(2)
      .every((l) => l === '' || l.startsWith('  ')),
    'every body line is indented, and a blank line is never padded into trailing whitespace',
  );
});

// --- project scoping -------------------------------------------------------------------------
// One logs/ directory serves every project on the machine, and each line carries its slug. A 7-file
// window on this machine held 5 slugs, so an unscoped report measures one project's index against
// every project's retrievals.
const MIXED = [
  ...LINES.map((l) => ({ ...l, slug: 'mine' })),
  { t: '2026-08-01T09:04:00Z', slug: 'other', abstained: false, score: 30, ms: 5, injected: 1, k: 1, notes: ['zzz'] }, // prettier-ignore
  { t: '2026-08-01T09:05:00Z', slug: 'other', abstained: true, reason: 'low confidence', ms: 5 },
];

test('summarize: a slug scopes the window and says how much it dropped', () => {
  const s = summarize(MIXED, ['a', 'b', 'c', 'd'], 'mine');
  assert.equal(s.decisions, 4, "the other project's decisions are not this project's rate");
  assert.equal(s.otherProjects, 2);
  assert.equal(
    s.top.some(([n]) => n === 'zzz'),
    false,
    "another project's note must not appear in this project's most-injected list",
  );
  assert.match(render(s), /4 decisions for mine .* 2 more in this window belong to other projects/);
});

test('summarize: no slug keeps every project and says so', () => {
  const s = summarize(MIXED, null, null);
  assert.equal(s.decisions, 6);
  assert.equal(s.otherProjects, 0);
  assert.match(render(s), /every project on this machine/);
});

test('render: a window with no decisions for THIS project is not "no logs"', () => {
  const s = summarize(MIXED, ['a'], 'absent');
  assert.equal(s.decisions, 0);
  assert.match(render(s), /none of the 6 logged decisions in this window belong to absent/);
});

// An index that opens but holds no rows used to report "all 0 indexed notes have surfaced" — the
// opposite of the truth, from the one code path that exists to spot dead notes.
test('summarize: an empty index is unmeasured, not "everything surfaced"', () => {
  const s = summarize(LINES, []);
  assert.equal(s.never, null);
  assert.equal(s.indexed, null);
  assert.match(render(s), /never-injected notes: not measured/);
});

// The keyword arm renders with a trailing weak-hit floor that renderLines checks BEFORE the
// character budget, so `k > injected` there is not proof the budget bit. The line must not claim it.
test('render: the trimmed line names both causes, not just the budget', () => {
  const body = render(summarize(LINES, null));
  assert.match(body, /rendered fewer notes than the arm offered/);
  assert.match(body, /weak-hit floor/);
});

// The report prints vault note names, and the command body tells the reader to show doctor output
// verbatim. The warning must travel with the data.
test('report: the note lists carry their own do-not-paste warning', () => {
  const dir = tmpLogs({ 'recall-2026-08-01.jsonl': jsonl(LINES) });
  assert.match(report({ logDir: dir, indexNotes: ['a', 'b', 'c'] }), /come from your vault/);
});

// The entry writes this one before either arm exists — no socket, no BM25. Charged to the keyword
// bucket it made the fallback look fast and useless, and on an install whose index moved that would
// be every keyword row.
test("summarize: a 'no index' abstain is its own arm, not the BM25 fallback", () => {
  const s = summarize([
    {
      t: '2026-08-01T09:00:00Z',
      abstained: true,
      reason: 'no index at semantic-x-bge-m3.db',
      ms: 2,
    },
    { t: '2026-08-01T09:01:00Z', abstained: true, reason: 'low confidence', score: 3, ms: 40 },
  ]);
  assert.deepEqual(
    s.arms.map(([n, a]) => [n, a.decisions]),
    [
      ['(no index)', 1],
      ['keyword', 1],
    ],
  );
  const keyword = /** @type {[string, any]} */ (s.arms.find(([n]) => n === 'keyword'));
  assert.deepEqual(keyword[1].latencies, [40], 'the 2 ms short-circuit is not a BM25 timing');
});

// The never-injected list is the one output this feature exists for, and a line older than `notes`
// names only its top hit — so up to three notes it really did inject look never-injected. The
// report has to say so while such lines are still in the window.
test('render: pre-change injections make the never-injected list an upper bound, and it says so', () => {
  const s = summarize(
    [
      { t: '2026-08-01T09:00:00Z', abstained: false, top: 'a', score: 9, injected: 3 },
      { t: '2026-08-01T09:01:00Z', abstained: false, score: 9, injected: 1, k: 1, notes: ['b'] },
    ],
    ['a', 'b', 'c'],
  );
  assert.equal(s.unlisted, 1);
  const body = render(s);
  assert.match(body, /1 of 2 injections predate candidate logging/);
  assert.match(body, /UPPER BOUND/);
});

// A readable index holding nothing and no index at all need different actions from the reader.
test('render: an empty index is diagnosed as empty, not as unreadable', () => {
  assert.match(render(summarize(LINES, [])), /has an index and it holds no notes/);
  assert.match(render(summarize(LINES, null)), /no readable index for this project/);
});

// A warning that fires where it does not apply is the one that gets ignored where it does.
test('report: no note names printed means no do-not-paste warning', () => {
  const dir = tmpLogs({});
  assert.doesNotMatch(report({ logDir: dir }), /come from your vault/);
});
