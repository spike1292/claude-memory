#!/usr/bin/env node
// PostToolUse entry: warn (never block) when a written vault note breaks the conventions.
//
// Thin on purpose: stdin, file path, stdout. Logic and tests live in lib/validate-note.mjs.
// hooks.json points at this path, so it is a contract — keep it.
import { report } from './lib/validate-note.mjs';

let file = '';
try {
  const j = JSON.parse(await new Response(process.stdin).text());
  file = j?.tool_input?.file_path || j?.tool_input?.path || '';
} catch {
  /* no or unparsable payload — nothing to check */
}

// A hook must never fail a write.
if (file) {
  try {
    const text = report(file);
    if (text) console.log(text);
  } catch {
    /* best effort, by design */
  }
}
