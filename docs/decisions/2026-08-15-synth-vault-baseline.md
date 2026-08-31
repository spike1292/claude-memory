# The synthetic vault's seed-7 baseline, and why the English set is a tripwire, not evidence

**Date:** 2026-08-15 · **Status:** adopted · **Source:** `scripts/lib/memory-synth-vault.mjs`

## Why a fixed vault

A versioned case set pins the QUESTIONS but not the NOTES. On 2026-08-15 that gap faked a result
three times in one day — the same 28 questions scored @1 32.1% and then 28.6% an hour later, with
no retrieval change, because a note had been added in between. Every A/B was really "old retrieval
on 1034 notes vs new retrieval on 1047 notes".

Borrowed from obsidian-second-brain's `scripts/eval/BENCHMARK.md`, whose sharpest idea is that gold
answers are known BY CONSTRUCTION — the generator wrote the canonical note, so there are no
judgement calls.

## Real prose, invented names only

Deliberate departure from obsidian-second-brain: they compose notes from invented vocabulary.
Invented words carry no meaning for an embedding model, so a paraphrase test over them measures
nothing but tokenisation. Here the PROSE is ordinary English (so meaning is real) and only the
product NAMES are invented (so gold stays unique and can never collide with a real note). The
comment left in code keeps the resulting rule (real prose, invented names) as a two-line invariant;
this record is the argument for why that rule exists.

## Baseline (seed 7, 300 notes, 40 gold, 2026-08-15)

MEASURED BASELINE — seed 7, 300 notes, 40 gold cases (2026-08-15):

| model | EN paraphrase @1 | EN MRR | NL paraphrase @1 | NL MRR |
| --- | ---: | ---: | ---: | ---: |
| bge-m3 | 100% | 1.00 | 100% | 1.00 |
| bge-small-en | 100% | 1.00 | 17.5% | 0.241 |
| lexical (BM25) | 60% | 0.653 | 5% | 0.100 |

## Hardening attempt (failed)

HARDENING ATTEMPT (2026-08-15): FAILED on English. Two "echo" notes per gold case were added — same
domain, same opening symptom, then an explicitly different cause and fix. English stayed at 100%
for both models; Dutch moved 100% → 95% @1. The model separates them easily because an echo STATES
its different cause in plain language, and that is what the vector reads.

The obvious next step is not being taken: echoes carrying the gold note's FULL body would compete
hard, but they would also become a second valid answer to the paraphrase — and the acceptance test
here CANNOT SEE THAT. The keyword set identifies gold by title words, which are deliberately
disjoint from the paraphrase, so an ambiguous paraphrase still scores 100% on keywords. A test that
cannot fail on the thing it is guarding is not a guard. Hardening this properly needs hand-authored
near-misses with a human deciding "is this also a correct answer?", which is the judgement call the
generate-by-construction design exists to avoid.

So: the echoes stay (they cost nothing and make the vault marginally more realistic), and the
English set remains a TRIPWIRE. Use the real-vault case sets for small deltas.

**ECHO_CAUSES mechanism** (`scripts/lib/memory-synth-vault.mjs`, above `ECHO_CAUSES`): the first
version of this vault scored 100% on English for two different models, i.e. no headroom, because
the 260 filler notes competed on TOPIC but never on the specific issue — and the real failure mode
is the right note losing to a near-identical SIBLING. An echo restates a gold note's symptom in the
same domain and then diverges: different cause, different fix. (The code comment above
`ECHO_CAUSES` keeps the resulting verification rule — check the keyword case set before widening an
echo — and points here for why.)

## Why the English set is a tripwire, not evidence

READ THAT HONESTLY. The English set is AT ITS CEILING: two different models both score 100%, so it
cannot detect an improvement and must not be quoted as evidence that one is better. It is a
TRIPWIRE — the mean-pooling bug that took the real vault from @5 67.9% to 25.0% would collapse
these numbers, and that is what it is for. The Dutch set is the discriminating one, and it settles
the model choice on a note set that cannot move underneath the comparison.

Hardening the English set needs distractors that are near-misses rather than merely same-domain;
the 260 filler notes compete on topic but not on the specific issue, which is why there is no
headroom. Until then, use the real-vault case sets for small deltas and this vault for breakage.
