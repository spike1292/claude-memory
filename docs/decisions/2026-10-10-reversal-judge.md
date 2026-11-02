# A haiku judge decides when a merge is a reversal

2026-10-10 — settles [#156](https://github.com/spike1292/claude-memory/issues/156).

## What it is

`reconcile()` used to append every matched insight to its note as `**Also seen**`, so a lesson that
reversed the note was filed as support for it. Now the distiller collects the run's merge pairs and
makes one extra `claude -p --model haiku` call over all of them (`JUDGE_PROMPT` in
`hooks/lib/distill-session.mjs`). On `reverses`, with a quoted old claim that is really in the note
(normalised, at least 12 characters), the insight becomes its own note with a back-link, and the old
sentence gets `(superseded <today> by [[new-note]])`, which #163's ranking demotes. Anything else,
including a failed call, merges as before. `reconcile: manual` notes are never merge pairs, so they
are never judged or touched.

## The measurement

Pairs are the real vault's `**Also seen**` appends: 507 pairs from 421 Insights notes, labels and
text machine-local. The answer key is 61 pairs labelled by hand: every pair any run flagged plus 30
random unflagged ones. It holds 20 real reversals; the 30 random pairs held 0. Real reversals are
~4% of merges.

| Variant | Hits / 20 | False alarms | Cost |
|---|---|---|---|
| haiku, shipped prompt, 31 pairs per call (×2 runs) | 13, 13 | 6, 6 | ~$0.01 per call |
| haiku, shipped prompt, 3 pairs per call | 12 | 8 (3 unanswered) | $0.007 per call |
| haiku, shipped prompt + "same subject" rule (×2) | 12, 11 | 5, 7 | ~$0.01 per call |
| sonnet, shipped prompt | 11 | 2 | ~$0.18 per call |

On this key, about 60% recall and 65% precision; no prompt or batch size moved that. Production
precision was 15% (see "Re-measured on production verdicts"). A false mark only demotes a
note, it never hides one. Every quoted claim in these runs was in its note verbatim, so the quote
check rejected nothing; it stays because it is what ties each marker to evidence.

Cost of one call from `--output-format json`, shipped prompt, synthetic pairs: $0.0063 for 1 pair,
$0.0067 for 5. Nearly all of it is the headless session's fixed context (~30k cache-write tokens).

## Why not a local NLI model

`Xenova/nli-deberta-v3-xsmall` (q8) scored 24/24 on a hand-written synthetic set at 17 ms per pair.
On the real pairs it called 179/507 "reverses", 0 of a 15-pair random sample of those were real,
and it took ~3 s per pair. NLI models are trained on single short sentences; these are
multi-sentence notes.

## Re-measured on production verdicts (2026-11-02, #221)

Every `reverses` verdict from 2026-10-11 to 2026-10-31, joined to its pair from the judge's own
`distill-*.jsonl` records and labelled by hand (labels and text machine-local):

| Label | Pairs |
|---|---|
| real reversal (NEW right, OLD out of date) | 5 |
| backwards (NEW contradicts OLD, OLD is right) | 4 |
| same | 11 |
| extends | 14 |
| total | 34 |

Precision is 5/34 (15%), against the answer key's figure above. That key was built from
`**Also seen**` appends, so it never held the restatements the extractor writes day to day. The
quote check refused none of the 34: a restatement shares the words it quotes. The backwards row is
a failure the first measurement had no label for; on it the marker demotes the correct note.

## Where it is logged

The worker line carries `judge` (verdict counts, zeros omitted; `rejected` is a `reverses` the quote check refused).
The call's cost is its own `event: 'judge'` line, like the extractor's `extract` line: every usage
field the envelope reported and none it did not, `outcome: 'error'` for a billed failure, and no
line at all when no envelope came back. `/memory:doctor --hooks` prints it as a second cost table,
per call over the runs that made one; a window without a judge line says "not measured" (#168).
