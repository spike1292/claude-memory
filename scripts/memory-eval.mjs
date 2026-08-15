#!/usr/bin/env node
// Reproducible retrieval eval for the vault. Generates a versioned case set once, then scores any
// retrieval change against THE SAME cases.
//
// Why this exists: before it, every /memory:eval run hand-wrote a fresh set of questions. The
// numbers moved between runs (0.60 → 1.00 on 2026-08-14) but the question set moved too, so the
// comparison proved nothing — and the questions were written by someone who already knew the vault
// and knew what had just been fixed. Borrowed wholesale from obsidian-second-brain's harness, whose
// baseline states the rule plainly: **no retrieval change ships without before/after numbers on the
// same cases.**
//
// Usage:
//   node memory-eval.mjs --generate 40 [--style semantic|keyword] [--out <path>]
//   node memory-eval.mjs --run [--cases <path>] [--mode semantic|lexical] [--layer Memory] [--json]
//   node memory-eval.mjs --selftest
//
// Cases live in ~/.claude/data/eval-cases-<slug>-<style>.jsonl and are GITIGNORED: they contain
// vault content. Regenerate only with --force; a changed case set invalidates every past number.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activeModel } from './lib/model-default.mjs';
import * as paths from '../hooks/lib/paths.mjs';

const RECALL_KS = [1, 3, 5, 10];

// ---------------------------------------------------------------- pure helpers (self-tested)

export function titleTokens(stem) {
  return new Set(stem.toLowerCase().replace(/^\d{4}-\d{2}-\d{2}-/, '').split(/[^a-z0-9]+/).filter((w) => w.length > 3));
}

// Strip everything that would leak the answer's own vocabulary or isn't prose: frontmatter,
// headings, code fences, wikilinks — and critically the `_Also asked as:` line, which is a list of
// queries the note was written to match. Generating a question from it would score our own aliases.
export function evalBody(raw) {
  let t = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/^_Also asked as:[\s\S]*$/m, ' ');
  t = t.replace(/^#{1,6} .*$/gm, ' ');
  t = t.replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, ' ');
  t = t.replace(/`[^`]*`/g, ' ');
  return t;
}

// A paraphrase question must not reuse the note's title words — that is the whole point of the
// semantic style; otherwise it degenerates into a keyword lookup and every channel scores well.
export function pickSentence(body, stem, style) {
  const tt = titleTokens(stem);
  const sents = body.split(/(?<=[.!?])\s+|\n{2,}/).map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 40 && s.length <= 220 && /[a-z]/.test(s));
  if (!sents.length) return null;
  const score = (s) => {
    const toks = new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
    let overlap = 0;
    for (const w of toks) if (tt.has(w)) overlap++;
    return style === 'keyword' ? overlap : -overlap; // keyword wants the title words, semantic avoids them
  };
  return sents.sort((a, b) => score(b) - score(a) || b.length - a.length)[0];
}

export function metrics(perCase) {
  const n = perCase.length || 1;
  const recall = {};
  for (const k of RECALL_KS) recall[k] = perCase.filter((c) => c.rank > 0 && c.rank <= k).length / n;
  const mrr = perCase.reduce((a, c) => a + (c.rank ? 1 / c.rank : 0), 0) / n;
  return { recall, mrr };
}

if (process.argv.includes('--selftest')) {
  const { strict: assert } = await import('node:assert');
  // 'cap' is 3 chars and drops out — short tokens are noise, not identity
  assert.deepEqual([...titleTokens('2026-08-14-cap-concurrency-with-literal')].sort(), ['concurrency', 'literal', 'with']);
  const raw = '---\nname: x\n---\n## Head\nThe runner fleet gains vCPU without gaining RAM, so a percentage silently re-tunes upward.\n\n_Also asked as: should I use parallel 2, why fixed numbers._\n';
  const b = evalBody(raw);
  assert.ok(!b.includes('Also asked as'), 'alias line must never seed a question — it is a list of queries we wrote to match');
  assert.ok(!b.includes('## Head'));
  assert.ok(b.includes('runner fleet'));
  const s = pickSentence(b, 'runner-fleet-vcpu', 'semantic');
  assert.ok(s && s.length >= 40);
  const m = metrics([{ rank: 1 }, { rank: 3 }, { rank: 0 }, { rank: 7 }]);
  assert.equal(m.recall[1], 0.25);
  assert.equal(m.recall[3], 0.5);
  assert.equal(m.recall[10], 0.75);
  assert.ok(Math.abs(m.mrr - (1 + 1 / 3 + 0 + 1 / 7) / 4) < 1e-9);
  console.log('selftest: 9 assertions passed');
  process.exit(0);
}

// ---------------------------------------------------------------- setup

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const repo = argv.filter((a) => !a.startsWith('--')).find((a) => fs.existsSync(a) && fs.statSync(a).isDirectory()) || process.cwd();
// --vault/--slug point this at a generated benchmark vault instead of the real one, which is how
// a retrieval change gets scored against a FIXED note set. Explicit flags, not CLAUDE_VAULT: an
// env override once sent a relocating hook at a throwaway path and cost 24 notes.
const VAULT = val('--vault') || paths.vault();
const SLUG = val('--slug') || paths.projectKey(repo);
// Echo the resolved project. `repo` defaults to cwd, so running this from ~/.claude silently
// evaluates the CONFIG repo's near-empty vault — hit three separate times on 2026-08-14, once per
// script, always with a confident-looking wrong answer.
console.error(`project: ${SLUG}  (from ${repo})`);
const STYLE = val('--style') || 'semantic';
// Case sets are generated FROM a real vault and contain its content, so they live in
// machine-local state, never in the plugin (which is a public repo).
const DATA = paths.stateDir('eval');
const CASES = val('--cases') || val('--out') || path.join(DATA, `eval-cases-${SLUG}-${STYLE}.jsonl`);

function allNotes() {
  const out = [];
  const add = (dir, layer) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      if (f === 'REFLECTIONS.md' || f === 'MEMORY.md') continue;
      out.push({ note: f.slice(0, -3), layer, file: path.join(dir, f) });
    }
  };
  add(path.join(VAULT, 'Memory', SLUG), 'Memory');
  for (const l of ['Patterns', 'Mistakes', 'Decisions']) add(path.join(VAULT, 'Insights', SLUG, l), l);
  // permanent/ is a retrieval target like any other — consolidated notes are often the BEST answer,
  // so leaving them out both hides misses and rejects valid gold notes.
  for (const d of ['', 'domain', 'tools']) add(path.join(VAULT, 'permanent', d), 'permanent');
  return out;
}

// ---------------------------------------------------------------- generate

// --author: read {q, gold} JSONL on stdin, validate every gold note exists, and save as the case
// set. This is how a REAL paraphrase set is made: the agent writes the questions once (it is the
// LLM the upstream harness calls out to), then scoring is reproducible forever after.
if (flag('--author')) {
  const known = new Set(allNotes().map((n) => n.note));
  const lines = fs.readFileSync(0, 'utf8').trim().split('\n').filter(Boolean);
  const cases = [], bad = [];
  for (const l of lines) {
    const c = JSON.parse(l);
    const missing = c.gold.filter((g) => !known.has(g));
    if (missing.length) { bad.push(`${missing.join(', ')}  (Q: ${c.q.slice(0, 60)})`); continue; }
    cases.push({ ...c, style: c.style || 'semantic-authored' });
  }
  if (bad.length) { console.log(`gold note(s) not found — fix these first:\n  ${bad.join('\n  ')}`); process.exit(1); }
  fs.writeFileSync(CASES, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
  console.log(`${cases.length} authored cases → ${CASES}`);
  process.exit(0);
}

if (flag('--generate')) {
  const n = Number(val('--generate') || 40);
  if (fs.existsSync(CASES) && !flag('--force')) {
    console.log(`${CASES} exists. Regenerating invalidates every past number — pass --force if that is what you want.`);
    process.exit(1);
  }
  const notes = allNotes();
  // Deterministic sample: sort by name and stride. Math.random would make the set unreproducible,
  // which is the exact failure this harness exists to fix.
  notes.sort((a, b) => (a.note < b.note ? -1 : 1));
  const stride = Math.max(1, Math.floor(notes.length / n));
  const cases = [];
  for (let i = 0; i < notes.length && cases.length < n; i += stride) {
    const nt = notes[i];
    const q = pickSentence(evalBody(fs.readFileSync(nt.file, 'utf8')), nt.note, STYLE);
    if (q) cases.push({ q, gold: [nt.note], layer: nt.layer, style: STYLE });
  }
  fs.writeFileSync(CASES, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
  console.log(`${cases.length} cases (${STYLE}) → ${CASES}`);
  console.log('Gitignored by the deny-by-default rule: these contain vault content.');
  console.log('\n⚠ These are EXTRACTED SENTENCES, not paraphrases — the note contains them verbatim,');
  console.log('  so BM25 finds them trivially (measured: lexical recall@1 97.5% vs semantic 62.5%).');
  console.log('  Useful as a lexical-recall floor and an index-coverage check; NOT a paraphrase test.');
  console.log('  For that, author real questions and pipe them to --author.');
  process.exit(0);
}

// ---------------------------------------------------------------- run

if (!flag('--run')) { console.log('usage: --generate N [--style semantic|keyword] | --run [--mode semantic|lexical] | --selftest'); process.exit(1); }
if (!fs.existsSync(CASES)) { console.log(`no case set at ${CASES}. Generate one first: --generate 40`); process.exit(1); }
const cases = fs.readFileSync(CASES, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const mode = val('--mode') || 'semantic';
// A rank-window intervention (reserved slots, re-ranking) is invisible when the harness fetches a
// wider window than a session does: promoted items sort to the bottom by score, so scoring @5 from
// a k=10 fetch shows nothing at @5. --fetch-k measures what the caller actually sees; only ks up to
// it are reported, since a k=5 fetch cannot answer @10.
const K = Number(val('--fetch-k') || Math.max(...RECALL_KS));
const KS = RECALL_KS.filter((k) => k <= K);

let ranked; // [{q, results:[{note}]}]
if (mode === 'semantic') {
  const args = ['--json', '-k', String(K), repo];
  if (val('--layer')) args.push('--layer', val('--layer'));
  // Forward the vault override, or the child searches the REAL vault while this process scores
  // against the benchmark one — two different note sets, one silent mismatch.
  if (val('--vault')) args.push('--vault', val('--vault'));
  if (val('--slug')) args.push('--slug', val('--slug'));
  for (const c of cases) args.push('--query', c.q);
  const out = execFileSync('node', [path.join(paths.scriptsDir, 'memory-semantic.mjs'), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  ranked = out.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
} else {
  // Lexical arm: a local BM25 stand-in, NOT ctx_search. It exists so a retrieval change can be
  // compared against a keyword baseline on the same cases inside one process. It does not reproduce
  // context-mode's ranking, and a number from it is not a claim about ctx_search.
  const notes = allNotes().map((n) => ({ ...n, toks: evalBody(fs.readFileSync(n.file, 'utf8')).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2) }));
  const df = new Map();
  for (const n of notes) for (const t of new Set(n.toks)) df.set(t, (df.get(t) || 0) + 1);
  const avgdl = notes.reduce((a, n) => a + n.toks.length, 0) / notes.length;
  const N = notes.length;
  ranked = cases.map((c) => {
    const qt = c.q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const scored = notes.map((n) => {
      const tf = new Map();
      for (const t of n.toks) tf.set(t, (tf.get(t) || 0) + 1);
      let s = 0;
      for (const t of qt) {
        const f = tf.get(t) || 0;
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
        s += idf * (f * 2.2) / (f + 1.2 * (1 - 0.75 + 0.75 * n.toks.length / avgdl));
      }
      return { note: n.note, s };
    });
    return { q: c.q, results: scored.sort((a, b) => b.s - a.s).slice(0, K).map((x) => ({ note: x.note })) };
  });
}

const perCase = cases.map((c, i) => {
  const res = ranked[i]?.results || [];
  const rank = res.findIndex((r) => c.gold.includes(r.note)) + 1;
  return { q: c.q, gold: c.gold[0], layer: c.layer, rank, top1: res[0]?.note ?? null };
});
const { recall, mrr } = metrics(perCase);
const misses = perCase.filter((c) => !c.rank);
const buried = perCase.filter((c) => c.rank > 3);

// Every semantic number is model-dependent, so the model IS part of the measurement. Reporting a
// recall figure without it is the provenance gap CLAIM-1 exists to catch.
const model = mode === 'semantic' ? activeModel() : 'bm25';
if (flag('--json')) {
  console.log(JSON.stringify({ cases: CASES, mode, model, fetchK: K, n: perCase.length, recall, mrr: +mrr.toFixed(3) }, null, 2));
  process.exit(0);
}
console.log(`${perCase.length} cases · style ${cases[0]?.style ?? '?'} · mode ${mode} · model ${model}${val('--layer') ? ` · layer ${val('--layer')}` : ''}`);
for (const k of KS) console.log(`  recall@${String(k).padEnd(2)} ${(recall[k] * 100).toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(recall[k] * 40))}`);
console.log(`  MRR      ${mrr.toFixed(3)}`);
console.log(`  misses (gold absent from top ${K}): ${misses.length}   buried (rank>3): ${buried.length}`);
// What beat the gold note is the diagnosis: a keyword magnet, a near-duplicate, or a better answer.
if (misses.length) {
  console.log('\nMisses — and what ranked #1 instead:');
  for (const m of misses.slice(0, 10)) console.log(`  want ${m.gold}\n    got ${m.top1}\n    Q: ${m.q.slice(0, 90)}`);
}
if (buried.length) {
  console.log('\nBuried (found, but below rank 3):');
  for (const b of buried.slice(0, 8)) console.log(`  rank ${b.rank}  ${b.gold}  (beaten by ${b.top1})`);
}
