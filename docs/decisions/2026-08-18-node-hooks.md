# The last three gate hooks move to Node

**Date:** 2026-08-18 · **Status:** shipped · **Supersedes the "Do not port" list in**
[2026-08-17-shell-vs-node-hooks.md](2026-08-17-shell-vs-node-hooks.md)

## Question

The 2026-08-17 record kept `semantic-index-refresh.sh`, `graph-staleness-check.sh` and
`distill-session.sh` in bash under the rule *"a gate that decides cheaply and spawns belongs in
bash"*. Does that still hold when the criteria are duplication, testability, portability and
readability rather than latency?

## Answer

No — and the latency premise was wrong too. All three are now Node.

## The measurement that settled it

The 2026-08-17 record's floors are correct and still stand:

| | |
| --- | --- |
| bash | 4.7–5.4 ms |
| bash + source `vault-env.sh` | 15.0 ms |
| node | 38.4–40.5 ms |
| node + import `paths.mjs` | 42.7 ms |
| one fork (`jq` / `git` / `grep`) | 2.8–4.1 ms |

**They were applied to the wrong thing.** "bash 5 ms vs node 40 ms" describes a *bare* gate. None
of these three was bare: each sources `vault-env.sh` and forks `git` and `jq` several times before
it decides. `distill-session.sh` parsed its payload with **five separate `printf | jq` pipelines**.

Measured end to end, gate path only (the hook decides there is nothing to do and exits), vault on
**local disk** — an empty temp vault, not the cloud-backed one — n=30:

| hook | bash | Node | |
| --- | ---: | ---: | --- |
| `semantic-index-refresh` | 43.6 ms | 45.7 ms | +2.1 ms |
| `graph-staleness-check` | 46.2 ms | 46.4 ms | +0.2 ms |
| `distill-session` | 58.5 ms | 48.6 ms | **−9.9 ms** |
| **total** | **148.3 ms** | **140.7 ms** | **−7.6 ms** |

The port is a net *win*, carried by the distiller's five `jq` forks. The other two are inside noise.

**This is the repo's own recurring mistake, one level up.** Three of the recorded L3 lessons are
about measuring the wrong path — *"timing below runtime floor is a measurement malfunction"*,
*"timing through excluded/early-exit code paths hides real performance"*. Here a correct floor was
quoted about hooks that never ran at it. A floor is not a budget.

## Why, beyond the numbers

- **Duplication.** `graph-staleness-check.sh` probed four candidate `claude` paths in bash while
  `distill-session.mjs` probed the same four in Node, and nothing kept the lists in step. Both now
  call one `findClaude()` in [`hooks/lib/hook-io.mjs`](../../hooks/lib/hook-io.mjs), along with one
  stdin parser, one debounce-marker implementation and one `detach()`.
- **Testability.** The three shell files had **zero** tests, and their logic — a 24h debounce, a
  2h Stop debounce, a >400-message threshold, a short-sha staleness comparison — was untestable
  without spawning bash. The suite went from 76 to 99 tests, all of the new ones covering decisions
  those scripts made silently.
- **Portability.** Three fewer files depending on `jq`, on BSD-vs-GNU `stat`, and on `date +%s`.
- **Readability.** Each hook is now a decision function returning a verdict (`plan()` / `gatePlan()`)
  plus a three-line executor. The verdict is inspectable; `set -euo pipefail` plus early `exit 0`
  was not.

## What did NOT change

- **`vault-memory-sync.sh` stays bash.** The reason was never language: it moves files and repoints
  a live symlink in a cloud-synced vault, and has cost 24 notes once. It needs a characterisation
  test before it needs a port.
- **`doctor.sh` stays bash.** Its job includes diagnosing a broken Node runtime, and a Node doctor
  cannot report "node is missing".
- **The rule itself still holds** — fork count decides, not language. This record does not overturn
  it. It records that the rule was applied without counting the forks.

## Also folded in

- The redundant `$MEMORY_HOME/.semantic-index.lock` is **deleted**. The indexer's own per-model
  lock (`db/.index-<model>.lock`) is the one that guards the mixed-dimension corruption it was born
  from; the outer lock's only observable effect was a **silent** skip — on contention it exited 0
  with no output, so a session that indexed nothing looked exactly like one with nothing to index.
- Debounce markers move from `~/.cache/claude-{distill,graphgen}/` into
  `$CLAUDE_MEMORY_HOME/cache/`, and the two background logs into `$CLAUDE_MEMORY_HOME/logs/`. Same
  rule as `db/`, `models/` and `eval/`: one machine-local root to inspect, size and clear. Cost of
  the move is one missed debounce per marker at upgrade — a single extra background run, never a
  wrong one.

## If you want to revisit

Re-measure before arguing. The numbers above are the **gate path on local disk**; a cloud-backed
vault moves every hook in this system substantially (SessionStart 798 ms vs 485 ms in the 2026-08-17
record), and any comparison that does not state which one it used is not evidence.
