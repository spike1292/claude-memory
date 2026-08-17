// Tests for hooks/lib/insights-surface.mjs. Run: node --test hooks/lib/insights-surface.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { noteTitle, orderNewestFirst, render, LIMIT } from './insights-surface.mjs';

test('noteTitle prefers frontmatter, falls back to the filename', () => {
  assert.strictEqual(noteTitle('2026-08-06-a-b.md', '---\ntitle: Real Title\n---\n'), 'Real Title');
  // The case a naive port gets wrong: an empty title: value must fall back to the filename.
  assert.strictEqual(noteTitle('2026-08-06-a-b.md', '---\ntitle:\n---\n'), 'a b');
  assert.strictEqual(noteTitle('2026-08-06-a-b.md', '---\ntitle:   \n---\n'), 'a b');
  assert.strictEqual(noteTitle('2026-08-06-a-b.md', 'no frontmatter at all\n'), 'a b');
  // Only a line-initial title: counts, the same as grep '^title:'.
  assert.strictEqual(noteTitle('2026-01-01-x.md', 'body mentions title: nope\n'), 'x');
  assert.strictEqual(noteTitle('plain.md', '---\ntitle: T\n---\n'), 'T');
});

test('orderNewestFirst sorts by date and drops non-markdown', () => {
  assert.deepStrictEqual(
    orderNewestFirst(['2026-01-01-a.md', '2026-03-01-c.md', '2026-02-01-b.md']),
    ['2026-03-01-c.md', '2026-02-01-b.md', '2026-01-01-a.md'],
  );
  assert.deepStrictEqual(orderNewestFirst(['a.md', 'notes.txt', 'b.md']), ['b.md', 'a.md']);
});

test('render is silent when there is nothing', () => {
  assert.strictEqual(
    render('p', [], () => ''),
    '',
    'silent when there is nothing',
  );
});

test('render caps the list and reports the remainder', () => {
  const many = Array.from(
    { length: 18 },
    (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}-n${i}.md`,
  );
  const out = render('p', orderNewestFirst(many), () => '---\ntitle: T\n---\n').split('\n');
  assert.strictEqual(out.length, 1 + LIMIT + 1, 'header + 15 titles + the older count');
  assert.strictEqual(out.at(-1), '(+3 older)');
  assert.ok(out[0].includes('Insights/p/Mistakes/'));

  const few = render(
    'p',
    ['2026-01-02-b.md', '2026-01-01-a.md'],
    () => '---\ntitle: T\n---\n',
  ).split('\n');
  assert.strictEqual(few.length, 3, 'no older-count line when at or under the cap');
});
