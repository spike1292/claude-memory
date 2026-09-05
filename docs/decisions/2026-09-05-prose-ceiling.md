# Comments may not outnumber code, and CI fails when they do

**Date:** 2026-09-05 · **Status:** shipped · **Supersedes:** the "No CI guard" section of
[2026-08-23-comment-reader-distance.md](2026-08-23-comment-reader-distance.md)

## Question

#87 ran three local review rounds. Each answered a finding by fixing the code **and** writing a
comment explaining what had been wrong, so `scripts/lib/memory-eval.mjs` went from 1.17 comment
lines per code line to 1.42 before anyone noticed, and round four then flagged the comments. Is
there a check for that, or does it stay a matter of taste?

## Answer

A ceiling of **1.00**, enforced, on the files a change touches. `npm run prose` locally, a CI step on
every PR. A **0.75 warning band** below it prints and does not fail, so a file arrives at the ceiling
announced rather than by surprise.

2026-08-23 declined exactly this, and the objection was good: a length test fires on the
load-bearing blocks first, and several of those are the only record of a silent failure. The answer
is that **a fact worth keeping has a home**. If it is needed by whoever edits that function, it stays
and something else goes; if it is only needed when *changing the design*, it moves to
`docs/decisions/` or `docs/architecture.md`. Deleting it is not the fix and the failure message says
so. This is the same rule 2026-08-23 already set — the ceiling only makes it a deadline.

Maintainer's call, 2026-09-05: *"it should fail in ci. comments should not be more then code."*

## Scope: a ratchet, not a sweep

**Nine files were over and eight more were in the warn band on 2026-09-05**, from 3.00
(`scripts/env.mjs`) down. That count is here and nowhere else — it changes with every cut, so
anywhere else it would be a copy going stale, which is the drift this whole PR was about. They are
not rewritten. The gate reads only files the diff
touches, so each gets cut by whoever next has reason to be in it. `node scripts/prose-guard.mjs
--all` prints the backlog and never fails, because a ratchet that fails on code nobody touched is a
ratchet everybody disables.

`*.test.mjs` is exempt. A test's comment is the failure it pins, which is the one place restating
the code earns its keep.

## What was tried first and deleted

A conflicting-measurement **scanner**: extract every number of three digits or more from prose, take
its nearest content words as a subject signature, and fail when one subject carries two values. It
was built, and then run against `28e19c8` — the commit that actually held `142` vs `143` unique
prompts and `3227` vs `3862` turns.

**It found 0.** The signature is phrasing-sensitive; the same quantity appeared as `raw turns user`,
`machine real turns` and `candidates human turns`, three subjects. The one true `142`/`143` pair sat
on a single line, which its own "two numbers on one line is a comparison" rule suppressed. Whole-repo
it reported 13 conflicts, all years, file paths and unrelated literals.

CLAUDE.md's rule is that a scan-based guard must assert it found something. This one could not, and a
guard that misses the case it was written for is worse than none — it is a green check that proves
nothing. Judging "are these two numbers the same claim?" needs a reader, so it went to the reviewer
prompt in `claude-review.yml` instead, which had already caught all four unaided.

## Consequences

The deterministic half measures volume and does it for free. The judgement half — one home per fact,
and a comment restating what a named test already pins — is two clauses in the review prompt. Neither
replaces the cut pass in CLAUDE.md; the ceiling is what makes skipping it visible.
