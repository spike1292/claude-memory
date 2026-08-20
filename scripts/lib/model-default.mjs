// The active embedding model, in ONE place.
//
// Three files needed it — the search script, the eval harness and the recall hook — and each had
// its own `|| 'bge-small-en'` fallback. Indexes are per-model and memory-recall.mjs exits 0 when
// its DB is missing, so a drifting default does not error: recall just silently stops firing.
//
// Changing this is a real change. A different model means a different index (a full rebuild) and
// different dupe/cluster thresholds — see MODELS in models.mjs. Do not change it without
// a case-set run: memory-eval.mjs --run --cases "$CLAUDE_MEMORY_HOME/eval/<set>.jsonl"
import { config } from '../../hooks/lib/paths.mjs';

export const DEFAULT_MODEL = 'bge-m3';
export const activeModel = () =>
  process.env.MEMORY_SEMANTIC_MODEL || config().model || DEFAULT_MODEL;
