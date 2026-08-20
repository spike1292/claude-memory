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
// refresh only re-embeds notes whose CONTENT moved — see contentHash().
// See MODELS in models.mjs — dims, chunk size, prefixes, POOLING and thresholds are per-model and none of
// them transfer. Pooling in particular is silent when wrong: bge-m3 scored @5 25.0% mean-pooled and
// 67.9% cls-pooled, and the mean-pooled index returned confident, plausible, wrong rankings.
//
// Setup on a new machine (node_modules is gitignored, so the dep does not travel with the repo):
//   cd ~/.claude && npm install @huggingface/transformers && npm approve-scripts onnxruntime-node
//   (the postinstall fetches the native runtime; without it the pipeline cannot start)
//
// Usage:
//   node ~/.claude/scripts/memory-semantic.mjs --dupes                # same-folder near-duplicates
//   node ~/.claude/scripts/memory-semantic.mjs --clusters               # topics with no permanent/ note
//   node ~/.claude/scripts/memory-semantic.mjs --index [repo-dir]     # build/refresh (idempotent)
//   node ~/.claude/scripts/memory-semantic.mjs --query "how long was the site down" [-k 5]
//   node --test scripts/lib/memory-semantic.test.mjs
//
// ponytail: linear cosine scan over a few thousand 384-d vectors is ~5ms. No ANN index, no server.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { activeModel } from './model-default.mjs';
// The profiles moved out on 2026-08-20 so a caller wanting only the key list is not taken down by
// this module's exit-on-unknown-model. Their comments went with them — the batch-size-is-1 finding
// and the per-model pooling and dupeMin warnings are in models.mjs, not lost.
import { MODELS } from './models.mjs';
// The lexical vocabulary lives in its own import-free module because the recall hook needs it ABOVE
// its fail-open try, and this module's scope exits the process on an unknown model. Consumers
// import it from there directly — the re-export that used to sit here was deleted 2026-08-19: a
// second import path for one implementation is a second thing to keep in step.
import { CARD, STOP, lexTokens, bm25 } from './lexical.mjs';
import * as paths from '../../hooks/lib/paths.mjs';

// Which sibling servers should this one evict?
//
// The server is keyed by MODEL alone and serves every project, so anything else under run/ is a
// leftover: a per-slug socket from the version that ran one server per project, or a server for a
// model that is no longer the active one. Both are pure cost — a warm server is 800MB-1.4GB — so a
// starting server asks each of them to quit.
//
// Sockets are the registry: no pidfile, no lock, nothing to leave stale. This is also the migration
// path off the per-slug scheme, which needs no special case precisely because those names are
// "not mine" under the same rule.
//
// ponytail: last-writer-wins, no coordination. Two servers starting in the same instant can evict
// each other and both die; the next prompt respawns one, so it self-heals at the cost of one
// keyword-only recall. Needs a lock only if that is ever observed.
export function evictableSockets(names, ownName) {
  return names.filter((n) => n !== ownName && n.startsWith('search-') && n.endsWith('.sock'));
}

export const QUIT = { quit: 1 };

/**
 * A lazily-loaded value that is loaded AT MOST ONCE at a time, and can be taken back out.
 *
 * `if (!x) x = await load()` is a check-then-act across an await. It was unreachable while the model
 * loaded once at startup and never went back to null; making it unloadable made it reachable, and
 * then two requests arriving after an unload would both load, with the second assignment silently
 * dropping the first ~1.3GB onnxruntime session — no dispose(), exactly the leak this file exists to
 * prevent. In `lib/` rather than beside its one caller because a regression here is SILENT: it costs
 * memory, not correctness, so nothing fails and no answer changes.
 *
 * - `get()` shares the in-flight promise, so N concurrent callers cause ONE load.
 * - a rejected load clears the in-flight slot, so one failure does not poison every later call.
 * - `take()` removes and returns the value for the caller to release; a `take()` while a load is
 *   still in flight returns null and lets that load land. Bounded: the value then waits for the
 *   next `take()`, and for the server that is the following idle tick.
 */
export function singleFlight(load) {
  let value = null;
  let inFlight = null;
  let borrowed = 0;
  return {
    get() {
      if (value) return Promise.resolve(value);
      if (!inFlight)
        inFlight = load().then(
          (v) => {
            value = v;
            inFlight = null;
            return v;
          },
          (e) => {
            inFlight = null;
            throw e;
          },
        );
      return inFlight;
    },
    /**
     * Hold the value for the duration of `use`, so `take()` cannot pull it out mid-flight.
     *
     * singleFlight originally guarded concurrent LOADS. The mirror hazard is on the release side:
     * an idle timer calling take() → dispose() while another request is still running inference on
     * that same session frees it underneath native code. Rare — it needs an inference outlasting
     * the idle timer — but it is the same class of bug, and the failure is a native crash rather
     * than a wrong answer.
     */
    async borrow(use) {
      const v = await this.get();
      borrowed++;
      try {
        return await use(v);
      } finally {
        borrowed--;
      }
    },
    /**
     * In use right now? `take()` refuses while it is. Callers own the retry — the server re-arms
     * its idle timer on a refusal, because nothing else would: only a new connection re-arms it.
     */
    busy() {
      return borrowed > 0;
    },
    take() {
      if (borrowed > 0) return null;
      const v = value;
      value = null;
      return v;
    },
  };
}

/**
 * Per-key cache that reloads when the source has been written since it was loaded.
 *
 * Split out for the same reason as singleFlight: the staleness comparison is one expression whose
 * failure modes are all silent. `mtimeMs <= entry.loadedAt` must be written in that direction so a
 * NaN — which is what a failed stat gives — falls through to a RELOAD rather than serving a cached
 * index forever. The other order (`mtimeMs > entry.loadedAt`) reads identically and is wrong.
 *
 * Entries are never evicted: an index is ~15MB of vectors against the ~1.3GB model, so the process
 * idle timer is a good enough upper bound on how long they live.
 */
export function mtimeCache(load) {
  const entries = new Map();
  return {
    get(key, mtimeMs) {
      const have = entries.get(key);
      if (have && mtimeMs <= have.loadedAt) return have;
      const fresh = load(key);
      entries.set(key, fresh);
      return fresh;
    },
    size: () => entries.size,
  };
}

/**
 * Documents for the keyword arm, tokenised once.
 *
 * Granularity is a real choice, not a detail. `chunk` keeps both arms scoring the same units.
 * `note` concatenates a note's chunks first, which suits a LONG note whose matching terms are spread
 * thin — one where no single chunk looks convincing but the note carries the query's vocabulary
 * across many sections. It also inflates df for the identity header repeated in every chunk, though
 * BM25 saturates term frequency so the effect is bounded. MEMORY_FUSE_LEX=note|chunk.
 *
 * Tokenising here rather than per query matters: df/idf does not change per question, so doing it
 * inside the loop would re-tokenise thousands of chunks for every question asked.
 */
export function buildLexDocs(rowsUsed, mode) {
  if (mode !== 'note')
    return rowsUsed.map((r) => ({
      note: r.note,
      layer: r.layer,
      heading: r.heading,
      text: r.text,
      toks: lexTokens(r.text),
    }));
  const byNote = new Map();
  for (const r of rowsUsed) {
    const cur = byNote.get(r.note) ?? {
      note: r.note,
      layer: r.layer,
      heading: '(note)',
      text: '',
      toks: [],
    };
    cur.text += ' ' + r.text;
    byNote.set(r.note, cur);
  }
  return [...byNote.values()].map((d) => ({ ...d, toks: lexTokens(d.text) }));
}

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
export { MODELS };
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

// Does this note still hash to what the index embedded? The incremental path used to key on exact
// mtime equality alone, and the vault sits on Synology Drive, which rewrites mtime on sync without
// touching content — prune-logs.mjs says so in its own header. Every touched note was then re-embedded
// at batch size 1, which is a 20-40 min CPU storm for content nobody changed (2026-08-19).
//
// The RAW FILE BYTES are hashed, not the chunk text. The property that has to hold is "the hash
// changes if the embeddings would change", and it holds in the direction that matters: chunkNote()
// is pure and deterministic, so identical bytes give identical chunks give identical vectors. The
// converse is deliberately loose — a frontmatter-only edit changes the hash and costs one needless
// re-embed, which is the safe way to be wrong and is exactly what mtime does today. Hashing bytes
// also means the caller hashes what it already read, with no chunking pass on files it will skip.
// Callers pass the Buffer readFileSync returned and decode it only for a file they will re-embed,
// so this really is over the file's bytes; a string argument is hashed as its UTF-8 encoding, and
// the two agree for anything that round-trips (invalid UTF-8 does not, which is the reason to hand
// it the Buffer).
// (A change to chunkNote() itself is invisible to this, as it was to mtime: --rebuild is the escape
// hatch, same as for a model change.)
//
// sha256 via crypto.hash(): stdlib, one-shot, no dependency. Change detection, not integrity, so
// speed would win over strength — but there is nothing to win. Measured 2026-08-19, 8000 note-sized
// 4 KB strings (32 MB, several times this vault): sha256 36 ms, sha1 24 ms. Twelve milliseconds
// across a whole vault, against ~1.5 s to embed ONE chunk. sha256 is hardware-accelerated
// everywhere this runs and is not the digest a FIPS build disables, so it is the boring choice.
export function contentHash(raw) {
  return crypto.hash('sha256', raw, 'hex');
}

// CARD, the card-chunk heading sentinel, is defined in ./lexical.mjs and re-exported above.

// Every chunk carries the note's identity. Without it a mid-note section embeds as anonymous prose
// and a whole-note question cannot reach it — the vector equivalent of the "### Untitled" chunks
// FTS5 was returning for L1 notes.
export function chunkNote(name, raw) {
  const { meta, body } = stripFrontmatter(raw);
  const head = meta ? `${name}: ${meta}` : name;
  const out = [{ heading: CARD, text: `${head}\n${body.slice(0, 700)}`.slice(0, MAX_CHARS) }];
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
// not a replaced one. The deleted `--layer Memory` filtered the corpus, so L1 notes stopped being buried only
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
// STOP, lexTokens and bm25 are defined in ./lexical.mjs; import them from there.

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

/**
 * A query-ready index bundle from raw chunk rows. No SQLite here — `lib/` must not import
 * node:sqlite (CI enforces it — "node:sqlite is imported only by entry points"), so the entry
 * reads the rows and this owns everything after.
 *
 * Split out for the reason singleFlight and mtimeCache were: the alias ablation and the card map
 * are both silent when wrong. Dropping alias chunks changes retrieval without erroring, and a
 * missing card map degrades every brief to raw chunk text that still looks like a result.
 */
export function buildBundle(slug, dbPath, rows, { dropAliases = false, lexMode, dim } = {}) {
  // Ablation switch, so the alias-chunk change can be scored against its own absence on ONE index.
  // Otherwise the A/B needs two full rebuilds, and the note set moves between them — which is
  // exactly how the 2026-08-15 alias measurement was first taken (1034 notes before, 1047 after)
  // and why it could not be trusted. Query-time exclusion holds the note set fixed by construction.
  const rowsUsed = dropAliases ? rows.filter((r) => r.heading !== '(aliases)') : rows;
  if (dim != null) assertVectorWidth(rowsUsed, dim, 'query');
  return {
    slug,
    dbPath,
    rowsUsed,
    lexDocs: buildLexDocs(rowsUsed, lexMode),
    // Display text comes from the note's CARD, not from whichever chunk matched. Alias chunks win
    // the match often (that is their job) but their text is a list of questions — as a one-line
    // brief it reads as noise. Match on any chunk, describe with the card.
    cardByNote: new Map(rowsUsed.filter((r) => r.heading === CARD).map((r) => [r.note, r.text])),
    loadedAt: Date.now(),
  };
}

// One query, factored out so the CLI and the socket server cannot drift apart. A server that
// re-implemented ranking would eventually answer differently from the eval harness, and the whole
// point of the harness is that it measures what a session actually gets.
//
// It once took a `preFiltered` flag, set when `--layer` had narrowed the corpus so the Memory
// reserve would not be reserving inside a single layer. `--layer` was deleted on 2026-08-19 as
// measured-refuted, and with it the only caller that ever passed true.
//
// Everything else is byte-for-byte what ran in the entry (moved 2026-08-19); the arms and their
// weights are measured numbers and this move is not the place to touch them.
export function searchIn(index, q, qvec, k) {
  const { rowsUsed, lexDocs } = index;
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
      const lexRanked = [...bestLex.entries()]
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([n]) => n);
      const order = fuseRRF(
        sorted.map((x) => x.r.note),
        lexRanked,
        FUSE_W,
        k,
      );
      const byNote = new Map(sorted.map((x) => [x.r.note, x]));
      // A note the keyword arm found but the vector arm ranked below the window still needs a row
      // to display; pull it from the chunk table rather than dropping it.
      fused = order.map((n) => byNote.get(n) ?? { r: lexDocs.find((d) => d.note === n), s: 0 });
    }
  }
  // Layer quota — OFF by default, refuted at k=5 on both case sets (see fuseReserved).
  const reserve = Number(process.env.MEMORY_FUSE_RESERVE ?? 0);
  const base = fused ?? sorted.slice(0, k);
  return reserve > 0
    ? fuseReserved(fused ? base.map((x) => x) : sorted, k, reserve, (x) => x.r.layer === 'Memory')
    : base;
}
