#!/usr/bin/env node
// Semantic (vector) search over the vault — the paraphrase bridge that FTS5 cannot be.
//
// Why: ctx_search is BM25 over FTS5, keyword-only, and misses paraphrases that share no
// distinctive term. Query expansion was tried and rejected — it depends on the agent remembering
// to expand. Full rationale and the rejected-alternative measurement:
// docs/decisions/2026-08-15-model-choice.md.
//
// Local by construction: the model runs on-machine via onnxruntime. The vault holds PRIVATE notes
// (roster, KIDs, PI priorities) — nothing leaves the machine after the one-time model fetch.
//
// Model choice: DEFAULT bge-m3 (cls pooling, batch 1, alias chunks) — see the export below for
// why it's the default, and docs/decisions/2026-08-15-model-choice.md for the full EN/NL
// comparison against bge-small-en and e5-multi. Wrong pooling is silent (CLAUDE.md "Model
// profiles are not interchangeable").
//
// Usage: CLAUDE.md's "Exercising the real pipeline" section (--index/--query/--dupes/--clusters).
//
// ponytail: linear cosine scan over a few thousand 384-d vectors is ~5ms. No ANN index, no server.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { activeModel } from './model-default.mjs';
// The profiles moved out on 2026-08-20 so a caller wanting only the key list is not taken down by
// this module's exit-on-unknown-model. Their comments went with them — the batch-size-is-1 finding
// and the per-model pooling and dupeMin warnings are in models.mjs, not lost.
import { MODELS } from './models.mjs';
// The lexical vocabulary lives in its own import-free module because the recall hook needs it ABOVE
// its fail-open try, and this module's scope exits the process on an unknown model. Consumers
// import it from there directly — the re-export that used to sit here was deleted 2026-08-19: a
// second import path for one implementation is a second thing to keep in step.
import { CARD, lexTokens, bm25 } from './lexical.mjs';

/** @typedef {{ note: string, layer: string, heading: string, text: string }} ResultRow */
/** @typedef {ResultRow & { vec: Uint8Array }} ChunkRow */
/** @typedef {ResultRow & { toks: string[] }} LexDoc */
/** @typedef {{ r: ResultRow, s: number }} Scored */
/**
 * @template {ResultRow} [T=ChunkRow]
 * @typedef {object} Bundle
 * @property {string} slug
 * @property {string} dbPath
 * @property {readonly T[]} rowsUsed
 * @property {LexDoc[]} lexDocs
 * @property {Map<string, string>} cardByNote
 * @property {number} loadedAt
 */

// Which sibling servers should this one evict? Anything else under run/ is a leftover (CLAUDE.md's
// "One --serve for the whole machine, keyed by MODEL"). Sockets are the registry — no pidfile, no
// lock, nothing to leave stale.
// ponytail: last-writer-wins, no coordination. Two servers starting at once can evict each other and
// both die; the next prompt respawns one. Needs a lock only if that is ever observed.
/**
 * @param {readonly string[]} names
 * @param {string} ownName
 * @returns {string[]}
 */
export function evictableSockets(names, ownName) {
  return names.filter((n) => n !== ownName && n.startsWith('search-') && n.endsWith('.sock'));
}

export const QUIT = { quit: 1 };

/**
 * A lazily-loaded value that is loaded AT MOST ONCE at a time, and can be taken back out.
 *
 * `if (!x) x = await load()` is a check-then-act across an await: two requests arriving after an
 * unload would both load, with the second silently dropping the first ~1.3GB onnxruntime session
 * (no dispose() — the leak this exists to prevent). `get()` shares the in-flight promise so N
 * concurrent callers cause ONE load; `take()` returns null while a load is in flight and lets that
 * load land instead of racing it.
 *
 * @template T
 * @param {() => Promise<T>} load
 */
export function singleFlight(load) {
  /** @type {T | null} */
  let value = null;
  /** @type {Promise<T> | null} */
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
     * Hold the value for the duration of `use`, so `take()` cannot pull it out mid-flight — an idle
     * timer calling take() -> dispose() while inference still runs on that session would free it
     * underneath native code (a crash, not a wrong answer).
     *
     * @template R
     * @param {(v: T) => R | Promise<R>} use
     * @returns {Promise<R>}
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
 * `mtimeMs <= entry.loadedAt` must be written in that direction — a NaN (a failed stat) then falls
 * through to a RELOAD rather than serving a cached index forever; the other order reads identically
 * and is wrong. Entries are never evicted: an index is ~15MB against the ~1.3GB model, so the
 * process idle timer already bounds how long they live.
 *
 * @template {{ loadedAt: number }} T
 * @param {(key: string) => T} load
 */
export function mtimeCache(load) {
  /** @type {Map<string, T>} */
  const entries = new Map();
  return {
    /**
     * @param {string} key
     * @param {number} mtimeMs
     * @returns {T}
     */
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
 * Documents for the keyword arm, tokenised once (df/idf doesn't change per question, so
 * re-tokenising inside the query loop would cost every question the whole corpus).
 * `chunk` keeps both arms scoring the same units; `note` concatenates a note's chunks first, which
 * suits a long note whose matching terms are spread thin. MEMORY_FUSE_LEX=note|chunk.
 *
 * @param {readonly ResultRow[]} rowsUsed
 * @param {string} [mode]
 * @returns {LexDoc[]}
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
  /** @type {Map<string, LexDoc>} */
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

// Is something already listening on this unix socket? Full history and the measured server pile-up
// this replaced: docs/decisions/2026-08-17-socket-unlink-race.md.
// Probing must happen BEFORE the index load and warm-up, or a duplicate has already paid for both
// by the time it discovers it is redundant. A connect that neither succeeds nor errors is treated
// as LIVE — not stealing from a server that might be there is the safe direction. Only
// ECONNREFUSED (nobody bound, the file is a leftover) earns an unlink.
/**
 * @param {string} sockPath
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function socketIsLive(sockPath, timeoutMs = 1000) {
  if (!fs.existsSync(sockPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const c = net.createConnection(sockPath);
    let settled = false;
    const done = (/** @type {boolean} */ v) => {
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

// DEFAULT = bge-m3 since 2026-08-15, by measurement on both case sets — the full comparison and
// the harness-bug history behind two earlier rejections: docs/decisions/2026-08-15-model-choice.md.
//
// e5-multi remains available for Dutch-heavy work (MEMORY_SEMANTIC_MODEL=e5-multi, then
// --index --rebuild), though bge-m3 now beats it on Dutch too.
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

/**
 * @param {string} raw
 * @returns {{ meta: string, body: string }}
 */
export function stripFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: '', body: raw };
  const desc = (m[1].match(/^\s*description:\s*(.+)$/m) || [])[1] || '';
  return { meta: desc.trim().replace(/^["']|["']$/g, ''), body: raw.slice(m[0].length) };
}

// Does this note still hash to what the index embedded? mtime is only a fast-path hint now, not
// the decision — docs/architecture.md's closed risk R1 has why (a 20-40 min re-embed storm for
// unchanged Synology-touched content, 2026-08-19).
//
// Hashes the RAW FILE BYTES, not the chunk text: chunkNote() is pure, so identical bytes give
// identical vectors, and a frontmatter-only edit costing one needless re-embed is the safe way to
// be wrong — same as mtime. A change to chunkNote() itself is invisible to this, same as to mtime;
// --rebuild is the escape hatch for both.
//
// sha256 via crypto.hash(): stdlib, hardware-accelerated, not a digest a FIPS build disables.
// Speed sweep vs sha1: docs/decisions/2026-08-19-content-hash.md.
/**
 * @param {import('node:crypto').BinaryLike} raw
 * @returns {string}
 */
export function contentHash(raw) {
  return crypto.hash('sha256', raw, 'hex');
}

// CARD, the card-chunk heading sentinel, is defined in ./lexical.mjs and re-exported above.

// Every chunk carries the note's identity. Without it a mid-note section embeds as anonymous prose
// and a whole-note question cannot reach it — the vector equivalent of the "### Untitled" chunks
// FTS5 was returning for L1 notes.
/**
 * @param {string} name
 * @param {string} raw
 * @returns {{ heading: string, text: string }[]}
 */
export function chunkNote(name, raw) {
  const { meta, body } = stripFrontmatter(raw);
  const head = meta ? `${name}: ${meta}` : name;
  const out = [{ heading: CARD, text: `${head}\n${body.slice(0, 700)}`.slice(0, MAX_CHARS) }];
  // `_Also asked as:` gets its OWN chunk — alone at the end of a note it dilutes into the last
  // section's embedding and becomes unreachable by a near-identical query (2026-08-15 near-miss;
  // full case: docs/decisions/2026-08-15-alias-chunk-regex.md). `$` under the /m flag means END OF
  // LINE, not end of string, so a naive regex here truncates a wrapped alias block to its first
  // line — `(?![\s\S])` is the actual end-of-input assertion /m cannot break.
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

// Corpus competition: a SEPARATE result window, not a replaced one — filtering the corpus instead
// regresses retrieval (commands/eval.md's "scoping by layer is REFUTED" warning). Reserving slots
// lets the ~47 L1 notes surface without evicting the ~990 Insights ones.
// `sorted` is descending by `.s`; returns at most K, still score-ordered.
/**
 * @template {{ s: number }} T
 * @param {readonly T[]} sorted
 * @param {number} K
 * @param {number} reserve
 * @param {(x: T) => boolean} isReserved
 * @returns {T[]}
 */
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

/**
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are L2-normalised at embed time, so the dot product IS cosine
}

// A stored vector whose byte length does not match the active model's dimension is from a DIFFERENT
// model. Reading it as `new Float32Array(buf, offset, DIM)` does not throw — it silently reinterprets
// the bytes and returns a plausible-looking score. That is how a mixed-dimension index (384 + 1024 in
// one table, 2026-08-15) can serve nonsense with no error anywhere.
/**
 * @param {readonly Partial<ChunkRow>[]} rows
 * @param {number} dim
 * @param {string} [label]
 */
export function assertVectorWidth(rows, dim, label = 'index') {
  const want = dim * 4;
  // `?.`, not `.`: a row reaching here without a vector at all is the same corruption this
  // exists to catch, and it must produce the message below rather than a TypeError one line up.
  const bad = rows.filter((r) => r.vec?.byteLength !== want);
  if (!bad.length) return;
  const widths = [...new Set(bad.map((r) => r.vec?.byteLength ?? 'missing'))].join(', ');
  console.log(
    `⚠ ${label}: ${bad.length}/${rows.length} vectors are ${widths} bytes, expected ${want} (${dim}-dim).`,
  );
  console.log(
    '  The index mixes models — results would be silent nonsense. Run --index --rebuild.',
  );
  process.exit(1);
}

// Topic clusters, for finding CONSOLIDATION GAPS — many notes on one idea with no permanent/
// note covering them. Deliberately CROSS-folder, unlike dedup: a topic is normally a Pattern +
// a Mistake + a Decision about the same thing. Union-find over the similarity graph:
// single-linkage, so a chain of related notes forms one topic rather than requiring every pair
// to be similar. Exists because memory-audit-checks.mjs's keyword Jaccard scan missed 6 real
// merges across 987 notes it should have caught (2026-08-14) — full evidence and the
// cache-policy-quota/Cache-Control examples: docs/decisions/2026-08-14-topic-cluster-gaps.md.
/**
 * @template {{ vec: ArrayLike<number> }} T
 * @param {readonly T[]} items
 * @param {number} minScore
 * @returns {T[][]}
 */
export function clusterNotes(items, minScore) {
  const parent = items.map((_, i) => i);
  const find = (/** @type {number} */ i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (/** @type {number} */ a, /** @type {number} */ b) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (cosine(items[i].vec, items[j].vec) >= minScore) union(i, j);
  /** @type {Map<number, T[]>} */
  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    /** @type {T[]} */ (groups.get(r)).push(it);
  });
  return [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
}

// Mean of L2-normalised vectors, re-normalised — the cluster's "average meaning", used to ask
// whether any permanent/ note already covers it.
/**
 * @param {readonly ArrayLike<number>[]} vecs
 * @returns {Float32Array}
 */
export function centroid(vecs) {
  const out = new Float32Array(vecs[0].length);
  for (const v of vecs) for (let i = 0; i < v.length; i++) out[i] += v[i];
  let n = 0;
  for (let i = 0; i < out.length; i++) n += out[i] * out[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

// Cross-layer pairs score 0 by construction: a Pattern and a Mistake on one topic are
// complementary by design. `layer` IS the folder — see vaultSources() in the entry.
// The single shared duplicate predicate (write-time reconcile and --dupes both call this) and
// why searchIn()'s fused score is NOT this quantity: CLAUDE.md "Architecture" § Retrieval,
// docs/decisions/2026-08-23-embedding-reconcile.md.
/**
 * @param {{ layer: string, vec: ArrayLike<number> }} a
 * @param {{ layer: string, vec: ArrayLike<number> }} b
 * @returns {number}
 */
export function dupeScore(a, b) {
  return a.layer === b.layer ? cosine(a.vec, b.vec) : 0;
}

/**
 * @template {{ note: string, layer: string, vec: ArrayLike<number> }} T
 * @param {readonly T[]} items
 * @param {number} minScore
 * @returns {{ s: number, layer: string, a: string, b: string }[]}
 */
export function samefolderPairs(items, minScore) {
  /** @type {{ s: number, layer: string, a: string, b: string }[]} */
  const out = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const s = dupeScore(items[i], items[j]);
      if (s >= minScore) out.push({ s, layer: items[i].layer, a: items[i].note, b: items[j].note });
    }
  return out.sort((x, y) => y.s - x.s);
}

/**
 * The pair key both halves of the dedup eval agree on. Order-independent, because a truth file is
 * hand-written and nobody should have to guess which note the author put first.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function pairKey(a, b) {
  return [a, b].sort().join(' :: ');
}

/**
 * Score one bar against a truth set.
 *
 * Extracted and tested because it produces the ONE number this predicate is judged by, and an
 * off-by-one in a denominator here is invisible: every column would still look plausible. `false`
 * counts every firing that is not a known duplicate, INCLUDING pairs nobody has judged — a bar that
 * fires on 1322 pairs to catch 18 is not a better bar, and a caught column alone cannot see that.
 *
 * @param {readonly { a: string, b: string }[]} fired
 * @param {ReadonlySet<string>} dupes
 * @param {ReadonlySet<string>} keeps
 * @returns {{ fires: number, caught: number, missed: number, falses: number, keepsProposed: number }}
 */
export function sweepDupes(fired, dupes, keeps) {
  const firedKeys = new Set(fired.map((p) => pairKey(p.a, p.b)));
  const caught = [...dupes].filter((k) => firedKeys.has(k)).length;
  return {
    fires: firedKeys.size,
    caught,
    missed: dupes.size - caught,
    falses: firedKeys.size - caught,
    keepsProposed: [...keeps].filter((k) => firedKeys.has(k)).length,
  };
}

/**
 * Nearest same-layer note to a candidate card, or null when nothing reaches the bar.
 *
 * Top-1 by design: the runner-up is not a consolation prize. When the best match is marked
 * `reconcile: manual` the caller writes a new note rather than folding into second place, because
 * the mark says the human settled where this lesson's boundary sits.
 *
 * @template {{ note: string, layer: string, vec: ArrayLike<number> }} T
 * @param {readonly T[]} items
 * @param {{ layer: string, vec: ArrayLike<number> }} candidate
 * @param {number} minScore
 * @returns {{ note: string, s: number } | null}
 */
export function bestDupe(items, candidate, minScore) {
  /** @type {{ note: string, s: number } | null} */
  let best = null;
  for (const it of items) {
    const s = dupeScore(it, candidate);
    if (s >= minScore && (!best || s > best.s)) best = { note: it.note, s };
  }
  return best;
}

// ---------------------------------------------------------------- lexical arm + fusion
//
// Fusion exists because the two channels miss DIFFERENT notes: keyword search recovers
// identifier-shaped misses (CLI notes, ticket keys, dated commit-style titles) that the vector
// arm drops. Case counts and the sweep: docs/decisions/2026-08-15-fusion-tuning.md.
//
// RECIPROCAL RANK FUSION, not a weighted sum of scores. Cosine sits in a narrow ~0.4-0.7 band
// while BM25 is unbounded, so summing them needs a normaliser, and a normaliser is one more
// thing that is silently per-model. RRF consumes RANKS, so it cannot be broken by a model with a
// compressed similarity band, which is exactly how e5-multi failed. One knob: how much a vector
// rank outweighs a keyword rank.
// STOP, lexTokens and bm25 are defined in ./lexical.mjs; import them from there.

// `w` weights the vector rank against the keyword rank. w=0 is keyword-only, a large w is
// vector-only. RRF_K flattens the top of the curve so rank 1 vs 2 is not a landslide.
export const RRF_K = 60;
// w=2 chosen (2026-08-15 sweep, 28 EN + 15 NL cases): the only weight where neither language
// regresses. Re-sweep after any model change — a value swept on another vault/fusion formula
// does not transfer (obsidian-second-brain's w=20 is worse here on every EN column). Table:
// docs/decisions/2026-08-15-fusion-tuning.md.
// 0 disables fusion (vector only). Override per run with MEMORY_FUSE_W.
export const DEFAULT_FUSE_W = 2;
// 'chunk' scoring (concatenate per-chunk, not per whole note) chosen by measurement — beats
// whole-note scoring at every weight and worst for Dutch (2026-08-15 sweep). MEMORY_FUSE_LEX=note
// kept as a reproducible negative result. Sweep: docs/decisions/2026-08-15-fusion-tuning.md.
export const DEFAULT_FUSE_LEX = 'chunk';
/**
 * @param {readonly string[]} semRanked
 * @param {readonly string[]} lexRanked
 * @param {number} w
 * @param {number} k
 * @returns {string[]}
 */
export function fuseRRF(semRanked, lexRanked, w, k) {
  /** @type {Map<string, number>} */
  const score = new Map();
  const add = (/** @type {readonly string[]} */ list, /** @type {number} */ weight) =>
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
 * node:sqlite (CI enforces it), so the entry reads the rows and this owns everything after.
 *
 * @template {ResultRow} T
 * @param {string} slug
 * @param {string} dbPath
 * @param {readonly T[]} rows
 * @param {{ dropAliases?: boolean, lexMode?: string, dim?: number }} [opts]
 * @returns {Bundle<T>}
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

// One query, factored out so the CLI and the socket server cannot drift apart — a server that
// re-implemented ranking would eventually answer differently from the eval harness, and the
// whole point of the harness is that it measures what a session actually gets.
//
// The `preFiltered`/`--layer` history and why this is byte-for-byte what ran in the entry:
// docs/architecture.md, "G1 — the entry/lib/ rule is inverted where it matters".
/**
 * @param {Bundle<ChunkRow>} index
 * @param {string} q
 * @param {Float32Array} qvec
 * @param {number} k
 * @returns {Scored[]}
 */
export function searchIn(index, q, qvec, k) {
  const { rowsUsed, lexDocs } = index;
  // best chunk per note, so one long note cannot fill the whole result list
  /** @type {Map<string, Scored>} */
  const best = new Map();
  for (const r of rowsUsed) {
    const s = cosine(qvec, new Float32Array(r.vec.buffer, r.vec.byteOffset, DIM));
    if (!best.has(r.note) || /** @type {Scored} */ (best.get(r.note)).s < s)
      best.set(r.note, { r, s });
  }
  const sorted = [...best.values()].sort((a, b) => b.s - a.s);

  // Keyword arm over the SAME units, then rank-fuse.
  const FUSE_W = Number(process.env.MEMORY_FUSE_W ?? DEFAULT_FUSE_W);
  /** @type {Scored[] | null} */
  let fused = null;
  if (FUSE_W > 0 && FUSE_W < Infinity) {
    const qt = lexTokens(q);
    if (qt.length) {
      const scores = bm25(lexDocs, qt);
      /** @type {Map<string, number>} */
      const bestLex = new Map();
      lexDocs.forEach((d, i) => {
        if (!bestLex.has(d.note) || /** @type {number} */ (bestLex.get(d.note)) < scores[i])
          bestLex.set(d.note, scores[i]);
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
      fused = order.map(
        (n) =>
          byNote.get(n) ?? { r: /** @type {LexDoc} */ (lexDocs.find((d) => d.note === n)), s: 0 },
      );
    }
  }
  // Layer quota — OFF by default, refuted at k=5 on both case sets (see fuseReserved).
  const reserve = Number(process.env.MEMORY_FUSE_RESERVE ?? 0);
  const base = fused ?? sorted.slice(0, k);
  return reserve > 0
    ? fuseReserved(fused ? base.map((x) => x) : sorted, k, reserve, (x) => x.r.layer === 'Memory')
    : base;
}
