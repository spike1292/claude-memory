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
> this list, per the rule at the top. It **narrows** `R4` rather than closing it: the sentinel is
> `CARD` in `scripts/lib/memory-semantic.mjs`, bound as a SQL parameter at both reads in
> `scripts/memory-semantic.mjs`, but `hooks/memory-recall.mjs:176` still spells it out — importing
> the lib there would put its module init on the `UserPromptSubmit` path. A test reads that file's
> source so the drift is loud, and **item 7 closes `R4` properly** by giving recall a `lib/` twin.
> Wave 2 is finished; numbering below is unchanged.

---

## Wave 3 — the missing seam

### 7. Give `memory-recall.mjs` a `lib/` twin

- **Goal:** the structural fix with the widest reach. Closes the last entry/`lib` gap (`G1`),
  removes the duplicate BM25 and the copy-pasted `STOP` list (`H6`, including its duplicated
  `with`), and makes the prompt path testable for the first time. **It also inherits item 6's
  deferred site** — once recall's SQL lives behind a `lib/`, that last bare `'(card)'` can take
  `CARD` and `R4` closes for real.
- **Also closes:** `R4` (item 6, 2026-08-19, narrowed it and left this site).
- **Files:** new `hooks/lib/memory-recall.mjs` + `hooks/lib/memory-recall.test.mjs`; slim
  [`hooks/memory-recall.mjs`](../hooks/memory-recall.mjs).
- **Diff plan:** move the pure parts — gates, tokenisation, BM25 scoring, hit formatting, the log
  record shape. **Leave `node:sqlite` and `net` in the entry**: CI requires it, and it keeps the
  socket out of the test. The lib takes rows as values. Then delete recall's inline
  `STOP`/`toks`/BM25 in favour of the lib's, resolving three of `H6`'s four forks.
- **Risk: medium.** This is the `UserPromptSubmit` path; a regression degrades every prompt. It does
  fail safe by construction (`process.exit(0)` throughout, "fail-open, always"), and the change is
  extraction rather than redesign. Verify against a real prompt before merging.
- **~2 h.**

> **Item 8 (move `searchIn()` into the lib) landed on 2026-08-19**, with item 6, and is deleted from
> this list, per the rule at the top. It narrows `G1`: the body moved unchanged into
> `scripts/lib/memory-semantic.mjs`, and the argv-derived `--layer` became a last parameter,
> `preFiltered` — a boolean flag, not a layer to filter by.
> `loadIndex()` stays in the entry and stays untested — it opens the database, and `lib/` may not
> import `node:sqlite`, which is `G1`'s own point.

---

## Wave 4 — cover the destructive scripts

These two are the entire irreversible-data-loss surface. Neither has a test.

### 9. Port `prune-logs.sh` to Node

Restated after #20: **port it, do not just test it.** It is a loop over files with per-item date
parsing, which is what the fork-count rule sends to Node — the 2026-08-17 sweep only missed it
because it is not a hook. Porting gets the test for free and removes the portability trap; testing
the shell version keeps the trap and buys less.

- **Goal:** it `mv`s vault files, has a 90-day horizon, and has almost certainly never run on real
  data. Its BSD `date -j -f` path is the one you run and the one CI cannot reach — the branch CI
  *could* test is the one you never execute.
- **Files:** new `scripts/prune-logs.mjs` + `scripts/lib/prune-logs.mjs` + test; delete the `.sh`;
  update the invocation in [`commands/prune.md`](../commands/prune.md).
- **Diff plan:** ~25 lines. Dates come from the filename (`YYYY-MM-DD-*.md`), never mtime — Synology
  churns mtime, which is the same fact behind `R1`. Keep move-only, never delete. Test a synthetic
  directory straddling the cutoff and assert exactly the old files moved into `Archive/`.
- **Risk: low.** Move-only, and the port is mechanical.
- **~45 min.** Still the best coverage-per-hour in the repo.

### 10. Test `vault-memory-sync.sh`

- **Goal:** 160 lines, no test, moves files and repoints a live symlink in a cloud-synced directory.
  It has cost 24 notes once (`H4`).
- **Files:** new test with an isolated `HOME` and a synthetic vault.
- **Diff plan:** **isolate `HOME`, not just `CLAUDE_VAULT`** — the script repoints the live
  `~/.claude/projects/*/memory`. Assert: notes survive a `legacy_key` → `project_key` migration, the
  symlink resolves where expected, and nothing is deleted. This is a *characterisation* test; it
  does not violate the standing "do not port" rule.
- **Risk: medium** to write (the isolation is fiddly), **low** to merge.
- **~90 min.**

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
  convention — and after item 7 it is finally testable.
- **Files:** [`scripts/memory-eval.mjs`](../scripts/memory-eval.mjs) /
  [`scripts/lib/memory-eval.mjs`](../scripts/lib/memory-eval.mjs), then the constant in the new
  recall lib.
- **Diff plan:** `--mode lexical` currently measures the *lib's* BM25, not recall's. After item 7
  they are one implementation, so it becomes the right instrument — run it against the versioned
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
| ~~3~~ | ~~6, 8~~ | — | landed 2026-08-19: two extractions with tests; `R4` narrowed, not closed — item 7 closes it |
| 4 | 7 | ~2 h | the structural fix — must precede items 11 and 12, and closes the `R4` site item 6 deferred |
| 5 | 9, 10 | ~2.5 h | coverage on the only two scripts that can lose data; 9 is now a port |
| 6 | 11, 12 | ~1.5 h | two paper invariants become enforced |
| 7 | ~~13~~, 14 | ~15 min | rot removal; 13 landed in #24 |

Item 15 is non-work. **Of what is left, only items 7 and 9 change behaviour** — everything else
is observation, extraction, or tests.

Item **11** (CI enforcing the entry/`lib` rule) got cheaper: #20 added three compliant entries, so
the rule now holds in 8 of 12 rather than 5 of 9, and the allowlist it would need is down to four
names.
