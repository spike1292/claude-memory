// Tests for hooks/lib/validate-note.mjs. Run: node --test hooks/lib/validate-note.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { frontmatter, noteBody, isCheckable, warnings } from './validate-note.mjs';

const V = '/v';

test('frontmatter needs a line-1 fence and tolerates an unterminated one', () => {
  assert.strictEqual(frontmatter('---\na: 1\n---\nbody'), 'a: 1');
  assert.strictEqual(frontmatter('no fence\n---\n'), null, 'fence must be on line 1');
  // An unterminated fence must not swallow the check — it reports as frontmatter, not as absent.
  assert.strictEqual(frontmatter('---\na: 1\nb: 2'), 'a: 1\nb: 2');
});

test('noteBody falls back to the whole file when unfenced', () => {
  // Body = after the SECOND fence, but the whole file when unfenced, so body checks still fire.
  assert.strictEqual(noteBody('---\na: 1\n---\nhello'), 'hello');
  assert.strictEqual(noteBody('plain note'), 'plain note');
});

test('isCheckable covers Memory notes only', () => {
  assert.ok(isCheckable(`${V}/Memory/p/a.md`, V));
  assert.ok(!isCheckable(`${V}/Logs/p/a.md`, V), 'Logs are an operating surface');
  assert.ok(!isCheckable(`${V}/Graph/p/a.md`, V));
  assert.ok(!isCheckable(`${V}/Memory/p/MEMORY.md`, V), 'the MOC is not a note');
  assert.ok(!isCheckable(`${V}/Memory/p/REFLECTIONS.md`, V));
  assert.ok(!isCheckable('/elsewhere/a.md', V), 'outside the vault');
  assert.ok(!isCheckable(`${V}/Memory/p/a.txt`, V));
});

test('a well-formed Memory note warns about nothing', () => {
  const good = '---\nname: a\nconfidence: high\n---\n\nbody\n\n_Also asked as: one, two._\n';
  assert.deepStrictEqual(warnings(`${V}/Memory/p/a.md`, good, V), []);
});

test('name mismatch, missing confidence and missing aliases each warn', () => {
  const w1 = warnings(`${V}/Memory/p/a.md`, '---\nname: WRONG\n---\n\nx\n', V);
  assert.ok(w1.some((w) => w.includes('name: must equal the filename')));
  assert.ok(w1.some((w) => w.includes('no confidence:')));
  assert.ok(w1.some((w) => w.includes('_Also asked as:')));
});

test('Insights notes are exempt from name: and confidence:', () => {
  const w2 = warnings(`${V}/Insights/p/Mistakes/a.md`, '---\ntitle: x\n---\n\nx\n\n_Also asked as: q._\n', V);
  assert.deepStrictEqual(w2, []);
});

test('missing fence and tabs in frontmatter warn', () => {
  assert.ok(warnings(`${V}/Memory/p/a.md`, 'no fence at all\n\n_Also asked as: q._\n', V)
    .some((w) => w.includes('no frontmatter fence')));
  assert.ok(warnings(`${V}/Memory/p/a.md`, '---\nname: a\nconfidence: high\ntab:\there\n---\n\n_Also asked as: q._\n', V)
    .some((w) => w.includes('tab inside frontmatter')));
});

test('prose "superseded" warns unless it names a date and target', () => {
  const sup = '---\nname: a\nconfidence: high\n---\n\nThis is SUPERSEDED now.\n\n_Also asked as: q._\n';
  assert.ok(warnings(`${V}/Memory/p/a.md`, sup, V).some((w) => w.includes('says superseded in prose')));
  const supOk = '---\nname: a\nconfidence: high\n---\n\nGone (superseded 2026-08-01 by [[b]]).\n\n_Also asked as: q._\n';
  assert.deepStrictEqual(warnings(`${V}/Memory/p/a.md`, supOk, V), []);
});

test('regex metacharacters in a filename match literally', () => {
  assert.doesNotThrow(() => warnings(`${V}/Memory/p/a+b(c).md`, '---\nname: a+b(c)\n---\n', V));
  assert.ok(!warnings(`${V}/Memory/p/a+b(c).md`, '---\nname: a+b(c)\nconfidence: low\n---\n\n_Also asked as: q._\n', V)
    .some((w) => w.includes('name: must equal')), 'metacharacters must match literally');
});
