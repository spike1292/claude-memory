// Model profiles, in a module of their OWN and not beside the resolver that uses them.
//
// memory-semantic.mjs resolves the active model at import time and calls process.exit(1) when it
// does not know it, so importing that file just to read the key list takes any caller down with a
// bad config value — which is exactly when a diagnostic is being run. Same reason lexical.mjs was
// split out for the recall hook. This file resolves nothing and must stay that way.

// Model profiles. Embedding models are asymmetric in different ways — BGE-en wants an instruction
// on the query only, E5 wants `query:`/`passage:` on both sides, bge-m3 wants neither. Getting the
// prefix wrong degrades retrieval silently, so it belongs with the model, not in a comment.
// Override with MEMORY_SEMANTIC_MODEL=<key>.
// BATCH SIZE IS 1 FOR EVERY MODEL, deliberately — verify with `--check-embedding`. Padding shifts
// a vector 0.014 where competing notes sit ~0.001 apart (2026-08-15); sweep in
// docs/decisions/2026-08-15-model-choice.md.
/**
 * @typedef {object} ModelProfile
 * @property {string} id
 * @property {number} dim
 * @property {number} maxChars
 * @property {'mean'|'cls'} pool
 * @property {string} q
 * @property {string} d
 * @property {number} dupeMin
 * @property {number} clusterMin
 * @property {number} [batch]
 */

/** @type {Record<string, ModelProfile>} */
export const MODELS = {
  // `dupeMin` is model-specific and NOT transferable: E5 packs everything into a high, narrow band,
  // so bge-small-en's 0.86 reports 29,560 pairs under e5-multi — noise that looks like a backlog.
  // Mean, NOT cls — measured, against the model card. BGE-v1.5 is documented as CLS-pooled, but on
  // the 28-case EN set cls scores @1 21.4% / MRR 0.337 against mean's 32.1% / 0.415. Whatever the
  // Xenova q8 export does, it is not what the card describes. Do not "fix" this to cls.
  'bge-small-en': {
    id: 'Xenova/bge-small-en-v1.5',
    dim: 384,
    maxChars: 1800,
    pool: 'mean',
    q: 'Represent this sentence for searching relevant passages: ',
    d: '',
    dupeMin: 0.86,
    clusterMin: 0.8,
  },
  // Multilingual, same 384 dims. Better Dutch at k>=3 (NL @5 66.7% vs bge's 40.0%) but a large
  // English regression (@1 10.7% vs 32.1%): its similarity band is compressed, so ranking barely
  // discriminates. Available for Dutch-heavy work; not the default.
  'e5-multi': {
    id: 'Xenova/multilingual-e5-small',
    dim: 384,
    maxChars: 1600,
    pool: 'mean',
    q: 'query: ',
    d: 'passage: ',
    dupeMin: 0.95,
    clusterMin: 0.92,
  },
  // 1024-dim multilingual, maxChars 1800 — aligned to the other profiles on purpose, not a cost
  // concession (an earlier "disqualified on cost" verdict was measuring chunking, not the model).
  // dupeMin 0.75 / clusterMin 0.72 measured 2026-08-17 — do not copy or scale from e5-multi, m3's
  // similarity band sits low and wide, the opposite of e5-multi's high narrow one, and neither
  // direction transfers. Cost re-evaluation and calibration sweep in
  // docs/decisions/2026-08-15-model-choice.md.
  'bge-m3': {
    id: 'Xenova/bge-m3',
    dim: 1024,
    maxChars: 1800,
    d: '',
    q: '',
    pool: 'cls',
    dupeMin: 0.75,
    clusterMin: 0.72,
  },
};
