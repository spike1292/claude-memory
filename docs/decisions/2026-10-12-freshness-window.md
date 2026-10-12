# FRESH-2 freshness window: 90 days by default

**Date:** 2026-10-12 · **Issue:** #68

## Decision

`/memory:health` warns on an inline `as of YYYY-MM-DD` stamp older than its window. The default
window is **90 days**. `freshnessDays` in `config.json` overrides it per vault-relative folder
prefix; the longest prefix wins.

## Why 90

The policy we borrowed (docs/research/2026-08-21-obsidian-second-brain.md) defaults to 7 days,
because its fast facts are CRM counts. Ours are engineering measurements with longer half-lives.

Measured on the maintainer's vault on 2026-10-12 with `grep -E "as of [0-9]{4}-"` over the
folders the audit scans — every project's `Memory/` and `Insights/*/{Patterns,Mistakes,Decisions}`,
37 stamps. `permanent/` is not audited and is not counted.

| Window | Stamps flagged |
| --- | --- |
| 7 days | 37 |
| 30 days | 35 |
| 60 days | 29 |
| 90 days | 8 |
| 180 days | 0 |

A window that flags nearly everything trains people to ignore the audit. 90 days flags about a
fifth of the stamps: a list someone can work through.

## Scope

- Only `as of` stamps count. A bare date, a `Measured …` line, and anything under a dated heading
  are snapshots by protocol and record what was true then, so they cannot go stale.
- Ages are whole calendar days against the LOCAL date: stamps are written by hand in local time.
- Not in `checkFile()`: the write-time hook shares it, and a stamp is never stale when written.
- No ranking change. Decay in retrieval is #69.
