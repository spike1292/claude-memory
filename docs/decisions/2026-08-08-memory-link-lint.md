# The MOC-only lint: why prose didn't hold

**Date:** 2026-08-08 · **Status:** shipped

## Question

CLAUDE.md documents a convention: every L1 note needs "≥2 wikilinks, linked both ways." Does
stating it in prose keep it true?

## Answer

No. `/memory:health` found MOC-only notes (reachable only from the MOC, invisible to the note
graph) in three consecutive audits: 2026-08-07 (four notes), 2026-08-08 (`jira-zscaler-403`),
2026-08-08 (`prod-error-baseline`). On the third recurrence in the same day, the standing rule
became a lint: `hooks/lib/memory-link-lint.mjs`, run at SessionStart.

MOC-only is not corruption — the note is findable by direct link or search. It is invisible to the
note graph, so nothing leads a reader to it while reading a sibling note. Reporting it at session
start is what makes it fixable; the lint names notes only and never auto-fixes, since deciding
WHICH sibling should link back is a judgement call the lint cannot make.

## Scope, since #75

The lint also reports everything else true of `MEMORY.md` itself: its size against the cap Claude
Code loads it under, for the current project (the lint output) and for every project in the vault
(`capReport`, read by `/memory:doctor`).
