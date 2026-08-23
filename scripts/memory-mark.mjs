#!/usr/bin/env node
// Mark a vault note as manually adjudicated: never auto-merge anything into it.
//
//   node scripts/memory-mark.mjs <note-name-or-path> [...]
//   node scripts/memory-mark.mjs --unmark <note-name-or-path> [...]
//
// Its own script rather than a flag on memory-semantic.mjs because it WRITES TO THE VAULT and that
// one only ever writes the index. A search tool that can edit notes is a search tool that one day
// edits notes during a --dupes run.
//
// A script rather than instructions in /memory:prune, because "the agent will remember to add the
// field" is what produced four unmarked keeps on 2026-08-22 — the same shape as the bug this whole
// change is about. One flag cannot half-apply.
import fs from 'node:fs';
import path from 'node:path';
import * as paths from '../hooks/lib/paths.mjs';

const argv = process.argv.slice(2);
const unmark = argv.includes('--unmark');
const names = argv.filter((a) => !a.startsWith('-'));

if (!names.length) {
  console.error('usage: memory-mark.mjs [--unmark] <note-name-or-path> [...]');
  process.exit(1);
}

const VAULT = paths.vault();

/**
 * Notes are addressed by NAME across the whole vault — names are unique vault-wide (the semantic
 * index keys by filename stem), so a search beats making the caller type a path they read out of
 * a --dupes report that prints names.
 *
 * @param {string} name
 * @returns {string | null}
 */
function resolve(name) {
  if (name.endsWith('.md') && fs.existsSync(name)) return name;
  const stem = name.replace(/\.md$/, '');
  /** @type {string[]} */
  const stack = [VAULT];
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === `${stem}.md`) return full;
    }
  }
  return null;
}

const FIELD = 'reconcile: manual';

let changed = 0;
for (const name of names) {
  const file = resolve(name);
  if (!file) {
    console.error(`not found in the vault: ${name}`);
    process.exitCode = 1;
    continue;
  }
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) {
    // Refuse rather than invent a frontmatter block: a note without one is not shaped the way this
    // vault's notes are shaped, and guessing at that is how a second writer corrupts the first's.
    console.error(`no frontmatter, refusing to edit: ${file}`);
    process.exitCode = 1;
    continue;
  }
  const has = /^reconcile:\s*manual\s*$/m.test(m[1]);
  if (unmark) {
    if (!has) {
      console.log(`already unmarked: ${path.basename(file)}`);
      continue;
    }
    fs.writeFileSync(file, raw.replace(/^reconcile:\s*manual\s*\n/m, ''));
  } else {
    if (has) {
      console.log(`already marked: ${path.basename(file)}`);
      continue;
    }
    fs.writeFileSync(file, raw.replace(/\n---\n/, `\n${FIELD}\n---\n`));
  }
  changed++;
  console.log(`${unmark ? 'unmarked' : 'marked'}: ${path.basename(file)}`);
}

console.log(`\n${changed} note(s) changed.`);
