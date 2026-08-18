#!/usr/bin/env node
// Print the resolved memory environment as shell assignments, for `eval` by hooks/lib/vault-env.sh.
//
// Thin on purpose: argv in, one block out. Logic and tests live in hooks/lib/env-shell.mjs.
//
//   eval "$(node scripts/env.mjs "$PWD")"
import { shellEnv } from '../hooks/lib/env-shell.mjs';

process.stdout.write(shellEnv(process.argv[2] || process.cwd()));
