# Embedding reconcile for the distiller's dedup

Status: shipped 2026-08-23 in #101, pending the maintainer's truth-file run. Issue #93.
Follow-up scan: #100.

## Why

`findNearDuplicate()`'s body arm catches 0 of 25 real duplicates and every one of its nine
firings is a false positive. No threshold separates the classes — real duplicates score as low
as 0.115 on body containment while sitting at 0.78–0.87 in embedding space. The measurements
and the refutation of the 2026-08-17 calibration are in
[docs/decisions/2026-08-23-embedding-reconcile.md](../decisions/2026-08-23-embedding-reconcile.md).

Two gaps come with it: nothing compares a new note against notes written earlier in the SAME
distillation (the index is rebuilt afterwards), and correctly cross-linking two distinct notes
raises their similarity past the bar, so adjudicated keeps are re-proposed forever.

## Order of work

1. **Plan + decision record.** This file and the decision record, first commit, so the 2026-08-17
   containment numbers survive the deletion of the comment that held them.
2. **Shared predicate.** One exported function deciding "are these two cards duplicates" — raw
   cosine over card chunks, same layer, `>= PROFILE.dupeMin`. `--dupes` and the write-time check
   both call it. If they can disagree, the audit stops being an acceptance check.
3. **Socket dupe mode.** New request mode on `--serve`: candidate card text + slug + layer in,
   best same-layer note + raw cosine + the candidate's vector + a mode marker out. The marker is
   load-bearing: an older server does not error on the new request, it embeds the literal string
   `"undefined"` and answers confidently, and servers are keyed by model rather than version so an
   old one is never evicted.
4. **Distiller reconcile.** Build the would-be note content, chunk it with the existing chunker,
   take the card, ask the server. Top-1 only. Keep this run's `{note, vec}` in memory and check
   that first — same predicate, no index needed.
5. **`reconcile: manual`.** Frontmatter opt-out, note-scoped, blocking BOTH arms. New
   `scripts/lib/memory-mark.mjs` owns reading and writing it, behind a thin `scripts/memory-mark.mjs`
   entry; `/memory:prune` calls it on every kept pair. The distiller reads the mark through the same
   `isMarked()` that writes it — two regexes for one field is this PR's own bug at smaller scale. A
   `declined` count rides the existing `{written, merged}` return.
6. **Delete the body arm.** `bodyTokens`, `containment`, `RECONCILE_BODY_AT` and their tests.
   Not kept as a fallback — it is measured harmful. Fallback is the slug arm alone.
7. **`--dupe-eval`.** Truth-file sweep reporting caught/25 with the false count beside it. Harness
   ships, case set is gitignored. Its counting is `sweepDupes()` in `lib/`, tested, because an
   off-by-one in a denominator there is invisible — every column still looks plausible.
8. **Changelog** under `## [Unreleased]`.

## Done looks like

- The sweep reports caught/25 and a false count against the real vault, materially better than 0/25.
- The four adjudicated keeps are not proposed.
- Two insights restating one lesson in one distillation produce one note.
- An opted-out note is never auto-merged into, by either arm, and each block is counted.
- Server stopped and index absent: distillation still completes, dedup falls back to the slug arm.
- A reply without the mode marker is treated as no answer.
- `node --test`, `npm run typecheck`, `npm run format:check` all pass.

## Not here

- Periodic scanning (#100), merging the 26 existing pairs, automatic merges, slug-arm tuning,
  `dupeMin` re-calibration, `permanent/` consolidation (#96).

## Maintainer one-off

The agent cannot derive these — they are judgements:

1. `node scripts/memory-semantic.mjs --dupes`
2. Mark the four correct keeps with `scripts/memory-mark.mjs`.
3. Hand-write the first truth file: 25 duplicates plus those 4 keeps.
