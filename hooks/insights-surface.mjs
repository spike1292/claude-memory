#!/usr/bin/env node
// SessionStart entry: surface recent L3 Mistakes titles so past errors actually reach context.
// The vault Insights layer is write-heavy but not auto-loaded (unlike MEMORY.md); this closes the
// gap. Titles only — cheap; full lessons stay in the vault / via /memory:health.
//
// Thin on purpose: stdin, cwd, stdout. All logic and every test live in lib/insights-surface.mjs,
// which imports cleanly and needs no subprocess to exercise. hooks.json points here, so this path
// is a contract — keep it.
import { readStdin, payload, hookCwd, logHook } from './lib/hook-io.mjs';
import { surface } from './lib/insights-surface.mjs';

// readStdin() and not `new Response(process.stdin)`: the web-streams path costs ~18 ms of runtime
// bootstrap per hook against ~0.5 ms for one readFileSync(0) — a third of this hook's whole wall
// time, paid to parse a 100-byte payload. Measured 2026-08-20,
// docs/decisions/2026-08-20-hook-startup-cost.md.
const p = payload(readStdin());
const cwd = hookCwd(p);

// A SessionStart hook must never break a session.
/** @type {import('./lib/hook-io.mjs').HookOutcome} */
let outcome = 'ran';
/** @type {string | undefined} */
let reason;
try {
  const text = surface(cwd);
  if (text) console.log(text);
  reason = text ? 'surfaced' : 'nothing to surface';
} catch (e) {
  outcome = 'error';
  reason = String(/** @type {Error} */ (e)?.message ?? e);
}

// Last, so the duration covers the work — and outside the try for the same reason the catch is
// there: the log is best-effort, and logHook swallows its own failures.
logHook({
  hook: 'insights-surface',
  event: String(p.hook_event_name ?? ''),
  cwd,
  session: /** @type {string|undefined} */ (p.session_id),
  outcome,
  reason,
});
