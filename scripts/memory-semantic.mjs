#!/usr/bin/env node
// Semantic (vector) search over the vault — the paraphrase bridge that FTS5 cannot be.
//
// Why: ctx_search is BM25 over FTS5, keyword-only. A question that shares no *distinctive* term
// with the note simply cannot match — "firewall" never reaches `WAF`, "short outage" never reaches
// `cutover`, and generic words ("production", "monorepo") are weighted to nothing. Measured
// 2026-08-14: 8 such questions scored 0/8 verbatim. Query expansion recovered 6/8 but depends on the
// agent remembering to expand; this matches by meaning instead.
//
// Local by construction: the model runs on-machine via onnxruntime. The vault holds PRIVATE notes
// (roster, KIDs, PI priorities) — nothing leaves the machine after the one-time model fetch.
//
// Model choice, measured on two versioned case sets (28 EN authored paraphrases, 15 NL).
// Current config (bge-m3, cls pooling, batch 1, alias chunks):
//                  EN @1    EN @5    EN MRR  |  NL @1    NL @5    NL MRR  | full build
//   bge-m3         35.7%    67.9%    0.479   |  46.7%    86.7%    0.617   |  ~5.7 min <- default
//   bge-small-en   32.1%    53.6%    0.415   |  33.3%    40.0%    0.354   |  ~51 s
//   e5-multi       10.7%    46.4%    0.273   |  26.7%    66.7%    0.425   |  ~96 s
// The bge-small/e5 rows predate the pooling, batch and alias-chunk fixes and are NOT comparable
// figures — they are what those models scored when they were the default, kept for history. Any
// real comparison needs a rebuild per model, which per-model indexes now make affordable.
// Sample sizes are small: one EN case is 3.6 points, one NL case 6.7. Read MRR and direction, not
// single-point moves. The build is a ONE-OFF anyway: indexes are per-model, and the steady-state
// refresh only re-embeds notes whose mtime moved.
// See MODELS below — dims, chunk size, prefixes, POOLING and thresholds are per-model and none of
// them transfer. Pooling in particular is silent when wrong: bge-m3 scored @5 25.0% mean-pooled and
// 67.9% cls-pooled, and the mean-pooled index returned confident, plausible, wrong rankings.
//
// Setup on a new machine (node_modules is gitignored, so the dep does not travel with the repo):
//   cd ~/.claude && npm install @huggingface/transformers && npm approve-scripts onnxruntime-node
//   (the postinstall fetches the native runtime; without it the pipeline cannot start)
//
// Usage:
//   node ~/.claude/scripts/memory-semantic.mjs --dupes                # same-folder near-duplicates
//   node ~/.claude/scripts/memory-semantic.mjs --clusters [--size 4]  # topics with no permanent/ note
//   node ~/.claude/scripts/memory-semantic.mjs --index [repo-dir]     # build/refresh (idempotent)
//   node ~/.claude/scripts/memory-semantic.mjs --query "how long was the site down" [-k 5]
//   node ~/.claude/scripts/memory-semantic.mjs --selftest
//
// ponytail: linear cosine scan over a few thousand 384-d vectors is ~5ms. No ANN index, no server.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { activeModel } from './lib/model-default.mjs';
import * as paths from '../hooks/lib/paths.mjs';

// Model profiles. Embedding models are asymmetric in different ways — BGE-en wants an instruction
// on the query only, E5 wants `query:`/`passage:` on both sides, bge-m3 wants neither. Getting the
// prefix wrong degrades retrieval silently, so it belongs with the model, not in a comment.
// Override with MEMORY_SEMANTIC_MODEL=<key>.
// BATCH SIZE IS 1 FOR EVERY MODEL, deliberately — verify with `--check-embedding`.
// Batching pads each text to the longest in its group and the padding CHANGES the output. Measured
// 2026-08-15, same string alone vs batched: bge-m3 cosine 0.986, bge-small 0.9966, e5 0.9973 — all
// three fail. Competing notes in this index sit ~0.001 apart, so a 0.014 shift does not perturb a
// ranking, it decides one, and a vector's value came to depend on which unrelated notes shared its
// batch. It surfaced as two rebuilds of BYTE-IDENTICAL notes scoring differently and was one
// sentence away from being written up as "run-to-run noise" — which would have set a permanent fake
// noise floor under every future A/B. Batching also loses on speed with real notes (0.14 s/chunk
// unpadded vs 0.28), because padding makes short chunks cost as much as the longest one beside them;
// the benchmark that said otherwise used equal-length strings, which never occur in a vault.
const MODELS = {
  // `dupeMin` is model-specific and NOT transferable: E5 packs everything into a high, narrow band,
  // so bge-small-en's 0.86 reports 29,560 pairs under e5-multi — noise that looks like a backlog.
  // Mean, NOT cls — measured, against the model card. BGE-v1.5 is documented as CLS-pooled, but on
  // the 28-case EN set cls scores @1 21.4% / MRR 0.337 against mean's 32.1% / 0.415. Whatever the
  // Xenova q8 export does, it is not what the card describes. Do not "fix" this to cls.
  'bge-small-en': { id: 'Xenova/bge-small-en-v1.5', dim: 384, maxChars: 1800, pool: 'mean', q: 'Represent this sentence for searching relevant passages: ', d: '', dupeMin: 0.86, clusterMin: 0.80 },
  // Multilingual, same 384 dims. Better Dutch at k>=3 (NL @5 66.7% vs bge's 40.0%) but a large
  // English regression (@1 10.7% vs 32.1%): its similarity band is compressed, so ranking barely
  // discriminates. Available for Dutch-heavy work; not the default.
  'e5-multi': { id: 'Xenova/multilingual-e5-small', dim: 384, maxChars: 1600, pool: 'mean', q: 'query: ', d: 'passage: ', dupeMin: 0.95, clusterMin: 0.92 },
  // 1024-dim multilingual. The 2026-08-15 "disqualified on cost" verdict was measuring my own
  // chunking, not the model: maxChars was 4000 here against 1800 everywhere else, and m3 accepts
  // 8192 tokens where bge-small truncates at 512 — so m3 alone actually processed the long tail,
  // at quadratic attention cost. Benchmarked at EQUAL length it is 9.6x bge-small (384ms vs 40ms
  // per 1800-char text), below its 17x parameter ratio. Aligned to 1800 so the A/B varies the
  // model and nothing else.
  //
  // dupeMin/clusterMin MEASURED 2026-08-17, and they were badly wrong before that: they had been
  // copied from e5-multi (0.95/0.92) and never calibrated, which made both scans report a clean
  // vault. Sweep over the 74-note claude-memory Insights set, against which a /memory:health audit
  // had already hand-identified 16 same-lesson pairs:
  //
  //   --dupes --min   0.95  0.90  0.86  0.84  0.80  0.75      --clusters --min  0.92 .. 0.76  0.72
  //   pairs              0     0     1     6     9    16      topics               0 .. 0       2
  //
  // Real duplicates occupy 0.75-0.869; the first coincidental pair appears at 0.714. m3's band sits
  // LOW and wide, the opposite of e5-multi's high narrow one — which is exactly why the number does
  // not transfer, in either direction. At 0.95 the scan found 0 of 16.
  //
  // clusterMin 0.72 is its own measurement, not dupeMin scaled: at 0.76 and above --clusters
  // returned nothing, at 0.72 it surfaced two real uncovered topics (shell-vs-Node fork cost;
  // conventional-commit version derivation), both with a typical-member similarity of ~0.89.
  //
  // Two real duplicates in that set scored BELOW 0.70 and no threshold would have found them; they
  // were caught by reading. This scan proposes, the human judges — do not read a clean run as proof.
  'bge-m3': { id: 'Xenova/bge-m3', dim: 1024, maxChars: 1800, d: '', q: '', pool: 'cls', dupeMin: 0.75, clusterMin: 0.72 },
};
// DEFAULT = bge-m3 since 2026-08-15, by measurement on both case sets (table at the top).
//
// It was rejected twice before that, and BOTH rejections were bugs in the harness, not the model:
//   1. "too slow" — its profile carried maxChars 4000 while every other model had 1800, so it alone
//      processed the long tail at quadratic attention cost. At equal length it is 9.6x bge-small,
//      below its 17x parameter ratio. Aligned: 3.8h extrapolated -> 7 min actual.
//   2. "worse retrieval" — mean pooling on a CLS-trained model. @5 25.0% -> 67.9% once fixed.
// Both failures were silent. Neither raised an error; both produced numbers that looked like a
// verdict on bge-m3. A model does not get disqualified until the thing measuring it is checked.
//
// e5-multi remains available for Dutch-heavy work (MEMORY_SEMANTIC_MODEL=e5-multi, then
// --index --rebuild), though bge-m3 now beats it on Dutch too.
//
// One index PER MODEL, not per vault: comparing two models used to cost a full rebuild in each
// direction, which is why the cost objection above was never re-tested. Suffixed DBs make a build
// a one-off you keep, so a model can be re-litigated for the price of an eval run.
export const MODEL_KEY = activeModel();
const PROFILE = MODELS[MODEL_KEY];
if (!PROFILE) { console.log(`unknown MEMORY_SEMANTIC_MODEL — known: ${Object.keys(MODELS).join(', ')}`); process.exit(1); }
const MODEL = PROFILE.id;
const DIM = PROFILE.dim;
const MAX_CHARS = PROFILE.maxChars;
const MIN_SECTION = 40; // a section body shorter than this carries no retrievable content
const QUERY_PREFIX = PROFILE.q;
const DOC_PREFIX = PROFILE.d;

// ---------------------------------------------------------------- pure helpers (self-tested)

export function stripFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: '', body: raw };
  const desc = (m[1].match(/^\s*description:\s*(.+)$/m) || [])[1] || '';
  return { meta: desc.trim().replace(/^["']|["']$/g, ''), body: raw.slice(m[0].length) };
}

// Every chunk carries the note's identity. Without it a mid-note section embeds as anonymous prose
// and a whole-note question cannot reach it — the vector equivalent of the "### Untitled" chunks
// FTS5 was returning for L1 notes.
export function chunkNote(name, raw) {
  const { meta, body } = stripFrontmatter(raw);
  const head = meta ? `${name}: ${meta}` : name;
  const out = [{ heading: '(card)', text: `${head}\n${body.slice(0, 700)}`.slice(0, MAX_CHARS) }];
  // `_Also asked as:` gets its OWN chunk. The convention was designed for FTS5, where a term only
  // has to be present — but it sits at the END of the note, so in vector space it lands inside the
  // last 1800-char section whose embedding is dominated by that section's actual subject. Measured
  // 2026-08-15: cra2-ecs-runtime-facts lists "can I trust the cra2 dashboards for alarm thresholds"
  // almost verbatim, and the near-identical question could not retrieve it inside the top FORTY.
  // Alone, the line is nothing but the questions the note answers — which is what a query looks like.
  // `$` under the /m flag means END OF LINE, not end of string — so the lazy quantifier stopped at
  // the first newline and the chunk held only the first line of a wrapped alias block. That is how
  // the very phrase this change was built to rescue ("alarm thresholds", line 3 of 4) stayed
  // unretrievable AFTER the fix shipped. `(?![\s\S])` is the end-of-input assertion /m cannot break.
  const alias = body.match(/^_Also asked as:([\s\S]*?)(?:\n\s*\n|(?![\s\S]))/m);
  // Led by the NAME only, not the description: the head line is ~260 chars of summary prose here and
  // would outweigh the questions it is supposed to introduce — the same dilution being fixed.
  if (alias) out.push({ heading: '(aliases)', text: `${name} — questions this note answers:\n${alias[1].replace(/_\s*$/, '').trim()}`.slice(0, MAX_CHARS) });
  for (const part of body.split(/^##\s+/m)) {
    const nl = part.indexOf('\n');
    if (nl === -1) continue; // no body under this heading
    const heading = part.slice(0, nl).trim();
    const text = part.slice(nl + 1).trim();
    if (text.length < MIN_SECTION) continue;
    for (let i = 0; i < text.length; i += MAX_CHARS) {
      const slice = text.slice(i, i + MAX_CHARS);
      if (slice.trim().length < MIN_SECTION) continue;
      out.push({ heading: heading || '(body)', text: `${head} — ${heading}\n${slice}` });
    }
  }
  return out;
}

// Corpus competition, fixed the way the eval skill always described it: a SEPARATE result window,
// not a replaced one. `--layer Memory` filters the corpus, so L1 notes stop being buried only
// because every Insights note is deleted from the window — measured 2026-08-15, that costs EN @5
// 67.9% -> 53.6%, because plenty of gold answers ARE Insights notes. Reserving slots instead lets
// the ~47 L1 notes surface without evicting the ~990 Insights ones.
// `sorted` is descending by `.s`; returns at most K, still score-ordered.
export function fuseReserved(sorted, K, reserve, isReserved) {
  const top = sorted.slice(0, K);
  const need = reserve - top.filter(isReserved).length;
  if (need <= 0) return top;
  // Promote only as far as there is something to evict, or the window grows past K when the top is
  // already all-reserved — caught by selftest, not by any query, since K/3 makes it rare in practice.
  const evictable = top.filter((x) => !isReserved(x)).length;
  const promote = sorted.slice(K).filter(isReserved).slice(0, Math.min(need, evictable));
  if (!promote.length) return top;
  // evict the weakest non-reserved entries — never a reserved one, or promotion eats itself
  let drop = promote.length;
  const kept = [];
  for (let i = top.length - 1; i >= 0; i--) {
    if (drop > 0 && !isReserved(top[i])) { drop--; continue; }
    kept.unshift(top[i]);
  }
  return [...kept, ...promote].sort((a, b) => b.s - a.s);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are L2-normalised at embed time, so the dot product IS cosine
}

// A stored vector whose byte length does not match the active model's dimension is from a DIFFERENT
// model. Reading it as `new Float32Array(buf, offset, DIM)` does not throw — it silently reinterprets
// the bytes and returns a plausible-looking score. That is how a mixed-dimension index (384 + 1024 in
// one table, 2026-08-15) can serve nonsense with no error anywhere.
export function assertVectorWidth(rows, dim, label = 'index') {
  const want = dim * 4;
  const bad = rows.filter((r) => r.vec.byteLength !== want);
  if (!bad.length) return rows;
  const widths = [...new Set(bad.map((r) => r.vec.byteLength))].join(', ');
  console.log(`⚠ ${label}: ${bad.length}/${rows.length} vectors are ${widths} bytes, expected ${want} (${dim}-dim).`);
  console.log('  The index mixes models — results would be silent nonsense. Run --index --rebuild.');
  process.exit(1);
}

// Same-folder near-duplicates by MEANING. The Jaccard scan in memory-audit-checks.mjs clusters by
// shared tokens and therefore cannot see notes that restate one idea in different words — on
// 2026-08-14 it reported 0 pairs ≥0.45 across 987 notes while six real merges sat in them
// ("origin owns Cache-Control" / "cache-control at origin not CloudFront" / "cache-control source
// should follow the content source"). Same keyword-vs-meaning gap that made ctx_search miss
// paraphrased questions. Cross-folder pairs are complementary by design and are never reported.
//
// Topic clusters, for finding CONSOLIDATION GAPS — many notes on one idea with no permanent/ note
// covering them. Deliberately CROSS-folder, unlike dedup: a topic is normally a Pattern + a Mistake
// + a Decision about the same thing. The 9-note cache-policy-quota cluster and the 6-note
// Cache-Control family both sat unnoticed for weeks because nothing measured this.
// Union-find over the similarity graph: single-linkage, so a chain of related notes forms one topic
// rather than requiring every pair to be similar.
export function clusterNotes(items, minScore) {
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (cosine(items[i].vec, items[j].vec) >= minScore) union(i, j);
  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });
  return [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
}

// Mean of L2-normalised vectors, re-normalised — the cluster's "average meaning", used to ask
// whether any permanent/ note already covers it.
export function centroid(vecs) {
  const out = new Float32Array(vecs[0].length);
  for (const v of vecs) for (let i = 0; i < v.length; i++) out[i] += v[i];
  let n = 0;
  for (let i = 0; i < out.length; i++) n += out[i] * out[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

export function samefolderPairs(items, minScore) {
  const out = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].layer !== items[j].layer) continue;
      const s = cosine(items[i].vec, items[j].vec);
      if (s >= minScore) out.push({ s, layer: items[i].layer, a: items[i].note, b: items[j].note });
    }
  return out.sort((x, y) => y.s - x.s);
}

// ---------------------------------------------------------------- lexical arm + fusion
//
// The two channels miss DIFFERENT notes. Measured 2026-08-15 on the real vault: of 7 EN cases the
// vector arm missed, keyword search finds 4 — all of them identifier-shaped (a CLI note, a ticket
// key, two dated commit-style titles). NL: 1 of 2. That is the ceiling fusion is reaching for, and
// it includes cra2-ecs-runtime-facts, which sat outside the top 40 semantically and survived two
// other attempted fixes.
//
// RECIPROCAL RANK FUSION, not a weighted sum of scores. Cosine sits in a narrow ~0.4-0.7 band while
// BM25 is unbounded, so summing them needs a normaliser, and a normaliser is one more thing that is
// silently per-model — today already produced four of those (pooling, dedup threshold, chunk size,
// batch). RRF consumes RANKS, so it cannot be broken by a model with a compressed similarity band,
// which is exactly how e5-multi failed. One knob: how much a vector rank outweighs a keyword rank.
const STOP = new Set('the a an and or of to in on for is are was were it its this that with as by at from be not you your we our they them if then when what which how why do does did can could should would use used using via no yes into over under more most less least than each per also only just same other about have has had will'.split(' '));
export const lexTokens = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

// Textbook BM25 over the chunk texts already in the index — no second store, no extra dependency.
export function bm25(docs, qTokens, k1 = 1.2, b = 0.75) {
  const N = docs.length || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  const avgdl = docs.reduce((a, d) => a + d.toks.length, 0) / N;
  return docs.map((d) => {
    const tf = new Map();
    for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of qTokens) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const n = df.get(t) || 0;
      s += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.toks.length / avgdl));
    }
    return s;
  });
}

// `w` weights the vector rank against the keyword rank. w=0 is keyword-only, a large w is
// vector-only. RRF_K flattens the top of the curve so rank 1 vs 2 is not a landslide.
const RRF_K = 60;
// Swept on both real-vault case sets, 2026-08-15 (28 EN authored paraphrases, 15 NL):
//     w        EN@1   EN@5  EN MRR  |  NL@1   NL@5  NL MRR
//     0 (off)  35.7   67.9   0.479  |  46.7   86.7   0.617
//     1        39.3   75.0   0.558  |  40.0   80.0   0.558   <- best EN MRR, but NL regresses
//     2        39.3   82.1   0.547  |  46.7   86.7   0.628   <- chosen
//     4        32.1   85.7   0.516  |  40.0   86.7   0.592   <- best EN@5, both @1 regress
//     20       35.7   71.4   0.505  |  46.7   86.7   0.633
// Chosen on "no column regresses on either language", which only w=2 satisfies. It buys EN @5
// 67.9 -> 82.1 (+4 cases, exactly the headroom the channel-disagreement analysis predicted) and
// leaves Dutch alone, where the vector arm was already strong.
//
// NOTE 20 is obsidian-second-brain's swept value and is WORSE here on every EN column. Their
// number was measured on their vault with their fusion formula; the sweep is the transferable
// part, the weight is not. Fifth per-setup parameter today after pooling, dedup threshold, chunk
// size and batch. Re-sweep after any model change.
// 0 disables fusion (vector only). Override per run with MEMORY_FUSE_W.
const DEFAULT_FUSE_W = 2;
// 'chunk' by MEASUREMENT — 'note' (concatenate a note's chunks, then score) was tried on the
// hypothesis that a long note whose query terms are spread thin would fare better whole. It is
// worse everywhere, at every weight, and it mauls Dutch (w=2: EN@1 39.3->32.1, EN MRR
// 0.547->0.506, NL@1 46.7->26.7, NL MRR 0.628->0.515). Whole-note BM25 rewards length — more
// terms, more chances to match — so long generic notes displace short precise ones, and a Dutch
// query matching few terms is exactly where length normalisation matters most. It also did NOT
// rescue cra2-ecs-runtime-facts, the note the hypothesis was built around. Kept as an option so
// the negative result stays reproducible: MEMORY_FUSE_LEX=note.
const DEFAULT_FUSE_LEX = 'chunk';
export function fuseRRF(semRanked, lexRanked, w, k) {
  const score = new Map();
  const add = (list, weight) => list.forEach((note, i) => score.set(note, (score.get(note) || 0) + weight / (RRF_K + i + 1)));
  add(semRanked, w);
  add(lexRanked, 1);
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([note]) => note);
}

if (process.argv.includes('--selftest')) {
  const { strict: assert } = await import('node:assert');
  const fm = stripFrontmatter('---\nname: x\ndescription: "A thing"\n---\nbody here\n');
  assert.equal(fm.meta, 'A thing');
  assert.equal(fm.body.trim(), 'body here');
  assert.equal(stripFrontmatter('no frontmatter').meta, '');
  const doc = '---\ndescription: D\n---\nintro\n\n## First\nalpha text long enough to be worth embedding here\n\n## Second\nbeta text long enough to be worth embedding here\n';
  const ch = chunkNote('my-note', doc);
  assert.equal(ch[0].heading, '(card)');
  assert.ok(ch[0].text.startsWith('my-note: D'));
  assert.deepEqual(ch.slice(1).map((c) => c.heading), ['First', 'Second']);
  assert.ok(ch[1].text.includes('my-note: D — First'), 'section chunks must carry note identity');
  assert.equal(chunkNote('n', '---\ndescription: D\n---\n## H\ntiny\n').length, 1, 'sub-threshold sections dropped');
  // a section longer than the window splits, and every piece keeps the identity header
  const long = chunkNote('n', `---\ndescription: D\n---\n## H\n${'x'.repeat(MAX_CHARS * 2 + 100)}\n`);
  assert.equal(long.length, 4, 'card + 3 slices');
  assert.ok(long.every((c) => c.text.startsWith('n')));
  const v = new Float32Array([0.6, 0.8]);
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(v, new Float32Array([-0.8, 0.6]))) < 1e-6);
  // dedup: same-folder only, sorted, threshold respected
  const near = new Float32Array([0.6, 0.8]), far = new Float32Array([-0.8, 0.6]);
  const mid = new Float32Array([0.66, 0.75]); // ~0.996 with `near`
  const pairs = samefolderPairs(
    [
      { note: 'a', layer: 'Patterns', vec: near },
      { note: 'b', layer: 'Patterns', vec: mid },
      { note: 'c', layer: 'Patterns', vec: far },
      { note: 'd', layer: 'Decisions', vec: near }, // cross-folder twin of `a` — must NOT pair
    ],
    0.9
  );
  assert.equal(pairs.length, 1, 'only the same-folder near pair');
  assert.deepEqual([pairs[0].a, pairs[0].b], ['a', 'b']);
  assert.equal(pairs[0].layer, 'Patterns');
  assert.equal(samefolderPairs([{ note: 'a', layer: 'P', vec: near }, { note: 'b', layer: 'P', vec: far }], 0.9).length, 0);
  // clustering: cross-folder by design, single-linkage, singletons dropped
  const c1 = new Float32Array([1, 0]), c2 = new Float32Array([0.99, 0.141]), c3 = new Float32Array([0.97, 0.24]);
  const groups = clusterNotes(
    [
      { note: 'a', layer: 'Patterns', vec: c1 },
      { note: 'b', layer: 'Mistakes', vec: c2 }, // different folder — must still cluster
      { note: 'c', layer: 'Decisions', vec: c3 }, // only close to b: single-linkage chains it in
      { note: 'lonely', layer: 'Patterns', vec: new Float32Array([0, 1]) },
    ],
    0.95
  );
  assert.equal(groups.length, 1, 'one topic; the singleton is dropped');
  assert.equal(groups[0].length, 3);
  assert.deepEqual(new Set(groups[0].map((g) => g.layer)), new Set(['Patterns', 'Mistakes', 'Decisions']));
  // centroid of identical vectors is that vector; of a spread, it is normalised
  assert.ok(Math.abs(cosine(centroid([c1, c1]), c1) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(centroid([c1, c2, c3]), c1) - 1) < 0.05);
  // fuseReserved: promotion must respect K, never evict a reserved item, and stay score-ordered
  const mk = (n, s, layer) => ({ r: { note: n, layer }, s });
  const isMem = (x) => x.r.layer === 'Memory';
  const feed = [mk('i1', 0.9, 'Patterns'), mk('i2', 0.8, 'Patterns'), mk('i3', 0.7, 'Patterns'),
                mk('m1', 0.6, 'Memory'), mk('m2', 0.5, 'Memory')];
  let f = fuseReserved(feed, 3, 1, isMem);
  assert.deepEqual(f.map((x) => x.r.note), ['i1', 'i2', 'm1'], 'weakest non-reserved is evicted, not the strongest');
  assert.equal(f.length, 3, 'fusion must never exceed K');
  assert.ok(f.every((x, i) => i === 0 || f[i - 1].s >= x.s), 'result stays score-ordered');
  // already satisfied -> untouched; nothing to promote -> untouched
  assert.deepEqual(fuseReserved([mk('m1', 0.9, 'Memory'), mk('i1', 0.8, 'Patterns')], 2, 1, isMem).map((x) => x.r.note), ['m1', 'i1']);
  assert.deepEqual(fuseReserved([mk('i1', 0.9, 'Patterns'), mk('i2', 0.8, 'Patterns')], 2, 1, isMem).map((x) => x.r.note), ['i1', 'i2']);
  // an all-reserved window must not cannibalise itself to make room
  assert.equal(fuseReserved([mk('m1', 0.9, 'Memory'), mk('m2', 0.8, 'Memory'), mk('m3', 0.7, 'Memory')], 2, 3, isMem).length, 2);
  // the alias line must become its own chunk, stripped of markdown, carrying the note identity
  const aliased = chunkNote('cra2-facts', '---\nname: x\ndescription: d\n---\n## Body\nSome long prose about ECS task counts and subnet exhaustion that has nothing to do with the question.\n\n_Also asked as: can I trust the dashboards for alarm thresholds, do we have NAT gateways._\n');
  const ali = aliased.find((c) => c.heading === '(aliases)');
  assert.ok(ali, 'alias line must produce a chunk of its own');
  assert.ok(ali.text.includes('cra2-facts'), 'alias chunk must carry the note identity');
  assert.ok(ali.text.includes('alarm thresholds') && !ali.text.includes('subnet exhaustion'),
    'alias chunk must hold ONLY the questions — mixing in body prose is the dilution being fixed');
  assert.ok(!/_$/.test(ali.text.trim()), 'trailing markdown underscore stripped');
  assert.ok(!ali.text.includes('d\n'), 'alias chunk leads with the NAME, not the long description');
  // A WRAPPED alias block must survive whole. The first version used /m with $, which anchors to
  // end-of-LINE, so it kept only line 1 — and the single-line fixture above could never catch it.
  const wrapped = chunkNote('n', '---\nname: x\n---\n## B\nbody prose here to fill the section out.\n\n_Also asked as: first question here,\nsecond question here,\nthird question about alarm thresholds._\n');
  const wali = wrapped.find((c) => c.heading === '(aliases)');
  assert.ok(wali.text.includes('first question') && wali.text.includes('third question about alarm thresholds'),
    'every line of a wrapped alias block must be kept');
  assert.equal(chunkNote('n', '---\nname: x\n---\n## B\nprose with no alias line at all here.\n').filter((c) => c.heading === '(aliases)').length, 0);
  // ---- lexical arm + fusion
  assert.deepEqual(lexTokens('The WAF rule, and a 403!'), ['waf', 'rule', '403'], 'stopwords and punctuation dropped');
  const docs = [
    { toks: lexTokens('the alarm threshold was calibrated on a quiet period') },
    { toks: lexTokens('unrelated note about cookies and sessions') },
    { toks: lexTokens('alarm alarm alarm') },
  ];
  const sc = bm25(docs, lexTokens('alarm threshold'));
  assert.ok(sc[0] > sc[1], 'a matching doc must outscore a non-matching one');
  assert.equal(sc[1], 0, 'no shared term means no score');
  assert.ok(sc[0] > sc[2], 'matching BOTH terms must beat repeating one — saturation, not raw count');

  // fusion consumes RANKS, so a channel with a compressed score band cannot dominate by scale
  const semR = ['a', 'b', 'c'], lexR = ['c', 'z', 'a'];
  assert.deepEqual(fuseRRF(semR, lexR, 1, 3), ['a', 'c', 'b'], 'agreement wins, then each channel\'s best');
  assert.deepEqual(fuseRRF(semR, lexR, 1000, 2), ['a', 'b'], 'a large weight collapses to vector order');
  assert.deepEqual(fuseRRF(semR, lexR, 0, 2), ['c', 'z'], 'zero weight collapses to keyword order');
  assert.equal(fuseRRF(semR, lexR, 1, 10).length, 4, 'union of both lists, deduplicated');
  // a note only ONE channel found must still be reachable — that is the entire point
  assert.ok(fuseRRF(semR, lexR, 1, 4).includes('z'), 'keyword-only find must survive fusion');

  // ---- profile invariants. The bge-m3 "too slow" verdict came from ITS profile carrying maxChars
  // 4000 while everyone else had 1800: the A/B varied model AND chunk size, and nothing complained.
  // Chunk size must stay comparable across models or a model comparison measures the chunking.
  const sizes = Object.values(MODELS).map((m) => m.maxChars);
  const spread = Math.max(...sizes) / Math.min(...sizes);
  assert.ok(spread <= 1.25, `maxChars spread ${spread.toFixed(2)}x across models — a model A/B would be confounded by chunk size`);
  for (const [k, m] of Object.entries(MODELS)) {
    // pooling must be stated, never inherited: it is silent when wrong (bge-m3 @5 25.0% vs 67.9%)
    // and the right answer contradicts the model card for bge-small.
    assert.ok(m.pool === 'cls' || m.pool === 'mean', `${k}: pool must be declared explicitly`);
    assert.ok(m.dim > 0 && m.maxChars > 0 && typeof m.id === 'string', `${k}: incomplete profile`);
  }

  // ---- property check against REAL notes, not fixtures. The truncation bug survived a green
  // unit test because I wrote the fixture from the same wrong model as the code — one alias line,
  // so end-of-line and end-of-string looked identical. Real notes wrap; assert on those instead.
  // Skipped silently when no vault is reachable, so the selftest still runs anywhere.
  // Resolve the vault HERE: this block runs long before the module-level VAULT/SLUG consts, so
  // referencing them threw a dead-zone ReferenceError that the catch below reported as "no vault".
  // The check meant to find silent failures was itself failing silently. Skips must name a reason.
  let checked = 0, skipReason = '', project = '(unresolved)';
  try {
    const vroot = paths.vault();
    const vslug = paths.projectKey(process.cwd());
    project = vslug;
    const dirs = [path.join(vroot, 'Memory', vslug), path.join(vroot, 'permanent', 'tools'),
                  path.join(vroot, 'Insights', vslug, 'Mistakes')];
    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.md')).slice(0, 80)) {
        const raw = fs.readFileSync(path.join(d, f), 'utf8');
        const block = raw.match(/^_Also asked as:([\s\S]*?)(?:\n\s*\n|(?![\s\S]))/m);
        if (!block || block[1].length > MAX_CHARS - 200) continue;   // over-long blocks may legally clip
        const chunks = chunkNote(f.slice(0, -3), raw);
        const ali = chunks.find((c) => c.heading === '(aliases)');
        assert.ok(ali, `${f}: has an alias block but produced no alias chunk`);
        const lastWord = block[1].replace(/[_.\s]+$/, '').split(/\s+/).pop();
        assert.ok(ali.text.includes(lastWord),
          `${f}: alias chunk lost its tail ("${lastWord}") — a wrapped block was truncated`);
        checked++;
      }
    }
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;   // a real finding must never look like a skip
    skipReason = `${e.constructor.name}: ${e.message.split('\n')[0]}`;
  }
  // A check that quietly verifies nothing is worse than no check: it reads as a passing test.
  assert.ok(checked > 0 || skipReason, 'real-note check matched no notes and gave no reason — it is not running');
  // Print BOTH: an early abort after N successes used to render as a clean "+N checked", hiding
  // the error that stopped it. A count is not evidence of completion.
  assert.ok(!skipReason, `real-note check aborted after ${checked} notes — ${skipReason}`);
  // Name the project. Running this from ~/.claude silently audits the CONFIG repo instead of the
  // work vault — hit SEVEN times on 2026-08-15, and here it quietly shrank a 345-note check to 6
  // while still printing a pass. Coverage that depends on cwd must state which cwd it got.
  console.log(`selftest: 52 assertions passed (+${checked} real notes chunk-checked in ${project})`);
  process.exit(0);
}

// ---------------------------------------------------------------- setup

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const repo = argv.filter((a) => !a.startsWith('-')).find((a) => fs.existsSync(a) && fs.statSync(a).isDirectory()) || process.cwd();
// --vault/--slug point this at a generated benchmark vault instead of the real one, which is how
// a retrieval change gets scored against a FIXED note set. Explicit flags, not CLAUDE_VAULT: an
// env override once sent a relocating hook at a throwaway path and cost 24 notes.
const VAULT = val('--vault') || paths.vault();
const SLUG = val('--slug') || paths.projectKey(repo);
const DB_DIR = paths.stateDir('db');
const DB_PATH = path.join(DB_DIR, `semantic-${SLUG}-${MODEL_KEY}.db`);
const db = new DatabaseSync(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY, note TEXT, layer TEXT, file TEXT, mtime INTEGER,
  heading TEXT, text TEXT, vec BLOB)`);
db.exec('CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file)');
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

// Vectors from two different models are not comparable — cosine between them is noise that looks
// like a score. Record which model built the index; --index rebuilds on a change, everything else
// refuses to run against a stale one rather than returning quiet nonsense.
const storedModel = db.prepare("SELECT value FROM meta WHERE key = 'model'").get()?.value;
const hasChunks = db.prepare('SELECT COUNT(*) c FROM chunks').get().c > 0;
// An index written before this table existed records no model. Treat unknown as MISMATCHED, not as
// "probably fine" — the first version of this guard did the latter and quietly kept serving stale
// vectors from the previous model while reporting the index as current.
const modelChanged = hasChunks && storedModel !== MODEL;

let embedder = null;
async function embed(texts) {
  if (!embedder) {
    const transformers = await import('@huggingface/transformers');
    // Redirect the weights to $CLAUDE_MEMORY_HOME/models BEFORE the first pipeline() call.
    // The default caches ~722 MB inside node_modules/@huggingface/transformers/.cache, which is
    // the plugin's version-pinned dir and is discarded on every /plugin update.
    paths.useModelCache(transformers);
    embedder = await transformers.pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  }
  // Pooling is per-model and silent when wrong, exactly like the query/passage prefixes above.
  // The BGE family trains its dense vector on the CLS token; E5 trains on the mean. Feeding a
  // BGE model mean-pooled vectors still returns plausible cosines, so the loss never surfaces
  // as an error — only as rankings that are quietly worse than the model can do.
  // Slice HERE, not in the callers, so the index path and the query path embed identically. They
  // did not: indexing batched 8 while a query batched however many questions were asked at once —
  // so the eval harness (28 questions in one padded batch) computed different vectors than a live
  // session (one question). With batch 1 the padding is gone and both sides agree by construction.
  const B = PROFILE.batch ?? 1;   // 1 = no padding. See --check-embedding; every model tested fails at >1.
  const vecs = [];
  for (let i = 0; i < texts.length; i += B) {
    const out = await embedder(texts.slice(i, i + B), { pooling: PROFILE.pool ?? 'mean', normalize: true });
    for (const v of out.tolist()) vecs.push(Float32Array.from(v));
  }
  return vecs;
}

// Every mode except --index reads vectors it did not build; refuse if they came from another model
// rather than returning scores that look plausible and mean nothing.
if (modelChanged && !flag('--index')) {
  console.log(`index was built with ${storedModel}, but ${MODEL} is configured — run --index to rebuild.`);
  process.exit(1);
}


// ---------------------------------------------------------------- coverage

function vaultSources() {
  const out = [{ dir: path.join(VAULT, 'Memory', SLUG), layer: 'Memory' }];
  for (const f of ['Patterns', 'Mistakes', 'Decisions'])
    out.push({ dir: path.join(VAULT, 'Insights', SLUG, f), layer: f });
  // permanent/ is cross-project, not slug-scoped. Indexed here so --clusters can ask "is this topic
  // already consolidated?", and so promoted knowledge is searchable at all.
  out.push({ dir: path.join(VAULT, 'permanent'), layer: 'permanent' });
  for (const sub of ['domain', 'tools']) out.push({ dir: path.join(VAULT, 'permanent', sub), layer: 'permanent' });
  return out;
}

// Is every note actually IN the index? Nobody had ever asked. A note missing from the index is
// indistinguishable from a note that ranks badly — both just fail to appear — so the whole class
// hides behind "retrieval is imperfect". obsidian-second-brain lists 100% index coverage as one of
// its measured gains, which is what prompted checking ours: it was 1047 of 1048.
if (flag('--coverage')) {
  const onDisk = new Map();   // stem -> [paths]
  for (const { dir } of vaultSources()) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')))
      onDisk.set(f.slice(0, -3), [...(onDisk.get(f.slice(0, -3)) ?? []), path.join(dir, f)]);
  }
  const indexed = new Set(db.prepare('SELECT DISTINCT note n FROM chunks').all().map((r) => r.n));
  const missing = [...onDisk.keys()].filter((n) => !indexed.has(n));
  // A stem that exists twice is worse than a missing note: the index keys by stem, so two files
  // MERGE into one entry, best-chunk scoring mixes their content, and an Obsidian [[wikilink]] to
  // that name is ambiguous too. It reads as full coverage while silently holding one note fewer.
  const collisions = [...onDisk.entries()].filter(([, paths]) => paths.length > 1);
  console.log(`project ${SLUG}`);
  console.log(`  on disk ${onDisk.size} distinct names (${[...onDisk.values()].flat().length} files) · indexed ${indexed.size}`);
  if (missing.length) console.log(`  MISSING from the index (${missing.length}):\n    ${missing.join('\n    ')}`);
  for (const [stem, paths] of collisions)
    console.log(`  NAME COLLISION "${stem}" — the index merges these into one entry:\n    ${paths.join('\n    ')}`);
  if (!missing.length && !collisions.length) console.log('  OK — every note is indexed exactly once.');
  process.exit(missing.length || collisions.length ? 1 : 0);
}

// ---------------------------------------------------------------- embedding property check

// Batching pads every text to the longest in its group, and the padding CHANGES the output — the
// same string scored cosine 0.986 against itself on 2026-08-15, while competing notes here sit
// ~0.001 apart. No model card mentions it. Ten seconds, and it re-checks the property for whatever
// model is configured, instead of trusting that this one behaves like the last one.
if (flag('--check-embedding')) {
  const t = 'a representative note section about alarm thresholds, WAF rules and deployment controllers';
  const [alone] = await embed([t]);
  const [again] = await embed([t]);
  const batched = (await embed([t, 'short', 'x'.repeat(1500)]))[0];
  const self = cosine(alone, again), mixed = cosine(alone, batched);
  console.log(`model ${MODEL}  batch=${PROFILE.batch ?? 1}`);   // must mirror embed(); a stale default here reports a batch size the code does not use
  console.log(`  same text twice        cosine ${self.toFixed(6)}`);
  console.log(`  alone vs in a batch    cosine ${mixed.toFixed(6)}`);
  const ok = self > 0.99999 && mixed > 0.99999;
  console.log(ok
    ? '  OK — embedding is stable; batch company does not change the vector.'
    : `  FAIL — batch company shifts the vector by ${(1 - mixed).toFixed(4)}. Set batch: 1 for this model.`);
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------- index

if (flag('--index')) {
  // Cross-process write lock, PER MODEL — same scope as the DB it guards. A long background
  // bge-m3 build must not stall the default profile's incremental refresh. (The cross-model
  // corruption this lock was born from — a table holding 384-dim and 1024-dim vectors at once —
  // is now structurally impossible: the two models no longer share a file.)
  const lockDir = path.join(DB_DIR, `.index-${MODEL_KEY}.lock`);
  let locked = false;
  try { fs.mkdirSync(lockDir); locked = true; } catch {
    const age = Date.now() - (fs.statSync(lockDir).mtimeMs || 0);
    if (age < 30 * 60 * 1000) { console.log('another --index is running (lock held); skipping'); process.exit(0); }
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir); locked = true;   // reclaim a lock left by a killed run
  }
  const releaseLock = () => { if (locked) { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {} locked = false; } };
  process.on('exit', releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLock(); process.exit(1); });

  const sources = vaultSources();

  const files = [];
  for (const { dir, layer } of sources) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      if (f === 'REFLECTIONS.md') continue; // an audit log, not a memory
      const full = path.join(dir, f);
      files.push({ full, layer, note: f.slice(0, -3), mtime: Math.floor(fs.statSync(full).mtimeMs) });
    }
  }

  // --rebuild forces a full re-embed. Needed when the metadata cannot be trusted: a run that
  // recorded the model without re-embedding leaves the DB claiming one model while holding another
  // model's vectors, and no automatic check can see that.
  if (modelChanged || flag('--rebuild')) {
    console.log(`model changed ${storedModel ?? '(unrecorded)'} → ${MODEL}; rebuilding the whole index (vectors are not comparable across models)`);
    db.exec('DELETE FROM chunks');
  }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('model', MODEL);

  // Incremental: re-embed only notes whose mtime moved; drop rows for deleted notes.
  const known = new Map(db.prepare('SELECT file, MAX(mtime) AS mtime FROM chunks GROUP BY file').all().map((r) => [r.file, r.mtime]));
  const live = new Set(files.map((f) => f.full));
  let dropped = 0;
  for (const f of known.keys()) if (!live.has(f)) { db.prepare('DELETE FROM chunks WHERE file = ?').run(f); dropped++; }
  const stale = files.filter((f) => known.get(f.full) !== f.mtime);

  console.log(`${files.length} notes · ${stale.length} to (re)embed · ${dropped} removed`);
  if (!stale.length) { console.log('index already current'); process.exit(0); }

  const del = db.prepare('DELETE FROM chunks WHERE file = ?');
  const ins = db.prepare('INSERT INTO chunks (note, layer, file, mtime, heading, text, vec) VALUES (?,?,?,?,?,?,?)');
  const pending = [];
  for (const f of stale) {
    del.run(f.full);
    for (const c of chunkNote(f.note, fs.readFileSync(f.full, 'utf8')))
      pending.push({ ...c, note: f.note, layer: f.layer, file: f.full, mtime: f.mtime });
  }

  const BATCH = PROFILE.batch ?? 1;    // embed() slices to the same size; keep them equal
  const t0 = Date.now();
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const vecs = await embed(batch.map((b) => DOC_PREFIX + b.text));
    batch.forEach((b, j) => ins.run(b.note, b.layer, b.file, b.mtime, b.heading, b.text, new Uint8Array(vecs[j].buffer)));
    try { fs.utimesSync(lockDir, new Date(), new Date()); } catch {}  // heartbeat: a slow model's build outlives the 30-min stale window
    if ((i / BATCH) % 10 === 0) console.log(`  ${Math.min(i + BATCH, pending.length)}/${pending.length} chunks`);
  }
  console.log(`indexed ${pending.length} chunks from ${stale.length} notes in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${DB_PATH}`);
  process.exit(0);
}

// ---------------------------------------------------------------- consolidation gaps

if (flag('--clusters')) {
  const min = Number(val('--min') || PROFILE.clusterMin);
  const minSize = Number(val('--size') || 4);
  const cards = db.prepare("SELECT note, layer, text, vec FROM chunks WHERE heading = '(card)'").all()
    .map((r) => ({ note: r.note, layer: r.layer, text: r.text, vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, DIM) }));
  if (!cards.length) { console.log('empty index — run --index first'); process.exit(1); }

  const permanent = cards.filter((c) => c.layer === 'permanent');
  const working = cards.filter((c) => c.layer !== 'permanent');
  const clusters = clusterNotes(working, min).filter((g) => g.length >= minSize);

  console.log(`${working.length} notes · ${permanent.length} permanent/ notes · clusters ≥${minSize} at ≥${min}: ${clusters.length}\n`);
  let gaps = 0;
  for (const g of clusters) {
    const c = centroid(g.map((x) => x.vec));
    // Is this topic already consolidated? Compare the cluster's average meaning to permanent/.
    let best = { note: null, s: 0 };
    for (const p of permanent) { const s = cosine(c, p.vec); if (s > best.s) best = { note: p.note, s }; }
    // Absolute thresholds are meaningless here: E5 puts every pair in a narrow high band, so the
    // nearest permanent/ note scores ~0.91 against topics it has nothing to do with. Calibrate
    // against the cluster itself instead — a note that genuinely covers this topic should sit as
    // close to the centroid as a typical MEMBER does. Self-scaling, and model-independent.
    // Bar = the 25th percentile of member distances, NOT the median. Requiring a synthesis note to
    // be more central than half the cluster is arbitrary — half the members fail that test by
    // definition. Measured: a hand-written synthesis of a 22-note cluster landed at 0.945 against a
    // 0.947 median and was reported as a gap, which is the test being wrong, not the note.
    // "As close as a typical member" is the real question.
    const memberSims = g.map((x) => cosine(c, x.vec)).sort((a, b) => a - b);
    const typical = memberSims[Math.floor(memberSims.length * 0.25)];
    if (best.s >= typical) continue; // a permanent/ note sits inside the topic's own spread
    gaps++;
    if (gaps > Number(val('--top') || 8)) continue;
    const mix = g.reduce((m, x) => ((m[x.layer] = (m[x.layer] || 0) + 1), m), {});
    console.log(`${g.length} notes — ${Object.entries(mix).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    console.log(best.s >= typical - 0.02
      ? `   nearest permanent/: ${best.note} ${best.s.toFixed(3)} vs typical member ${typical.toFixed(3)} — borderline; check whether it should absorb this`
      : `   no permanent/ note covers this (best ${best.note ?? 'n/a'} ${best.s.toFixed(3)} vs typical member ${typical.toFixed(3)})`);
    // /memory:synthesize needs the whole membership, not a preview — it must read every note.
    const showMembers = Number(val('--members') || 6);
    for (const x of g.slice(0, showMembers)) console.log(`   · [${x.layer}] ${x.note}`);
    if (g.length > showMembers) console.log(`   · …and ${g.length - showMembers} more (--members 99)`);
    console.log('');
  }
  const shown = Math.min(gaps, Number(val('--top') || 8));
  console.log(gaps
    ? `${gaps} topic(s) with no consolidated note${gaps > shown ? ` (showing the ${shown} largest)` : ''}. Writing one is a judgement call — this only finds where it is missing.`
    : 'every cluster is covered by a permanent/ note.');
  process.exit(0);
}

// ---------------------------------------------------------------- dedup

if (flag('--dupes')) {
  const min = Number(val('--min') || PROFILE.dupeMin);
  // One vector per note: the '(card)' chunk carries title + description + the opening body, which
  // for a short Insight note is effectively the whole note. Comparing cards keeps this O(notes²)
  // (~165k pairs, well under a second) instead of O(chunks²).
  const rawCards = db.prepare("SELECT note, layer, text, vec FROM chunks WHERE heading = '(card)'").all();
  assertVectorWidth(rawCards, DIM, 'dupes');
  const cards = rawCards.map((r) => ({ note: r.note, layer: r.layer, text: r.text, vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, DIM) }));
  if (!cards.length) { console.log('empty index — run --index first'); process.exit(1); }
  const pairs = samefolderPairs(cards, min);
  const byNote = new Map(cards.map((c) => [c.note, c]));
  console.log(`${cards.length} notes · same-folder pairs ≥ ${min}: ${pairs.length}`);
  console.log('(cross-folder pairs are complementary by design and are not reported)\n');
  for (const p of pairs.slice(0, Number(val('--top') || 30))) {
    console.log(`${p.s.toFixed(3)} [${p.layer}]`);
    for (const n of [p.a, p.b]) console.log(`   ${n}\n      ${byNote.get(n).text.replace(/\s+/g, ' ').slice(0, 130)}…`);
  }
  console.log('\nJudge each pair: merge when it adds coverage, keep when it only removes a file.');
  process.exit(0);
}

// ---------------------------------------------------------------- query

const loadedAt = Date.now();
const queries = argv.filter((a, i) => argv[i - 1] === '--query' || argv[i - 1] === '-q');
if (!queries.length && !flag('--serve')) {
  console.log('usage: --index | --query "question" [--query "..."] [-k 5] | --selftest');
  process.exit(1);
}
const K = Number(val('-k') || 5);
// --layer Memory gives L1 its own result window. Without it the ~990 Insights notes bury the ~47
// Memory ones: measured 2026-08-14, gold L1 notes sat at rank 20 and 35 unscoped, top-3 scoped.
// Same corpus-competition effect BM25 shows — a bigger k does not fix it, a separate window does.
const layer = val('--layer');
const rows = layer
  ? db.prepare('SELECT note, layer, heading, text, vec FROM chunks WHERE layer = ?').all(layer)
  : db.prepare('SELECT note, layer, heading, text, vec FROM chunks').all();
if (!rows.length) { console.log(layer ? `no chunks in layer ${layer}` : 'empty index — run --index first'); process.exit(1); }
// Ablation switch, so the alias-chunk change can be scored against its own absence on ONE index.
// Otherwise the A/B needs two full rebuilds, and the note set moves between them — which is exactly
// how the 2026-08-15 alias measurement was first taken (1034 notes before, 1047 after) and why it
// could not be trusted. Query-time exclusion holds the note set fixed by construction.
const rowsUsed = process.env.MEMORY_NO_ALIAS_CHUNKS === '1' ? rows.filter((r) => r.heading !== '(aliases)') : rows;
assertVectorWidth(rowsUsed, DIM, 'query');

// Tokenise once for all queries — df/idf does not change per question, so doing this inside the
// loop would re-tokenise thousands of chunks per query for no reason.
//
// GRANULARITY IS A REAL CHOICE, not a detail. Per-chunk keeps both arms scoring the same units.
// Per-note concatenates a note's chunks first, which suits a LONG note whose matching terms are
// spread thin — cra2-ecs-runtime-facts carries the query's vocabulary across many sections and no
// single chunk looks convincing. It also inflates df for the identity header repeated in every
// chunk, though BM25 saturates term frequency so the effect is bounded. MEMORY_FUSE_LEX=note|chunk.
const LEX_MODE = process.env.MEMORY_FUSE_LEX ?? DEFAULT_FUSE_LEX;
const lexDocs = LEX_MODE === 'note'
  ? [...rowsUsed.reduce((m, r) => {
      const cur = m.get(r.note) ?? { note: r.note, layer: r.layer, heading: '(note)', text: '', toks: [] };
      cur.text += ' ' + r.text;
      m.set(r.note, cur);
      return m;
    }, new Map()).values()].map((d) => ({ ...d, toks: lexTokens(d.text) }))
  : rowsUsed.map((r) => ({ note: r.note, layer: r.layer, heading: r.heading, text: r.text, toks: lexTokens(r.text) }));

// One query, factored out so the CLI and the socket server cannot drift apart. A server that
// re-implemented ranking would eventually answer differently from the eval harness, and the whole
// point of the harness is that it measures what a session actually gets.
function searchOne(q, qvec, k) {
  // best chunk per note, so one long note cannot fill the whole result list
  const best = new Map();
  for (const r of rowsUsed) {
    const s = cosine(qvec, new Float32Array(r.vec.buffer, r.vec.byteOffset, DIM));
    if (!best.has(r.note) || best.get(r.note).s < s) best.set(r.note, { r, s });
  }
  const sorted = [...best.values()].sort((a, b) => b.s - a.s);

  // Keyword arm over the SAME units, then rank-fuse.
  const FUSE_W = Number(process.env.MEMORY_FUSE_W ?? DEFAULT_FUSE_W);
  let fused = null;
  if (FUSE_W > 0 && FUSE_W < Infinity) {
    const qt = lexTokens(q);
    if (qt.length) {
      const scores = bm25(lexDocs, qt);
      const bestLex = new Map();
      lexDocs.forEach((d, i) => {
        if (!bestLex.has(d.note) || bestLex.get(d.note) < scores[i]) bestLex.set(d.note, scores[i]);
      });
      const lexRanked = [...bestLex.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([n]) => n);
      const order = fuseRRF(sorted.map((x) => x.r.note), lexRanked, FUSE_W, k);
      const byNote = new Map(sorted.map((x) => [x.r.note, x]));
      // A note the keyword arm found but the vector arm ranked below the window still needs a row
      // to display; pull it from the chunk table rather than dropping it.
      fused = order.map((n) => byNote.get(n) ?? { r: lexDocs.find((d) => d.note === n), s: 0 });
    }
  }
  // Layer quota — OFF by default, refuted at k=5 on both case sets (see fuseReserved).
  const reserve = layer ? 0 : Number(process.env.MEMORY_FUSE_RESERVE ?? 0);
  const base = fused ?? sorted.slice(0, k);
  return reserve > 0
    ? fuseReserved(fused ? base.map((x) => x) : sorted, k, reserve, (x) => x.r.layer === 'Memory')
    : base;
}

// ---------------------------------------------------------------- serve
//
// The model and the index cost ~1.5s warm / ~3.1s cold to load, which is why the per-prompt recall
// hook was stuck on its own weak keyword search (MRR 0.158 against this path's 0.547). Holding both
// in a resident process turns that into a socket round-trip. Idle-exits so it cannot become a
// daemon nobody remembers starting; the hook respawns it on demand.
if (flag('--serve')) {
  const net = await import('node:net');
  const sockPath = path.join(paths.stateDir('run'), `search-${SLUG}-${MODEL_KEY}.sock`);
  try { fs.unlinkSync(sockPath); } catch {}
  const IDLE_MS = Number(process.env.MEMORY_SERVE_IDLE_MS ?? 30 * 60 * 1000);
  let idle = setTimeout(() => process.exit(0), IDLE_MS);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), IDLE_MS); };

  await embed(['warm up so the first real request is not the one that pays for the model load']);

  // Display text comes from the note's CARD, not from whichever chunk matched. Alias chunks win the
  // match often (that is their job) but their text is a list of questions — as a one-line brief it
  // reads as noise. Match on any chunk, describe with the card.
  const cardByNote = new Map(rowsUsed.filter((r) => r.heading === '(card)').map((r) => [r.note, r.text]));

  const server = net.createServer((sock) => {
    bump();
    let buf = '';
    sock.on('data', async (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      const line = buf.slice(0, buf.indexOf('\n')); buf = '';
      try {
        const { q, k = 5 } = JSON.parse(line);
        // The index changes under us as notes are written; mtime on the DB is the cheap check.
        const stat = fs.statSync(DB_PATH);
        const stale = stat.mtimeMs > loadedAt;
        const [qv] = await embed([QUERY_PREFIX + q]);
        const top = searchOne(q, qv, k);
        sock.end(JSON.stringify({
          results: top.map(({ r, s }) => ({
            note: r.note, layer: r.layer, heading: r.heading,
            text: cardByNote.get(r.note) ?? r.text, matched: r.heading, score: +s.toFixed(4),
          })),
          stale,   // caller decides; a slightly stale brief beats a 3s stall
        }) + '\n');
      } catch (e) {
        sock.end(JSON.stringify({ error: String(e.message ?? e) }) + '\n');
      }
    });
    sock.on('error', () => {});
  });
  server.listen(sockPath, () => console.log(`serving ${SLUG} / ${MODEL_KEY} on ${sockPath} (${rowsUsed.length} chunks, idle exit ${IDLE_MS / 60000}m)`));
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, () => { try { fs.unlinkSync(sockPath); } catch {} process.exit(0); });
} else {

const qvecs = await embed(queries.map((q) => QUERY_PREFIX + q));
queries.forEach((q, qi) => {
  const top = searchOne(q, qvecs[qi], K);
  // --json: one machine-readable line per query, so the eval harness can score a whole case set in
  // a single process (the model loads once, not once per question).
  if (flag('--json')) {
    console.log(JSON.stringify({ q, results: top.map(({ r, s }) => ({ note: r.note, layer: r.layer, score: +s.toFixed(4) })) }));
    return;
  }
  console.log(`\n## ${q}`);
  for (const { r, s } of top)
    console.log(`  ${s.toFixed(3)} [${r.layer}] ${r.note} — ${r.heading}\n      ${r.text.replace(/\s+/g, ' ').slice(0, 150)}…`);
});

}
