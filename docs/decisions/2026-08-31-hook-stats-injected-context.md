# What a session actually pays for injected context, and two ways to get it wrong

**Date:** 2026-08-31 · **Status:** shipped · **Issue:** [#36](https://github.com/spike1292/claude-memory/issues/36) PR 2

## Question

`/memory:doctor --hooks` reports what SessionStart hooks injected into the context window. What is
the right unit to average over, and what happens if you pick the wrong one?

## Answer

### Per-session, not per-line — a headless run doubles the naive count

Injected context is measured PER SESSION, because that is the unit a user pays it in — and only over
REAL sessions. A headless `claude` run (a distillation, a graph regen) fires SessionStart itself, so
its injector lines are a second population with nothing to do with what a person's session cost.
Folded in, they roughly doubled every count: on a synthetic 12-session log, an injector that fired in
3 sessions reported 15 runs.

`summarize()` therefore filters headless lines out (`!l.child`) before building the per-session map,
and counts a session where the hook ran and injected nothing as a real zero — not a skip. Mixing the
two would show an occasional injector as costing every session it merely ran in.

### The per-hook sum is a sum of means, not a per-session breakdown — the naive form overstates a rare big injector

`injectedSection()`'s headline number sums, across hooks, each hook's own mean over the sessions it
ran in. The naive alternative — summing actual per-session totals, or averaging only the sessions a
hook injected in — overstates an occasional large injector: on a synthetic log where `memory-link-lint`
injected 30 KB twice across forty sessions, the naive form reported ~7600 tokens/session against a
true ~100 for thirty-eight of those forty, and that inflated mean crossed the warning threshold that
then printed a false positive.

Averaging over every session the hook RAN in (not just the sessions where it injected) is deliberate:
"injected in 2 of 40 sessions, mean 380" and "40 of 40, mean 380" are different findings, and a mean
with no denominator cannot tell them apart.

## Caveat

Each hook's term is a mean over the sessions ITS OWN hook ran in. If two injectors ran in different
session subsets, the cross-hook sum is over populations that do not coincide — both hooks fire at
every SessionStart today, so they do coincide in practice, and the report labels the total "on
AVERAGE" rather than claiming more. Revisit if a SessionStart hook ever becomes conditional on
something other than always-fires.

## Related

[2026-08-20-hook-startup-cost.md](2026-08-20-hook-startup-cost.md) covers `bench-hooks.mjs`'s
*wall-clock cost* measurements; this record covers `hook-stats.mjs`'s *reporting correctness* —
related but distinct subjects.
