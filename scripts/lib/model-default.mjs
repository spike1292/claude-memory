// The active embedding model, in ONE place — CLAUDE.md's Retrieval section explains why a drifting default is silent rather than an error.
// Changing this is a real change (different model = different index, different dupe/cluster thresholds in models.mjs) — verify with memory-eval.mjs --run --cases "$CLAUDE_MEMORY_HOME/eval/<set>.jsonl" first.
import { config } from '../../hooks/lib/paths.mjs';

export const DEFAULT_MODEL = 'bge-m3';
export const activeModel = () =>
  process.env.MEMORY_SEMANTIC_MODEL || config().model || DEFAULT_MODEL;
