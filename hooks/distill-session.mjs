#!/usr/bin/env node
// SessionEnd + Stop entry. Two modes, one file:
//
//   no argv  -> GATE. Reads the hook payload on stdin, decides, and detaches the worker below.
//   argv     -> WORKER. Distils one transcript into Obsidian Insight notes.
//
// The gate re-invokes this same path, so the argv form is a contract — keep it.
import { readStdin, payload } from './lib/hook-io.mjs';
import { distill, gate } from './lib/distill-session.mjs';

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
  gate(payload(readStdin()));
}
