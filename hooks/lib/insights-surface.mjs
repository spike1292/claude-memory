// L3 Mistakes and open-fork surfacing — the logic half. The CLI entry is hooks/insights-surface.mjs.
//
// Nothing here reads argv, stdin or prints: it takes a cwd and returns the text to show, so it is
// importable and testable without a subprocess. Tests: hooks/lib/insights-surface.test.mjs
//
// Ported from shell on 2026-08-17, 124 ms → 52 ms: it forked `grep` + `sed` once per note, up to 45
// subprocesses to print 15 lines. Pinning the vault to local disk moved it 174.0 → 165.2 ms, which
// is what identified it as fork-bound — docs/decisions/2026-08-17-shell-vs-node-hooks.md.
import fs from 'node:fs';
import path from 'node:path';
import { vault, projectKey, legacyKey } from './paths.mjs';
import { defuse } from './memory-recall.mjs';

// ponytail: titles only, capped, silent when there is nothing.
export const LIMIT = 15;

/**
 * The displayed title for one note: frontmatter `title:` if it carries a value, else the filename
 * with its date prefix stripped and dashes spaced out.
 *
 * The empty-value case is why this is a function with a test. `grep -m1 '^title:' | sed` yields an
 * empty string for `title:` with nothing after it, and the shell version then fell through to the
 * filename — a naive port prints a blank bullet instead.
 *
 * @param {string} filename
 * @param {string} raw
 * @returns {string}
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

/**
 * Newest first. Filenames are date-prefixed, so a plain reverse sort is chronological.
 *
 * @param {string[]} names
 * @returns {string[]}
 */
export function orderNewestFirst(names) {
  return names
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse();
}

/**
 * @param {string} slug
 * @param {string[]} files
 * @param {(file: string) => string} read
 * @returns {string}
 */
export function render(slug, files, read) {
  if (!files.length) return '';
  const out = [
    `Past mistakes for this project (L3 memory — avoid repeating; full lessons in Insights/${slug}/Mistakes/ or via /memory:health):`,
  ];
  for (const f of files.slice(0, LIMIT)) out.push(`- ${defuse(noteTitle(f, read(f)))}`);
  if (files.length > LIMIT) out.push(`(+${files.length - LIMIT} older)`);
  return out.join('\n');
}

/**
 * L1 notes whose frontmatter says `status: open`, newest first.
 *
 * @param {string} dir
 * @returns {{ name: string, title: string }[]}
 */
export function openForks(dir) {
  /** @type {{ name: string, title: string, mtime: number }[]} */
  const out = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of names) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    try {
      const file = path.join(dir, f);
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.startsWith('---\n')) continue;
      const end = raw.indexOf('\n---', 3);
      const fm = raw.slice(4, end === -1 ? undefined : end + 1);
      if (!/^status:[ \t]*["']?open["']?[ \t]*$/m.test(fm)) continue;
      // ponytail: mtime orders by last edit, and a fresh clone resets it; add a created: field if that bites
      out.push({ name: f.slice(0, -3), title: noteTitle(f, fm), mtime: fs.statSync(file).mtimeMs });
    } catch {
      /* unreadable note: skip it */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map(({ name, title }) => ({ name, title }));
}

/**
 * @param {string} slug
 * @param {{ name: string, title: string }[]} forks
 * @returns {string}
 */
export function renderForks(slug, forks) {
  if (!forks.length) return '';
  const out = [
    'Open forks for this project (ideas parked mid-session; close with status: closed):',
  ];
  for (const f of forks.slice(0, LIMIT)) out.push(`- ${defuse(f.title)} ([[${defuse(f.name)}]])`);
  if (forks.length > LIMIT) {
    out.push(`(+${forks.length - LIMIT} more in Memory/${slug}/ with status: open)`);
  }
  return out.join('\n');
}

/** @param {string} p */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The text to surface for `cwd`, or '' when there is nothing to say.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function surface(cwd) {
  let slug;
  try {
    slug = projectKey(cwd);
  } catch {
    slug = legacyKey(cwd);
  }
  // Tolerate a not-yet-migrated vault: vault-memory-sync.sh performs the rename, but SessionStart
  // hook order isn't guaranteed, so fall back for this one session.
  const resolve = (/** @type {string[]} */ ...sub) => {
    const dir = path.join(vault(), sub[0], slug, ...sub.slice(1));
    if (isDir(dir)) return { s: slug, dir };
    const s = legacyKey(cwd);
    return { s, dir: path.join(vault(), sub[0], s, ...sub.slice(1)) };
  };
  const m = resolve('Insights', 'Mistakes');
  /** @type {string[]} */
  let files = [];
  try {
    files = orderNewestFirst(fs.readdirSync(m.dir));
  } catch {
    /* no Mistakes folder */
  }
  const mistakes = render(m.s, files, (f) => {
    try {
      return fs.readFileSync(path.join(m.dir, f), 'utf8');
    } catch {
      return '';
    }
  });
  const mem = resolve('Memory');
  return [mistakes, renderForks(mem.s, openForks(mem.dir))].filter(Boolean).join('\n\n');
}
