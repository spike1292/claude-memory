#!/usr/bin/env node
// SessionEnd entry: distil a transcript into Obsidian Insight notes.
//
// Thin on purpose: argv in, one line of output. Logic and tests live in lib/distill-session.mjs.
// distill-session.sh invokes this path (detached), so it is a contract — keep it.
import { distill } from './lib/distill-session.mjs';

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('usage: distill-session.mjs <transcript> <cwd>');
  process.exit(1);
}

const r = distill(argv[0], argv[1]);
if (r)
  console.log(
    `distill: wrote ${r.written} note(s), merged ${r.merged} into existing, for ${r.slug}`,
  );
