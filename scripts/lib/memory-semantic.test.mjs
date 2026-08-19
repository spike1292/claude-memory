// Tests for scripts/lib/memory-semantic.mjs.
// Run: node --test scripts/lib/memory-semantic.test.mjs
//
// The scoring maths and chunking only. The DB, the embedding pipeline and the CLI live in
// scripts/memory-semantic.mjs and are exercised by running it.
//
// NO retrieval number ships from here: recall/MRR come from memory-eval.mjs against a fixed case
// set. These assertions pin SHAPE (chunk boundaries, fusion order, vector width), which is what
// silently broke twice — mean-vs-cls pooling and a padded batch both produced confident, wrong
// rankings without erroring.
import test from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../../hooks/lib/paths.mjs';
import {
  MAX_CHARS,
  MODELS,
  bm25,
  centroid,
  chunkNote,
  clusterNotes,
  contentHash,
  cosine,
  fuseRRF,
  buildBundle,
  buildLexDocs,
  evictableSockets,
  mtimeCache,
  singleFlight,
  fuseReserved,
  lexTokens,
  samefolderPairs,
  socketIsLive,
  stripFrontmatter,
} from './memory-semantic.mjs';

test('scoring, chunking and fusion', () => {
  const fm = stripFrontmatter('---\nname: x\ndescription: "A thing"\n---\nbody here\n');
  assert.equal(fm.meta, 'A thing');
  assert.equal(fm.body.trim(), 'body here');
  assert.equal(stripFrontmatter('no frontmatter').meta, '');
  const doc =
    '---\ndescription: D\n---\nintro\n\n## First\nalpha text long enough to be worth embedding here\n\n## Second\nbeta text long enough to be worth embedding here\n';
  const ch = chunkNote('my-note', doc);
  assert.equal(ch[0].heading, '(card)');
  assert.ok(ch[0].text.startsWith('my-note: D'));
  assert.deepEqual(
    ch.slice(1).map((c) => c.heading),
    ['First', 'Second'],
  );
  assert.ok(ch[1].text.includes('my-note: D — First'), 'section chunks must carry note identity');
  assert.equal(
    chunkNote('n', '---\ndescription: D\n---\n## H\ntiny\n').length,
    1,
    'sub-threshold sections dropped',
  );
  // a section longer than the window splits, and every piece keeps the identity header
  const long = chunkNote(
    'n',
    `---\ndescription: D\n---\n## H\n${'x'.repeat(MAX_CHARS * 2 + 100)}\n`,
  );
  assert.equal(long.length, 4, 'card + 3 slices');
  assert.ok(long.every((c) => c.text.startsWith('n')));
  const v = new Float32Array([0.6, 0.8]);
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(v, new Float32Array([-0.8, 0.6]))) < 1e-6);
  // dedup: same-folder only, sorted, threshold respected
  const near = new Float32Array([0.6, 0.8]),
    far = new Float32Array([-0.8, 0.6]);
  const mid = new Float32Array([0.66, 0.75]); // ~0.996 with `near`
  const pairs = samefolderPairs(
    [
      { note: 'a', layer: 'Patterns', vec: near },
      { note: 'b', layer: 'Patterns', vec: mid },
      { note: 'c', layer: 'Patterns', vec: far },
      { note: 'd', layer: 'Decisions', vec: near }, // cross-folder twin of `a` — must NOT pair
    ],
    0.9,
  );
  assert.equal(pairs.length, 1, 'only the same-folder near pair');
  assert.deepEqual([pairs[0].a, pairs[0].b], ['a', 'b']);
  assert.equal(pairs[0].layer, 'Patterns');
  assert.equal(
    samefolderPairs(
      [
        { note: 'a', layer: 'P', vec: near },
        { note: 'b', layer: 'P', vec: far },
      ],
      0.9,
    ).length,
    0,
  );
  // clustering: cross-folder by design, single-linkage, singletons dropped
  const c1 = new Float32Array([1, 0]),
    c2 = new Float32Array([0.99, 0.141]),
    c3 = new Float32Array([0.97, 0.24]);
  const groups = clusterNotes(
    [
      { note: 'a', layer: 'Patterns', vec: c1 },
      { note: 'b', layer: 'Mistakes', vec: c2 }, // different folder — must still cluster
      { note: 'c', layer: 'Decisions', vec: c3 }, // only close to b: single-linkage chains it in
      { note: 'lonely', layer: 'Patterns', vec: new Float32Array([0, 1]) },
    ],
    0.95,
  );
  assert.equal(groups.length, 1, 'one topic; the singleton is dropped');
  assert.equal(groups[0].length, 3);
  assert.deepEqual(
    new Set(groups[0].map((g) => g.layer)),
    new Set(['Patterns', 'Mistakes', 'Decisions']),
  );
  // centroid of identical vectors is that vector; of a spread, it is normalised
  assert.ok(Math.abs(cosine(centroid([c1, c1]), c1) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(centroid([c1, c2, c3]), c1) - 1) < 0.05);
  // fuseReserved: promotion must respect K, never evict a reserved item, and stay score-ordered
  const mk = (n, s, layer) => ({ r: { note: n, layer }, s });
  const isMem = (x) => x.r.layer === 'Memory';
  const feed = [
    mk('i1', 0.9, 'Patterns'),
    mk('i2', 0.8, 'Patterns'),
    mk('i3', 0.7, 'Patterns'),
    mk('m1', 0.6, 'Memory'),
    mk('m2', 0.5, 'Memory'),
  ];
  let f = fuseReserved(feed, 3, 1, isMem);
  assert.deepEqual(
    f.map((x) => x.r.note),
    ['i1', 'i2', 'm1'],
    'weakest non-reserved is evicted, not the strongest',
  );
  assert.equal(f.length, 3, 'fusion must never exceed K');
  assert.ok(
    f.every((x, i) => i === 0 || f[i - 1].s >= x.s),
    'result stays score-ordered',
  );
  // already satisfied -> untouched; nothing to promote -> untouched
  assert.deepEqual(
    fuseReserved([mk('m1', 0.9, 'Memory'), mk('i1', 0.8, 'Patterns')], 2, 1, isMem).map(
      (x) => x.r.note,
    ),
    ['m1', 'i1'],
  );
  assert.deepEqual(
    fuseReserved([mk('i1', 0.9, 'Patterns'), mk('i2', 0.8, 'Patterns')], 2, 1, isMem).map(
      (x) => x.r.note,
    ),
    ['i1', 'i2'],
  );
  // an all-reserved window must not cannibalise itself to make room
  assert.equal(
    fuseReserved(
      [mk('m1', 0.9, 'Memory'), mk('m2', 0.8, 'Memory'), mk('m3', 0.7, 'Memory')],
      2,
      3,
      isMem,
    ).length,
    2,
  );
  // the alias line must become its own chunk, stripped of markdown, carrying the note identity
  const aliased = chunkNote(
    'cra2-facts',
    '---\nname: x\ndescription: d\n---\n## Body\nSome long prose about ECS task counts and subnet exhaustion that has nothing to do with the question.\n\n_Also asked as: can I trust the dashboards for alarm thresholds, do we have NAT gateways._\n',
  );
  const ali = aliased.find((c) => c.heading === '(aliases)');
  assert.ok(ali, 'alias line must produce a chunk of its own');
  assert.ok(ali.text.includes('cra2-facts'), 'alias chunk must carry the note identity');
  assert.ok(
    ali.text.includes('alarm thresholds') && !ali.text.includes('subnet exhaustion'),
    'alias chunk must hold ONLY the questions — mixing in body prose is the dilution being fixed',
  );
  assert.ok(!/_$/.test(ali.text.trim()), 'trailing markdown underscore stripped');
  assert.ok(!ali.text.includes('d\n'), 'alias chunk leads with the NAME, not the long description');
  // A WRAPPED alias block must survive whole. The first version used /m with $, which anchors to
  // end-of-LINE, so it kept only line 1 — and the single-line fixture above could never catch it.
  const wrapped = chunkNote(
    'n',
    '---\nname: x\n---\n## B\nbody prose here to fill the section out.\n\n_Also asked as: first question here,\nsecond question here,\nthird question about alarm thresholds._\n',
  );
  const wali = wrapped.find((c) => c.heading === '(aliases)');
  assert.ok(
    wali.text.includes('first question') &&
      wali.text.includes('third question about alarm thresholds'),
    'every line of a wrapped alias block must be kept',
  );
  assert.equal(
    chunkNote('n', '---\nname: x\n---\n## B\nprose with no alias line at all here.\n').filter(
      (c) => c.heading === '(aliases)',
    ).length,
    0,
  );
  // ---- lexical arm + fusion
  assert.deepEqual(
    lexTokens('The WAF rule, and a 403!'),
    ['waf', 'rule', '403'],
    'stopwords and punctuation dropped',
  );
  const docs = [
    { toks: lexTokens('the alarm threshold was calibrated on a quiet period') },
    { toks: lexTokens('unrelated note about cookies and sessions') },
    { toks: lexTokens('alarm alarm alarm') },
  ];
  const sc = bm25(docs, lexTokens('alarm threshold'));
  assert.ok(sc[0] > sc[1], 'a matching doc must outscore a non-matching one');
  assert.equal(sc[1], 0, 'no shared term means no score');
  assert.ok(
    sc[0] > sc[2],
    'matching BOTH terms must beat repeating one — saturation, not raw count',
  );

  // fusion consumes RANKS, so a channel with a compressed score band cannot dominate by scale
  const semR = ['a', 'b', 'c'],
    lexR = ['c', 'z', 'a'];
  assert.deepEqual(
    fuseRRF(semR, lexR, 1, 3),
    ['a', 'c', 'b'],
    "agreement wins, then each channel's best",
  );
  assert.deepEqual(
    fuseRRF(semR, lexR, 1000, 2),
    ['a', 'b'],
    'a large weight collapses to vector order',
  );
  assert.deepEqual(fuseRRF(semR, lexR, 0, 2), ['c', 'z'], 'zero weight collapses to keyword order');
  assert.equal(fuseRRF(semR, lexR, 1, 10).length, 4, 'union of both lists, deduplicated');
  // a note only ONE channel found must still be reachable — that is the entire point
  assert.ok(fuseRRF(semR, lexR, 1, 4).includes('z'), 'keyword-only find must survive fusion');

  // ---- profile invariants. The bge-m3 "too slow" verdict came from ITS profile carrying maxChars
  // 4000 while everyone else had 1800: the A/B varied model AND chunk size, and nothing complained.
  // Chunk size must stay comparable across models or a model comparison measures the chunking.
  const sizes = Object.values(MODELS).map((m) => m.maxChars);
  const spread = Math.max(...sizes) / Math.min(...sizes);
  assert.ok(
    spread <= 1.25,
    `maxChars spread ${spread.toFixed(2)}x across models — a model A/B would be confounded by chunk size`,
  );
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
});

test('real notes chunk cleanly — and the check names the project it got', (t) => {
  // Resolve the vault HERE: this block runs long before the module-level VAULT/SLUG consts, so
  // referencing them threw a dead-zone ReferenceError that the catch below reported as "no vault".
  // The check meant to find silent failures was itself failing silently. Skips must name a reason.
  let checked = 0,
    skipReason = '',
    project = '(unresolved)';
  try {
    const vroot = paths.vault();
    const vslug = paths.projectKey(process.cwd());
    project = vslug;
    const dirs = [
      path.join(vroot, 'Memory', vslug),
      path.join(vroot, 'permanent', 'tools'),
      path.join(vroot, 'Insights', vslug, 'Mistakes'),
    ];
    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs
        .readdirSync(d)
        .filter((x) => x.endsWith('.md'))
        .slice(0, 80)) {
        const raw = fs.readFileSync(path.join(d, f), 'utf8');
        const block = raw.match(/^_Also asked as:([\s\S]*?)(?:\n\s*\n|(?![\s\S]))/m);
        if (!block || block[1].length > MAX_CHARS - 200) continue; // over-long blocks may legally clip
        const chunks = chunkNote(f.slice(0, -3), raw);
        const ali = chunks.find((c) => c.heading === '(aliases)');
        assert.ok(ali, `${f}: has an alias block but produced no alias chunk`);
        const lastWord = block[1]
          .replace(/[_.\s]+$/, '')
          .split(/\s+/)
          .pop();
        assert.ok(
          ali.text.includes(lastWord),
          `${f}: alias chunk lost its tail ("${lastWord}") — a wrapped block was truncated`,
        );
        checked++;
      }
    }
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e; // a real finding must never look like a skip
    skipReason = `${e.constructor.name}: ${e.message.split('\n')[0]}`;
  }
  // A check that quietly verifies nothing is worse than no check: it reads as a passing test.
  assert.ok(
    checked > 0 || skipReason,
    'real-note check matched no notes and gave no reason — it is not running',
  );
  // Print BOTH: an early abort after N successes used to render as a clean "+N checked", hiding
  // the error that stopped it. A count is not evidence of completion.
  assert.ok(!skipReason, `real-note check aborted after ${checked} notes — ${skipReason}`);
  // Name the project AND the count. Running this from ~/.claude silently audits the CONFIG repo
  // instead of the work vault — hit SEVEN times on 2026-08-15, and there it quietly shrank a
  // 345-note check to 6 while still printing a pass. Coverage that depends on cwd must say which
  // cwd it got and how much it actually covered, or a shrunken run reads as a clean one.
  t.diagnostic(`chunk-checked ${checked} real notes in ${project}`);
});

// socketIsLive — the guard that keeps one bge-m3 per slug+model instead of six.
//
// Costs nothing to test and everything to get wrong in the safe direction: a false "dead" makes a
// duplicate steal the socket and orphan a live server holding ~800MB.
test('contentHash: stable, byte-sensitive, and blind to everything else', () => {
  const note =
    '---\ndescription: D\n---\n## H\nalpha text long enough to be worth embedding here\n';
  // Deterministic across calls and across processes — the whole incremental path rests on it.
  assert.equal(contentHash(note), contentHash(note));
  assert.match(contentHash(note), /^[0-9a-f]{64}$/);
  // One byte moves it. The pair below is what mtime cannot tell apart and what this replaces.
  assert.notEqual(contentHash(note), contentHash(note.replace('alpha', 'alpho')));
  // A Buffer and its decoded string agree — the indexer hands it the Buffer it just read.
  assert.equal(contentHash(Buffer.from(note, 'utf8')), contentHash(note));
  // Whitespace is content: it reaches the chunk text, so it must reach the hash.
  assert.notEqual(contentHash(note), contentHash(note + '\n'));
  // Reading the same bytes twice hashes the same regardless of when — a synced file whose mtime
  // was rewritten hashes to what the index already holds, which is the entire point.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contenthash-'));
  const f = path.join(dir, 'n.md');
  fs.writeFileSync(f, note);
  const before = contentHash(fs.readFileSync(f, 'utf8'));
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(f, future, future);
  assert.equal(contentHash(fs.readFileSync(f, 'utf8')), before, 'mtime must not reach the hash');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('socketIsLive: live socket, stale file, and absent path', async () => {
  const net = await import('node:net');
  // Short base dir on purpose — macOS sun_path caps a unix socket path at 104 bytes, and the
  // scratchpad paths this repo is usually tested from blow straight past it with EINVAL.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sock-'));
  const sock = path.join(dir, 's');

  assert.equal(await socketIsLive(path.join(dir, 'nope')), false, 'absent path is not live');

  const server = net.createServer(() => {});
  await new Promise((r) => server.listen(sock, r));
  assert.equal(await socketIsLive(sock), true, 'a listening socket must read as live');

  // Close the server but leave the file: exactly what a SIGKILLed serve leaves behind, and the
  // only case that may be unlinked.
  await new Promise((r) => server.close(r));
  fs.writeFileSync(sock, ''); // close() removes it; recreate the leftover
  assert.equal(await socketIsLive(sock), false, 'a socket file nobody is bound to is not live');

  fs.rmSync(dir, { recursive: true, force: true });
});

// evictableSockets — the one-resident-server rule. Pure filtering, so it is cheap to pin down; the
// connect-and-quit half is exercised end-to-end by running two servers.
test('evictableSockets: siblings only, never self, never strays', () => {
  // Under the model-keyed scheme the server's own name is search-<model>.sock; everything else
  // under run/ is a leftover — an old per-slug socket, or a server for a model no longer active.
  const own = 'search-bge-m3.sock';
  const names = [
    own,
    'search-bge-small-en.sock', // a server for a model that is no longer the active one
    'search-repo-a-bge-m3.sock', // per-slug names left by the version before the rename,
    'search-repo-b-bge-m3.sock', // which is why the migration needs no special case
    'search-repo-c-bge-small-en.sock',
    'notes.db', // the run dir is not sockets-only
    'search-repo-d.sock.tmp',
  ];
  const out = evictableSockets(names, own);
  assert.ok(
    !out.includes(own),
    'a server must never evict itself — that is a self-inflicted outage',
  );
  assert.deepEqual(out.sort(), [
    'search-bge-small-en.sock',
    'search-repo-a-bge-m3.sock',
    'search-repo-b-bge-m3.sock',
    'search-repo-c-bge-small-en.sock',
  ]);
  assert.equal(evictableSockets([own], own).length, 0, 'a lone server evicts nobody');
});

// serveIdleMs — the knob that decides how long 800MB-1.4GB sits doing nothing.
test('serveIdleMs: env wins, then config, then a sane default', (t) => {
  const prev = process.env.MEMORY_SERVE_IDLE_MS;
  t.after(() => {
    if (prev === undefined) delete process.env.MEMORY_SERVE_IDLE_MS;
    else process.env.MEMORY_SERVE_IDLE_MS = prev;
  });

  delete process.env.MEMORY_SERVE_IDLE_MS;
  assert.equal(paths.serveIdleMs(), 30 * 60 * 1000, 'default is 30 minutes');

  process.env.MEMORY_SERVE_IDLE_MS = '60000';
  assert.equal(paths.serveIdleMs(), 60000, 'env overrides');

  // Garbage must not disable the timer — that is how a 1.4GB process becomes permanent.
  for (const bad of ['', 'soon', '0', '-1', 'NaN']) {
    process.env.MEMORY_SERVE_IDLE_MS = bad;
    assert.equal(paths.serveIdleMs(), 30 * 60 * 1000, `"${bad}" must fall back, not disable`);
  }
});

// modelIdleMs — the timer that actually reclaims the 1.3GB. Separate from serveIdleMs because the
// process and the model are two different costs; conflating them is why the process timeout had to
// be short.
test('modelIdleMs: env wins, then config, then a sane default', (t) => {
  const prev = process.env.MEMORY_MODEL_IDLE_MS;
  t.after(() => {
    if (prev === undefined) delete process.env.MEMORY_MODEL_IDLE_MS;
    else process.env.MEMORY_MODEL_IDLE_MS = prev;
  });

  delete process.env.MEMORY_MODEL_IDLE_MS;
  assert.equal(paths.modelIdleMs(), 5 * 60 * 1000, 'default is 5 minutes');

  process.env.MEMORY_MODEL_IDLE_MS = '30000';
  assert.equal(paths.modelIdleMs(), 30000, 'env overrides');

  for (const bad of ['', 'soon', '0', '-1', 'NaN']) {
    process.env.MEMORY_MODEL_IDLE_MS = bad;
    assert.equal(paths.modelIdleMs(), 5 * 60 * 1000, `"${bad}" must fall back, not disable`);
  }

  // The model must go before the process does, or unloading it never happens.
  delete process.env.MEMORY_MODEL_IDLE_MS;
  assert.ok(
    paths.modelIdleMs() < paths.serveIdleMs(),
    'model idle must be shorter than process idle, or the unload is dead code',
  );
});

// buildLexDocs — the keyword arm's units. Per-chunk vs per-note is a scoring decision, so the shape
// is pinned rather than assumed.
test('buildLexDocs: chunk mode keeps rows, note mode concatenates', () => {
  const rows = [
    { note: 'a', layer: 'Memory', heading: '(card)', text: 'cutover rollback' },
    { note: 'a', layer: 'Memory', heading: '(body)', text: 'canary deployment' },
    { note: 'b', layer: 'Patterns', heading: '(card)', text: 'latency budget' },
  ];

  const chunk = buildLexDocs(rows, 'chunk');
  assert.equal(chunk.length, 3, 'chunk mode is one doc per row');
  assert.ok(chunk[0].toks.length > 0, 'each doc is tokenised');

  const note = buildLexDocs(rows, 'note');
  assert.equal(note.length, 2, 'note mode is one doc per note');
  const a = note.find((d) => d.note === 'a');
  assert.equal(a.heading, '(note)');
  for (const w of ['cutover', 'rollback', 'canary', 'deployment'])
    assert.ok(a.toks.includes(w), `note doc must carry "${w}" from both of its chunks`);
  assert.equal(note.find((d) => d.note === 'b').layer, 'Patterns', 'layer survives the merge');

  // Anything that is not exactly 'note' means chunk — the env var is free text.
  assert.equal(buildLexDocs(rows, undefined).length, 3);
  assert.equal(buildLexDocs([], 'note').length, 0, 'an empty index is not an error');
});

// singleFlight — the guard that stops a concurrent reload leaking a ~1.3GB onnxruntime session.
// Tested here rather than through the server because a regression is SILENT: it costs memory, not
// correctness, so no answer changes and nothing throws.
test('singleFlight: N concurrent callers cause exactly one load', async () => {
  let loads = 0;
  let release;
  const cell = singleFlight(() => {
    loads++;
    return new Promise((r) => (release = () => r({ id: loads })));
  });

  const all = [cell.get(), cell.get(), cell.get(), cell.get()];
  assert.equal(loads, 1, 'four concurrent get()s must share ONE in-flight load');
  release();
  const got = await Promise.all(all);
  assert.equal(loads, 1, 'still one after they resolve');
  for (const g of got) assert.equal(g.id, 1, 'every caller gets the same instance');
  assert.equal(new Set(got).size, 1, 'literally the same object — a second would be the leak');

  // Cached: a later get() must not reload.
  assert.equal((await cell.get()).id, 1);
  assert.equal(loads, 1, 'a resolved value is reused, not reloaded');
});

test('singleFlight: take() hands the value over and the next get() reloads', async () => {
  let loads = 0;
  const cell = singleFlight(async () => ({ id: ++loads }));

  const first = await cell.get();
  const taken = cell.take();
  assert.equal(taken, first, 'take() returns the live value so the caller can release it');
  assert.equal(cell.take(), null, 'taking twice must not hand out the same value again');

  const second = await cell.get();
  assert.equal(second.id, 2, 'after a take() the next get() loads afresh');
  assert.notEqual(second, first);
});

test('singleFlight: a failed load clears the slot instead of poisoning it', async () => {
  let attempts = 0;
  const cell = singleFlight(async () => {
    if (++attempts === 1) throw new Error('cold start failed');
    return { id: attempts };
  });

  await assert.rejects(() => cell.get(), /cold start failed/);
  // The bug this guards: a rejected promise left in the slot would reject every later call forever,
  // so recall would stay dead for the life of the process after one transient failure.
  assert.equal((await cell.get()).id, 2, 'the next call retries rather than replaying the failure');
});

test('singleFlight: take() during an in-flight load lets that load land', async () => {
  let loads = 0;
  let release;
  const cell = singleFlight(() => {
    loads++;
    return new Promise((r) => (release = () => r({ id: loads })));
  });

  const pending = cell.get();
  assert.equal(cell.take(), null, 'nothing is loaded yet, so there is nothing to release');
  release();
  const v = await pending;
  assert.equal(v.id, 1, 'the caller still gets its value');
  assert.equal(await cell.get(), v, 'and the arrived value is now the cached one');
  assert.equal(loads, 1, 'the take() must not have triggered a second load');
});

test('singleFlight: take() refuses while the value is borrowed', async () => {
  let loads = 0;
  const cell = singleFlight(async () => ({ id: ++loads, disposed: false }));

  let releaseWork;
  const work = new Promise((r) => (releaseWork = r));
  const inFlight = cell.borrow(async (v) => {
    // The idle timer fires here, mid-inference. Disposing now would free the session underneath
    // native code — a crash, not a wrong answer.
    assert.equal(cell.busy(), true, 'the cell must report itself in use');
    assert.equal(cell.take(), null, 'take() must refuse while borrowed');
    await work;
    return v.id;
  });

  releaseWork();
  assert.equal(await inFlight, 1);
  assert.equal(cell.busy(), false, 'no longer in use once the borrow returns');
  assert.ok(cell.take(), 'and now it may be taken and disposed');
});

test('singleFlight: a throwing borrow still releases the value', async () => {
  const cell = singleFlight(async () => ({ id: 1 }));
  await assert.rejects(() =>
    cell.borrow(async () => {
      throw new Error('inference blew up');
    }),
  );
  // Without the finally, one failed request would pin the session for the life of the process —
  // the unload would refuse forever and the 1.3GB would never come back.
  assert.equal(cell.busy(), false, 'a failed borrow must not leave the cell permanently busy');
  assert.ok(cell.take(), 'so the idle timer can still reclaim it');
});

// mtimeCache — reload-when-written. One expression, and every way of getting it wrong is silent.
test('mtimeCache: serves cached until the source is newer, and reloads on a failed stat', () => {
  let loads = 0;
  const cache = mtimeCache((key) => ({ key, id: ++loads, loadedAt: 1000 }));

  const a = cache.get('projA', 999);
  assert.equal(a.id, 1, 'first get loads');
  assert.equal(cache.get('projA', 999).id, 1, 'not newer than loadedAt — cached');
  assert.equal(cache.get('projA', 1000).id, 1, 'equal is not newer — still cached');
  assert.equal(loads, 1);

  assert.equal(cache.get('projA', 1001).id, 2, 'written since load — reloads');

  // The direction that matters: a failed stat yields NaN, and NaN <= x is false, so it RELOADS.
  // Written the other way round (`mtimeMs > loadedAt`) NaN would be false and serve a stale index
  // forever, which reads identically and is wrong.
  const before = loads;
  cache.get('projA', NaN);
  assert.equal(loads, before + 1, 'an unreadable source must reload, never serve stale silently');

  cache.get('projB', 0);
  assert.equal(cache.size(), 2, 'projects are cached independently');
});

// buildBundle — everything after the SQL. Both of its decisions fail silently: dropping alias
// chunks changes retrieval without erroring, and a missing card map degrades every brief to raw
// chunk text that still looks like a result.
test('buildBundle: card map, alias ablation, and the lex mode it is given', () => {
  const rows = [
    { note: 'a', layer: 'Memory', heading: '(card)', text: 'a: the card line' },
    { note: 'a', layer: 'Memory', heading: '(aliases)', text: 'how do we cut over?' },
    { note: 'a', layer: 'Memory', heading: '(body)', text: 'cutover rollback detail' },
    { note: 'b', layer: 'Patterns', heading: '(body)', text: 'latency budget' },
  ];

  const b = buildBundle('projA', '/tmp/x.db', rows, { lexMode: 'chunk' });
  assert.equal(b.slug, 'projA');
  assert.equal(b.dbPath, '/tmp/x.db');
  assert.equal(b.rowsUsed.length, 4, 'alias chunks are kept by default — they earn their matches');
  assert.equal(b.cardByNote.get('a'), 'a: the card line', 'the card is what a brief displays');
  assert.equal(b.cardByNote.get('b'), undefined, 'a note with no card falls back to chunk text');
  assert.ok(b.loadedAt > 0, 'loadedAt is what mtimeCache compares against');

  const ablated = buildBundle('projA', '/tmp/x.db', rows, { dropAliases: true, lexMode: 'chunk' });
  assert.equal(ablated.rowsUsed.length, 3, 'the ablation switch removes alias chunks');
  assert.ok(!ablated.rowsUsed.some((r) => r.heading === '(aliases)'));
  assert.equal(
    ablated.lexDocs.length,
    3,
    'and the keyword arm sees the ablated set, not the full one',
  );

  // lexMode is threaded through rather than read from the environment here — the entry owns env.
  assert.equal(buildBundle('p', '/d', rows, { lexMode: 'note' }).lexDocs.length, 2);
  assert.equal(buildBundle('p', '/d', rows, { lexMode: 'chunk' }).lexDocs.length, 4);
});
