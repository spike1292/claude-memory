// Tests for hooks/lib/memory-link-lint.mjs. Run: node --test hooks/lib/memory-link-lint.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  linkTargets,
  findOrphans,
  findDrift,
  mocSize,
  findOversize,
  reportFor,
  capReport,
  AUTO_MEMORY_CAP,
} from './memory-link-lint.mjs';

test('linkTargets parses aliases and headings', () => {
  assert.deepStrictEqual(
    [...linkTargets('see [[a]] and [[b|alias]] and [[c#head]]')],
    ['a', 'b', 'c'],
  );
  assert.deepStrictEqual(
    [...linkTargets('[[foo bar]]')],
    ['foo bar'],
    'a space is part of the target',
  );
  assert.deepStrictEqual([...linkTargets('[[nx]] is not [[n]]')], ['nx', 'n']);
  assert.deepStrictEqual([...linkTargets('no links here')], []);
});

const M = '/v/Memory/p';
/**
 * @param {readonly (readonly [string, string])[]} pairs
 * @returns {[string, string][]}
 */
const corpus = (pairs) => pairs.map(([f, t]) => [path.join(M, f), t]);

test('findOrphans counts sibling links but not the MOC or self', () => {
  // linked from a sibling -> not an orphan; only from the MOC -> orphan
  assert.deepStrictEqual(
    findOrphans(
      M,
      ['a', 'b', 'MEMORY'],
      corpus([
        ['MEMORY.md', '- [[a]]\n- [[b]]'],
        ['b.md', 'see [[a]]'],
      ]),
    ),
    ['b'],
    'a is linked by b; b only by the MOC',
  );
  // a self-link is not inbound
  assert.deepStrictEqual(findOrphans(M, ['a'], corpus([['a.md', 'I am [[a]]']])), ['a']);
  // an alias/heading link counts
  assert.deepStrictEqual(
    findOrphans(
      M,
      ['a', 'b'],
      corpus([
        ['b.md', '[[a|see]]'],
        ['a.md', '[[b#top]]'],
      ]),
    ),
    [],
  );
  // MEMORY is never reported as an orphan itself
  assert.deepStrictEqual(findOrphans(M, ['MEMORY'], corpus([['MEMORY.md', 'x']])), []);
});

test('findDrift only flags bolded multi-digit figures a note contradicts', () => {
  /** @type {Record<string, string>} */
  const notes = { a: 'the count is 1172 today', b: 'no figures here' };
  const read = (/** @type {string} */ tgt) => (tgt in notes ? notes[tgt] : null);
  assert.deepStrictEqual(
    findDrift('- [[a]] holds **1,172** notes', read),
    [],
    'commas stripped both sides',
  );
  assert.deepStrictEqual(findDrift('- [[a]] holds **999** notes', read), [
    { target: 'a', n: '999' },
  ]);
  assert.deepStrictEqual(
    findDrift('- [[a]] holds **7** notes', read),
    [],
    'single digits are noise',
  );
  assert.deepStrictEqual(
    findDrift('- [[a]] holds 999 notes', read),
    [],
    'unbolded numbers are ignored',
  );
  assert.deepStrictEqual(findDrift('- [[missing]] says **999**', read), [], 'no note, no claim');
  assert.deepStrictEqual(findDrift('not a moc line **999**', read), []);
  assert.deepStrictEqual(
    findDrift('- [[b]] says **10** and **9999**', read).map((d) => d.n),
    ['10', '9999'],
  );
});

test('mocSize counts bytes and lines the way the loader does', () => {
  assert.deepStrictEqual(mocSize(''), { bytes: 0, lines: 0 });
  assert.deepStrictEqual(
    mocSize('a\nb\n'),
    { bytes: 4, lines: 2 },
    'a trailing newline is not a line',
  );
  assert.deepStrictEqual(mocSize('a\nb'), { bytes: 3, lines: 2 });
  assert.deepStrictEqual(mocSize('é'), { bytes: 2, lines: 1 }, 'bytes, not characters');
});

test('findOversize warns near the cap and reports crossing it', () => {
  assert.strictEqual(findOversize('- [[a]] tiny'), '', 'well under: nothing to say');

  const near = 'x'.repeat(Math.round(AUTO_MEMORY_CAP.bytes * 0.85));
  const nearText = findOversize(near);
  assert.match(nearText, /85% of/, 'names the percentage');
  assert.doesNotMatch(nearText, /DROPPED/, 'not yet truncated');

  const overBytes = findOversize('x'.repeat(AUTO_MEMORY_CAP.bytes + 1));
  assert.match(overBytes, /DROPPED/, 'past the cap, content is silently dropped');

  const overLines = findOversize('x\n'.repeat(AUTO_MEMORY_CAP.lines + 1));
  assert.match(overLines, /DROPPED/, 'the line cap bites even when the byte cap does not');
  assert.match(overLines, new RegExp(`${AUTO_MEMORY_CAP.lines} lines`), 'names the line cap');
});

test('lint reports an oversize MOC alongside the other findings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moc-'));
  const mem = path.join(dir, 'Memory', 'p');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- [[a]]\n' + 'x'.repeat(AUTO_MEMORY_CAP.bytes));
  fs.writeFileSync(path.join(mem, 'a.md'), 'lonely');
  const out = reportFor(mem, path.join(dir, 'Insights', 'p'));
  assert.match(out, /MOC-only memory notes/, 'the orphan is still reported');
  assert.match(out, /DROPPED/, 'and so is the truncation');
});

test('capReport names only this project and aggregates the rest', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  const write = (/** @type {string} */ slug, /** @type {string} */ text) => {
    fs.mkdirSync(path.join(vault, 'Memory', slug), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Memory', slug, 'MEMORY.md'), text);
  };
  write('mine', 'small');
  write('other-private-repo', 'x'.repeat(AUTO_MEMORY_CAP.bytes + 1));

  const lines = capReport(vault, 'mine');
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /^ok\tthis project's MEMORY\.md fits/);
  assert.match(lines[1], /^warn\t1 of 1 other MEMORY\.md over the cap/);
  assert.ok(
    !lines.join('\n').includes('other-private-repo'),
    'other projects must not be named — this report is pasted into issues',
  );

  write('mine', 'x'.repeat(AUTO_MEMORY_CAP.bytes + 1));
  assert.match(capReport(vault, 'mine')[0], /^fail\t/, 'over the cap is a failure, not a warning');
  assert.deepStrictEqual(capReport(path.join(vault, 'nope'), 'mine'), [], 'no vault, no report');
});
