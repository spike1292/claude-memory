#!/usr/bin/env node
// Apply a reviewed /memory:synthesize draft from Staging/<slug>/ into permanent/ — the ONLY path
// that writes there (#96). Gated on a held-out case set (#87/#126) so a promotion cannot ship a
// number fitted to the questions that motivated it.
//
// Usage:
//   node memory-adopt.mjs <staged-note-name> --min-rank1 <percent> [--cases <path>]
//   node memory-adopt.mjs <staged-note-name> --dry-run
//   node memory-adopt.mjs <staged-note-name> --min-rank1 <percent> --force   # overwrite an existing note
//   [--vault <dir>] [--slug <slug>] to point at a synthetic vault instead of the real one.
//
// Entry only: argv, fs, subprocess. The accept/rollback state machine and its tests live in
// lib/memory-adopt.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as paths from '../hooks/lib/paths.mjs';
import { resolveNote } from './lib/memory-mark.mjs';
import { adopt } from './lib/memory-adopt.mjs';

const argv = process.argv.slice(2);
const flag = (/** @type {string} */ n) => argv.includes(n);
const val = (/** @type {string} */ n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};
const name = argv.find((a) => !a.startsWith('--'));
if (!name) {
  console.error(
    'usage: memory-adopt.mjs <staged-note-name> --min-rank1 <percent> [--dry-run] [--force]\n' +
      '  [--cases <path>] [--vault <dir>] [--slug <slug>]',
  );
  process.exit(1);
}

const VAULT = val('--vault') || paths.vault();
const SLUG = val('--slug') || paths.projectKey(process.cwd());
const dryRun = flag('--dry-run');
const force = flag('--force');
const minRank1 = val('--min-rank1');
// A real adopt with no floor is how #96 shipped a promotion gain fitted to its own questions —
// --dry-run is the only path that skips the gate, because it writes nothing to score.
if (!dryRun && !minRank1) {
  console.error(
    '--min-rank1 <percent> is required for a real adopt. Use --dry-run to preview without it.',
  );
  process.exit(1);
}

const stagingDir = path.join(VAULT, 'Staging', SLUG);
const staged = resolveNote(stagingDir, name);
if (!staged) {
  console.error(`not found in Staging/${SLUG}: ${name}`);
  process.exit(1);
}
const target = path.join(VAULT, 'permanent', `${path.basename(staged, '.md')}.md`);

const result = adopt(
  {
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, s) => fs.writeFileSync(p, s),
    removeFile: (p) => fs.unlinkSync(p),
    exists: (p) => fs.existsSync(p),
    reindex: () => {
      execFileSync(
        'node',
        [
          path.join(paths.scriptsDir, 'memory-semantic.mjs'),
          '--index',
          '--vault',
          VAULT,
          '--slug',
          SLUG,
        ],
        { stdio: 'ignore' },
      );
    },
    runGate: () => {
      const args = ['--run', '--json', '--kind', 'held-out', '--vault', VAULT, '--slug', SLUG];
      if (minRank1) args.push('--min-rank1', minRank1);
      const cases = val('--cases');
      if (cases) args.push('--cases', cases);
      // --run exits non-zero when the gate fails, but still prints the JSON envelope to stdout —
      // execFileSync throws on that exit code and attaches stdout to the error, not to a return.
      try {
        const out = execFileSync(
          'node',
          [path.join(paths.scriptsDir, 'memory-eval.mjs'), ...args],
          {
            encoding: 'utf8',
          },
        );
        const env = JSON.parse(out);
        return {
          failures: env.gate ?? [],
          recall1: env.recall?.[1] ?? null,
          frozen: env.frozen ?? null,
        };
      } catch (e) {
        const stdout = /** @type {{ stdout?: string }} */ (e).stdout;
        try {
          return { failures: JSON.parse(String(stdout)).gate ?? ['held-out eval run failed'] };
        } catch {
          return { failures: [`held-out eval run failed: ${/** @type {Error} */ (e).message}`] };
        }
      }
    },
  },
  { stagedPath: staged, targetPath: target, dryRun, force },
);

switch (result.status) {
  case 'undrafted':
    console.log(`still the /memory:synthesize skeleton — draft it before adopting: ${staged}`);
    process.exit(1);
  case 'wrong-type':
    console.log(
      `frontmatter type is not "permanent" — /memory:synthesize should set it when drafting: ${staged}`,
    );
    process.exit(1);
  case 'exists':
    console.log(`${target} already exists — pass --force to overwrite.`);
    process.exit(1);
  case 'dry-run':
    console.log(`would adopt ${staged}\n  -> ${target}`);
    process.exit(0);
  case 'rejected':
    console.log(
      `rejected — held-out gate failed, permanent/ left unchanged:\n${(result.reasons ?? [])
        .map((r) => `  - ${r}`)
        .join('\n')}\nStaged proposal kept for a retry: ${staged}`,
    );
    process.exit(1);
  case 'adopted':
    console.log(
      `adopted: ${target}\nremoved staged proposal: ${staged}` +
        (result.recall1 != null
          ? `\nheld-out recall@1: ${(result.recall1 * 100).toFixed(1)}%`
          : '') +
        (result.frozen ? `\nheld-out set: ${result.frozen}` : '\nheld-out set: not frozen'),
    );
    process.exit(0);
}
