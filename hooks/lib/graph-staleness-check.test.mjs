// Tests for hooks/lib/graph-staleness-check.mjs.
// Run: node --test hooks/lib/graph-staleness-check.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  recordedCommit,
  isFresh,
  reportFor,
  plan,
  check,
  DEBOUNCE_SECONDS,
  BUSY_MESSAGE,
  STALE_MESSAGE,
} from './graph-staleness-check.mjs';
import { readMarker } from './hook-io.mjs';

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

// The constants above prove nothing about the wiring. What follows drives plan() and check()
// against a real stale repo, a real vault and a real lock file: the two branches this feature IS.
//
// Hermetic by construction — $CLAUDE_MEMORY_HOME, the vault root, the repo and `claude` itself are
// all built per test. The stand-in `claude` is a script that sleeps, so the lock it leaves behind
// is held by a genuinely live process rather than a number written into a file.
const staleRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-repo-'));
  const git = (...args) =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'f'), 'x');
  git('add', '.');
  git('commit', '-qm', 'one');
  return dir;
};

/** A vault holding a report for `cwd` that records a commit this repo has never had. */
const staleReport = (cwd, vaultRoot = emptyVault()) => {
  const dir = path.join(vaultRoot, 'Graph', reportFor(cwd, vaultRoot).slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'GRAPH_REPORT.md'), '---\ncommit: 0000000\n---\n');
  return vaultRoot;
};

/** Run `fn` with a scratch state dir and a `claude` that sleeps instead of indexing. */
const isolated = (fn) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-state-'));
  const bin = path.join(state, 'bin');
  fs.mkdirSync(bin);
  const claude = path.join(bin, 'claude');
  fs.writeFileSync(claude, '#!/bin/sh\nsleep 30\n');
  fs.chmodSync(claude, 0o755);
  const prev = { home: process.env.CLAUDE_MEMORY_HOME, p: process.env.PATH };
  process.env.CLAUDE_MEMORY_HOME = state;
  process.env.PATH = `${bin}${path.delimiter}${prev.p}`;
  try {
    return fn();
  } finally {
    if (prev.home === undefined) delete process.env.CLAUDE_MEMORY_HOME;
    else process.env.CLAUDE_MEMORY_HOME = prev.home;
    process.env.PATH = prev.p;
  }
};

test('check takes the lock, hands it to the child, and the next session stands down', () => {
  const cwd = staleRepo();
  const vaultRoot = staleReport(cwd);
  isolated(() => {
    const { lock, marker } = plan(cwd, { vaultRoot });
    assert.strictEqual(readMarker(marker), 0, 'precondition: this repo has never been regenerated');

    const first = check(cwd, { vaultRoot });
    assert.ok(first.includes(STALE_MESSAGE), 'the session that wins says it is regenerating');
    assert.ok(readMarker(marker) > 0, 'and the 24h per-repo debounce is now set');

    const [pid] = fs.readFileSync(lock, 'utf8').trim().split(/\s+/).map(Number);
    assert.notStrictEqual(pid, process.pid, 'the lock is handed to the CHILD — this process exits');
    assert.doesNotThrow(() => process.kill(pid, 0), 'and that child is alive');

    // The whole point: ANOTHER repo's SessionStart. Its own 24h marker is unset, so the per-repo
    // debounce has nothing to say here — only the machine-wide lock stops it.
    const other = staleRepo();
    staleReport(other, vaultRoot);
    try {
      assert.ok(check(other, { vaultRoot }).includes(BUSY_MESSAGE), 'no second re-index starts');
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }

    // Reclaiming a DEAD owner's lock is not asserted through this path: the killed child stays a
    // zombie while this test process lives, so it still answers kill(pid, 0). Only the real hook,
    // which exits immediately and lets init reap, sees it disappear. That branch is covered
    // directly in hook-io.test.mjs ('a lock whose owner died is reclaimed').
  });
});
