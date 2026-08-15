---
description: Prune memory — archive old logs, dedup Insight notes (asks before deleting), refresh the search index
---

> **Paths.** Every shell snippet below assumes these two, set first:
> ```bash
> STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
> MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
> ```
> `$MEM` is the plugin root, `$STATE` is machine-local state (indexes, models, logs, eval cases).

Keep the vault signal-dense. `<slug>` = the project key: normalised git remote of `pwd` (e.g. `gitlab.example.com-teamname-frontend`), NOT the checkout path — run `. "$MEM/hooks/lib/vault-env.sh"; project_key "$PWD"`. `<repo>` = last path segment of `pwd`, lowercased. Vault root: `<vault>` = `. "$MEM/hooks/lib/vault-env.sh"; resolve_vault`. Best run at **end of session**, after the Stop-hook distiller's final pass.

0. **Take the carry-forward list first — before looking for anything new:**

   ```
   node "$MEM/scripts/memory-audit-checks.mjs" --deferred
   ```

   It prints every `/memory:health` finding whose disposition in `REFLECTIONS.md` still reads *deferred*. Those are items a previous audit judged real and handed to prune; work them before hunting fresh duplicates, and **close each one by editing its disposition row** — "applied", "declined" with a reason, or "deferred" narrowed to whatever genuinely remains. An unedited row stays open forever and the next prune re-reads it.

   Why this is step 0: a deferred item used to survive only if the next prune happened to rank it. Two pairs deferred on 2026-08-08 were still sitting there on 2026-08-14, because the 2026-08-08 prune merged three *different* pairs and nobody ever went back to the row. The ledger is the fix; skipping it puts the leak straight back.

   Run the full `memory-audit-checks.mjs` (no flag) if you want its same-folder Jaccard pairs as a starting point for step 2 — it clusters same-folder first, which is what step 2 requires anyway.

1. **Archive old logs** (mechanical, safe): run
   `"$MEM/scripts/prune-logs.sh" "<vault>/Logs/<slug>"`
   (override the window with `PRUNE_DAYS=N`). This moves logs >90 days into `Logs/<slug>/Archive/` — no deletion.

2. **Dedup insights** (needs judgment). **Start from the semantic scan, not from titles:**

   ```
   node "$MEM/scripts/memory-semantic.mjs" --dupes [--min 0.86] [--top 30]
   ```

   It ranks same-folder pairs by embedding similarity in well under a second, and cross-folder pairs are excluded by construction. **Use it in preference to token overlap.** On 2026-08-14 the Jaccard scan in `memory-audit-checks.mjs` reported **0 pairs ≥0.45** across 987 notes while eleven real duplicates sat in them — notes that restate one idea in different words ("origin owns Cache-Control" / "cache-control at origin not CloudFront" / "cache-control source should follow the content source") share a concept but almost no vocabulary. That is the same keyword-vs-meaning gap that makes `ctx_search` miss paraphrased questions. Keep the Jaccard list as a secondary signal; it still catches literal restatements cheaply.

   **Calibration is per-model — do not carry a threshold across models.** Run it with no `--min` and trust the profile default (`e5-multi` 0.95, `bge-small-en` 0.86). E5 packs all similarities into a high narrow band, so bge-small-en's 0.86 returns **29,560 pairs** under e5-multi — noise that reads like a backlog. On the current profile, ≥0.95 yields ~16 pairs and they are overwhelmingly real. **High similarity is not proof** — under the old model `aws-cra1-login` and `aws-cra2-login` scored 0.890 and must never be merged: same shape, opposite content (two different AWS orgs). The scan proposes; you judge.

   Then, for each candidate, find notes that describe the **same** lesson or that a later note supersedes.
   - **Cluster within each folder FIRST, then look across folders.** Cross-type pairs (a Mistake plus its matching Decision) are complementary by design and get kept — so if a greedy pass assigns a note to a cross-type cluster first and marks it consumed, it never gets compared against its real same-type twin and the duplicate survives the prune. That is precisely how `cloudfront-function-code-budgeting-with-esbuild` and `…-size-budgeting-with-esbuild` (Jaccard 0.67) slipped through on 2026-08-07 and were only caught by the next audit. Same-folder first, always.
   - Propose a concrete merge plan: which note survives, what content folds in, which become redundant.
   - **Do NOT delete anything without explicit confirmation** (vault rule). On confirmation: merge content into the surviving note and delete the redundant ones.
   - **Union the aliases on merge** (mandatory): before deleting a redundant note, fold every distinctive `_Also asked as:` paraphrase from it into the survivor's alias line. Dropping a deleted note's aliases silently shrinks retrieval coverage — a `/memory:eval` miss that looks like a vocabulary gap but is really merge-loss. Dedup near-identical phrasings; keep the union.

2b. ⚠ **`--dupes` and `--clusters` thresholds are UNMEASURED for the current model.** `dupeMin`/
   `clusterMin` are per-model and do not transfer — e5-multi reported 29,560 pairs at bge-small's
   0.86 because its similarity band is compressed. The values carried for bge-m3 (0.95/0.92) were
   never calibrated against it, so treat their output as a starting point and sanity-check the top
   pairs before trusting the count. Recalibrating means sweeping the threshold and eyeballing where
   real duplicates stop and coincidence starts.

3. **Refresh BOTH indexes** so retrieval reflects the pruned state — the FTS5 one below, and the semantic one: `node "$MEM/scripts/memory-semantic.mjs" --index` (incremental: re-embeds only notes whose mtime moved and drops rows for deleted notes, so it is seconds after a prune). **Run it here even though a SessionStart hook also refreshes it** — that hook fires at the *start* of the next session, and until then the vector side would keep answering with notes this prune just deleted. (Routine freshness after *new* notes is automatic — the distiller re-indexes at SessionEnd; this step matters mainly for **deletions**, which must drop stale chunks.)
   - **Source label MUST be lowercase** `<repo>` — the SessionEnd distiller indexes as `vault-insights-frontend` / `vault-memory-frontend` (lowercase). If you index with a different case (e.g. `vault-insights-Frontend`), FTS5 stores a *second* copy under the case-variant label and every note returns twice, halving the effective result window and pushing real matches below the top-5. Lowercase the repo segment before substituting.
   - Because deletes happened, don't just re-index (append-only FTS5 keeps stale chunks): **`ctx purge` (scope: project) THEN re-index** both dirs:
     - `ctx_index(path: "<vault>/Insights/<slug>", source: "vault-insights-<repo-lowercase>")`
     - `ctx_index(path: "<vault>/Memory/<slug>", source: "vault-memory-<repo-lowercase>")`
   - Verify: search a deleted note's title — it should no longer surface, and no note should appear twice under two case-variant sources.

3b. **Check for consolidation gaps** (occasionally — not every prune):

   ```
   node "$MEM/scripts/memory-semantic.mjs" --clusters
   ```

   Dedup asks "are these two notes the same?"; this asks the opposite question — **"are these twenty notes one topic that nothing summarises?"** It clusters across folders (a topic is normally a Pattern + a Mistake + a Decision) and reports clusters with no `permanent/` note as central to them as their own typical member. That is the `staging → promotion` step of the knowledge lifecycle, which has otherwise never happened: **965 Insights against 5 `permanent/` notes.** Two clusters found this way — 9 notes on cache-policy quota, 6 on Cache-Control ownership — had each sat unnoticed for weeks.

   **It finds where a note is missing; it does not write one.** Writing a synthesis note asserts a claim no single note makes, which is exactly where the distiller has confabulated before. Judge the cluster, then write it yourself.

4. Report: N logs archived, M duplicates merged, index refreshed (K notes across Insights+Memory), and anything left for manual review.

Occasionally (every few prunes) run `/memory:eval` afterwards to catch retrieval regressions — if recall@5 drops, add paraphrase aliases to the notes that missed.
