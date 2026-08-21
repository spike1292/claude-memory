// Tests for scripts/lib/hook-stats.mjs. Run: node --test scripts/lib/hook-stats.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  timeouts,
  summarize,
  nearTimeout,
  render,
  report,
  redact,
  NEAR_FRACTION,
  estTokens,
  BYTES_PER_TOKEN,
  INJECTED_TOKEN_BUDGET,
} from './hook-stats.mjs';

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

test('each event gets its own declared limit, with the tighter one as the fallback', () => {
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
  // The per-hook key stays the tighter of the two, for a line whose event is missing — but a row
  // that knows its event must be judged against ITS budget, or a 4 s Stop reads as a near-miss of
  // a limit that belongs to SessionEnd.
  assert.strictEqual(timeouts(file).get('a'), 5);
  assert.strictEqual(timeouts(file).get('a · Stop'), 30);
  assert.strictEqual(timeouts(file).get('a · SessionEnd'), 5);
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
  assert.deepStrictEqual(names.sort(), [
    'distill-session · SessionEnd',
    'distill-session · worker',
  ]);
  const worker = s.hooks.find(([n]) => n.endsWith('· worker'));
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
  // hooks/ AND scripts/, recursively. The worker line for the re-index is written by
  // scripts/memory-semantic.mjs — the indexer logs itself, since there is no supervisor — so a
  // scan of hooks/ alone walks straight past one of the two names this test exists to protect.
  const logged = new Set();
  for (const root of ['../../hooks', '../../scripts']) {
    const dir = path.join(here, root);
    for (const f of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!f.name.endsWith('.mjs') || f.name.endsWith('.test.mjs')) continue;
      for (const m of fs
        .readFileSync(path.join(f.parentPath, f.name), 'utf8')
        .matchAll(/hook: '([\w.-]+)'/g))
        logged.add(m[1]);
    }
  }
  assert.ok(logged.size >= 7, `found only ${logged.size} logged hook names — the scan broke`);
  for (const name of logged)
    assert.ok(declared.has(name), `"${name}" is logged but hooks.json declares no such hook`);
});

test('a reason never publishes a path, because the report invites a paste', () => {
  // The doc tells the user everything here but the slug is safe to put in a public issue. Raw
  // exception messages are not: an ENOENT carries the vault root, the NOTE FILENAME inside it, and
  // the OS username. The log file on disk keeps the whole message; the report does not.
  assert.strictEqual(
    redact("ENOENT: no such file, open '/Users/someone/Vault/Memory/proj/private-note.md'"),
    "ENOENT: no such file, open '<path>'",
  );
  assert.strictEqual(redact('~/.claude/projects/x/y.jsonl'), '<path>');
  // A vault under `~/My Vault` or `~/Google Drive` is the common case, not an edge one, and the
  // one-pass rule leaked the directory name out of the middle: `<path> Vault<path>`.
  assert.strictEqual(
    redact("ENOENT: open '/Users/bob/My Vault/Memory/proj/secret.md'"),
    "ENOENT: open '<path>'",
  );
  // logHook caps a reason at 200 chars, which cuts the CLOSING QUOTE off a long path — the quoted
  // pass then stops matching and the bare rule publishes the spaced segments it exists to hide. A
  // deep iCloud vault path passes 200 characters on its own.
  const truncated =
    "ENOENT: no such file or directory, open '/Users/bob/Library/Mobile Documents/" +
    'com~apple~CloudDocs/My Private Vault/Memory/proj/a-long-note-name.m';
  assert.strictEqual(redact(truncated), "ENOENT: no such file or directory, open '<path>");

  // And it leaves the reasons that are the whole point of the column alone.
  for (const kept of [
    'transcript missing',
    'wrote 3, merged 0',
    'no index at semantic-proj-bge-m3.db',
    'another --index holds the lock',
  ])
    assert.strictEqual(redact(kept), kept);
});

test('Stop and SessionEnd are separate rows, and Stop keeps its own timeout', () => {
  const s = summarize([
    line({ hook: 'distill-session', event: 'Stop', ms: 37, outcome: 'debounced' }),
    line({ hook: 'distill-session', event: 'Stop', ms: 38, outcome: 'debounced' }),
    line({ hook: 'distill-session', event: 'SessionEnd', ms: 9000, outcome: 'spawned' }),
  ]);
  // Stop fires every assistant turn and does nothing; SessionEnd is the run that reads the
  // transcript. Merged, dozens of 37 ms decisions hid the one invocation that can breach 15 s.
  const rows = Object.fromEntries(s.hooks.map(([n, r]) => [n, r]));
  assert.strictEqual(rows['distill-session · Stop'].n, 2);
  assert.strictEqual(rows['distill-session · SessionEnd'].n, 1);

  const out = render(s, timeouts(MANIFEST));
  // The timeout is declared per HOOK, so both rows still carry it — the row key must not be used
  // to look it up.
  const sessionEnd = out.split('\n').find((l) => l.includes('distill-session · SessionEnd'));
  assert.match(String(sessionEnd), /15s/);
  assert.match(String(sessionEnd), /\s1$/, 'and 9 s of a 15 s budget counts as a near miss');
});

test('estTokens keeps "injected nothing" apart from "never measured"', () => {
  assert.strictEqual(estTokens(4000), 4000 / BYTES_PER_TOKEN);
  assert.strictEqual(estTokens(0), 0, 'a measured zero is a number');
  // Anything unmeasured stays null all the way to the "-" it prints, so it can never average in.
  assert.strictEqual(estTokens(undefined), null);
  assert.strictEqual(estTokens(null), null);
  assert.strictEqual(estTokens(NaN), null);
});

test('a session where the hook ran and injected nothing is a real zero', () => {
  const s = summarize([
    line({ hook: 'insights-surface', ms: 40, bytes: 4000, session: 'a' }),
    line({ hook: 'insights-surface', ms: 40, session: 'b' }),
  ]);
  const out = render(s, new Map());
  // It RAN in both sessions and injected in one, so a session costs 500 tokens on average, not the
  // 1000 it costs on the sessions where it fires. Averaging only over the injecting runs is how
  // an occasional injector came to be billed to every session — and how the per-session total
  // below it overstated by 2.7x on a realistic log.
  assert.match(out, /insights-surface\s+2\s+1\s+500\s/);
  assert.match(out, /~500 estimated tokens of SessionStart context per session/);
});

test('a hook that never recorded bytes is left out, not counted as free', () => {
  // The difference between "injected nothing" and "was not measuring yet". A week of log files
  // written before this field existed sits in the reader's window.
  const out = render(summarize([line({ hook: 'validate-note', ms: 20, session: 'a' })]), new Map());
  assert.match(out, /injected context: not measured/);
});

test('lines from a headless claude run never enter the injected figures', () => {
  const s = summarize([
    line({ hook: 'insights-surface', ms: 40, bytes: 4000, session: 'real' }),
    line({ hook: 'insights-surface', ms: 40, bytes: 4000, session: 'child-1', child: true }),
    line({ hook: 'insights-surface', ms: 40, bytes: 4000, session: 'child-2', child: true }),
  ]);
  // Every distillation fires SessionStart again, so on a real install the child population is
  // roughly one per session — folded in, it doubled every count in this table and the total under
  // it. Those runs are real, they are just not what a person's session cost.
  assert.match(render(s, new Map()), /insights-surface\s+1\s+1\s+1000\s/);
});

test('the injected section labels itself an estimate and the cost section a measurement', () => {
  const out = render(
    summarize([
      line({ hook: 'insights-surface', ms: 40, bytes: 400, session: 'a' }),
      line({ hook: 'distill-session', event: 'extract', usd: 0.04, inTok: 9, outTok: 90 }),
    ]),
    new Map(),
  );
  // The two must never read alike: one is bytes divided by a rule of thumb, the other is what the
  // CLI itself reported.
  assert.match(out, /ESTIMATED tokens/);
  assert.match(out, /MEASURED, from the CLI/);
});

test('the budget warning fires on the per-session total, not on one hook', () => {
  const big = INJECTED_TOKEN_BUDGET * BYTES_PER_TOKEN;
  const under = render(summarize([line({ hook: 'a', bytes: big / 2, session: 's' })]), new Map());
  assert.doesNotMatch(under, /WARNING/);
  const over = render(
    summarize([
      line({ hook: 'a', bytes: big * 0.6, session: 's' }),
      line({ hook: 'b', bytes: big * 0.6, session: 's' }),
    ]),
    new Map(),
  );
  // Neither hook is over on its own; what the session pays is. That sum is the number a user feels.
  assert.match(over, new RegExp(`over the ${INJECTED_TOKEN_BUDGET}-token line`));
});

test('recall is folded in from its own family, and named as an average', () => {
  const out = render(
    summarize([line({ hook: 'insights-surface', bytes: 400, session: 's1' })]),
    new Map(),
    [{ chars: 1200, abstained: false }, { abstained: true }],
  );
  assert.match(out, /recall injected ~300 tok/);
  assert.match(out, /average over sessions, not a per-session figure/);
  // An abstention injected nothing and must not be counted as a prompt that did.
  assert.match(out, /across 1 prompt/);
});

test('no measurements at all reads as "not measured", never as free', () => {
  const out = render(summarize([line({ hook: 'validate-note', ms: 20 })]), new Map());
  assert.match(out, /injected context: not measured/);
  assert.match(out, /distiller cost: not measured/);
  // The distiller line has to say WHY nothing is there, or a debounced night reads as a broken one.
  assert.match(out, /debounced, found no CLI, or failed before the call/);
});

test('a log file written before these fields existed still renders', () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'hooks-2026-08-20.jsonl'),
    JSON.stringify({
      t: '2026-08-20T10:00:00Z',
      slug: 'proj',
      hook: 'insights-surface',
      ms: 40,
      outcome: 'ran',
    }) + '\n',
  );
  const out = report({ logDir: dir, manifest: MANIFEST, slug: 'proj' });
  assert.match(out, /1 invocations for proj/);
  assert.match(
    out,
    /injected context: not measured/,
    'and the new metrics say so rather than lying',
  );
});

test('an extract line is a cost record, not a hook invocation', () => {
  const s = summarize([
    line({
      hook: 'distill-session',
      event: 'SessionEnd',
      ms: 40,
      outcome: 'spawned',
      session: 'a',
    }),
    line({ hook: 'distill-session', event: 'extract', ms: 92_000, usd: 0.04, session: 'a' }),
  ]);
  // Counted as an invocation it took distill-session's 15 s timeout with it, and reported a 92 s
  // API call — inside a worker that is already detached — as a breach of a limit it is not subject
  // to, in the one column the report tells the reader to read as an outage.
  assert.strictEqual(s.invocations, 1);
  assert.deepStrictEqual(
    s.hooks.map(([n]) => n),
    ['distill-session · SessionEnd'],
  );
  const out = render(s, timeouts(MANIFEST));
  assert.doesNotMatch(out, /extract\s+1\s+92000/);
  assert.match(out, /distiller cost \(MEASURED/);
});

test('a usage field missing from some runs is averaged over the runs that had it', () => {
  const out = render(
    summarize([
      line({
        hook: 'distill-session',
        event: 'extract',
        inTok: 9,
        cacheWriteTok: 18078,
        usd: 0.04,
      }),
      line({ hook: 'distill-session', event: 'extract', inTok: 9, usd: 0.04 }),
    ]),
    new Map(),
  );
  // The API omits cache-creation when nothing was cached. Counting that absence as 0 while still
  // counting the run halved the per-run figure for the run that WAS measured — under a heading
  // that says MEASURED, in a PR whose own rule is that absent is never zero.
  const perRun = out.split('\n').find((l) => l.trim().startsWith('per run'));
  assert.match(String(perRun), /18078/, 'averaged over the one run that carried it, not both');
  assert.match(out, /column\(s\) are missing from SOME runs/);
});

test('a column no run reported says so, rather than claiming an averaging', () => {
  const out = render(
    summarize([line({ hook: 'distill-session', event: 'extract', inTok: 9, usd: 0.04 })]),
    new Map(),
  );
  // "3 columns are missing from SOME runs and are averaged over the runs that carried them"
  // describes an averaging that never happened when no run carried them at all.
  assert.match(out, /column\(s\) print "-": no run in this window reported that figure at all/);
  assert.doesNotMatch(out, /missing from SOME runs/);
});

test('the per-day rate divides by the log days read, and names the denominator', () => {
  const lines = [
    { t: '2026-08-19T10:00:00Z', slug: 'proj', hook: 'x', event: 'SessionStart', outcome: 'ran' },
    line({ hook: 'distill-session', event: 'extract', usd: 0.07, t: '2026-08-21T10:00:00Z' }),
  ];
  // The window is counted in FILES, and a day nothing was logged has no file — so the denominator
  // has to come from the files that were read, not from the days the surviving lines happen to
  // mention. A fortnight's spend over the one day the distiller ran is not a daily rate, and the
  // reader cannot tell which was used unless the report says.
  assert.match(render(summarize(lines, null, 7), new Map()), /per day \(÷7 log day\(s\)\)/);
  // With nothing passed it falls back to the days the lines cover, rather than dividing by zero.
  assert.match(render(summarize(lines), new Map()), /per day \(÷2 log day\(s\)\)/);
});

test('a window with only recall measured never prints a zero for the injectors', () => {
  const out = render(
    summarize([line({ hook: 'validate-note', ms: 20, session: 'a' })]),
    new Map(),
    [{ chars: 1200, abstained: false }],
  );
  // Round 2 guarded the table against exactly this and left the summary line printing from the
  // other branch: "not measured", and four lines later "~0 tokens per session across 0
  // injector(s)". In a report whose thesis is that a measured zero and an unmeasured one must
  // never look alike, that sentence is the failure.
  assert.match(out, /SessionStart injectors: not measured/);
  assert.doesNotMatch(out, /~0 estimated tokens/);
  assert.doesNotMatch(out, /across 0 injector/);
  assert.match(out, /recall injected ~300 tok/);
});

test('a billed-but-failed run is counted, and named, in the cost section', () => {
  const out = render(
    summarize([
      line({ hook: 'distill-session', event: 'extract', usd: 0.0389 }),
      line({ hook: 'distill-session', event: 'extract', usd: 0.0412, outcome: 'error' }),
    ]),
    new Map(),
  );
  // Including it is right — the money was spent. Saying nothing is not: it wrote no notes, so
  // "per run" would price a distillation using a run that did not distil, which is the very fold
  // the extract line's outcome field exists to prevent.
  assert.match(out, /2 run\(s\), 1 of which failed after being billed/);
  assert.match(out, /"per run" is not\n.*the price of a distillation/s);
  // And a clean window says nothing about failures at all.
  const clean = render(
    summarize([line({ hook: 'distill-session', event: 'extract', usd: 0.0389 })]),
    new Map(),
  );
  assert.doesNotMatch(clean, /failed after being billed/);
});
