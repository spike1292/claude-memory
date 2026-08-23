// Tests for scripts/lib/memory-eval.mjs. Run: node --test scripts/lib/memory-eval.test.mjs
import test from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  titleTokens,
  evalBody,
  pickSentence,
  metrics,
  lexicalRank,
  goldCoverage,
  defaultCasesPath,
  GOLD_FLOOR,
} from './memory-eval.mjs';

test('titleTokens drops short tokens', () => {
  // 'cap' is 3 chars and drops out — short tokens are noise, not identity
  assert.deepEqual([...titleTokens('2026-08-14-cap-concurrency-with-literal')].sort(), [
    'concurrency',
    'literal',
    'with',
  ]);
});

test('evalBody strips the alias line and headings', () => {
  const raw =
    '---\nname: x\n---\n## Head\nThe runner fleet gains vCPU without gaining RAM, so a percentage silently re-tunes upward.\n\n_Also asked as: should I use parallel 2, why fixed numbers._\n';
  const b = evalBody(raw);
  assert.ok(
    !b.includes('Also asked as'),
    'alias line must never seed a question — it is a list of queries we wrote to match',
  );
  assert.ok(!b.includes('## Head'));
  assert.ok(b.includes('runner fleet'));
  const s = pickSentence(b, 'runner-fleet-vcpu', 'semantic');
  assert.ok(s && s.length >= 40);
});

test('metrics compute recall@k and MRR', () => {
  const m = metrics([{ rank: 1 }, { rank: 3 }, { rank: 0 }, { rank: 7 }]);
  assert.equal(m.recall[1], 0.25);
  assert.equal(m.recall[3], 0.5);
  assert.equal(m.recall[10], 0.75);
  assert.ok(Math.abs(m.mrr - (1 + 1 / 3 + 0 + 1 / 7) / 4) < 1e-9);
});

// These two pin the ways the old inlined tokeniser differed from lexTokens. It had neither
// property, so both assertions failed before 2026-08-19 — that is why they are worth their lines.
test('lexicalRank scores through the shared tokeniser, so stopwords carry no signal', () => {
  const docs = [
    { note: 'a', text: 'the cutover window was short' },
    { note: 'b', text: 'the runner fleet gained vCPU' },
  ];
  const [{ results }] = lexicalRank(docs, ['the was and of it'], 5);
  assert.deepEqual(
    results.map((r) => r.score),
    [0, 0],
    'a query of nothing but stopwords must match nothing',
  );
});

test('lexicalRank de-duplicates query terms', () => {
  const docs = [
    { note: 'a', text: 'cutover cutover rehearsal' },
    { note: 'b', text: 'unrelated prose about caching' },
  ];
  const once = lexicalRank(docs, ['cutover'], 5)[0].results[0];
  const twice = lexicalRank(docs, ['cutover cutover'], 5)[0].results[0];
  assert.equal(twice.note, once.note);
  assert.equal(
    twice.score,
    once.score,
    'repeating a word in the prompt must not double its weight',
  );
});

test('lexicalRank ranks the matching note first and honours k', () => {
  const docs = [
    { note: 'a', text: 'nothing relevant here at all' },
    { note: 'b', text: 'stale html survives a release because the CDN caches it' },
    { note: 'c', text: 'more unrelated prose' },
  ];
  const [{ results }] = lexicalRank(docs, ['stale html after a release'], 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].note, 'b');
});

// The three bands of goldCoverage. Zero-of-N is a mismatched corpus, not a bad retrieval score;
// scoring one anyway reported another project's case set as this project's recall (#97).
test('goldCoverage: every gold note present is ok', () => {
  const cov = goldCoverage([{ gold: ['a'] }, { gold: ['b', 'c'] }], new Set(['a', 'b', 'c']));
  assert.deepEqual(cov, { total: 3, resolved: 3, fraction: 1, verdict: 'ok' });
});

test('goldCoverage: a few missing gold notes are churn, not a mismatch', () => {
  const cov = goldCoverage(
    [{ gold: ['a', 'b', 'c'] }, { gold: ['pruned'] }],
    new Set(['a', 'b', 'c']),
  );
  assert.equal(cov.verdict, 'churn', 'a gold note lost to a prune must warn, never abort');
  assert.equal(cov.resolved, 3);
  assert.equal(cov.total, 4);
});

test("goldCoverage: another vault's case set is a mismatch", () => {
  const cov = goldCoverage([{ gold: ['x'] }, { gold: ['y', 'z'] }], new Set(['a', 'b', 'c']));
  assert.equal(cov.verdict, 'mismatch');
  assert.equal(cov.resolved, 0);
  assert.equal(cov.fraction, 0);
});

test('goldCoverage: the floor is inclusive, so exactly GOLD_FLOOR is churn', () => {
  assert.equal(GOLD_FLOOR, 0.5);
  const at = goldCoverage([{ gold: ['a', 'b', 'x', 'y'] }], new Set(['a', 'b']));
  assert.equal(at.fraction, 0.5);
  assert.equal(at.verdict, 'churn');
  const below = goldCoverage([{ gold: ['a', 'x', 'y', 'z'] }], new Set(['a', 'b']));
  assert.equal(below.fraction, 0.25);
  assert.equal(below.verdict, 'mismatch');
});

test('goldCoverage: a case set with no gold refs at all is a mismatch, not a pass', () => {
  const cov = goldCoverage([], new Set(['a']));
  assert.equal(cov.total, 0);
  assert.equal(cov.verdict, 'mismatch', 'an empty set must not divide to a passing 1');
});

test('goldCoverage: a case line with no usable gold contributes nothing to the count', () => {
  // `flatMap` on a missing key yields `undefined`, which counted as one unresolvable ref — so a
  // malformed file reported as another vault's instead of reaching the "no gold notes at all"
  // branch written for it.
  const cov = goldCoverage([{}, { gold: null }, { gold: 'not-an-array' }], new Set(['a']));
  assert.equal(cov.total, 0);
  assert.equal(cov.verdict, 'mismatch');
});

test('goldCoverage: a gold note named twice counts once per reference', () => {
  const cov = goldCoverage([{ gold: ['a'] }, { gold: ['a'] }], new Set(['a']));
  assert.equal(cov.total, 2);
  assert.equal(cov.resolved, 2);
  assert.equal(cov.verdict, 'ok');
});

// ---------------------------------------------------------------- the CLI round trip
//
// goldCoverage being right proves nothing if the entry never calls it, and the entry resolving the
// scoped default proves nothing if a stale --cases in the command doc overrides it. Both ends, or
// neither: two tests pinning one end each stay green while the ends drift.
//
// Every one of these exits BEFORE retrieval, so none loads a model or an index.

const ENTRY = fileURLToPath(new URL('../memory-eval.mjs', import.meta.url));
const SLUG = 'eval-guard-test';

/** @type {string[]} */
const tmpDirs = [];
test.after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A throwaway vault + state dir, isolated from the real ones. Notes are named, not generated:
 * these tests care only about which gold names resolve.
 * @param {readonly string[]} notes
 * @param {readonly {q: string, gold?: string[]}[] | null} cases  null writes no file at all
 */
function scratch(notes, cases) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eval-guard-')));
  tmpDirs.push(tmp);
  const vault = path.join(tmp, 'vault');
  const notesDir = path.join(vault, 'Memory', SLUG);
  fs.mkdirSync(notesDir, { recursive: true });
  for (const n of notes) fs.writeFileSync(path.join(notesDir, `${n}.md`), `# ${n}\n`);
  const evalDir = path.join(tmp, 'state', 'eval');
  fs.mkdirSync(evalDir, { recursive: true });
  // Through the resolver, not a hand-written copy: the whole bug was a second copy of this path
  // drifting from where the script looks.
  const scopedPath = defaultCasesPath(evalDir, SLUG, 'semantic');
  const casesPath = path.join(tmp, 'cases.jsonl');
  if (cases) fs.writeFileSync(casesPath, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
  // Built, never spread: an inherited CLAUDE_VAULT would point the child at the real vault. This is
  // the isolation.
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(tmp, 'home'),
    CLAUDE_MEMORY_HOME: path.join(tmp, 'state'),
  };
  /** @param {...string} args */
  const run = (...args) =>
    spawnSync(process.execPath, [ENTRY, '--vault', vault, '--slug', SLUG, ...args], {
      encoding: 'utf8',
      env,
    });
  return { run, casesPath, scopedPath };
}

test('CLI --run refuses a case set built from another vault, and names no notes', () => {
  const { run, casesPath } = scratch(
    ['ours-one', 'ours-two'],
    [
      { q: 'a', gold: ['theirs-one'] },
      { q: 'b', gold: ['theirs-two', 'theirs-three'] },
    ],
  );
  const r = run('--run', '--cases', casesPath);
  assert.equal(r.status, 1, `a mismatched case set must exit non-zero:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /0\/3 gold notes/);
  assert.match(r.stdout, /DIFFERENT vault/);
  for (const leaked of ['theirs-one', 'theirs-two', 'theirs-three'])
    assert.ok(
      !(r.stdout + r.stderr).includes(leaked),
      `refusal leaked the gold note name "${leaked}" — it may belong to another project's private vault`,
    );
});

test('CLI --run warns but proceeds when a gold note was pruned', () => {
  const { run, casesPath } = scratch(
    ['ours-one', 'ours-two', 'ours-three'],
    [
      { q: 'a', gold: ['ours-one', 'ours-two', 'ours-three'] },
      { q: 'b', gold: ['pruned'] },
    ],
  );
  // --mode lexical scores in-process, so this one runs the whole way through without a model or an
  // index — which is what lets it assert the exit code, not just the warning.
  const r = run('--run', '--cases', casesPath, '--mode', 'lexical');
  assert.match(r.stderr, /warning: 1\/4 gold notes no longer exist/);
  assert.ok(
    !r.stdout.includes('DIFFERENT vault'),
    'ordinary churn must not be refused as a mismatch',
  );
  assert.equal(r.status, 0, `churn must score and exit clean:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /recall@/, 'it must actually report a number, not just warn');
});

test('CLI --run with no --cases resolves the slug-scoped default', () => {
  const { run, scopedPath } = scratch(['ours-one'], null);
  const r = run('--run');
  // No case set exists, so it stops at the "author one first" branch — which is exactly what
  // prints the path it resolved. That path is the whole fix: scoped by slug, and by style.
  assert.match(r.stdout, /no case set at/);
  assert.ok(r.stdout.includes(scopedPath), `default must be slug-scoped, got:\n${r.stdout}`);
});

test('CLI --run does not tell you to drop a --cases you never passed', () => {
  // The project's OWN scoped set, gone stale against a vault that moved. Advising "drop --cases"
  // here would name the flag the caller did not use and point at the file it just ran.
  const { run, scopedPath } = scratch(['ours-one'], null);
  fs.writeFileSync(scopedPath, JSON.stringify({ q: 'a', gold: ['long-gone'] }) + '\n');
  const r = run('--run');
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes('Drop --cases'), `got:\n${r.stdout}`);
  assert.match(r.stdout, /vault has moved out from under it/);
});

test('CLI --run treats an explicit --cases at the scoped path as no override', () => {
  // Passing --cases with the scoped path is not an override — both the refusal and the "no case set
  // at" branch hand you that path, so pasting it back must not answer "drop --cases" and name the
  // same file.
  const { run, scopedPath } = scratch(['ours-one'], null);
  fs.writeFileSync(scopedPath, JSON.stringify({ q: 'a', gold: ['long-gone'] }) + '\n');
  const r = run('--run', '--cases', scopedPath);
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes('Drop --cases'), `got:\n${r.stdout}`);
  assert.match(r.stdout, /vault has moved out from under it/);
});

test('CLI --run refuses a partly-truncated case set instead of crashing on it', () => {
  // Three good cases plus one gold-less line: coverage skips the bad line and passes as `ok`, then
  // the scorer dereferences `c.gold` and dies with a TypeError. Half a case set is not a number.
  const { run, casesPath } = scratch(
    ['ours-one'],
    [{ q: 'a', gold: ['ours-one'] }, { q: 'b', gold: ['ours-one'] }, { q: 'c' }],
  );
  const r = run('--run', '--cases', casesPath, '--mode', 'lexical');
  assert.equal(r.status, 1, `must refuse, not crash:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /1 of 3 case lines have no gold array/);
  assert.ok(!r.stderr.includes('TypeError'), `crashed instead of refusing:\n${r.stderr}`);
  assert.ok(!r.stdout.includes('recall@'));
});

test('CLI refuses --cases=X rather than silently scoring the default', () => {
  // val() reads `--flag value` and nothing rejected an unrecognised token, so the equals form was
  // dropped and the run scored the DEFAULT set — printing a number the operator would read as
  // belonging to the file they had just named. #97's failure, reached by a typo.
  const { run, casesPath, scopedPath } = scratch(['ours-one'], [{ q: 'a', gold: ['ours-one'] }]);
  fs.writeFileSync(scopedPath, JSON.stringify({ q: 'z', gold: ['ours-one'] }) + '\n');
  const r = run('--run', '--mode', 'lexical', `--cases=${casesPath}`);
  assert.equal(r.status, 1, `equals form must not score:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /--cases takes a space-separated value/);
  assert.ok(!r.stdout.includes('recall@'), 'it must not report a number for a set it never read');
});

test('CLI --run prints the case set beside the number it reports', () => {
  // Every failure in #97 is a figure attributed to a set nobody checked. A number printed beside
  // its source cannot be silently misread, whatever routed us to the wrong file.
  const { run, casesPath } = scratch(['ours-one'], [{ q: 'a', gold: ['ours-one'] }]);
  const r = run('--run', '--cases', casesPath, '--mode', 'lexical');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /recall@/);
  assert.ok(r.stdout.includes(casesPath), `summary must name its case set, got:\n${r.stdout}`);
});

test('CLI --run says the vault is empty rather than blaming the case set', () => {
  const { run, casesPath } = scratch([], [{ q: 'a', gold: ['anything'] }]);
  const r = run('--run', '--cases', casesPath, '--mode', 'lexical');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /nothing to score against/);
  assert.ok(
    !r.stdout.includes('DIFFERENT vault'),
    'an unsynced vault is not evidence about the case set',
  );
});

test('CLI --run names the override the caller actually used, including --out', () => {
  // --out overrides the case path too, so a branch keyed on "is CASES the scoped path" told an
  // --out caller to drop a --cases it never passed — round 1's fix reintroducing round 1's bug.
  const { run, casesPath } = scratch(['ours-one'], [{ q: 'a', gold: ['theirs'] }]);
  const r = run('--run', '--out', casesPath, '--mode', 'lexical');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Drop --out to use this project's own set/);
  assert.ok(!r.stdout.includes('Drop --cases'), `got:\n${r.stdout}`);
});

test("CLI --run calls an empty case set empty, not another vault's", () => {
  const { run, casesPath } = scratch(['ours-one'], []);
  const r = run('--run', '--cases', casesPath, '--mode', 'lexical');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /names no gold notes at all/);
  assert.ok(
    !r.stdout.includes('DIFFERENT vault'),
    'a truncated or half-written file is not a foreign one',
  );
});

// The doc end of the round trip. Everything above pins the SCRIPT; #97 was a defect in the COMMAND
// that overrode it, so re-adding `--cases` to commands/eval.md would reinstate the bug with every
// other test in this file green.
test('commands/eval.md runs the per-project eval without --cases', () => {
  const raw = fs.readFileSync(new URL('../../commands/eval.md', import.meta.url), 'utf8');
  // Join shell line-continuations FIRST, so a scan line is a whole logical command. Scanning raw
  // lines, `--run` on one line and `--cases` on the next passed this test while fully reinstating
  // #97 — a scan guard that reports clean because it looked at the wrong unit.
  const doc = raw.replace(/\\\r?\n\s*/g, ' ');
  // The per-project invocations are the memory-eval ones with no --vault: a --vault line is the
  // bench-vault walkthrough, where an explicit --cases is correct.
  const perProject = doc
    .split('\n')
    .filter((l) => l.includes('memory-eval.mjs') && l.includes('--run') && !l.includes('--vault'));
  // A scan guard that matches nothing passes for the wrong reason — this repo has been bitten by
  // exactly that, so assert the scan found the lines before asserting anything about them.
  assert.ok(
    perProject.length >= 2,
    `expected the per-project --run invocations in commands/eval.md, found ${perProject.length}`,
  );
  for (const line of perProject)
    assert.ok(
      !line.includes('--cases') && !line.includes('--out'),
      `commands/eval.md must let the slug-scoped default resolve, got: ${line.trim()}`,
    );
});

test('CLI --run is unchanged when every gold note resolves', () => {
  const { run, casesPath } = scratch(
    ['ours-one', 'ours-two'],
    [
      { q: 'a', gold: ['ours-one'] },
      { q: 'b', gold: ['ours-two'] },
    ],
  );
  const r = run('--run', '--cases', casesPath, '--mode', 'lexical');
  assert.equal(r.status, 0, `a matching case set must score cleanly:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /recall@/);
  assert.ok(!r.stderr.includes('warning:'), 'the ok band must say nothing at all');
  assert.ok(!r.stdout.includes('DIFFERENT vault'));
});
