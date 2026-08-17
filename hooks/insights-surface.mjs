#!/usr/bin/env node
// SessionStart: surface recent L3 Mistakes titles so past errors actually reach context.
// The vault Insights layer is write-heavy but not auto-loaded (unlike MEMORY.md); this closes the
// gap. Titles only — cheap; full lessons stay in the vault / via /memory:health.
// ponytail: no bodies, capped at 15, silent when there's nothing.
//
// Ported from insights-surface.sh on 2026-08-17: 160 ms → 48 ms. It forked `grep` + `sed` once per
// note, up to 45 subprocesses to print 15 lines. Pinning the vault to local disk bought it 9 ms of
// its 174 ms, which is what identified it as fork-bound rather than I/O-bound — see
// docs/decisions/2026-08-17-shell-vs-node-hooks.md.
import fs from 'node:fs';
import path from 'node:path';
import { vault, projectKey, legacyKey, isEntryPoint } from './lib/paths.mjs';

const LIMIT = 15;

/**
 * The displayed title for one note: frontmatter `title:` if it carries a value, else the filename
 * with its date prefix stripped and dashes spaced out.
 *
 * The empty-value case is why this is a function with a test. `grep -m1 '^title:' | sed` yields an
 * empty string for `title:` with nothing after it, and the shell version then fell through to the
 * filename — a naive port prints a blank bullet instead.
 */
export function noteTitle(filename, raw) {
  const m = raw.match(/^title: *(.*)$/m);
  const t = m ? m[1].trim() : '';
  if (t) return t;
  return filename.replace(/\.md$/, '').replace(/^[0-9-]*/, '').replace(/-/g, ' ');
}

/** Newest first. Filenames are date-prefixed, so a plain reverse sort is chronological. */
export function orderNewestFirst(names) {
  return names.filter((f) => f.endsWith('.md')).sort().reverse();
}

export function render(slug, files, read) {
  if (!files.length) return '';
  const out = [`Past mistakes for this project (L3 memory — avoid repeating; full lessons in Insights/${slug}/Mistakes/ or via /memory:health):`];
  for (const f of files.slice(0, LIMIT)) out.push(`- ${noteTitle(f, read(f))}`);
  if (files.length > LIMIT) out.push(`(+${files.length - LIMIT} older)`);
  return out.join('\n');
}

function main() {
  let cwd = process.cwd();
  try {
    const j = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (j?.cwd) cwd = j.cwd;
  } catch { /* no payload — fall back to cwd, as the shell version did */ }

  let slug;
  try { slug = projectKey(cwd); } catch { slug = legacyKey(cwd); }
  const dirFor = (s) => path.join(vault(), 'Insights', s, 'Mistakes');
  let dir = dirFor(slug);
  // Tolerate a not-yet-migrated vault: vault-memory-sync.sh performs the rename, but SessionStart
  // hook order isn't guaranteed, so fall back for this one session.
  if (!isDir(dir)) { slug = legacyKey(cwd); dir = dirFor(slug); }
  if (!isDir(dir)) return;

  let files;
  try { files = orderNewestFirst(fs.readdirSync(dir)); } catch { return; }
  const text = render(slug, files, (f) => {
    try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; }
  });
  if (text) console.log(text);
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Nothing runs on import.
const isMain = isEntryPoint(import.meta.url);

if (isMain && process.argv.includes('--selftest')) {
  const assert = await import('node:assert').then((m) => m.default);

  assert.strictEqual(noteTitle('2026-08-06-a-b.md', '---\ntitle: Real Title\n---\n'), 'Real Title');
  // The case a naive port gets wrong: an empty title: value must fall back to the filename.
  assert.strictEqual(noteTitle('2026-08-06-a-b.md', '---\ntitle:\n---\n'), 'a b');
  assert.strictEqual(noteTitle('2026-08-06-a-b.md', '---\ntitle:   \n---\n'), 'a b');
  assert.strictEqual(noteTitle('2026-08-06-a-b.md', 'no frontmatter at all\n'), 'a b');
  // Only a line-initial title: counts, the same as grep '^title:'.
  assert.strictEqual(noteTitle('2026-01-01-x.md', 'body mentions title: nope\n'), 'x');
  assert.strictEqual(noteTitle('plain.md', '---\ntitle: T\n---\n'), 'T');

  assert.deepStrictEqual(orderNewestFirst(['2026-01-01-a.md', '2026-03-01-c.md', '2026-02-01-b.md']),
    ['2026-03-01-c.md', '2026-02-01-b.md', '2026-01-01-a.md']);
  assert.deepStrictEqual(orderNewestFirst(['a.md', 'notes.txt', 'b.md']), ['b.md', 'a.md']);

  assert.strictEqual(render('p', [], () => ''), '', 'silent when there is nothing');

  const many = Array.from({ length: 18 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}-n${i}.md`);
  const out = render('p', orderNewestFirst(many), () => '---\ntitle: T\n---\n').split('\n');
  assert.strictEqual(out.length, 1 + LIMIT + 1, 'header + 15 titles + the older count');
  assert.strictEqual(out.at(-1), '(+3 older)');
  assert.ok(out[0].includes('Insights/p/Mistakes/'));

  const few = render('p', ['2026-01-02-b.md', '2026-01-01-a.md'], () => '---\ntitle: T\n---\n').split('\n');
  assert.strictEqual(few.length, 3, 'no older-count line when at or under the cap');

  console.log('selftest: 13 assertions passed');
} else if (isMain) {
  try { main(); } catch { /* a SessionStart hook must never break a session */ }
}
