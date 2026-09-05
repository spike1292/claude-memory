#!/usr/bin/env node
// Prints the resolved memory environment as shell assignments; eval "$(node scripts/env.mjs "$PWD")" from hooks/lib/vault-env.sh.
// Off-pattern placement (logic lives in hooks/lib/env-shell.mjs, not scripts/lib/) — why: docs/architecture.md, "B1 — hooks/ and scripts/ are not layers".
import { shellEnv } from '../hooks/lib/env-shell.mjs';

process.stdout.write(shellEnv(process.argv[2] || process.cwd()));
