# The link lint caches each note's wikilink targets (#202)

## Problem

`memory-link-lint` opened every `.md` under the project's `Memory/` and `Insights/` at every
SessionStart to find orphans. On this repo that is 1,120 files for 19 L1 notes. `/memory:doctor
--hooks` (2026-10-10 … 13) showed p50 787 ms and max 9,569 ms against the 10 s timeout. By hand:
3.49 s on a cold file cache, 0.25 s warm.

## Decision

A per-project cache at `$CLAUDE_MEMORY_HOME/cache/link-targets-<sha1(mem)[:12]>.json` holds, per
note, its `linkTargets()` and a `mtimeMs:size:ino` stamp. A note with an unchanged stamp is not
opened. Only `MEMORY.md` and the notes it points at are read in full, for the drift and size checks.
One file per project, so a run writes only its own entries and a deleted note drops out. The file is
written only when it changed, by tmp + rename.

The issue's other two options were not built. A detached run that reports at the next start shows
findings one session late. `git grep` needs a git-backed vault and still reads every file.

## Measurement

`node scripts/bench-hooks.mjs -n 20 --notes 19 --insights 1100`, synthetic vault in the OS temp dir
(local APFS, not cloud-backed), Node 24.19.0, darwin/arm64, 2026-10-13. `memory-link-lint` row, ms:

| | min | median | p90 | max |
| --- | ---: | ---: | ---: | ---: |
| before | 190.2 | 197.1 | 213.4 | 229.5 |
| after | 57.1 | 60.2 | 64.9 | 65.6 |

Floor (`node -e ""`) in the after run: median 29.3 ms. The first sample of each run builds the
cache, so `max` includes the cold-cache run.

**Not measured: a cold OS file cache.** `purge` needs root. Files the bench just wrote sit in the
page cache, so both rows are warm. After the fix a warm run opens 0 Insights notes and only stats
them; the cold-cache gain on a real vault is still to be read from `/memory:doctor --hooks`.

## Not changed

- What counts as an orphan.
- The hook timeout in `hooks.json`.
- `validate-note`'s orphan check still reads the whole corpus through `readCorpus()`. Its tests do
  not isolate `$CLAUDE_MEMORY_HOME`, so giving it the cache needs that first.
