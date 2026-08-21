#!/usr/bin/env node
// PostToolUse entry: warn (never block) when a written vault note breaks the conventions.
//
// Thin on purpose: stdin, file path, stdout. Logic and tests live in lib/validate-note.mjs.
// hooks.json points at this path, so it is a contract — keep it.
import { readStdin, payload, hookCwd, logHook } from './lib/hook-io.mjs';
import { report } from './lib/validate-note.mjs';

// readStdin() and not `new Response(process.stdin)`. This is the hottest hook in the system — it
// runs on every Write/Edit — and the web-streams path cost it ~18 ms of runtime bootstrap before
// it had even looked at the payload, against ~0.5 ms for one readFileSync(0). Measured
// 2026-08-20, docs/decisions/2026-08-20-hook-startup-cost.md.
const j = payload(readStdin());
const file = String(j?.tool_input?.file_path || j?.tool_input?.path || '');

// A hook must never fail a write.
/** @type {import('./lib/hook-io.mjs').HookOutcome} */
let outcome = 'ran';
/** @type {string | undefined} */
let reason = file ? undefined : 'no file path in payload';
if (file) {
  try {
    const text = report(file);
    if (text) console.log(text);
    reason = text ? 'warned' : 'clean';
  } catch (e) {
    outcome = 'error';
    reason = String(/** @type {Error} */ (e)?.message ?? e);
  }
}

// The hottest hook in the system — one line per Write/Edit, so the log grows fastest here. That is
// also why it is the one whose duration is worth watching: the same ~18 ms that mattered enough to
// change how stdin is read is a fifth of this hook's budget.
logHook({
  hook: 'validate-note',
  event: String(j.hook_event_name ?? ''),
  cwd: hookCwd(j),
  session: /** @type {string|undefined} */ (j.session_id),
  outcome,
  reason,
});
