// The adopt/rollback state machine for /memory:adopt (#96): the ONLY path that writes to
// `permanent/`. Every mutation is injected as an `io` function, so the gate — a held-out eval run
// that shells out to memory-eval.mjs — is testable without spawning a subprocess or touching a real
// vault, the same seam memory-eval.mjs's own scoring functions use.
//
// Logic half; the CLI entry is scripts/memory-adopt.mjs.
// Tests: node --test scripts/lib/memory-adopt.test.mjs

/**
 * A note is still the /memory:synthesize skeleton, already drafted into the permanent shape, or
 * neither. Read off the frontmatter `type:` line only — matching the placeholder PROSE would break
 * the moment a drafted note quotes its own history.
 *
 * @param {string} raw
 * @returns {'undrafted' | 'ready' | 'wrong-type'}
 */
export function checkDraftStatus(raw) {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  if (/^type:[ \t]*promotion-candidate[ \t]*$/m.test(fm)) return 'undrafted';
  if (/^type:[ \t]*permanent[ \t]*$/m.test(fm)) return 'ready';
  return 'wrong-type';
}

/** @typedef {{ failures: string[] }} GateResult */
/**
 * @typedef {{
 *   readFile: (p: string) => string,
 *   writeFile: (p: string, s: string) => void,
 *   removeFile: (p: string) => void,
 *   exists: (p: string) => boolean,
 *   reindex: () => void,
 *   runGate: () => GateResult,
 * }} AdoptIO
 */

/**
 * @typedef {{ stagedPath: string, targetPath: string, dryRun: boolean, force: boolean }} AdoptOpts
 * @typedef {{ status: 'undrafted' | 'wrong-type' | 'exists' | 'dry-run' | 'rejected' | 'adopted', reasons?: string[] }} AdoptResult
 */

/**
 * Copy staged -> permanent/, reindex, run the held-out gate, and roll back on failure. Nothing
 * written to `permanent/` survives a failing gate; nothing removed from Staging/ survives one
 * either, so a rejected proposal can be fixed and retried.
 *
 * @param {AdoptIO} io
 * @param {AdoptOpts} opts
 * @returns {AdoptResult}
 */
export function adopt(io, opts) {
  const raw = io.readFile(opts.stagedPath);
  const draft = checkDraftStatus(raw);
  if (draft === 'undrafted') return { status: 'undrafted' };
  if (draft === 'wrong-type') return { status: 'wrong-type' };
  if (io.exists(opts.targetPath) && !opts.force) return { status: 'exists' };
  if (opts.dryRun) return { status: 'dry-run' };

  io.writeFile(opts.targetPath, raw);
  io.reindex();
  const gate = io.runGate();
  if (gate.failures.length) {
    io.removeFile(opts.targetPath);
    io.reindex();
    return { status: 'rejected', reasons: gate.failures };
  }
  io.removeFile(opts.stagedPath);
  return { status: 'adopted' };
}
