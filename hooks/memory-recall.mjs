#!/usr/bin/env node
// UserPromptSubmit: inject a small brief of relevant vault notes — or nothing at all.
//
// BOUNDED    at most MAX_NOTES notes and MAX_CHARS characters. A hint, not a dump.
// ABSTAINS   weak matches inject NOTHING. Silence beats noise: a wrong note costs more attention
//            than no note, and it teaches the reader to ignore the brief.
// OBSERVABLE every decision — inject or abstain, with the reason — appends one JSONL line, so the
//            abstention rate is measurable later instead of assumed.
// FAIL-OPEN  any error exits 0 silently. Recall must never break a prompt.
//
// Why this exists: MEMORY.md is auto-loaded in full every session and grows without limit — the
// system's oldest open gap. Per-prompt retrieval is the alternative to loading everything always.
//
// Retrieval is the SAME ranking the CLI and the eval harness use — vector + keyword rank fusion —
// served by a resident process over a unix socket (~60ms). It used to be keyword-only, because
// loading model and index per prompt costs ~1540ms warm and ~3100ms cold; that is what the server
// exists to amortise. If the socket is missing or slow the hook spawns it for next time and answers
// this prompt from keyword search, so a prompt never waits on infrastructure.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { projectKey, stateDir, scriptsDir, memoryHome } from './lib/paths.mjs';

const MAX_NOTES = 4;
const MAX_CHARS = 900;   // ~250 tokens
const MIN_SCORE = 6.0;   // below this the top hit is not worth the reader's attention
const MIN_PROMPT = 25;   // one-word prompts have no retrievable intent

const STOP = new Set('the a an and or of to in on for is are was were it its this that with as by at from be not you your we our they them if then when what which how why do does did can could should would use used using via no yes into over under more most less least than each per also only just same other about with have has had will'.split(' '));

// Ships INERT. Injecting into every prompt changes how every session reads, so arming it is the
// user's call. Two ways to arm it, and the FILE is the one that reliably works: `env` in
// settings.local.json does not reach hook subprocesses, so MEMORY_RECALL_ENABLED alone left this
// hook silently disabled (found 2026-08-15 — it had not fired once since being packaged).
//   touch "$CLAUDE_MEMORY_HOME/recall-enabled"      # or MEMORY_RECALL_ENABLED=1
const armed = process.env.MEMORY_RECALL_ENABLED === '1'
  || fs.existsSync(path.join(memoryHome(), 'recall-enabled'));
if (!armed) process.exit(0);

try {
  const raw = fs.readFileSync(0, 'utf8');
  const payload = JSON.parse(raw || '{}');
  const prompt = (payload.prompt || '').trim();
  const cwd = payload.cwd || process.cwd();
  if (prompt.length < MIN_PROMPT) process.exit(0);

  const slug = projectKey(cwd);
  // Indexes are per-model, so the DB name depends on the active model. Recall reads chunk TEXT and
  // never the vectors, but the path must still resolve — and a missing DB exits 0 silently, so a
  // drifted default here would turn recall off with no error. Hence the shared constant.
  const { activeModel } = await import(new URL('../scripts/lib/model-default.mjs', import.meta.url));
  const model = activeModel();
  const dbPath = path.join(stateDir('db'), `semantic-${slug}-${model}.db`);

  const logDir = stateDir('logs');
  const runDir = stateDir('run');
  const log = (entry) => {
    try {
      fs.appendFileSync(path.join(logDir, `recall-${new Date().toISOString().slice(0, 10)}.jsonl`),
        JSON.stringify({ t: new Date().toISOString(), slug, ...entry }) + '\n');
    } catch { /* logging must never break the prompt either */ }
  };

  // The log is defined BEFORE the first exit on purpose. It used to sit after the missing-DB check,
  // so "the index moved and I have been switched off for six hours" and "no relevant notes" looked
  // identical — which is exactly what happened on 2026-08-15 when the DB filename gained a model
  // suffix. Fail-open is right; fail-open AND silent is not.
  if (!fs.existsSync(dbPath)) { log({ abstained: true, reason: 'no index at ' + path.basename(dbPath) }); process.exit(0); }

  // Resident search server: same ranking as the CLI and the eval harness (vector + keyword rank
  // fusion), 60ms instead of the ~1540ms it costs to load model and index per prompt. That cost is
  // why this hook was stuck on its own keyword-only search, at MRR 0.158 against the full path's
  // 0.547. If the socket is absent or slow, spawn it for NEXT time and fall through to keyword —
  // a prompt must never wait on it.
  const sockPath = path.join(runDir, `search-${slug}-${model}.sock`);
  const askServer = (q) => new Promise((resolve) => {
    const done = (v) => { try { c.destroy(); } catch {} resolve(v); };
    const c = net.createConnection(sockPath);
    const timer = setTimeout(() => done(null), 700);
    let buf = '';
    c.on('connect', () => c.write(JSON.stringify({ q, k: MAX_NOTES }) + '\n'));
    c.on('data', (d) => { buf += d; });
    c.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    c.on('error', () => { clearTimeout(timer); done(null); });
  });

  const semantic = fs.existsSync(sockPath) ? await askServer(prompt) : null;
  if (!semantic) {
    // Detached, stdio ignored, unref'd: this process must be free to exit immediately.
    try {
      spawn(process.execPath, [path.join(scriptsDir, 'memory-semantic.mjs'), '--serve'],
        { cwd, detached: true, stdio: 'ignore' }).unref();
    } catch { /* best effort; keyword search still answers this prompt */ }
  }

  if (semantic?.results?.length) {
    // Cosine needs its own gate — MIN_SCORE below is BM25-scaled and means nothing here. Calibrated
    // 2026-08-15 on 5 on-topic and 5 deliberately off-topic prompts: on-topic 0.495-0.736, off-topic
    // 0.351-0.506. The bands OVERLAP, so no threshold is clean; 0.55 rejects all 5 off-topic and
    // admits 4 of 5 on-topic. Erring toward silence is the design rule. Sample is 10 prompts — treat
    // it as a starting point, and read the abstain rate in the log rather than trusting this number.
    const MIN_COS = 0.55;
    const hits = semantic.results.filter((r) => r.score >= MIN_COS).slice(0, MAX_NOTES);
    if (!hits.length) {
      log({ abstained: true, reason: 'low confidence (semantic)', top: semantic.results[0]?.note, score: semantic.results[0]?.score, via: 'server' });
      process.exit(0);
    }
    const lines = [];
    let used = 0;
    for (const r of hits) {
      const first = (r.text ?? '').split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
      const line = `- [[${r.note}]] (${r.layer}): ${first.slice(0, 150)}`;
      if (used + line.length > MAX_CHARS) break;
      lines.push(line); used += line.length;
    }
    if (lines.length) {
      log({ abstained: false, injected: lines.length, chars: used, top: hits[0].note, score: hits[0].score, via: 'server', stale: semantic.stale });
      console.log(`Possibly relevant vault notes (retrieved, not verified — open one before relying on it):\n${lines.join('\n')}`);
      process.exit(0);
    }
  }

  const db = new DatabaseSync(dbPath);
  const cards = db.prepare("SELECT note, layer, text FROM chunks WHERE heading = '(card)'").all();
  if (!cards.length) { log({ abstained: true, reason: 'empty index' }); process.exit(0); }

  const toks = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
  const qt = [...new Set(toks(prompt))];
  if (!qt.length) { log({ abstained: true, reason: 'no content words' }); process.exit(0); }

  const docs = cards.map((c) => ({ ...c, toks: toks(c.text) }));
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  const avgdl = docs.reduce((a, d) => a + d.toks.length, 0) / docs.length;
  const N = docs.length;

  const scored = docs.map((d) => {
    const tf = new Map();
    for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of qt) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const n = df.get(t) || 0;
      s += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.toks.length / avgdl));
    }
    return { note: d.note, layer: d.layer, text: d.text, s };
  }).sort((a, b) => b.s - a.s);

  if (!scored.length || scored[0].s < MIN_SCORE) {
    log({ abstained: true, reason: 'low confidence', top: scored[0]?.note ?? null, score: +(scored[0]?.s ?? 0).toFixed(2) });
    process.exit(0);
  }

  const lines = [];
  let used = 0;
  for (const r of scored.slice(0, MAX_NOTES)) {
    if (r.s < MIN_SCORE / 2) break; // trailing weak hits add noise, not context
    const first = r.text.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
    const line = `- [[${r.note}]] (${r.layer}): ${first.slice(0, 150)}`;
    if (used + line.length > MAX_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) { log({ abstained: true, reason: 'budget' }); process.exit(0); }

  log({ abstained: false, injected: lines.length, chars: used, top: scored[0].note, score: +scored[0].s.toFixed(2) });
  console.log(`Possibly relevant vault notes (retrieved, not verified — open one before relying on it):\n${lines.join('\n')}`);
} catch {
  process.exit(0); // fail-open, always
}
