# The hash-column migration does not force a rebuild

**Date:** 2026-08-19 · **Status:** shipped

## What changed

`chunks` gained a `hash` column so `--index` can tell a note whose *mtime* moved (a Synology sync
touching the file) from one whose *content* moved. An index built before this column existed
still holds vectors this model built, and they answer exactly as well as they did before the
column shipped — only `--index` needs the column, and it fills it in by reading each note once
instead of re-embedding it (the backfill).

## Rejected: forcing a rebuild on a missing hash

A missing `hash` column is not treated as a model change and does not force `--rebuild`. The
version that did force one would have fired unattended on every existing install:
`semantic-index-refresh` launches `--index` **detached**, with its stdio in a log, and its rows
are written **outside a transaction**. A 20-40 minute bge-m3 rebuild interrupted by a sleep, a
reboot, or a quit leaves an index that is PARTIAL yet indistinguishable from a current one —
schema present, `meta.model` matching, `COUNT(*) > 0`. Recall would then rank over a fraction of
the vault and return confident, plausible, incomplete answers, which is precisely the failure the
model-change guard exists to prevent.

That risk stays behind an explicit `--rebuild`, where a user asked for it and is watching; it must
never be something the plugin opens on its own.
