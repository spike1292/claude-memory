// The lexical vocabulary shared by the search CLI and the UserPromptSubmit recall hook: the card
// sentinel, the stopword list, the tokeniser and BM25. Nothing else.
//
// Split out from memory-semantic.mjs so hooks/memory-recall.mjs can import it STATICALLY, above its
// fail-open try — memory-semantic.mjs's module scope does console.log() + process.exit(1) on an
// unknown model, which would crash every prompt's recall hook. Design story and the module-init
// cost measurement (2026-08-19): docs/architecture.md, section B1.
//
// THIS FILE IMPORTS NOTHING — not even a node builtin. Keep it that way: an import added here runs
// on every prompt, armed or not.
//
// memory-semantic.mjs re-exports all four, so existing consumers and tests are unchanged.

// The card chunk's heading (`CARD`) is a WIRE value, not a label — every reader binds it as a SQL
// parameter so a rename cannot go silent again. Full failure mode: R4 in docs/architecture.md.
export const CARD = '(card)';

export const STOP = new Set(
  'the a an and or of to in on for is are was were it its this that with as by at from be not you your we our they them if then when what which how why do does did can could should would use used using via no yes into over under more most less least than each per also only just same other about have has had will'.split(
    ' ',
  ),
);

/**
 * @param {string} s
 * @returns {string[]}
 */
export const lexTokens = (s) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

// Textbook BM25 over the chunk texts already in the index — no second store, no extra dependency.
//
// k1/b are DEFAULTS here and callers that gate on an absolute score must pass them explicitly:
// recall's MIN_SCORE = 6.0 and its MIN_SCORE/2 trailing floor are calibrated against 1.2/0.75, and
// a tune made for the CLI's fusion arm would silently rescale both. See hooks/lib/memory-recall.mjs.

/** @typedef {{ toks: string[] }} Bm25Doc */

/**
 * @param {readonly Bm25Doc[]} docs
 * @param {readonly string[]} qTokens
 * @param {number} [k1]
 * @param {number} [b]
 * @returns {number[]}
 */
export function bm25(docs, qTokens, k1 = 1.2, b = 0.75) {
  const N = docs.length || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  const avgdl = docs.reduce((a, d) => a + d.toks.length, 0) / N;
  return docs.map((d) => {
    const tf = new Map();
    for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of qTokens) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const n = df.get(t) || 0;
      s +=
        (Math.log(1 + (N - n + 0.5) / (n + 0.5)) * (f * (k1 + 1))) /
        (f + k1 * (1 - b + (b * d.toks.length) / avgdl));
    }
    return s;
  });
}
