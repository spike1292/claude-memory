# The day-claim guard: three attempts, why `wx` won

**Date:** 2026-08-21 · **Status:** shipped · **Extends** [2026-08-20-hook-startup-cost.md](2026-08-20-hook-startup-cost.md)

## Question

`hook-io.mjs`'s `appendJsonl()` runs a retention pass (`pruneDatedLogs()`) on the first append of a
new day, machine-wide, from `logs/`, which every SessionStart hook and every prompt writes to
concurrently. What claims exactly one process for that pass, and what happens to the rest?

## What was tried

1. **`!existsSync(today's marker)`.** Check-then-act across PROCESSES — `logs/` is machine-wide,
   five SessionStart hooks fire at once, each family has its own file. Measured 2026-08-21: NINE of
   nine concurrent hooks each ran a full pass.
2. **A read-then-write date stamp.** Took the median down to one pass, but left a window (up to
   eight of nine passing in 15 trials) and, worse, INVERTED when the stamp could not be written:
   the read never returned today, so every append pruned — 20 of 20 trials, 146 ms each, forever.
3. **`wx` create-if-absent on `logs/.retention-<day>`.** Atomic: the create either succeeds for
   exactly one process or throws `EEXIST`. Measured after the change, 15 trials of nine concurrent
   hooks over a 300-file backlog: EXACTLY ONE pass every trial, and zero passes when `logs/` is
   read-only.

## Answer

`wx`. Any other error (read-only `logs/`, `EACCES`) means the claim could not be made, and
therefore we do not prune — right, because the unlinks would fail for the same reason. Fail-closed
here is a directory that keeps growing; fail-open was a full `readdir` on every prompt.

The claim is taken BEFORE the pass runs, not after, so a process killed mid-pass leaves the rest of
the backlog until tomorrow — bounded, and the alternative is a lock this path must not wait on.

## Mechanism

`logs/.retention-<day>` is created with `fs.openSync(path, 'wx')` and closed immediately; its
content is unused, only its existence. `pruneDatedLogs()` sweeps it alongside the dated logs it
authorises deleting, so `logs/` does not accumulate one dotfile per day in the name of not
accumulating one log file per day. Implementation: `claimDay()` in `hooks/lib/hook-io.mjs`.

## If you want to revisit

Re-run the concurrency trial (nine parallel processes claiming the same day, a backlog of dated
files to prune) and compare pass counts against the numbers above.
