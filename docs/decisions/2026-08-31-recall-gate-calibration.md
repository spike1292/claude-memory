# The recall hook's BM25 gate: 6.0, not ~14

**Date:** 2026-08-31 · **Status:** shipped · **Issue:** [#36](https://github.com/spike1292/claude-memory/issues/36) PR 2

## Question

`hooks/lib/memory-recall.mjs`'s keyword arm abstains below `MIN_SCORE`. What sits behind that
number, and why does it stay at 6.0 when the sweep behind it shows 14 would cut false fires on
off-topic prompts in half?

## How it was measured

`memory-synth-vault.mjs --seed 7`, re-run at 120/300/1000 notes (`--notes 100` built 120 notes
before #49 made that flag a ceiling), scored with `cases-paraphrase.jsonl` + `cases-keyword.jsonl`
— 80 on-topic prompts whose gold note is known by construction, authored by nobody for this sweep.

The off-topic control was a separate 28-question authored set about a corpus the bench vault does
not contain, so no bench note is a right answer and every fire on it is pure noise. It is named by
that property (an off-topic control against a corpus the vault lacks) rather than by a path, because
an unscoped case-set name is owned by whichever project authored one first (#97).

That control set is **machine-local and cannot ship**: authored case sets live under
`$CLAUDE_MEMORY_HOME` and are private by policy, so the on-topic half of the table below is
reproducible from the committed generator and the off-topic half is not. To re-run the off-topic
half, author your own questions about a corpus the bench vault does not contain
(`memory-eval.mjs --author`) — any set where every fire is by construction wrong will do.

The instrument is `keywordArm`'s own ranking, not a model of it: `bm25(cards, [...new
Set(lexTokens(q))], 1.2, 0.75)` over the `(card)` chunks, which agreed with `keywordArm`'s own
decision on 120/120 cases at 6.0. `--mode lexical` in `memory-eval.mjs` is **not** this instrument
— it scores whole notes, and on these same cases puts gold at rank 1 for 50% (paraphrase) and 25%
(keyword) against `keywordArm`'s 100% on both.

## The sweep

| gate | on-topic answered (of 80) | off-topic false-fire (of 28) | at 120/300/1000 notes |
| ---: | --- | --- | --- |
| 6.0 | 80  80  80 | 17  19  28 | |
| 10.0 | 80  80  80 | 9  11  13 | |
| 14.0 | 80  80  80 | 8   8  10 | |
| 17.0 | 79  80  80 | 4   6   8 | |

6.0 is **not** too high. The weakest on-topic prompt scores 15.2/17.4/20.3 — a 2.5-3.4x margin — and
no gate from 0 to 12 suppresses one of the 80; gold is at rank 1 for every one of them.

It is too **low** in the other direction: it sits inside the off-topic band (5.5-32.1 at 300 notes)
and rejects between a third of it and none of it, so a long prompt that merely shares software
vocabulary gets an answer anyway. ~14 halves the false fires at zero on-topic cost at all three
corpus sizes.

## Why 6.0 ships anyway

**Deliberately not changed.** Moving it is a behaviour change on every prompt, and this sweep is a
direction rather than a value ready to cut in. Absolute BM25 is corpus-scaled (avgdl moved 82 → 51
across the three sizes), the synthetic prose is tidier than a real vault's, and the off-topic control
is contaminated — both corpora are software prose. Read the abstain rate in the log
(`logs/recall-<date>.jsonl`, `/memory:doctor --stats`) before trusting either number against a real
vault.

## If you want to revisit

Re-run `memory-synth-vault.mjs --seed 7` at the same three sizes, author a fresh off-topic control
under `$CLAUDE_MEMORY_HOME` about a corpus the bench vault does not contain, and compare the abstain
rate this sweep predicts against what a week of real `recall-<date>.jsonl` logs actually show.
