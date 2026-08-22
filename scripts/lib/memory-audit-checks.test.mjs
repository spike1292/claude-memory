// Tests for scripts/lib/memory-audit-checks.mjs.
// Run: node --test scripts/lib/memory-audit-checks.test.mjs
//
// Three audits hand-wrote these checks and two got the same two wrong: `confidence:` is nested under
// `metadata:` (so a ^-anchored grep reports every note as missing it), and a path regex swallows the
// `…/` in abbreviated prose paths (15 of 24 "missing" paths in the 2026-08-14 audit). Both are
// encoded here. If you extend the checks, add an assertion.
import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  isStandingNegative,
  hasConfidence,
  isAbbreviated,
  parseDeferred,
  supersessionState,
  freshnessFindings,
  isUnprovenancedMetric,
  isUnstampedVolatileClaim,
  buildSuffixIndex,
  mocTargets,
  stripCodeBlocks,
} from './memory-audit-checks.mjs';

test('isStandingNegative separates claims from instructions', () => {
  // standing negatives — real claims
  assert.ok(isStandingNegative('- **cra2 prod has never served traffic** — 0–3 requests/24h'));
  assert.ok(
    isStandingNegative(
      'ESLint ban on `@integration/*` = recommended but **not yet added** (deferred).',
    ),
  );
  assert.ok(isStandingNegative('There is no NAT gateway yet in this account.'));
  // instructions — must NOT fire
  assert.ok(!isStandingNegative('**Never cite an ADR from its filename.** Verified 2026-08-08.'));
  assert.ok(!isStandingNegative('- Do not treat "Zscaler is on" as sufficient explanation.'));
  assert.ok(!isStandingNegative('Always measure before quoting a cost figure.'));
  assert.ok(!isStandingNegative('_Also asked as: has this never worked?_'));
});

test('hasConfidence sees the nested metadata: form', () => {
  // confidence
  assert.ok(hasConfidence('metadata: \n  node_type: memory\n  confidence: high\n  type: project'));
  assert.ok(!hasConfidence('metadata: \n  type: project'));
});

test('isAbbreviated catches elided prose paths', () => {
  // abbreviation
  assert.ok(isAbbreviated('`libs/core/observability/.../sentry-integration.ts`'));
  assert.ok(!isAbbreviated('`libs/server/core/src/routes/well-known.ts`'));
});

test('buildSuffixIndex maps a bare filename to real paths', () => {
  // suffix index — the real recurring case: a note wrote `scripts/cra2-alias-move.sh`
  const idx = buildSuffixIndex([
    'docs/devops/cra2-migration/scripts/cra2-alias-move.sh',
    'libs/server/core/index.ts',
  ]);
  assert.deepEqual(idx.get('scripts/cra2-alias-move.sh'), [
    'docs/devops/cra2-migration/scripts/cra2-alias-move.sh',
  ]);
  assert.deepEqual(idx.get('core/index.ts'), ['libs/server/core/index.ts']);
  assert.equal(idx.get('docs/devops/cra2-migration/scripts/cra2-alias-move.sh'), undefined); // exact hit is not a suffix
});

test('parseDeferred reads back only still-open rows', () => {
  // deferred-row ledger
  const rows = parseDeferred(
    [
      '| 2026-08-14 | shipped a ledger | deferred items leaking between runs |', // summary table, no owning entry
      '## 2026-08-08 — audit',
      '| Finding | Category | Disposition |',
      '| --- | --- | --- |',
      '| three dup pairs | duplicate | **deferred** to `/memory:prune` |',
      '| a fixed thing | orphan | **applied** — linked |',
      '## 2026-08-09 — audit',
      '| later pair | duplicate | **declined** — complementary, not deferred |',
      '| open pair | duplicate | **deferred** |',
    ].join('\n'),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].entry, '2026-08-08 audit');
  assert.equal(rows[0].finding, 'three dup pairs');
  assert.equal(rows[1].entry, '2026-08-09 audit');
});

test('supersessionState distinguishes prose from a declared marker', () => {
  // supersession: prose-only vs declared
  const proseOnly = supersessionState(
    '---\nname: x\n---\n## ⚠ SUPERSEDED — the cutover reversed this\nbody',
  );
  assert.equal(proseOnly.inProse, true);
  assert.equal(proseOnly.declared, null);
  const declared = supersessionState(
    '---\nname: x\nsuperseded_by: cra2-prd-cutover-run\nsuperseded_on: 2026-08-14\n---\n## ⚠ SUPERSEDED\nbody',
  );
  assert.equal(declared.declared, 'cra2-prd-cutover-run');
  assert.equal(declared.on, '2026-08-14');
  assert.equal(supersessionState('---\nname: x\n---\njust a normal note').inProse, false);
  // an inline per-claim marker satisfies the check without lying at note level
  const marked = supersessionState(
    '---\nname: x\n---\n## ⚠ SUPERSEDED\ncra2 served no traffic (measured 2026-08-12, superseded 2026-08-14 by [[cra2-prd-cutover-run]])',
  );
  assert.equal(marked.marked, true);
  assert.equal(marked.declared, null, 'the note itself is still valid — only one claim died');
  assert.equal(supersessionState('---\nname: x\n---\n## SUPERSEDED\nno marker here').marked, false);
  // component replacement is not claim supersession — these must NOT be flagged
  assert.equal(
    supersessionState(
      '---\nn: x\n---\nCore Modules already superseded by `@integration/api-client-*`.',
    ).inProse,
    false,
  );
  assert.equal(
    supersessionState('---\nn: x\n---\nthe redirects-poller superseded in cra2 by the KVS pipeline')
      .inProse,
    false,
  );
  assert.equal(
    supersessionState(
      '---\nn: x\n---\n- **Superseded since (as of 2026-08-07):** the managed policy is gone',
    ).inProse,
    true,
  );
});

test('freshnessFindings flags unstamped volatile quantities', () => {
  // FRESH-1: only unstamped, present-tense, quantitative claims about volatile things
  assert.ok(isUnstampedVolatileClaim('The vault holds 965 Insights notes and 47 Memory notes.'));
  assert.ok(
    !isUnstampedVolatileClaim('The vault holds 965 Insights notes (as of 2026-08-14).'),
    'stamped is legal',
  );
  assert.ok(
    !isUnstampedVolatileClaim('There were 965 notes before the prune.'),
    'past tense is history, not a current claim',
  );
  assert.ok(
    !isUnstampedVolatileClaim('Where truth lives: query it from the MR, 31 open.'),
    'a pointer is legal',
  );
  assert.ok(
    !isUnstampedVolatileClaim('Prefer small notes to large ones.'),
    'no quantity, no claim',
  );
  assert.ok(!isUnstampedVolatileClaim('## 47 tasks'), 'headings are not claims');
  // FRESH-4: a dated heading opens a snapshot region
  const ff = freshnessFindings(
    '## Measured 2026-08-08\nThe repo has 501 projects and 47 libs.\n\n## Now\nThe repo has 501 projects.',
  );
  assert.equal(ff.length, 1, 'only the claim outside the dated section');
  assert.ok(ff[0].text.includes('501 projects'));
});

test('isUnprovenancedMetric requires an instrument', () => {
  // CLAIM-1: metrics need an instrument; bare counts and provenanced metrics do not fire
  assert.ok(isUnprovenancedMetric('Semantic reaches recall@5 of 94% against lexical 21%.'));
  assert.ok(!isUnprovenancedMetric('recall@5 46.4% over 28 cases'), 'sample size is provenance');
  assert.ok(!isUnprovenancedMetric('recall@5 46.4% (measured 2026-08-15)'), 'a date is provenance');
  assert.ok(
    !isUnprovenancedMetric('recall@5 46.4% via `memory-eval.mjs --run --cases x.jsonl`'),
    'a command is provenance',
  );
  assert.ok(
    !isUnprovenancedMetric('The vault holds 968 Insights notes.'),
    'a bare count is FRESH-1 territory, not CLAIM-1',
  );
  assert.ok(
    !isUnprovenancedMetric('| recall@5 | 46.4% |'),
    'table rows are formatting, judged by their section',
  );
  assert.ok(
    !isUnprovenancedMetric('Filename drift hides coverage in 3 places.'),
    'a metric word used descriptively is not a claim',
  );
  assert.ok(
    !isUnprovenancedMetric('**SLO: p90 origin latency < 2 s.**'),
    'a target needs agreement, not provenance',
  );
  assert.ok(
    !isUnprovenancedMetric(
      'semantic **recall@5 46.4%**',
      'On a versioned 28-case set: semantic **recall@5 46.4%**',
    ),
    'provenance may sit on a neighbouring line',
  );
});

test('mocTargets reads the markdown links MEMORY.md is actually written with', () => {
  const moc =
    '- [Never `git add -A`](never-git-add-all.md) — hook\n- [Other](./other.md#x) — hook\n';
  assert.deepEqual([...mocTargets(moc)], ['never-git-add-all', 'other']);
  // both forms, and a non-note link is not a target
  assert.deepEqual([...mocTargets('[[a|alias]] and [b](b.md)')], ['a', 'b']);
  assert.equal(mocTargets('[docs](docs/architecture.md) [x](https://e.com)').has('x'), false);
});

test('stripCodeBlocks keeps a bash [[ ]] test out of the wikilink scan', () => {
  const body = 'text\n\n```bash\nif [[ $var =~ ^[0-9]+$ ]]; then :; fi\n```\n\n[[real-note]]\n';
  const out = stripCodeBlocks(body);
  assert.equal(out.includes('$var'), false);
  assert.equal(out.includes('[[real-note]]'), true);
  assert.equal(stripCodeBlocks('a `[[ -f x ]]` b').includes('[['), false);
  assert.equal(stripCodeBlocks('plain [[link]] here'), 'plain [[link]] here');
});
