# `/memory:health` reads what the scans name, not every note

**Date:** 2026-10-12 · **Issue:** #95

## Decision

Step 1 reads `REFLECTIONS.md`, `MEMORY.md`, the notes a step-0 scan names (claim-line form), and
at most 15 `--dupes` pairs from a band just below `dupeMin`. It does not read the whole corpus.
`/memory:prune` step 2 points at the same rule.

## Why not read everything

Measured on the maintainer's vault on 2026-10-12, this repo's slug. Tokens are estimates
(bytes ÷ 4).

| what | notes | bytes | est. tokens |
| --- | --- | --- | --- |
| every note | 1,056 | 947,731 | ~237k |
| same set, claim-line form | 1,056 | 730,522 | ~183k |
| the four step-0 scans' output | n/a | 6,201 | ~1.6k |

The largest slug in that vault has 2,931 notes (~652k est. tokens) — more than one context
window. Claim-line form alone saves about 23%; the saving comes from limiting which notes are read.

## Why the sample is 0.70–`dupeMin`, at most 15 pairs

- **Band (bge-m3 only).** The 2026-08-17 sweep in `/memory:prune` step 2b is the only measurement
  of where real duplicates stop. 0.70 sits just under its first coincidental pair. Two real
  duplicates scored below 0.70, so no band reaches them. No other profile has a sweep, so it gets
  no sample.
- **Cap.** 15 pairs is 30 notes. The 2026-08-22 audit read about 30 of 447 notes beyond the scans
  and found 2 stale claims, 2 tool defects and 26 duplicate pairs, more than the read-everything
  audit of 2026-08-17 found on a corpus 6× smaller (#95).

## Not done

Rotating "notes no audit mentioned in the last K audits" into the read set. Raise it only if the
bounded sample proves too narrow.
