---
description: Apply a reviewed /memory:synthesize draft from Staging/ into permanent/ — the only path that writes there, gated on a held-out case set
---

> **Paths.** Every shell snippet below assumes these two, set first:
> ```bash
> STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
> MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
> ```
> `$MEM` is the plugin root, `$STATE` is machine-local state (indexes, models, logs, eval cases).

This is the **second half** of promotion (#96). `--propose` (`memory-semantic.mjs`) and
`/memory:synthesize` produce a drafted note under `<vault>/Staging/<slug>/`; nothing before this
command ever touches `permanent/`. `/memory:adopt` is the only thing that does.

1. **The note must already be drafted.** A staging file whose frontmatter still reads
   `type: promotion-candidate` is the `--propose` skeleton, not a synthesis — run
   `/memory:synthesize` on it first. `/memory:adopt` refuses anything not shaped
   `type: permanent`; it does not draft.

2. **Adopt with a floor:**

   ```bash
   node "$MEM/scripts/memory-adopt.mjs" <staged-note-name> --min-rank1 <percent>
   ```

   This copies the staged note into `permanent/`, reindexes, and runs the eval harness against the
   project's **held-out** set (`--kind held-out`, #87/#126) — never the tuning set, which the
   drafting step could have (even accidentally) fitted. Below the floor, the copy is rolled back:
   `permanent/` is reindexed back to what it was before this command ran, and the staged file is
   left in place so the draft can be fixed and retried. The failing reasons are printed by name.

   **There is no way to run this without a floor.** Skipping the gate is exactly the failure this
   command exists to close — the "no drop" tripwire this issue considered and rejected reads as "it
   worked" when it has proven nothing. If you genuinely want to preview without scoring, use
   `--dry-run` instead of inventing a number to pass.

3. **Preview first, if unsure:**

   ```bash
   node "$MEM/scripts/memory-adopt.mjs" <staged-note-name> --dry-run
   ```

   Prints the source and target paths. Writes nothing, runs no gate.

4. **`--force` overwrites an existing `permanent/` note of the same name.** It does not skip the
   gate — a forced overwrite is still scored and still rolls back on failure. Use it when
   re-drafting a topic that was adopted before.

5. **On success**, the staged proposal is deleted (it is now `permanent/`) and the command prints
   the adopted path. Re-run `--clusters` to confirm the topic is now covered — the report goes from
   "no permanent/ note covers this" to nothing, since the new note now sits inside the cluster's own
   spread. Quote the before/after with the held-out set named, the same way any retrieval number
   here must name its source.

**Out of scope.** This command never drafts, never merges member notes, and never runs the gate
against the tuning set — a number from the tuning set is not evidence for a promotion decision, it
is the failure #87 exists to prevent.
