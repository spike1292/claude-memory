#!/usr/bin/env node
// SessionStart entry: name the L1 notes reachable only from the MOC, and once a day the duplicate pairs.
//
// Thin on purpose: stdin, cwd, stdout, and the index handle. Logic and tests live in lib/.
// hooks.json points at this path, so it is a contract — keep it.
import { readStdin, payload, hookCwd, logHook } from './lib/hook-io.mjs';
import { lint } from './lib/memory-link-lint.mjs';
import { DatabaseSync } from 'node:sqlite';
import { dupeReport } from './lib/dupe-report.mjs';
import { CARD } from '../scripts/lib/lexical.mjs';

/** @typedef {import('./lib/dupe-report.mjs').CardRow} CardRow */
/** @type {import('./lib/dupe-report.mjs').ReadIndex} */
const readIndex = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const meta = /** @type {{ value?: string } | undefined} */ (
      db.prepare("SELECT value FROM meta WHERE key = 'model'").get()
    );
    const rows = db
      .prepare('SELECT note, layer, file, vec FROM chunks WHERE heading = ?')
      .all(CARD);
    return { model: meta?.value, rows: /** @type {CardRow[]} */ (/** @type {unknown} */ (rows)) };
  } finally {
    db.close();
  }
};

// readStdin() and not `new Response(process.stdin)` — the web-streams path costs ~18 ms of runtime
// bootstrap per hook. See docs/decisions/2026-08-20-hook-startup-cost.md.
const p = payload(readStdin());
const cwd = hookCwd(p);

// A SessionStart hook must never break a session.
/** @type {import('./lib/hook-io.mjs').HookOutcome} */
let outcome = 'ran';
/** @type {string | undefined} */
let reason;
/** @type {Record<string, number> | undefined} */
let extra;
try {
  const text = [lint(cwd), await dupeReport(cwd, readIndex)].filter(Boolean).join('\n\n');
  if (text) console.log(text);
  reason = text ? 'reported' : 'nothing to report';
  // What this hook COSTS the session, in bytes of context window. Omitted rather than logged as 0
  // when it injects nothing, so "injected nothing" and "was not measuring yet" stay distinguishable
  // — a week of older log files sits in the reader's window.
  if (text) extra = { bytes: Buffer.byteLength(text) };
} catch (e) {
  outcome = 'error';
  reason = String(/** @type {Error} */ (e)?.message ?? e);
}

// This hook is the one whose cost depends on the vault: 74 ms in this repo, 10.9 s on a 49-note
// project, against a 10 s timeout. Its duration is the reason the log exists.
logHook({
  hook: 'memory-link-lint',
  event: String(p.hook_event_name ?? ''),
  cwd,
  session: /** @type {string|undefined} */ (p.session_id),
  outcome,
  reason,
  extra,
});
