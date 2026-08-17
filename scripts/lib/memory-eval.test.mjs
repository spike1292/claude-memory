// Tests for scripts/lib/memory-eval.mjs. Run: node --test scripts/lib/memory-eval.test.mjs
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { titleTokens, evalBody, pickSentence, metrics } from './memory-eval.mjs';

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
