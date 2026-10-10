# A soft cost budget for `MEMORY.md`, separate from the load cap

2026-10-10 — settles [#109](https://github.com/spike1292/claude-memory/issues/109). Extends
[2026-08-22-auto-memory.md](2026-08-22-auto-memory.md); does not change it.

## Two questions, two numbers

`AUTO_MEMORY_CAP` (25 KB / 200 lines) answers "will Claude Code truncate it?". It says nothing about
"what does loading it cost?". A MOC can pass the first and be the most expensive thing the plugin
does: the work repo below sat at 78% of the cap in August, was reported healthy, and cost ~5k
tokens at every start.

So `/memory:doctor` now prints a second figure per MOC, from `costReport()`:

- estimated tokens per session start — `bytes / BYTES_PER_TOKEN`, the same single estimator the
  `--hooks` report uses, labelled ESTIMATED;
- distinct `session` ids with `event: "SessionStart"` for that slug in `logs/hooks-*.jsonl`, over
  the logged days `logRetentionDays` kept. Distinct sessions, not lines: several hooks log at one
  start, so lines overcount 3–4×;
- `unmeasured` when the log has no start for the slug, never `0 starts`.

It reads the same `mocs()` walk as `capReport()`, so the two cannot disagree about which file a slug
is, and the legacy-key caveat `capReport()` states holds for both.

## The budget: 2,000 estimated tokens per start

Measured on this machine, 2026-10-10, 22 logged days, every MOC in the vault (slugs withheld):

| MOC | est. tok/start | starts/day | est. tok/day |
| --- | --- | --- | --- |
| work repo | 5,936 | 6.1 | 36,422 |
| B | 939 | 1.2 | 1,152 |
| C | 548 | 0.9 | 473 |
| D | 252 | 1.0 | 263 |
| E | 102 | 0.2 | 23 |

Every healthy MOC is under 1,000; the outlier is 6× that. 2,000 sits in the gap with 2× headroom
for the largest healthy one, and it is already `INJECTED_TOKEN_BUDGET` — the opening-cost budget
for hook-injected context — so it is reused rather than becoming a second number. Five files over
three weeks is a starting value, not a proven one.

## What it does not do

- It **warns, never fails.** `fail` stays reserved for truncation, which loses content; cost does
  not.
- It **trims nothing.** "Reporting is the bound" from 2026-08-22 stands.
- The budget is per start, not per day. The frequency is printed beside it so a human can weigh a
  MOC opened twice a week against one opened six times a day; a per-day threshold would need its
  own data.
