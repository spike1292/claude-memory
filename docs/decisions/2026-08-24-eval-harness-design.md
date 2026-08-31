# Why a versioned case set, not hand-written questions per run

**Date:** 2026-08-24 · **Status:** shipped

## Question

Before `scripts/memory-eval.mjs` existed, every `/memory:eval` run hand-wrote a fresh set of
questions. Does a fresh set per run measure a retrieval change, or does it measure something else?

## Answer

Something else. The numbers moved between runs — 0.60 → 1.00 on 2026-08-14 — but the question set
moved too, so the comparison proved nothing. Worse, the questions were written by someone who
already knew the vault and knew what had just been fixed, which biases the set toward the change
being evaluated.

The fix is a versioned case set: generate it once (`--generate`/`--author`), then score every
retrieval change against THE SAME cases (`--run`). Borrowed wholesale from
[obsidian-second-brain's harness](../research/2026-08-21-obsidian-second-brain.md), whose baseline
states the rule plainly: **no retrieval change ships without before/after numbers on the same
cases.** The same rule is restated as a standing norm in `skills/protocol/SKILL.md` and `CLAUDE.md`
— this record is why the tooling exists to enforce it, not the rule itself.

## Consequences

Case sets contain vault content, so they live under `$CLAUDE_MEMORY_HOME/eval/`, gitignored, and
are slug- **and** style-scoped (`defaultCasesPath()` in `scripts/lib/memory-eval.mjs`) — see that
function's own comment for why the scoping itself is a single-place invariant. Regenerating a case
set (`--force`) invalidates every past number recorded against it; a number is only comparable to
another number from the exact same file.
