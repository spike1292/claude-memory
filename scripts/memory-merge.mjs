#!/usr/bin/env node
// Merge duplicate vault notes into one survivor — /memory:prune step 2, after the human confirms.
//
//   node scripts/memory-merge.mjs [--dry-run] <survivor> <redundant> [...]
//   node scripts/memory-merge.mjs [--dry-run] --plan <file.json>   [["survivor", "redundant", ...], ...]
//
// Entry only: argv, stdout, exit code. The logic and its tests live in lib/memory-merge.mjs.
import fs from 'node:fs';
import * as paths from '../hooks/lib/paths.mjs';
import { todayStr } from '../hooks/lib/distill-session.mjs';
import { applyMerge, planMerge } from './lib/memory-merge.mjs';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const at = argv.indexOf('--plan');
const groups =
  at >= 0
    ? JSON.parse(fs.readFileSync(argv[at + 1], 'utf8'))
    : [argv.filter((a) => !a.startsWith('-'))];

if (!groups.length || !groups[0]?.length) {
  console.error(
    'usage: memory-merge.mjs [--dry-run] (<survivor> <redundant> [...] | --plan <file>)',
  );
  process.exit(1);
}

const vault = paths.vault();
/** @type {import('./lib/memory-merge.mjs').Plan} */
let plan;
try {
  plan = planMerge(vault, groups, todayStr());
} catch (e) {
  console.error(`refusing the whole plan, nothing changed:\n${/** @type {Error} */ (e).message}`);
  process.exit(1);
}

for (const g of plan.groups)
  console.log(`${g.survivor.name}  <=  ${g.redundant.map((r) => r.name).join(', ')}`);
console.log(`\nedit (${plan.edits.length}):`);
for (const f of plan.edits) console.log(`  ${f}`);
console.log(`move to trash (${plan.moves.length}):`);
for (const m of plan.moves) console.log(`  ${m.from}\n    -> ${m.to}`);

if (dry) {
  console.log('\n--dry-run: nothing changed.');
  process.exit(0);
}

const dangling = applyMerge(vault, plan);
console.log(`\nmerged ${plan.groups.length} group(s), moved ${plan.moves.length} note(s).`);
if (dangling.length) {
  console.error(`still linking to a moved note:\n  ${dangling.join('\n  ')}`);
  process.exitCode = 1;
} else console.log('dangling links: none.');
