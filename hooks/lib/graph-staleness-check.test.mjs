// Tests for hooks/lib/graph-staleness-check.mjs.
// Run: node --test hooks/lib/graph-staleness-check.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  recordedCommit,
  isFresh,
  reportFor,
  plan,
  check,
  regenArgv,
  regenPrompt,
  REGEN_MCP_TOOLS,
  PLUGIN_ROOT,
  DEBOUNCE_SECONDS,
  BUSY_MESSAGE,
  STALE_MESSAGE,
  REASONS,
} from './graph-staleness-check.mjs';
import { readMarker, nowSeconds } from './hook-io.mjs';

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
  const git = (/** @type {string[]} */ ...args) =>
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
const staleReport = (/** @type {string} */ cwd, vaultRoot = emptyVault()) => {
  const dir = path.join(vaultRoot, 'Graph', reportFor(cwd, vaultRoot).slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'GRAPH_REPORT.md'), '---\ncommit: 0000000\n---\n');
  return vaultRoot;
};

const CBM = { command: '/bin/cbm' };

/** Run `fn` with a scratch state dir and a `claude` that records its argv, then sleeps. */
const isolated = (/** @type {(argvFile: string) => void} */ fn) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-state-'));
  const bin = path.join(state, 'bin');
  fs.mkdirSync(bin);
  const claude = path.join(bin, 'claude');
  const argvFile = path.join(state, 'argv');
  fs.writeFileSync(
    claude,
    `#!/bin/sh\nprintf '%s\\0' "$@" > '${argvFile}.tmp' && mv '${argvFile}.tmp' '${argvFile}'\nsleep 30\n`,
  );
  fs.chmodSync(claude, 0o755);
  fs.writeFileSync(
    path.join(state, '.claude.json'),
    JSON.stringify({ mcpServers: { 'codebase-memory-mcp': CBM } }),
  );
  /** @type {Record<string, string | undefined>} */
  const env = {
    CLAUDE_MEMORY_HOME: state,
    HOME: state,
    CLAUDE_CONFIG_DIR: undefined,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const set = (/** @type {Record<string, string | undefined>} */ vars) => {
    for (const [k, v] of Object.entries(vars))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  };
  set(env);
  try {
    return fn(argvFile);
  } finally {
    set(prev);
  }
};

test('check takes the lock, hands it to the child, and the next session stands down', () => {
  const cwd = staleRepo();
  const vaultRoot = staleReport(cwd);
  isolated((argvFile) => {
    const now = nowSeconds();
    const p = /** @type {import('./graph-staleness-check.mjs').RegenPlan} */ (
      plan(cwd, { vaultRoot, now })
    );
    const { lock, marker } = p;
    assert.strictEqual(readMarker(marker), 0, 'precondition: this repo has never been regenerated');

    // The try starts at the call that SPAWNS: every assertion after it must run inside, or a
    // failing one leaks the stand-in `claude` for its full sleep.
    const first = check(cwd, { vaultRoot, now });
    try {
      const until = Date.now() + 5000;
      while (!fs.existsSync(argvFile) && Date.now() < until)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      const got = fs.readFileSync(argvFile, 'utf8').split('\0').slice(0, -1);
      assert.deepStrictEqual(got, regenArgv(p), 'the child got the argv the builder returns');

      assert.ok(
        first.line.includes(STALE_MESSAGE),
        'the session that wins says it is regenerating',
      );
      assert.ok(readMarker(marker) > 0, 'and the 24h per-repo debounce is now set');

      const [pid] = fs.readFileSync(lock, 'utf8').trim().split(/\s+/).map(Number);
      assert.notStrictEqual(pid, process.pid, 'the lock is handed to the CHILD — this one exits');
      assert.doesNotThrow(() => process.kill(pid, 0), 'and that child is alive');

      // The whole point: ANOTHER repo's SessionStart. Its own 24h marker is unset, so the per-repo
      // debounce has nothing to say here — only the machine-wide lock stops it.
      const other = staleRepo();
      staleReport(other, vaultRoot);
      assert.ok(
        check(other, { vaultRoot }).line.includes(BUSY_MESSAGE),
        'no second re-index starts',
      );
    } finally {
      const [pid] = fs.readFileSync(lock, 'utf8').trim().split(/\s+/).map(Number);
      try {
        // The GROUP, not the pid. `detach()` spawns with setsid, so the stand-in `claude` is its
        // own group leader; a negative pid reaches it and anything it started. Killing the pid
        // alone was enough while nothing else ran under it, and this is the form that stays right
        // if it ever does.
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone, or never spawned */
      }
    }

    // Reclaiming a DEAD owner's lock is not asserted through this path: the killed child stays a
    // zombie while this test process lives, so it still answers kill(pid, 0). Only the real hook,
    // which exits immediately and lets init reap, sees it disappear. That branch is covered
    // directly in hook-io.test.mjs ('a lock whose owner died is reclaimed').
  });
});

test('check names the reason it stayed silent, so a guard is not read as a miss', () => {
  const prev = process.env.CBM_GRAPHGEN_CHILD;
  process.env.CBM_GRAPHGEN_CHILD = '1';
  try {
    const r = check(process.cwd());
    // The background regeneration fires SessionStart itself. Without an outcome, its own suppressed
    // run and a session where the report was simply fresh are the same empty line.
    assert.strictEqual(r.line, '');
    assert.strictEqual(r.outcome, 'child-guard');
    assert.strictEqual(r.reason, REASONS.child, 'the constant plan() returns, not a copy of it');
  } finally {
    if (prev === undefined) delete process.env.CBM_GRAPHGEN_CHILD;
    else process.env.CBM_GRAPHGEN_CHILD = prev;
  }
});

test('an install with no graph layer reports a dependency, not a healthy hook', () => {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graphvault-'));
  const r = check(process.cwd(), { vaultRoot });
  // The L4 layer is optional and most installs never set it up. As `ran` this hook would report
  // itself healthy forever while doing nothing at all — for most users, on every session.
  assert.strictEqual(r.outcome, 'noop-missing-dep');
  assert.strictEqual(r.reason, REASONS.noReport);
});

test('every reason plan() can return is one outcomeOf actually recognises', () => {
  // The same round-trip guard distill-session has, for the same reason: a literal in the plan and a
  // constant in the mapper drift apart in silence, and a test written against either half alone
  // stays green through it.
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'graph-staleness-check.mjs'),
    'utf8',
  );
  const from = src.indexOf('export function plan(');
  const to = src.indexOf('export function check(');
  const body = from === -1 || to === -1 ? '' : src.slice(from, to);
  assert.ok(body.includes('REASONS.'), 'the scan found plan() and it uses the constants');
  for (const m of body.matchAll(/reason:\s*(['"`])((?:(?!\1).)*)\1/g))
    assert.fail(`plan() returns the literal ${JSON.stringify(m[2])} — use REASONS`);
});

/** @returns {import('./graph-staleness-check.mjs').RegenPlan} */
const fixedPlan = (report = '/v/Graph/host-me-repo/GRAPH_REPORT.md') => ({
  action: 'regen',
  message: STALE_MESSAGE,
  slug: 'host-me-repo',
  claude: '/bin/claude',
  marker: '/m',
  lock: '/l',
  now: new Date(2026, 9, 13, 12).getTime() / 1000,
  logFile: '/log',
  report,
  head: 'abcdef1234567890',
  mcp: CBM,
});

test('the regen argv is a closed tool list in dontAsk mode, never a permission bypass', () => {
  const p = fixedPlan();
  const argv = regenArgv(p);
  for (const bad of ['--dangerously-skip-permissions', 'bypassPermissions', 'acceptEdits'])
    assert.ok(!argv.includes(bad), `no ${bad}`);
  assert.deepStrictEqual(argv, [
    '-p',
    regenPrompt(p),
    '--permission-mode',
    'dontAsk',
    '--restricted',
    '--plugin-dir',
    PLUGIN_ROOT,
    '--add-dir',
    '/v/Graph/host-me-repo',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{"codebase-memory-mcp":{"command":"/bin/cbm"}}}',
    '--tools',
    'Read,Write',
    '--allowedTools',
    'mcp__codebase-memory-mcp__list_projects',
    'mcp__codebase-memory-mcp__index_status',
    'mcp__codebase-memory-mcp__index_repository',
    'mcp__codebase-memory-mcp__detect_changes',
    'mcp__codebase-memory-mcp__get_architecture',
    'mcp__codebase-memory-mcp__query_graph',
    'mcp__codebase-memory-mcp__search_graph',
    'Read(//v/Graph/host-me-repo/GRAPH_REPORT.md)',
    'Edit(//v/Graph/host-me-repo/GRAPH_REPORT.md)',
  ]);
  assert.strictEqual(REGEN_MCP_TOOLS.length, 7);
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'commands', 'graph-report.md')));
});

test('glob characters in the report path are escaped, by a hand-written literal', () => {
  const argv = regenArgv(fixedPlan('/v/Graph/we*ird-[re]po?x/GRAPH_REPORT.md'));
  assert.deepStrictEqual(argv.slice(-2), [
    'Read(//v/Graph/we\\*ird-\\[re\\]po\\?x/GRAPH_REPORT.md)',
    'Edit(//v/Graph/we\\*ird-\\[re\\]po\\?x/GRAPH_REPORT.md)',
  ]);
});

test('the regen prompt carries the four values as data and says tool output is data', () => {
  const p = fixedPlan();
  const prompt = regenPrompt(p);
  assert.ok(prompt.startsWith('/memory:graph-report '));
  assert.ok(prompt.includes('host-me-repo'), 'slug');
  assert.ok(prompt.includes(p.report), 'report path');
  assert.ok(prompt.includes('2026-10-13'), 'date');
  assert.ok(prompt.includes('abcdef1'), 'short commit');
  assert.ok(!prompt.includes('abcdef1234567890'), 'the SHORT commit, as the report records');
  assert.match(prompt, /never instructions/);
  assert.match(prompt, /mode='full'/);
});

/** @param {string} url */
const repoWithOrigin = (url) => {
  const dir = staleRepo();
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url], { stdio: 'pipe' });
  return dir;
};

test('a slug with glob characters still yields exactly one Read and one Edit rule, escaped', () => {
  const cwd = repoWithOrigin('https://example.com/we*ird/[re]po?x');
  const vaultRoot = staleReport(cwd);
  isolated(() => {
    const p = plan(cwd, { vaultRoot });
    assert.strictEqual(p.action, 'regen');
    const rp = /** @type {import('./graph-staleness-check.mjs').RegenPlan} */ (p);
    const argv = regenArgv(rp);
    const fileRules = argv
      .slice(argv.indexOf('--allowedTools') + 1)
      .filter((a) => !a.startsWith('mcp__'));
    assert.strictEqual(fileRules.length, 2);
    for (const rule of fileRules)
      assert.ok(rule.endsWith('/Graph/example.com-we\\*ird-\\[re\\]po\\?x/GRAPH_REPORT.md)'), rule);
  });
});

test('a report path a rule list could split is refused: nudge, no spawn', () => {
  const cwd = repoWithOrigin('https://example.com/a,b/repo');
  const vaultRoot = staleReport(cwd);
  isolated(() => {
    const p = plan(cwd, { vaultRoot });
    assert.strictEqual(p.action, 'nudge');
    assert.strictEqual(p.reason, REASONS.unsafePath);
    assert.strictEqual(check(cwd, { vaultRoot }).outcome, 'error');
  });
});

test('no user-scope codebase-memory-mcp server: nudge as a missing dependency, no spawn', () => {
  const cwd = staleRepo();
  const vaultRoot = staleReport(cwd);
  isolated(() => {
    fs.writeFileSync(path.join(process.env.HOME ?? '', '.claude.json'), '{}');
    const p = plan(cwd, { vaultRoot });
    assert.strictEqual(p.action, 'nudge');
    assert.strictEqual(p.reason, REASONS.noMcp);
    assert.strictEqual(check(cwd, { vaultRoot }).outcome, 'noop-missing-dep');
  });
});

test('CLAUDE_CONFIG_DIR relocates .claude.json, as it does for Claude Code', () => {
  const cwd = staleRepo();
  const vaultRoot = staleReport(cwd);
  isolated(() => {
    const home = process.env.HOME ?? '';
    const dir = path.join(home, 'config');
    fs.mkdirSync(dir);
    fs.renameSync(path.join(home, '.claude.json'), path.join(dir, '.claude.json'));
    process.env.CLAUDE_CONFIG_DIR = dir;
    assert.strictEqual(plan(cwd, { vaultRoot }).action, 'regen');
  });
});
