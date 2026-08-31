# Topic clusters exist because a keyword scan cannot see meaning-level duplicates

**Date:** 2026-08-14 · **Status:** shipped

## What the existing scan misses

`memory-audit-checks.mjs`'s Jaccard scan clusters same-folder notes by shared tokens. On
2026-08-14 it reported 0 pairs at or above 0.45 across 987 notes in the vault, while six real
merges sat in that same set — notes restating one idea in different words, invisible to a
token-overlap scan because they share almost no vocabulary:

- "origin owns Cache-Control"
- "cache-control at origin not CloudFront"
- "cache-control source should follow the content source"

This is the same keyword-vs-meaning gap that made `ctx_search` miss paraphrased questions —
a lexical instrument cannot see a semantic restatement.

## What `clusterNotes()` adds

A semantic pass over the vault, purpose-built for a different question than dedup: not "are these
two notes the same lesson" (that is `dupeScore`/`bestDupe`, cosine over CARD vectors, same-layer
only), but **"is there a CONSOLIDATION GAP"** — many notes circling one idea with no `permanent/`
note covering them yet. Two design choices follow from that:

- **Deliberately CROSS-folder**, unlike dedup. A topic is normally a Pattern + a Mistake + a
  Decision about the same underlying thing, and those live in different folders by design.
  Restricting to same-folder would hide exactly the clusters this exists to find.
- **Union-find over the similarity graph, single-linkage.** A chain of related notes (A~B~C, even
  where A and C alone would not clear the bar) forms one topic rather than requiring every pair in
  the group to be mutually similar.

## Evidence it matters

Two clusters — a 9-note cache-policy-quota cluster and a 6-note Cache-Control family — both sat
unnoticed for weeks in the vault before this measurement, because nothing was measuring
cross-folder topical overlap at all.
