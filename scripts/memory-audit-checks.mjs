#!/usr/bin/env node
// Mechanical vault-audit checks — CLI entry.
//
// Thin on purpose: argv, vault scan, stdout. Every predicate and `checkFile` live in
// lib/memory-audit-checks.mjs with their tests beside them, so /memory:health and validate-note
// share one implementation instead of re-deriving the checks in prose.
//
//   node scripts/memory-audit-checks.mjs [repo]        full audit
//   node scripts/memory-audit-checks.mjs --check-file <f>
//   node scripts/memory-audit-checks.mjs --deferred
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as paths from '../hooks/lib/paths.mjs';
import {
  isStandingNegative, hasConfidence, isAbbreviated, parseDeferred, supersessionState,
  freshnessFindings, isUnprovenancedMetric, buildSuffixIndex, checkFile,
} from './lib/memory-audit-checks.mjs';

if (process.argv.includes('--check-file')) {
  const f = process.argv[process.argv.indexOf('--check-file') + 1];
  if (f) {
    const out = checkFile(f);
    if (out.length) console.log(out.join('\n'));
  }
  process.exit(0);
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
