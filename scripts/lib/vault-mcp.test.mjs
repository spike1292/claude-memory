// Tests for scripts/lib/vault-mcp.mjs. Synthetic vault, isolated HOME and CLAUDE_MEMORY_HOME, a
// stubbed CARD reader over an empty index file and a fake --serve socket: the embedding model is never loaded.
import test from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-'));
const VAULT = path.join(root, 'vault');
const HOME = path.join(root, 'home');
const MEM = path.join(root, 'mem');
fs.mkdirSync(HOME);
process.env.HOME = HOME;
process.env.CLAUDE_MEMORY_HOME = MEM;
process.env.CLAUDE_VAULT = VAULT;
delete process.env.MEMORY_SEMANTIC_MODEL;

execFileSync(process.execPath, [
  path.join(here, '..', 'memory-synth-vault.mjs'),
  '--out',
  VAULT,
  '--notes',
  '20',
  '--seed',
  '7',
]);

const { MODEL_KEY, isIndexedSlug, indexedSlugs } = await import('./memory-semantic.mjs');
const { createHandler, readToken, startServer, PROTOCOL } = await import('./vault-mcp.mjs');

const DB_DIR = path.join(MEM, 'db');
fs.mkdirSync(DB_DIR, { recursive: true });
const memDir = path.join(VAULT, 'Memory', 'bench');
const notes = fs.readdirSync(memDir).filter((f) => f.endsWith('.md'));
const cards = notes.map((f) => ({
  note: f.slice(0, -3),
  layer: 'Memory',
  text: fs.readFileSync(path.join(memDir, f), 'utf8'),
}));
fs.writeFileSync(path.join(DB_DIR, `semantic-bench-${MODEL_KEY}.db`), '');
fs.writeFileSync(path.join(DB_DIR, `semantic-..-${MODEL_KEY}.db`), '');
fs.writeFileSync(path.join(DB_DIR, `semantic-other-not-this-model.db`), '');

fs.mkdirSync(path.join(VAULT, 'Logs', 'bench'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'Logs', 'bench', 'secret.md'), 'log secret');
fs.mkdirSync(path.join(VAULT, 'Graph', 'bench'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'Graph', 'bench', 'graph.md'), 'graph secret');
fs.symlinkSync(path.join(VAULT, 'Logs', 'bench', 'secret.md'), path.join(memDir, 'escape.md'));

const TOKEN = 'x'.repeat(40);
const AUTH = `Bearer ${TOKEN}`;

/** @param {string} dir */
function treeHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (/** @type {string} */ d) => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      h.update(p);
      if (e.isSymbolicLink()) h.update(fs.readlinkSync(p));
      else if (e.isDirectory()) walk(p);
      else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}
const before = treeHash(VAULT) + treeHash(DB_DIR);

const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vms-'));
test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sockDir, { recursive: true, force: true });
});
const SOCK = path.join(sockDir, 's.sock');
let spawns = 0;
/** @type {string[]} */
const cardReads = [];
let sockHits = 0;
/** @type {any[]} */
const sockRequests = [];

/** @param {object} [opts] */
const handler = (opts = {}) =>
  createHandler({
    token: TOKEN,
    readCards: (/** @type {string} */ f) => {
      cardReads.push(f);
      return cards;
    },
    sockPath: SOCK,
    spawn: () => {
      spawns++;
    },
    log: () => {},
    ...opts,
  });

/**
 * @param {{ body?: string | object, headers?: Record<string, string>, method?: string, url?: string }} r
 * @param {ReturnType<typeof handler>} [h]
 */
async function call(r, h = handler()) {
  const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    method: r.method ?? 'POST',
    url: r.url ?? '/mcp',
    headers: Object.fromEntries(
      Object.entries({ authorization: AUTH, ...r.headers }).filter(([, v]) => v !== undefined),
    ),
  });
  let status = 0;
  let out = '';
  const res = {
    writeHead(/** @type {number} */ s) {
      status = s;
      return res;
    },
    end(/** @type {string | undefined} */ b) {
      out = b ?? '';
    },
  };
  await h(/** @type {any} */ (req), /** @type {any} */ (res));
  return { status, body: out ? JSON.parse(out) : null };
}

/**
 * @param {string} method
 * @param {object} [params]
 * @param {Record<string, string | undefined>} [headers]
 */
function rpc(method, params = {}, headers = {}) {
  /** @type {Record<string, any>} */
  const p = { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL } };
  /** @type {Record<string, any>} */
  const h = { 'mcp-protocol-version': PROTOCOL, 'mcp-method': method };
  if (method === 'tools/call') h['mcp-name'] = p.name;
  return call({
    body: { jsonrpc: '2.0', id: 1, method, params: p },
    headers: { ...h, ...headers },
  });
}
/** @param {string} name @param {object} args */
const tool = (name, args) => rpc('tools/call', { name, arguments: args });

test('auth: no token, wrong token, different length all get 401 with no body', async () => {
  for (const authorization of [undefined, `Bearer ${'y'.repeat(40)}`, `Bearer ${TOKEN}x`, TOKEN]) {
    const r = await call({ body: 'not json', headers: /** @type {any} */ ({ authorization }) });
    assert.equal(r.status, 401);
    assert.equal(r.body, null);
  }
});

test('auth is checked before the body is read', async () => {
  let read = false;
  const req = Object.assign(
    new Readable({
      read() {
        read = true;
        this.push(null);
      },
    }),
    { method: 'POST', url: '/mcp', headers: {} },
  );
  let status = 0;
  await handler()(
    /** @type {any} */ (req),
    /** @type {any} */ ({
      writeHead: (/** @type {number} */ s) => (status = s),
      end() {},
    }),
  );
  assert.equal(status, 401);
  assert.equal(read, false);
});

test('Origin present gets 403; GET gets 405; other paths 404', async () => {
  assert.equal((await rpc('tools/list', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call({ method: 'GET' })).status, 405);
  assert.equal((await call({ url: '/other' })).status, 404);
});

test('body over the cap gets 413', async () => {
  const r = await call({ body: 'x'.repeat(70 * 1024) });
  assert.equal(r.status, 413);
});

test('JSON-RPC framing errors', async () => {
  const parse = await call({ body: '{nope' });
  assert.equal(parse.body.error.code, -32700);
  const batch = await call({ body: [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }] });
  assert.equal(batch.body.error.code, -32600);
  const shape = await call({ body: { jsonrpc: '1.0', id: 1, method: 'tools/list' } });
  assert.equal(shape.body.error.code, -32600);
  const unknown = await rpc('resources/list');
  assert.equal(unknown.body.error.code, -32601);
  for (const r of [parse, batch, shape, unknown])
    assert.doesNotMatch(
      JSON.stringify(r.body),
      new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
});

test('protocol version: missing -32602/400, legacy -32022/400, initialize -32022/400', async () => {
  const missing = await call({
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    headers: { 'mcp-protocol-version': PROTOCOL, 'mcp-method': 'tools/list' },
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, -32602);

  const old = await call({
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } },
    },
    headers: { 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/list' },
  });
  assert.equal(old.status, 400);
  assert.equal(old.body.error.code, -32022);
  assert.deepEqual(old.body.error.data, { supported: [PROTOCOL], requested: '2025-11-25' });

  const init = await call({
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    },
  });
  assert.equal(init.status, 400);
  assert.equal(init.body.error.code, -32022);
  assert.deepEqual(init.body.error.data.supported, [PROTOCOL]);
});

test('headers: missing Mcp-Method, mismatched Mcp-Name get 400', async () => {
  assert.equal((await rpc('tools/list', {}, { 'mcp-method': undefined })).status, 400);
  assert.equal((await rpc('tools/list', {}, { 'mcp-protocol-version': undefined })).status, 400);
  const r = await rpc(
    'tools/call',
    { name: 'list_projects', arguments: {} },
    { 'mcp-name': 'search' },
  );
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, -32020);
});

test('server/discover names the one supported version', async () => {
  const { status, body } = await rpc('server/discover');
  assert.equal(status, 200);
  assert.equal(body.result.resultType, 'complete');
  assert.deepEqual(body.result.supportedVersions, [PROTOCOL]);
  assert.deepEqual(body.result.capabilities, { tools: {} });
  assert.equal(body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'vault-mcp');
  assert.equal(typeof body.result.ttlMs, 'number');
  assert.equal(typeof body.result.cacheScope, 'string');
});

test('tools/list returns exactly the three tools, in order', async () => {
  const { body } = await rpc('tools/list');
  assert.deepEqual(
    body.result.tools.map((/** @type {{ name: string }} */ t) => t.name),
    ['list_projects', 'search', 'get_note'],
  );
  assert.equal(body.result.resultType, 'complete');
  assert.equal(typeof body.result.ttlMs, 'number');
  assert.equal(typeof body.result.cacheScope, 'string');
  assert.ok(body.result._meta['io.modelcontextprotocol/serverInfo']);
});

test('slug guard: only safe slugs with an index for the active model', () => {
  assert.deepEqual(indexedSlugs(DB_DIR), ['bench']);
  assert.equal(isIndexedSlug(DB_DIR, 'bench'), true);
  for (const s of ['..', '../x', 'a/b', '', 'other-not-this', 'nope', '.'])
    assert.equal(isIndexedSlug(DB_DIR, s), false, s);
});

test('list_projects returns the indexed slugs', async () => {
  const { body } = await tool('list_projects', {});
  assert.deepEqual(body.result.structuredContent, { projects: ['bench'] });
});

test('search: bad project is refused before any socket or spawn', async () => {
  spawns = 0;
  for (const project of ['../x', 'a/b', '', 'nope', '..']) {
    const { body } = await tool('search', { query: 'container heap limit', project });
    assert.equal(body.error.code, -32602, project);
  }
  assert.equal(spawns, 0);
  assert.deepEqual(cardReads, []);
  const badK = await tool('search', { query: 'x y z', project: 'bench', k: 11 });
  assert.equal(badK.body.error.code, -32602);
});

test('search: no socket answers from the keyword arm and spawns once', async () => {
  spawns = 0;
  const { body } = await tool('search', {
    query: 'interpreter heap cap above the container limit',
    project: 'bench',
  });
  const out = body.result.structuredContent;
  assert.equal(out.arm, 'keyword');
  assert.ok(out.results.length > 0);
  assert.match(out.results[0].note, /heap-cap/);
  assert.equal(spawns, 1);
  assert.deepEqual(cardReads, [path.join(DB_DIR, `semantic-bench-${MODEL_KEY}.db`)]);
});

test('search: a live --serve socket answers with arm semantic', async () => {
  const srv = net.createServer((s) => {
    sockHits++;
    s.on('data', (d) => {
      sockRequests.push(JSON.parse(String(d)));
      s.end(
        JSON.stringify({
          slug: 'bench',
          results: [{ note: 'n1', layer: 'Memory', text: 't', score: 0.9 }],
        }) + '\n',
      );
    });
  });
  await new Promise((r) => srv.listen(SOCK, () => r(null)));
  try {
    spawns = 0;
    const { body } = await tool('search', { query: 'anything at all', project: 'bench', k: 3 });
    const out = body.result.structuredContent;
    assert.equal(out.arm, 'semantic');
    assert.equal(out.results[0].note, 'n1');
    assert.deepEqual(sockRequests.at(-1), { q: 'anything at all', k: 3, slug: 'bench' });
    assert.equal(spawns, 0);
    const hits = sockHits;
    await tool('search', { query: 'anything', project: '../x' });
    assert.equal(sockHits, hits);
  } finally {
    await new Promise((r) => srv.close(() => r(null)));
  }
});

test('get_note reads a Memory note and refuses everything outside the sources', async () => {
  const name = notes[0].slice(0, -3);
  const ok = await tool('get_note', { project: 'bench', note: name });
  assert.equal(
    ok.body.result.content[0].text,
    fs.readFileSync(path.join(memDir, notes[0]), 'utf8'),
  );
  for (const note of [
    `../${name}`,
    '../../Logs/bench/secret',
    path.join(memDir, name),
    'Logs/bench/secret',
    'secret',
    'graph',
    'escape',
    '',
  ]) {
    const r = await tool('get_note', { project: 'bench', note });
    assert.equal(r.body.error?.code, -32602, note);
    assert.doesNotMatch(JSON.stringify(r.body), /secret/);
  }
  const badProject = await tool('get_note', { project: '..', note: 'CLAUDE' });
  assert.equal(badProject.body.error.code, -32602);
});

test('startServer: a real request without the token gets 401', async () => {
  const srv = startServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    readCards: () => [],
    log: () => {},
  });
  await new Promise((r) => srv.once('listening', () => r(null)));
  try {
    const port = /** @type {import('node:net').AddressInfo} */ (srv.address()).port;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
  } finally {
    await new Promise((r) => srv.close(() => r(null)));
  }
});

test('readToken: file or $CREDENTIALS_DIRECTORY, never env, at least 32 bytes', () => {
  const dir = fs.mkdtempSync(path.join(root, 'cred-'));
  fs.writeFileSync(path.join(dir, 'vault-mcp-token'), TOKEN + '\n');
  assert.equal(readToken({ credentialsDir: dir }), TOKEN);
  const short = path.join(dir, 'short');
  fs.writeFileSync(short, 'x'.repeat(31));
  assert.throws(() => readToken({ tokenFile: short }), /32/);
  assert.throws(() => readToken({}), /token/);
});

test('the entry refuses to start with no token', () => {
  const r = spawnSync(process.execPath, [path.join(here, '..', 'vault-mcp.mjs'), '--port', '0'], {
    env: { ...process.env, CREDENTIALS_DIRECTORY: '', VAULT_MCP_TOKEN: TOKEN },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /token/);
});

test('the suite wrote nothing to the vault or the index directory', () => {
  assert.equal(treeHash(VAULT) + treeHash(DB_DIR), before);
});
