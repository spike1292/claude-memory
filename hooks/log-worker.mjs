#!/usr/bin/env node
// NOT a Claude Code hook — nothing in hooks.json points here. This is the supervisor that
// `detach({ worker })` puts in front of background work so the WORKER gets a log line, not just
// the gate that spawned it.
//
// Three hooks detach and exit immediately (distill-session, semantic-index-refresh,
// graph-staleness-check), so their own elapsed time measures a decision, never the work. One of
// the three hands its work to the `claude` binary, which cannot be instrumented from the inside;
// a supervisor is the one mechanism that covers all three the same way.
//
// It must be transparent: stdio is inherited (the caller already pointed it at the right log file),
// the environment is inherited, and the exit code is passed through. A bug here breaks
// distillation and graph regeneration, so every failure below degrades to "run the child anyway".
//
// Usage: log-worker.mjs '<json>' <cmd> [args...]   — the JSON carries hook, cwd and session id.
import { spawn } from 'node:child_process';
import { logHook } from './lib/hook-io.mjs';

const [spec, cmd, ...args] = process.argv.slice(2);

/** @type {{ hook?: string, cwd?: string, session?: string }} */
let w = {};
try {
  w = JSON.parse(spec || '{}') || {};
} catch {
  /* an unreadable spec costs a log line, never the run */
}

if (!cmd) process.exit(0);

/**
 * @param {import('./lib/hook-io.mjs').HookOutcome} outcome
 * @param {string} [reason]
 * @param {number} [code]
 */
const done = (outcome, reason, code = 0) => {
  logHook({
    hook: w.hook || 'unknown',
    event: 'worker',
    cwd: w.cwd,
    session: w.session,
    outcome,
    reason,
  });
  process.exit(code);
};

/**
 * A spawn failure has to reach BOTH places. stderr here is the caller's log file — distill.log or
 * graphgen.log — inherited, so this is the banner `detach()` used to write when it watched the real
 * command itself; someone reading that file must not find a gate that said "spawned" and then
 * nothing. The JSONL line is for the report.
 *
 * @param {string} message
 */
const failed = (message) => {
  console.error(`\n=== ${new Date().toISOString()} ${message} ===`);
  done('error', message, 1);
};

// spawn() throws SYNCHRONOUSLY on a malformed argument — a NUL byte in the command, a non-string
// arg — and reports a missing binary ASYNCHRONOUSLY. Both have to be caught: the synchronous half
// would take this process down before either record was written, leaving the gate's `spawned` line
// as the last word on a run that never happened. `failed()` exits, so nothing below it runs in
// that case.
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
try {
  child = spawn(cmd, args, { cwd: w.cwd, stdio: 'inherit' });
} catch (e) {
  failed(`spawn failed: ${String(/** @type {Error} */ (e)?.message ?? e)}`);
}

child?.on('error', (e) => failed(`spawn failed: ${e.message}`));
child?.on('exit', (code, signal) =>
  code === 0
    ? done('ran')
    : done('error', signal ? `killed by ${signal}` : `exit ${code}`, code ?? 1),
);
