// Tests for hooks/lib/distill-session.mjs. Run: node --test hooks/lib/distill-session.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as paths from './paths.mjs';
import {
  gatePlan,
  gateOutcome,
  GATE_REASONS,
  MIN_MESSAGES,
  STOP_MIN_MESSAGES,
  STOP_DEBOUNCE_SECONDS,
  slugify,
  extractJson,
  todayStr,
  projectKey,
  findNearDuplicate,
  bodyTokens,
  reconcile,
  transcriptToText,
  parseEnvelope,
} from './distill-session.mjs';
// Git with user and system config neutralised. Both helpers below resolve a remote URL that the
// assertions compare exactly, so a developer with a global `[url] insteadOf` rewrite would see a
// different remote than the test expects and fail on a machine setting rather than on the code.
// It is also spread into the child env of the hook itself: the hook resolves the key by shelling
// out to git, and GIT_CONFIG_GLOBAL overrides the HOME-based lookup, so scratch-HOME alone does not
// cover it. Proved by running the suite under a planted insteadOf — 1 failure before, 0 after, and
// the failure named `vault-insights-evil.example-...`, i.e. the rewrite reaching the assertion
// (2026-08-19, review of #31).
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-'));

test('distill-session', async (t) => {
  await t.test('slugify, extractJson and todayStr', () => {
    assert.strictEqual(slugify('Use $web Container!'), 'use-web-container');
    // \w vs \p{L}: the ASCII-only port of this would return "rsum-cach"
    assert.strictEqual(slugify('Résumé cache'), 'résumé-cache');
    assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepStrictEqual(extractJson('noise {"a": 2} tail'), { a: 2 });
    assert.deepStrictEqual(extractJson('not json'), {});

    assert.strictEqual(todayStr(new Date(2026, 7, 6)), '2026-08-06');
  });

  await t.test('projectKey handles every remote URL form', () => {
    // Expected keys are written out, never compared against another implementation: the sed
    // pipeline this used to defer to became normaliseRemote() in paths.mjs on 2026-08-18, and a
    // comparison would now pass by construction. Same reason paths.test.mjs lost its shell oracle.
    const r = path.join(tmpBase, 'r');
    for (const [url, want] of [
      ['git@gitlab.example.com:TeamName/Frontend.git', 'gitlab.example.com-teamname-frontend'],
      ['https://gitlab.example.com/TeamName/Frontend.git', 'gitlab.example.com-teamname-frontend'],
      [
        'https://user:tok@gitlab.example.com/TeamName/Frontend',
        'gitlab.example.com-teamname-frontend',
      ],
    ]) {
      fs.rmSync(r, { recursive: true, force: true });
      execFileSync('git', ['init', '-q', r], { stdio: 'pipe', env: GIT_ENV });
      execFileSync('git', ['-C', r, 'remote', 'add', 'origin', url], {
        stdio: 'pipe',
        env: GIT_ENV,
      });
      const got = projectKey(r);
      assert.strictEqual(got, want, `${url} -> ${got}, want ${want}`);
    }
    // non-git dir falls back to the legacy cwd-slug
    const plain = path.join(tmpBase, 'plain');
    fs.mkdirSync(plain);
    assert.strictEqual(projectKey(plain), paths.legacyKey(plain));
  });

  const d = path.join(tmpBase, 'notes');
  fs.mkdirSync(d);
  // the two pairs that actually regressed after a /memory:prune merge
  fs.writeFileSync(
    path.join(d, '2026-08-06-parent-pipeline-allow-failure-true-hides-child-job-cancellat.md'),
    '---\ntitle: x\n---\n\n## x\n\nbody\n\n_Also asked as: why did the deploy vanish, parent hid it._\n',
  );
  fs.writeFileSync(
    path.join(d, '2026-08-06-gitlab-resource-groups-process-mode-is-api-only-not-yaml.md'),
    '---\ntitle: y\n---\n\n## y\n\nbody\n',
  );

  await t.test('findNearDuplicate slug arm merges restatements, keeps distinct lessons', () => {
    assert.ok(findNearDuplicate(d, 'parent-pipeline-allow-failure-masks-child-pipeline-cancellat'));
    assert.ok(findNearDuplicate(d, 'resource-group-process-mode-defaults-to-unordered-and-is-api'));
    // distinct lessons that merely share vocabulary must NOT collapse
    assert.strictEqual(findNearDuplicate(d, 'media-cache-key-with-query-aware-allowlist'), null);
    assert.strictEqual(
      findNearDuplicate(d, 'gitlab-ci-trigger-uses-branch-ref-not-commit-sha'),
      null,
    );
  });

  // ---- body arm (RECONCILE_BODY_AT). The pairs below are the real 2026-08-17 audit findings,
  // shortened: a restatement whose TITLE shares nothing with the original, which is the whole class
  // the slug arm could not see. A 2-arg call must keep behaving exactly as it did before.
  const b = path.join(tmpBase, 'bodies');
  fs.mkdirSync(b);
  const mirrors =
    'Config vault and project_key resolution was duplicated in bash, Node and Python.' +
    ' Porting the distiller to Node eliminated a mirror by importing paths.mjs instead of' +
    ' reimplementing it. Mirrors drift; imports do not.';
  fs.writeFileSync(
    path.join(b, '2026-08-16-single-implementation-resolution-beats-mirrored-logic.md'),
    `---\ntitle: m\n---\n\n## m\n\n${mirrors}\n\n_Also asked as: mirror drift, one source of truth._\n`,
  );
  // Same lesson, different words in the title: slug Jaccard is 0.00, body containment clears 0.40.
  const restated =
    '## Collapse multi-runtime mirrors via porting\n\nConfig, vault and project_key' +
    ' resolution existed in bash, Node and Python. Porting distill-session.py to Node removed one' +
    ' mirror without adding abstraction — the new .mjs imports paths.mjs for resolution.\n';
  await t.test('findNearDuplicate body arm catches restatements the slug arm cannot see', () => {
    assert.strictEqual(
      findNearDuplicate(b, 'collapse-multi-runtime-mirrors-via-porting'),
      null,
      'slug arm alone must miss this pair — that is the bug the body arm fixes',
    );
    assert.ok(
      findNearDuplicate(b, 'collapse-multi-runtime-mirrors-via-porting', restated),
      'body arm must catch a restatement whose title shares no vocabulary',
    );

    // A complementary note on the same subject must NOT merge. This is the real KEEP pair that
    // scored highest (0.286) in the calibration, so this asserts the margin under
    // RECONCILE_BODY_AT.
    const complementary =
      '## Cache the fork, do not port the caller\n\nA shell hook that calls' +
      ' project_key forks git and pays the full 34ms each time. Caching it saves 14ms per call' +
      ' across every hook, rather than porting one expensive hook from shell to Node.\n';
    assert.strictEqual(
      findNearDuplicate(b, 'cache-the-fork-do-not-port-the-caller', complementary),
      null,
      'a complementary lesson on the same subject must survive as its own note',
    );
  });

  await t.test('bodyTokens excludes the alias line and headings', () => {
    // The alias line is deliberately over-broad vocabulary; counting it would inflate every pair.
    assert.ok(
      !bodyTokens(
        '---\ntitle: t\n---\n\n## t\n\nreal claim.\n\n_Also asked as: zebra, quokka._\n',
      ).has('zebra'),
      'alias line must not reach the body tokens',
    );
    assert.ok(
      !bodyTokens('## heading-word\n\nclaim.\n').has('heading'),
      'heading restates the title the slug arm already scores',
    );
  });

  await t.test('an unreadable sibling note is skipped, not thrown', () => {
    // Hooks never block, so one bad file must not take the whole check down.
    fs.writeFileSync(path.join(b, '2026-08-16-unreadable.md'), 'x');
    fs.chmodSync(path.join(b, '2026-08-16-unreadable.md'), 0o000);
    assert.ok(
      findNearDuplicate(b, 'collapse-multi-runtime-mirrors-via-porting', restated),
      'an unreadable note must be skipped, not thrown',
    );
    fs.chmodSync(path.join(b, '2026-08-16-unreadable.md'), 0o644);
  });

  await t.test('the entry still runs when reached through a symlinked dir', () => {
    // Plugins are installed through symlinked dirs — a version-pinned cache dir, or a checkout
    // linked into ~/.claude/plugins — and the gate hands node a path that still contains the link.
    // Run the entry through one: it must reach its lib and print the usage line. Assert on OUTPUT,
    // because a broken import path would also exit non-zero and look like the expected failure.
    // ONE arg is the probe: since the shell gate was ported, NO args means "gate on stdin", which
    // is correctly silent — the one-arg form is what still reports usage.
    // Probe the ENTRY, never this test file: symlinking our own directory and re-running
    // `basename(self)` spawns the test file again, and each copy spawns another. That recursion
    // hung for two minutes before it was caught.
    const entry = fileURLToPath(new URL('../distill-session.mjs', import.meta.url));
    const linkRoot = path.join(tmpBase, 'linked');
    fs.symlinkSync(path.dirname(entry), linkRoot, 'dir');
    // The child inherits our env, and NODE_TEST_CONTEXT is set when the test runner is driving.
    // Left in place the child would register tests instead of running main(), print no usage line,
    // and fail this assertion for a reason that has nothing to do with the guard. Strip it.
    const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;
    // One arg prints usage to stderr and exits 1, so execFileSync throws — the output is the
    // signal here, not the status. Silence is the failure being guarded against.
    let viaLink = '';
    try {
      execFileSync(process.execPath, [path.join(linkRoot, path.basename(entry)), 'only-one-arg'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException & { stdout?: string, stderr?: string }} */ (e);
      viaLink = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    assert.match(
      viaLink,
      /^usage:/,
      'the entry must still run when reached through a symlinked dir',
    );
  });

  await t.test('reconcile unions aliases and appends one dated addendum per day', () => {
    const target = path.join(
      d,
      '2026-08-06-parent-pipeline-allow-failure-true-hides-child-job-cancellat.md',
    );
    const before = fs.readdirSync(d).filter((f) => f.endsWith('.md')).length;
    reconcile(
      target,
      'Parent masks child cancellation',
      '## t\n\n**Error:** child jobs died silently\n',
      'pipeline looked green',
      '2026-08-07',
    );
    const out = fs.readFileSync(target, 'utf8');
    assert.strictEqual(
      fs.readdirSync(d).filter((f) => f.endsWith('.md')).length,
      before,
      'reconcile must not create a file',
    );
    assert.ok(
      out.includes('pipeline looked green') && out.includes('why did the deploy vanish'),
      'aliases must union',
    );
    assert.strictEqual(
      out.split('_Also asked as:').length - 1,
      1,
      'must not append a second alias line',
    );
    assert.ok(out.includes('**Also seen 2026-08-07') && out.includes('child jobs died silently'));
    reconcile(target, 'again', '## t\n\nmore\n', '', '2026-08-07');
    assert.strictEqual(
      fs.readFileSync(target, 'utf8').split('**Also seen 2026-08-07').length - 1,
      1,
      'one addendum per day',
    );
  });

  await t.test('transcriptToText flattens and redacts <private>', () => {
    // the one guard with a privacy cost
    const tr = path.join(tmpBase, 't.jsonl');
    fs.writeFileSync(
      tr,
      [
        JSON.stringify({
          message: { role: 'user', content: 'hello <private>my api key</private> bye' },
        }),
        'not json at all',
        JSON.stringify({
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'hi' },
              { type: 'tool_use', name: 'Bash' },
            ],
          },
        }),
      ].join('\n'),
    );
    const flat = transcriptToText(tr);
    assert.ok(!flat.includes('my api key'), '<private> must never survive into the extractor');
    assert.ok(flat.includes('[REDACTED]') && flat.includes('[assistant:tool] Bash'));
  });

  fs.rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------- main

// ---------------------------------------------------------------- the gate

const transcriptWith = (/** @type {number} */ lines) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-gate-'));
  const f = path.join(d, 'transcript.jsonl');
  fs.writeFileSync(f, '{}\n'.repeat(lines));
  return f;
};

test('gatePlan refuses to distil its own extractor run', () => {
  // The headless extractor is a `claude` session whose Stop fires this hook again. Without the
  // guard the distiller distils its own distillation, recursively, at one LLM call per level.
  const prev = process.env.CLAUDE_DISTILL_CHILD;
  process.env.CLAUDE_DISTILL_CHILD = '1';
  try {
    const p = gatePlan({ hook_event_name: 'SessionEnd', transcript_path: transcriptWith(500) });
    assert.strictEqual(p.run, false);
    assert.strictEqual(p.reason, 'child run');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_DISTILL_CHILD;
    else process.env.CLAUDE_DISTILL_CHILD = prev;
  }
});

test('gatePlan honours Claude Code stop_hook_active', () => {
  const p = /** @type {import('./distill-session.mjs').SkipGate} */ (
    gatePlan({
      hook_event_name: 'Stop',
      stop_hook_active: true,
      transcript_path: transcriptWith(500),
    })
  );
  assert.strictEqual(p.run, false);
  assert.strictEqual(p.reason, 'stop_hook_active');
});

test('gatePlan needs a transcript that exists', () => {
  assert.strictEqual(
    /** @type {import('./distill-session.mjs').SkipGate} */ (
      gatePlan({ hook_event_name: 'SessionEnd' })
    ).reason,
    'no transcript path',
  );
  assert.strictEqual(
    /** @type {import('./distill-session.mjs').SkipGate} */ (
      gatePlan({ hook_event_name: 'SessionEnd', transcript_path: '/nope/nope.jsonl' })
    ).reason,
    'transcript missing',
  );
});

test('SessionEnd distils any non-trivial session; Stop does not', () => {
  const short = transcriptWith(MIN_MESSAGES + 5);
  assert.strictEqual(
    gatePlan({ hook_event_name: 'SessionEnd', transcript_path: short }).run,
    true,
    'SessionEnd is authoritative',
  );
  // Stop fires constantly during normal work — it is a crash fallback, not a second trigger.
  const p = gatePlan({ hook_event_name: 'Stop', transcript_path: short });
  assert.strictEqual(p.run, false);
  assert.strictEqual(p.reason, 'stop: session too short');
});

test('a trivial session is skipped on every event', () => {
  const tiny = transcriptWith(MIN_MESSAGES - 1);
  for (const ev of ['SessionEnd', 'Stop']) {
    const p = gatePlan({ hook_event_name: ev, transcript_path: tiny });
    assert.strictEqual(p.run, false, ev);
    assert.strictEqual(p.reason, 'trivial session', ev);
  }
});

test('Stop distils a LONG session, then debounces it', () => {
  const long = transcriptWith(STOP_MIN_MESSAGES + 1);
  const sid = `gate-test-${process.pid}`;
  const now = 1_700_000_000;

  const first = gatePlan(
    { hook_event_name: 'Stop', transcript_path: long, session_id: sid },
    { now },
  );
  assert.strictEqual(first.run, true, 'no marker yet — must run');

  fs.writeFileSync(first.marker, `${now}\n`);
  try {
    const soon = gatePlan(
      { hook_event_name: 'Stop', transcript_path: long, session_id: sid },
      { now: now + STOP_DEBOUNCE_SECONDS - 1 },
    );
    assert.strictEqual(soon.run, false);
    assert.strictEqual(soon.reason, 'stop: debounced');

    const later = gatePlan(
      { hook_event_name: 'Stop', transcript_path: long, session_id: sid },
      { now: now + STOP_DEBOUNCE_SECONDS },
    );
    assert.strictEqual(later.run, true, 'the window is open at exactly the boundary');

    // SessionEnd is never debounced: it is the authoritative pass.
    const end = gatePlan(
      { hook_event_name: 'SessionEnd', transcript_path: long, session_id: sid },
      { now: now + 1 },
    );
    assert.strictEqual(end.run, true);
  } finally {
    fs.rmSync(first.marker, { force: true });
  }
});

// The ctx source label and the indexed directory must carry the SAME identity (item 14, unified
// 2026-08-19). Before that the label was `vault-<layer>-${basename(cwd)}` while the directory was
// `VAULT/<layer>/<project_key>` — so this repo, checked out as `mem-checkout`, indexed
// `Memory/github.com-spike1292-claude-memory` under the source `vault-memory-mem-checkout`: a name
// that named the checkout rather than the notes, and that no other part of the system could
// reconstruct. (It did NOT put two labels in one index — context-mode partitions its content DB by
// checkout path — see the comment on `reindex()`.) Driven end to end through the entry with a fake
// `context-mode` on PATH, because that is the only place the two halves are visible together;
// `reindex()` is deliberately not exported.
//
// This asserts the post-migration case, where `slug` is `projectKey(cwd)`. The invariant is the
// weaker "label == indexed directory": on the pre-migration fallback path `slug` is `legacyKey`
// and both sides move together. That path is not covered here.
test('the ctx source label carries the same key as the directory it indexes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-ctx-'));
  // Registered the moment the scratch world exists, not after the assertions: an rmSync on the last
  // line is skipped whenever an assertion above it throws — exactly when there is something to
  // leak. #30 added t.after for the same reason, after leaked worlds reached 2.7 GB in $TMPDIR
  // (2026-08-19, review of #31).
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'mem-checkout');
  const vault = path.join(root, 'vault');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'ctx.log');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  // Git runs with its user and system config neutralised, not the inherited env. The hook under
  // test resolves project_key from `git remote get-url origin`, so a developer with a global
  // `[url] insteadOf` rewrite would see a different remote here than the assertion expects and the
  // test would fail on a machine setting rather than on the code (2026-08-19, review of #31).
  const git = (/** @type {string[]} */ ...a) =>
    execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe', env: GIT_ENV });
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:spike1292/claude-memory.git');
  const slug = 'github.com-spike1292-claude-memory';
  for (const layer of ['Insights', 'Memory', 'Logs', 'Graph'])
    fs.mkdirSync(path.join(vault, layer, slug), { recursive: true });
  fs.mkdirSync(path.join(vault, 'permanent'), { recursive: true });

  // Records argv instead of indexing. `context-mode` is optional and never installed by CI.
  fs.writeFileSync(
    path.join(bin, 'context-mode'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`,
  );
  fs.chmodSync(path.join(bin, 'context-mode'), 0o755);

  const transcript = path.join(root, 't.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ message: { role: 'user', content: 'x'.repeat(400) } }) + '\n',
  );

  const entry = fileURLToPath(new URL('../distill-session.mjs', import.meta.url));
  execFileSync(process.execPath, [entry, transcript, repo], {
    stdio: 'pipe',
    env: {
      ...GIT_ENV,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: root,
      CLAUDE_MEMORY_HOME: path.join(root, 'state'),
      DISTILL_VAULT: vault,
      DISTILL_DRYRUN: '1',
    },
  });

  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  const sources = calls.map((l) => l.split(' --source ')[1]);
  assert.deepStrictEqual(sources.slice(0, 4), [
    `vault-insights-${slug}`,
    `vault-memory-${slug}`,
    `vault-logs-${slug}`,
    `vault-graph-${slug}`,
  ]);
  assert.strictEqual(sources[4], 'vault-permanent', 'permanent/ keeps its cross-project label');
  // The directory on the same command line carries the same identity — that is the whole point.
  for (const [i, layer] of ['Insights', 'Memory', 'Logs', 'Graph'].entries())
    assert.ok(
      calls[i].includes(path.join(vault, layer, slug)),
      `${layer}: label and directory must agree`,
    );
  // `--project` is still the checkout path (context-mode scopes on it); only the labels moved.
  assert.ok(!sources.join(' ').includes('mem-checkout'), 'no label keyed on the checkout dir name');
});

test('gateOutcome tells a guard from a decision from a debounce', () => {
  // These are the three states that look identical from outside the hook: it exited 0 and printed
  // nothing. Which one it was is the difference between "working as designed" and "off for weeks".
  // Through the CONSTANTS, not through literals: gatePlan() and gateOutcome() have to agree, and a
  // test written against a copy of the string cannot see them stop agreeing.
  assert.strictEqual(gateOutcome({ run: false, reason: GATE_REASONS.child }), 'child-guard');
  assert.strictEqual(gateOutcome({ run: false, reason: GATE_REASONS.stopActive }), 'child-guard');
  assert.strictEqual(gateOutcome({ run: false, reason: GATE_REASONS.debounced }), 'debounced');
  // And end to end for the one branch that needs no fixture, so the wiring itself is exercised.
  process.env.CLAUDE_DISTILL_CHILD = '1';
  try {
    assert.strictEqual(gateOutcome(gatePlan({})), 'child-guard');
  } finally {
    delete process.env.CLAUDE_DISTILL_CHILD;
  }

  // A transcript that never arrives is this hook's missing dependency, not a quiet decision: if
  // Claude Code stopped sending the path, distillation would stop forever while every line said
  // `ran`.
  assert.strictEqual(
    gateOutcome({ run: false, reason: GATE_REASONS.noTranscript }),
    'noop-missing-dep',
  );
  assert.strictEqual(
    gateOutcome({ run: false, reason: GATE_REASONS.badTranscript }),
    'noop-missing-dep',
  );
  const ran = /** @type {const} */ ({
    run: true,
    transcript: '/t',
    marker: '/m',
    now: 1,
    lines: 60,
  });
  assert.strictEqual(
    gateOutcome({ ...ran, spawned: true }),
    'spawned',
    'the gate never claims to have done the work — the worker line says that',
  );
  // And it never claims to have spawned what it failed to spawn. detach() reports a failed fork
  // with a null pid; treating that as `spawned` is a healthy column over a dead distiller.
  assert.strictEqual(gateOutcome({ ...ran, spawned: false }), 'error');
});

test('the distill WORKER really writes its own line, outcome and reason and all', (t) => {
  // The entry's process.on('exit') handler is the only thing that records how long a distillation
  // took, and until now it was covered by nothing but a source grep — which stays green if the
  // handler becomes unreachable, or if the outcome mapping inverts. This runs it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'distillworker-'));
  // Same reason as the test above: #30 added `t.after` after leaked worlds reached 2.7 GB in
  // $TMPDIR, and this one builds a state dir, a logs dir and a vault on every run of the suite.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, 't.jsonl');
  fs.writeFileSync(
    transcript,
    Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: `line ${i}` } }),
    ).join('\n') + '\n',
  );
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '../distill-session.mjs');
  execFileSync(process.execPath, [entry, transcript, process.cwd()], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      CLAUDE_MEMORY_HOME: path.join(root, 'state'),
      DISTILL_DRYRUN: '1',
      DISTILL_VAULT: path.join(root, 'vault'),
      MEMORY_HOOK_SESSION: 'sess-worker',
    },
  });

  const logDir = path.join(root, 'state', 'logs');
  const [file] = fs.readdirSync(logDir).filter((f) => f.startsWith('hooks-'));
  const rec = JSON.parse(fs.readFileSync(path.join(logDir, file), 'utf8').trim().split('\n')[0]);
  assert.strictEqual(rec.hook, 'distill-session');
  assert.strictEqual(rec.event, 'worker', 'a worker line, not a gate line');
  assert.strictEqual(rec.outcome, 'ran');
  assert.strictEqual(rec.session, 'sess-worker', 'correlated to its gate through the environment');
  assert.match(String(rec.reason), /^wrote \d+, merged \d+$/);
  // The duration has to be the WORK. A gate decides in ~40 ms; this process did the distillation.
  assert.ok(rec.ms > 0);
});

test('every reason gatePlan can return is one gateOutcome actually recognises', () => {
  // The round trip, not the two halves separately. Round 5 added `stopShort` to the mapper and left
  // the plan emitting the literal, so the branch it shipped to fix never fired — with both existing
  // tests green, because one asserts the literal and the other only ever feeds in constants.
  const seen = new Set(Object.values(GATE_REASONS));
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'distill-session.mjs'),
    'utf8',
  );
  const from = src.indexOf('export function gatePlan');
  const to = src.indexOf('export function gate(');
  const planBody = from === -1 || to === -1 ? '' : src.slice(from, to);
  // A scan that silently covers NOTHING is the failure this test was written to prevent, one level
  // up: rename gatePlan and `slice(-1, n)` returns '', matchAll finds nothing, and the test goes
  // green over a body it never read.
  assert.ok(
    planBody.includes('GATE_REASONS.'),
    'the scan found gatePlan and it uses the constants',
  );

  // Every quoting form, not just the single quotes prettier happens to produce today: a template
  // literal (`stop: ${n} lines`) would evade a quote-only scan and reach gateOutcome unrecognised.
  for (const m of planBody.matchAll(/reason:\s*(['"`])((?:(?!\1).)*)\1/g))
    assert.fail(`gatePlan returns the literal ${JSON.stringify(m[2])} — use GATE_REASONS`);

  // And the stand-downs really do map away from `ran`, which is documented as "did its work".
  for (const r of [GATE_REASONS.stopShort, GATE_REASONS.trivial, GATE_REASONS.debounced])
    assert.strictEqual(gateOutcome({ run: false, reason: r }), 'debounced', r);
  // A transcript that is absent, unreadable, or not a file at all is the same outage.
  for (const r of [GATE_REASONS.noTranscript, GATE_REASONS.badTranscript, GATE_REASONS.notAFile])
    assert.strictEqual(gateOutcome({ run: false, reason: r }), 'noop-missing-dep', r);
  assert.ok(seen.size >= 6, 'the constant table still covers every branch');
});

test('parseEnvelope reads the JSON output envelope, usage and all', () => {
  const env = parseEnvelope(
    JSON.stringify({
      type: 'result',
      is_error: false,
      result: '{"patterns":[],"mistakes":[],"decisions":[]}',
      total_cost_usd: 0.0389,
      usage: {
        input_tokens: 9,
        cache_creation_input_tokens: 18078,
        cache_read_input_tokens: 22363,
        output_tokens: 90,
      },
    }),
  );
  assert.deepStrictEqual(env?.usage, {
    inTok: 9,
    cacheWriteTok: 18078,
    cacheReadTok: 22363,
    outTok: 90,
    usd: 0.0389,
  });
  // The model's own answer is the `result` STRING, and the existing brace extractor reads it.
  assert.deepStrictEqual(extractJson(/** @type {string} */ (env?.text)), {
    patterns: [],
    mistakes: [],
    decisions: [],
  });
});

test('parseEnvelope returns null for plain stdout, which is the fallback signal', () => {
  // A CLI that does not wrap its output must cost a cost figure, never a night's insights. Null
  // here is what makes runExtractor hand the raw text to the brace extractor instead.
  assert.strictEqual(parseEnvelope('Here you go:\n```json\n{"patterns":[]}\n```'), null);
  assert.strictEqual(parseEnvelope(''), null);
  assert.strictEqual(parseEnvelope('not json at all'), null);
  // And the fallback really does still parse that stdout.
  assert.deepStrictEqual(extractJson('Here you go:\n```json\n{"patterns":[]}\n```'), {
    patterns: [],
  });
});

test('the model answering with a bare object is not mistaken for an envelope', () => {
  // The answer is itself JSON. Without the `typeof result === "string"` test, an answer that
  // happened to carry a `result` key would be read as a wrapper and the extractor handed nothing.
  const answer = '{"patterns":[{"title":"t","description":"d"}],"result":42}';
  assert.strictEqual(parseEnvelope(answer), null);
  assert.strictEqual(extractJson(answer).patterns?.length, 1);
});

test('an envelope with no usage block still yields its text', () => {
  // Insights first: a wrapper whose usage shape changed must not lose the notes, and a cost of
  // zero must never be invented for it.
  const env = parseEnvelope(JSON.stringify({ result: '{"mistakes":[]}' }));
  assert.strictEqual(env?.usage, null);
  assert.deepStrictEqual(extractJson(/** @type {string} */ (env?.text)), { mistakes: [] });
});
