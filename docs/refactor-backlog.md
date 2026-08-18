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

### 2. `doctor.sh` reports `$CLAUDE_MEMORY_HOME` subdirectory sizes

- **Goal:** turn `R5` from unbounded into observed. The 2.2 GB `node_modules` was found by
  accident — same shape, different directory.
- **Files:** [`scripts/doctor.sh`](../scripts/doctor.sh)
- **Diff plan:** one section printing `du -sh` (**with `-L`** — see the 2026-08-18 symlink fix) for
  `db/ models/ logs/ eval/ run/` plus a total; `warn` above a threshold. Reuse the existing
  `ok`/`warn` helpers, keep the always-`exit 0` rule.
- **Risk: low.** Read-only, and the script cannot fail its caller.
- **~20 min.**

### 3. Cap `semantic-index.log`

- **Goal:** the one unbounded append in the system. **Still open after #20** — `logBanner()` appends
  and nothing truncates.
- **Files:** [`hooks/lib/hook-io.mjs`](../hooks/lib/hook-io.mjs) — `logBanner()`, now that the hook
  is Node. Fixing it there covers `distill.log` and `graphgen.log` at the same time, which the
  original shell-only fix would not have.
- **Diff plan:** in `logBanner()`, before appending, truncate to the last 256 KB when the file
  exceeds 1 MB. Node has no `tail -c`, so read the last 256 KB with a positioned `fs.readSync` and
  rewrite — no dependency, and the whole file never enters memory.
- **Risk: low.**
- **~20 min.**

### 4. `chmod 0600` the daemon socket

- **Goal:** close the auth analogue. Since 0.3.0 the slug is a *request field*, so one connection
  can read any indexed project's notes.
- **Files:** [`scripts/memory-semantic.mjs`](../scripts/memory-semantic.mjs), inside the
  `server.listen` callback.
- **Diff plan:** `fs.chmodSync(sockPath, 0o600)` in the listen callback, in a `try/catch`, with one
  comment noting that macOS does not enforce unix-socket permissions uniformly — this is defence in
  depth, not a guarantee.
- **Risk: low.** Same-user client; it cannot lock you out.
- **~10 min.**

---

## Wave 2 — index correctness

### 5. Stop keying staleness on mtime alone

- **Goal:** kill `R1`, the highest-probability failure on the list.
  [`scripts/prune-logs.sh`](../scripts/prune-logs.sh) states in its own header that Synology sync
  churns mtime; the indexer keys its entire incremental decision on exact mtime equality.
- **Files:** [`scripts/memory-semantic.mjs`](../scripts/memory-semantic.mjs) (`--index` block),
  [`scripts/lib/memory-semantic.mjs`](../scripts/lib/memory-semantic.mjs) (a `contentHash` helper
  and its test).
- **Diff plan:** add a `hash` column to `chunks`. Two-level check — mtime matches, skip without
  reading (the fast path is unchanged); mtime differs, read + hash, and skip re-embedding when the
  hash matches. Notes are already read for chunking, so the extra cost falls only on files that
  *look* stale. The schema change forces a one-time `--rebuild`, which the CHANGELOG defines as
  breaking: needs an `## [Unreleased]` entry and a minor bump.
- **Risk: medium.** Touches the write path and the schema. Mitigations: the per-model write lock
  already exists, `--rebuild` is the escape hatch, and `memory-synth-vault.mjs` gives a
  deterministic corpus to verify incremental behaviour against.
- **~90 min.** Highest single-item payoff in this backlog.

### 6. `'(card)'` becomes a constant, with a test behind it

- **Goal:** kill `R4`. Five bare literals, one producer, four consumers — a rename silently empties
  recall's keyword arm, and abstention is that hook's normal behaviour.
- **Files:** [`scripts/lib/memory-semantic.mjs`](../scripts/lib/memory-semantic.mjs) (export
  `CARD`), [`scripts/memory-semantic.mjs`](../scripts/memory-semantic.mjs) (3 sites),
  [`hooks/memory-recall.mjs`](../hooks/memory-recall.mjs) (1 site).
- **Diff plan:** `export const CARD = '(card)';` beside `chunkNote`, substituted at all five sites.
  **The test matters more than the constant:** assert `chunkNote()` emits a chunk whose heading is
  `CARD`, so a rename fails `node --test` instead of silently emptying a `SELECT`.
- **Risk: low.** Mechanical. Caveat: importing the lib from `memory-recall.mjs` puts its module-init
  on the prompt path — measure it, or defer recall's site until item 7.
- **~30 min.**

---

## Wave 3 — the missing seam

### 7. Give `memory-recall.mjs` a `lib/` twin

- **Goal:** the structural fix with the widest reach. Closes the last entry/`lib` gap (`G1`),
  removes the duplicate BM25 and the copy-pasted `STOP` list (`H6`, including its duplicated
  `with`), and makes the prompt path testable for the first time.
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

### 8. Move `searchIn()` into the lib

- **Goal:** the function that decides what a session actually sees lives in the untested 843-line
  entry (`G1`).
- **Files:** [`scripts/memory-semantic.mjs`](../scripts/memory-semantic.mjs) →
  [`scripts/lib/memory-semantic.mjs`](../scripts/lib/memory-semantic.mjs), plus a test.
- **Diff plan:** `searchIn(index, q, qvec, k)` already takes a bundle from `buildBundle` and returns
  ranked rows — it is pure. Move it verbatim and import it back. `loadIndex` stays in the entry (it
  opens a database). Test against a hand-built bundle: assert RRF ordering, and that both arms
  contribute.
- **Risk: low.** Pure move, and both the CLI and the daemon already call it, so the two cannot drift.
- **~45 min.**

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

### 13. Fix the stale numbers in `commands/synthesize.md`

- **Goal:** [`commands/synthesize.md`](../commands/synthesize.md) hardcodes "965 Insights against 5
  `permanent/` notes" — a 2026-08-15 measurement that nothing updates.
- **Diff plan:** either re-measure and date the claim, or replace the figure with the command that
  produces it. Prefer the latter: a number with no refresh path is guaranteed to rot.
- **Risk: none.** **~10 min.**

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
| ~~1~~ | ~~1–4~~ → **2, 3, 4** | ~50 min | item 1 landed in #20; the rest still make silent failures visible |
| 2 | 5 | ~1.5 h | kills the highest-probability failure (needs a minor bump) |
| 3 | 6, 8 | ~1.25 h | two pure extractions, both with tests |
| 4 | 7 | ~2 h | the structural fix — must precede items 11 and 12 |
| 5 | 9, 10 | ~2.5 h | coverage on the only two scripts that can lose data; 9 is now a port |
| 6 | 11, 12 | ~1.5 h | two paper invariants become enforced |
| 7 | 13, 14 | ~30 min | rot removal |

Items 3 and 15 are net deletions or non-work. **Only items 5, 7 and 9 change behaviour** —
everything else is observation, extraction, or tests.

Item **11** (CI enforcing the entry/`lib` rule) got cheaper: #20 added three compliant entries, so
the rule now holds in 8 of 12 rather than 5 of 9, and the allowlist it would need is down to four
names.
