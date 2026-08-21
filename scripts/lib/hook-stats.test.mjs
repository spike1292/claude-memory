// Tests for scripts/lib/hook-stats.mjs. Run: node --test scripts/lib/hook-stats.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timeouts, summarize, nearTimeout, render, report, NEAR_FRACTION } from './hook-stats.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(here, '../../hooks/hooks.json');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hookstats-'));

/** @param {Partial<import('./hook-stats.mjs').HookLine>} o */
const line = (o) => ({ t: '2026-08-20T10:00:00.000Z', slug: 'proj', outcome: 'ran', ...o });

test('timeouts come from the real manifest, and are never written down twice', () => {
  const t = timeouts(MANIFEST);
  // The assertion is that the manifest is READ, not that any particular number is 10 or 15 — a
  // hard-coded limit here would be the second place a timeout lives, which is the bug this avoids.
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  /** @type {number[]} */
  const declared = [];
  for (const group of Object.values(manifest.hooks))
    for (const m of /** @type {any[]} */ (group)) for (const h of m.hooks) declared.push(h.timeout);

  assert.ok(t.size >= 7, 'every hook the manifest names gets a limit');
  assert.ok(t.has('memory-recall') && t.has('vault-memory-sync'), 'both .mjs and .sh commands');
  for (const [, secs] of t) assert.ok(declared.includes(secs), `${secs} is a declared timeout`);
});

test('a hook declared under two events is held to the tighter limit', () => {
  // distill-session is on SessionEnd and Stop. If those ever differ, the one it can actually
  // breach is the smaller — a max would report near-misses that are really breaches. Proved
  // against a SYNTHETIC manifest: asserting the real 15 here would put a timeout in a second
  // place, which is the thing this whole reader is built to avoid.
  const written = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
  const file = path.join(written, 'hooks.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ command: 'node "${X}/hooks/a.mjs"', timeout: 30 }] }],
        SessionEnd: [{ hooks: [{ command: 'node "${X}/hooks/a.mjs"', timeout: 5 }] }],
      },
    }),
  );
  assert.strictEqual(timeouts(file).get('a'), 5);
});

test('an unreadable manifest costs the timeout column, not the report', () => {
  assert.strictEqual(timeouts('/no/such/hooks.json').size, 0);
  assert.doesNotThrow(() => timeouts('/no/such/hooks.json'));
});

test('summarize keeps a gate and its worker apart', () => {
  const s = summarize([
    line({ hook: 'distill-session', event: 'SessionEnd', ms: 40, outcome: 'spawned' }),
    line({ hook: 'distill-session', event: 'worker', ms: 90_000 }),
  ]);
  const names = s.hooks.map(([n]) => n);
  // Averaging a 40 ms gate decision with a 90-second distillation would describe neither. They are
  // two measurements of two different things that happen to carry the same hook name.
  assert.deepStrictEqual(names.sort(), ['distill-session', 'distill-session (worker)']);
  const worker = s.hooks.find(([n]) => n.endsWith('(worker)'));
  assert.strictEqual(worker?.[1].worker, true);
});

test('summarize scopes to a slug and says how much it dropped', () => {
  const lines = [
    line({ hook: 'validate-note', ms: 20 }),
    line({ hook: 'validate-note', ms: 20, slug: 'other' }),
    line({ hook: 'validate-note', ms: 20, slug: 'other' }),
  ];
  const scoped = summarize(lines, 'proj');
  assert.strictEqual(scoped.invocations, 1);
  assert.strictEqual(scoped.otherProjects, 2, 'the log is machine-wide and the report says so');
  assert.strictEqual(summarize(lines).invocations, 3, 'no slug keeps every project');
});

test('a line with no ms is counted as untimed, never as a fast hook', () => {
  const s = summarize([line({ hook: 'x', ms: 10 }), line({ hook: 'x' })]);
  assert.strictEqual(s.untimed, 1);
  assert.strictEqual(s.hooks[0][1].n, 2);
  assert.deepStrictEqual(s.hooks[0][1].latencies, [10], 'a missing ms is absent, not zero');
});

test('nearTimeout is null without a limit, and 0 is a measurement', () => {
  // "-" and "0" must not print the same: one says nothing was compared, the other says nothing
  // came close.
  assert.strictEqual(nearTimeout([9000], undefined), null);
  assert.strictEqual(nearTimeout([100, 200], 10), 0);
  assert.strictEqual(nearTimeout([5000, 100], 10), 1, `5 s is ${NEAR_FRACTION} of a 10 s timeout`);
  assert.strictEqual(nearTimeout([4999], 10), 0, 'the boundary is inclusive on the near side only');
});

test('render says "not measured" rather than inventing a zero', () => {
  assert.match(render(summarize([]), new Map()), /not measured/);
  // A window that holds only other projects' lines is a different diagnosis from an empty window,
  // and reading the first as the second sends someone looking for a broken hook.
  const other = render(summarize([line({ hook: 'x', slug: 'zzz' })], 'proj'), new Map());
  assert.match(other, /belong to proj/);
  assert.match(other, /machine-wide/);
});

test('render names the hook that is not instrumented', () => {
  const out = render(summarize([line({ hook: 'validate-note', ms: 20 })]), timeouts(MANIFEST));
  // Otherwise the bash hook's absence from the table reads as a hook that never fires.
  assert.match(out, /vault-memory-sync/);
  assert.match(out, /not instrumented/);
  // And the one detached hook whose worker cannot be timed, for the same reason: its absence must
  // not read as a background run that never happened.
  assert.match(out, /graph-staleness-check \(its background run is timed by nothing\)/);
});

test('report reads a real log directory and exits with a section either way', () => {
  const dir = tmp();
  assert.match(
    report({ logDir: dir, manifest: MANIFEST }),
    /no hook logs in/,
    'an empty state is a sentence, not a crash',
  );
  fs.writeFileSync(
    path.join(dir, 'hooks-2026-08-20.jsonl'),
    [
      JSON.stringify(line({ hook: 'memory-link-lint', ms: 10_900 })),
      '{ this line is torn',
      JSON.stringify(line({ hook: 'memory-link-lint', ms: 74 })),
    ].join('\n') + '\n',
  );
  const out = report({ logDir: dir, manifest: MANIFEST, slug: 'proj' });
  assert.match(out, /2 invocations for proj/, 'the torn line is skipped, not thrown on');
  // 10.9 s against a 10 s timeout — the measured cost of this hook on a 49-note project, and the
  // reason the near-timeout column exists at all.
  assert.match(out, /10900\.0/);
  const row = out.split('\n').find((l) => l.includes('memory-link-lint') && l.includes('10s'));
  assert.match(String(row), /\s1$/, 'one invocation ran at or past half its declared timeout');
});

test('a row with a timeout but no timings reports "-", not a clean zero', () => {
  // p50/p95/max all print "-" here. A confident 0 beside them reads as measured and fine.
  assert.strictEqual(nearTimeout([], 10), null);
});

test('render counts the lines a background run produced, apart from the sessions', () => {
  const out = render(
    summarize([
      line({ hook: 'insights-surface', ms: 40 }),
      line({ hook: 'insights-surface', ms: 40, child: true }),
    ]),
    new Map(),
  );
  assert.match(out, /1 of 2 were fired by a background/);
});

test('render admits that the sample is censored at the timeout', () => {
  // The one thing this report cannot see is the thing it looks like it is measuring: a hook killed
  // at its limit writes no line at all, so the near-timeout column counts survivors only.
  const out = render(summarize([line({ hook: 'memory-link-lint', ms: 9000 })]), timeouts(MANIFEST));
  assert.match(out, /CENSORED AT THE TIMEOUT/);
});

test('every hook name an entry logs is a name the manifest declares', () => {
  // The JOIN KEY, which is the half the "timeouts are never written down twice" rule does not
  // cover: the number lives only in hooks.json, but the NAME lives in a string literal in each
  // entry AND in the manifest's command path. Rename hooks/memory-link-lint.mjs and update
  // hooks.json, and this report silently prints "-" for the timeout of a hook that still has one.
  const declared = timeouts(MANIFEST);
  // RECURSIVE: the two `hook:` literals that matter most sit in hooks/lib/, on the worker lines,
  // and a non-recursive scan walked straight past exactly the names it was written to protect.
  const dir = path.join(here, '../../hooks');
  const logged = new Set();
  for (const f of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!f.name.endsWith('.mjs') || f.name.endsWith('.test.mjs')) continue;
    for (const m of fs
      .readFileSync(path.join(f.parentPath, f.name), 'utf8')
      .matchAll(/hook: '([\w.-]+)'/g))
      logged.add(m[1]);
  }
  assert.ok(logged.size >= 7, `found only ${logged.size} logged hook names — the scan broke`);
  for (const name of logged)
    assert.ok(declared.has(name), `"${name}" is logged but hooks.json declares no such hook`);
});
