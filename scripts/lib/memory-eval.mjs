#!/usr/bin/env node
// Logic half; the CLI entry is scripts/memory-eval.mjs.
// Reproducible retrieval eval for the vault. Generates a versioned case set once, then scores any
// retrieval change against THE SAME cases — why a versioned set replaced hand-written questions:
// docs/decisions/2026-08-24-eval-harness-design.md.
//
// Usage:
//   node memory-eval.mjs --author < cases.jsonl          the way to make a REAL paraphrase set
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
import { createHash } from 'node:crypto';
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
// hook (that one scores only the `(card)` chunk) — read that before quoting a number from here at
// the hook. The 50%/25% vs `keywordArm()`'s 100%/100% gap this caused, and the fork of its own
// tokeniser/BM25 this replaced, are recorded in docs/decisions/2026-08-19-orchestrated-change.md
// ("Verify the instrument before quoting a number from it") and docs/architecture.md ("H6 — text
// processing is forked three ways").
//
// `lexTokens`/`bm25` from lexical.mjs are the only implementation now. k1/b are passed explicitly
// for the same reason hooks/lib/memory-recall.mjs passes its BM25 constants explicitly: a change to
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

// An unscorable case stays in the denominator: the printed recall must not quietly improve by
// dropping the cases the instrument could not measure. Counting them is the CALLER's, over the
// whole set including pairwise cases, which this function does not see — a count here would be a
// second definition of one quantity over a different population.
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
// One place on purpose: the bug this fixes was a second, hand-written copy of this name drifting
// from the resolver. Messages that quote a case-set path resolve it through here, never rebuild it.
//
// The KIND suffix arrived with #87 and is empty for a tuning set on purpose: every existing set is a
// tuning set, so an unsuffixed name keeps working with no migration and no re-authoring. A held-out
// set gets its own file because a shared one is a set a tuning run can reach by accident, and the
// whole guarantee is that it cannot.
/**
 * @param {string} dir
 * @param {string} slug
 * @param {string} style
 * @param {string} [kind]
 * @returns {string}
 */
export function defaultCasesPath(dir, slug, style, kind = KIND.tuning) {
  // Throwing, not defaulting: `--kind holdout` silently scoring the TUNING set would report a
  // number the operator reads as held out, which is worse than no number at all.
  if (kind !== KIND.tuning && kind !== KIND.heldOut)
    throw new Error(`unknown case-set kind ${kind} — use ${KIND.tuning} or ${KIND.heldOut}`);
  return kind === KIND.heldOut
    ? path.join(dir, `eval-cases-${slug}-${style}${HELD_OUT_SUFFIX}`)
    : path.join(dir, `eval-cases-${slug}-${style}.jsonl`);
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
 * @returns {{ total: number, resolved: number, verdict: 'ok'|'churn'|'mismatch' }}
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
    verdict: fraction === 1 ? GOLD.ok : fraction >= GOLD_FLOOR ? GOLD.churn : GOLD.mismatch,
  };
}

// ---------------------------------------------------------------- mine

// Held-out questions have to come from somewhere nobody could have fitted them to. Claude Code
// transcripts are that source: prompts typed months before any tuning run, in the words the user
// actually used. Authored paraphrases are not — this repo shipped inflated figures to five
// artefacts because the questions moved with the result (#87).
//
// The bounds are empirical, from 3227 raw user turns across 26 transcript folders (2026-09-04).
// Under 15 chars is "ok", "yes", "do 1" — no retrievable content. Over 400 is a pasted log or
// diff, which is a document, not a question.
export const MINE_MIN = 15;
export const MINE_MAX = 400;

// Prompts that are plumbing rather than speech. `tool_result` and `system-reminder` arrive as user
// turns because that is how the harness threads them; `Caveat:` is Claude Code's own resumed-
// session banner. None was typed by a human.
const MINE_NOISE = /Caveat:|tool_result|system-reminder/;

/**
 * A parsed transcript record -> the human's prompt, or null when the record is not one.
 *
 * Split from the line form so the caller can count TURNS without parsing twice. The tally has to
 * separate "lines read" from "user turns seen": a transcript is mostly assistant and tool records,
 * so reporting lines as turns overstates the pool by two orders of magnitude — 212043 lines against
 * 3227 real turns on this machine (2026-09-04). An estimate printed like a measurement is the
 * failure this whole case-set effort exists to stop.
 *
 * @param {any} o
 * @returns {string|null}
 */
export function mineTurn(o) {
  const t = mineText(o);
  if (t.length < MINE_MIN || t.length > MINE_MAX) return null;
  // A slash command is an instruction to the harness, and `<` opens an injected XML payload. Both
  // are the leading character on purpose: `/memory:eval` is noise, "what does /memory:eval do" is
  // a question, and only the position tells them apart.
  if (t.startsWith('/') || t.startsWith('<')) return null;
  if (MINE_NOISE.test(t)) return null;
  return t;
}

/**
 * The speech in a record, normalised, or '' when it carries none.
 *
 * Empty is the signal that separates a HUMAN turn from a tool result: both arrive as `type: user`,
 * because that is how the harness threads a tool's answer back. Counting tool results as turns
 * reported 37878 where the machine holds ~3227 human ones (2026-09-04) — the same overstatement as
 * counting lines, one level down.
 *
 * @param {any} o
 * @returns {string}
 */
function mineText(o) {
  const c = o.message?.content;
  // Content is a bare string on older transcripts and a content-block array on newer ones. Only
  // `text` blocks are speech; a `tool_result` block in the same array is the harness talking.
  const raw =
    typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c
            .filter((p) => p?.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join(' ')
        : '';
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Is this record a human turn at all? The turn/prompt split is what makes the dropped count mean
 * "a human said this and we rejected it" rather than "this file has assistant records in it".
 *
 * @param {any} o
 * @returns {boolean}
 */
const isUserTurn = (o) => o?.type === 'user' && !o.isMeta && mineText(o) !== '';

/**
 * One transcript JSONL line -> the human's prompt, or null when the line is not one.
 *
 * Returns null rather than throwing on unparseable input: a transcript is an append log that can
 * be truncated mid-write, and one bad tail line must not cost the other 3226.
 *
 * @param {string} line
 * @returns {string|null}
 */
export function minePrompt(line) {
  const o = mineParse(line);
  return o && isUserTurn(o) ? mineTurn(o) : null;
}

/** @param {string} line @returns {any} */
function mineParse(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Fold transcript lines into a candidate set, deduplicating on the prompt text.
 *
 * `seen` is the caller's, because deduplication has to span FOLDERS and not just files: the same
 * sessions appear under more than one cwd-slug when a home directory is renamed. Measured
 * 2026-09-04 — mining two such folders separately reported 142 unique each where the pair holds
 * 142 between them, so a per-folder Set would have doubled the apparent pool.
 *
 * @param {Iterable<string>} lines
 * @param {Set<string>} seen mutated
 * @returns {{ lines: number, turns: number, kept: number }}
 */
export function minePrompts(lines, seen) {
  let count = 0,
    turns = 0,
    kept = 0;
  for (const l of lines) {
    count++;
    const o = mineParse(l);
    if (!o || !isUserTurn(o)) continue;
    turns++;
    const q = mineTurn(o);
    if (!q || seen.has(q)) continue;
    seen.add(q);
    kept++;
  }
  return { lines: count, turns, kept };
}

// ---------------------------------------------------------------- set kind, gate, pairwise (#87)

// A tuning set may be fitted to; a held-out set may not. The distinction is only worth anything if
// it is mechanical, so it lives in the FILENAME and in every report — not in a convention someone
// remembers. Constants, not literals: a copy in the resolver and another in the reporter drift
// apart in silence.
export const KIND = /** @type {const} */ ({ tuning: 'tuning', heldOut: 'held-out' });

const HELD_OUT_SUFFIX = '-heldout.jsonl';

/**
 * The kind of the case set actually being read, from its resolved path.
 *
 * Reported kind comes from the FILE, never from `--kind`, because the two can disagree: `--cases`
 * names a path outright, so `--kind held-out --cases <a tuning set>` would otherwise print a tuning
 * number under a held-out label — the exact mislabelling the kind exists to prevent, reached by the
 * override path instead of by a typo.
 *
 * @param {string} p
 * @returns {string}
 */
export function kindOfPath(p) {
  return p.endsWith(HELD_OUT_SUFFIX) ? KIND.heldOut : KIND.tuning;
}

// Why a case produced no number at all. Each is a broken instrument, not a bad result, and the gate
// treats them as blocking for that reason: SkillOpt's ungated run lost 52.8 points by acting on
// scores it should have refused (docs/decisions/2026-09-04-eval-gate.md).
export const UNSCORABLE = /** @type {const} */ ({
  gold: 'a gold or owner note named by this case is not in the vault',
  empty: 'retrieval returned nothing for this question',
  score: 'a returned result carries a non-finite score',
});

/**
 * Can this case yield a number at all? Null means yes — including "yes, and the gold note lost".
 *
 * @param {{ gold?: unknown, owner?: unknown }} c
 * @param {readonly { note: string, score?: number }[]} results
 * @param {ReadonlySet<string>} known
 * @returns {string|null}
 */
export function unscorableReason(c, results, known) {
  if (!results.length) return UNSCORABLE.empty;
  if (results.some((r) => r.score !== undefined && !Number.isFinite(r.score)))
    return UNSCORABLE.score;
  // `some` for gold, `every` for owner, and the asymmetry is the point. `gold` is a DISJUNCTION
  // everywhere else — `c.gold.includes(r.note)` scores a hit on ANY member — so one pruned member
  // leaves the case perfectly scorable, and the `some(!known)` this replaces reported a case that
  // ranked 1 as unmeasurable, then blocked the gate on it. `owner` is a single ref naming the note
  // that must win, so losing it loses the assertion outright.
  const gold = Array.isArray(c.gold) ? c.gold : [];
  if (!gold.some((g) => known.has(g))) return UNSCORABLE.gold;
  if (c.owner && !known.has(String(c.owner))) return UNSCORABLE.gold;
  return null;
}

/**
 * A pairwise case: the question belongs to `owner`, and `gold` names the note that must NOT win it.
 *
 * The owner has to be FOUND, not merely ahead. A question matching nothing satisfies "the named
 * note did not win" and would score as a pass — a case that passes precisely when retrieval is
 * broken. The `Infinity` sentinel is what makes that impossible, rather than a separate guard on
 * the owner: `named` is at most Infinity, so an absent owner can never compare less than it.
 *
 * @param {{ gold: readonly string[], owner: string }} c
 * @param {readonly { note: string }[]} results
 * @returns {{ owner: number, named: number, pass: boolean }}
 */
export function pairwise(c, results) {
  /** @param {string} n @returns {number} */
  const rankOf = (n) => {
    const i = results.findIndex((r) => r.note === n);
    return i < 0 ? Infinity : i + 1;
  };
  const owner = rankOf(c.owner);
  const named = Math.min(...c.gold.map(rankOf), Infinity);
  return { owner, named, pass: owner < named };
}

/**
 * The accept/reject rule, as a list of reasons to reject. Empty means accept.
 *
 * Separate from the reporting path because a report and a gate answer different questions: `--run`
 * with no floor prints a number and exits 0, which is what every existing caller does. A floor is
 * opt-in, and asking for one is what turns unscorable cases from a warning into a refusal.
 *
 * @param {{ recall1: number, minRank1: number|null, unscorable: number, pairFails: number,
 *   recallCases: number }} x
 * @returns {string[]}
 */
export function gateFailures({ recall1, minRank1, unscorable, pairFails, recallCases }) {
  const out = [];
  // A pairwise case is an ASSERTION, not a metric, so it fails the run whether or not a floor was
  // asked for. No existing case set has an owner field, so this changes nothing for any caller.
  if (pairFails) out.push(`${pairFails} pairwise case(s) failed: the owner did not outrank`);
  // Unscorable blocks only under a floor, and the reason is the `churn` band: a gold note removed
  // by a prune is unscorable and has always been reported as a warning and scored past
  // (goldCoverage above). Refusing it unprompted would break every plain `--run`. Asking for a
  // floor is asking for an accept/reject decision, and that decision is the one that must fail
  // closed — docs/decisions/2026-09-04-eval-gate.md.
  if (minRank1 == null) return out;
  if (unscorable)
    out.push(`${unscorable} unscorable case(s) — the set did not measure them, so it did not pass`);
  // A set of only pairwise cases has NO recall cases, and `metrics()` divides by `|| 1`, so the
  // floor was compared against a 0 that nothing had measured — "0 cases · recall@1 0.0% · GATE
  // FAILED" on a set where every assertion passed. A floor over an empty population is not a score.
  if (!recallCases) return out;
  if (recall1 < minRank1)
    out.push(
      `recall@1 ${(recall1 * 100).toFixed(1)}% is below the floor ${(minRank1 * 100).toFixed(1)}%`,
    );
  return out;
}

/**
 * The identity of a case set, publishable where its contents are not.
 *
 * A held-out set stays machine-local because it carries vault content, so "it was not edited to fit
 * the result" cannot be shown by publishing it. A hash can be quoted in an issue or a decision
 * record and checked later against the file. `trimEnd` so a trailing newline added by an editor is
 * not a different set.
 *
 * @param {string} text
 * @returns {string}
 */
export function casesHash(text) {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n').trimEnd()).digest('hex');
}
