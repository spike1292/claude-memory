# Hook startup baseline

What every hook costs at startup, measured by `scripts/bench-hooks.mjs`. This is the number a
startup regression is compared against. It is replaced in place by a new run; the history is in
`git log`. Why the bench measures what it does, and the 2026-08-20 cut, are in
[decisions/2026-08-20-hook-startup-cost.md](decisions/2026-08-20-hook-startup-cost.md).

## Regenerate

```bash
node scripts/bench-hooks.mjs -n 20 --notes 50 --cwd ~/Development/claude-memory
```

`--cwd` must be a normal checkout, not a worktree: a worktree adds ~10 ms per hook (see the
decision record). Replace the table and the conditions together, never one without the other.

## Conditions

| | |
| --- | --- |
| date | 2026-10-12 |
| code | `1707e93` |
| vault | **synthetic, on local disk** — the bench's temp dir, never the cloud-backed real vault |
| notes | `--notes 50`: 50 L1 notes + 10 Mistakes |
| iterations | `-n 20` per row, plus a discarded warm-up |
| cwd | `~/Development/claude-memory`, a normal (non-worktree) checkout |
| machine | Apple M2 Pro, 16 GB, macOS 26.6.2, Node v24.19.0, darwin/arm64 |
| load | load average ~7 (other Claude sessions running) |
| path | the gate path — every hook decides there is nothing to do; nothing detaches |

## Results

Milliseconds. Compare medians; p90 and max on a loaded laptop are noise.

| what | n | min | median | p90 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| node -e "" (floor) | 20 | 26.6 | 28.4 | 30.4 | 30.8 |
| + import paths.mjs | 20 | 30.3 | 31.7 | 35.1 | 35.7 |
| + import hook-io.mjs | 20 | 30.0 | 32.6 | 42.0 | 44.6 |
| + import node:sqlite | 20 | 26.2 | 28.1 | 31.9 | 51.7 |
| insights-surface | 20 | 35.3 | 37.3 | 40.2 | 40.2 |
| memory-link-lint | 20 | 37.9 | 40.0 | 41.6 | 46.0 |
| semantic-index-refresh | 20 | 34.3 | 35.9 | 39.9 | 40.4 |
| graph-staleness-check | 20 | 33.3 | 34.7 | 38.0 | 38.5 |
| validate-note | 20 | 39.7 | 42.0 | 43.6 | 43.7 |
| distill-session (gate) | 20 | 35.7 | 37.9 | 58.4 | 137.9 |
| memory-recall (inert) | 20 | 30.4 | 33.9 | 35.6 | 37.9 |
| memory-recall (armed, no index) | 20 | 33.3 | 37.6 | 64.1 | 165.3 |

A run directly before this one, same conditions, agreed within 3 ms on every median except
`validate-note` (57.8) and `memory-link-lint` (45.1). Re-run before calling a move of that size a
regression.
