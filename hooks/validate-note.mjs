#!/usr/bin/env node
// PostToolUse entry: warn (never block) when a written vault note breaks the conventions.
//
// Thin on purpose: stdin, file path, stdout. Logic and tests live in lib/validate-note.mjs.
// hooks.json points at this path, so it is a contract — keep it.
import { readStdin, payload } from './lib/hook-io.mjs';
import { report } from './lib/validate-note.mjs';

// readStdin() and not `new Response(process.stdin)`. This is the hottest hook in the system — it
// runs on every Write/Edit — and the web-streams path cost it ~18 ms of runtime bootstrap before
// it had even looked at the payload, against ~0.5 ms for one readFileSync(0). Measured
// 2026-08-20, docs/decisions/2026-08-20-hook-startup-cost.md.
const j = payload(readStdin());
const file = String(j?.tool_input?.file_path || j?.tool_input?.path || '');

// A hook must never fail a write.
if (file) {
  try {
    const text = report(file);
    if (text) console.log(text);
  } catch {
    /* best effort, by design */
  }
}
