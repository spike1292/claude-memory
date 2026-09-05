// Model profiles, in a module of their own — CHANGELOG.md's 0.4.0 entry has why (importing
// memory-semantic.mjs just for this list takes a caller down on a bad config value).
// Override with MEMORY_SEMANTIC_MODEL=<key>. Batch 1 for every model; padding shifts a vector
// 0.014 where competing notes sit ~0.001 apart (2026-08-15) — sweep in
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
  // dupeMin is model-specific, not transferable — sweep: docs/decisions/2026-08-15-model-choice.md.
  // Mean pooling, not cls, despite the model card — measured against it (same doc).
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
  // Better Dutch, large English regression — sweep: docs/decisions/2026-08-15-model-choice.md.
  // Available for Dutch-heavy work; not the default.
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
  // dupeMin 0.75 / clusterMin 0.72 measured 2026-08-17 — do not copy or scale from e5-multi, m3's
  // similarity band sits low and wide, the opposite. Full sweep and cost re-evaluation:
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
