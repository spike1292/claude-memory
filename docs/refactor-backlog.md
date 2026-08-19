# Refactor backlog

Small, atomic, independently mergeable tasks, ordered by **impact per hour**.

Where this came from: an audit of the gaps recorded in
[architecture.md](architecture.md) — its "how things really work" half names the problems, this
file names the fixes. Every item traces to a `G`/`B`/`H`/`R` marker there.

Written 2026-08-18 against `e16c41d`. **Delete items as they land** rather than marking them done;
the changelog is the record of what shipped. If an item is declined, keep it with a one-line reason
so it is not rediscovered as a good idea later (see item 15).

---

## Wave 1 — make silent failures loud

The cheapest items in the repo, all attacking one class: things that fail without saying so.

> **Item 1 (delete the shell index lock) landed in #20** and is deleted from this list, per the rule
> at the top. It closed `H12` and `R2`. Numbering below is unchanged so that references to items by
> number in commits and PRs keep resolving.

> **Items 2, 3 and 4 (state sizes in `doctor.sh`, the log cap, `chmod 0600` on the socket) landed
> in #24** and are deleted from this list, per the rule at the top. Between them they turn `R5`
> from unbounded into observed and close the auth analogue. Wave 1 is finished; numbering below is
> unchanged.

---

## Wave 2 — index correctness

> **Item 5 (stop keying staleness on mtime alone) landed in #27** and is deleted from this list,
> per the rule at the top. It closed `R1`. The one deviation from the plan written here: the `hash`
> column does **not** force a one-time `--rebuild`. An index built before it holds this model's
> vectors and answers as well as it ever did, so `--index` backfills the hashes in place from the
> notes whose mtime it already trusts — seconds of I/O instead of an unattended 20-40 min re-embed
> on every existing install. Not breaking; no minor bump on that account.

> **Item 6 (`'(card)'` becomes a constant) landed on 2026-08-19**, with item 8, and is deleted from
> this list, per the rule at the top. It narrowed `R4` and left one bare literal in
> `hooks/memory-recall.mjs`; **item 7 took that site and closed `R4`** the same day. Wave 2 is
> finished; numbering below is unchanged.

---

## Wave 3 — the missing seam

> **Item 7 (give `memory-recall.mjs` a `lib/` twin) landed on 2026-08-19** and is deleted from this
> list, per the rule at the top. It closes `G1`'s last hole — `hooks/memory-recall.mjs` is 153 lines
> of stdin, socket, `node:sqlite` and stdout over a 148-line `hooks/lib/memory-recall.mjs`, which has
> the repo's first test of the prompt path. It closes `R4` for real: the SELECT binds `CARD`. It
> resolves three of `H6`'s four forks — `STOP`, the tokeniser and BM25 now come from
> `scripts/lib/lexical.mjs`, and the two implementations were equivalent, so no ranking moved.
> **The measured price is +0.5 to +0.9 ms of module init on every prompt** (local APFS; the hook
> reads `$CLAUDE_MEMORY_HOME`, never the cloud-backed vault), gate exits included
> (8 runs, warm, marginal after `paths.mjs`, which the entry loads anyway) — and end to end,
> spawn to close, +0.5 to +1.7 ms on the fastest of 20 gate-exit runs across three alternating
> passes against `main`, with the medians inside the noise, on a ~37 ms Node-startup floor. Item 6
> deferred this site on the assumption the cost would be material and it is not — but the reason
> the four live in their own import-free module rather than in `scripts/lib/memory-semantic.mjs`
> is not the 3.8-4.4 ms that one costs to import. It is that a hook entry imports its `lib/` twin
> statically,
> above the fail-open try and above the arming gate, and `memory-semantic.mjs`'s module scope does
> `console.log` + `process.exit(1)` on an unknown model — a line on the hook's **stdout**, which
> Claude Code injects as context, on every prompt of a disarmed install. Anything reachable from a
> hook's `lib/` twin is uncatchable by construction; that is the rule, not the milliseconds.
> The `MIN_SCORE` gate still has no case set behind it — that is item 12, unchanged.

> **Item 8 (move `searchIn()` into the lib) landed on 2026-08-19**, with item 6, and is deleted from
> this list, per the rule at the top. It narrows `G1`: the body moved unchanged into
> `scripts/lib/memory-semantic.mjs`, and the argv-derived `--layer` became a last parameter,
> `preFiltered` — a boolean flag, not a layer to filter by.
> `loadIndex()` stays in the entry and stays untested — it opens the database, and `lib/` may not
> import `node:sqlite`, which is `G1`'s own point.

---

## Wave 4 — cover the destructive scripts

These two were the entire irreversible-data-loss surface. Both landed on 2026-08-19; the wave is
empty, and what is left of it is the follow-up named at the end of item 10 below.

> **Item 9 (port `prune-logs.sh` to Node) landed on 2026-08-19** and is deleted from this list, per
> the rule at the top. `scripts/prune-logs.mjs` + `scripts/lib/prune-logs.mjs` and a test per
> branch; the `.sh` is gone and `commands/prune.md` calls the new entry. The unreachable-branch
> problem it was named for is gone with it — there is no longer a BSD `date -j -f` arm that CI
> cannot run. Three deliberate behaviour changes are recorded in the module's own comments: a
> filename that matches the date pattern but is not a calendar date (`2026-02-31`) is now skipped
> rather than normalised to 2026-03-03, a name that already exists in `Archive/` is left in place
> rather than overwritten, and `Archive/` is created only when something moves. Reviewing the port
> found five defects *in the port*, all fixed with a regression test rather than disclosed: an
> out-of-range `PRUNE_DAYS` archived the whole directory, `PRUNE_DAYS=" "` did the same through a
> 0-day window, an unpadded cutoff year did it a third time at `PRUNE_DAYS=375000`, a symlinked
> log was invisible to both the moved and the skipped list, and a mid-run failure reported nothing
> about what had already moved.

> **Item 10 (test `vault-memory-sync.sh`) landed on 2026-08-19** and is deleted from this list, per
> the rule at the top. `hooks/vault-memory-sync.test.mjs` drives the 163-line script as a black box
> — spawn bash, hook payload on stdin, assert on the filesystem — from a scratch `HOME` per
> subtest, with a built rather than inherited child env; 12 cases, and mutation-checked on a
> throwaway copy of the repo, so it is known to fail when the script is broken rather than merely
> known to be green. **The fence in `H4` stays**: the script is still bash and still must not be
> ported. What the test changes is that a port is now *diffable* against a baseline, which was the
> stated precondition, not permission to do it.
>
> Three defects in the script itself are recorded there as `CHARACTERISED, NOT ENDORSED` with a
> passing assertion each, deliberately unfixed because a fix without this test is what lost the 24
> notes: `mv -n` skips a same-named note and the following `rm -rf` then deletes it, a subdirectory
> under a real memory dir is deleted rather than migrated, and the refusal to merge a
> legacy-slug folder into an existing destination is silent, so those notes are stranded forever.
> **The first two are silent note loss on the next SessionStart and want their own PR** — the
> test that had to come first now exists. Two branches stay uncovered: the `~/.claude/CLAUDE.md`
> migration and the `Commands/` stub `rmdir`, where mutants that turn them into `rm -rf` still
> survive.

---

## Wave 5 — make the paper invariants real

### 11. CI: every entry has a `lib/` twin, or is allowlisted

- **Goal:** the entry/`lib` rule is enforced by nothing today, and all four existing CI checks are
  *exempt by construction* for logic left in an entry file.
- **Files:** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
- **Diff plan:** loop `hooks/*.mjs` and `scripts/*.mjs`; fail when no `lib/<name>.mjs` exists and the
  file is not on an explicit allowlist carrying a stated reason. **Do this after item 7**, so the
  allowlist starts empty or near-empty. Match the existing steps' style: a comment saying why, and an
  `::error::` naming the fix.
- **Risk: low.** Flip that row in [architecture.md](architecture.md)'s invariants table from
  `NOTHING` to `CI` in the same PR.
- **~30 min.**

### 12. Give `MIN_SCORE = 6.0` a case set

- **Goal:** the one number in the repo that breaks the "no retrieval number without a case set"
  convention. Item 7 landed on 2026-08-19, so it is now testable and now shares the lib's BM25.
- **Files:** [`scripts/memory-eval.mjs`](../scripts/memory-eval.mjs) /
  [`scripts/lib/memory-eval.mjs`](../scripts/lib/memory-eval.mjs), then `MIN_SCORE` in
  [`hooks/lib/memory-recall.mjs`](../hooks/lib/memory-recall.mjs).
- **Diff plan:** `--mode lexical` used to measure the *lib's* BM25 and not recall's. Since item 7
  they are one implementation, so it is now the right instrument — run it against the versioned
  authored case set and record the sweep in a comment beside the constant, the way `MIN_COS` already
  does.
- **Risk: low** technically; the cost is the eval run, not the diff.
- **~1 h.**

---

## Wave 6 — housekeeping

> **Item 13 (the stale numbers in `commands/synthesize.md`) landed in #24** and is deleted from
> this list, per the rule at the top. The frozen figures were replaced by the command that
> measures them.

### 14. Decide `H7`, then act once

- **Goal:** `reindex()` in [`hooks/lib/distill-session.mjs`](../hooks/lib/distill-session.mjs) labels
  `ctx_search` sources by `basename(cwd)` while indexing directories by `project_key`. Two identity
  schemes, adjacent lines.
- **Diff plan:** **this needs a decision, not a patch.** The `vault-memory-<repo>` basename form is
  what the SessionStart retrieval guidance tells Claude to use, so changing it orphans existing ctx
  indexes and contradicts documented advice. Either change both sides and reindex, or add one comment
  stating the split is deliberate. Do not leave it undocumented.
- **Risk: medium** if changed (orphans indexes), **none** if documented.
- **~15 min to document, ~1 h to change.**

### 15. Declined: relocate `paths.mjs`

`paths.mjs` is the only real layer in the system and it is misfiled under `hooks/`, so eight files
reach up through `../../hooks/lib/` to import it. Moving it touches those import sites, the CI globs
and CLAUDE.md — **for conceptual clarity and no behaviour change.** Worst impact-per-hour in this
backlog. Recorded so it is not rediscovered as a good idea later.

**Still declined after #20**, which rewrote this file without moving it. Rewriting it was the moment
a relocation would have been cheapest, and it still did not pay for itself.

---

## Suggested sequencing

| PR | Items | Effort | Buys |
| --- | --- | ---: | --- |
| ~~1~~ | ~~1–4~~ | — | all landed: item 1 in #20, items 2–4 in #24 |
| ~~2~~ | ~~5~~ | — | landed in #27: killed the highest-probability failure; no bump needed, it forces no re-index |
| ~~3~~ | ~~6, 8~~ | — | landed 2026-08-19 as #28: two extractions with tests; `R4` narrowed, not closed — item 7 closed it |
| ~~4~~ | ~~7~~ | — | landed 2026-08-19: the structural fix; `G1`'s last hole and `R4` both closed, three of `H6`'s four forks gone. Items 11 and 12 are now unblocked |
| ~~5~~ | ~~9, 10~~ | — | landed 2026-08-19: the log pruner is Node and tested; `vault-memory-sync.sh` has a characterisation baseline and keeps its fence. Both scripts that can lose data are now covered |
| 6 | 11, 12 | ~1.5 h | two paper invariants become enforced |
| 7 | ~~13~~, 14 | ~15 min | rot removal; 13 landed in #24 |
| 8 | *new* | ~1 h | fix the two silent-note-loss paths item 10 characterised — now unblocked, and the only known data-loss bugs left |

Item 15 is non-work. **Of what was numbered here, nothing left changes behaviour** — it is all
observation, extraction, or tests. (Items 7 and 9 were the two that did, and both landed.) The
unnumbered row 8 is the exception and is deliberately behaviour-changing: it is the fix for the two
data-loss paths item 10 pinned down.

Item **11** (CI enforcing the entry/`lib` rule) got cheaper twice: #20 added three compliant
entries, and item 7 took the last hook entry that had no twin at all. The mechanical form of the
check — does `<dir>/lib/<name>.mjs` exist for every non-test `hooks/*.mjs` and `scripts/*.mjs` —
now fails on exactly **one** file, `scripts/env.mjs`, whose twin is `hooks/lib/env-shell.mjs`:
neither same-named nor in the sibling directory (see `B1`). So the allowlist is one name with one
stated reason, not the four it would have needed before. Re-counted 2026-08-19 by running that
loop; the older "four names" figure predates items 7 and 8.
