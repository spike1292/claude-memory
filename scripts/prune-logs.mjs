#!/usr/bin/env node
// Archive session logs older than N days (default 90) into <logs-dir>/Archive/.
// Moving only (reversible); never deletes. Usage: prune-logs.mjs <logs-dir>
import fs from 'node:fs';
import { parseDays, pruneLogs } from './lib/prune-logs.mjs';

/** @typedef {import('./lib/prune-logs.mjs').PrunePartialError} PrunePartialError */

const dir = process.argv[2];
if (!dir) {
  console.error('usage: prune-logs.mjs <logs-dir>');
  process.exit(1);
}
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.log(`no logs dir: ${dir}`);
  process.exit(0);
}

const raw = process.env.PRUNE_DAYS ?? '';
const days = parseDays(raw);
if (!Number.isInteger(days)) {
  console.error(`PRUNE_DAYS must be a whole number of days, got: ${JSON.stringify(raw)}`);
  process.exit(1);
}

/** @param {import('./lib/prune-logs.mjs').PruneResult} result */
function report({ moved, skipped, collisions }) {
  console.log(`archived ${moved.length} log(s) older than ${days}d from ${dir}`);
  for (const n of skipped) console.log(`skipped (no usable date in filename): ${n}`);
  for (const n of collisions) console.log(`skipped (already in Archive/, left in place): ${n}`);
}

try {
  report(pruneLogs(dir, { days }));
} catch (err) {
  // A mid-run failure still has to say what already moved, or the move is not reversible in
  // practice — `err.partial` is the result so far, attached by pruneLogs().
  const e = /** @type {PrunePartialError} */ (err);
  if (e.partial) report(e.partial);
  console.error(`prune failed: ${e.message}`);
  process.exit(1);
}
