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

test('mocSize counts bytes, and lines ignoring a trailing newline', () => {
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

  // AT the threshold, both sides of it. Without these the 80% could be moved anywhere in
  // (0.5, 0.9] and every other assertion here stays green — the constant would be pinned by
  // nothing, which is how a report quietly stops firing until it is too late.
  const bytesAt = (/** @type {number} */ r) => 'x'.repeat(Math.round(AUTO_MEMORY_CAP.bytes * r));
  assert.match(findOversize(bytesAt(0.8)), /80% of/, 'exactly at 80%: reports');
  assert.strictEqual(findOversize(bytesAt(0.8).slice(1)), '', 'one byte under 80%: silent');

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

test('reportFor puts an oversize MOC alongside the other findings', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mem = path.join(dir, 'Memory', 'p');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- [[a]]\n' + 'x'.repeat(AUTO_MEMORY_CAP.bytes));
  fs.writeFileSync(path.join(mem, 'a.md'), 'lonely');
  const out = reportFor(mem, path.join(dir, 'Insights', 'p'));
  assert.match(out, /MOC-only memory notes/, 'the orphan is still reported');
  assert.match(out, /DROPPED/, 'and so is the truncation');
});

test('capReport names only this project, and gives every other MOC its percentage', (t) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const write = (/** @type {string} */ slug, /** @type {string} */ text) => {
    fs.mkdirSync(path.join(vault, 'Memory', slug), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Memory', slug, 'MEMORY.md'), text);
  };
  write('mine', 'small');
  write('other-private-repo', 'x'.repeat(AUTO_MEMORY_CAP.bytes + 1));

  const lines = capReport(vault, 'mine');
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /^ok\tthis project's MEMORY\.md fits/);
  assert.match(
    lines[1],
    /^warn\t1 of 1 other MEMORY\.md over the cap, 0 near it — 100%/,
    'floored: a file one byte over reads as 100%, and the WORDS say which side of the cap it is on',
  );
  assert.ok(
    !lines.join('\n').includes('other-private-repo'),
    'other projects must not be named — this report is pasted into issues',
  );

  write('mine', 'x'.repeat(AUTO_MEMORY_CAP.bytes + 1));
  assert.match(capReport(vault, 'mine')[0], /^fail\t/, 'over the cap is a failure, not a warning');

  // The band the whole feature exists for: still loading, about to stop. Untested, `>= NEAR` could
  // be deleted outright and an 85% index would report "fits the load cap" with every test green.
  write('mine', 'x'.repeat(Math.round(AUTO_MEMORY_CAP.bytes * 0.9)));
  const near = capReport(vault, 'mine');
  assert.match(near[0], /^warn\tthis project's MEMORY\.md is near the load cap: .* — 90% of/);

  // The three boundaries, so neither threshold can move without a test saying so.
  write('mine', 'x'.repeat(AUTO_MEMORY_CAP.bytes * 0.8));
  assert.match(capReport(vault, 'mine')[0], /^warn\t.* near the load cap/, 'exactly 80%: warns');
  write('mine', 'x'.repeat(AUTO_MEMORY_CAP.bytes * 0.8 - 1));
  assert.match(capReport(vault, 'mine')[0], /^ok\t/, 'one byte under 80%: still just fits');
  write('mine', 'x'.repeat(AUTO_MEMORY_CAP.bytes));
  assert.match(
    capReport(vault, 'mine')[0],
    /^warn\t.* near the load cap/,
    'exactly at the cap nothing is dropped yet — a warning, never a failure',
  );
  write('other-private-repo', 'x'.repeat(Math.round(AUTO_MEMORY_CAP.bytes * 0.9)));
  assert.match(
    capReport(vault, 'mine')[1],
    /^warn\t0 of 1 other MEMORY\.md over the cap, 1 near it — 90%/,
    "the others' near counter, which no other case moves off zero",
  );

  for (const blank of ['', '\n', '   \n\n'])
    assert.match(
      (write('mine', blank), capReport(vault, 'mine'))[0],
      /^warn\tthis project's MEMORY\.md is empty/,
      `${JSON.stringify(blank)}: empty means no content, not zero bytes — whitespace injects nothing either`,
    );

  // Without this branch the project's own MOC would fall into the unnamed `others` aggregate and be
  // reported as someone else's — which is how a legacy cwd-slug folder would look.
  const missing = capReport(vault, 'not-indexed-here');
  assert.match(missing[0], /^warn\tno MEMORY\.md for this project \(not-indexed-here\)/);
  assert.strictEqual(missing.length, 2, 'and the others are still reported');
  assert.deepStrictEqual(capReport(path.join(vault, 'nope'), 'mine'), [], 'no vault, no report');
});
