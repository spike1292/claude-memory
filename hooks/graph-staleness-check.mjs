#!/usr/bin/env node
// SessionStart entry: nudge or regenerate a stale codebase graph report.
//
// Thin on purpose: stdin in, at most one JSON line out. Logic and tests live in
// lib/graph-staleness-check.mjs.
import { readStdin, payload, hookCwd } from './lib/hook-io.mjs';
import { check } from './lib/graph-staleness-check.mjs';

const line = check(hookCwd(payload(readStdin())));
if (line) console.log(line);
