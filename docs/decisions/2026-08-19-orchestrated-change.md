# Orchestrating a change: Implement → Verify → Document → Review → Land

**Date:** 2026-08-19 · **Status:** shipped, six runs · **Rewritten from
`docs/plans/2026-08-18-refactor-backlog.md`, deleted when its last run merged**

## Question

The refactor backlog was worked by fanning agents out across batched PRs (#24, #27–#31). The
batching was specific to that backlog and died with it. The **phase order** did not: it changed
three times in response to things that got past a review, and the final shape is reusable. This
records the shape and the evidence, per CLAUDE.md's rule that a plan outliving its execution becomes
a decision record.

## The shape

```
Implement  → per item, parallel where the file sets are disjoint
Verify     → per item, adversarial, pipelined so item A verifies while item B is still written
Document   → changelog, backlog deletion, architecture markers, PR body DRAFTED to a file
Review     → whole-diff: the /code-review two axes, and this repo's CI prompt run locally
Land       → gate, commit, push, PR from the reviewed draft
```

Three orderings in it are load-bearing, and each was bought with a defect.

**`Review` sees the final diff, not the implementers' output.** On #24, two of the three findings in
the second round were *introduced by the first round's fixes*. A review pass is itself a change and
needs reviewing.

**`Document` comes before `Review`.** Both of #24's escapes were prose: a CHANGELOG entry naming
directories the code did not print, and a PR body claiming "110 pass (99 on `main`; the 11 new
ones…)" when `main` had 107 and the diff added 3. Neither sentence existed when its reviewers ran.
Writing the prose first costs nothing — it touches files the code agents have finished with — and it
lets a reviewer check a claim against the diff while both are still editable.

**The PR body is drafted to a file, never composed at push time**, and `Land` writes no new prose. A
body written after the last review is a body nobody reviewed, which is exactly how those numbers
shipped. If `Land` finds itself inventing a sentence, `Document` was incomplete.

**Reviewers diff `git diff main` — two dots, not `main...HEAD`.** Work may be uncommitted when they
run; on run 3 the three-dot range was empty, the reviewers silently fell back to the working tree,
and one flagged it. The review was valid by accident.

## What the six runs taught

- **After a rename or removal, re-grep the whole repo — prose included.** On #28 each round found
  what the previous round's fix left behind: dead imports, then prose the rename missed, then two
  more prose sites, then three older dead imports beside the ones just removed. Every one would have
  been caught by `grep -rn '<old name>' --include='*.mjs' --include='*.md' .`. The cheapest rule
  here: it turns a review round into a search.
- **A known defect gets fixed, or gets a code comment and a test. Never a bullet in the PR body.**
  Three runs disclosed a real defect in prose and shipped it anyway; disclosure reads as diligence
  and still leaves the bug, and a PR body is the one artefact nobody re-reads after merge. The
  legitimate exception has a price: `vault-memory-sync.sh`'s defects genuinely could not be fixed in
  the same PR as its first test, so each carries a `CHARACTERISED, NOT ENDORSED` comment **and** a
  passing assertion. The rule is not "always fix" — it is that prose is never the only record.
- **A characterisation test has to be shown to fail.** A test written against existing code is green
  by construction. Run 5's suite was mutation-checked on a throwaway copy — revert `cp -n` to a
  move, drop the no-merge guard, delete the `cat | jq` line — and the first pass found two mutants
  that survived, one on the line deciding *which* project's symlink gets repointed. Invisible from a
  green run and from reading the file.
- **The suggested fix is not always the right fix.** Two reviewers proposed temp-file + `rename()`
  for `trimLog`'s non-atomic rewrite; both were wrong, because `openLog()` hands detached children an
  `O_APPEND` fd that a rename would strand on an unlinked inode. Findings are input, not
  instructions — reject with reasoning where the reasoning holds.
- **"Breaking" is a claim about the failure mode, not about the schema.** Run 2 was planned as a
  minor bump because it adds a column. The reviewer who killed the forced `--rebuild` was reasoning
  about `semantic-index-refresh` running detached with rows written outside a transaction — a fact
  three files from the diff. A plan's breaking label is a hypothesis for the implementer to test.
- **Verify the instrument before quoting a number from it.** Run 6's item 12 was planned around
  "#29 made `--mode lexical` the same BM25 recall uses". It was not: that mode still carried its own
  tokeniser and BM25, and scores whole notes where the hook scores only the `(card)` chunk — 50%/25%
  against `keywordArm`'s 100%/100% on the same cases. Checking the premise found the fork; a sweep
  run on the assumption would have produced a plausible, precise, wrong number with a comment
  claiming a case set behind it.
- **An item's stated harm can be false while the item is still right.** Item 14 was justified by
  "one vault folder, two source labels", which sounded like one index holding both. context-mode
  partitions per checkout, so that never happened. The real payoff was narrower and better: the
  label became derivable from the note path. Verify a motivating fact against the dependency, not
  against the entry asserting it.
- **Name a new check by what it can see.** Item 11's step proves a `lib/` twin *exists* — an empty
  one passes, and the three fat entries pass. The invariants row therefore reads `CI (partial)`. A
  row claiming `CI` would have retired the question, which is the failure that table exists to
  prevent, introduced by the PR meant to make it more honest.
- **Every PR had been appending its own `### ` heading to `## [Unreleased]`** — seven by run 2,
  `### Fixed` three times among them, in a section that ships as release notes *verbatim*. Each
  agent only ever read the line it inserted after. `Document` now merges into the existing headings.

## Consequences

Agent count roughly doubles per run: one `Document`, two whole-diff reviewers, and a refutation
panel on anything touching a hot path. That is the cost of the ordering, and the escapes above are
what it buys.

The local CI reviewer needs the prompt read at run time —
`node scripts/review-prompt.mjs` — not pasted into a script, or it becomes a third place the
invariants live and drift. See `docs/ci-and-releases.md` for why that prompt stays inline in the
workflow.

**Not carried over:** the conflict map, the per-run diff plans, the cost table and the item text.
All of it shipped, or is in `docs/architecture.md` and the changelog, or — where a plan turned out
wrong — is in the code comment that corrects it, which is where someone will actually meet it.
