// Tests for hooks/lib/memory-link-lint.mjs. Run: node --test hooks/lib/memory-link-lint.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { linkTargets, findOrphans, findDrift } from './memory-link-lint.mjs';

test('linkTargets parses aliases and headings', () => {
  assert.deepStrictEqual([...linkTargets('see [[a]] and [[b|alias]] and [[c#head]]')], ['a', 'b', 'c']);
  assert.deepStrictEqual([...linkTargets('[[foo bar]]')], ['foo bar'], 'a space is part of the target');
  assert.deepStrictEqual([...linkTargets('[[nx]] is not [[n]]')], ['nx', 'n']);
  assert.deepStrictEqual([...linkTargets('no links here')], []);
});

const M = '/v/Memory/p';
const corpus = (pairs) => pairs.map(([f, t]) => [path.join(M, f), t]);

test('findOrphans counts sibling links but not the MOC or self', () => {
  // linked from a sibling -> not an orphan; only from the MOC -> orphan
  assert.deepStrictEqual(
    findOrphans(M, ['a', 'b', 'MEMORY'], corpus([['MEMORY.md', '- [[a]]\n- [[b]]'], ['b.md', 'see [[a]]']])),
    ['b'], 'a is linked by b; b only by the MOC');
  // a self-link is not inbound
  assert.deepStrictEqual(
    findOrphans(M, ['a'], corpus([['a.md', 'I am [[a]]']])), ['a']);
  // an alias/heading link counts
  assert.deepStrictEqual(
    findOrphans(M, ['a', 'b'], corpus([['b.md', '[[a|see]]'], ['a.md', '[[b#top]]']])), []);
  // MEMORY is never reported as an orphan itself
  assert.deepStrictEqual(findOrphans(M, ['MEMORY'], corpus([['MEMORY.md', 'x']])), []);
});

test('findDrift only flags bolded multi-digit figures a note contradicts', () => {
  const notes = { a: 'the count is 1172 today', b: 'no figures here' };
  const read = (tgt) => (tgt in notes ? notes[tgt] : null);
  assert.deepStrictEqual(findDrift('- [[a]] holds **1,172** notes', read), [], 'commas stripped both sides');
  assert.deepStrictEqual(findDrift('- [[a]] holds **999** notes', read), [{ target: 'a', n: '999' }]);
  assert.deepStrictEqual(findDrift('- [[a]] holds **7** notes', read), [], 'single digits are noise');
  assert.deepStrictEqual(findDrift('- [[a]] holds 999 notes', read), [], 'unbolded numbers are ignored');
  assert.deepStrictEqual(findDrift('- [[missing]] says **999**', read), [], 'no note, no claim');
  assert.deepStrictEqual(findDrift('not a moc line **999**', read), []);
  assert.deepStrictEqual(findDrift('- [[b]] says **10** and **9999**', read).map((d) => d.n), ['10', '9999']);
});
