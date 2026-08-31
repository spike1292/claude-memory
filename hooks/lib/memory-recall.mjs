// Pure decision logic for the UserPromptSubmit recall hook. The entry (hooks/memory-recall.mjs)
// owns stdin, the socket, node:sqlite and stdout; everything here takes rows and strings as values,
// so the gates, the ranking and the log-record shapes are testable without an index, a resident
// server, or a runtime that even has node:sqlite.
//
// Never import scripts/lib/memory-semantic.mjs here: this module is imported STATICALLY by
// hooks/memory-recall.mjs, above the fail-open try and above the recallEnabled() gate, so
// everything reachable from here runs on every prompt of every session, armed or not, uncatchably.
// memory-semantic.mjs's module scope does console.log(...) + process.exit(1) on an unknown model —
// uncatchable here, and hooks.json's `|| exit 0` turns that into a context-injecting no-op on every
// prompt, disarmed installs included.
//
// Equivalence proof for the 2026-08-19 swap off this module's own stopword/tokeniser/BM25 fork, and
// the module-init cost measurements behind choosing lexical.mjs over memory-semantic.mjs:
// docs/architecture.md H6 (~line 526) and B1 (~line 432).
import { CARD, bm25, lexTokens } from '../../scripts/lib/lexical.mjs';

export const MAX_NOTES = 4;
export const MAX_CHARS = 900; // ~250 tokens
// ponytail: gate is corpus-scaled, ~14 halves false fires — docs/decisions/2026-08-31-recall-gate-calibration.md
export const MIN_SCORE = 6.0;
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

/**
 * @typedef {{ note: string, layer: string, text?: string | null, score: number }} Hit
 * @typedef {{ note: string, layer: string, text?: string | null, score?: number }} ServerHit
 * @typedef {{ note: string, layer: string, text: string | null }} Card
 * @typedef {{
 *   abstained: boolean,
 *   reason?: string,
 *   top?: string | null,
 *   score?: number,
 *   injected?: number,
 *   chars?: number,
 *   via?: string,
 *   ms?: number,
 *   k?: number,
 *   notes?: string[],
 * }} LogEntry
 * @typedef {{ entry: LogEntry, output: string | null }} Decision
 */

// `k` and `notes` are the arm's CANDIDATES — the top MAX_NOTES by score, in render order, BEFORE
// renderLines applied anything of its own. `injected` is what actually reached the prompt, so the
// injected notes are `notes.slice(0, injected)`.
//
// `k > injected` therefore means renderLines stopped early, and WHICH of its two stops is
// arm-dependent: the semantic arm renders floorless over already-gated hits, so there it is the
// character budget; the keyword arm passes a trailing weak-hit floor (MIN_SCORE / 2) that
// renderLines checks BEFORE the budget, and its candidates are the top 4 of the whole corpus with
// only `scored[0]` gated — so there it is usually the floor. Do not read it as "the budget".
// Both keys follow `score`'s discipline: an arm with no candidates omits them rather than logging
// `0` and `[]`, which would read like a measurement of nothing instead of the absence of one.
// `ms` is stamped by the entry, which owns the clock; the arms stay pure and untimed.

export const HEADER =
  'Possibly relevant vault notes (retrieved, not verified — open one before relying on it):';

/** @param {readonly string[]} lines */
export const brief = (lines) => `${HEADER}\n${lines.join('\n')}`;

// Both arms render identically; only the trailing-weak-hit floor differs, so it is the one
// parameter. `floor` is BM25-scaled for the keyword arm and absent for the semantic one.
/**
 * @param {readonly Hit[]} hits
 * @param {number} [floor]
 * @returns {{ lines: string[], used: number }}
 */
export function renderLines(hits, floor = -Infinity) {
  /** @type {string[]} */
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
/**
 * @param {readonly ServerHit[] | null | undefined} results
 * @returns {Decision | null}
 */
export function semanticArm(results) {
  if (!results?.length) return null;
  const hits = /** @type {Hit[]} */ (
    results.filter((r) => /** @type {number} */ (r.score) >= MIN_COS).slice(0, MAX_NOTES)
  );
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
      k: hits.length,
      notes: hits.map((h) => h.note),
    },
    output: brief(lines),
  };
}

// The keyword arm always decides — it is the fallback, so it has nothing to fall through to.
// Its log records carry NO `via` field, and that absence is the only thing telling the two arms
// apart in the log. It is a contract, not an oversight.
/**
 * @param {readonly Card[]} cards
 * @param {string} prompt
 * @returns {Decision}
 */
export function keywordArm(cards, prompt) {
  if (!cards.length) return { entry: { abstained: true, reason: 'empty index' }, output: null };

  const qt = [...new Set(lexTokens(prompt))];
  if (!qt.length) return { entry: { abstained: true, reason: 'no content words' }, output: null };

  // `?? ''` is not defensive padding: chunks.text has no NOT NULL (scripts/memory-semantic.mjs's
  // CREATE TABLE), and lexTokens does s.toLowerCase() with no guard, so one NULL row would throw out
  // of the keyword arm. It fails open either way — the entry's outer catch exits 0 — but it would
  // take the whole arm down and log nothing, where every other empty-content path here logs a
  // reason. Unreachable today; the schema is what makes it reachable tomorrow (2026-08-19, #29).
  const docs = cards.map((c) => ({ ...c, toks: lexTokens(c.text ?? '') }));
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

  const cand = scored.slice(0, MAX_NOTES);
  const { lines, used } = renderLines(cand, MIN_SCORE / 2);
  const considered = { k: cand.length, notes: cand.map((c) => c.note) };
  if (!lines.length)
    return { entry: { abstained: true, reason: 'budget', ...considered }, output: null };

  return {
    entry: {
      abstained: false,
      injected: lines.length,
      chars: used,
      top: scored[0].note,
      score: +scored[0].score.toFixed(2),
      ...considered,
    },
    output: brief(lines),
  };
}
