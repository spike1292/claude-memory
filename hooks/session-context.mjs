#!/usr/bin/env node
// Pipe filter after vault-memory-sync.sh: its plain stdout becomes SessionStart context JSON, so
// Copilot CLI injects it too (#217). The script stays unported; see CLAUDE.md.
import { readStdin, payload, standDown, sessionContext } from './lib/hook-io.mjs';

const text = readStdin().trim();
if (!standDown('session-context', payload(text)) && text) console.log(sessionContext(text));
