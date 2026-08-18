#!/usr/bin/env node
// SessionStart entry: refresh the semantic vault index in the background.
//
// Thin on purpose: stdin in, nothing out. Logic and tests live in lib/semantic-index-refresh.mjs.
import { readStdin, payload, hookCwd } from './lib/hook-io.mjs';
import { refresh } from './lib/semantic-index-refresh.mjs';

refresh(hookCwd(payload(readStdin())));
