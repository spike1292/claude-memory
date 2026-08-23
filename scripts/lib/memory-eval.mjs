#!/usr/bin/env node
// Logic half; the CLI entry is scripts/memory-eval.mjs.
// Reproducible retrieval eval for the vault. Generates a versioned case set once, then scores any
// retrieval change against THE SAME cases.
//
// Why this exists: before it, every /memory:eval run hand-wrote a fresh set of questions. The
// numbers moved between runs (0.60 → 1.00 on 2026-08-14) but the question set moved too, so the
// comparison proved nothing — and the questions were written by someone who already knew the vault
// and knew what had just been fixed. Borrowed wholesale from obsidian-second-brain's harness, whose
// baseline states the rule plainly: **no retrieval change ships without before/after numbers on the
// same cases.**
//
// Usage:
//   node memory-eval.mjs --generate 40 [--style semantic|keyword] [--out <path>]
//   node memory-eval.mjs --run [--cases <path>] [--mode semantic|lexical] [--json]
//   node --test scripts/lib/memory-eval.test.mjs
//
// Cases live at `defaultCasesPath()` under $CLAUDE_MEMORY_HOME/eval/ and are GITIGNORED: they
// contain vault content. Regenerate only with --force; a changed case set invalidates every past
// number.

// `node:fs`, `execFileSync`, `model-default.mjs` and `paths.mjs` were all imported and none of them
// referenced — dead since the entry/lib split moved the CLI out. Dropped 2026-08-19.
import path from 'node:path';
import { bm25, lexTokens } from './lexical.mjs';

export const RECALL_KS = [1, 3, 5, 10];

/** @typedef {{ note: string, text: string }} EvalDoc */
/** @typedef {{ note: string, score: number }} RankedNote */
/** @typedef {{ q: string, results: RankedNote[] }} RankedQuery */

// ---------------------------------------------------------------- pure helpers (self-tested)

/** @param {string} stem @returns {Set<string>} */
export function titleTokens(stem) {
  return new Set(
    stem
      .toLowerCase()
      .replace(/^\d{4}-\d{2}-\d{2}-/, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );
}

// Strip everything that would leak the answer's own vocabulary or isn't prose: frontmatter,
// headings, code fences, wikilinks — and critically the `_Also asked as:` line, which is a list of
// queries the note was written to match. Generating a question from it would score our own aliases.
/** @param {string} raw @returns {string} */
export function evalBody(raw) {
  let t = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/^_Also asked as:[\s\S]*$/m, ' ');
  t = t.replace(/^#{1,6} .*$/gm, ' ');
  t = t.replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, ' ');
  t = t.replace(/`[^`]*`/g, ' ');
  return t;
}

// A paraphrase question must not reuse the note's title words — that is the whole point of the
// semantic style; otherwise it degenerates into a keyword lookup and every channel scores well.
/**
 * @param {string} body
 * @param {string} stem
 * @param {string} style
 * @returns {string|null}
 */
export function pickSentence(body, stem, style) {
  const tt = titleTokens(stem);
  const sents = body
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 40 && s.length <= 220 && /[a-z]/.test(s));
  if (!sents.length) return null;
  /** @param {string} s @returns {number} */
  const score = (s) => {
    const toks = new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    );
    let overlap = 0;
    for (const w of toks) if (tt.has(w)) overlap++;
    return style === 'keyword' ? overlap : -overlap; // keyword wants the title words, semantic avoids them
  };
  return sents.sort((a, b) => score(b) - score(a) || b.length - a.length)[0];
}

// The keyword baseline for `--run --mode lexical`. It scores WHOLE NOTES, which is what makes it a
// baseline for the semantic arm (that one searches every chunk) rather than a model of the recall
// hook (that one scores only the `(card)` chunk). Read that sentence before quoting a number from
// here at the hook: on the seed-7 300-note bench vault this scores recall@1 50.0% on
// cases-paraphrase and 25.0% on cases-keyword, where `keywordArm()` over the same cases puts the
// gold note at rank 1 for 40/40 of BOTH — the document unit, not the ranking function, is the gap
// (measured 2026-08-19).
//
// It used to inline its own tokeniser and its own BM25 — a THIRD fork of both, after #29 retired
// recall's. That fork silently differed twice: no stopword removal, and no de-duplication of query
// terms, so a prompt repeating a word scored it twice. Both are gone; `lexTokens`/`bm25` from
// lexical.mjs are the only implementation. k1/b are passed explicitly for the same reason
// hooks/lib/memory-recall.mjs passes them — the inlined arithmetic was 1.2/0.75 and a change to
// bm25()'s defaults must not move this silently.
/**
 * @param {readonly EvalDoc[]} docs
 * @param {readonly string[]} queries
 * @param {number} k
 * @returns {RankedQuery[]}
 */
export function lexicalRank(docs, queries, k) {
  const scored = docs.map((d) => ({ note: d.note, toks: lexTokens(d.text) }));
  return queries.map((q) => {
    const s = bm25(scored, [...new Set(lexTokens(q))], 1.2, 0.75);
    return {
      q,
      results: scored
        .map((d, i) => ({ note: d.note, score: s[i] }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k),
    };
  });
}

/**
 * @param {readonly { rank: number }[]} perCase
 * @returns {{ recall: Record<number, number>, mrr: number }}
 */
export function metrics(perCase) {
  const n = perCase.length || 1;
  /** @type {Record<number, number>} */
  const recall = {};
  for (const k of RECALL_KS)
    recall[k] = perCase.filter((c) => c.rank > 0 && c.rank <= k).length / n;
  const mrr = perCase.reduce((a, c) => a + (c.rank ? 1 / c.rank : 0), 0) / n;
  return { recall, mrr };
}

// The one place a case-set filename is built. It is slug- AND style-scoped because
// $CLAUDE_MEMORY_HOME/eval/ is machine-local and shared by every project on the machine: a name
// without a slug in it belongs to whichever project authored one first, and every other project
// then scores itself against that vault's questions (#97).
//
// One place on purpose. The bug this fixes was a second, hand-written copy of this name drifting
// from the resolver — so a refusal message that spelled the path out again would re-open it.
/** @param {string} dir @param {string} slug @param {string} style @returns {string} */
export function defaultCasesPath(dir, slug, style) {
  return path.join(dir, `eval-cases-${slug}-${style}.jsonl`);
}

// The verdicts goldCoverage() decides. A constant, not a literal: a copy in the producer and
// another in the branch that reads it drift apart in silence, and every test written against the
// copy stays green while the branch goes dead.
export const GOLD = /** @type {const} */ ({
  ok: 'ok',
  churn: 'churn',
  mismatch: 'mismatch',
});

// Below this fraction of gold notes resolving, the case set is not measuring this vault at all.
// Low on purpose: it separates a mismatched CORPUS from ordinary churn, and nothing else. A gold
// note deleted by a prune must stay a warning — `/memory:prune` removed 20 notes on 2026-08-22 and
// none of them was gold, so the legitimate rate is near zero and the floor never has to be tight.
export const GOLD_FLOOR = 0.5;

// The guard `--run` did not have. `--author` has always resolved every gold note and refused a set
// with a missing one; `--run` checked that the case FILE existed and then scored, so a case set
// built from a DIFFERENT vault produced a confident 0% instead of an error. Measured 2026-08-23
// through this code path: 2/32 gold refs resolvable from the unscoped path `/memory:eval` named,
// against 53/53 for the same project's slug-scoped set (#97). The 2 are notes in `permanent/`,
// which is cross-project by design — which is why the floor is a FRACTION and not "any miss".
//
// The REFUSAL reports counts, never note names: the missing notes may belong to another project's
// private vault — the same leak recorded in the mistakes layer when `--stats` printed vault paths
// into a paste-into-issues report. Two limits on that claim, both deliberate. The caller echoes the
// case-set PATH, which is what tells the operator which file to stop using. And the `churn` band
// scores rather than refusing, so the normal misses block prints gold names — that band assumes the
// set is this project's, which below the floor is exactly what stops being true.
/**
 * `gold` is `unknown` because these come from JSON.parse of a file the user pointed us at — the
 * shape is a claim, not a guarantee, and this is the boundary that checks it.
 * @param {readonly { gold?: unknown }[]} cases
 * @param {ReadonlySet<string>} known
 * @returns {{ total: number, resolved: number, fraction: number, verdict: 'ok'|'churn'|'mismatch' }}
 */
export function goldCoverage(cases, known) {
  // Array-guarded, because a case line with no `gold` key flatMaps to `undefined` and counted as an
  // unresolvable ref — which made a malformed file report as another vault's rather than reaching
  // the "names no gold notes at all" branch written for it.
  const gold = cases.flatMap((c) => (Array.isArray(c.gold) ? c.gold : []));
  const resolved = gold.filter((g) => known.has(g)).length;
  // An empty set divides to NaN, and `NaN >= GOLD_FLOOR` is false — but say it, because a case set
  // with no gold at all is a mismatch on purpose, not an accident of the arithmetic.
  const fraction = gold.length ? resolved / gold.length : 0;
  return {
    total: gold.length,
    resolved,
    fraction,
    verdict: fraction === 1 ? GOLD.ok : fraction >= GOLD_FLOOR ? GOLD.churn : GOLD.mismatch,
  };
}
