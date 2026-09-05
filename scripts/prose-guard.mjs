#!/usr/bin/env node
// A prose gate — CLI entry. Thin on purpose: argv, git, stdout. Exits 1 when a file this change
// touches carries more comment than code.
//
//   node scripts/prose-guard.mjs [<base-ref>]     default origin/main
//   node scripts/prose-guard.mjs --all            every tracked .mjs, reported, never failing
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { commentRatio, addedLines, overCeiling, CEILING } from './lib/prose-guard.mjs';

const argv = process.argv.slice(2);
const base = argv.find((a) => !a.startsWith('--')) || 'origin/main';
// `quiet` for the probe on a file that did not exist at the base ref: git writes "fatal: path …
// exists on disk, but not in <ref>" to stderr, which lands in the CI log as if the run had failed.
/** @param {string[]} a @param {boolean} [quiet] @returns {string} */
const git = (a, quiet = false) =>
  execFileSync('git', a, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
  });

const read = (/** @type {string} */ f) => ({ file: f, text: fs.readFileSync(f, 'utf8') });

// --all is the backlog view: the files already over on the day the ceiling landed. It never fails,
// because a ratchet that fails on code nobody touched is a ratchet everybody disables.
if (argv.includes('--all')) {
  const over = overCeiling(
    git(['ls-files', '*.mjs'])
      .split('\n')
      .filter((f) => f && fs.existsSync(f))
      .map(read),
  );
  for (const o of over) console.log(`  ${o.ratio.toFixed(2)}  ${o.file}`);
  console.log(
    `\n${over.length} file(s) over ${CEILING.toFixed(2)} — cut each when you next touch it.`,
  );
  process.exit(0);
}

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
    was = `  was ${commentRatio(git(['show', `${base}:${f}`], true)).ratio.toFixed(2)}`;
  } catch {
    /* new file: nothing to compare against */
  }
  console.log(`  ${now.ratio.toFixed(2)}${was}  ${f}`);
}
const over = overCeiling(changed.map(read));
if (!over.length) {
  console.log(`\n  all under the ${CEILING.toFixed(2)} ceiling.`);
  process.exit(0);
}
console.log(`\ncomments outnumber code in ${over.length} file(s) this change touches:`);
for (const o of over) console.log(`  ${o.ratio.toFixed(2)}  ${o.file}`);
// The fix is named, not just the number: "write less" deletes the load-bearing blocks first, which
// is the objection this ceiling had to answer.
console.log(
  `\nCeiling is ${CEILING.toFixed(2)}. Move the facts that are only needed when CHANGING the design to` +
    '\ndocs/decisions/ or docs/architecture.md, and drop what a named test already pins.' +
    '\nA fact worth keeping has a home; deleting it is not the fix.',
);
process.exit(1);
