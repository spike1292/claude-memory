// Tests for scripts/lib/memory-eval.mjs. Run: node --test scripts/lib/memory-eval.test.mjs
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { titleTokens, evalBody, pickSentence, metrics, lexicalRank } from './memory-eval.mjs';

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
