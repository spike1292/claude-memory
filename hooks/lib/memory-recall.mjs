// Pure decision logic for the UserPromptSubmit recall hook. The entry (hooks/memory-recall.mjs)
// owns stdin, the unix socket, `node:sqlite` and stdout; everything here takes ROWS AND STRINGS AS
// VALUES, so the gates, the ranking and the log-record shapes are testable without an index, a
// resident server, or a runtime that even has `node:sqlite`.
//
// Recall carried its OWN copy of the stopword list, the tokeniser and BM25 until 2026-08-19 — a
// fourth fork of all three. They are gone; the shared ones below are the only implementation.
// The two were equivalent, which is why the swap is safe rather than merely plausible:
//   - the STOP lists were the same 71 words. Recall's literal spelled `with` twice, which a Set
//     collapses, so the two Sets compared identical member-for-member.
//   - recall's inline BM25 was `bm25()` at its own defaults with the arithmetic pre-substituted:
//     `f * 2.2` is `f * (k1 + 1)` at k1 = 1.2, and `0.25 + 0.75 * dl / avgdl` is
//     `1 - b + b * dl / avgdl` at b = 0.75.
//
// IMPORTED FROM scripts/lib/lexical.mjs, NOT from memory-semantic.mjs where these four grew up.
// This module is imported STATICALLY by hooks/memory-recall.mjs — above the fail-open try and above
// the `recallEnabled()` gate — so everything reachable from here runs on every prompt of every
// session, armed or not, uncatchably. memory-semantic.mjs cannot go there: its module scope
// resolves the active model and, on an unknown one, does `console.log(...)` + `process.exit(1)`.
// Measured 2026-08-19 with `{"model":"bge-m4"}` in config.json: exit 1 and that line on STDOUT —
// which hooks.json's `|| exit 0` turns into exit 0 WITH the line, i.e. injected as context on every
// prompt, disarmed installs included. It also promoted model-default.mjs from a caught dynamic
// import to an uncatchable static one. lexical.mjs imports nothing at all, so it adds no failure
// mode the entry's own `./lib/paths.mjs` import did not already have, and its module init is
// 0.26-0.42 ms rather than the 3.8-4.4 ms of memory-semantic.mjs (8 runs each, 2026-08-19).
import { CARD, bm25, lexTokens } from '../../scripts/lib/lexical.mjs';

export const MAX_NOTES = 4;
export const MAX_CHARS = 900; // ~250 tokens
export const MIN_SCORE = 6.0; // below this the top hit is not worth the reader's attention
export const MIN_PROMPT = 25; // one-word prompts have no retrievable intent
// Cosine needs its own gate — MIN_SCORE above is BM25-scaled and means nothing here. Calibrated
// 2026-08-15 on 5 on-topic and 5 deliberately off-topic prompts: on-topic 0.495-0.736, off-topic
// 0.351-0.506. The bands OVERLAP, so no threshold is clean; 0.55 rejects all 5 off-topic and admits
// 4 of 5 on-topic. Erring toward silence is the design rule. Sample is 10 prompts — treat it as a
// starting point, and read the abstain rate in the log rather than trusting this number.
export const MIN_COS = 0.55;

// Re-exported so the entry's SELECT can bind the card sentinel instead of spelling it out. That
// bare literal was the last unbound consumer (R4 in docs/architecture.md); it is gone as of
// 2026-08-19 because the SQL now sits behind this module.
export { CARD };

export const HEADER =
  'Possibly relevant vault notes (retrieved, not verified — open one before relying on it):';

export const brief = (lines) => `${HEADER}\n${lines.join('\n')}`;

// Both arms render identically; only the trailing-weak-hit floor differs, so it is the one
// parameter. `floor` is BM25-scaled for the keyword arm and absent for the semantic one.
export function renderLines(hits, floor = -Infinity) {
  const lines = [];
  let used = 0;
  for (const r of hits) {
    if (r.score < floor) break; // trailing weak hits add noise, not context
    const first = (r.text ?? '').split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
    const line = `- [[${r.note}]] (${r.layer}): ${first.slice(0, 150)}`;
    if (used + line.length > MAX_CHARS) break; // strict >: a brief of exactly MAX_CHARS fits
    lines.push(line);
    used += line.length;
  }
  return { lines, used };
}

// null means FALL THROUGH to the keyword arm, and it is the answer for more than just an error: a
// server reply of `{"results":[]}`, `{"results":null}` or unparseable output all land here, and the
// hook then answers from BM25 rather than abstaining. Anything else is a decision — `{ entry }` is
// the JSONL record, `output` is stdout or null.
export function semanticArm(results) {
  if (!results?.length) return null;
  const hits = results.filter((r) => r.score >= MIN_COS).slice(0, MAX_NOTES);
  if (!hits.length) {
    return {
      // `score` is deliberately not defaulted: a hit with no score field must leave the key out of
      // the JSON entirely rather than log a 0 that reads like a real measurement.
      entry: {
        abstained: true,
        reason: 'low confidence (semantic)',
        top: results[0]?.note,
        score: results[0]?.score,
        via: 'server',
      },
      output: null,
    };
  }
  const { lines, used } = renderLines(hits);
  // Only reachable if the very first line already exceeds MAX_CHARS, which needs a ~700-char note
  // name because the body is sliced to 150. Effectively dead; kept because falling through is the
  // safe reading of it, not because it has ever been observed (2026-08-19).
  if (!lines.length) return null;
  return {
    entry: {
      abstained: false,
      injected: lines.length,
      chars: used,
      top: hits[0].note,
      score: hits[0].score,
      via: 'server',
    },
    output: brief(lines),
  };
}

// The keyword arm always decides — it is the fallback, so it has nothing to fall through to.
// Its log records carry NO `via` field, and that absence is the only thing telling the two arms
// apart in the log. It is a contract, not an oversight.
export function keywordArm(cards, prompt) {
  if (!cards.length) return { entry: { abstained: true, reason: 'empty index' }, output: null };

  const qt = [...new Set(lexTokens(prompt))];
  if (!qt.length) return { entry: { abstained: true, reason: 'no content words' }, output: null };

  const docs = cards.map((c) => ({ ...c, toks: lexTokens(c.text) }));
  // k1/b PINNED, not left to bm25()'s defaults. MIN_SCORE below and its MIN_SCORE/2 trailing floor
  // are absolute BM25 values calibrated at 1.2/0.75 — the arithmetic recall used to inline. Sharing
  // the function means a tune made for the CLI's fusion arm would otherwise rescale both gates
  // silently, and no test asserts an absolute score.
  const scores = bm25(docs, qt, 1.2, 0.75);
  const scored = docs
    .map((d, i) => ({ note: d.note, layer: d.layer, text: d.text, score: scores[i] }))
    .sort((a, b) => b.score - a.score);

  if (!scored.length || scored[0].score < MIN_SCORE) {
    return {
      entry: {
        abstained: true,
        reason: 'low confidence',
        top: scored[0]?.note ?? null,
        score: +(scored[0]?.score ?? 0).toFixed(2),
      },
      output: null,
    };
  }

  const { lines, used } = renderLines(scored.slice(0, MAX_NOTES), MIN_SCORE / 2);
  if (!lines.length) return { entry: { abstained: true, reason: 'budget' }, output: null };

  return {
    entry: {
      abstained: false,
      injected: lines.length,
      chars: used,
      top: scored[0].note,
      score: +scored[0].score.toFixed(2),
    },
    output: brief(lines),
  };
}
