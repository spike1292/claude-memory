#!/usr/bin/env node
// CLI entry for the hook-startup bench. Owns argv, the scratch dir and stdout; the logic is in
// scripts/lib/bench-hooks.mjs.
//
//   node scripts/bench-hooks.mjs [-n 20] [--notes 50] [--cwd .] [--keep]
//
// It never touches the real vault: HOME, CLAUDE_MEMORY_HOME and CLAUDE_VAULT are all redirected
// into a temp root that the lib refuses to run outside of. `--cwd` is the directory the hooks are
// told they are running in — it should be a real git checkout, since that is what project-key
// resolution costs money on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectKey } from '../hooks/lib/paths.mjs';
import { bench, formatTable, ms, scratchRoot } from './lib/bench-hooks.mjs';

const argv = process.argv.slice(2);
const val = (/** @type {string} */ name, /** @type {string} */ dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const n = Number(val('-n', '20'));
const notes = Number(val('--notes', '50'));
const cwd = path.resolve(val('--cwd', process.cwd()));
const keep = argv.includes('--keep');
const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const root = scratchRoot();
const slug = projectKey(cwd);

console.log(`bench-hooks: n=${n} per row, ${notes} L1 notes, slug ${slug}`);
console.log(`  cwd     ${cwd}`);
console.log(
  `  scratch ${root}  (vault, HOME and state all live here — the real vault is untouched)`,
);
console.log(`  node    ${process.version} on ${process.platform}/${process.arch}`);
console.log('');

try {
  const { rows } = bench({
    root,
    pluginRoot,
    cwd,
    slug,
    n,
    notes,
    onRow: (r) => process.stderr.write(`  measured ${r.name}: ${ms(r.median)} ms\n`),
  });
  console.log(formatTable(rows));
  const failed = rows.filter((r) => r.failures);
  if (failed.length)
    console.log(`\nnon-zero exits: ${failed.map((r) => `${r.name} (${r.failures})`).join(', ')}`);
} finally {
  if (keep) console.log(`\nscratch kept at ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
}
