// The active embedding model, in ONE place — see CLAUDE.md's Retrieval section (~line 196) for why
// a drifting default is silent rather than an error.
//
// Changing this is a real change: a different model means a different index (a full rebuild) and
// different dupe/cluster thresholds — see MODELS in models.mjs. Do not change it without
// a case-set run: memory-eval.mjs --run --cases "$CLAUDE_MEMORY_HOME/eval/<set>.jsonl"
import { config } from '../../hooks/lib/paths.mjs';

export const DEFAULT_MODEL = 'bge-m3';
export const activeModel = () =>
  process.env.MEMORY_SEMANTIC_MODEL || config().model || DEFAULT_MODEL;
