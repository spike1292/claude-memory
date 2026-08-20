#!/usr/bin/env node
// SessionStart entry: nudge or regenerate a stale codebase graph report.
//
// Thin on purpose: stdin in, at most one JSON line out. Logic and tests live in
// lib/graph-staleness-check.mjs.
import { readStdin, payload, hookCwd, logHook } from './lib/hook-io.mjs';
import { check } from './lib/graph-staleness-check.mjs';

const p = payload(readStdin());
const cwd = hookCwd(p);
const session = /** @type {string|undefined} */ (p.session_id);

// A GATE, and the one detached hook with no worker line: the pid in graphgen.lock has to be the
// `claude` process itself, or a dead supervisor would free the lock while the work ran on. See
// lib/graph-staleness-check.mjs's check().
const r = check(cwd);
if (r.line) console.log(r.line);
logHook({
  hook: 'graph-staleness-check',
  event: String(p.hook_event_name ?? ''),
  cwd,
  session,
  outcome: r.outcome,
  reason: r.reason,
});
