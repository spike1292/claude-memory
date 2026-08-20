// Tests for scripts/lib/doctor-perf.mjs. Run: node --test scripts/lib/doctor-perf.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  formatBytes,
  table,
  parseServers,
  modelState,
  MODEL_RSS_THRESHOLD,
  dirUsage,
  parseIndexName,
  indexStats,
  probeSocket,
  report,
  readPs,
} from './doctor-perf.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perf-'));
const MODELS = ['bge-small-en', 'bge-m3', 'e5-multi'];

test('formatBytes scales, and never prints a misleading round number', () => {
  assert.strictEqual(formatBytes(0), '0 B');
  assert.strictEqual(formatBytes(512), '512 B');
  assert.strictEqual(formatBytes(1024), '1.0 KB');
  assert.strictEqual(formatBytes(1024 * 1024 * 1.3), '1.3 MB');
  assert.strictEqual(formatBytes(1024 ** 3 * 1.3), '1.3 GB');
  // A total that cannot be computed must not read as an empty directory.
  assert.strictEqual(formatBytes(NaN), '-');
  assert.strictEqual(formatBytes(-1), '-');
});

test('table pads every column but the last', () => {
  const t = table(['a', 'bbb'], [['xxxx', 'y']]);
  const [head, row] = t.split('\n');
  assert.strictEqual(head, 'a     bbb');
  assert.strictEqual(row, 'xxxx  y');
  assert.ok(!/ $/m.test(t), 'no trailing spaces — the table survives a paste into an issue');
});

test('parseServers finds only the search servers, and reads RSS in bytes', () => {
  const ps = [
    '  501  15360  02:59:11 node /x/scripts/memory-semantic.mjs --serve',
    '  502 379584  01:00:00 node /y/scripts/memory-semantic.mjs --serve',
    '  503   1024  00:00:01 node /x/scripts/memory-semantic.mjs --query hello',
    '  504   2048  00:00:02 vim memory-semantic.mjs',
    'garbage line',
  ].join('\n');
  const found = parseServers(ps);
  assert.deepStrictEqual(
    found.map((s) => s.pid),
    [501, 502],
    'a --query run and an editor are not servers',
  );
  assert.strictEqual(found[0].rss, 15360 * 1024, 'ps reports KB; the report is in bytes');
  assert.strictEqual(found[0].elapsed, '02:59:11');
});

test('parseServers survives an empty or failed ps', () => {
  assert.deepStrictEqual(parseServers(''), []);
  assert.deepStrictEqual(parseServers(undefined), []);
});

// The command column is last precisely so a path with spaces cannot eat the columns before it.
test('parseServers reads a command containing spaces', () => {
  const [s] = parseServers('  7  100  00:01 node /My Dir/scripts/memory-semantic.mjs --serve');
  assert.deepStrictEqual(s, { pid: 7, rss: 100 * 1024, elapsed: '00:01' });
});

test('modelState splits the two states well clear of the threshold', () => {
  assert.strictEqual(modelState(15 * 1024 * 1024), 'model unloaded', 'measured idle: 15 MB');
  assert.strictEqual(
    modelState(370 * 1024 * 1024),
    'model loaded',
    'measured after a query: 370 MB',
  );
  assert.strictEqual(modelState(MODEL_RSS_THRESHOLD), 'model loaded');
});

test('parseIndexName splits on the KNOWN model, not on the last dash', () => {
  // Both halves contain dashes; a positional split gets this wrong in both directions.
  assert.deepStrictEqual(
    parseIndexName('semantic-github.com-spike1292-claude-memory-bge-m3.db', MODELS),
    {
      slug: 'github.com-spike1292-claude-memory',
      model: 'bge-m3',
    },
  );
  assert.deepStrictEqual(parseIndexName('semantic-bench-bge-small-en.db', MODELS), {
    slug: 'bench',
    model: 'bge-small-en',
  });
  assert.strictEqual(parseIndexName('semantic-bench-unknown-model.db', MODELS), null);
  assert.strictEqual(parseIndexName('not-an-index.db', MODELS), null);
});

test('dirUsage sums a tree, skips symlinks, and reports a missing directory', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a'), 'x'.repeat(100));
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'sub', 'b'), 'x'.repeat(50));
  // A link is counted as a link, not as what it points at. No directory scanned today is one —
  // this is the standing precaution against risk R8, where every past size check that dereferenced
  // a symlink measured something other than what it claimed.
  fs.symlinkSync(path.join(d, 'a'), path.join(d, 'link'));

  assert.deepStrictEqual(dirUsage(d), { bytes: 150, files: 2, missing: false });
  assert.deepStrictEqual(dirUsage(path.join(d, 'nope')), { bytes: 0, files: 0, missing: true });
});

// run/ holds unix sockets and almost nothing else, so counting only regular files reports the
// directory the servers live in as empty. Caught exactly that way once.
test('dirUsage counts a socket', async () => {
  const d = tmp();
  const server = net.createServer(() => {});
  await new Promise((r) => server.listen(path.join(d, 'search.sock'), r));
  try {
    assert.strictEqual(dirUsage(d).files, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// No `node:sqlite` here on purpose: the entry owns the handle, so this drives the injected reader.
// CI fails the build if any lib/ file — tests included — imports it.
test('indexStats reports what the reader returns, and names what it cannot read', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'semantic-proj-bge-m3.db'), 'x'.repeat(64));
  fs.writeFileSync(path.join(d, 'semantic-broken-bge-m3.db'), 'not a database');
  const counts = (f) => (f.includes('broken') ? null : { chunks: 3, notes: 2 });

  const rows = indexStats(d, MODELS, counts);
  const ok = rows.find((r) => r.slug === 'proj');
  assert.strictEqual(ok.chunks, 3);
  assert.strictEqual(ok.notes, 2, 'notes are distinct files, not chunks');
  assert.ok(ok.bytes > 0 && ok.mtime instanceof Date);

  const broken = rows.find((r) => r.slug === 'broken');
  assert.strictEqual(broken.chunks, null, 'an unreadable index is the state that mutes recall');
});

test('indexStats on a missing db dir is empty, not a throw', () => {
  assert.deepStrictEqual(indexStats(path.join(tmp(), 'nope'), MODELS), []);
});

// The default reader returns null for everything, so a caller that forgets to inject one gets
// "unreadable" rows rather than a crash on an undefined call.
test('indexStats without a reader still lists the files', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'semantic-proj-bge-m3.db'), 'x');
  const [row] = indexStats(d, MODELS);
  assert.strictEqual(row.slug, 'proj');
  assert.strictEqual(row.chunks, null);
});

test('probeSocket never spawns: a missing socket is an answer', async () => {
  const r = await probeSocket(path.join(tmp(), 'search.sock'), { slug: 'x' });
  assert.deepStrictEqual(r, { ok: false, reason: 'no socket' });
});

// A socket FILE outlives the process that bound it, so this is a routine state, not an error.
test('probeSocket reports an orphaned socket file', async () => {
  const f = path.join(tmp(), 'search.sock');
  const server = net.createServer(() => {});
  await new Promise((r) => server.listen(f, r));
  await new Promise((r) => server.close(r));
  fs.writeFileSync(f, ''); // the file, without the listener behind it
  const r = await probeSocket(f, { slug: 'x', timeoutMs: 200 });
  assert.strictEqual(r.ok, false);
});

test('probeSocket times a real answer and counts its results', async () => {
  const f = path.join(tmp(), 'search.sock');
  const server = net.createServer((c) =>
    c.on('data', () => c.end(JSON.stringify({ slug: 'x', results: [1, 2, 3] }) + '\n')),
  );
  await new Promise((r) => server.listen(f, r));
  try {
    const r = await probeSocket(f, { slug: 'x' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.hits, 3);
    assert.ok(r.ms >= 0 && r.ms < 3000);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('probeSocket gives up rather than hanging the report', async () => {
  const f = path.join(tmp(), 'search.sock');
  // The server-side socket is held so it can be destroyed here: server.close() waits for open
  // connections, and this server deliberately never reads the request that is sitting in it.
  const open = [];
  const server = net.createServer((c) => open.push(c)); // accepts, never answers
  await new Promise((r) => server.listen(f, r));
  try {
    const r = await probeSocket(f, { slug: 'x', timeoutMs: 100 });
    assert.deepStrictEqual(r, { ok: false, reason: 'no answer in 100ms' });
  } finally {
    for (const c of open) c.destroy();
    await new Promise((r) => server.close(r));
  }
});

// The probe is a real query: the server embeds it, which reloads the ~1.3 GB model if modelIdleMs
// had unloaded it. Measuring the unloaded state must not create the loaded one.
test('report does not probe a server that has unloaded its model', async () => {
  const state = tmp();
  const idle = '  501  15360  02:00:00 node /x/scripts/memory-semantic.mjs --serve';
  const out = await report({ state, activeModel: 'bge-m3', activeSlug: 'x', ps: idle });
  assert.match(out, /has its model unloaded — probing could reload it/);
  assert.match(out, /starts a server or reloads a model/);
});

// One --serve per MODEL, and ps cannot say which is which. A warm server proves nothing about the
// socket this report is about to talk to, so a mixed pair must not be treated as warm.
test('report does not probe when one of two servers is cold', async () => {
  const ps = [
    '  501  15360  02:00:00 node /x/scripts/memory-semantic.mjs --serve', // idle: 15 MB
    '  502 593920  02:00:00 node /x/scripts/memory-semantic.mjs --serve', // warm: 580 MB
  ].join('\n');
  const out = await report({ state: tmp(), activeModel: 'bge-m3', activeSlug: 'x', ps });
  assert.match(out, /has its model unloaded — probing could reload it/);
});

test('report says so when there is no server at all', async () => {
  const out = await report({ state: tmp(), activeModel: 'bge-m3', activeSlug: 'x', ps: '' });
  assert.match(out, /no server running/);
});

// The three tests above cover only the branches that decline to probe. This one drives the whole
// assembly through the OTHER side of the gate: a warm ps listing, a real listening socket at the
// path report() computes, and both probes answering.
test('report measures the round trip when every server is warm', async () => {
  const state = tmp();
  fs.mkdirSync(path.join(state, 'run'), { recursive: true });
  const server = net.createServer((c) =>
    c.on('data', () => c.end(JSON.stringify({ slug: 'x', results: [1, 2] }) + '\n')),
  );
  await new Promise((r) => server.listen(path.join(state, 'run', 'search-bge-m3.sock'), r));
  try {
    const ps = '  501 593920  02:00:00 node /x/scripts/memory-semantic.mjs --serve';
    const out = await report({ state, activeModel: 'bge-m3', activeSlug: 'x', ps });
    assert.match(out, /\d+ ms first query, \d+ ms second \(2 hits, slug x\)/);
    assert.doesNotMatch(out, /not measured/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// Everything above feeds parseServers a synthetic listing, so nothing checked that the `ps` flags
// work on the platform running them. A wrong flag would not error — it would return rows nothing
// matches, and the report would say "none running" while a server was up. This finds THIS process
// in the real output, which pins the column ORDER as well as the shape.
test('the ps flags produce rows this platform can parse', () => {
  const out = readPs();
  assert.ok(out.length > 0, 'ps produced no output at all');

  const mine = out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .find((m) => Number(m[1]) === process.pid);

  assert.ok(mine, `no row matched pid ${process.pid} — check the ps flags for this platform`);
  assert.ok(Number(mine[2]) > 0, 'the rss column is not a size');
  assert.match(mine[3], /^(\d+-)?(\d+:)?\d+:\d\d$/, 'the etime column is not an elapsed time');
  assert.match(mine[4], /node/, 'the command column does not hold the command');
});
