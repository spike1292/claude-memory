import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMark, frontmatter, isMarked, markNotes, resolveNote } from './memory-mark.mjs';

const NOTE = '---\nname: a-note\ntype: insight\n---\n\n## A note\n\nbody.\n';

test('the mark is a frontmatter line, never prose that says the same words', () => {
  assert.equal(isMarked(NOTE), false);
  const marked = /** @type {string} */ (applyMark(NOTE));
  assert.equal(isMarked(marked), true);
  assert.match(/** @type {string} */ (frontmatter(marked)), /^reconcile: manual$/m);
  assert.ok(marked.endsWith('## A note\n\nbody.\n'), 'the body is untouched');

  // A note ABOUT the mark is exactly the note this vault would contain, and it must stay mergeable.
  const aboutIt = '---\nname: n\n---\n\n## n\n\nSet reconcile: manual on a pair you keep.\n';
  assert.equal(isMarked(aboutIt), false, 'body prose must not read as the mark');

  // Nested blocks sit above the closing delimiter, so an insert that lands inside one would be
  // silently wrong: a `^`-anchored read of that key would then find nothing.
  const nested = '---\nname: n\nmetadata:\n  type: reference\n---\n\nbody\n';
  const nestedMarked = /** @type {string} */ (applyMark(nested));
  assert.equal(isMarked(nestedMarked), true);
  assert.ok(nestedMarked.includes('  type: reference\nreconcile: manual\n---\n'));
});

test('applying a mark that is already there changes nothing', () => {
  // null rather than identical text, so the caller reports "already marked" instead of rewriting
  // the file: the moved mtime alone would re-embed the note on the next incremental index.
  const marked = /** @type {string} */ (applyMark(NOTE));
  assert.equal(applyMark(marked, true), null);
  assert.equal(applyMark(NOTE, false), null);
  assert.equal(applyMark(/** @type {string} */ (applyMark(marked, false)), false), null);
  assert.equal(applyMark(marked, false), NOTE, 'unmark is the exact inverse of mark');
  assert.equal(applyMark('no frontmatter here\n'), null, 'a note with no frontmatter is refused');
});

test('notes are addressed by name, anywhere under the vault', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const deep = path.join(root, 'Insights', 'proj', 'Patterns');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, '2026-08-23-a-note.md'), NOTE);
  fs.writeFileSync(path.join(root, 'plain.md'), 'no frontmatter\n');

  assert.equal(resolveNote(root, '2026-08-23-a-note'), path.join(deep, '2026-08-23-a-note.md'));
  assert.equal(resolveNote(root, '2026-08-23-a-note.md'), path.join(deep, '2026-08-23-a-note.md'));
  // A PREFIX of a real name is not a match: names are compared whole, so `--dupes` output pasted
  // one note short cannot silently mark a different note.
  assert.equal(resolveNote(root, '2026-08-23-a'), null);
  assert.equal(resolveNote(root, 'nothing-like-this'), null);

  const [ok, missing, bare] = markNotes(root, ['2026-08-23-a-note', 'nope', 'plain']);
  assert.equal(ok.status, 'marked');
  assert.equal(missing.status, 'missing');
  assert.equal(bare.status, 'no-frontmatter');
  assert.ok(isMarked(fs.readFileSync(path.join(deep, '2026-08-23-a-note.md'), 'utf8')));
  assert.equal(fs.readFileSync(path.join(root, 'plain.md'), 'utf8'), 'no frontmatter\n');

  // Round trip through the filesystem, not just through the string helpers: two tests pinning one
  // end each would both stay green while the ends drifted.
  assert.equal(markNotes(root, ['2026-08-23-a-note'])[0].status, 'unchanged');
  assert.equal(markNotes(root, ['2026-08-23-a-note'], false)[0].status, 'unmarked');
  assert.equal(fs.readFileSync(path.join(deep, '2026-08-23-a-note.md'), 'utf8'), NOTE);
});
