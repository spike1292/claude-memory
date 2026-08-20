#!/usr/bin/env node
// SessionStart entry: name the L1 notes reachable only from the MOC.
//
// Thin on purpose: stdin, cwd, stdout. Logic and tests live in lib/memory-link-lint.mjs.
// hooks.json points at this path, so it is a contract — keep it.
import { readStdin, payload, hookCwd } from './lib/hook-io.mjs';
import { lint } from './lib/memory-link-lint.mjs';

// readStdin() and not `new Response(process.stdin)` — the web-streams path costs ~18 ms of runtime
// bootstrap per hook. See docs/decisions/2026-08-20-hook-startup-cost.md.
const cwd = hookCwd(payload(readStdin()));

// A SessionStart hook must never break a session.
try {
  const text = lint(cwd);
  if (text) console.log(text);
} catch {
  /* best effort, by design */
}
