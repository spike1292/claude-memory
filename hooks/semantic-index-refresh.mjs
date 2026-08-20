#!/usr/bin/env node
// SessionStart entry: refresh the semantic vault index in the background.
//
// Thin on purpose: stdin in, nothing out. Logic and tests live in lib/semantic-index-refresh.mjs.
import { readStdin, payload, hookCwd, logHook } from './lib/hook-io.mjs';
import { outcomeOf, refresh } from './lib/semantic-index-refresh.mjs';

const p = payload(readStdin());
const cwd = hookCwd(p);
const session = /** @type {string|undefined} */ (p.session_id);

// This is a GATE: it decides and detaches, so the line below times the decision, never the
// re-index. The re-index writes its own line under the same session id, from log-worker.mjs.
const plan = refresh(cwd, new Date(), session);
logHook({
  hook: 'semantic-index-refresh',
  event: String(p.hook_event_name ?? ''),
  cwd,
  session,
  outcome: outcomeOf(plan),
  reason: plan.run ? plan.slug : plan.reason,
});
