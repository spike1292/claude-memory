#!/usr/bin/env node
// Print the resolved memory environment as shell assignments, for `eval` by hooks/lib/vault-env.sh.
//
// Thin on purpose: argv in, one block out.
//
//   eval "$(node scripts/env.mjs "$PWD")"
//
// PLACEMENT, deliberately off-pattern. Every other entry pairs with a twin of the same name in the
// sibling lib/ (scripts/memory-semantic.mjs -> scripts/lib/memory-semantic.mjs); this one's logic
// lives in hooks/lib/env-shell.mjs. That is where it belongs: it renders what paths.mjs resolves,
// and paths.mjs is in hooks/lib/. Moving it to scripts/lib/env.mjs would file hook-resolution infra
// under scripts/ and split it from the module it exists to serve. The entry sits in scripts/
// because that is where a CLI goes and because vault-env.sh invokes it by path.
import { shellEnv } from '../hooks/lib/env-shell.mjs';

process.stdout.write(shellEnv(process.argv[2] || process.cwd()));
