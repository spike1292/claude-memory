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
//   node --test scripts/lib/memory-semantic.test.mjs
//
// ponytail: linear cosine scan over a few thousand 384-d vectors is ~5ms. No ANN index, no server.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { activeModel } from './model-default.mjs';
import * as paths from '../../hooks/lib/paths.mjs';

// Is something already listening on this unix socket?
//
// One resident server per slug+model, or bge-m3 multiplies. Measured 2026-08-17 on a 16GB machine:
// SIX --serve processes at once, each holding a full model — 797MB-1.5GB phys_footprint apiece,
// mostly swapped out, so they cost the machine without showing up in RSS.
//
// They pile up because --serve used to unlink the socket unconditionally and rebind. The previous
// server kept running with a listening fd on an unlinked inode: reachable by nobody, exiting only
// when its 30m idle timer fired. And a redundant spawn is the NORMAL case, not an edge one —
// memory-recall.mjs spawns whenever it has no answer, which includes its 700ms timeout expiring
// during the ~1.5s warm-up. Every prompt in that window forked another model.
//
// Probing costs ~1ms and has to happen BEFORE the index load and the warm-up, or a duplicate has
// already paid for both by the time it discovers it is redundant.
//
// A connect that neither succeeds nor errors is treated as LIVE: not stealing from a server that
// might be there is the safe direction, and a genuinely wedged one still dies on its idle timer.
// Only ECONNREFUSED — nobody bound, the file is a leftover — earns an unlink.
// Which sibling servers should this one evict?
//
// One warm server is 800MB-1.4GB, and a server exists per PROJECT — three indexed repos meant up to
// three of them resident at once for 30 minutes each. You are prompting in one repo at a time, so
// the other two are pure cost. A starting server takes over: it lists the sibling sockets in run/
// and asks each to quit.
//
// Sockets are the registry — no pidfile, no lock, nothing to leave stale. The name carries both
// halves of the identity, and only the slug may differ: a server for the SAME project on a
// different model is not a sibling to evict, it is a model change, which every mode except --index
// already refuses.
//
// ponytail: last-writer-wins, no coordination. Two servers for different projects starting in the
// same instant can evict each other and both die; the next prompt respawns one, so it self-heals at
// the cost of one keyword-only recall. Needs a lock only if that is ever observed, which takes two
// sessions prompting simultaneously in different repos.
export function evictableSockets(names, ownName) {
  return names.filter((n) => n !== ownName && n.startsWith('search-') && n.endsWith('.sock'));
}

export const QUIT = { quit: 1 };

export function socketIsLive(sockPath, timeoutMs = 1000) {
  if (!fs.existsSync(sockPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const c = net.createConnection(sockPath);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        c.destroy();
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done(true), timeoutMs);
    c.on('connect', () => done(true));
    c.on('error', () => done(false));
  });
}

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
export const MODELS = {
  // `dupeMin` is model-specific and NOT transferable: E5 packs everything into a high, narrow band,
  // so bge-small-en's 0.86 reports 29,560 pairs under e5-multi — noise that looks like a backlog.
  // Mean, NOT cls — measured, against the model card. BGE-v1.5 is documented as CLS-pooled, but on
  // the 28-case EN set cls scores @1 21.4% / MRR 0.337 against mean's 32.1% / 0.415. Whatever the
  // Xenova q8 export does, it is not what the card describes. Do not "fix" this to cls.
  'bge-small-en': {
    id: 'Xenova/bge-small-en-v1.5',
    dim: 384,
    maxChars: 1800,
    pool: 'mean',
    q: 'Represent this sentence for searching relevant passages: ',
    d: '',
    dupeMin: 0.86,
    clusterMin: 0.8,
  },
  // Multilingual, same 384 dims. Better Dutch at k>=3 (NL @5 66.7% vs bge's 40.0%) but a large
  // English regression (@1 10.7% vs 32.1%): its similarity band is compressed, so ranking barely
  // discriminates. Available for Dutch-heavy work; not the default.
  'e5-multi': {
    id: 'Xenova/multilingual-e5-small',
    dim: 384,
    maxChars: 1600,
    pool: 'mean',
    q: 'query: ',
    d: 'passage: ',
    dupeMin: 0.95,
    clusterMin: 0.92,
  },
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
  'bge-m3': {
    id: 'Xenova/bge-m3',
    dim: 1024,
    maxChars: 1800,
    d: '',
    q: '',
    pool: 'cls',
    dupeMin: 0.75,
    clusterMin: 0.72,
  },
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
export const PROFILE = MODELS[MODEL_KEY];
if (!PROFILE) {
  console.log(`unknown MEMORY_SEMANTIC_MODEL — known: ${Object.keys(MODELS).join(', ')}`);
  process.exit(1);
}
export const MODEL = PROFILE.id;
export const DIM = PROFILE.dim;
export const MAX_CHARS = PROFILE.maxChars;
export const MIN_SECTION = 40; // a section body shorter than this carries no retrievable content
export const QUERY_PREFIX = PROFILE.q;
export const DOC_PREFIX = PROFILE.d;

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
  if (alias)
    out.push({
      heading: '(aliases)',
      text: `${name} — questions this note answers:\n${alias[1].replace(/_\s*$/, '').trim()}`.slice(
        0,
        MAX_CHARS,
      ),
    });
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
    if (drop > 0 && !isReserved(top[i])) {
      drop--;
      continue;
    }
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
  console.log(
    `⚠ ${label}: ${bad.length}/${rows.length} vectors are ${widths} bytes, expected ${want} (${dim}-dim).`,
  );
  console.log(
    '  The index mixes models — results would be silent nonsense. Run --index --rebuild.',
  );
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
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
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
export const STOP = new Set(
  'the a an and or of to in on for is are was were it its this that with as by at from be not you your we our they them if then when what which how why do does did can could should would use used using via no yes into over under more most less least than each per also only just same other about have has had will'.split(
    ' ',
  ),
);
export const lexTokens = (s) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

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
      s +=
        (Math.log(1 + (N - n + 0.5) / (n + 0.5)) * (f * (k1 + 1))) /
        (f + k1 * (1 - b + (b * d.toks.length) / avgdl));
    }
    return s;
  });
}

// `w` weights the vector rank against the keyword rank. w=0 is keyword-only, a large w is
// vector-only. RRF_K flattens the top of the curve so rank 1 vs 2 is not a landslide.
export const RRF_K = 60;
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
export const DEFAULT_FUSE_W = 2;
// 'chunk' by MEASUREMENT — 'note' (concatenate a note's chunks, then score) was tried on the
// hypothesis that a long note whose query terms are spread thin would fare better whole. It is
// worse everywhere, at every weight, and it mauls Dutch (w=2: EN@1 39.3->32.1, EN MRR
// 0.547->0.506, NL@1 46.7->26.7, NL MRR 0.628->0.515). Whole-note BM25 rewards length — more
// terms, more chances to match — so long generic notes displace short precise ones, and a Dutch
// query matching few terms is exactly where length normalisation matters most. It also did NOT
// rescue cra2-ecs-runtime-facts, the note the hypothesis was built around. Kept as an option so
// the negative result stays reproducible: MEMORY_FUSE_LEX=note.
export const DEFAULT_FUSE_LEX = 'chunk';
export function fuseRRF(semRanked, lexRanked, w, k) {
  const score = new Map();
  const add = (list, weight) =>
    list.forEach((note, i) => score.set(note, (score.get(note) || 0) + weight / (RRF_K + i + 1)));
  add(semRanked, w);
  add(lexRanked, 1);
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([note]) => note);
}
