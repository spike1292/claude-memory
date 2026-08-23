# The distiller dedups against embeddings, not word overlap

2026-08-23. Supersedes the body-arm calibration of 2026-08-17. Issue #93.

## What was there

`findNearDuplicate()` scored a new Insight note against existing same-folder notes with two arms,
each divided by its own threshold so a single `>= 1` gate could compare them:

- **slug Jaccard** over filename tokens, bar `RECONCILE_AT = 0.45`
- **body containment** over prose tokens, bar `RECONCILE_BODY_AT = 0.40`

The body arm was added on 2026-08-17 after the first `/memory:health` audit found 16 same-lesson
pairs the slug arm had let through. Its calibration, preserved verbatim because it is the reason
anyone would reach for containment again:

| arm | caught | false merges |
| --- | --- | --- |
| slug Jaccard >= 0.45 | 0/16 | 0/7 |
| body Jaccard >= 0.25 | 6/16 | 0/7 |
| body containment >= 0.40 | 11/16 | 0/7 |

Measured against those 16 pairs plus 7 the audit judged complementary and must not merge.

Jaccard lost because the pairs differ in LENGTH: a two-sentence note restating a six-sentence one
shares most of its own vocabulary but a small fraction of the union, so the denominator buries it.
Containment divides by the smaller set and asymmetry stops being a penalty.

`0.40` rather than the `0.30` that would have caught 15/16: the highest complementary pair scored
`0.286`, so `0.40` kept a `0.114` margin where `0.30` left `0.006`. The costs were judged
asymmetric — a false merge folds one lesson into another and deletes the distinct one, a miss only
leaves a duplicate for `/memory:prune`.

## Why it was wrong

Duplicates kept arriving at the same rate. `/memory:health` on 2026-08-22 found **26 same-folder
pairs** at or above the calibrated bge-m3 `dupeMin` of `0.75`; **24 of the 26 were written after
the body arm landed**.

Swept over all 33,994 same-folder pairs in the 447-note Insights corpus, against a truth set of the
25 in-scope pairs:

| bar | fires | caught | false |
| --- | --- | --- | --- |
| **0.40 (shipped)** | 9 | **0 / 25** | 9 |
| 0.35 | 38 | 6 / 25 | 32 |
| 0.30 | 126 | 14 / 25 | 112 |
| 0.25 | 403 | 17 / 25 | 386 |
| 0.20 | 1322 | 18 / 25 | 1304 |

**The shipped bar caught nothing and all nine of its firings were false positives.** There is no
threshold that works, because the classes do not separate. Real duplicates score as low as `0.115`:

```
idx 0.821  body 0.115   mutation-testing-as-proof-of-guard-effectiveness / mutation-testing-proves-test-validity
idx 0.808  body 0.150   one-shared-writer-prevents-silent-divergence / single-shared-appender-prevents-log-schema-drift
idx 0.862  body 0.357   hardcoded-list-counts-in-comments / hardcoded-counts-in-prose-beside-lists-drift-silently
```

The 2026-08-17 measurement was not wrong about its own 16 pairs — it was measured on the pairs the
slug arm had already failed to catch, which is a different distribution from the one the arm meets
in production. **11/16 on the set that motivated the change did not survive contact with the corpus.**

`bodyTokens()` yields ~30 tokens per note. Two notes stating one lesson in different words overlap
lexically almost not at all, which is precisely the case the arm existed to catch. Word overlap is
the wrong instrument at this length, and no constant fixes an instrument.

## What replaced it

Embeddings, which the semantic index already holds and which score every one of these pairs at
0.78–0.87. This is what the 2026-08-17 REFLECTIONS entry prescribed — "compare bodies **or
embeddings, which the semantic index already holds**" — and only the lexical half was built.

The 2026-08-17 comment deferred it on the grounds that it "means reindexing BEFORE this check
instead of after". **That premise was wrong.** The new note does not have to be in the index; it is
embedded as a candidate and compared against indexed cards. No re-index, no added SessionEnd
latency beyond one socket round trip against a server that is already resident.

Three things the replacement had to carry that the arm did not:

- **One shared predicate.** Raw cosine over card chunks, same layer, `>= PROFILE.dupeMin`. The
  write-time check and the `--dupes` audit call the same function, because an audit that defines
  duplicates differently from the writer cannot serve as its acceptance check. Note that the query
  path's score is NOT this quantity: it is RRF-fused with BM25 and is `0` for keyword-only hits.
- **Same-run comparison.** The index is rebuilt after a distillation, so notes written seconds ago
  are invisible to it. Two insights restating one lesson in one run were being written as two notes
  every time — observed twice on 2026-08-22, where a reconcile fired against an existing note AND a
  fresh note was written for the same event. An in-memory list of this run's `{note, vec}` closes it.
- **An opt-out.** Correctly cross-linking two distinct notes RAISES their similarity:
  `equivalence-testing-over-survival-testing` / `mutation-testing-proves-test-validity` moved
  `0.754 → 0.762` when an audit added the back-link, crossing the `0.75` bar. The 2026-08-17 audit
  saw the same effect on the release-versioning pair. Without a way to record "this boundary is
  deliberate", the act of relating two notes correctly pushes them toward being merged.

`reconcile: manual` is note-scoped rather than pair-scoped, and blocks BOTH arms. Pair-scoped was
considered and rejected: at write time the incoming note is neither end of any previously judged
pair, so a pair marker would have been dead code until #100's periodic scan landed. Note-scoped
works in both paths — a scan checks whether either end is marked.

## The bar

`PROFILE.dupeMin` directly, with no higher write-time margin. The asymmetric-cost argument from
2026-08-17 still holds, but a second constant would be a second per-model calibration AND would
mean the sweep measures a bar the distiller does not use. The opt-out is a human judgement where a
margin would be a guess.

## Do not re-derive

If you are reaching for token overlap on note bodies again: it was measured twice, and the second
measurement is the one taken on the real distribution. **0 of 25.**
