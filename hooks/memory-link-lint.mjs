#!/usr/bin/env node
// SessionStart entry: name the L1 notes reachable only from the MOC.
//
// Thin on purpose: stdin, cwd, stdout. Logic and tests live in lib/memory-link-lint.mjs.
// hooks.json points at this path, so it is a contract — keep it.
import { lint } from './lib/memory-link-lint.mjs';

let cwd = process.cwd();
try {
  // @ts-expect-error Node's Response accepts a Readable; the DOM BodyInit type does not.
  const j = JSON.parse(await new Response(process.stdin).text());
  if (j?.cwd) cwd = j.cwd;
} catch {
  /* no payload — fall back to cwd */
}

// A SessionStart hook must never break a session.
try {
  const text = lint(cwd);
  if (text) console.log(text);
} catch {
  /* best effort, by design */
}
