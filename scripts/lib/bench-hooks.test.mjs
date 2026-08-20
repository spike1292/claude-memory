import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertIsolated,
  baselineSpecs,
  bench,
  benchEnv,
  formatTable,
  hookSpecs,
  makeFixture,
  ms,
  sample,
  scratchRoot,
  stats,
  timeOnce,
} from './bench-hooks.mjs';
import { projectKey } from '../../hooks/lib/paths.mjs';
import { resolveSlug } from '../../hooks/lib/semantic-index-refresh.mjs';
import { gatePlan, MIN_MESSAGES } from '../../hooks/lib/distill-session.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-hooks-test-'));
  return d;
};

test('stats reports min, median, p90 and max', () => {
  const s = stats([5, 1, 3, 2, 4]);
  assert.equal(s.n, 5);
  assert.equal(s.min, 1);
  assert.equal(s.median, 3);
  assert.equal(s.max, 5);
  assert.equal(s.p90, 5);
});

test('stats averages the middle pair for an even count', () => {
  assert.equal(stats([1, 2, 3, 4]).median, 2.5);
});

test('stats on nothing is not NaN-crashing but NaN-reporting', () => {
  const s = stats([]);
  assert.equal(s.n, 0);
  assert.ok(Number.isNaN(s.median));
  assert.equal(ms(s.median), '-');
});

test('formatTable emits one markdown row per measurement', () => {
  const out = formatTable([{ name: 'x', n: 2, min: 1, median: 1.25, p90: 1.5, max: 1.5 }]);
  const lines = out.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^\| x \| 2 \| 1\.0 \| 1\.3 \| 1\.5 \| 1\.5 \|$/);
});

test('assertIsolated accepts a scratch env', () => {
  const root = tmp();
  assert.equal(assertIsolated(benchEnv(root), root), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('assertIsolated refuses a path outside the scratch root', () => {
  const root = tmp();
  const env = benchEnv(root);
  env.CLAUDE_VAULT = path.join(os.homedir(), 'Documents', 'ClaudeVault');
  assert.throws(() => assertIsolated(env, root), /CLAUDE_VAULT=.*outside the scratch root/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('assertIsolated refuses an unset variable', () => {
  const root = tmp();
  const env = benchEnv(root);
  delete env.HOME;
  assert.throws(() => assertIsolated(env, root), /HOME must be set/);
  fs.rmSync(root, { recursive: true, force: true });
});

// The root itself is not "inside" the root — a hook given HOME=root would write markers next to
// the vault it is supposed to be isolated from.
test('assertIsolated refuses the scratch root itself', () => {
  const root = tmp();
  const env = benchEnv(root);
  env.HOME = root;
  assert.throws(() => assertIsolated(env, root), /HOME=.*outside the scratch root/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('benchEnv disarms recall inherited from the caller', () => {
  const root = tmp();
  const env = benchEnv(root, { MEMORY_RECALL_ENABLED: '1', PATH: '/usr/bin' });
  assert.equal(env.MEMORY_RECALL_ENABLED, undefined);
  assert.equal(env.PATH, '/usr/bin');
  fs.rmSync(root, { recursive: true, force: true });
});

test('makeFixture writes the note counts it was asked for', () => {
  const root = tmp();
  const f = makeFixture(root, { slug: 'proj', notes: 12 });
  assert.equal(fs.readdirSync(f.memory).filter((n) => n.startsWith('2026-')).length, 12);
  assert.ok(fs.existsSync(path.join(f.memory, 'MEMORY.md')));
  assert.equal(fs.readdirSync(f.mistakes).length, 2);
  assert.ok(fs.existsSync(f.note));
  fs.rmSync(root, { recursive: true, force: true });
});

// The distiller's gate must say "trivial session"; a fixture transcript long enough to trip
// MIN_MESSAGES would detach a real worker on every iteration of the bench. Asserted through
// gatePlan() itself rather than against a copied constant — the first version of this test
// compared with STOP_MIN_MESSAGES (400), which SessionEnd never reaches, and so passed while the
// row it guards was spawning.
test('makeFixture keeps the transcript below the distiller threshold', () => {
  const root = tmp();
  const f = makeFixture(root, { slug: 'proj', notes: 3 });
  assert.ok(fs.readFileSync(f.transcript, 'utf8').trim().split('\n').length < MIN_MESSAGES);
  const plan = gatePlan({
    cwd: root,
    hook_event_name: 'SessionEnd',
    transcript_path: f.transcript,
    session_id: 'bench',
  });
  assert.equal(plan.run, false);
  assert.equal(plan.reason, 'trivial session');
  fs.rmSync(root, { recursive: true, force: true });
});

test('every hook spec names an entry that exists', () => {
  for (const h of hookSpecs({
    cwd: '/tmp/x',
    transcript: '/tmp/t.jsonl',
    note: '/tmp/n.md',
    emptyVault: '/tmp/empty',
  })) {
    assert.ok(fs.existsSync(path.join(pluginRoot, h.entry)), `${h.entry} is missing`);
    assert.doesNotThrow(() => JSON.parse(h.stdin));
  }
});

test('only the armed recall row arms recall', () => {
  const specs = hookSpecs({
    cwd: '/tmp/x',
    transcript: '/tmp/t.jsonl',
    note: '/tmp/n.md',
    emptyVault: '/tmp/empty',
  });
  const armed = specs.filter((s) => s.env?.MEMORY_RECALL_ENABLED === '1');
  assert.equal(armed.length, 1);
  assert.match(armed[0].name, /armed/);
});

test('baseline specs import real module paths', () => {
  const specs = baselineSpecs(pluginRoot);
  assert.equal(specs[0].args[1], '');
  for (const s of specs.slice(1, 3)) {
    const file = /file:\/\/([^"]+)/.exec(s.args[1])?.[1];
    assert.ok(file && fs.existsSync(file), `${s.name} points at nothing`);
  }
});

test('timeOnce reports the child status and a positive wall time', () => {
  const r = timeOnce(process.execPath, ['-e', 'process.exit(3)'], { env: process.env, cwd: '.' });
  assert.equal(r.status, 3);
  assert.ok(r.dt > 0);
});

test('sample returns n samples and counts non-zero exits', () => {
  const s = sample(process.execPath, ['-e', 'process.exit(1)'], { env: process.env, cwd: '.' }, 2);
  assert.equal(s.n, 2);
  assert.equal(s.failures, 2);
});

// The end-to-end guard: every entry path resolves, every hook exits 0 against the fixture, and
// nothing reaches outside the scratch root. n=1 keeps it a test rather than a benchmark.
test('bench runs every row against the fixture and none of them fail', () => {
  const root = scratchRoot();
  try {
    const { rows } = bench({
      root,
      pluginRoot,
      cwd: pluginRoot,
      slug: projectKey(pluginRoot),
      n: 1,
      notes: 5,
    });
    assert.equal(rows.length, 12);
    for (const r of rows) {
      assert.equal(r.failures, 0, `${r.name} exited non-zero`);
      assert.ok(r.median > 0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The reason the semantic row gets its own vault: with the populated one the hook stops being a
// gate and detaches a real indexer. Both halves are asserted, so a future edit that drops the
// override fails here instead of quietly spawning a model load under the bench.
test('the semantic-index-refresh row cannot reach a vault it would index', () => {
  const root = scratchRoot();
  try {
    const slug = projectKey(pluginRoot);
    const f = makeFixture(root, { slug, notes: 3 });
    const spec = hookSpecs({
      cwd: pluginRoot,
      transcript: f.transcript,
      note: f.note,
      emptyVault: f.emptyVault,
    }).find((s) => s.name === 'semantic-index-refresh');
    assert.equal(spec?.env?.CLAUDE_VAULT, f.emptyVault);
    assert.equal(resolveSlug(pluginRoot, f.emptyVault), null);
    assert.equal(resolveSlug(pluginRoot, f.vault), slug);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
