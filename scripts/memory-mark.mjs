#!/usr/bin/env node
// Mark a vault note as manually adjudicated: never auto-merge anything into it.
//
//   node scripts/memory-mark.mjs <note-name-or-path> [...]
//   node scripts/memory-mark.mjs --unmark <note-name-or-path> [...]
//
// A script rather than instructions in /memory:prune — CLAUDE.md's Retrieval section (the
// `reconcile: manual` bullet) has why: the instruction version produced four unmarked keeps.
//
// Entry only: argv, stdout, exit code. The logic and its tests live in lib/memory-mark.mjs.
import * as paths from '../hooks/lib/paths.mjs';
import { markNotes } from './lib/memory-mark.mjs';

const argv = process.argv.slice(2);
const unmark = argv.includes('--unmark');
const names = argv.filter((a) => !a.startsWith('-'));

if (!names.length) {
  console.error('usage: memory-mark.mjs [--unmark] <note-name-or-path> [...]');
  process.exit(1);
}

let changed = 0;
for (const r of markNotes(paths.vault(), names, !unmark)) {
  if (r.status === 'missing') {
    console.error(`not found in the vault: ${r.name}`);
    process.exitCode = 1;
  } else if (r.status === 'no-frontmatter') {
    console.error(`no frontmatter, refusing to edit: ${r.file}`);
    process.exitCode = 1;
  } else if (r.status === 'unchanged') {
    console.log(`already ${unmark ? 'unmarked' : 'marked'}: ${r.name}`);
  } else {
    changed++;
    console.log(`${r.status}: ${r.name}`);
  }
}

console.log(`\n${changed} note(s) changed.`);
