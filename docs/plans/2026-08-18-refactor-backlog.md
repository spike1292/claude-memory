# Implement the refactor backlog via 6 dynamic workflows

## Context

[docs/refactor-backlog.md](../refactor-backlog.md) holds 13 open
items distilled from the "how things really work" half of `docs/architecture.md`. An audit against
HEAD (`d516c18`) confirms **all 13 are still open** — the only three commits since `e16c41d` were a
key-resolution fix, a permission allowlist, and a docs change.

The audit corrected three claims in the backlog, and the plan uses the corrected numbers:

| Backlog says | Actually |
| --- | --- |
| item 6: 5 literals, 3 in `scripts/memory-semantic.mjs` | 5 literals, **2** there (`:432`, `:510`); `:506` is a comment |
| item 11: rule holds 8 of 12, allowlist of 4 | holds **12 of 14**, allowlist is **2**: `hooks/memory-recall.mjs` (item 7 removes it) and `scripts/env.mjs` (16 lines) |
| item 10: `vault-memory-sync.sh` is 160 lines | 163 |

The work is a good fit for orchestration because the items are deliberately atomic and mostly
disjoint — but they are **not** freely parallel: four of them collide inside
`scripts/memory-semantic.mjs`. The batching below is derived from the file-conflict map, not from
the backlog's wave numbers.

**Decisions taken (2026-08-18):** workflows push branches and open PRs; item 14 unifies on
`project_key` rather than documenting the split; all 13 items in scope.

---

## Conflict map — why the batches are what they are

| Item | Files touched |
| --- | --- |
| 2 | `scripts/doctor.sh` |
| 3 | `hooks/lib/hook-io.mjs` (+ test) |
| 4 | `scripts/memory-semantic.mjs` (`server.listen`, `:771`) |
| 5 | `scripts/memory-semantic.mjs` (`:105` schema, `:387` staleness), `scripts/lib/memory-semantic.mjs` |
| 6 | `scripts/lib/memory-semantic.mjs`, `scripts/memory-semantic.mjs`, `hooks/memory-recall.mjs` |
| 7 | `hooks/memory-recall.mjs` (253 lines) → new `hooks/lib/memory-recall.mjs` + test |
| 8 | `scripts/memory-semantic.mjs:606` → `scripts/lib/memory-semantic.mjs` |
| 9 | new `scripts/prune-logs.mjs` + lib + test; delete `.sh`; `commands/prune.md:27` |
| 10 | new test only |
| 11 | `.github/workflows/ci.yml`, `docs/architecture.md` |
| 12 | `scripts/lib/memory-eval.mjs`, the new recall lib |
| 13 | `commands/synthesize.md:16` |
| 14 | `hooks/lib/distill-session.mjs:446-450`, `hooks/vault-memory-sync.sh:155`, CHANGELOG |

Two clusters force serialization: **{4, 5, 6, 8}** all edit `scripts/memory-semantic.mjs`, and
**{6, 7, 12}** all edit the recall path. Everything else is genuinely disjoint and runs in parallel
inside its batch.

Every run also edits `docs/refactor-backlog.md` (deleting its landed items, per that file's own
rule) and `CHANGELOG.md` — which is a further reason the six runs are **sequential**, one PR merged
before the next branches.

---

## The six runs

Each run = one `Workflow` invocation = one branch = one PR. I launch run N+1 only after run N's PR
is merged.

### Run 1 → PR A · items 2, 3, 4, 13 · ~50 min

Four disjoint files, so four implementers run in parallel. This is the batch that "makes silent
failures loud".

- **2** — `scripts/doctor.sh`: a section printing `du -shL` (the `-L` is the 2026-08-18 symlink fix)
  for `db/ models/ logs/ eval/ run/` under `STATE=$(memory_home)` (`:17`), plus a total and a `warn`
  above threshold. Reuse the existing `ok`/`warn` helpers; keep the always-`exit 0` rule.
- **3** — `hooks/lib/hook-io.mjs:167-175` `logBanner()`: before appending, when the file exceeds
  1 MB, keep the last 256 KB via a positioned `fs.readSync` and rewrite. Fixing it here covers
  `semantic-index.log`, `distill.log` and `graphgen.log` at once.
- **4** — `scripts/memory-semantic.mjs:771` listen callback: `fs.chmodSync(sockPath, 0o600)` in a
  `try/catch`, with the comment that macOS does not enforce unix-socket permissions uniformly.
- **13** — `commands/synthesize.md:16`: replace the hardcoded "965 Insights against 5 `permanent/`
  notes" with the command that produces the figure.

### Run 2 → PR B · item 5 · ~1.5 h · **behaviour change, minor bump**

The highest-probability failure on the list: `scripts/memory-semantic.mjs:387` filters on exact
mtime equality (`known.get(f.full) !== f.mtime`) while `scripts/prune-logs.sh`'s own header records
that Synology churns mtime.

Add a `hash` column to the `chunks` schema (`:105`) and a `contentHash` helper + test in
`scripts/lib/memory-semantic.mjs`. Two-level check: mtime matches → skip without reading (fast path
unchanged); mtime differs → read, hash, skip re-embedding when the hash matches. Notes are already
read for chunking, so the extra cost falls only on files that *look* stale.

Not parallel — one implementer, then a dedicated verification agent that builds a deterministic
corpus with `scripts/memory-synth-vault.mjs --out /tmp/bench --notes 300 --seed 7`, indexes it,
touches files without changing content, and asserts zero re-embeds.

The schema change forces a one-time `--rebuild`, which CHANGELOG.md's preamble defines as breaking:
`## [Unreleased]` entry required, minor bump at release (via `scripts/release.sh`, never by hand).

### Run 3 → PR C · items 6, 8 · ~1.25 h

Both live in `scripts/{,lib/}memory-semantic.mjs`, so they run as a two-stage **pipeline**, not in
parallel.

- **6** — `export const CARD = '(card)'` beside `chunkNote` in the lib, substituted at the four
  script sites (`scripts/memory-semantic.mjs:432,510`; `scripts/lib/memory-semantic.mjs:361,624`).
  **The test matters more than the constant:** assert `chunkNote()` emits a chunk whose heading is
  `CARD`, so a rename fails `node --test` instead of silently emptying recall's keyword arm.
  **Defer the fifth site** (`hooks/memory-recall.mjs:176`) to run 4 — importing the lib from the
  entry would put its module-init on the prompt path.
- **8** — move `searchIn(index, q, qvec, k)` (`scripts/memory-semantic.mjs:606`) verbatim into the
  lib and import it back. `loadIndex` stays in the entry (it opens a database; CI forbids
  `node:sqlite` in `lib/`). Test against a hand-built bundle: assert RRF ordering and that both arms
  contribute. Both the daemon (`:739`) and the CLI (`:825`) already call it, so they cannot drift.

### Run 4 → PR D · item 7 + item 6's deferred site · ~2 h · **highest risk**

The structural fix. `hooks/memory-recall.mjs` is 253 lines carrying its own `STOP` set (`:32`), its
own tokeniser (`:186`) and its own BM25 (`:216`) — a fourth fork of logic the lib already has.

Move the pure parts (gates, tokenisation, BM25 scoring, hit formatting, the log record shape) into
new `hooks/lib/memory-recall.mjs` + test; the lib takes rows as values. **Leave `node:sqlite` and
`net` in the entry** — CI enforces it and it keeps the socket out of the test. Then delete the
inline `STOP`/`toks`/BM25 in favour of the lib's.

This is the `UserPromptSubmit` path, so the workflow spends its agent budget on verification rather
than breadth: one implementer, three adversarial reviewers each prompted to *refute* that the
extraction is behaviour-preserving (distinct lenses: fail-open guarantees, BM25 scoring identity,
prompt-path latency), and a live check against a real prompt before the PR opens. The change is
extraction, not redesign, and the path fails open by construction (`process.exit(0)` throughout).

### Run 5 → PR E · items 9, 10 · ~2.5 h

The entire irreversible-data-loss surface. Two implementers in parallel — disjoint, both mostly new
files.

- **9 — port, do not just test.** New `scripts/prune-logs.mjs` + `scripts/lib/prune-logs.mjs` +
  test; delete the `.sh`; update the sole invocation at `commands/prune.md:27`. ~25 lines. Dates
  come from the filename (`YYYY-MM-DD-*.md`), **never mtime** — same fact as item 5. Move-only,
  never delete. The BSD `date -j -f` branch is the one you run and the one CI cannot reach, which is
  the whole argument for porting instead of testing.
- **10 — characterisation test** for `hooks/vault-memory-sync.sh` (163 lines, no test, has cost 24
  notes once). **Isolate `HOME`, not just `CLAUDE_VAULT`** — the script repoints the live
  `~/.claude/projects/*/memory` symlink. Assert notes survive a `legacy_key` → `project_key`
  migration, the symlink resolves where expected, and nothing is deleted. This does not violate the
  standing "do not port `vault-memory-sync.sh`" rule.

The `HOME` isolation is the fiddly part, so item 10 gets its own verify agent that runs the new test
against a scratch `HOME` and confirms the real `~/.claude` was untouched.

### Run 6 → PR F · items 11, 12, 14 · ~2.5 h

Three disjoint file sets, run in parallel; 11 and 12 both depend on run 4 having landed.

- **11** — loop `hooks/*.mjs` and `scripts/*.mjs` in `.github/workflows/ci.yml`; fail when no
  `lib/<name>.mjs` twin exists and the file is not allowlisted with a stated reason. After run 4 the
  allowlist is **one name**: `scripts/env.mjs`. Match the existing steps' style (a comment saying
  why, an `::error::` naming the fix). Flip that row in `docs/architecture.md`'s invariants table
  from `NOTHING` to `CI` in the same PR.
- **12** — `MIN_SCORE = 6.0` (`hooks/memory-recall.mjs:29`) is the one number breaking the "no
  retrieval number without a case set" convention. After run 4, `--mode lexical` in
  `scripts/memory-eval.mjs` measures the same BM25 recall uses, so it becomes the right instrument.
  Run the sweep against the versioned authored case set and record it in a comment beside the
  constant, the way `MIN_COS = 0.55` already does at `:133-137`. **The eval run is the cost here,
  not the diff** — this agent is the long pole of the whole plan.
- **14 — unify on `project_key`** (your decision; the backlog's default was to document the split).
  `hooks/lib/distill-session.mjs:446-450` labels ctx sources `vault-<layer>-${basename(cwd)}` while
  indexing `path.join(VAULT, layer, slug)` where `slug` is `project_key`. Change the labels to use
  `slug`, and update the retrieval guidance heredoc at `hooks/vault-memory-sync.sh:155` in the same
  PR so the documented advice matches.

  **This orphans every existing ctx index** under the old basename labels. `ctx_search` returns
  nothing for those layers until a `/memory:prune` reindexes — the plugin's own retrieval path is
  untouched, so this is degraded ctx freshness, not lost recall. It needs a CHANGELOG entry saying
  so, and `hooks/vault-memory-sync.sh` is the file the repo policy fences off, so the edit must stay
  a string change inside the heredoc and nothing else.

---

## Workflow script shape

One template, six instantiations. Run 1's script, in full; the others differ only in the item list,
the stage graph (pipeline where files collide), and the verifier count.

```js
export const meta = {
  name: 'backlog-wave-1',
  description: 'Items 2,3,4,13 — make silent failures loud',
  phases: [
    { title: 'Implement', detail: 'one agent per item, disjoint files' },
    { title: 'Verify',    detail: 'adversarial review per item' },
    { title: 'Document',  detail: 'changelog, backlog, architecture markers, PR body draft' },
    { title: 'Review',    detail: 'two-axis skill review + the CI reviewer, run locally' },
    { title: 'Land',      detail: 'format, test, commit, push, PR' },
  ],
}

const ITEMS = args   // [{n, goal, files, diff, risk}, ...] passed in from the plan

const done = await pipeline(
  ITEMS,
  it => agent(IMPL_PROMPT(it), { label: `impl:${it.n}`, phase: 'Implement', schema: EDIT_REPORT }),
  (rep, it) => agent(REVIEW_PROMPT(it, rep), { label: `review:${it.n}`, phase: 'Verify', schema: VERDICT }),
)

// Barrier: the prose is written against the whole batch, and must exist before review.
phase('Document')
const doc = await agent(DOCUMENT_PROMPT(done.filter(Boolean)), { schema: DOC_RESULT })
// writes CHANGELOG.md + docs/refactor-backlog.md + docs/architecture.md markers,
// and DRAFTS the PR body to .git/PR_BODY.md — drafted, not posted.

// Whole-diff review, over code AND prose. Nothing is committed or pushed yet.
phase('Review')
const [skillReview, ciReview] = await parallel([
  () => agent(CODE_REVIEW_SKILL_PROMPT(ITEMS, doc), { label: 'review:two-axis', schema: TWO_AXIS }),
  () => agent(CI_REVIEWER_PROMPT(doc),              { label: 'review:as-ci',   schema: FINDINGS }),
])

const blockers = [...skillReview.hard, ...ciReview.findings.filter(f => f.severity === 'blocker')]
if (blockers.length) await agent(FIX_PROMPT(blockers), { label: 'fix:blockers', phase: 'Review' })

phase('Land')
const gate = await agent(GATE_PROMPT, { schema: GATE_RESULT })   // npm run format && node --test --test-concurrency=1
if (!gate.pass) return { blocked: gate.failures }
// Commits, pushes, and opens the PR with the REVIEWED body from .git/PR_BODY.md. Writes no
// new prose — anything it had to invent here would be prose nobody reviewed.
return await agent(LAND_PROMPT(done.filter(Boolean), skillReview, ciReview), { schema: PR_RESULT })
```

**Shape notes.** Implement→Verify is a `pipeline`, so item 2's review starts while item 4 is still
being written. `Document`, `Review` and `Land` are the genuine barriers: the prose, the whole-diff
review, `node --test` and a single commit are all batch-wide by definition. Runs 3 and 4 replace the
fan-out with a serial chain (item 6 → item 8) or a single implementer plus a 3-agent refutation
panel. Nothing needs `isolation: 'worktree'` — within a run the file sets are disjoint, and across
runs the execution is sequential.

### Why `Document` comes before `Review`

**The changelog and the PR body are reviewable artefacts, and they are where this repo's mistakes
actually landed.** Both of PR #24's escapes were prose, not code:

- The CHANGELOG claimed doctor prints `db/ models/ logs/ eval/ run/` when the shipped loop printed
  `db/ logs/ eval/ run/ cache/`. Three reviews ran before that sentence existed.
- The PR body claimed "110 pass (99 on `main`; the 11 new ones…)" against a real 107 and 3. The CI
  reviewer caught it *after* push, by reading the description against the diff — the one reviewer
  that saw it, because it was the only one that ran after the body was written.

Writing the prose first costs nothing: `Document` touches only `CHANGELOG.md`,
`docs/refactor-backlog.md`, `docs/architecture.md` and a PR-body draft, none of which the code
agents are still holding. Reviewing after it means a reviewer can check the claims against the diff
while both are still editable, instead of after a PR exists.

Two consequences worth stating, because they are what make the ordering real:

- **The PR body is drafted to a file, not posted.** `Document` writes `.git/PR_BODY.md`; `Land` runs
  `gh pr create --body-file` on the reviewed draft. A body composed at push time is prose nobody
  reviewed, which is exactly how #24's numbers shipped.
- **`Land` writes no new prose.** It formats, tests, commits, pushes, and opens the PR. If it finds
  itself needing to invent a sentence, that is a sign `Document` was incomplete — and the sentence
  would be unreviewed.

`Document` is also where the recurring "stale marker" finding is closed: it is told which
`docs/architecture.md` risk row each item in the batch closes, and marking that row is part of its
output rather than something a reviewer has to catch. Run 1 shipped a stale `R5` row and had it
flagged twice.

### The two reviewers — after building and documenting, before pushing

The per-item `Verify` agents see one item each. Neither of these does: both read the whole diff,
which is the only way to catch a finding that lives *between* items.

Both run over the diff **and** the prose `Document` just wrote — the changelog entry, the backlog
deletion, the architecture markers, and the drafted PR body.

**Reviewer 1 — the `/code-review` skill's two axes.** Standards (does the diff obey the repo's
documented rules, plus the Fowler smell baseline?) and Spec (does it implement what the backlog item
asked, nothing more, nothing less?), run as separate sub-agents so neither pollutes the other's
context. The axes are deliberately not merged or reranked. The Spec axis reads the item text **from
`main`**, because `Document` has by then deleted the item it implements —
`git show main:docs/refactor-backlog.md`.

**Reviewer 2 — the CI reviewer's own prompt, run locally.** `node scripts/review-prompt.mjs`
prints it, straight out of [.github/workflows/claude-review.yml](../../.github/workflows/claude-review.yml).
Substitute the `REPO`/`PR NUMBER` header for "review the working tree against `main`" and the
trailing "post GitHub comments" instruction for "return findings"; change nothing else. Three
reasons this earns a slot rather than duplicating reviewer 1:

- **It is the reviewer that actually gates the PR.** Running it before pushing turns a
  comment-then-fix-then-repush round trip into an edit. Measured on PR #24: three of its findings
  would have been caught pre-push, and two of those were introduced by the *previous* round of
  review fixes. It is also the reviewer that reads the PR description against the diff, which is
  why the description has to exist before it runs.
- **Its weighting is different and repo-specific.** Privacy first (public repo, private vault),
  then state-inside-the-plugin-dir, absolute paths, blocking hooks, config-resolution drift,
  retrieval numbers without a case set. A generic standards review does not rank these.
- **It is the only review a PR that edits `claude-review.yml` can get.** `claude-code-action`
  refuses to run when the workflow file differs from the copy on the default branch — it logs a
  warning and exits SUCCESS, so the check goes green having reviewed nothing. For those PRs the
  local copy is not redundancy, it is the whole review.

**Keeping the copy honest.** Reviewer 2's value depends on the prompt matching the workflow, so it
reads it at run time — a pasted copy would be a third place the invariants live, and CLAUDE.md
already carries a rule about the second one drifting. `scripts/lib/review-prompt.test.mjs` asserts
the real workflow still yields a prompt with both ends intact, so restructuring the YAML fails
`node --test` instead of silently leaving the local reviewer reading nothing.

**The prompt stays inline in the workflow, and that is a security property, not inertia.**
`claude-code-action` validates that *the workflow file invoking it* is byte-identical to the copy on
the default branch — server-side, scoped to that one file. A prompt in its own file could be
rewritten by a PR while the `.yml` stayed identical, and the PR would then be reviewed under rules
it had just written. Checked on 2026-08-19: there is no `prompt_file` input either, so externalising
it would have meant an env var, buying the regression for nothing.

**What each reviewer's findings do.** `blocker` from either stops the run before `Land`, and a fix
agent addresses them. `should-fix` and `nit` are passed to the land agent and stated in the PR body
as knowingly deferred — this repo's convention is that a deferred finding is recorded, not silently
dropped.

### Contract every implementer prompt carries

Non-negotiable, because these are the repo's invariants and an agent that misses one produces a PR
CI will reject:

1. **Never commit or push to `main`** — branch (`git switch -c fix/<slug>`), push, `gh pr create`.
2. **Never bump a version by hand.** `scripts/release.sh` writes all five sites; CI fails on drift.
3. Changelog entry goes under `## [Unreleased]` **in the same PR** — that section becomes the
   release notes verbatim.
4. Logic goes in the `lib/` twin, never the entry. `lib/` modules must import without side effects,
   and must not import `node:sqlite` (both CI-enforced, `ci.yml:47` and `:76-89`).
5. Comments carry the *why*, with the date and the measurement that settled it.
6. `npm run format` before committing (prettier pinned via `npx`, never a devDependency).
7. **Delete** the landed items from `docs/refactor-backlog.md`; do not mark them done.
8. If a rule in `CLAUDE.md` changes, change it in `.github/workflows/claude-review.yml`'s prompt too.
9. No retrieval number ships without naming the case set it came from.
10. Never point a test at the real vault — synthesize one with `scripts/memory-synth-vault.mjs` and
    pass `--vault`/`--slug`.

---

## Verification

Per run, before the PR opens (the `Land` phase gate):

```bash
npm run format:check
node --test --test-concurrency=1      # CI's exact form; concurrency 1 is load-bearing
scripts/release.sh --selftest         # 13 bash cases node --test cannot run
scripts/doctor.sh                     # always exits 0; read its output
```

Per-item end-to-end checks that the generic gate does not cover:

- **item 2** — `scripts/doctor.sh` prints five sizes plus a total, and still exits 0 with
  `$CLAUDE_MEMORY_HOME` pointed at an empty dir.
- **item 3** — append 2 MB to a scratch log, call `logBanner()`, assert the file is ≤ ~1 MB and the
  tail survived.
- **item 4** — `ls -l` the socket after `--serve` starts; expect `srw-------`.
- **item 5** — synth vault, index, `touch` every note without editing, re-index, assert **zero**
  re-embeds; then edit one note and assert exactly one.
- **items 6, 8** — the new unit tests are the check; additionally confirm a live
  `memory-semantic.mjs --query` still returns the same top-5 as before the move.
- **item 7** — the panel's verdicts, plus one real `UserPromptSubmit` round trip with recall armed,
  confirming the hook still answers inside its 700 ms budget and still abstains below the gates.
- **item 9** — synthetic `Logs/` straddling the 90-day cutoff; assert exactly the old files moved
  into `Archive/` and nothing was deleted.
- **item 10** — the new test passes against a scratch `HOME`, and `~/.claude/projects/*/memory`
  still resolves to the real vault afterwards.
- **item 11** — deliberately add an entry with no twin and confirm CI's new step fails on it.
- **item 12** — the sweep output, naming its case set.
- **item 14** — `DISTILL_DRYRUN=1 node hooks/distill-session.mjs <transcript> <cwd>` shows the new
  `vault-<layer>-<project_key>` labels; then `/memory:prune` and confirm `ctx_search` scoped to the
  new source name returns notes.

---

## Cost and shape

Every run carries the same tail: one `document` agent (changelog, backlog, architecture markers,
PR-body draft) then the same two whole-diff `review` agents, on top of its per-item verification.

| Run | PR | Items | Agents | Effort |
| --- | --- | --- | ---: | ---: |
| 1 | A | 2, 3, 4, 13 | 4 impl + 4 verify + 1 doc + 2 review + 2 land | ~50 min |
| 2 | B | 5 | 1 impl + 1 prove + 3 refute + 1 doc + 2 review + 2 land | ~1.5 h |
| 3 | C | 6, 8 | 2 impl (serial) + 2 verify + 1 doc + 2 review + 2 land | ~1.25 h |
| 4 | D | 7 (+ 6's deferred site) | 1 impl + 3 refute + 1 live + 1 doc + 2 review + 2 land | ~2 h |
| 5 | E | 9, 10 | 2 impl + 2 verify + 1 doc + 2 review + 2 land | ~2.5 h |
| 6 | F | 11, 12, 14 | 3 impl + 3 verify + 1 doc + 2 review + 2 land | ~2.5 h |

~58 agents total across six runs, none exceeding the medium size guideline of 15 in a single run.
Six PRs against a protected `main`, merged in order.

**Only items 5, 7, 9 and 14 change behaviour.** The other nine are observation, extraction, tests,
or docs.

Item 15 (relocate `paths.mjs`) stays declined and stays in the file as the record of why.

---

## Status

- **Run 1 — landed as [#24](https://github.com/spike1292/claude-memory/pull/24)**, merged
  2026-08-19 as `6aeff51`. Items 2, 3, 4, 13 deleted from the backlog. Took three rounds of review
  fixes; the Review phase above exists because of them, and the numbers quoted in it are from this
  PR.
- **Run 2 — in flight** on `fix/index-content-hash` (item 5).
- Runs 3–6 not started.

### What Run 1 taught, folded back into the plan

- **Two of the three findings in the second review round were introduced by the first round.** A
  review pass is itself a change, and needs reviewing. The Review phase runs on the final diff, not
  on the implementers' output.
- **The mistakes were in the prose, not the code.** Both escapes were sentences: a CHANGELOG entry
  naming directories the code does not print, and a PR body claiming "110 pass (99 on main; the 11
  new ones…)" when `main` had 107 and the diff added 3. Neither existed when the reviewers ran.
  Hence the `Document` phase, and hence reviewing after it rather than before: the changelog and the
  PR body are now artefacts a reviewer checks against the diff while both are still editable.
- **A "docs are stale" finding recurs across runs.** `docs/architecture.md`'s risk table has a row
  per failure this backlog closes, and closing one without marking the row is the single most
  repeated finding so far. Each run's land agent is told which marker its items close.
- **The suggested fix is not always the right fix.** Two reviewers proposed temp-file + `rename()`
  for `trimLog`'s non-atomic rewrite; both were wrong, because `openLog()` hands detached children
  an `O_APPEND` fd that a rename would strand on an unlinked inode. Reviewer findings are input,
  not instructions — the fix agent is told to reject with reasoning where the reasoning holds.
