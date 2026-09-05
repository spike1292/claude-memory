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

## Facts rehomed from the code, 2026-09-05

Moved out of `scripts/lib/memory-eval.mjs`, which had grown more comment than code over three
review rounds. Each is needed when *changing* the harness, not when editing the function it sat
above, which is where the reader-distance rule puts it
([2026-08-23-comment-reader-distance.md](2026-08-23-comment-reader-distance.md)).

**`lexicalRank` scores WHOLE NOTES, and is not a model of the recall hook.** It is a baseline for
the semantic arm, which searches every chunk; the recall hook scores only the `(card)` chunk. On the
bench vault's own cases the two disagree wildly — gold at rank 1 for 50%/25% here against
`keywordArm()`'s 100%/100% (2026-08-19). A number from here says nothing about `MIN_SCORE`. It once
forked its own tokeniser and BM25; `lexTokens`/`bm25` from `lexical.mjs` are the only implementation
now, and `k1`/`b` are passed explicitly so a change to `bm25()`'s defaults cannot move this silently.
See [2026-08-19-orchestrated-change.md](2026-08-19-orchestrated-change.md) ("Verify the instrument
before quoting a number from it") and `docs/architecture.md` ("H6 — text processing is forked three
ways").

**`defaultCasesPath` is the one place a case-set filename is built.** Slug- AND style-scoped because
`$CLAUDE_MEMORY_HOME/eval/` is machine-local and shared by every project on the machine: a name with
no slug in it belongs to whichever project authored one first, and every other project then scores
itself against that vault's questions (#97). The bug it fixed was a second, hand-written copy of the
name drifting from the resolver, so messages quoting a case-set path resolve it through here and
never rebuild it. The `-heldout` suffix (#87) is empty for a tuning set on purpose — every existing
set is one, so an unsuffixed name keeps working with no migration.

**`goldCoverage` is the guard `--run` did not have.** `--author` has always resolved every gold note
and refused a set with a missing one; `--run` checked that the case FILE existed and then scored, so
a case set built from a DIFFERENT vault produced a confident 0% instead of an error. Measured
2026-08-23 through this code path: 2/32 gold refs resolvable from the unscoped path `/memory:eval`
named, against 53/53 for the same project's slug-scoped set (#97). The 2 are notes in `permanent/`,
which is cross-project by design — which is why the floor is a FRACTION and not "any miss". The
floor is low on purpose: it separates a mismatched CORPUS from ordinary churn and nothing else, and
`/memory:prune` removed 20 notes on 2026-08-22 with none of them gold, so the legitimate rate is
near zero.

The refusal reports counts, never note names: the missing notes may belong to another project's
private vault — the same leak recorded when `--stats` printed vault paths into a paste-into-issues
report. Two deliberate limits on that. The caller echoes the case-set PATH, which is what tells the
operator which file to stop using; and the `churn` band scores rather than refusing, so the normal
misses block does print gold names — that band assumes the set is this project's, which below the
floor is exactly what stops being true.

**The mining bounds are empirical.** Under 15 characters is "ok", "yes", "do 1" — no retrievable
content. Over 400 is a pasted log or diff, a document rather than a question. One machine,
2026-09-05: 217458 transcript lines across 1368 files → 3862 human turns → 977 unique candidates. It
is a snapshot that grows with use — the same machine read 3735 turns a day earlier — so re-run
`--mine` rather than quoting it.
