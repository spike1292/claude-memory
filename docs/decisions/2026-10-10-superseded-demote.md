# `SUPERSEDED_DEMOTE` = 0.9, chosen without a cost signal

2026-10-10 — settles [#163](https://github.com/spike1292/claude-memory/issues/163).

## What it is

`searchIn()` multiplies a superseded chunk's score by `SUPERSEDED_DEMOTE` in both arms, for ordering
only. The returned `s` stays raw cosine, so the recall gate is unaffected by any value here.

## The sweep

Synthetic vault, seed 7, `--notes 300`, bge-m3, `cases-supersede.jsonl` (`tuning`):

| Value | Passed |
| ----- | ------ |
| 1 (off) | 5/8 |
| 0.99 | 6/8 |
| 0.98, 0.97, 0.95, 0.93, 0.9, 0.8, 0.7, 0.5 | 8/8 |

A real `tuning` set (16 cases) scored identically at 1, 0.9 and 0.5. A real `held-out` set (24
cases, sha256 `1b2dee1ec1981c58bc58e7803775ad2c846347ecbc5771148a15696e1605fbf3`) was scored once at
1 and once at 0.9, not swept, and scored identically.

## Why 0.9

The data bounds the value from above (≤ 0.98) and not from below. The cost of a value too low is
real but unmeasured: a multi-claim note whose card or alias chunk inherits one marker falls below
weaker notes on its still-true claims. 0.9 sits clear of the 0.98 edge without pushing further than
the evidence asks.

Re-sweep when a case set exists that measures that cost — a question answered by the still-true
section of a note that also carries a marker.
