// L3 Mistakes surfacing — the logic half. The CLI entry is hooks/insights-surface.mjs.
//
// Nothing here reads argv, stdin or prints: it takes a cwd and returns the text to show, so it is
// importable and testable without a subprocess. Tests: hooks/lib/insights-surface.test.mjs
//
// Ported from insights-surface.sh on 2026-08-17: 160 ms → 48 ms. It forked `grep` + `sed` once per
// note, up to 45 subprocesses to print 15 lines. Pinning the vault to local disk bought it 9 ms of
// its 174 ms, which is what identified it as fork-bound rather than I/O-bound — see
// docs/decisions/2026-08-17-shell-vs-node-hooks.md.
import fs from 'node:fs';
import path from 'node:path';
import { vault, projectKey, legacyKey } from './paths.mjs';

// ponytail: titles only, capped, silent when there is nothing.
export const LIMIT = 15;

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
  return filename
    .replace(/\.md$/, '')
    .replace(/^[0-9-]*/, '')
    .replace(/-/g, ' ');
}

/** Newest first. Filenames are date-prefixed, so a plain reverse sort is chronological. */
export function orderNewestFirst(names) {
  return names
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse();
}

export function render(slug, files, read) {
  if (!files.length) return '';
  const out = [
    `Past mistakes for this project (L3 memory — avoid repeating; full lessons in Insights/${slug}/Mistakes/ or via /memory:health):`,
  ];
  for (const f of files.slice(0, LIMIT)) out.push(`- ${noteTitle(f, read(f))}`);
  if (files.length > LIMIT) out.push(`(+${files.length - LIMIT} older)`);
  return out.join('\n');
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The text to surface for `cwd`, or '' when there is nothing to say. */
export function surface(cwd) {
  let slug;
  try {
    slug = projectKey(cwd);
  } catch {
    slug = legacyKey(cwd);
  }
  const dirFor = (s) => path.join(vault(), 'Insights', s, 'Mistakes');
  let dir = dirFor(slug);
  // Tolerate a not-yet-migrated vault: vault-memory-sync.sh performs the rename, but SessionStart
  // hook order isn't guaranteed, so fall back for this one session.
  if (!isDir(dir)) {
    slug = legacyKey(cwd);
    dir = dirFor(slug);
  }
  if (!isDir(dir)) return '';

  let files;
  try {
    files = orderNewestFirst(fs.readdirSync(dir));
  } catch {
    return '';
  }
  return render(slug, files, (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return '';
    }
  });
}
