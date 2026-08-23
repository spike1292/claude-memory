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
// Below this the top hit is not worth the reader's attention. Swept 2026-08-19 on the synthetic
// bench vault (`memory-synth-vault.mjs --seed 7`, re-run at 120/300/1000 notes — `--notes 100`
// built 120 before #49 made that flag a ceiling), using the
// `cases-paraphrase.jsonl` + `cases-keyword.jsonl` that script emits: 80 on-topic prompts whose
// gold note is known by construction and which nobody wrote for this sweep. The off-topic control
// was a 28-question authored set about a corpus the bench vault does not contain, so no bench note
// is a right answer and every fire there is pure noise. That property — not any particular file —
// is what makes a set usable here; it is deliberately named by its property rather than by a path,
// because an unscoped case-set name under $CLAUDE_MEMORY_HOME is owned by whichever project
// authored one first (#97).
//
// That control set is MACHINE-LOCAL and cannot ship: authored case sets live under
// $CLAUDE_MEMORY_HOME and are private by policy, so the on-topic half of this table is
// reproducible from the committed generator and the off-topic half is not. To re-run the
// off-topic half, author your own questions about a corpus the bench vault does not contain
// (`memory-eval.mjs --author`) — any set where every fire is by construction wrong will do.
//
// The instrument is keywordArm's own ranking, not a model of it: `bm25(cards, [...new
// Set(lexTokens(q))], 1.2, 0.75)` over the `(card)` chunks, which agreed with keywordArm's own
// decision on 120/120 cases at 6.0. `--mode lexical` in memory-eval.mjs is NOT this instrument;
// it scores whole notes, and on these same cases puts gold at rank 1 for 50% (paraphrase) and
// 25% (keyword) against keywordArm's 100% on both.
//
//   gate   on-topic answered (of 80)   off-topic false-fire (of 28)   at 120/300/1000 notes
//    6.0   80  80  80                  17  19  28
//   10.0   80  80  80                   9  11  13
//   14.0   80  80  80                   8   8  10
//   17.0   79  80  80                   4   6   8
//
// 6.0 is NOT too high. The weakest on-topic prompt scores 15.2/17.4/20.3 — a 2.5-3.4x margin —
// and no gate from 0 to 12 suppresses one of the 80; gold is at rank 1 for every one of them.
// It is too LOW in the other direction: it sits inside the off-topic band (5.5-32.1 at 300 notes)
// and rejects between a third of it and none of it, so a long prompt that merely shares software
// vocabulary gets an answer anyway. ~14 halves the false fires at zero on-topic cost at all three
// corpus sizes.
//
// DELIBERATELY NOT CHANGED HERE: moving it is a behaviour change on every prompt, and this is a
// direction rather than a value. Absolute BM25 is corpus-scaled (avgdl moved 82 -> 51 across the
// three sizes), the synthetic prose is tidier than a real vault's, and the off-topic control is
// contaminated — both corpora are software prose. Read the abstain rate in the log first.
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
