// Read-only MCP server over the vault, for a claude.ai custom connector. MCP 2026-07-28 only,
// Streamable HTTP with JSON responses, hand-rolled JSON-RPC: no SDK, no new dependency.
// Why bearer-only, Origin refused, one protocol version and an ungated keyword fallback:
// docs/decisions/2026-10-13-vault-mcp.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import * as paths from '../../hooks/lib/paths.mjs';
import { detach } from '../../hooks/lib/hook-io.mjs';
import { bm25, lexTokens } from './lexical.mjs';
import {
  MODEL_KEY,
  SAFE_NAME,
  indexedSlugs,
  isIndexedSlug,
  vaultSources,
} from './memory-semantic.mjs';

export const PROTOCOL = '2026-07-28';
export const BODY_CAP = 64 * 1024;
const PV = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const PAGE = { ttlMs: 300000, cacheScope: 'public' };

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List the vault projects that have a search index. Call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search',
    description: 'Search one project of the memory vault. Returns the best-matching notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        project: { type: 'string', description: 'A slug from list_projects' },
        k: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
      },
      required: ['query', 'project'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_note',
    description: 'Read one note of a project by its name, as returned by search.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, note: { type: 'string' } },
      required: ['project', 'note'],
      additionalProperties: false,
    },
  },
];

class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   * @param {number} [status]
   * @param {unknown} [data]
   */
  constructor(code, message, status = 200, data) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}
/** @param {string} msg */
const badArgs = (msg) => new RpcError(-32602, msg);

/**
 * @param {{ tokenFile?: string, credentialsDir?: string }} o
 * @returns {string}
 */
export function readToken({ tokenFile, credentialsDir }) {
  const file = tokenFile || (credentialsDir ? path.join(credentialsDir, 'vault-mcp-token') : '');
  if (!file) throw new Error('no token: pass --token-file or set $CREDENTIALS_DIRECTORY');
  const token = fs.readFileSync(file, 'utf8').trim();
  if (Buffer.byteLength(token) < 32) throw new Error('token shorter than 32 bytes');
  return token;
}

/**
 * @param {string | undefined} header
 * @param {string} token
 */
function authorized(header, token) {
  const got = Buffer.from(String(header ?? ''));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string | null>} null when over BODY_CAP
 */
function readCapped(req) {
  if (Number(req.headers['content-length']) > BODY_CAP) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (/** @type {Buffer} */ c) => {
      size += c.length;
      if (size > BODY_CAP) {
        req.removeAllListeners('data');
        req.pause();
        resolve(null);
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {string} sockPath
 * @param {object} msg
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
function askServe(sockPath, msg, timeoutMs) {
  return new Promise((resolve) => {
    const c = net.createConnection(sockPath);
    let buf = '';
    const done = (/** @type {any} */ v) => {
      clearTimeout(timer);
      c.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    c.on('connect', () => c.write(JSON.stringify(msg) + '\n'));
    c.on('data', (d) => (buf += d));
    c.on('end', () => {
      try {
        done(JSON.parse(buf));
      } catch {
        done(null);
      }
    });
    c.on('error', () => done(null));
  });
}

/** @typedef {{ note: string, layer: string, text: string | null }} Card */

// Same BM25 over the same CARD rows as recall's keywordArm(), without its prompt-injection gates:
// a search tool returns a ranking and lets the caller judge it.
/**
 * @param {readonly Card[]} cards
 * @param {string} query
 * @param {number} k
 */
function keywordSearch(cards, query, k) {
  const qt = [...new Set(lexTokens(query))];
  if (!qt.length) return [];
  const docs = cards.map((c) => ({ ...c, toks: lexTokens(c.text ?? '') }));
  const scores = bm25(docs, qt, 1.2, 0.75);
  return docs
    .map((d, i) => ({ note: d.note, layer: d.layer, text: d.text, score: +scores[i].toFixed(4) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Resolves only to a file directly inside one of the project's vaultSources() folders, by real
 * path, so a symlink out of them is refused like a missing note.
 * @param {string} vault
 * @param {string} project
 * @param {unknown} note
 * @returns {string | null}
 */
function readNote(vault, project, note) {
  if (typeof note !== 'string' || !SAFE_NAME.test(note)) return null;
  const file = note.endsWith('.md') ? note : `${note}.md`;
  const real = (/** @type {string} */ p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const roots = vaultSources(vault, project)
    .map((s) => real(s.dir))
    .filter((d) => d !== null);
  for (const root of roots) {
    const p = real(path.join(root, file));
    if (p && roots.includes(path.dirname(p)) && fs.statSync(p).isFile())
      return fs.readFileSync(p, 'utf8');
  }
  return null;
}

/**
 * @typedef {{
 *   token: string,
 *   readCards: (dbFile: string) => Card[],
 *   vault?: string,
 *   dbDir?: string,
 *   sockPath?: string,
 *   spawn?: () => void,
 *   timeoutMs?: number,
 *   log?: (line: string) => void,
 * }} HandlerOptions
 */

/**
 * @param {HandlerOptions} o
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHandler({
  token,
  readCards,
  vault = paths.vault(),
  dbDir = paths.stateDir('db'),
  sockPath = path.join(paths.stateDir('run'), `search-${MODEL_KEY}.sock`),
  spawn = () =>
    detach(process.execPath, [path.join(paths.scriptsDir, 'memory-semantic.mjs'), '--serve']),
  timeoutMs = 1500,
  log = (line) => console.error(line),
}) {
  const version = JSON.parse(
    fs.readFileSync(path.join(paths.pluginRoot, 'package.json'), 'utf8'),
  ).version;
  const meta = { [SERVER_INFO]: { name: 'vault-mcp', version } };

  /** @param {unknown} project */
  const project = (project) => {
    if (!isIndexedSlug(dbDir, project)) throw badArgs('unknown project; call list_projects');
    return project;
  };

  /**
   * @param {string} name
   * @param {Record<string, unknown>} args
   */
  async function callTool(name, args) {
    if (name === 'list_projects') return { projects: indexedSlugs(dbDir) };
    if (name === 'search') {
      const slug = project(args.project);
      const { query, k = 5 } = args;
      if (typeof query !== 'string' || !query.trim()) throw badArgs('query must be a string');
      if (!Number.isInteger(k) || /** @type {number} */ (k) < 1 || /** @type {number} */ (k) > 10)
        throw badArgs('k must be an integer from 1 to 10');
      const n = /** @type {number} */ (k);
      const sem = await askServe(sockPath, { q: query, k: n, slug }, timeoutMs);
      if (Array.isArray(sem?.results)) {
        const results = sem.results.map((/** @type {any} */ r) => ({
          note: r.note,
          layer: r.layer,
          text: r.text,
          score: r.score,
        }));
        return { arm: 'semantic', results };
      }
      spawn();
      const dbFile = path.join(dbDir, `semantic-${slug}-${MODEL_KEY}.db`);
      return { arm: 'keyword', results: keywordSearch(readCards(dbFile), query, n) };
    }
    if (name === 'get_note') {
      const text = readNote(vault, project(args.project), args.note);
      if (text === null) throw badArgs('no such note in this project');
      return text;
    }
    throw badArgs('unknown tool');
  }

  /**
   * @param {string} raw
   * @param {import('node:http').IncomingHttpHeaders} headers
   * @returns {Promise<{ status: number, body: object, msg?: any }>}
   */
  async function rpc(raw, headers) {
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return reply(null, new RpcError(-32700, 'parse error', 400));
    }
    const valid =
      msg &&
      typeof msg === 'object' &&
      !Array.isArray(msg) &&
      msg.jsonrpc === '2.0' &&
      typeof msg.method === 'string' &&
      (typeof msg.id === 'string' || Number.isInteger(msg.id)) &&
      (msg.params === undefined || (msg.params && typeof msg.params === 'object'));
    if (!valid) return reply(null, new RpcError(-32600, 'invalid request', 400));
    const id = msg.id;
    const params = msg.params ?? {};
    try {
      const requested = msg.method === 'initialize' ? params.protocolVersion : params._meta?.[PV];
      if (requested === undefined && msg.method !== 'initialize')
        throw new RpcError(-32602, 'missing _meta protocolVersion', 400);
      if (requested !== PROTOCOL)
        throw new RpcError(-32022, 'unsupported protocol version', 400, {
          supported: [PROTOCOL],
          requested: requested ?? null,
        });
      const mismatch =
        headers['mcp-protocol-version'] !== PROTOCOL ||
        headers['mcp-method'] !== msg.method ||
        (msg.method === 'tools/call' && headers['mcp-name'] !== params.name);
      if (mismatch) throw new RpcError(-32020, 'header mismatch', 400);

      /** @type {object} */
      let result;
      if (msg.method === 'server/discover')
        result = {
          supportedVersions: [PROTOCOL],
          capabilities: { tools: {} },
          ttlMs: 3600000,
          cacheScope: 'public',
        };
      else if (msg.method === 'tools/list') result = { tools: TOOLS, ...PAGE };
      else if (msg.method === 'tools/call') {
        const args = params.arguments ?? {};
        if (typeof params.name !== 'string' || typeof args !== 'object' || Array.isArray(args))
          throw badArgs('tools/call needs a name and an arguments object');
        const out = await callTool(params.name, args);
        result =
          typeof out === 'string'
            ? { content: [{ type: 'text', text: out }], isError: false }
            : {
                content: [{ type: 'text', text: JSON.stringify(out) }],
                structuredContent: out,
                isError: false,
              };
      } else throw new RpcError(-32601, 'method not found');
      return {
        status: 200,
        body: { jsonrpc: '2.0', id, result: { resultType: 'complete', ...result, _meta: meta } },
        msg,
      };
    } catch (e) {
      return { ...reply(id, e), msg };
    }
  }

  /**
   * @param {unknown} id
   * @param {unknown} e
   */
  function reply(id, e) {
    const err = e instanceof RpcError ? e : new RpcError(-32603, 'internal error', 500);
    /** @type {{ code: number, message: string, data?: unknown }} */
    const error = { code: err.code, message: err.message };
    if (err.data !== undefined) error.data = err.data;
    return { status: err.status, body: { jsonrpc: '2.0', id, error } };
  }

  return async (req, res) => {
    /**
     * @param {number} status
     * @param {object} [body]
     * @param {Record<string, string>} [extra]
     */
    const send = (status, body, extra = {}) => {
      const h = body ? { 'content-type': 'application/json', ...extra } : extra;
      res.writeHead(status, h);
      res.end(body ? JSON.stringify(body) : undefined);
    };
    if (!authorized(req.headers.authorization, token)) return send(401);
    if (req.headers.origin !== undefined) return send(403);
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') return send(404);
    if (req.method !== 'POST') return send(405, undefined, { allow: 'POST' });
    const raw = await readCapped(req).catch(() => null);
    if (raw === null) return send(413, undefined, { connection: 'close' });
    const { status, body, msg } = await rpc(raw, req.headers);
    log(
      JSON.stringify({
        t: new Date().toISOString(),
        status,
        method: msg?.method,
        protocolVersion: req.headers['mcp-protocol-version'],
        clientInfo: msg?.params?._meta?.['io.modelcontextprotocol/clientInfo'],
      }),
    );
    send(status, body);
  };
}

/**
 * @param {HandlerOptions & { host?: string, port: number }} o
 * @returns {import('node:http').Server}
 */
export function startServer({ host = '127.0.0.1', port, ...opts }) {
  const handle = createHandler(opts);
  return http
    .createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    })
    .listen(port, host);
}
