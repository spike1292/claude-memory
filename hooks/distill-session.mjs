#!/usr/bin/env node
// SessionEnd + Stop entry. Two modes, one file:
//
//   no argv  -> GATE. Reads the hook payload on stdin, decides, and detaches the worker below.
//   argv     -> WORKER. Distils one transcript into Obsidian Insight notes.
//
// The gate re-invokes this same path, so the argv form is a contract — keep it.
import { readStdin, payload, hookCwd, logHook } from './lib/hook-io.mjs';
import { distill, gate, gateOutcome } from './lib/distill-session.mjs';

const argv = process.argv.slice(2);

if (argv.length >= 2) {
  const r = distill(argv[0], argv[1]);
  if (r)
    console.log(
      `distill: wrote ${r.written} note(s), merged ${r.merged} into existing, for ${r.slug}`,
    );
} else if (argv.length === 1) {
  console.error('usage: distill-session.mjs <transcript> <cwd>   (or no args to gate on stdin)');
  process.exit(1);
} else {
  // GATE only. The worker half above is spawned under hooks/log-worker.mjs, which writes the
  // second line — same session id, and a duration that is the distillation rather than this
  // decision.
  const p = payload(readStdin());
  const plan = gate(p);
  logHook({
    hook: 'distill-session',
    event: String(p.hook_event_name ?? ''),
    cwd: hookCwd(p),
    session: /** @type {string|undefined} */ (p.session_id),
    outcome: gateOutcome(plan),
    reason: plan.run ? `${plan.lines} lines` : plan.reason,
  });
}
