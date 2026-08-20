#!/usr/bin/env node
// SessionStart entry: surface recent L3 Mistakes titles so past errors actually reach context.
// The vault Insights layer is write-heavy but not auto-loaded (unlike MEMORY.md); this closes the
// gap. Titles only — cheap; full lessons stay in the vault / via /memory:health.
//
// Thin on purpose: stdin, cwd, stdout. All logic and every test live in lib/insights-surface.mjs,
// which imports cleanly and needs no subprocess to exercise. hooks.json points here, so this path
// is a contract — keep it.
import { surface } from './lib/insights-surface.mjs';

let cwd = process.cwd();
try {
  // @ts-expect-error Node's Response accepts a Readable; the DOM BodyInit type does not.
  const j = JSON.parse(await new Response(process.stdin).text());
  if (j?.cwd) cwd = j.cwd;
} catch {
  /* no payload — fall back to cwd, as the shell version did */
}

// A SessionStart hook must never break a session.
try {
  const text = surface(cwd);
  if (text) console.log(text);
} catch {
  /* best effort, by design */
}
