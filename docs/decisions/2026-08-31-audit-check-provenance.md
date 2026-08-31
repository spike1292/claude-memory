# CLAIM-1: a metric needs its instrument, because prose didn't gate it

**Date:** 2026-08-31 · **Status:** shipped · **Issue:** [#36](https://github.com/spike1292/claude-memory/issues/36) PR 2

## What this replaced

`isUnprovenancedMetric()` in `scripts/lib/memory-audit-checks.mjs` flags a METRIC-shaped number
(`recall@5 46.4%`, `MRR 0.289`, ...) that names no instrument — no script, case set, sample size,
or date that produced it. It exists because the alternative, relying on prose and an L1 note to
carry the discipline, recurred as the same failure three times in one cycle:

- **"CLAUDE.md now mandates X"** — the file was never opened.
- **synthesis grade 0.945 vs 0.947** — the test was wrong, not the note.
- **"recall 0.94 / 1.00"** — the question set was rewritten every run (see
  [skills/protocol/SKILL.md](../../skills/protocol/SKILL.md), "No retrieval number without a
  case-set run behind it", for the fuller story — the versioned set measured 0.46, and the inflated
  figure reached five artefacts including a public README before anything caught it).

The vault's own L1 note `instrument-must-match-healthy-signal` already taught this lesson and did
not prevent any of the three recurrences, because prose cannot gate a write. A mechanical check
can: `isUnprovenancedMetric()` flags a metric without provenance before it is written down again.

## Calibration

Deliberately narrow: FRESH-1 already covers a plain count going stale; this covers evaluative
scores specifically, which look authoritative precisely because they are specific, whereas a bare
count is just a fact.

The metric word must sit NEXT TO a value — "filename drift hides coverage" and "ALB coverage → the
EDGE dashboard" use these words descriptively, and only "recall@5 46.4%" or "MRR 0.289" is a claim
about a measurement. The first cut matched the word anywhere on a line containing any digit and was
~80% false positives — the same over-loose first draft as FRESH-1 (133 hits) and the supersession
check (2 of 3 first-pass hits were false). Assume a new check is miscalibrated until its output has
been read line by line.
