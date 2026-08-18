// Tests for hooks/lib/graph-staleness-check.mjs.
// Run: node --test hooks/lib/graph-staleness-check.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordedCommit,
  isFresh,
  reportFor,
  plan,
  DEBOUNCE_SECONDS,
} from './graph-staleness-check.mjs';

const emptyVault = () => fs.mkdtempSync(path.join(os.tmpdir(), 'graph-vault-'));

test('recordedCommit reads the frontmatter sha, and only at line start', () => {
  assert.strictEqual(recordedCommit('---\ncommit: abc1234\n---\n'), 'abc1234');
  assert.strictEqual(recordedCommit('---\ncommit:   abc1234\n---\n'), 'abc1234');
  // Prose mentioning a commit must not be mistaken for the recorded one.
  assert.strictEqual(recordedCommit('body says commit: deadbee\n'), null);
  assert.strictEqual(recordedCommit('---\nno sha here\n---\n'), null);
  assert.strictEqual(recordedCommit(''), null);
  assert.strictEqual(recordedCommit(undefined), null);
});

test('isFresh compares a full HEAD against a SHORT recorded sha', () => {
  assert.strictEqual(isFresh('abc1234def5678', 'abc1234'), true);
  assert.strictEqual(isFresh('abc1234def5678', 'abc1234def5678'), true);
  assert.strictEqual(isFresh('zzz9999aaa', 'abc1234'), false);
  // Neither side may be empty — an unknown sha is not a match.
  assert.strictEqual(isFresh('', 'abc1234'), false);
  assert.strictEqual(isFresh('abc1234', ''), false);
  assert.strictEqual(isFresh('abc1234', null), false);
});

test('reportFor returns no report when the vault has none', () => {
  const { report } = reportFor(process.cwd(), emptyVault());
  assert.strictEqual(report, null);
});

test('plan stays SILENT when no report exists — it never generates the first one', () => {
  // Deliberate: the first report is a minutes-long unattended run nobody asked for.
  const p = plan(process.cwd(), { vaultRoot: emptyVault() });
  assert.strictEqual(p.action, 'silent');
  assert.strictEqual(p.reason, 'no report yet');
});

test('plan stays silent inside its own background run', () => {
  const prev = process.env.CBM_GRAPHGEN_CHILD;
  process.env.CBM_GRAPHGEN_CHILD = '1';
  try {
    const p = plan(process.cwd(), { vaultRoot: emptyVault() });
    assert.strictEqual(p.action, 'silent');
    assert.strictEqual(p.reason, 'child run', 'the regen run fires SessionStart too');
  } finally {
    if (prev === undefined) delete process.env.CBM_GRAPHGEN_CHILD;
    else process.env.CBM_GRAPHGEN_CHILD = prev;
  }
});

test('the debounce window is 24h', () => {
  assert.strictEqual(DEBOUNCE_SECONDS, 86_400);
});
