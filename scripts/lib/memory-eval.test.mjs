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
  minePrompt,
  minePrompts,
  MINE_MIN,
  MINE_MAX,
  KIND,
  UNSCORABLE,
  unscorableReason,
  pairwise,
  gateFailures,
  casesHash,
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
  assert.deepEqual(cov, { total: 3, resolved: 3, verdict: 'ok' });
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
});

test('goldCoverage: the floor is inclusive, so exactly GOLD_FLOOR is churn', () => {
  assert.equal(GOLD_FLOOR, 0.5);
  const at = goldCoverage([{ gold: ['a', 'b', 'x', 'y'] }], new Set(['a', 'b']));
  assert.equal(at.total, 4);
  assert.equal(at.resolved, 2);
  assert.equal(at.verdict, 'churn');
  const below = goldCoverage([{ gold: ['a', 'x', 'y', 'z'] }], new Set(['a', 'b']));
  assert.equal(below.resolved, 1);
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
 * Both case fields are optional: several tests feed deliberately malformed lines.
 * @param {readonly {q?: unknown, gold?: unknown, owner?: string}[] | null} cases  null writes no file at all
 * @param {Record<string, string>} [bodies] per-note prose; the shared default ties every BM25 score,
 *   which is fine for the guards that exit before scoring and useless for one that asserts a RANK
 */
function scratch(notes, cases, bodies = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eval-guard-')));
  tmpDirs.push(tmp);
  const vault = path.join(tmp, 'vault');
  const notesDir = path.join(vault, 'Memory', SLUG);
  fs.mkdirSync(notesDir, { recursive: true });
  // Real prose, not just a title: --generate samples sentences of 40-220 chars, so title-only notes
  // would make it emit zero cases and a data-loss test would pass against an empty file either way.
  for (const n of notes)
    fs.writeFileSync(
      path.join(notesDir, `${n}.md`),
      `# ${n}\n\n${bodies[n] ?? 'The deployment finished but the release never reached production, and nobody noticed for a day.'}\n`,
    );
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
  // A trailing `{stdin}` object feeds the child; --author reads its cases from fd 0.
  /** @param {...(string | {stdin: string})} args */
  const run = (...args) => {
    const last = args[args.length - 1];
    const stdin = typeof last === 'object' ? last.stdin : undefined;
    const flags = /** @type {string[]} */ (typeof last === 'object' ? args.slice(0, -1) : args);
    return spawnSync(process.execPath, [ENTRY, '--vault', vault, '--slug', SLUG, ...flags], {
      encoding: 'utf8',
      env,
      input: stdin,
    });
  };
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
  assert.match(r.stdout, /1 of 3 case lines are missing a question or a gold array/);
  assert.ok(!r.stderr.includes('TypeError'), `crashed instead of refusing:\n${r.stderr}`);
  assert.ok(!r.stdout.includes('recall@'));
});

test('CLI --run refuses a question with nothing searchable in it', () => {
  // `typeof '' === 'string'`, so an empty q passed the guard, and `'???'` is not even blank. Both
  // tokenise to nothing: every BM25 score ties at 0 and the ranking is whatever order the docs came
  // in, which reports as 100% where k exceeds the corpus and 0% on a real vault. Neither is a
  // measurement.
  // `q: 42` rides along because the obvious short spelling of this guard — `!c.q?.trim()` — passes
  // the blank case and THROWS here: optional chaining guards null, not type. It shipped for one
  // commit and put back the crash the typeof test existed to stop.
  for (const q of ['   ', '', '???', '…—', 42, { text: 'nope' }]) {
    const { run, casesPath } = scratch(['ours-one'], [{ q, gold: ['ours-one'] }]);
    const r = run('--run', '--cases', casesPath, '--mode', 'lexical');
    assert.equal(r.status, 1, `q=${JSON.stringify(q)} must refuse, not score:\n${r.stdout}`);
    assert.match(r.stdout, /missing a question or a gold array/);
    assert.ok(!r.stdout.includes('recall@'));
    assert.ok(!r.stderr.includes('TypeError'), `q=${JSON.stringify(q)} crashed:\n${r.stderr}`);
  }
  // The other half of the rule, and the one that matters more: a question in any script must still
  // score. `\w` is ASCII-only in JS, so the obvious spelling of "has a word character" would have
  // rejected every non-Latin question in a vault that has them.
  for (const q of ['  padded text  ', 'x', '日本語のしつもん', 'hoe lang duurde de cutover']) {
    const { run, casesPath } = scratch(['ours-one'], [{ q, gold: ['ours-one'] }]);
    const r = run('--run', '--cases', casesPath, '--mode', 'lexical');
    assert.equal(r.status, 0, `q=${JSON.stringify(q)} must still score:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /recall@/);
  }
});

test('CLI --run refuses a case line with gold but no question', () => {
  // The guard filtered on `gold` alone, so this reached the scorer and threw on `c.q` — the same
  // crash one field over, and --author already guarded both.
  const { run, casesPath } = scratch(
    ['ours-one'],
    [{ q: 'a', gold: ['ours-one'] }, { gold: ['ours-one'] }],
  );
  const r = run('--run', '--cases', casesPath, '--mode', 'lexical');
  assert.equal(r.status, 1, `must refuse, not crash:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /missing a question or a gold array/);
  assert.ok(!r.stderr.includes('TypeError'), `crashed instead of refusing:\n${r.stderr}`);
});

test('CLI --generate followed by a flag does not write an empty case set over a real one', () => {
  // `--generate` may be bare, so val() cannot refuse a missing value — and the next token is then
  // the NEXT FLAG. Number('--force') is NaN, the stride is NaN, the loop never runs, and the file
  // was overwritten with nothing, exit 0. Destroying an authored case set is the worst outcome
  // here: it is the baseline every past number was measured against.
  const { run, scopedPath } = scratch(['ours-one', 'ours-two'], null);
  fs.writeFileSync(scopedPath, JSON.stringify({ q: 'keep me', gold: ['ours-one'] }) + '\n');
  const r = run('--generate', '--force');
  assert.equal(r.status, 0, `got:\n${r.stdout}${r.stderr}`);
  const written = fs.readFileSync(scopedPath, 'utf8').trim();
  assert.ok(written.length > 0, 'the case set was overwritten with nothing');
  assert.match(r.stdout, /[1-9]\d* cases \(semantic\)/, 'it must report a real count, not 0');
});

test('CLI --run refuses a genuinely truncated line instead of throwing', () => {
  // The earlier truncation test used `{"q":"c"}` — valid JSON, so it never reached the parse. A
  // half-written last line throws SyntaxError from inside a .map(), which reads as a crash.
  const { run, casesPath } = scratch(['ours-one'], [{ q: 'a', gold: ['ours-one'] }]);
  fs.appendFileSync(casesPath, '{"q":"truncated","gold":["ou');
  const r = run('--run', '--cases', casesPath, '--mode', 'lexical');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /line 2 is not valid JSON/);
  assert.ok(!r.stderr.includes('SyntaxError'), `crashed instead of refusing:\n${r.stderr}`);
});

// --author is the other caller of parseJsonl, and the only write path with no --force gate. It had
// no CLI test at all, which is why both of these shipped.
test('CLI --author refuses to overwrite a case set with nothing', () => {
  const { run, scopedPath } = scratch(['ours-one'], null);
  fs.writeFileSync(scopedPath, JSON.stringify({ q: 'keep me', gold: ['ours-one'] }) + '\n');
  const before = fs.readFileSync(scopedPath, 'utf8');
  const r = run('--author', { stdin: '' });
  assert.equal(r.status, 1, `empty stdin must not write:\n${r.stdout}`);
  assert.match(r.stdout, /refusing to overwrite/);
  assert.equal(fs.readFileSync(scopedPath, 'utf8'), before, 'the authored baseline was destroyed');
});

test('CLI --author refuses a case with no question instead of crashing', () => {
  const { run } = scratch(['ours-one'], null);
  const r = run('--author', { stdin: JSON.stringify({ gold: ['nope'] }) + '\n' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /every case needs a question and a gold array/);
  assert.ok(!r.stderr.includes('TypeError'), `crashed instead of refusing:\n${r.stderr}`);
});

test('CLI --author writes a real case set from valid stdin', () => {
  const { run, scopedPath } = scratch(['ours-one'], null);
  const r = run('--author', {
    stdin: JSON.stringify({ q: 'a question', gold: ['ours-one'] }) + '\n',
  });
  assert.equal(r.status, 0, `got:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /1 authored cases/);
  assert.match(fs.readFileSync(scopedPath, 'utf8'), /semantic-authored/);
});

test('CLI --run refuses a --cases pointing at a directory', () => {
  const { run, casesPath } = scratch(['ours-one'], [{ q: 'a', gold: ['ours-one'] }]);
  const r = run('--run', '--cases', path.dirname(casesPath), '--mode', 'lexical');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /is a directory/);
  assert.ok(!r.stderr.includes('EISDIR'), `crashed instead of refusing:\n${r.stderr}`);
});

test('CLI --json reports only the ks the fetch window can answer', () => {
  // The human path filters to KS; this one printed every k, so `--fetch-k 3` emitted an @5 and an
  // @10 that were @3 censored to the window — indistinguishable from measurements to a reader.
  const { run, casesPath } = scratch(
    ['ours-one', 'ours-two'],
    [
      { q: 'a', gold: ['ours-one'] },
      { q: 'b', gold: ['ours-two'] },
    ],
  );
  const r = run('--run', '--cases', casesPath, '--mode', 'lexical', '--fetch-k', '3', '--json');
  assert.equal(r.status, 0, `got:\n${r.stdout}${r.stderr}`);
  const json = JSON.parse(r.stdout);
  assert.equal(json.fetchK, 3);
  assert.deepEqual(Object.keys(json.recall), ['1', '3'], 'a k=3 fetch cannot answer @5 or @10');
});

test('CLI refuses a --fetch-k that is not a positive number', () => {
  // NaN emptied the recall-k list: no bars printed, --json reported every k as 0, exit 0.
  const { run, casesPath } = scratch(['ours-one'], [{ q: 'a', gold: ['ours-one'] }]);
  for (const bad of ['abc', '0']) {
    const r = run('--run', '--cases', casesPath, '--mode', 'lexical', '--fetch-k', bad);
    assert.equal(r.status, 1, `--fetch-k ${bad} must not score:\n${r.stdout}`);
    assert.match(r.stdout, /--fetch-k takes a positive whole number/);
  }
});

test('CLI --generate refuses a count that is not a number', () => {
  const { run, scopedPath } = scratch(['ours-one', 'ours-two'], null);
  fs.writeFileSync(scopedPath, JSON.stringify({ q: 'keep me', gold: ['ours-one'] }) + '\n');
  const before = fs.readFileSync(scopedPath, 'utf8');
  for (const bad of ['forty', '0', '-5', '3.7']) {
    const r = run('--generate', bad, '--force');
    assert.equal(r.status, 1, `--generate ${bad} must refuse:\n${r.stdout}`);
    assert.match(r.stdout, /--generate takes a positive count/);
    assert.equal(fs.readFileSync(scopedPath, 'utf8'), before, `--generate ${bad} touched the file`);
  }
});

test('CLI --generate bare still means 40', () => {
  const { run, scopedPath } = scratch(['ours-one', 'ours-two'], null);
  const r = run('--generate');
  assert.equal(r.status, 0, `bare --generate must still work:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /[1-9]\d* cases \(semantic\)/);
  assert.ok(fs.readFileSync(scopedPath, 'utf8').trim().length > 0, 'it must write real cases');
});

test('KNOWN_FLAGS covers every flag the entry actually reads', () => {
  // The list fails closed — a flag missing from it is refused outright rather than ignored — but
  // "refused outright" still means a working invocation stops working. Tie it to the call sites.
  const src = fs.readFileSync(ENTRY, 'utf8');
  const used = new Set([...src.matchAll(/(?:val|flag)\('(--[\w-]+)'/g)].map((m) => m[1]));
  assert.ok(used.size > 0, 'found no flag call sites — this scan is looking at the wrong thing');
  const list = src.slice(
    src.indexOf('const KNOWN_FLAGS'),
    src.indexOf(']);', src.indexOf('const KNOWN_FLAGS')),
  );
  for (const f of used)
    assert.ok(list.includes(`'${f}'`), `${f} is read by the entry but missing from KNOWN_FLAGS`);
});

test('CLI refuses a misspelled flag rather than dropping it', () => {
  // `--casess other.jsonl` matched nothing and was discarded, so the run scored the DEFAULT set and
  // printed a number the operator attributed to the file they named — #97, reached by a typo.
  const { run, casesPath, scopedPath } = scratch(['ours-one'], [{ q: 'a', gold: ['ours-one'] }]);
  fs.writeFileSync(scopedPath, JSON.stringify({ q: 'z', gold: ['ours-one'] }) + '\n');
  const r = run('--run', '--mode', 'lexical', '--casess', casesPath);
  assert.equal(r.status, 1, `got:\n${r.stdout}`);
  assert.match(r.stdout, /unknown flag --casess/);
  assert.ok(!r.stdout.includes('recall@'), 'it must not report a number for a set it never read');
});

test('CLI refuses a value-taking flag with no value', () => {
  // `--cases` last in argv yields undefined; `--cases --mode lexical` swallows the next flag. Both
  // scored the default set and printed a number for one the operator never named.
  const { run } = scratch(['ours-one'], null);
  const trailing = run('--run', '--mode', 'lexical', '--cases');
  assert.equal(trailing.status, 1, `got:\n${trailing.stdout}`);
  assert.match(trailing.stdout, /--cases needs a value/);
  const swallowed = run('--run', '--cases', '--mode', 'lexical');
  assert.equal(swallowed.status, 1, `got:\n${swallowed.stdout}`);
  assert.match(swallowed.stdout, /--cases needs a value/);
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
  // --out caller to drop a --cases it never passed.
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
  // Whole CODE BLOCKS, not lines. Per-line, `ARGS='--cases …'` on one line and `$ARGS` on the run
  // line matched neither filter and passed green while the doc still ran the unscoped set. The unit
  // that has to be clean is everything the reader will paste.
  const fences = [...doc.matchAll(/^[ \t]*(```|~~~)[^\n]*\n([\s\S]*?)^[ \t]*\1/gm)].map(
    (m) => m[2],
  );
  // A RUNNABLE line — one that starts with the interpreter — not any prose mentioning the flag.
  // eval.md line 76 already discusses `memory-eval.mjs` in a sentence; adding `--run` to a sentence
  // like it would otherwise fail this suite and block a perfectly good doc edit.
  /** @param {string} l */
  const isRun = (l) => /^\s*node\s/.test(l) && l.includes('memory-eval.mjs') && l.includes('--run');
  // Everything the scan cannot parse is a place to hide a `--cases`. An indented code block, a
  // fence inside a blockquote, or a fence style this regex misses would each leave a runnable
  // invocation unscanned while the two clean lines kept the counts below happy — so require that
  // every --run line in the WHOLE doc was seen, not just that the ones we found are clean.
  const inFences = fences.flatMap((b) => b.split('\n')).filter(isRun);
  const inDoc = doc.split('\n').filter(isRun);
  assert.equal(
    inFences.length,
    inDoc.length,
    `a memory-eval --run line sits outside any scanned code block:\n${inDoc
      .filter((l) => !inFences.includes(l))
      .join('\n')}`,
  );
  // The per-project block is the one invoking memory-eval with --run and no --vault; a --vault
  // block is the bench-vault walkthrough, where an explicit --cases is correct.
  /** @param {string} l */
  const isPerProjectRun = (l) => isRun(l) && !l.includes('--vault');
  const blocks = fences.filter((b) => b.split('\n').some(isPerProjectRun));
  // A scan guard that matches nothing passes for the wrong reason — this repo has been bitten by
  // exactly that, so assert the scan found its target before asserting anything about it.
  assert.ok(blocks.length >= 1, 'found no per-project eval block in commands/eval.md');
  for (const b of blocks)
    assert.ok(
      !b.includes('--cases') && !b.includes('--out'),
      `commands/eval.md must let the slug-scoped default resolve, got block:\n${b}`,
    );
  // And NO fenced line may name the machine-shared eval directory, however it is spelled. The check
  // above asks "does this line say --cases", which two shapes evade: a `--vault` line is exempted
  // from it (a live-vault run pointed at a shared file is the original bug), and the argument can
  // be assembled in an earlier fence (`ARGS="--cases $STATE/eval/…"`). Both must write the path, so
  // the path is what to look for — and deliberately on EVERY fenced line, not just runnable ones,
  // because the assembling line is not itself a command. The cost is that a fenced example naming
  // that directory for any reason fails here; the prose above the block is where it belongs.
  const shared = fences
    .flatMap((b) => b.split('\n'))
    .filter((l) => /\$\{?STATE\}?\/eval\//.test(l) || l.includes('eval-cases-'));
  assert.deepEqual(
    shared,
    [],
    `no fenced example in commands/eval.md may name the machine-shared eval dir — put it in prose:\n${shared.join('\n')}`,
  );
});

test('CLI --run scores cleanly and names its case set when every gold note resolves', () => {
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
  // Every failure in #97 is a figure attributed to a set nobody checked; a number printed beside
  // its source cannot be silently misread.
  assert.ok(r.stdout.includes(casesPath), `summary must name its case set, got:\n${r.stdout}`);
  const json = JSON.parse(run('--run', '--cases', casesPath, '--mode', 'lexical', '--json').stdout);
  assert.equal(json.goldResolved, 2, 'the JSON envelope must carry the coverage the warning does');
  assert.equal(json.goldTotal, 2);
  assert.equal(json.cases, casesPath);
});

// --- mine ------------------------------------------------------------------

/** @param {object} o */
const userLine = (o) => JSON.stringify({ type: 'user', ...o });

test('minePrompt reads both content shapes', () => {
  const q = 'why does the recall hook abstain so often on short prompts';
  assert.equal(minePrompt(userLine({ message: { content: q } })), q);
  assert.equal(
    minePrompt(userLine({ message: { content: [{ type: 'text', text: q }] } })),
    q,
    'a content-block array is the newer transcript shape and must mine the same',
  );
});

test('minePrompt keeps only the text blocks', () => {
  const line = userLine({
    message: {
      content: [
        { type: 'tool_result', content: 'ENOENT: no such file or directory, open /tmp/nope' },
        { type: 'text', text: 'that path is wrong, where does the index actually live' },
      ],
    },
  });
  assert.equal(minePrompt(line), 'that path is wrong, where does the index actually live');
});

test('minePrompt drops harness turns, not human ones', () => {
  const long = 'x'.repeat(MINE_MIN + 5);
  assert.equal(minePrompt(userLine({ message: { content: long }, isMeta: true })), null);
  assert.equal(minePrompt(JSON.stringify({ type: 'assistant', message: { content: long } })), null);
  assert.equal(minePrompt(userLine({ message: { content: '/memory:eval --run' } })), null);
  assert.equal(
    minePrompt(userLine({ message: { content: '<system-reminder>hi</system-reminder>' } })),
    null,
  );
  assert.equal(minePrompt(userLine({ message: { content: `Caveat: ${long}` } })), null);
  // Position is what separates the two: a slash-command line is noise, a question ABOUT one is not.
  assert.equal(
    minePrompt(userLine({ message: { content: 'what does /memory:eval --run actually score' } })),
    'what does /memory:eval --run actually score',
  );
});

test('minePrompt applies the length bounds', () => {
  assert.equal(minePrompt(userLine({ message: { content: 'do 1' } })), null);
  assert.equal(minePrompt(userLine({ message: { content: 'a'.repeat(MINE_MAX + 1) } })), null);
  assert.equal(
    minePrompt(userLine({ message: { content: 'b'.repeat(MINE_MAX) } })),
    'b'.repeat(MINE_MAX),
    'the bound is inclusive — an off-by-one here silently changes the pool size',
  );
});

test('minePrompt survives a truncated tail line', () => {
  const good = userLine({ message: { content: 'where do the semantic indexes get written to' } });
  const seen = new Set();
  const { lines, turns, kept } = minePrompts([good, '{"type":"user","message":{"conte'], seen);
  assert.equal(lines, 2);
  assert.equal(turns, 1, 'an unparseable line is not a turn — counting it inflates the drop rate');
  assert.equal(kept, 1, 'one unparseable append must not cost the lines around it');
});

test('minePrompts counts lines and turns apart', () => {
  const seen = new Set();
  const t = minePrompts(
    [
      JSON.stringify({ type: 'assistant', message: { content: 'a'.repeat(40) } }),
      userLine({ message: { content: 'do 1' } }),
      userLine({ message: { content: 'which model does the recall socket hold open' } }),
    ],
    seen,
  );
  // Lines are mostly assistant and tool records: reporting them as turns overstated the pool by
  // two orders of magnitude (212043 vs 3227 on 2026-09-04).
  assert.deepEqual(t, { lines: 3, turns: 2, kept: 1 });
});

test('minePrompts deduplicates across folders via the shared set', () => {
  const q = 'how is the project key derived when there is no git remote';
  const line = userLine({ message: { content: q } });
  const seen = new Set();
  // The two-folders-one-history case: 142 + 142 measured to 143 unique on 2026-09-04, so a
  // per-folder Set would double the reported pool.
  assert.equal(minePrompts([line], seen).kept, 1);
  assert.equal(minePrompts([line], seen).kept, 0);
  assert.equal(seen.size, 1);
});

test('a tool result is not a human turn', () => {
  const seen = new Set();
  const t = minePrompts(
    [
      userLine({ message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
      userLine({ message: { content: 'where does the model cache actually get redirected' } }),
    ],
    seen,
  );
  // Both arrive as `type: user`. Counting the first as a turn reported 37878 where the machine
  // holds ~3227 (2026-09-04), which makes the dropped count meaningless.
  assert.deepEqual(t, { lines: 2, turns: 1, kept: 1 });
});

// ---------------------------------------------------------------- set kind, gate, pairwise (#87)

test('a tuning set keeps the filename every past number was measured against', () => {
  // No migration step: the default kind must resolve to the name that already exists on disk.
  assert.equal(
    defaultCasesPath('/e', 'proj', 'semantic'),
    defaultCasesPath('/e', 'proj', 'semantic', KIND.tuning),
  );
  assert.ok(defaultCasesPath('/e', 'proj', 'semantic').endsWith('eval-cases-proj-semantic.jsonl'));
});

test('a held-out set resolves to its own file, never the tuning one', () => {
  const held = defaultCasesPath('/e', 'proj', 'semantic', KIND.heldOut);
  assert.notEqual(held, defaultCasesPath('/e', 'proj', 'semantic'));
  assert.ok(held.includes('heldout'), 'the kind must be visible in the path, not just in a report');
});

test('an unknown kind is refused rather than silently treated as tuning', () => {
  assert.throws(() => defaultCasesPath('/e', 'proj', 'semantic', 'holdout'), /kind/);
});

test('unscorableReason separates a broken instrument from a bad score', () => {
  const known = new Set(['note-a', 'note-b']);
  const ok = [{ note: 'note-b', score: 0.4 }];
  // Gold present, retrieval answered, and the gold note lost. That is a MISS, which is a number.
  assert.equal(unscorableReason({ gold: ['note-a'] }, ok, known), null);
  assert.equal(unscorableReason({ gold: ['gone'] }, ok, known), UNSCORABLE.gold);
  assert.equal(unscorableReason({ gold: ['note-a'] }, [], known), UNSCORABLE.empty);
  assert.equal(
    unscorableReason({ gold: ['note-a'] }, [{ note: 'note-b', score: NaN }], known),
    UNSCORABLE.score,
  );
  // An owner is a gold ref too — a pairwise case naming a deleted owner cannot be scored either.
  assert.equal(unscorableReason({ gold: ['note-a'], owner: 'gone' }, ok, known), UNSCORABLE.gold);
});

test('a pairwise case fails when its owner is absent, never passes vacuously', () => {
  // The bug this exists to stop: a question that matches NOTHING satisfies "the named note did not
  // win" and scores as a pass, so the case measures the retriever being broken.
  const c = { gold: ['wrong-note'], owner: 'right-note' };
  assert.equal(pairwise(c, [{ note: 'unrelated' }]).pass, false);
  assert.equal(pairwise(c, []).pass, false);
  assert.equal(pairwise(c, [{ note: 'right-note' }, { note: 'wrong-note' }]).pass, true);
  assert.equal(pairwise(c, [{ note: 'wrong-note' }, { note: 'right-note' }]).pass, false);
  // Owner found, named note absent entirely — the owner outranks it, which is the assertion.
  assert.equal(pairwise(c, [{ note: 'right-note' }]).pass, true);
});

test('metrics counts unscorable cases apart from cases that scored zero', () => {
  const m = metrics([{ rank: 1 }, { rank: 0 }, { rank: 0, unscorable: UNSCORABLE.gold }]);
  assert.equal(m.unscorable, 1, 'collapsing these into misses is the silent fallback this forbids');
  assert.equal(m.recall[1], 1 / 3);
});

test('the gate fails closed on an unscorable case, whatever the score is', () => {
  // 100% recall@1 and still a failure: a set that could not score one case did not measure it.
  const f = gateFailures({ recall1: 1, minRank1: 0.8, unscorable: 1, pairFails: 0 });
  assert.equal(f.length, 1);
  assert.match(f[0], /unscorable/);
  // Without a floor it stays a warning, because the churn band has always scored past a pruned
  // gold note and refusing it unprompted would break every plain --run.
  assert.deepEqual(gateFailures({ recall1: 1, minRank1: null, unscorable: 1, pairFails: 0 }), []);
});

test('the gate reads the floor and the pairwise cases, and passes when both hold', () => {
  assert.deepEqual(gateFailures({ recall1: 0.9, minRank1: 0.8, unscorable: 0, pairFails: 0 }), []);
  assert.equal(
    gateFailures({ recall1: 0.79, minRank1: 0.8, unscorable: 0, pairFails: 0 }).length,
    1,
  );
  assert.equal(
    gateFailures({ recall1: 0.9, minRank1: 0.8, unscorable: 0, pairFails: 2 }).length,
    1,
  );
  // No floor asked for means no floor enforced — a plain report still exits 0.
  assert.deepEqual(gateFailures({ recall1: 0, minRank1: null, unscorable: 0, pairFails: 0 }), []);
  // …but a pairwise case is an assertion, not a metric, so it fails with or without a floor.
  assert.equal(gateFailures({ recall1: 0, minRank1: null, unscorable: 0, pairFails: 1 }).length, 1);
});

test('casesHash ignores trailing-newline churn but not a changed question', () => {
  const a = '{"q":"one"}\n{"q":"two"}\n';
  assert.equal(casesHash(a), casesHash(a.trimEnd()));
  assert.notEqual(casesHash(a), casesHash('{"q":"one"}\n{"q":"three"}\n'));
  assert.match(casesHash(a), /^[0-9a-f]{64}$/);
});

// A ranking assertion needs notes the retriever can tell apart. The shared default body ties every
// BM25 score, so these three carry their own vocabulary.
const RANKED_BODIES = {
  'owner-note':
    'The certificate for the ingress controller expired overnight and every kubernetes request began failing at the edge.',
  'other-note':
    'The nightly backup job writes tarballs to object storage and prunes anything older than thirty days.',
  'third-note':
    'Invoices are reconciled against the ledger every morning by a scheduled batch that nobody has touched in a year.',
};
const RANKED_Q = 'why did the kubernetes ingress certificate expire';

test('CLI --kind held-out resolves a different file from the tuning set', () => {
  const { run, scopedPath } = scratch(['ours-one'], null);
  const r = run('--run', '--kind', 'held-out');
  assert.match(r.stdout, /no case set at/);
  assert.ok(r.stdout.includes('heldout'), `held-out must resolve its own path, got:\n${r.stdout}`);
  assert.ok(
    !r.stdout.includes(scopedPath),
    'a held-out run must never fall through to the tuning set',
  );
});

test('CLI refuses a misspelled --kind rather than scoring the tuning set under its name', () => {
  const { run } = scratch(['ours-one'], null);
  const r = run('--run', '--kind', 'holdout');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /unknown case-set kind/);
});

test('CLI --min-rank1 exits non-zero below the floor and zero above it', () => {
  const { run, casesPath } = scratch(
    ['owner-note', 'other-note', 'third-note'],
    [{ q: RANKED_Q, gold: ['owner-note'] }],
    RANKED_BODIES,
  );
  const pass = run('--run', '--cases', casesPath, '--mode', 'lexical', '--min-rank1', '100');
  assert.equal(pass.status, 0, `gold at rank 1 must clear a 100% floor:\n${pass.stdout}`);
  // The same vault, the same question, gold moved to the note that does not own it: recall@1 is 0
  // and the floor is what turns that from a printed regression into a failed run.
  const missPath = casesPath.replace(/\.jsonl$/, '-miss.jsonl');
  fs.writeFileSync(missPath, JSON.stringify({ q: RANKED_Q, gold: ['third-note'] }) + '\n');
  const below = run('--run', '--cases', missPath, '--mode', 'lexical', '--min-rank1', '100');
  assert.equal(below.status, 1, `below the floor must exit non-zero:\n${below.stdout}`);
  assert.match(below.stdout, /GATE FAILED/);
  // …and without the flag the very same run is a report that exits clean.
  assert.equal(run('--run', '--cases', missPath, '--mode', 'lexical').status, 0);
  assert.equal(
    run('--run', '--cases', missPath, '--mode', 'lexical', '--min-rank1', 'abc').status,
    1,
  );
});

test('CLI --min-rank1 fails closed on a case it could not score, and names it', () => {
  // recall@1 is 100% on the one case that CAN be scored. A gate that averaged the other away would
  // pass here — that silent pass is the whole failure this asks to prevent.
  const { run, casesPath } = scratch(
    ['owner-note', 'other-note', 'third-note'],
    [
      { q: RANKED_Q, gold: ['owner-note'] },
      { q: 'where do the nightly tarballs go', gold: ['deleted-note'] },
    ],
    RANKED_BODIES,
  );
  const r = run('--run', '--cases', casesPath, '--mode', 'lexical', '--min-rank1', '0');
  assert.equal(r.status, 1, `an unscorable case must block the gate:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /could not be scored/);
  assert.match(r.stdout, /where do the nightly tarballs go/, 'the message must name the case');
});

test('CLI scores a pairwise case by its owner, and fails the run when the owner loses', () => {
  const cases = [{ q: RANKED_Q, gold: ['other-note'], owner: 'owner-note' }];
  const good = scratch(['owner-note', 'other-note', 'third-note'], cases, RANKED_BODIES);
  const r = good.run('--run', '--cases', good.casesPath, '--mode', 'lexical');
  assert.equal(r.status, 0, `the owner does own this question:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /Pairwise .*1\/1 passed/);
  // …and the same case with the owner and the named note swapped must fail, with no floor asked
  // for: a pairwise case is an assertion, not a metric.
  const bad = scratch(
    ['owner-note', 'other-note', 'third-note'],
    [{ q: RANKED_Q, gold: ['owner-note'], owner: 'other-note' }],
    RANKED_BODIES,
  );
  const r2 = bad.run('--run', '--cases', bad.casesPath, '--mode', 'lexical');
  assert.equal(r2.status, 1, `a losing owner must fail the run:\n${r2.stdout}${r2.stderr}`);
  assert.match(r2.stdout, /GATE FAILED/);
});

test('CLI does not let a pairwise case pass vacuously when nothing matches', () => {
  // The question matches no note's vocabulary, so the named note does not win — and a naive
  // negative would call that a pass. It is a broken retrieval, and the run must say so.
  const { run, casesPath } = scratch(
    ['owner-note', 'other-note'],
    [{ q: 'zzzz qqqq vvvv wwww xxxx', gold: ['other-note'], owner: 'owner-note' }],
    RANKED_BODIES,
  );
  const r = run('--run', '--cases', casesPath, '--mode', 'lexical');
  assert.equal(r.status, 1, `a vacuous negative must not pass:\n${r.stdout}${r.stderr}`);
});

test('CLI --freeze pins a case set and --run refuses it once edited', () => {
  const { run, casesPath } = scratch(
    ['owner-note', 'other-note', 'third-note'],
    [{ q: RANKED_Q, gold: ['owner-note'] }],
    RANKED_BODIES,
  );
  const f = run('--freeze', '--cases', casesPath);
  assert.equal(f.status, 0, `${f.stdout}${f.stderr}`);
  assert.match(f.stdout, /sha256 [0-9a-f]{64}/);
  assert.equal(run('--run', '--cases', casesPath, '--mode', 'lexical').status, 0);
  fs.appendFileSync(casesPath, JSON.stringify({ q: RANKED_Q, gold: ['other-note'] }) + '\n');
  const r = run('--run', '--cases', casesPath, '--mode', 'lexical');
  assert.equal(r.status, 1, `an edited frozen set must be refused:\n${r.stdout}`);
  assert.match(r.stdout, /has changed since it was frozen/);
  // Re-freezing an already-frozen set takes --force, or a held-out set can be edited to fit.
  assert.equal(run('--freeze', '--cases', casesPath).status, 1);
  assert.equal(run('--freeze', '--force', '--cases', casesPath).status, 0);
});
