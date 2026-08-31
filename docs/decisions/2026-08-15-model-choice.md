# Model choice: why vector search, the EN/NL comparison, batch/padding, and bge-m3's two false disqualifications

**Date:** 2026-08-15 · **Status:** shipped

## Why a vector search arm at all

`ctx_search` is BM25 over FTS5, keyword-only. A question that shares no *distinctive* term with the
note simply cannot match — "firewall" never reaches `WAF`, "short outage" never reaches `cutover`,
and generic words ("production", "monorepo") are weighted to nothing. Measured 2026-08-14: 8 such
questions scored 0/8 verbatim. Query expansion recovered 6/8 but depends on the agent remembering to
expand; matching by meaning (a vector arm) does not have that dependency.

## The EN/NL model comparison

Measured on two versioned case sets (28 EN authored paraphrases, 15 NL). Current config (bge-m3,
cls pooling, batch 1, alias chunks):

```
                 EN @1    EN @5    EN MRR  |  NL @1    NL @5    NL MRR  | full build
  bge-m3         35.7%    67.9%    0.479   |  46.7%    86.7%    0.617   |  ~5.7 min <- default
  bge-small-en   32.1%    53.6%    0.415   |  33.3%    40.0%    0.354   |  ~51 s
  e5-multi       10.7%    46.4%    0.273   |  26.7%    66.7%    0.425   |  ~96 s
```

The bge-small/e5 rows predate the pooling, batch and alias-chunk fixes and are **not comparable
figures** — they are what those models scored when they were the default, kept for history. Any
real comparison needs a rebuild per model, which per-model indexes now make affordable.

Sample sizes are small: one EN case is 3.6 points, one NL case 6.7. Read MRR and direction, not
single-point moves.

## Why bge-m3 was almost disqualified for the wrong reasons

DEFAULT = bge-m3 since 2026-08-15. It was rejected twice before that, and **both rejections were
bugs in the harness, not the model**:

1. "Too slow" — its profile carried `maxChars` 4000 while every other model had 1800, so it alone
   processed the long tail at quadratic attention cost. At equal length it is 9.6x bge-small, below
   its 17x parameter ratio. Aligned: 3.8h extrapolated → 7 min actual. Benchmarked at EQUAL length
   it is 9.6x bge-small (384ms vs 40ms per 1800-char text), below its 17x parameter ratio. Aligned
   to 1800 so the A/B varies the model and nothing else.
2. "Worse retrieval" — mean pooling on a CLS-trained model. @5 25.0% → 67.9% once fixed (see
   `CLAUDE.md` "Model profiles are not interchangeable" for this figure).

Both failures were silent. Neither raised an error; both produced numbers that looked like a
verdict on bge-m3. A model does not get disqualified until the thing measuring it is checked.

One index PER MODEL, not per vault, is what makes re-litigating this cheap: comparing two models
used to cost a full rebuild in each direction, which is why the cost objection above was never
re-tested until the harness bug was found. Suffixed DBs make a build a one-off you keep, so a model
can be re-litigated for the price of an eval run instead of a full rebuild each direction.

## bge-m3: duplicate-threshold calibration

`dupeMin`/`clusterMin` MEASURED 2026-08-17, and they were badly wrong before that: they had been
copied from e5-multi (0.95/0.92) and never calibrated, which made both scans report a clean vault.
Sweep over the 74-note claude-memory Insights set, against which a `/memory:health` audit had already
hand-identified 16 same-lesson pairs:

```
--dupes --min   0.95  0.90  0.86  0.84  0.80  0.75      --clusters --min  0.92 .. 0.76  0.72
pairs              0     0     1     6     9    16      topics               0 .. 0       2
```

Real duplicates occupy 0.75-0.869; the first coincidental pair appears at 0.714. m3's band sits LOW
and wide, the opposite of e5-multi's high narrow one — which is exactly why the number does not
transfer, in either direction. At 0.95 the scan found 0 of 16.

`clusterMin` 0.72 is its own measurement, not `dupeMin` scaled: at 0.76 and above `--clusters`
returned nothing, at 0.72 it surfaced two real uncovered topics (shell-vs-Node fork cost;
conventional-commit version derivation), both with a typical-member similarity of ~0.89.

Two real duplicates in that set scored BELOW 0.70 and no threshold would have found them; they were
caught by reading. This scan proposes, the human judges — do not read a clean run as proof.

The code keeps the numbers and their date at the `bge-m3` profile
(`scripts/lib/models.mjs`): `dupeMin 0.75 / clusterMin 0.72 measured 2026-08-17 — do not copy or
scale from e5-multi, m3's similarity band sits low and wide, the opposite of e5-multi's high narrow
one, and neither direction transfers.`

## Batch size and padding

Batching pads each text to the longest in its group and the padding CHANGES the output. Measured
2026-08-15, same string alone vs batched: bge-m3 cosine 0.986, bge-small 0.9966, e5 0.9973 — all
three fail. Competing notes in this index sit ~0.001 apart, so a 0.014 shift does not perturb a
ranking, it decides one, and a vector's value came to depend on which unrelated notes shared its
batch. It surfaced as two rebuilds of BYTE-IDENTICAL notes scoring differently and was one sentence
away from being written up as "run-to-run noise" — which would have set a permanent fake noise floor
under every future A/B. Batching also loses on speed with real notes (0.14 s/chunk unpadded vs 0.28),
because padding makes short chunks cost as much as the longest one beside them; the benchmark that
said otherwise used equal-length strings, which never occur in a vault.

The code keeps one line with the load-bearing number and its date (`scripts/lib/models.mjs`, above
`MODELS`): `BATCH SIZE IS 1 FOR EVERY MODEL, deliberately ... padding shifts a vector 0.014 where
competing notes sit ~0.001 apart (2026-08-15)`.
