# A second fact-drift scanner: 2 of 3 caught, 48 false positives, no CI gate

**Date:** 2026-10-13 · **Status:** declined · **Issue:** #134

## Question

Duplicated-fact drift — one figure written in two places, one copy edited — is the shared mechanism
behind 40 of 152 review findings (#134). Can a deterministic check catch it, where the scanner in
[2026-09-05-prose-ceiling.md](2026-09-05-prose-ceiling.md) scored 0?

The bar, set in triage: flag each known drift at its pre-fix commit, and ship as CI only with **0
false positives on HEAD**. `CHANGELOG.md` and `docs/research/` are out of scope (dated figures
change there on purpose).

## Method

Every tracked `.mjs` and `.md`. A fact is a number (digits, or `one`–`twelve`) followed by a unit or
noun on the same line (`176 MB`, `142 unique`, `four places`); years are skipped. Three groupings:

| Variant | Two facts conflict when |
| --- | --- |
| `sketch` (#134's proposal) | the two content words before the number, the unit and the next word all match, and the values differ |
| `near` | same unit, values differ by at most 1%, and the ±1-line windows share two or more words of 5+ letters |
| `near1` | `near`, but an off-by-one difference also counts |

`near` encodes what drift looks like: an edit to one copy usually moves a figure a little, so a
large difference between two figures is more often two different quantities.

The known drifts, at the commit a reviewer flagged them on:

| Case | Pre-fix commit | The copies |
| --- | --- | --- |
| #126 | `06a3836` | `memory-eval.mjs:177` and `memory-eval.test.mjs:701` say 143 unique, `lib/memory-eval.mjs:299` says 142 |
| #6 | `63f0bc2` | `release.sh:9`, `CLAUDE.md:152`, `ci-and-releases.md:24` say four; the code writes five |
| 175/176 | `5c9337e` (parent of `c9013e0`, #135) | `slim-install.mjs:3` says 175 MB; `CLAUDE.md:56` and `architecture.md:301` say 176 MB |

## Result

| Variant | #126 | #6 | 175/176 | Caught | Pairs flagged on HEAD `e08b695` | True drift among them |
| --- | :-: | :-: | :-: | :-: | ---: | ---: |
| `sketch` | no | no | no | 0/3 | 70 groups | 0 |
| `near` | yes | no | yes | 2/3 | 48 | 0 |
| `near1` | yes | no | yes | 2/3 | 297 | not read |

Both `near` hits go away at the merged commit (`9ad19f9`, `c9013e0`), so they are real catches. The
#126 hit pairs the right lines for a partly wrong reason: it matched the per-folder `142 unique`
against the pair's `143 unique`, not the two copies of the pair figure.

**#6 cannot be caught this way.** The stale copies say "four places" and the true one says "five
fields": different nouns, and a 25% gap. The real contradiction was between the prose and the code,
which held five `jq` paths and no number.

**Every one of `near`'s 48 HEAD pairs is a false positive**, in 15 clusters of values. They are of
four kinds:

- one figure rounded in one place and exact in another (`68%` / `67.9%`, `239` / `238.7 ms`);
- two columns of one table row (`92.9` / `92.6 ms`, `46.2` / `46.4 ms`);
- two different measurements that sit close (`380 MB` is `node_modules`, `381 MB` the whole
  version directory; `166 ms` and `165.2 ms` are two different hooks);
- test fixtures and worked examples (`965` / `968 Insights notes`, `1.3 GB` / `1.29 GB`).

Making the rule tighter to drop these would also drop the two catches, which are the same shape: a
figure 1% away, in a nearby sentence, with shared words.

## Decision

No CI check. The bar was 0 false positives, and the best variant has 48 on a tree with no known
drift. The scanner is not committed.

What it does show: a script can find *candidates*, but deciding "are these two numbers the same
claim?" needs a reader. That stays with the reviewer prompt in `claude-review.yml`, and with the cut
pass in CLAUDE.md, which removes the second copy before it can drift.

Re-open only with a variant that catches #6, or one with a false-positive count low enough to read
by hand on every PR.
