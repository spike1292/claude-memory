---
description: Prune memory — archive old logs, dedup Insight notes (asks before deleting), refresh the search index
---

> **Paths.** Every shell snippet below assumes these two, set first:
> ```bash
> STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
> MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
> ```
> `$MEM` is the plugin root, `$STATE` is machine-local state (indexes, models, logs, eval cases).

Keep the vault signal-dense. `<slug>` = the project key: normalised git remote of `pwd` (e.g. `gitlab.example.com-teamname-frontend`), NOT the checkout path — run `. "$MEM/hooks/lib/vault-env.sh"; project_key "$PWD"`. Vault root: `<vault>` = `. "$MEM/hooks/lib/vault-env.sh"; resolve_vault`. Best run at **end of session**, after the Stop-hook distiller's final pass.

0. **Take the carry-forward list first — before looking for anything new:**

   ```
   node "$MEM/scripts/memory-audit-checks.mjs" --deferred
   ```

   It prints every `/memory:health` finding whose disposition in `REFLECTIONS.md` still reads *deferred*. Those are items a previous audit judged real and handed to prune; work them before hunting fresh duplicates, and **close each one by editing its disposition row** — "applied", "declined" with a reason, or "deferred" narrowed to whatever genuinely remains. An unedited row stays open forever and the next prune re-reads it.

   Why this is step 0: a deferred item used to survive only if the next prune happened to rank it. Two pairs deferred on 2026-08-08 were still sitting there on 2026-08-14, because the 2026-08-08 prune merged three *different* pairs and nobody ever went back to the row. The ledger is the fix; skipping it puts the leak straight back.

   Run the full `memory-audit-checks.mjs` (no flag) if you want its same-folder Jaccard pairs as a starting point for step 2 — it clusters same-folder first, which is what step 2 requires anyway.

1. **Archive old logs** (mechanical, safe): run
   `node "$MEM/scripts/prune-logs.mjs" "<vault>/Logs/<slug>"`
   (override the window with `PRUNE_DAYS=N`). This moves logs >90 days into `Logs/<slug>/Archive/` — no deletion.

2. **Dedup insights** (needs judgment). **Start from the semantic scan, not from titles:**

   ```
   node "$MEM/scripts/memory-semantic.mjs" --dupes [--min 0.75] [--top 30]
   ```

   It ranks same-folder pairs by embedding similarity in well under a second, and cross-folder pairs are excluded by construction. **Use it in preference to token overlap.** On 2026-08-14 the Jaccard scan in `memory-audit-checks.mjs` reported **0 pairs ≥0.45** across 987 notes while eleven real duplicates sat in them — notes that restate one idea in different words ("origin owns Cache-Control" / "cache-control at origin not CloudFront" / "cache-control source should follow the content source") share a concept but almost no vocabulary. That is the same keyword-vs-meaning gap that makes `ctx_search` miss paraphrased questions. Keep the Jaccard list as a secondary signal; it still catches literal restatements cheaply.

   **Calibration is per-model — do not carry a threshold across models.** Run it with no `--min` and trust the profile default (`bge-m3` 0.75, `bge-small-en` 0.86, `e5-multi` 0.95). The number does not transfer **in either direction**: e5-multi packs similarities into a high narrow band, so bge-small-en's 0.86 returns **29,560 pairs** under it — noise that reads like a backlog. bge-m3's band sits low and wide, so e5-multi's 0.95 returned **0 pairs on a 74-note set holding 16 real duplicates** — a clean bill of health that was pure miscalibration (measured 2026-08-17; that is why the default is now 0.75). **High similarity is not proof** — under the old model `aws-cra1-login` and `aws-cra2-login` scored 0.890 and must never be merged: same shape, opposite content (two different AWS orgs). And a clean run is not proof either: two real duplicates in that same set scored **below 0.70** and were found only by reading. The scan proposes; you judge.

   Then, for each candidate, find notes that describe the **same** lesson or that a later note supersedes.
   - **Cluster within each folder FIRST, then look across folders.** Cross-type pairs (a Mistake plus its matching Decision) are complementary by design and get kept — so if a greedy pass assigns a note to a cross-type cluster first and marks it consumed, it never gets compared against its real same-type twin and the duplicate survives the prune. That is precisely how `cloudfront-function-code-budgeting-with-esbuild` and `…-size-budgeting-with-esbuild` (Jaccard 0.67) slipped through on 2026-08-07 and were only caught by the next audit. Same-folder first, always.
   - Propose a concrete merge plan: which note survives, what content folds in, which become redundant.
   - **Do NOT delete anything without explicit confirmation** (vault rule). On confirmation: merge content into the surviving note and delete the redundant ones.
   - **Union the aliases on merge** (mandatory): before deleting a redundant note, fold every distinctive `_Also asked as:` paraphrase from it into the survivor's alias line. Dropping a deleted note's aliases silently shrinks retrieval coverage — a `/memory:eval` miss that looks like a vocabulary gap but is really merge-loss. Dedup near-identical phrasings; keep the union.

2b. **`--dupes` and `--clusters` are calibrated for bge-m3 as of 2026-08-17** (0.75 / 0.72), by the
   sweep below. They were **0.95 / 0.92**, copied from e5-multi and never measured, and at those
   values both scans reported nothing on a vault holding 16 real duplicates and 2 uncovered topics.
   If you change the model, redo this — and until you have, treat a clean run as unmeasured rather
   than as a clean vault.

   | `--dupes --min` | 0.95 | 0.90 | 0.86 | 0.84 | 0.80 | **0.75** |
   | --- | --- | --- | --- | --- | --- | --- |
   | pairs (74-note set) | 0 | 0 | 1 | 6 | 9 | **16** |

   Real duplicates occupied 0.75–0.869; the first coincidental pair appeared at 0.714.
   `--clusters` returned 0 topics at ≥0.76 and 2 real ones at **0.72**. Recalibrating is exactly
   this: sweep, then read the boundary pairs and find where real duplicates stop and coincidence
   starts. Note the tail — 2 real duplicates fell below 0.70 and no threshold would have surfaced
   them, so the sweep bounds the scan's reach, it does not eliminate reading.

3. **Refresh BOTH indexes** so retrieval reflects the pruned state — the FTS5 one below, and the semantic one: `node "$MEM/scripts/memory-semantic.mjs" --index` (incremental: re-embeds only notes whose CONTENT changed — a moved mtime costs one read and a hash — and drops rows for deleted notes, so it is seconds after a prune). **Run it here even though a SessionStart hook also refreshes it** — that hook fires at the *start* of the next session, and until then the vector side would keep answering with notes this prune just deleted. (Routine freshness after *new* notes is automatic — the distiller re-indexes at SessionEnd; this step matters mainly for **deletions**, which must drop stale chunks.)
   - **Source label is `vault-<layer>-<slug>` — the same `<slug>` as the directory** (unified 2026-08-19; it used to be `<repo>`, the lowercased checkout dir name, while the directory was already `<slug>`). Substitute `<slug>` verbatim — do not re-case it, do not re-derive it from the directory name. Any label that differs from the distiller's by so much as case makes FTS5 store a *second* copy, every note returns twice, and the effective result window halves.
   - **One-time migration (only until you have purged once):** every vault source indexed before 2026-08-19 sits under the old `vault-<layer>-<repo>` label, and the distiller now writes `vault-<layer>-<slug>` beside it. Both rows survive — context-mode's only automatic eviction is a 14-day staleness sweep on `indexed_at`, and re-indexing keeps the old rows fresh nowhere, so they age out only if nothing re-writes them. That is the duplicate-results hazard above, at the scale of the whole vault. The purge-then-reindex in the next bullet fixes it, which is why this prune runs it even when nothing was deleted. Confirm afterwards with `ctx_stats` (or a search) that no `vault-*-<repo>` source remains — `<repo>` being the old form, the lowercased last path segment of the checkout directory, which is what you are looking for the absence of.
   - **Run this every prune, deletions or not** — appended-to FTS5 keeps stale chunks after a delete, and until the label migration above has been purged once it is what removes the duplicate rows. Don't just re-index (append-only FTS5 keeps stale chunks): **`ctx purge` (scope: project) THEN re-index** all five sources — the four slug layers plus `permanent/`:
     - `ctx_index(path: "<vault>/Insights/<slug>", source: "vault-insights-<slug>")`
     - `ctx_index(path: "<vault>/Memory/<slug>", source: "vault-memory-<slug>")`
     - `ctx_index(path: "<vault>/Logs/<slug>", source: "vault-logs-<slug>")` and the same for `Graph`
     - `ctx_index(path: "<vault>/permanent", source: "vault-permanent")` — **not slug-scoped, and easy to forget.** The purge is scoped to the *project*, so it drops this cross-project layer's rows for this checkout as well, and nothing else puts them back until the next SessionEnd. `reindex()` in `hooks/lib/distill-session.mjs` issues five `cm index` calls for exactly this reason, and `hooks/lib/distill-session.test.mjs` asserts the fifth. A list that stops at the four slug layers leaves `permanent/` — the promoted, cross-project notes — missing from `ctx_search`, which is the same defect as leaving Logs and Graph out, one layer further up.
   - Verify: search a deleted note's title — it should no longer surface, and no note should appear twice under two sources whose labels differ only in the key.

3b. **Check for consolidation gaps** (occasionally — not every prune):

   ```
   node "$MEM/scripts/memory-semantic.mjs" --clusters
   ```

   Dedup asks "are these two notes the same?"; this asks the opposite question — **"are these twenty notes one topic that nothing summarises?"** It clusters across folders (a topic is normally a Pattern + a Mistake + a Decision) and reports clusters with no `permanent/` note as central to them as their own typical member. That is the `staging → promotion` step of the knowledge lifecycle, which has otherwise never happened: **965 Insights against 5 `permanent/` notes.** Two clusters found this way — 9 notes on cache-policy quota, 6 on Cache-Control ownership — had each sat unnoticed for weeks.

   **It finds where a note is missing; it does not write one.** Writing a synthesis note asserts a claim no single note makes, which is exactly where the distiller has confabulated before. Judge the cluster, then write it yourself.

4. Report: N logs archived, M duplicates merged, index refreshed (K notes across Insights+Memory), and anything left for manual review.

Occasionally (every few prunes) run `/memory:eval` afterwards to catch retrieval regressions — if recall@5 drops, add paraphrase aliases to the notes that missed.
