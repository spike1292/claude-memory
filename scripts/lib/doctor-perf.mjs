// The `--perf` half of /memory:doctor: where the CPU, the RAM and the disk actually went.
// The CLI entry is scripts/doctor-perf.mjs.
//
// doctor.sh answers "is this wired up". It cannot answer "why is this slow" or "what is eating my
// RAM", which is the question this plugin generates: one --serve process holds a ~1.3 GB model,
// six of them once ran at once on a 16 GB machine, and onnxruntime's arena never gives memory back.
//
// Read-only, and that is a hard rule, not a preference: this must never start a server, load a
// model or re-index. Everything below either reads a file, parses `ps`, or talks to a socket that
// is ALREADY listening.
//
// Node rather than more bash because every line of it loops — over db files, over a directory
// tree, over ps output — and a hook that loops belongs in Node.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

/** Bytes as a human reads them. Two significant-ish digits: 1.3 GB, not 1.29 GB or 1 GB. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Column-aligned rows. The last column is never padded — trailing spaces survive a paste. */
export function table(headers, rows) {
  const all = [headers, ...rows].map((r) => r.map((c) => String(c ?? '')));
  const width = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  return all
    .map((r) =>
      r
        .map((c, i) => (i === r.length - 1 ? c : c.padEnd(width[i])))
        .join('  ')
        .replace(/\s+$/, ''),
    )
    .join('\n');
}

/**
 * The resident search servers, from one `ps` listing.
 *
 * Parsed rather than looked up by pid file because the thing worth reporting is exactly the case
 * no pid file covers: MORE THAN ONE server alive. `command=` is last so a command containing
 * spaces cannot eat the columns before it.
 */
export function parseServers(psOutput) {
  const out = [];
  for (const line of String(psOutput ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, rssKb, elapsed, cmd] = m;
    if (!/memory-semantic\.mjs/.test(cmd) || !/--serve/.test(cmd)) continue;
    out.push({ pid: Number(pid), rss: Number(rssKb) * 1024, elapsed, cmd });
  }
  return out;
}

// `modelIdleMs` unloads the model and leaves the socket, indexes and BM25 tokens behind, so the two
// states are an order of magnitude apart in RSS and nothing else has to be asked. Measured on this
// machine 2026-08-20, one server, bge-m3: 15 MB idle-unloaded, 370 MB immediately after a query.
// The midpoint is the threshold; it is not close to either state.
// ponytail: RSS threshold, not a real probe — add a status field to the socket reply if it ever
// has to be exact.
export const MODEL_RSS_THRESHOLD = 100 * 1024 * 1024;

export const modelState = (rss) => (rss >= MODEL_RSS_THRESHOLD ? 'model loaded' : 'model unloaded');

/** Recursive size of a directory: total bytes and file count. Missing directory is zeroes. */
export function dirUsage(dir) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0, missing: true };
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = dirUsage(p);
      bytes += sub.bytes;
      files += sub.files;
    } else {
      try {
        // Symlinks are NOT followed: models/ is symlinked into a shared node_modules on a machine
        // that has run share-modules.mjs, and following it would bill one copy to every version.
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) continue;
        bytes += st.size;
        files++;
      } catch {
        /* raced with a delete */
      }
    }
  }
  return { bytes, files, missing: false };
}

/**
 * `semantic-<slug>-<model>.db` -> its two parts.
 *
 * Both halves contain dashes (`bge-small-en`, `github.com-spike1292-claude-memory`), so the split
 * cannot be positional — it is driven by the KNOWN model keys, longest first, since `bge-m3` and
 * `bge-small-en` share a prefix. The keys come from MODELS in memory-semantic.mjs; a second list
 * here would drift and silently mislabel every row.
 */
export function parseIndexName(file, modelKeys) {
  for (const model of [...modelKeys].sort((a, b) => b.length - a.length)) {
    const m = new RegExp(
      `^semantic-(.+)-${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.db$`,
    ).exec(file);
    if (m) return { slug: m[1], model };
  }
  return null;
}

/**
 * One row per index on this machine: size, chunks, notes, and when it was last written.
 *
 * Opened read-only. A db that cannot be read is reported as such rather than skipped — an
 * unreadable index is precisely the state that makes recall go quiet.
 */
export function indexStats(dbDir, modelKeys = []) {
  let files;
  try {
    files = fs.readdirSync(dbDir).filter((f) => f.endsWith('.db'));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const parts = parseIndexName(f, modelKeys) ?? { slug: f.replace(/\.db$/, ''), model: '?' };
      const full = path.join(dbDir, f);
      const row = { ...parts, file: f, bytes: 0, chunks: null, notes: null, mtime: null };
      try {
        const st = fs.statSync(full);
        row.bytes = st.size;
        row.mtime = st.mtime;
      } catch {
        /* reported as zeroes */
      }
      try {
        const db = new DatabaseSync(full, { readOnly: true });
        row.chunks = db.prepare('select count(*) c from chunks').get().c;
        row.notes = db.prepare('select count(distinct file) c from chunks').get().c;
        db.close();
      } catch {
        /* chunks stay null -> rendered as "unreadable" */
      }
      return row;
    })
    .sort((a, b) => b.bytes - a.bytes);
}

/**
 * Time one query against a socket that is already listening.
 *
 * Never spawns. `existsSync` is not proof the other end is alive — a socket file outlives the
 * process that bound it — so a refused connection is a normal answer here, not an error.
 */
export function probeSocket(sockPath, { slug, q = 'what did we decide', timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) return resolve({ ok: false, reason: 'no socket' });
    const started = process.hrtime.bigint();
    const c = net.createConnection(sockPath);
    const done = (v) => {
      try {
        c.destroy();
      } catch {
        /* already gone */
      }
      resolve(v);
    };
    const timer = setTimeout(
      () => done({ ok: false, reason: `no answer in ${timeoutMs}ms` }),
      timeoutMs,
    );
    let buf = '';
    c.on('connect', () => c.write(JSON.stringify({ q, k: 5, slug }) + '\n'));
    c.on('data', (d) => {
      buf += d;
    });
    c.on('end', () => {
      clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      let hits = null;
      try {
        hits = JSON.parse(buf)?.results?.length ?? null;
      } catch {
        /* a reply we cannot parse is still a timing */
      }
      done({ ok: true, ms, hits });
    });
    c.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, reason: e.code === 'ECONNREFUSED' ? 'socket file is orphaned' : e.code });
    });
  });
}

// `^(?=.)` and not `^`: indenting a blank line leaves trailing whitespace behind.
const section = (title, body) => `\n${title}\n${body.replace(/^(?=.)/gm, '  ')}\n`;

/**
 * The whole report, as one string.
 *
 * `activeModel` and `activeSlug` are what THIS project resolves to; everything else is
 * machine-wide on purpose — the cost being diagnosed is never confined to one repo.
 */
export async function report({
  state,
  activeModel,
  activeSlug,
  modelKeys = [],
  ps = readPs(),
} = {}) {
  const out = [];

  const servers = parseServers(ps);
  if (servers.length === 0) {
    out.push(section('search servers', 'none running — the next recall spawns one (~1.5s)'));
  } else {
    out.push(
      section(
        'search servers',
        table(
          ['pid', 'rss', 'uptime', 'state'],
          servers.map((s) => [s.pid, formatBytes(s.rss), s.elapsed, modelState(s.rss)]),
        ) +
          (servers.length > 1
            ? `\n\n${servers.length} servers are alive. One per MODEL is the design; more than that is` +
              ' the 16 GB failure mode — each holds its own copy of the weights.'
            : ''),
      ),
    );
  }

  const sock = path.join(state, 'run', `search-${activeModel}.sock`);
  const first = await probeSocket(sock, { slug: activeSlug });
  const second = first.ok ? await probeSocket(sock, { slug: activeSlug }) : null;
  out.push(
    section(
      'recall round trip',
      first.ok
        ? `${first.ms.toFixed(0)} ms first query, ${second.ms.toFixed(0)} ms second ` +
            `(${first.hits ?? '?'} hits, slug ${activeSlug})\n` +
            'A first query far above the second means the index for this slug was loaded on demand.'
        : `not measured: ${first.reason}\n` +
            'Nothing here starts a server. Run a prompt with recall armed, then re-run.',
    ),
  );

  const rows = indexStats(path.join(state, 'db'), modelKeys);
  out.push(
    section(
      'indexes',
      rows.length === 0
        ? 'none'
        : table(
            ['slug', 'model', 'size', 'chunks', 'notes', 'last indexed'],
            rows.map((r) => [
              r.slug + (r.slug === activeSlug ? ' *' : ''),
              r.model + (r.model === activeModel ? ' *' : ''),
              formatBytes(r.bytes),
              r.chunks ?? 'unreadable',
              r.notes ?? '-',
              r.mtime ? r.mtime.toISOString().slice(0, 16).replace('T', ' ') : '-',
            ]),
          ) +
            '\n\n* = this project / the active model. An index on another model is dead weight:' +
            '\n  every mode except --index refuses a model change. Delete it or re-index.',
    ),
  );

  const dirs = ['db', 'models', 'logs', 'run', 'eval', 'cache'];
  const usage = dirs.map((d) => [d, dirUsage(path.join(state, d))]);
  const total = usage.reduce((n, [, u]) => n + u.bytes, 0);
  out.push(
    section(
      `disk — ${state}`,
      table(
        ['dir', 'size', 'files'],
        usage
          .map(([d, u]) => [
            d + '/',
            u.missing ? '-' : formatBytes(u.bytes),
            u.missing ? '-' : u.files,
          ])
          .concat([['total', formatBytes(total), '']]),
      ),
    ),
  );

  return out.join('');
}

/** `ps` for every process on the machine. Failure is an empty listing, never a throw. */
export function readPs() {
  try {
    return execFileSync('ps', ['-Ao', 'pid=,rss=,etime=,command='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}
