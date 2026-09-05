// The adopt/rollback state machine for /memory:adopt (#96), the only path that writes to
// `permanent/`. `io` is injected so the gate — a held-out eval run shelling out to
// memory-eval.mjs — is testable without a subprocess or a real vault.
// CLI entry: scripts/memory-adopt.mjs. Tests: node --test scripts/lib/memory-adopt.test.mjs

/**
 * Undrafted skeleton, drafted into the permanent shape, or neither — read off the frontmatter
 * `type:` line only, since matching the placeholder PROSE would break on a note quoting its own
 * history.
 * @param {string} raw
 * @returns {'undrafted' | 'ready' | 'wrong-type'}
 */
export function checkDraftStatus(raw) {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  if (/^type:[ \t]*promotion-candidate[ \t]*$/m.test(fm)) return 'undrafted';
  if (/^type:[ \t]*permanent[ \t]*$/m.test(fm)) return 'ready';
  return 'wrong-type';
}

/** @typedef {{ failures: string[], recall1?: number | null, frozen?: string | null }} GateResult */
/** @typedef {{ readFile: (p: string) => string, writeFile: (p: string, s: string) => void, removeFile: (p: string) => void, exists: (p: string) => boolean, reindex: () => void, runGate: () => GateResult }} AdoptIO */
/** @typedef {{ stagedPath: string, targetPath: string, dryRun: boolean, force: boolean }} AdoptOpts */
/** @typedef {{ status: 'undrafted' | 'wrong-type' | 'exists' | 'dry-run' | 'rejected' | 'adopted', reasons?: string[], recall1?: number | null, frozen?: string | null }} AdoptResult */

/**
 * Copy staged -> permanent/, reindex, run the held-out gate, roll back on failure. A rejected
 * proposal keeps its staged file so it can be fixed and retried.
 * @param {AdoptIO} io
 * @param {AdoptOpts} opts
 * @returns {AdoptResult}
 */
export function adopt(io, opts) {
  const raw = io.readFile(opts.stagedPath);
  const draft = checkDraftStatus(raw);
  if (draft === 'undrafted') return { status: 'undrafted' };
  if (draft === 'wrong-type') return { status: 'wrong-type' };
  const targetExisted = io.exists(opts.targetPath);
  if (targetExisted && !opts.force) return { status: 'exists' };
  if (opts.dryRun) return { status: 'dry-run' };
  // --force overwrites an existing permanent/ note; a rejected gate must restore it, not delete
  // it, or a failed re-draft of an already-adopted topic loses the note that was there before.
  const previous = targetExisted ? io.readFile(opts.targetPath) : null;

  io.writeFile(opts.targetPath, raw);
  io.reindex();
  const gate = io.runGate();
  if (gate.failures.length) {
    if (previous == null) io.removeFile(opts.targetPath);
    else io.writeFile(opts.targetPath, previous);
    io.reindex();
    return { status: 'rejected', reasons: gate.failures };
  }
  io.removeFile(opts.stagedPath);
  return { status: 'adopted', recall1: gate.recall1 ?? null, frozen: gate.frozen ?? null };
}
