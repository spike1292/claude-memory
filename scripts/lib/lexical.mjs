// The lexical vocabulary shared by the search CLI and the UserPromptSubmit recall hook: the card
// sentinel, the stopword list, the tokeniser and BM25. Nothing else.
//
// WHY IT IS ITS OWN FILE, and not just four exports in memory-semantic.mjs where it grew up.
// hooks/lib/memory-recall.mjs needs exactly these four, and it is imported STATICALLY by
// hooks/memory-recall.mjs — above the fail-open try, above the `recallEnabled()` gate. Anything
// reachable from there runs on EVERY prompt of EVERY session, armed or not, with no way to catch
// what it does. memory-semantic.mjs is not safe to put there: its module scope resolves the active
// model and, on an unknown one, does `console.log(...)` + `process.exit(1)`. For the CLI that is a
// correct error message; on the prompt path it is a junk line on STDOUT that Claude Code injects as
// context (hooks.json's trailing `|| exit 0` turns the exit 1 into an exit 0 and keeps the line),
// on every prompt, including installs that never armed recall. Measured 2026-08-19 with
// `{"model":"bge-m4"}`: exit 1 + that line, vs exit 0 and zero bytes before. It also dragged
// model-default.mjs from a caught dynamic import into an uncatchable static one.
//
// THIS FILE IMPORTS NOTHING — not even a node builtin — and evaluates four declarations. That is
// the property that makes it safe above the try, and the property to preserve: an import added here
// is an import added to the prompt path. It is also 0.26-0.42 ms of module init against the
// 3.8-4.4 ms memory-semantic.mjs costs (8 runs each, warm, marginal after paths.mjs, 2026-08-19).
//
// memory-semantic.mjs re-exports all four, so every existing consumer and test is unchanged and
// there is still exactly ONE implementation of each.

// The card chunk's heading is a WIRE value, not a label: it is written into the index and matched
// back out by SQL in scripts/memory-semantic.mjs and hooks/memory-recall.mjs. Renaming it used to
// be silent in the worst way (R4 in docs/architecture.md) — recall's keyword arm SELECTs 0 rows,
// `avgdl` is NaN, every score is NaN, and the hook abstains, which is its NORMAL behaviour. Made a
// constant 2026-08-19 so producer and consumers cannot drift; every consumer binds it as a SQL
// parameter, recall included since its SELECT moved behind hooks/lib/memory-recall.mjs.
export const CARD = '(card)';

export const STOP = new Set(
  'the a an and or of to in on for is are was were it its this that with as by at from be not you your we our they them if then when what which how why do does did can could should would use used using via no yes into over under more most less least than each per also only just same other about have has had will'.split(
    ' ',
  ),
);

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
