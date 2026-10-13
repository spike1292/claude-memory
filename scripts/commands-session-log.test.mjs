// #90: the session-log headings are a contract between /memory:save and /memory:resume.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands');
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(COMMANDS, f), 'utf8');

const OLD = ['## Done', '## Decisions', '## Open / next', '## Files touched'];
const headings = (/** @type {string} */ md) =>
  [...md.matchAll(/^- `(## [^`]+)`/gm)].map((m) => m[1]);

test('every section save writes beyond the original four is read by resume', () => {
  const saved = headings(read('save.md'));
  for (const h of OLD) assert.ok(saved.includes(h), `save lost ${h}`);
  const added = saved.filter((h) => !OLD.includes(h));
  assert.ok(added.length >= 4, `expected the four new sections, scan found ${added.join(', ')}`);
  const resume = read('resume.md');
  for (const h of added) assert.ok(resume.includes(h), `resume does not read ${h}`);
});

test('save names the dead-end, error, state and files-to-read sections', () => {
  const added = headings(read('save.md')).join('\n');
  for (const re of [/dead end/i, /errors/i, /current state/i, /files to read/i])
    assert.match(added, re);
});

test('save keeps seconds and never-overwrite, and verifies before the write', () => {
  const save = read('save.md');
  assert.ok(save.includes('date +%Y-%m-%d-%H%M%S'));
  assert.ok(save.includes('test -e'));
  assert.match(save, /resolved|unresolved/);
  for (const item of [
    /tool output/i,
    /intermediate reasoning/i,
    /repeated operations/i,
    /code already/i,
  ])
    assert.match(save, item);
  const verify = save.search(/\*\*Verify before writing/);
  assert.ok(verify > 0, 'no verify step');
  assert.ok(verify < save.search(/\*\*Write it\*\*/), 'verify step must precede the write');
});

test('resume continues when an older log lacks the new sections', () => {
  assert.match(read('resume.md'), /older log/i);
});
