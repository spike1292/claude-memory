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
// Cases live in ~/.claude/data/eval-cases-<slug>-<style>.jsonl and are GITIGNORED: they contain
// vault content. Regenerate only with --force; a changed case set invalidates every past number.

// The shared lexical vocabulary is the ONLY import here. `node:fs`, `node:path`, `execFileSync`,
// `model-default.mjs` and `paths.mjs` were all imported and none of them referenced — dead since
// the entry/lib split moved the CLI out. Dropped 2026-08-19.
import { bm25, lexTokens } from './lexical.mjs';

export const RECALL_KS = [1, 3, 5, 10];

// ---------------------------------------------------------------- pure helpers (self-tested)

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
export function pickSentence(body, stem, style) {
  const tt = titleTokens(stem);
  const sents = body
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 40 && s.length <= 220 && /[a-z]/.test(s));
  if (!sents.length) return null;
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

export function metrics(perCase) {
  const n = perCase.length || 1;
  const recall = {};
  for (const k of RECALL_KS)
    recall[k] = perCase.filter((c) => c.rank > 0 && c.rank <= k).length / n;
  const mrr = perCase.reduce((a, c) => a + (c.rank ? 1 / c.rank : 0), 0) / n;
  return { recall, mrr };
}
