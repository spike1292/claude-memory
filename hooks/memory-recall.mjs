#!/usr/bin/env node
// UserPromptSubmit: inject a small brief of relevant vault notes — or nothing at all.
//
// BOUNDED    at most MAX_NOTES notes and MAX_CHARS characters. A hint, not a dump.
// ABSTAINS   weak matches inject NOTHING. Silence beats noise: a wrong note costs more attention
//            than no note, and it teaches the reader to ignore the brief.
// OBSERVABLE every decision — inject or abstain, with the reason — appends one JSONL line, so the
//            abstention rate is measurable later instead of assumed.
// FAIL-OPEN  any error inside the try exits 0 silently. Recall must never break a prompt. The
//            static imports below are the exception and cannot be made to fail open: a missing
//            `node:sqlite` (Node < 22.5, or Bun) or a typo'd module path exits 1 with a stack
//            trace, which hooks.json's trailing `|| exit 0` masks into transcript noise rather
//            than a blocked prompt. Adding an import here adds one more of those.
//
// Why this exists: MEMORY.md is auto-loaded in full every session and grows without limit — the
// system's oldest open gap. Per-prompt retrieval is the alternative to loading everything always.
//
// Retrieval is the SAME ranking the CLI and the eval harness use — vector + keyword rank fusion —
// served by a resident process over a unix socket (~60ms). It used to be keyword-only, because
// loading model and index per prompt costs ~1540ms warm and ~3100ms cold; that is what the server
// exists to amortise. If the socket is missing or slow the hook spawns it for next time and answers
// this prompt from keyword search, so a prompt never waits on infrastructure.
//
// This file owns argv/stdin/stdout, the socket and `node:sqlite`, and nothing else. The gates, the
// ranking, the formatting and the log-record shapes live in hooks/lib/memory-recall.mjs with their
// tests — `node:sqlite` stays HERE precisely so that module can be imported by a test without one.
//
// That twin's own import graph must not reach scripts/lib/memory-semantic.mjs — the guard and the
// why are at hooks/lib/memory-recall.mjs:1, with docs/architecture.md B1 (~line 432) behind it.
// Anything that can fail belongs in an `await import()` in the try, like model-default.mjs below.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { appendJsonl, detach, logHook } from './lib/hook-io.mjs';
import { projectKey, stateDir, scriptsDir, recallEnabled } from './lib/paths.mjs';
import { CARD, MAX_NOTES, MIN_PROMPT, keywordArm, semanticArm } from './lib/memory-recall.mjs';

// Ships INERT. Injecting into every prompt changes how every session reads, so arming it is the
// user's call:  {"recall": true} in $CLAUDE_MEMORY_HOME/config.json, or MEMORY_RECALL_ENABLED=1.
if (!recallEnabled()) process.exit(0);

// One line per ARMED invocation, in the `hooks` family, beside the decision line this hook has
// always written in the `recall` family. Two lines because they answer two questions: the recall
// line is about retrieval quality, this one is about the hook as a hook — how long the whole
// process took against its 10 s timeout, and whether it reached a decision at all.
//
// Registered on `exit` rather than called at each return, because this file exits from four
// places and the paths that exit EARLIEST (a prompt below MIN_PROMPT, an unparseable payload) are
// exactly the ones no decision line covers. A disarmed session writes nothing at all: recall ships
// inert, and an inert feature must not cost every prompt of every user a file append.
/** @type {import('./lib/hook-io.mjs').HookOutcome} */
let outcome = 'ran';
/** @type {string | undefined} */
let hookReason;
/** @type {{ cwd?: string, session?: string, event?: string }} */
const ctx = {};
process.on('exit', () =>
  logHook({
    hook: 'memory-recall',
    event: ctx.event ?? '',
    cwd: ctx.cwd,
    session: ctx.session,
    outcome,
    reason: hookReason,
  }),
);

try {
  const raw = fs.readFileSync(0, 'utf8');
  const payload = JSON.parse(raw || '{}');
  const prompt = (payload.prompt || '').trim();
  const cwd = payload.cwd || process.cwd();
  ctx.cwd = cwd;
  ctx.session = payload.session_id;
  ctx.event = payload.hook_event_name;
  if (prompt.length < MIN_PROMPT) {
    hookReason = 'prompt shorter than MIN_PROMPT';
    process.exit(0);
  }

  const slug = projectKey(cwd);
  // Indexes are per-model, so the DB name depends on the active model. Recall reads chunk TEXT and
  // never the vectors, but the path must still resolve — and a missing DB exits 0 silently, so a
  // drifted default here would turn recall off with no error. Hence the shared constant.
  const { activeModel } = await import(
    // @ts-expect-error Node accepts a URL specifier for a dynamic import; TypeScript wants a string.
    new URL('../scripts/lib/model-default.mjs', import.meta.url)
  );
  const model = activeModel();
  const dbPath = path.join(stateDir('db'), `semantic-${slug}-${model}.db`);

  const runDir = stateDir('run');
  // The appender is shared with every other hook (hooks/lib/hook-io.mjs) and stamps `t` and `slug`;
  // everything after them is this record, in this order, unchanged since the log began. It swallows
  // its own errors — logging must never break the prompt either.
  const log = (/** @type {import('./lib/memory-recall.mjs').LogEntry} */ entry) => {
    hookReason = entry.abstained ? `abstained: ${entry.reason ?? ''}`.trim() : 'injected';
    appendJsonl('recall', cwd, {
      ...entry,
      // `performance.now()` is measured from process start, NOT from here, and that is the
      // point: a prompt waits for the whole process, so node's own startup and this file's
      // static import graph — ~40 ms of the budget — are inside the number. A clock started
      // at the top of this try would have excluded exactly the part nobody can see. Read it
      // against the 700 ms socket timeout, which it contains rather than sits beside.
      ms: +performance.now().toFixed(1),
    });
  };

  // The log is defined BEFORE the first exit on purpose. It used to sit after the missing-DB check,
  // so "the index moved and I have been switched off for six hours" and "no relevant notes" looked
  // identical — which is exactly what happened on 2026-08-15 when the DB filename gained a model
  // suffix. Fail-open is right; fail-open AND silent is not.
  if (!fs.existsSync(dbPath)) {
    log({ abstained: true, reason: 'no index at ' + path.basename(dbPath) });
    // NOT `ran`. This is the 2026-08-15 incident in the comment above — a model suffix appeared in
    // the DB filename and recall was silently off for six hours — and it is exactly what the
    // outcome set is for. As `ran` it would be a healthy column of thousands of invocations.
    outcome = 'noop-missing-dep';
    process.exit(0);
  }

  // MRR 0.158 keyword-only vs 0.547 via the resident server — why this hook talks to the socket
  // instead of staying on its own BM25 fallback.
  // Keyed by MODEL alone, not slug+model: CLAUDE.md ~line 204 has the why and the old
  // ~1.3GB-per-repo cost this replaced.
  const sockPath = path.join(runDir, `search-${model}.sock`);
  /** @typedef {{ results?: import('./lib/memory-recall.mjs').ServerHit[] | null } | null} ServerReply */
  /**
   * @param {string} q
   * @returns {Promise<ServerReply>}
   */
  const askServer = (q) =>
    new Promise((resolve) => {
      const done = (/** @type {ServerReply} */ v) => {
        try {
          c.destroy();
        } catch {}
        resolve(v);
      };
      const c = net.createConnection(sockPath);
      const timer = setTimeout(() => done(null), 700);
      let buf = '';
      c.on('connect', () => c.write(JSON.stringify({ q, k: MAX_NOTES, slug }) + '\n'));
      c.on('data', (d) => {
        buf += d;
      });
      c.on('end', () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buf));
        } catch {
          resolve(null);
        }
      });
      c.on('error', () => {
        clearTimeout(timer);
        done(null);
      });
    });

  const semantic = fs.existsSync(sockPath) ? await askServer(prompt) : null;
  // detach() is the shared contract — detached, stdio ignored, unref'd — and it swallows its own
  // failures, because keyword search still answers this prompt. It is safe above the try only
  // because hook-io.mjs imports nothing that can throw or print at module scope; see the header.
  if (!semantic)
    detach(process.execPath, [path.join(scriptsDir, 'memory-semantic.mjs'), '--serve'], { cwd });

  const fromServer = semanticArm(semantic?.results);
  if (fromServer) {
    log(fromServer.entry);
    if (fromServer.output) console.log(fromServer.output);
  } else {
    // Opened only once the server has failed to answer, and never closed — process exit collects it.
    const db = new DatabaseSync(dbPath);
    const cards = /** @type {import('./lib/memory-recall.mjs').Card[]} */ (
      /** @type {unknown} */ (
        db.prepare('SELECT note, layer, text FROM chunks WHERE heading = ?').all(CARD)
      )
    );

    const fromKeyword = keywordArm(cards, prompt);
    log(fromKeyword.entry);
    if (fromKeyword.output) console.log(fromKeyword.output);
  }
} catch (e) {
  outcome = 'error';
  // With no reason this line reads as "the hook threw", which is how a malformed payload — bad
  // input, not a fault — was being reported. The message is the only thing that tells them apart.
  hookReason = String(/** @type {Error} */ (e)?.message ?? e);
  process.exit(0); // fail-open, always
}
