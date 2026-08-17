#!/usr/bin/env node
// Semantic + keyword retrieval over the vault — CLI entry.
//
// Thin-ish on purpose: this half owns argv, the SQLite handle and the embedding pipeline. The model
// profiles, chunking and all the scoring maths live in lib/memory-semantic.mjs with their tests
// beside them, so a ranking change can be exercised without a database.
//
// Usage:
//   node memory-semantic.mjs --index [dir] [--rebuild]
//   node memory-semantic.mjs --query "question" [-k 5] [--layer Memory] [--json]
//   node memory-semantic.mjs --serve | --coverage | --dupes | --clusters | --check-embedding
//   node --test scripts/lib/memory-semantic.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import * as paths from '../hooks/lib/paths.mjs';
import {
  MODELS,
  MODEL_KEY,
  PROFILE,
  MODEL,
  DIM,
  MAX_CHARS,
  MIN_SECTION,
  QUERY_PREFIX,
  DOC_PREFIX,
  RRF_K,
  DEFAULT_FUSE_W,
  DEFAULT_FUSE_LEX,
  stripFrontmatter,
  chunkNote,
  fuseReserved,
  cosine,
  assertVectorWidth,
  clusterNotes,
  centroid,
  samefolderPairs,
  lexTokens,
  bm25,
  fuseRRF,
  socketIsLive,
  evictableSockets,
  buildLexDocs,
  QUIT,
} from './lib/memory-semantic.mjs';

// ---------------------------------------------------------------- setup

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};
const repo =
  argv
    .filter((a) => !a.startsWith('-'))
    .find((a) => fs.existsSync(a) && fs.statSync(a).isDirectory()) || process.cwd();
// --vault/--slug point this at a generated benchmark vault instead of the real one, which is how
// a retrieval change gets scored against a FIXED note set. Explicit flags, not CLAUDE_VAULT: an
// env override once sent a relocating hook at a throwaway path and cost 24 notes.
const VAULT = val('--vault') || paths.vault();
const SLUG = val('--slug') || paths.projectKey(repo);
const DB_DIR = paths.stateDir('db');
const DB_PATH = path.join(DB_DIR, `semantic-${SLUG}-${MODEL_KEY}.db`);

// Keyed by MODEL, not by slug+model: one server answers for every project, because the model is
// what is expensive to hold and it is identical across them. Refuse to become a second one — see
// socketIsLive(). This sits above the DB open on purpose: everything below it (index rows, then the
// model) is what a duplicate must not pay for.
const SERVE_SOCK = path.join(paths.stateDir('run'), `search-${MODEL_KEY}.sock`);
if (flag('--serve')) {
  if (await socketIsLive(SERVE_SOCK)) {
    console.log(`already serving ${MODEL_KEY} on ${SERVE_SOCK}`);
    process.exit(0);
  }
  try {
    fs.unlinkSync(SERVE_SOCK); // stale file from a server that died without its SIGTERM handler
  } catch {}
}

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

// Release the onnxruntime session and let the process keep running. `pipeline.dispose()` calls
// `InferenceSession.release()` on each session, which is what actually returns the native memory —
// dropping the JS reference alone would not, since the allocation lives on the native side.
//
// This is the difference between a 1.4GB idle process and a ~150MB one. The socket, the loaded
// indexes and the tokenised BM25 documents all survive, so a question after an unload costs a model
// load (~1.5s) rather than a cold start, and one the keyword arm answers costs nothing.
async function unloadEmbedder() {
  if (!embedder) return false;
  const e = embedder;
  embedder = null; // clear FIRST: a request arriving mid-dispose must rebuild, not reuse a corpse
  try {
    await e.dispose();
  } catch {
    /* best effort — a failed release must not take the server down */
  }
  return true;
}

async function embed(texts) {
  if (!embedder) {
    const transformers = await import('@huggingface/transformers');
    // Redirect the weights to $CLAUDE_MEMORY_HOME/models BEFORE the first pipeline() call.
    // The default caches ~722 MB inside node_modules/@huggingface/transformers/.cache, which is
    // the plugin's version-pinned dir and is discarded on every /plugin update.
    paths.useModelCache(transformers);
    embedder = await transformers.pipeline('feature-extraction', MODEL, {
      dtype: 'q8',
      // Do not let onnxruntime pool freed arena blocks. Its BFCArena grows to the largest shapes it
      // has ever seen and never returns them, which is how a single long query left a resident
      // server holding 8.8G of dirty MALLOC_LARGE (2026-08-17). The clamp below bounds the input;
      // this bounds the ALLOCATOR, so a future model, a larger MAX_CHARS or an --index run over
      // long notes cannot reintroduce the same failure by a different route.
      // Costs per-inference allocation instead of pooled reuse — measured worth it, see the
      // arena numbers in CHANGELOG.
      session_options: { enableCpuMemArena: false },
    });
  }
  // Pooling is per-model and silent when wrong, exactly like the query/passage prefixes above.
  // The BGE family trains its dense vector on the CLS token; E5 trains on the mean. Feeding a
  // BGE model mean-pooled vectors still returns plausible cosines, so the loss never surfaces
  // as an error — only as rankings that are quietly worse than the model can do.
  // Slice HERE, not in the callers, so the index path and the query path embed identically. They
  // did not: indexing batched 8 while a query batched however many questions were asked at once —
  // so the eval harness (28 questions in one padded batch) computed different vectors than a live
  // session (one question). With batch 1 the padding is gone and both sides agree by construction.
  const B = PROFILE.batch ?? 1; // 1 = no padding. See --check-embedding; every model tested fails at >1.
  // Clamp HERE for the same reason the batch is pinned here: both sides must embed identically.
  // chunkNote() caps documents at MAX_CHARS (1800 for bge-m3) but nothing capped a QUERY, and the
  // recall hook embeds the user's whole prompt verbatim. A pasted stack trace went in at 57k chars
  // — 32x longer than anything in the index, so it was also being compared against a length the
  // index never contains.
  //
  // The memory cost is the sharp end. Attention is O(seq^2) per layer and bge-m3 accepts 8192
  // tokens across 24 layers, so one long prompt allocates multi-GB activations — and onnxruntime's
  // arena allocator keeps whatever high-water mark it reaches for the life of the process, which
  // for --serve is 30 idle minutes. Measured 2026-08-17 on a 16GB machine: two resident servers
  // holding 8.8G of dirty MALLOC_LARGE each, ~7.4G of it compressed; killing them returned it.
  // A server that has only ever seen <=1800-char inputs stays at ~450M.
  const clamped = texts.map((t) => (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t));
  const vecs = [];
  for (let i = 0; i < clamped.length; i += B) {
    const out = await embedder(clamped.slice(i, i + B), {
      pooling: PROFILE.pool ?? 'mean',
      normalize: true,
    });
    for (const v of out.tolist()) vecs.push(Float32Array.from(v));
  }
  return vecs;
}

// Every mode except --index reads vectors it did not build; refuse if they came from another model
// rather than returning scores that look plausible and mean nothing.
//
// --serve is exempt because this gate reads ONE index — the spawning project's, since
// memory-recall.mjs spawns with a cwd and no --slug. That was the right check when a server served
// exactly that project. Now it serves all of them, so a single stale index would exit(1) the shared
// server and silently kill recall for every OTHER project too: the spawn is detached with stdio
// ignored, so nothing surfaces. loadIndex() applies the same check per slug at request time and
// throws instead, which keeps one stale index one failed request.
if (modelChanged && !flag('--index') && !flag('--serve')) {
  console.log(
    `index was built with ${storedModel}, but ${MODEL} is configured — run --index to rebuild.`,
  );
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
  for (const sub of ['domain', 'tools'])
    out.push({ dir: path.join(VAULT, 'permanent', sub), layer: 'permanent' });
  return out;
}

// Is every note actually IN the index? Nobody had ever asked. A note missing from the index is
// indistinguishable from a note that ranks badly — both just fail to appear — so the whole class
// hides behind "retrieval is imperfect". obsidian-second-brain lists 100% index coverage as one of
// its measured gains, which is what prompted checking ours: it was 1047 of 1048.
if (flag('--coverage')) {
  const onDisk = new Map(); // stem -> [paths]
  for (const { dir } of vaultSources()) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')))
      onDisk.set(f.slice(0, -3), [...(onDisk.get(f.slice(0, -3)) ?? []), path.join(dir, f)]);
  }
  const indexed = new Set(
    db
      .prepare('SELECT DISTINCT note n FROM chunks')
      .all()
      .map((r) => r.n),
  );
  const missing = [...onDisk.keys()].filter((n) => !indexed.has(n));
  // A stem that exists twice is worse than a missing note: the index keys by stem, so two files
  // MERGE into one entry, best-chunk scoring mixes their content, and an Obsidian [[wikilink]] to
  // that name is ambiguous too. It reads as full coverage while silently holding one note fewer.
  const collisions = [...onDisk.entries()].filter(([, paths]) => paths.length > 1);
  console.log(`project ${SLUG}`);
  console.log(
    `  on disk ${onDisk.size} distinct names (${[...onDisk.values()].flat().length} files) · indexed ${indexed.size}`,
  );
  if (missing.length)
    console.log(`  MISSING from the index (${missing.length}):\n    ${missing.join('\n    ')}`);
  for (const [stem, paths] of collisions)
    console.log(
      `  NAME COLLISION "${stem}" — the index merges these into one entry:\n    ${paths.join('\n    ')}`,
    );
  if (!missing.length && !collisions.length)
    console.log('  OK — every note is indexed exactly once.');
  process.exit(missing.length || collisions.length ? 1 : 0);
}

// ---------------------------------------------------------------- embedding property check

// Batching pads every text to the longest in its group, and the padding CHANGES the output — the
// same string scored cosine 0.986 against itself on 2026-08-15, while competing notes here sit
// ~0.001 apart. No model card mentions it. Ten seconds, and it re-checks the property for whatever
// model is configured, instead of trusting that this one behaves like the last one.
if (flag('--check-embedding')) {
  const t =
    'a representative note section about alarm thresholds, WAF rules and deployment controllers';
  const [alone] = await embed([t]);
  const [again] = await embed([t]);
  const batched = (await embed([t, 'short', 'x'.repeat(1500)]))[0];
  const self = cosine(alone, again),
    mixed = cosine(alone, batched);
  console.log(`model ${MODEL}  batch=${PROFILE.batch ?? 1}`); // must mirror embed(); a stale default here reports a batch size the code does not use
  console.log(`  same text twice        cosine ${self.toFixed(6)}`);
  console.log(`  alone vs in a batch    cosine ${mixed.toFixed(6)}`);
  const ok = self > 0.99999 && mixed > 0.99999;
  console.log(
    ok
      ? '  OK — embedding is stable; batch company does not change the vector.'
      : `  FAIL — batch company shifts the vector by ${(1 - mixed).toFixed(4)}. Set batch: 1 for this model.`,
  );
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
  try {
    fs.mkdirSync(lockDir);
    locked = true;
  } catch {
    const age = Date.now() - (fs.statSync(lockDir).mtimeMs || 0);
    if (age < 30 * 60 * 1000) {
      console.log('another --index is running (lock held); skipping');
      process.exit(0);
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
    locked = true; // reclaim a lock left by a killed run
  }
  const releaseLock = () => {
    if (locked) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {}
      locked = false;
    }
  };
  process.on('exit', releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, () => {
      releaseLock();
      process.exit(1);
    });

  const sources = vaultSources();

  const files = [];
  for (const { dir, layer } of sources) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      if (f === 'REFLECTIONS.md') continue; // an audit log, not a memory
      const full = path.join(dir, f);
      files.push({
        full,
        layer,
        note: f.slice(0, -3),
        mtime: Math.floor(fs.statSync(full).mtimeMs),
      });
    }
  }

  // --rebuild forces a full re-embed. Needed when the metadata cannot be trusted: a run that
  // recorded the model without re-embedding leaves the DB claiming one model while holding another
  // model's vectors, and no automatic check can see that.
  if (modelChanged || flag('--rebuild')) {
    console.log(
      `model changed ${storedModel ?? '(unrecorded)'} → ${MODEL}; rebuilding the whole index (vectors are not comparable across models)`,
    );
    db.exec('DELETE FROM chunks');
  }
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('model', MODEL);

  // Incremental: re-embed only notes whose mtime moved; drop rows for deleted notes.
  const known = new Map(
    db
      .prepare('SELECT file, MAX(mtime) AS mtime FROM chunks GROUP BY file')
      .all()
      .map((r) => [r.file, r.mtime]),
  );
  const live = new Set(files.map((f) => f.full));
  let dropped = 0;
  for (const f of known.keys())
    if (!live.has(f)) {
      db.prepare('DELETE FROM chunks WHERE file = ?').run(f);
      dropped++;
    }
  const stale = files.filter((f) => known.get(f.full) !== f.mtime);

  console.log(`${files.length} notes · ${stale.length} to (re)embed · ${dropped} removed`);
  if (!stale.length) {
    console.log('index already current');
    process.exit(0);
  }

  const del = db.prepare('DELETE FROM chunks WHERE file = ?');
  const ins = db.prepare(
    'INSERT INTO chunks (note, layer, file, mtime, heading, text, vec) VALUES (?,?,?,?,?,?,?)',
  );
  const pending = [];
  for (const f of stale) {
    del.run(f.full);
    for (const c of chunkNote(f.note, fs.readFileSync(f.full, 'utf8')))
      pending.push({ ...c, note: f.note, layer: f.layer, file: f.full, mtime: f.mtime });
  }

  const BATCH = PROFILE.batch ?? 1; // embed() slices to the same size; keep them equal
  const t0 = Date.now();
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const vecs = await embed(batch.map((b) => DOC_PREFIX + b.text));
    batch.forEach((b, j) =>
      ins.run(b.note, b.layer, b.file, b.mtime, b.heading, b.text, new Uint8Array(vecs[j].buffer)),
    );
    try {
      fs.utimesSync(lockDir, new Date(), new Date());
    } catch {} // heartbeat: a slow model's build outlives the 30-min stale window
    if ((i / BATCH) % 10 === 0)
      console.log(`  ${Math.min(i + BATCH, pending.length)}/${pending.length} chunks`);
  }
  console.log(
    `indexed ${pending.length} chunks from ${stale.length} notes in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${DB_PATH}`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------- consolidation gaps

if (flag('--clusters')) {
  const min = Number(val('--min') || PROFILE.clusterMin);
  const minSize = Number(val('--size') || 4);
  const cards = db
    .prepare("SELECT note, layer, text, vec FROM chunks WHERE heading = '(card)'")
    .all()
    .map((r) => ({
      note: r.note,
      layer: r.layer,
      text: r.text,
      vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, DIM),
    }));
  if (!cards.length) {
    console.log('empty index — run --index first');
    process.exit(1);
  }

  const permanent = cards.filter((c) => c.layer === 'permanent');
  const working = cards.filter((c) => c.layer !== 'permanent');
  const clusters = clusterNotes(working, min).filter((g) => g.length >= minSize);

  console.log(
    `${working.length} notes · ${permanent.length} permanent/ notes · clusters ≥${minSize} at ≥${min}: ${clusters.length}\n`,
  );
  let gaps = 0;
  for (const g of clusters) {
    const c = centroid(g.map((x) => x.vec));
    // Is this topic already consolidated? Compare the cluster's average meaning to permanent/.
    let best = { note: null, s: 0 };
    for (const p of permanent) {
      const s = cosine(c, p.vec);
      if (s > best.s) best = { note: p.note, s };
    }
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
    console.log(
      `${g.length} notes — ${Object.entries(mix)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')}`,
    );
    console.log(
      best.s >= typical - 0.02
        ? `   nearest permanent/: ${best.note} ${best.s.toFixed(3)} vs typical member ${typical.toFixed(3)} — borderline; check whether it should absorb this`
        : `   no permanent/ note covers this (best ${best.note ?? 'n/a'} ${best.s.toFixed(3)} vs typical member ${typical.toFixed(3)})`,
    );
    // /memory:synthesize needs the whole membership, not a preview — it must read every note.
    const showMembers = Number(val('--members') || 6);
    for (const x of g.slice(0, showMembers)) console.log(`   · [${x.layer}] ${x.note}`);
    if (g.length > showMembers)
      console.log(`   · …and ${g.length - showMembers} more (--members 99)`);
    console.log('');
  }
  const shown = Math.min(gaps, Number(val('--top') || 8));
  console.log(
    gaps
      ? `${gaps} topic(s) with no consolidated note${gaps > shown ? ` (showing the ${shown} largest)` : ''}. Writing one is a judgement call — this only finds where it is missing.`
      : 'every cluster is covered by a permanent/ note.',
  );
  process.exit(0);
}

// ---------------------------------------------------------------- dedup

if (flag('--dupes')) {
  const min = Number(val('--min') || PROFILE.dupeMin);
  // One vector per note: the '(card)' chunk carries title + description + the opening body, which
  // for a short Insight note is effectively the whole note. Comparing cards keeps this O(notes²)
  // (~165k pairs, well under a second) instead of O(chunks²).
  const rawCards = db
    .prepare("SELECT note, layer, text, vec FROM chunks WHERE heading = '(card)'")
    .all();
  assertVectorWidth(rawCards, DIM, 'dupes');
  const cards = rawCards.map((r) => ({
    note: r.note,
    layer: r.layer,
    text: r.text,
    vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, DIM),
  }));
  if (!cards.length) {
    console.log('empty index — run --index first');
    process.exit(1);
  }
  const pairs = samefolderPairs(cards, min);
  const byNote = new Map(cards.map((c) => [c.note, c]));
  console.log(`${cards.length} notes · same-folder pairs ≥ ${min}: ${pairs.length}`);
  console.log('(cross-folder pairs are complementary by design and are not reported)\n');
  for (const p of pairs.slice(0, Number(val('--top') || 30))) {
    console.log(`${p.s.toFixed(3)} [${p.layer}]`);
    for (const n of [p.a, p.b])
      console.log(`   ${n}\n      ${byNote.get(n).text.replace(/\s+/g, ' ').slice(0, 130)}…`);
  }
  console.log('\nJudge each pair: merge when it adds coverage, keep when it only removes a file.');
  process.exit(0);
}

// ---------------------------------------------------------------- query

const queries = argv.filter((a, i) => argv[i - 1] === '--query' || argv[i - 1] === '-q');
if (!queries.length && !flag('--serve')) {
  console.log(
    'usage: --index | --query "question" [--query "..."] [-k 5] | --serve | --coverage | --dupes | --clusters',
  );
  process.exit(1);
}
const K = Number(val('-k') || 5);
// --layer Memory gives L1 its own result window. Without it the ~990 Insights notes bury the ~47
// Memory ones: measured 2026-08-14, gold L1 notes sat at rank 20 and 35 unscoped, top-3 scoped.
// Same corpus-competition effect BM25 shows — a bigger k does not fix it, a separate window does.
const layer = val('--layer');
const LEX_MODE = process.env.MEMORY_FUSE_LEX ?? DEFAULT_FUSE_LEX;

/**
 * Everything a query needs for ONE project, as a value rather than module state.
 *
 * It used to be module state, which is exactly why there had to be a server per project: the slug
 * was fixed before the socket existed. As a value, one process serves every project — and since the
 * model is ~1.3GB against ~15MB of vectors for a 3400-chunk index, the thing worth sharing is the
 * model, not the process.
 *
 * Throws rather than exiting: for the CLI a bad index is fatal, but for the server it is one bad
 * request among many, and a server that called process.exit() on a stale slug would take every other
 * project down with it.
 */
function loadIndex(slug) {
  const dbPath = path.join(DB_DIR, `semantic-${slug}-${MODEL_KEY}.db`);
  if (!fs.existsSync(dbPath)) throw new Error(`no index for ${slug} — run --index first`);
  const idb = new DatabaseSync(dbPath);
  // Same guard the CLI applies, per index: vectors from another model are noise that looks like a
  // score, and in a multi-project server one stale index must not be answered from.
  const stored = idb.prepare("SELECT value FROM meta WHERE key = 'model'").get()?.value;
  const rows = layer
    ? idb.prepare('SELECT note, layer, heading, text, vec FROM chunks WHERE layer = ?').all(layer)
    : idb.prepare('SELECT note, layer, heading, text, vec FROM chunks').all();
  if (rows.length && stored !== MODEL)
    throw new Error(`index for ${slug} was built with ${stored}, not ${MODEL} — run --index`);
  if (!rows.length)
    throw new Error(layer ? `no chunks in layer ${layer}` : 'empty index — run --index first');
  // Ablation switch, so the alias-chunk change can be scored against its own absence on ONE index.
  // Otherwise the A/B needs two full rebuilds, and the note set moves between them — which is
  // exactly how the 2026-08-15 alias measurement was first taken (1034 notes before, 1047 after)
  // and why it could not be trusted. Query-time exclusion holds the note set fixed by construction.
  const rowsUsed =
    process.env.MEMORY_NO_ALIAS_CHUNKS === '1'
      ? rows.filter((r) => r.heading !== '(aliases)')
      : rows;
  assertVectorWidth(rowsUsed, DIM, 'query');
  return {
    slug,
    dbPath,
    rowsUsed,
    lexDocs: buildLexDocs(rowsUsed, LEX_MODE),
    // Display text comes from the note's CARD, not from whichever chunk matched. Alias chunks win
    // the match often (that is their job) but their text is a list of questions — as a one-line
    // brief it reads as noise. Match on any chunk, describe with the card.
    cardByNote: new Map(
      rowsUsed.filter((r) => r.heading === '(card)').map((r) => [r.note, r.text]),
    ),
    loadedAt: Date.now(),
  };
}

// One query, factored out so the CLI and the socket server cannot drift apart. A server that
// re-implemented ranking would eventually answer differently from the eval harness, and the whole
// point of the harness is that it measures what a session actually gets.
function searchIn(index, q, qvec, k) {
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
  const sockPath = SERVE_SOCK; // probed and cleaned above; do NOT unlink again — by now another
  // server may legitimately own the path, and stealing it is what made these multiply.
  const IDLE_MS = paths.serveIdleMs();
  const MODEL_IDLE_MS = paths.modelIdleMs();
  const quit = () => {
    try {
      fs.unlinkSync(sockPath);
    } catch {}
    process.exit(0);
  };

  // Two timers, because the process and the model are two very different costs. The model is ~1.3G
  // and goes first; the process is ~150M once it has, and can afford to linger holding its indexes.
  let idle = setTimeout(quit, IDLE_MS);
  let modelIdle = null;
  const armModelIdle = () => {
    clearTimeout(modelIdle);
    modelIdle = setTimeout(async () => {
      if (await unloadEmbedder())
        console.log(`unloaded model after ${MODEL_IDLE_MS / 60000}m idle`);
    }, MODEL_IDLE_MS);
    modelIdle.unref?.(); // must never be the reason the event loop stays alive
  };
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(quit, IDLE_MS);
    armModelIdle();
  };

  // Indexes are per project and loaded on demand — this is what lets ONE process serve every
  // project instead of one process per project. They are cheap next to the model (~15M of vectors
  // for 3400 chunks against ~1.3G of weights), so they are cached and never evicted; the process
  // idle timer is the upper bound on how long they live.
  const indexes = new Map();
  function indexFor(slug) {
    const have = indexes.get(slug);
    // The index changes under us as notes are written, and a stale one is answered from silently.
    // mtime on the DB file is the cheap check — the same one the single-project server used, now
    // per project and used to RELOAD rather than merely to warn.
    if (have) {
      let mtime = 0;
      try {
        mtime = fs.statSync(have.dbPath).mtimeMs;
      } catch {
        /* file vanished; fall through and let loadIndex report it */
      }
      if (mtime <= have.loadedAt) return have;
    }
    const fresh = loadIndex(slug);
    indexes.set(slug, fresh);
    console.log(`loaded index ${slug} (${fresh.rowsUsed.length} chunks)`);
    return fresh;
  }

  // Pay the model load now, not on the first real request. The hook only spawns this server because
  // it just had no answer, so the prompt after next is the one that benefits.
  await embed(['warm up so the first real request is not the one that pays for the model load']);

  const server = net.createServer((sock) => {
    bump();
    let buf = '';
    sock.on('data', async (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      const line = buf.slice(0, buf.indexOf('\n'));
      buf = '';
      try {
        const msg = JSON.parse(line);
        // A newer server has taken over — see evictableSockets(). Acknowledge first so it is not
        // left waiting on a socket that vanishes mid-write.
        if (msg.quit) {
          sock.end(JSON.stringify({ quitting: MODEL_KEY }) + '\n', quit);
          return;
        }
        // The slug is now a REQUEST field, not process state. Falling back to the server's own slug
        // keeps an older hook working against a newer server rather than answering from the wrong
        // project — the one failure that would be invisible, since wrong notes still look like notes.
        const { q, k = 5, slug = SLUG } = msg;
        const index = indexFor(slug);
        const [qv] = await embed([QUERY_PREFIX + q]);
        const top = searchIn(index, q, qv, k);
        sock.end(
          JSON.stringify({
            slug,
            results: top.map(({ r, s }) => ({
              note: r.note,
              layer: r.layer,
              heading: r.heading,
              text: index.cardByNote.get(r.note) ?? r.text,
              matched: r.heading,
              score: +s.toFixed(4),
            })),
            stale: false, // indexFor() reloads on mtime change, so an answer is never stale now
          }) + '\n',
        );
      } catch (e) {
        sock.end(JSON.stringify({ error: String(e.message ?? e) }) + '\n');
      }
    });
    sock.on('error', () => {});
  });
  // The probe above closes the window to ~1ms, not to zero: loading the index takes seconds, and
  // two hooks firing in that gap both get past it. Losing the bind race is not an error — the other
  // server is serving. Without this the loser died on an unhandled 'error' event, and since it is
  // spawned detached with stdio ignored, the stack trace went nowhere.
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`already serving ${MODEL_KEY} (lost bind race)`);
      process.exit(0);
    }
    console.error(`serve failed: ${e.message}`);
    process.exit(1);
  });
  server.listen(sockPath, async () => {
    console.log(
      `serving ${MODEL_KEY} on ${sockPath} (all projects, model idle ${MODEL_IDLE_MS / 60000}m, exit ${IDLE_MS / 60000}m)`,
    );
    armModelIdle(); // nothing has been served yet, so the model must already be on the clock
    // Take over from any leftover server. AFTER listen, so a failed bind never evicts the server
    // that beat us to it. Best-effort throughout: one that ignores us dies on its own idle timer,
    // which is the whole safety net here.
    const runDir = path.dirname(sockPath);
    const own = path.basename(sockPath);
    let evicted = 0;
    for (const name of evictableSockets(fs.readdirSync(runDir), own)) {
      const done = await new Promise((resolve) => {
        const c = net.createConnection(path.join(runDir, name));
        const fin = (v) => {
          try {
            c.destroy();
          } catch {}
          resolve(v);
        };
        const t = setTimeout(() => fin(false), 1000);
        c.on('connect', () => c.write(JSON.stringify(QUIT) + '\n'));
        c.on('data', () => {
          clearTimeout(t);
          fin(true);
        });
        c.on('error', () => {
          clearTimeout(t);
          fin(false); // nobody home; its own startup probe unlinks the leftover
        });
      });
      if (done) evicted++;
    }
    if (evicted) console.log(`evicted ${evicted} server(s) for other projects`);
  });
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, () => {
      try {
        fs.unlinkSync(sockPath);
      } catch {}
      process.exit(0);
    });
} else {
  // The CLI is single-project by nature — its slug comes from cwd or --slug. A bad index here IS
  // fatal, unlike in the server, so the throw becomes the usage message it always was.
  let selfIndex;
  try {
    selfIndex = loadIndex(SLUG);
  } catch (e) {
    console.log(e.message);
    process.exit(1);
  }
  const qvecs = await embed(queries.map((q) => QUERY_PREFIX + q));
  queries.forEach((q, qi) => {
    const top = searchIn(selfIndex, q, qvecs[qi], K);
    // --json: one machine-readable line per query, so the eval harness can score a whole case set in
    // a single process (the model loads once, not once per question).
    if (flag('--json')) {
      console.log(
        JSON.stringify({
          q,
          results: top.map(({ r, s }) => ({ note: r.note, layer: r.layer, score: +s.toFixed(4) })),
        }),
      );
      return;
    }
    console.log(`\n## ${q}`);
    for (const { r, s } of top)
      console.log(
        `  ${s.toFixed(3)} [${r.layer}] ${r.note} — ${r.heading}\n      ${r.text.replace(/\s+/g, ' ').slice(0, 150)}…`,
      );
  });
}
