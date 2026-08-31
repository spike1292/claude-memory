#!/usr/bin/env node
// Print the resolved memory environment as shell assignments, for `eval` by hooks/lib/vault-env.sh.
//
// Thin on purpose: argv in, one block out.
//
//   eval "$(node scripts/env.mjs "$PWD")"
//
// PLACEMENT is deliberately off-pattern: logic lives in hooks/lib/env-shell.mjs, not a scripts/lib/
// twin, because it renders what paths.mjs resolves — docs/architecture.md, "B1 — hooks/ and
// scripts/ are not layers".
import { shellEnv } from '../hooks/lib/env-shell.mjs';

process.stdout.write(shellEnv(process.argv[2] || process.cwd()));
