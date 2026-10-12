// #95: /memory:health reads what the scans name, not the whole corpus.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands');
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(COMMANDS, f), 'utf8');

test('health step 0 runs all four scans', () => {
  const step0 = read('health.md').split(/\n1\. \*\*Gather/)[0];
  for (const scan of ['memory-audit-checks.mjs', '--coverage', '--dupes', '--clusters'])
    assert.ok(step0.includes(scan), `step 0 is missing ${scan}`);
});

test('neither command tells the agent to read every note', () => {
  for (const f of ['health.md', 'prune.md'])
    assert.doesNotMatch(read(f), /\bevery note under\b/i, f);
});

test('the --dupes header health tells the agent to read N from is the one the scan prints', () => {
  const header = 'same-folder pairs ≥ ';
  assert.ok(read('health.md').includes(header));
  const src = fs.readFileSync(path.join(COMMANDS, '..', 'scripts', 'memory-semantic.mjs'), 'utf8');
  assert.ok(src.includes(header));
});

test('prune points at the one statement of the read scope in health', () => {
  assert.match(read('health.md'), /full-corpus read is not the intended path/i);
  assert.match(read('prune.md'), /health\.md.*full-corpus read/is);
});
