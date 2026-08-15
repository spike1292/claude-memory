#!/usr/bin/env node
// Mechanical half of /memory:health. Run it, judge the output — it decides nothing.
//
// Why this exists: three consecutive audits hand-derived these same checks, and two of them got
// the same two wrong (REFLECTIONS.md 2026-08-10, 2026-08-14):
//   - `^confidence:` reports every note missing the field. It is nested under `metadata:`.
//   - a repo-path regex swallows the `…/` in abbreviated prose paths and calls 15 of them missing.
// Both are encoded below. Judgement stays with the auditor; this only finds candidates.
//
// Usage: node ~/.claude/scripts/memory-audit-checks.mjs [repo-dir]   (default: cwd)
// ponytail: prints findings, never edits. Deleting or rewriting a note needs confirmation anyway.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as paths from '../hooks/lib/paths.mjs';

// ---------------------------------------------------------------- predicates (self-tested below)

// A claim about STATE that a later event can reverse — not an instruction. "**Never** cite an ADR
// from its filename" is advice and stays true forever; "cra2 prod has never served traffic" is a
// measurement with a shelf life. Gate on a state verb, and drop imperative openers.
const STATE_VERB =
  'served?|serves|had|has|have|been|is|are|was|were|ran|run|happened|occurred|shipped|landed|merged|deployed|fired|reached|exists?|existed|added|done|implemented|fixed|enabled|migrated|started|carried';
const STANDING = new RegExp(
  `\\b(?:never (?:${STATE_VERB})|(?:has|have|had|is|are|was|were) never|not yet (?:${STATE_VERB})|` +
    `no [a-z0-9 '\`*-]{0,25} yet\\b|(?:none|zero) (?:of )?[a-z0-9 '\`*-]{0,25}(?:traffic|usage|customers|requests)|` +
    `so far no|still no\\b|(?:has|have)(?:n't| not) (?:${STATE_VERB}))`,
  'i'
);
// Imperative advice: the line's first words tell the reader what to do.
const IMPERATIVE = /^[\s>*_#-]*(?:\*\*)?(?:never|do not|don't|avoid|always|prefer|use|treat|read|check|verify)\b/i;

export function isStandingNegative(line) {
  const t = line.trim();
  if (!t || t.startsWith('_Also asked as')) return false;
  if (IMPERATIVE.test(t)) return false;
  return STANDING.test(t);
}

// confidence: is nested under metadata:, so it is indented. A ^-anchored grep reports every note
// as missing it — the exact false positive logged in REFLECTIONS 2026-08-10 and re-hit 2026-08-14.
export function hasConfidence(frontmatter) {
  return /^\s*confidence:\s*(high|medium|low)\s*$/m.test(frontmatter);
}

// An abbreviated path (`libs/foo/.../bar.ts`) is prose, not a claim. Reporting it "missing" is the
// other logged false positive: 15 of 24 "absent" paths in the 2026-08-14 audit were these.
export function isAbbreviated(context) {
  return /…|\.\.\./.test(context);
}

// Carry-forward list: rows in REFLECTIONS.md whose disposition is still "deferred". A deferred item
// used to survive only if the next prune happened to rank it — two duplicate pairs deferred on
// 2026-08-08 were still there on 2026-08-14, because the 2026-08-08 prune merged three *different*
// pairs. The row IS the ledger: closing an item means editing its disposition, not just doing it.
export function parseDeferred(text) {
  const out = [];
  let entry = '?';
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*—\s*(\S+)/);
    if (h) entry = `${h[1]} ${h[2]}`;
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const disposition = cells[cells.length - 1];
    if (/^\s*-+\s*$/.test(cells[0]) || /^disposition$/i.test(disposition)) continue; // header / separator
    if (entry === '?') continue; // a disposition belongs to a dated entry; tables above the first one are not findings
    // Anchor to the opening token: a "**declined** — complementary, not deferred" row is CLOSED.
    if (!/^[\s*_]*deferred\b/i.test(disposition)) continue;
    out.push({ entry, finding: cells[0], disposition });
  }
  return out;
}

// Bi-temporal bookkeeping: a fact has two dates — when it was TRUE (`valid_from`, and once reversed
// `superseded_on`) and when the vault LEARNED it (`modified`). Prose alone cannot answer "what did
// we believe on Tuesday", and a note headed "⚠ SUPERSEDED" in the body is invisible to every check.
// This finds claims that announce supersession in prose without recording it in frontmatter.
// Supersession here is per-CLAIM, not per-note. L1 notes are large and multi-claim: when the CRA2
// cutover landed it reversed one section of `cra2-ecs-runtime-facts` while the rest stayed true, so
// a note-level `superseded_by:` would have been a lie. The marker is therefore inline and sits with
// the claim it kills: `(superseded YYYY-MM-DD by [[note]])`. Note-level frontmatter is still honoured
// for the rarer case where an entire note is dead.
// Only CLAIM-supersession, not component replacement. "Core Modules already superseded by
// `@integration/api-client-*`" and "redirects-poller superseded by the KVS pipeline" describe
// software being replaced — true statements that will never need a marker. The house style for a
// dead *claim* is line-initial and shouty: "⚠ SUPERSEDED …" or "**Superseded since …**".
const SUPERSEDED_PROSE = /^[\s>*_#-]*(?:⚠\s*)?\**(?:SUPERSEDED\b|Superseded (?:since|on|by)\b|No longer true\b)/m;
// The load-bearing part is "superseded <date> by [[note]]" — it may sit anywhere inside a
// parenthetical, e.g. "(measured 2026-08-12, superseded 2026-08-14 by [[x]])". Requiring the paren
// to be adjacent rejected exactly the markers this convention produces.
const SUPERSEDED_MARKER = /superseded\s+\d{4}-\d{2}-\d{2}\s+by\s+\[\[[^\]]+\]\]/i;
export function supersessionState(raw) {
  const fm = (raw.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  const by = (fm.match(/^\s*superseded_by:\s*(.+)$/m) || [])[1];
  const on = (fm.match(/^\s*superseded_on:\s*(.+)$/m) || [])[1];
  const body = raw.slice(fm.length);
  return {
    declared: by ? by.trim().replace(/^["'\[]+|["'\]]+$/g, '') : null,
    on: on ? on.trim() : null,
    inProse: SUPERSEDED_PROSE.test(body),
    marked: SUPERSEDED_MARKER.test(body),
  };
}

// FRESH-1, after obsidian-second-brain's freshness policy: **every stored fact must be timeless,
// dated, or a pointer.** A present-tense claim about a volatile quantity, with no stamp and outside
// a dated container, is the sentence that becomes a lie next Tuesday while still reading as truth.
// Three legal forms: timeless ("invoices are issued monthly"), snapshot ("2026-08-12: 47 tasks"),
// pointer ("where truth lives: <url>, last observed X (as of DATE)").
// Precision over recall: the quantity must sit NEXT TO the volatile noun ("965 Insights notes",
// "47 tasks"), not merely somewhere on the same line. A looser version reported 133 hits across 47
// notes — mostly ticket ids like ATL-3317 and MR numbers — which is a backlog nobody reads.
const VOLATILE = '(?:tasks?|jobs?|tickets?|issues?|notes?|projects?|libs?|apps?|services?|clusters?|instances?|stacks?|alarms?|errors?|events?|requests?|users?|members?|commits?|branches?|files?|pairs?|gaps?|duplicates?)';
const COUNTED = new RegExp(`(?<![-#!\\w/.])(?:~|about\\s+)?\\d{1,6}(?:,\\d{3})*\\s*%?\\s+(?:\\w+\\s+){0,2}${VOLATILE}\\b`, 'i');
const PAST = /\b(was|were|had|reached|hit|closed|shipped|merged|landed|dropped|ended|became|used to|previously|at the time)\b/i;
// Any ISO date on the line makes it a snapshot — "Measured **2026-08-08** … 501 projects" is a
// dated observation whether or not the date sits in the parenthesised house style.
const STAMPED = /\d{4}-\d{2}(-\d{2})?/;
const POINTER = /\b(where truth lives|source of truth|read it from|query it|re-?run|check the MR|from the (?:API|dashboard))\b/i;

export function isUnstampedVolatileClaim(line) {
  const t = line.trim();
  if (!t || t.startsWith('|') || t.startsWith('>') || t.startsWith('_Also asked as')) return false;
  if (/^#{1,6}\s/.test(t) || /^```/.test(t)) return false;
  if (/^\w[\w-]*:\s/.test(t)) return false; // frontmatter key: value
  if (STAMPED.test(t) || POINTER.test(t) || PAST.test(t)) return false; // dated, pointed, or history
  return COUNTED.test(t.replace(/`[^`]*`/g, ' ')); // quoted code is never a claim
}

// CLAIM-1: a METRIC must name the instrument that produced it.
//
// This is the mechanical answer to the failure that recurred three times in one cycle: a number was
// believed because it looked plausible, and the thing that produced it was never checked.
//   · "CLAUDE.md now mandates X"      — the file was never opened
//   · synthesis grade 0.945 vs 0.947  — the test was wrong, not the note
//   · "recall 0.94 / 1.00"            — the question set was rewritten every run
// The L1 note `instrument-must-match-healthy-signal` already taught this and did not prevent any of
// them, because prose cannot gate a write. This can: a metric without provenance is flagged.
//
// Deliberately narrow. FRESH-1 already covers plain counts going stale; this covers the class that
// actually burned us — evaluative scores, which look authoritative precisely because they are
// specific. A bare count is a fact; a metric is a claim about a measurement.
// The metric word must sit NEXT TO a value. "Filename drift hides coverage" and "ALB coverage → the
// EDGE dashboard" use these words descriptively; only "recall@5 46.4%" or "MRR 0.289" is a claim
// about a measurement. First cut matched the word anywhere on a line containing any digit and was
// ~80% false positives — the same over-loose first draft as FRESH-1 (133 hits) and the supersession
// check (2 of 3). Assume a new check is miscalibrated until its output has been read line by line.
const METRIC = /\b(recall(@\d+)?|precision|MRR|F1|accuracy|hit[- ]rate|error[- ]rate|p50|p90|p95|p99|latency|throughput|uptime)\b[^.;]{0,15}?\d|\d+(\.\d+)?\s*%?\s*(recall|precision|MRR|accuracy|uptime)\b/i;
// A target is not a measurement: "SLO: p90 latency < 2s" states an objective, and objectives do not
// need provenance — they need agreement.
const TARGET = /\b(SLO|SLA|objective|target|budget|threshold|goal|aim for|must stay)\b/i;
// Provenance = anything letting a reader re-run or locate the measurement: a script, a command, a
// case set, a dated "measured/verified", or an explicit sample size.
const PROVENANCE = /(`[^`]*(?:\.mjs|\.py|\.sh|\.jsonl|--run|--mode|--cases)[^`]*`|\b(?:measur\w+|verified|benchmark(?:ed)?|case set|sample|question set|over \d+ (?:cases|questions|notes)|n\s*=\s*\d+)\b|\d{4}-\d{2}-\d{2})/i;

// `context` is the line plus its neighbours: a claim and its provenance routinely straddle a wrap
// ("On a versioned 28-case set:\n semantic **recall@5 46.4%**"), and flagging the second half of a
// properly-sourced sentence is noise.
export function isUnprovenancedMetric(line, context = line) {
  const t = line.trim();
  if (!t || t.startsWith('_Also asked as') || /^\w[\w-]*:\s/.test(t)) return false;
  if (/^#{1,6}\s/.test(t) || /^```/.test(t) || t.startsWith('|')) return false;
  if (!METRIC.test(t)) return false;
  if (TARGET.test(t)) return false;
  // Advice ABOUT metrics is not a claim OF one. "Store live metrics alongside the queries that
  // produced them" is the same lesson this check enforces — flagging it is pure noise.
  if (IMPERATIVE.test(t) || /^[\s>*_#-]*(?:\*\*)?(?:comparing|storing|measuring|tracking|reporting)\b/i.test(t)) return false;
  return !PROVENANCE.test(context);
}

// FRESH-4: a dated heading opens a snapshot region — everything under "## Measured 2026-08-08"
// claims what was true then, so it cannot rot. Region ends at the next heading of equal or higher
// level. Without this the lint flags every line of a measurement section.
export function freshnessFindings(body) {
  const out = [];
  let datedLevel = null;
  body.split('\n').forEach((line, i) => {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      if (datedLevel !== null && level <= datedLevel) datedLevel = null;
      if (/\d{4}-\d{2}(-\d{2})?/.test(h[2])) datedLevel = level;
      return;
    }
    if (datedLevel !== null) return;
    if (isUnstampedVolatileClaim(line)) out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

export function buildSuffixIndex(paths) {
  const idx = new Map();
  for (const t of paths)
    for (let i = t.indexOf('/'); i !== -1; i = t.indexOf('/', i + 1)) {
      const suf = t.slice(i + 1);
      if (!idx.has(suf)) idx.set(suf, []);
      idx.get(suf).push(t);
    }
  return idx;
}

if (process.argv.includes('--selftest')) {
  const { strict: assert } = await import('node:assert');
  // standing negatives — real claims
  assert.ok(isStandingNegative('- **cra2 prod has never served traffic** — 0–3 requests/24h'));
  assert.ok(isStandingNegative('ESLint ban on `@integration/*` = recommended but **not yet added** (deferred).'));
  assert.ok(isStandingNegative('There is no NAT gateway yet in this account.'));
  // instructions — must NOT fire
  assert.ok(!isStandingNegative('**Never cite an ADR from its filename.** Verified 2026-08-08.'));
  assert.ok(!isStandingNegative('- Do not treat "Zscaler is on" as sufficient explanation.'));
  assert.ok(!isStandingNegative('Always measure before quoting a cost figure.'));
  assert.ok(!isStandingNegative('_Also asked as: has this never worked?_'));
  // confidence
  assert.ok(hasConfidence('metadata: \n  node_type: memory\n  confidence: high\n  type: project'));
  assert.ok(!hasConfidence('metadata: \n  type: project'));
  // abbreviation
  assert.ok(isAbbreviated('`libs/core/observability/.../sentry-integration.ts`'));
  assert.ok(!isAbbreviated('`libs/server/core/src/routes/well-known.ts`'));
  // suffix index — the real recurring case: a note wrote `scripts/cra2-alias-move.sh`
  const idx = buildSuffixIndex(['docs/devops/cra2-migration/scripts/cra2-alias-move.sh', 'libs/server/core/index.ts']);
  assert.deepEqual(idx.get('scripts/cra2-alias-move.sh'), ['docs/devops/cra2-migration/scripts/cra2-alias-move.sh']);
  assert.deepEqual(idx.get('core/index.ts'), ['libs/server/core/index.ts']);
  assert.equal(idx.get('docs/devops/cra2-migration/scripts/cra2-alias-move.sh'), undefined); // exact hit is not a suffix
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
    ].join('\n')
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].entry, '2026-08-08 audit');
  assert.equal(rows[0].finding, 'three dup pairs');
  assert.equal(rows[1].entry, '2026-08-09 audit');
  // supersession: prose-only vs declared
  const proseOnly = supersessionState('---\nname: x\n---\n## ⚠ SUPERSEDED — the cutover reversed this\nbody');
  assert.equal(proseOnly.inProse, true);
  assert.equal(proseOnly.declared, null);
  const declared = supersessionState('---\nname: x\nsuperseded_by: cra2-prd-cutover-run\nsuperseded_on: 2026-08-14\n---\n## ⚠ SUPERSEDED\nbody');
  assert.equal(declared.declared, 'cra2-prd-cutover-run');
  assert.equal(declared.on, '2026-08-14');
  assert.equal(supersessionState('---\nname: x\n---\njust a normal note').inProse, false);
  // an inline per-claim marker satisfies the check without lying at note level
  const marked = supersessionState("---\nname: x\n---\n## ⚠ SUPERSEDED\ncra2 served no traffic (measured 2026-08-12, superseded 2026-08-14 by [[cra2-prd-cutover-run]])");
  assert.equal(marked.marked, true);
  assert.equal(marked.declared, null, 'the note itself is still valid — only one claim died');
  assert.equal(supersessionState('---\nname: x\n---\n## SUPERSEDED\nno marker here').marked, false);
  // component replacement is not claim supersession — these must NOT be flagged
  assert.equal(supersessionState('---\nn: x\n---\nCore Modules already superseded by `@integration/api-client-*`.').inProse, false);
  assert.equal(supersessionState('---\nn: x\n---\nthe redirects-poller superseded in cra2 by the KVS pipeline').inProse, false);
  assert.equal(supersessionState('---\nn: x\n---\n- **Superseded since (as of 2026-08-07):** the managed policy is gone').inProse, true);
  // FRESH-1: only unstamped, present-tense, quantitative claims about volatile things
  assert.ok(isUnstampedVolatileClaim('The vault holds 965 Insights notes and 47 Memory notes.'));
  assert.ok(!isUnstampedVolatileClaim('The vault holds 965 Insights notes (as of 2026-08-14).'), 'stamped is legal');
  assert.ok(!isUnstampedVolatileClaim('There were 965 notes before the prune.'), 'past tense is history, not a current claim');
  assert.ok(!isUnstampedVolatileClaim('Where truth lives: query it from the MR, 31 open.'), 'a pointer is legal');
  assert.ok(!isUnstampedVolatileClaim('Prefer small notes to large ones.'), 'no quantity, no claim');
  assert.ok(!isUnstampedVolatileClaim('## 47 tasks'), 'headings are not claims');
  // FRESH-4: a dated heading opens a snapshot region
  const ff = freshnessFindings('## Measured 2026-08-08\nThe repo has 501 projects and 47 libs.\n\n## Now\nThe repo has 501 projects.');
  assert.equal(ff.length, 1, 'only the claim outside the dated section');
  assert.ok(ff[0].text.includes('501 projects'));
  // CLAIM-1: metrics need an instrument; bare counts and provenanced metrics do not fire
  assert.ok(isUnprovenancedMetric('Semantic reaches recall@5 of 94% against lexical 21%.'));
  assert.ok(!isUnprovenancedMetric('recall@5 46.4% over 28 cases'), 'sample size is provenance');
  assert.ok(!isUnprovenancedMetric('recall@5 46.4% (measured 2026-08-15)'), 'a date is provenance');
  assert.ok(!isUnprovenancedMetric('recall@5 46.4% via `memory-eval.mjs --run --cases x.jsonl`'), 'a command is provenance');
  assert.ok(!isUnprovenancedMetric('The vault holds 968 Insights notes.'), 'a bare count is FRESH-1 territory, not CLAIM-1');
  assert.ok(!isUnprovenancedMetric('| recall@5 | 46.4% |'), 'table rows are formatting, judged by their section');
  assert.ok(!isUnprovenancedMetric('Filename drift hides coverage in 3 places.'), 'a metric word used descriptively is not a claim');
  assert.ok(!isUnprovenancedMetric('**SLO: p90 origin latency < 2 s.**'), 'a target needs agreement, not provenance');
  assert.ok(!isUnprovenancedMetric('semantic **recall@5 46.4%**', 'On a versioned 28-case set: semantic **recall@5 46.4%**'), 'provenance may sit on a neighbouring line');
  console.log('selftest: 44 assertions passed');
  process.exit(0);
}

// --check-file <path>: run the per-line predicates against ONE file and print warnings. This is what
// moves the checks to WRITE time instead of audit time — the inflated recall figure reached a public
// README between two audits, and an audit-only check structurally cannot catch that.
// Called by the validate-note.sh PostToolUse hook. Exits before any vault/git resolution so it stays
// fast enough to run on every write.
{
  const i = process.argv.indexOf('--check-file');
  if (i !== -1 && process.argv[i + 1]) {
    const f = process.argv[i + 1];
    if (!fs.existsSync(f)) process.exit(0);
    const raw = fs.readFileSync(f, 'utf8');
    const lines = raw.split('\n');
    const out = [];
    lines.forEach((l, n) => {
      const ctx = lines.slice(Math.max(0, n - 2), n + 2).join(' ');
      if (isUnprovenancedMetric(l, ctx)) out.push(`  · line ${n + 1}: metric with no instrument named — cite the run, script, case set or date`);
    });
    for (const fr of freshnessFindings(raw)) out.push(`  · line ${fr.line}: volatile quantity, no stamp — make it timeless, a dated snapshot, or a pointer`);
    const s = supersessionState(raw);
    if (s.inProse && !s.marked && !s.declared) out.push('  · reversal stated in prose only — mark it: (superseded YYYY-MM-DD by [[note]])');
    if (out.length) console.log(out.join('\n'));
    process.exit(0);
  }
}

const repo = process.argv.slice(2).find((a) => !a.startsWith('--')) || process.cwd();
// maxBuffer: `git ls-files` in this monorepo is ~2 MB; the 1 MB default fails with ENOBUFS.
const sh = (c, cwd = repo) =>
  execSync(c, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim();
const VAULT = paths.vault();
const SLUG = paths.projectKey(repo);
const MEM = path.join(VAULT, 'Memory', SLUG);
const INS = path.join(VAULT, 'Insights', SLUG);
const FOLDERS = ['Patterns', 'Mistakes', 'Decisions'];

if (!fs.existsSync(MEM)) {
  console.log(`no vault memory for ${SLUG} at ${MEM}`);
  process.exit(0);
}

const read = (f) => fs.readFileSync(f, 'utf8');

// --deferred: the carry-forward list alone, no repo scan. /memory:prune calls this first.
const reflections = path.join(INS, 'REFLECTIONS.md');
const stillDeferred = fs.existsSync(reflections) ? parseDeferred(read(reflections)) : [];
if (process.argv.includes('--deferred')) {
  // Echo the resolved project. `repo` defaults to cwd, so running this from ~/.claude audits the
  // CONFIG repo, finds its near-empty vault and reports "nothing deferred" with total confidence —
  // which happened on 2026-08-14. Naming the slug makes a wrong-project run obvious at a glance.
  console.log(`project: ${SLUG}  (from ${repo})`);
  if (!fs.existsSync(reflections)) console.log(`⚠ no REFLECTIONS.md for this project — wrong directory?`);
  if (!stillDeferred.length) console.log('nothing still deferred in REFLECTIONS.md');
  else {
    console.log(`${stillDeferred.length} item(s) still deferred — handle these BEFORE new findings:`);
    for (const r of stillDeferred) console.log(`  [${r.entry}] ${r.finding}`);
    console.log('\nClosing one means editing its disposition in REFLECTIONS.md. An unedited row stays open forever.');
  }
  process.exit(0);
}
const mds = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.md')) : []);
const section = (title, lines) => {
  if (!lines.length) return;
  console.log(`\n## ${title}`);
  lines.forEach((l) => console.log('  ' + l));
};

// ---------------------------------------------------------------- load
const notes = new Map(); // name -> { file, layer, body }
for (const f of mds(MEM)) {
  if (f === 'MEMORY.md') continue;
  notes.set(f.slice(0, -3), { file: path.join(MEM, f), layer: 'Memory', body: read(path.join(MEM, f)) });
}
for (const fo of FOLDERS)
  for (const f of mds(path.join(INS, fo)))
    notes.set(f.slice(0, -3), { file: path.join(INS, fo, f), layer: fo, body: read(path.join(INS, fo, f)) });

const memNames = [...notes].filter(([, v]) => v.layer === 'Memory').map(([k]) => k);
const counts = FOLDERS.map((f) => `${f} ${mds(path.join(INS, f)).length}`).join(' / ');
console.log(`# ${SLUG}`);
console.log(`snapshot: ${memNames.length} Memory + ${notes.size - memNames.length} Insights (${counts})`);
console.log('NOTE: the distiller writes concurrently — re-run at the end and report both counts if they moved.');

// permanent/ notes resolve as wikilink targets too (they are in the same Obsidian vault)
const permanent = new Set();
(function walk(d) {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.name.endsWith('.md')) permanent.add(e.name.slice(0, -3));
  }
})(path.join(VAULT, 'permanent'));

const linksIn = (t) => [...t.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim());
const resolves = (n) => notes.has(n) || permanent.has(n);

// ---------------------------------------------------------------- MOC + graph
const mocPath = path.join(MEM, 'MEMORY.md');
const moc = fs.existsSync(mocPath) ? read(mocPath) : '';
const mocLinks = new Set(linksIn(moc));
section(
  'Not in the MOC',
  memNames.filter((n) => !mocLinks.has(n)).map((n) => `${n} — add a one-line pointer to MEMORY.md`)
);
section(
  'Dangling wikilinks',
  [...new Set([...notes.values()].flatMap((v) => linksIn(v.body)))]
    .filter((n) => !resolves(n))
    .map((n) => `[[${n}]] — no such note in Memory, Insights or permanent/`)
);

const inbound = new Map([...notes.keys()].map((k) => [k, 0]));
for (const [k, v] of notes)
  for (const l of new Set(linksIn(v.body)))
    if (inbound.has(l) && l !== k && path.basename(v.file) !== 'MEMORY.md') inbound.set(l, inbound.get(l) + 1);
section(
  'MOC-only (no inbound sibling link)',
  memNames.filter((n) => inbound.get(n) === 0).map((n) => `${n} — link it from a note someone reads before needing it`)
);

// ---------------------------------------------------------------- frontmatter
// confidence: lives under metadata:, so it is indented. A ^-anchored grep reports 46 false hits.
const noConfidence = [];
const nameMismatch = [];
for (const n of memNames) {
  const fm = (notes.get(n).body.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  if (!hasConfidence(fm)) noConfidence.push(n);
  const declared = (fm.match(/^name:\s*(.+)$/m) || [])[1];
  if (declared && declared.trim().replace(/^["']|["']$/g, '') !== n) nameMismatch.push(`${n} — frontmatter says ${declared.trim()}`);
}
section('Missing confidence:', noConfidence);
section('name: does not match filename', nameMismatch);
// Insights notes carry title:, not name: — by distiller convention, not a defect. Not checked.

// ---------------------------------------------------------------- repo path claims
const tracked = new Set(sh('git ls-files').split('\n').filter(Boolean));
const bySuffix = buildSuffixIndex(tracked);
const TOP = '(?:apps|libs|tools|scripts|docs|styles|assets|e2e|\\.claude|\\.agents|\\.gitlab)';
const claimRe = new RegExp(`(?:^|[\\s\`'"(\\[])(${TOP}/[A-Za-z0-9._/-]*[A-Za-z0-9._-])`, 'g');
const abbreviated = [];
const suffixOnly = [];
const absent = [];
for (const n of memNames) {
  const body = notes.get(n).body;
  for (const line of body.split('\n')) {
    for (const m of line.matchAll(claimRe)) {
      const c = m[1].replace(/[.,;:]+$/, '');
      if (isAbbreviated(line.slice(Math.max(0, m.index - 2), m.index + m[0].length + 2))) {
        abbreviated.push(`${n}: ${c}`);
        continue;
      }
      if (tracked.has(c) || fs.existsSync(path.join(repo, c))) continue;
      const full = bySuffix.get(c);
      if (full) suffixOnly.push(`${n}: \`${c}\` → real path is \`${full[0]}\`${full.length > 1 ? ` (+${full.length - 1} more)` : ''}`);
      else absent.push(`${n}: ${c}`);
    }
  }
}
section(
  'Path abbreviated to a suffix — WRITE THE FULL PATH',
  [...new Set(suffixOnly)]
);
section(
  'Path not on this branch (check whether the note names the branch — many are legitimately branch-only)',
  [...new Set(absent)]
);
if (abbreviated.length) console.log(`\n(${new Set(abbreviated).size} ellipsis-abbreviated paths skipped — prose, not claims)`);

// ---------------------------------------------------------------- supersession candidates
// A standing negative ("has never served traffic", "not yet added") is what a later event note
// silently reverses — see REFLECTIONS 2026-08-14, where the prod cutover killed exactly such a
// claim in two notes and nothing pointed at it. No lint can know which event kills which claim;
// this only narrows where to look.
const timeBombs = [];
for (const n of memNames)
  notes.get(n).body.split('\n').forEach((l, i) => {
    if (isStandingNegative(l)) timeBombs.push(`${n}:${i + 1} ${l.trim().slice(0, 120)}`);
  });
section(
  `Standing-negative claims (${timeBombs.length}) — re-verify against anything that happened since`,
  timeBombs.slice(0, 25).concat(timeBombs.length > 25 ? [`… +${timeBombs.length - 25} more`] : [])
);

// ---------------------------------------------------------------- duplicates
const STOP = new Set(
  'the a an and or of to in on for is are was were it its this that with as by at from be not you your we our they them if then when what which how why do does did use used using via no yes into over under more most less least than each per also only just same other'.split(' ')
);
const toks = (t) =>
  new Set(t.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
const dups = [];
for (const fo of FOLDERS) {
  const docs = mds(path.join(INS, fo)).map((f) => ({ f: f.slice(0, -3), t: toks(read(path.join(INS, fo, f))) }));
  for (let i = 0; i < docs.length; i++)
    for (let j = i + 1; j < docs.length; j++) {
      const [a, b] = [docs[i], docs[j]];
      let inter = 0;
      const [small, big] = a.t.size < b.t.size ? [a.t, b.t] : [b.t, a.t];
      for (const t of small) if (big.has(t)) inter++;
      const jac = inter / (a.t.size + b.t.size - inter);
      if (jac >= 0.45) dups.push({ jac, fo, a: a.f, b: b.f });
    }
}
dups.sort((x, y) => y.jac - x.jac);
section(
  'Same-folder near-duplicates ≥0.45 (same folder first — cross-type pairs are complementary by design)',
  dups.map((d) => `${d.jac.toFixed(2)} [${d.fo}] ${d.a}\n         <> ${d.b}`)
);
if (dups.length) console.log('  → hand these to /memory:prune in the SAME session; a deferred pair only survives if the next prune happens to rank it.');

// ---------------------------------------------------------------- supersession (bi-temporal)
const proseOnly = [];
const supersededOk = [];
const danglingSupersede = [];
for (const [n, v] of notes) {
  const s = supersessionState(v.body);
  if (s.declared) {
    (resolves(s.declared) ? supersededOk : danglingSupersede).push(`${n} → ${s.declared}${s.on ? ` (${s.on})` : ' — no superseded_on:'}`);
  } else if (s.inProse && !s.marked && v.layer === 'Memory') {
    proseOnly.push(`${n} — reversal stated in prose only; mark the claim inline: (superseded YYYY-MM-DD by [[note]])`);
  }
}
section('Supersession not machine-readable', proseOnly);

// FRESH-1: unstamped volatile claims. Reported for Memory only — Insights notes are lessons, and a
// dated Insight filename already makes the whole note a snapshot.
const unstamped = [];
for (const n of memNames)
  for (const f of freshnessFindings(notes.get(n).body)) unstamped.push(`${n}:${f.line} ${f.text.slice(0, 110)}`);
// CLAIM-1 runs over BOTH layers: the inflated recall figure reached L1 notes, L3 Decision notes and
// a public README, so restricting it to Memory would have missed most of the damage.
const unprovenanced = [];
for (const [n, v] of notes)
  {
    const lines = v.body.split('\n');
    lines.forEach((l, i) => {
      const ctx = lines.slice(Math.max(0, i - 2), i + 2).join(' ');
      if (isUnprovenancedMetric(l, ctx)) unprovenanced.push(`${n}:${i + 1} ${l.trim().slice(0, 105)}`);
    });
  }
section(
  `CLAIM-1 — metric with no instrument named (${unprovenanced.length}); cite the run, script, case set or date that produced it`,
  unprovenanced.slice(0, 12).concat(unprovenanced.length > 12 ? [`… +${unprovenanced.length - 12} more`] : [])
);

section(
  `FRESH-1 — volatile quantity, present tense, no stamp (${unstamped.length}); make it timeless, a dated snapshot, or a pointer`,
  unstamped.slice(0, 15).concat(unstamped.length > 15 ? [`… +${unstamped.length - 15} more`] : [])
);
section('superseded_by: points at a note that does not exist', danglingSupersede);
if (supersededOk.length) console.log(`\n(${supersededOk.length} note(s) carry machine-readable supersession — good)`);

section(
  'Still deferred from an earlier audit — close these before adding new ones',
  stillDeferred.map((r) => `[${r.entry}] ${r.finding}`)
);

console.log('\ndone — every section above is a candidate, not a verdict.');
