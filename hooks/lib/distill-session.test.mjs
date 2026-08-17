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
  slugify,
  extractJson,
  todayStr,
  projectKey,
  findNearDuplicate,
  bodyTokens,
  reconcile,
  transcriptToText,
} from './distill-session.mjs';

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

  await t.test('projectKey agrees with vault-env.sh across URL forms', () => {
    // project_key must agree with hooks/lib/vault-env.sh across URL forms. It now IS vault-env.sh,
    // so this asserts that sed pipeline rather than a second copy of it.
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
      execFileSync('git', ['init', '-q', r], { stdio: 'pipe' });
      execFileSync('git', ['-C', r, 'remote', 'add', 'origin', url], { stdio: 'pipe' });
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
    // linked into ~/.claude/plugins — and distill-session.sh hands node a BASH_SOURCE-derived path
    // that still contains the link. Run the entry with no args through one: it must reach its lib
    // and print the usage line. Assert on OUTPUT, because a broken import path would also exit
    // non-zero and look like the expected failure.
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
    // No args means main() prints usage to stderr and exits 1, so execFileSync throws — the output
    // is the signal here, not the status. Silence is the failure being guarded against.
    let viaLink = '';
    try {
      execFileSync(process.execPath, [path.join(linkRoot, path.basename(entry))], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (e) {
      viaLink = `${e.stdout ?? ''}${e.stderr ?? ''}`;
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
