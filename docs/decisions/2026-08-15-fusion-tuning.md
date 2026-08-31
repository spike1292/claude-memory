# Retrieval fusion: why it exists, the weight, and the lexical-scoring mode

**Date:** 2026-08-15 · **Status:** shipped

## Why fusion exists at all

The vector arm and the BM25 keyword arm miss DIFFERENT notes. Measured on the real vault: of 7 EN
cases the vector arm missed, keyword search finds 4 — all of them identifier-shaped (a CLI note, a
ticket key, two dated commit-style titles). NL: 1 of 2. That is the ceiling fusion is reaching for,
and it includes `cra2-ecs-runtime-facts`, which sat outside the top 40 semantically and survived
two other attempted fixes before fusion caught it.

## The fusion weight (`DEFAULT_FUSE_W`)

Swept on both real-vault case sets (28 EN authored paraphrases, 15 NL):

| w | EN@1 | EN@5 | EN MRR | NL@1 | NL@5 | NL MRR |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 0 (off) | 35.7 | 67.9 | 0.479 | 46.7 | 86.7 | 0.617 |
| 1 | 39.3 | 75.0 | 0.558 | 40.0 | 80.0 | 0.558 — best EN MRR, but NL regresses |
| **2** | 39.3 | 82.1 | 0.547 | 46.7 | 86.7 | 0.628 — **chosen** |
| 4 | 32.1 | 85.7 | 0.516 | 40.0 | 86.7 | 0.592 — best EN@5, both @1 regress |
| 20 | 35.7 | 71.4 | 0.505 | 46.7 | 86.7 | 0.633 |

Chosen on "no column regresses on either language", which only `w=2` satisfies. It buys EN@5
67.9 → 82.1 (+4 cases, exactly the headroom the channel-disagreement analysis predicted) and
leaves Dutch alone, where the vector arm was already strong.

**`w=20` is `obsidian-second-brain`'s swept value and is WORSE here on every EN column.** Their
number was measured on their vault with their fusion formula; the sweep methodology transfers, the
weight itself does not. Re-sweep after any model change — `DEFAULT_FUSE_W` is now the fifth
per-setup parameter measured this way, after pooling, dedup threshold, chunk size and batch.

## RRF over a weighted sum

`fuseRRF()` is Reciprocal Rank Fusion, not a weighted sum of scores. Cosine sits in a narrow
~0.4-0.7 band while BM25 is unbounded, so summing them needs a normaliser, and a normaliser is one
more thing that would be silently per-model. RRF consumes RANKS instead, so it cannot be broken by
a model with a compressed similarity band — which is exactly how `e5-multi` failed under a
weighted-sum approach. `RRF_K=60` flattens the top of the curve so rank 1 vs 2 is not a landslide.

## The lexical-scoring mode (`DEFAULT_FUSE_LEX`)

`'chunk'` scoring (score each chunk independently, best-chunk-per-note wins) was chosen over
`'note'` scoring (concatenate a note's chunks, then score the whole thing) by measurement. `'note'`
was tried on the hypothesis that a long note whose query terms are spread thin across chunks would
fare better scored whole. It is worse everywhere, at every weight, and it mauls Dutch:

- EN@1: 39.3 → 32.1
- EN MRR: 0.547 → 0.506
- NL@1: 46.7 → 26.7
- NL MRR: 0.628 → 0.515

Whole-note BM25 rewards length — more terms, more chances to match — so long generic notes displace
short precise ones, and a Dutch query matching few terms is exactly where length normalisation
matters most. It also did NOT rescue `cra2-ecs-runtime-facts`, the note the hypothesis was built
around. Kept as an option (`MEMORY_FUSE_LEX=note`) so the negative result stays reproducible.
