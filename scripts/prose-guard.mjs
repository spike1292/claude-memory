#!/usr/bin/env node
// A diff budget for prose — CLI entry. Thin on purpose: argv, git, stdout. Always exits 0; it is an
// instrument, not a gate (see lib/prose-guard.mjs for why).
//
//   node scripts/prose-guard.mjs [<base-ref>]     default origin/main
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { commentRatio, addedLines } from './lib/prose-guard.mjs';

const base = process.argv[2] || 'origin/main';
/** @param {string[]} a @returns {string} */
const git = (a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const changed = git(['diff', '--name-only', `${base}...HEAD`])
  .split('\n')
  .filter((f) => f.endsWith('.mjs') && fs.existsSync(f));

if (!changed.length) {
  console.log(`prose: no .mjs changed since ${base}.`);
  process.exit(0);
}

const added = addedLines(git(['diff', '-U0', `${base}...HEAD`, '--', ...changed]));
console.log(`prose budget vs ${base}`);
console.log(`  added: ${added.comment} comment / ${added.code} code lines`);
for (const f of changed) {
  const now = commentRatio(fs.readFileSync(f, 'utf8'));
  let was = '  (new)';
  try {
    was = `  was ${commentRatio(git(['show', `${base}:${f}`])).ratio.toFixed(2)}`;
  } catch {
    /* new file: nothing to compare against */
  }
  console.log(`  ${now.ratio.toFixed(2)}${was}  ${f}`);
}
// Named, because a number with no band beside it is a number nobody acts on.
console.log('\n  repo band is 1.00-1.45 comment/code. Above it, run the cut pass (CLAUDE.md).');
