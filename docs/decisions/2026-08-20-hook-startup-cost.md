# What a hook costs at startup, and the one thing worth cutting

**Date:** 2026-08-20 · **Status:** shipped · **Issue:** [#37](https://github.com/spike1292/claude-memory/issues/37)
· **Extends** [2026-08-18-node-hooks.md](2026-08-18-node-hooks.md)

## Question

Every hook is a Node process, and a session pays for one on every event. The 2026-08-18 record
measured three of them by hand into a table nobody can re-run. Where does that time actually go —
the interpreter, the imports, or the work — and is any of it worth cutting?

## Answer

Imports are not the problem: nothing in `hooks/lib/` costs more than ~6 ms over a bare `node -e ''`,
and `node:sqlite` — the import that looked most suspicious — costs ~1 ms. **The problem was one
line, repeated in three entries.** `await new Response(process.stdin).text()` boots Node's
web-streams/fetch machinery to read a 100-byte JSON payload: **52.8 ms against a 34.6 ms floor**,
where `fs.readFileSync(0, 'utf8')` costs **35.1 ms** (n=12, medians). `hooks/lib/hook-io.mjs`
already had `readStdin()`/`payload()` doing exactly that for the gate hooks; the three entries that
predate it were still hand-rolling the slow version.

Switching them takes **~35 ms off every SessionStart** and **~16 ms off every Write/Edit**, which is
the hottest hook in the system. Nothing else was cut — see *What was not cut* below.

## How it was measured

`node scripts/bench-hooks.mjs [-n 20] [--notes 50] [--cwd .] [--keep]`, added by this change.
It builds a synthetic vault plus a scratch `HOME` and `CLAUDE_MEMORY_HOME` in a temp dir, refuses to
run if any of the three resolves outside it, and times each hook with the payload Claude Code would
send. The logic and its tests are in `scripts/lib/bench-hooks.mjs`.

Conditions for every number below, because a hook timing without them is not evidence:

| | |
| --- | --- |
| vault | **synthetic, on local disk** — a temp dir, never the cloud-backed real vault |
| notes | 50 L1 notes + 10 Mistakes, every tenth note MOC-only |
| iterations | **n=20** per row, plus a discarded warm-up |
| cwd | `~/Development/claude-memory`, a normal (non-worktree) checkout |
| machine | Node v24.16.0, darwin/arm64 |
| path | the **gate path** — every hook decides there is nothing to do; nothing detaches |

The gate path is not free by luck. `semantic-index-refresh` is the one hook the fixture would
otherwise satisfy — a populated `Memory/<slug>` plus an installed runtime is all `plan()` asks —
so it is given an empty scratch vault of its own, and `resolveSlug()` returns null after doing
the same `projectKey()` and stat work. Without that it detaches a real `memory-semantic.mjs
--index` child that loads the model, under a scratch root the bench then deletes. The row is
unmoved by the change: 40.5 ms median on a re-run (n=20) against 40.0 ms in the table below.

A cloud-backed vault moves all of this substantially (SessionStart 798 ms vs 485 ms in the
2026-08-17 record). These are the local-disk numbers and comparable only with other local-disk ones.

## Before

| what | n | min | median | p90 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| node -e "" (floor) | 20 | 30.9 | 32.4 | 35.9 | 37.7 |
| + import paths.mjs | 20 | 35.9 | 38.1 | 41.2 | 44.9 |
| + import hook-io.mjs | 20 | 35.4 | 38.4 | 41.0 | 42.8 |
| + import node:sqlite | 20 | 31.7 | 34.1 | 36.5 | 37.9 |
| insights-surface | 20 | 53.8 | 55.6 | 57.5 | 109.3 |
| memory-link-lint | 20 | 55.2 | 60.2 | 69.3 | 149.8 |
| semantic-index-refresh | 20 | 36.7 | 39.7 | 43.6 | 43.7 |
| graph-staleness-check | 20 | 35.7 | 40.9 | 43.8 | 43.8 |
| validate-note | 20 | 55.7 | 57.5 | 59.3 | 63.0 |
| distill-session (gate) | 20 | 38.6 | 40.4 | 42.2 | 42.5 |
| memory-recall (inert) | 20 | 35.6 | 37.9 | 39.3 | 44.3 |
| memory-recall (armed, no index) | 20 | 39.5 | 41.3 | 63.9 | 64.9 |

## After

| what | n | min | median | p90 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| node -e "" (floor) | 20 | 30.3 | 32.2 | 35.2 | 37.8 |
| + import paths.mjs | 20 | 35.1 | 37.4 | 39.6 | 40.5 |
| + import hook-io.mjs | 20 | 35.5 | 38.2 | 42.1 | 53.4 |
| + import node:sqlite | 20 | 31.1 | 32.9 | 35.2 | 37.4 |
| insights-surface | 20 | 36.9 | 40.8 | 44.1 | 44.1 |
| memory-link-lint | 20 | 40.8 | 42.0 | 44.9 | 45.1 |
| semantic-index-refresh | 20 | 37.0 | 40.0 | 45.4 | 47.2 |
| graph-staleness-check | 20 | 36.2 | 38.2 | 72.7 | 101.4 |
| validate-note | 20 | 40.0 | 41.8 | 45.0 | 45.9 |
| distill-session (gate) | 20 | 38.1 | 40.0 | 41.5 | 41.6 |
| memory-recall (inert) | 20 | 35.3 | 37.0 | 38.5 | 38.8 |
| memory-recall (armed, no index) | 20 | 38.4 | 39.4 | 41.8 | 42.1 |

Medians, before → after: `insights-surface` 55.6 → 40.8 (**−14.8**), `memory-link-lint` 60.2 → 42.0
(**−18.2**), `validate-note` 57.5 → 41.8 (**−15.7**). The four Node SessionStart hooks together go
**196.4 ms → 161.0 ms (−35.4)**. Everything else moved less than 3 ms, which is inside what this
bench can resolve — and `graph-staleness-check`'s 101.4 ms max, against a 38.2 ms median, is the
reason the headline column is the median: one outlier per twenty runs is a laptop, not a hook.

## What the numbers say beyond the cut

- **No hook is import-bound.** `paths.mjs` +5.2 ms, `hook-io.mjs` +6.0 ms, `node:sqlite` +0.7 ms
  over the floor. The lazy-import idea in #37 has nothing to buy: `memory-recall.mjs`'s four static
  imports, the ones its own header warns about, are collectively cheaper than one `Response`.
- **After the cut every hook sits within 5 ms of the `paths.mjs` import row** (37.4 ms). That 5 ms
  is all the work there is: reading 50 notes, one or two `git` forks, a `stat` pass. It is the shape
  you want — the floor dominates, and the floor is Node's, not ours.
- **A git worktree costs ~10 ms per hook**, because `projectKey()` refuses to cache when `.git` is a
  file (`gitConfigFor()` cannot cheaply confirm which config decides the key), so every hook forks
  `git` again. Same bench, same n, cwd inside a worktree: `semantic-index-refresh` 49.9 vs 40.0,
  `graph-staleness-check` 48.8 vs 38.2, `memory-recall (armed)` 51.5 vs 39.4. Left alone
  deliberately: a worktree is a developer's situation, not a user's, and the fix — parsing
  `gitdir:` out of the `.git` file and stamping the common dir's config — adds a resolution path to
  the one module that must not grow one for a case measured at 10 ms.

## What was not cut

- **Lazy imports.** Nothing to buy (above). It would also have to be argued past the entry/`lib`
  split.
- **A narrower `hooks.json` matcher.** `validate-note` is already `Write|Edit|MultiEdit`, and the
  remaining waste — a Write to a source file, which is most of them — is now ~42 ms of which ~37 ms
  is Node starting up. Matching on path is not something a `matcher` can express.
- **Skipping work when the vault is missing.** Already the behaviour: `insights-surface`,
  `memory-link-lint` and `semantic-index-refresh` all resolve a slug and return on a missing
  directory. The bench has a vault *present*, so those rows include the work, not the skip.
- **Bundling or precompiling.** Out of scope by the issue, and the numbers agree: it would attack
  the 5–6 ms of module resolution and leave the 32 ms interpreter floor untouched.

## The rule this is another instance of

The 2026-08-18 record ends "a floor is not a budget". This is the same lesson from the other side:
**a cost that looks like the floor may not be the floor.** Three hooks appeared to be 55–60 ms Node
hooks doing 20 ms of vault work. They were 40 ms Node hooks doing 5 ms of vault work, plus 18 ms of
runtime bootstrap bought by a convenience API. Nothing found that except measuring the pieces —
which is why `bench-hooks.mjs` measures the floor and the imports as rows, not just the hooks.

## If you want to revisit

Re-run `node scripts/bench-hooks.mjs -n 20 --notes 50` and paste the table. State the vault
(cloud-backed or local), the note count and n, or the numbers are not comparable with these.
