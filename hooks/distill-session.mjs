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
  // WORKER. It logs its own line rather than being wrapped by a supervisor process: the gate's
  // duration is a decision and this one is the distillation, and `process.on('exit')` catches every
  // way this process can end short of a signal — including a throw, which exits non-zero.
  /** @type {import('./lib/hook-io.mjs').HookOutcome} */
  let outcome = 'error';
  /** @type {string | undefined} */
  let reason;
  process.on('exit', () =>
    logHook({
      hook: 'distill-session',
      event: 'worker',
      cwd: argv[1],
      session: process.env.MEMORY_HOOK_SESSION,
      outcome,
      reason,
    }),
  );
  let r;
  try {
    r = distill(argv[0], argv[1]);
  } catch (e) {
    // Caught only to RECORD it, then rethrown: the exit code and the stack in distill.log are
    // unchanged. Without this an `error` row printed no reason at all, in the same report round
    // that added the reason column so an error row could be read.
    reason = String(/** @type {Error} */ (e)?.message ?? e);
    throw e;
  }
  outcome = 'ran';
  reason = r ? `wrote ${r.written}, merged ${r.merged}` : 'nothing to distil';
  if (r)
    console.log(
      `distill: wrote ${r.written} note(s), merged ${r.merged} into existing, for ${r.slug}`,
    );
} else if (argv.length === 1) {
  console.error('usage: distill-session.mjs <transcript> <cwd>   (or no args to gate on stdin)');
  process.exit(1);
} else {
  // GATE only. The worker half above writes the second line itself — same session id, carried in
  // MEMORY_HOOK_SESSION, and a duration that is the distillation rather than this decision.
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
