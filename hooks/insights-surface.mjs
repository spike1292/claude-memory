#!/usr/bin/env node
// SessionStart entry: surface recent L3 Mistakes titles so past errors actually reach context.
// The vault Insights layer is write-heavy but not auto-loaded (unlike MEMORY.md); this closes the
// gap. Titles only — cheap; full lessons stay in the vault / via /memory:health.
//
// Thin on purpose: stdin, cwd, stdout. All logic and every test live in lib/insights-surface.mjs,
// which imports cleanly and needs no subprocess to exercise. hooks.json points here, so this path
// is a contract — keep it.
import { readStdin, payload, hookCwd } from './lib/hook-io.mjs';
import { surface } from './lib/insights-surface.mjs';

// readStdin() and not `new Response(process.stdin)`: the web-streams path costs ~18 ms of runtime
// bootstrap per hook against ~0.5 ms for one readFileSync(0) — a third of this hook's whole wall
// time, paid to parse a 100-byte payload. Measured 2026-08-20,
// docs/decisions/2026-08-20-hook-startup-cost.md.
const cwd = hookCwd(payload(readStdin()));

// A SessionStart hook must never break a session.
try {
  const text = surface(cwd);
  if (text) console.log(text);
} catch {
  /* best effort, by design */
}
