---
description: Before you commit to a decision, make the vault argue against it — past failures, reversed calls, and refuted diagnoses on the same topic
---

> **Paths.** Every shell snippet below assumes these two, set first:
> ```bash
> STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
> MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
> ```
> `$MEM` is the plugin root, `$STATE` is machine-local state (indexes, models, logs, eval cases).

Confront a proposed decision with what this vault already learned. `<slug>` = the project key:
`. "$MEM/hooks/lib/vault-env.sh"; project_key "$PWD"`. Vault root: `resolve_vault`. **Read-only —
this command changes nothing.** Its whole job is to make you slower for sixty seconds.

The argument for it: this vault's own `REFLECTIONS.md` records diagnoses that were confidently wrong
and *already contradicted by a note that existed at the time*. Recording lessons after the fact has
not stopped them recurring; being confronted before acting might.

**Input:** the decision, in the user's words. If they invoked this bare, ask for it in one sentence.

1. **Retrieve the opposition — both channels, and widen the net beyond the obvious.**
   - `node "$MEM/scripts/memory-semantic.mjs" --query "<the decision>" -k 8`
   - `ctx_search(queries: [...], source: "vault-insights-<slug>")` — expand the query into the
     vocabulary the *answer* would use, not the user's phrasing (see CLAUDE.md).
   - Read `Insights/<slug>/REFLECTIONS.md` for the same subject, and `Mistakes/` in particular.
   Search for the decision **and for its opposite** — a note arguing the other way will not share
   vocabulary with the plan.

2. **Sort what comes back into four buckets.** Only these count as opposition:
   - **Reversed before** — a decision on this topic that was later undone, and why.
   - **Refuted diagnosis** — a claim of this shape that was measured and found wrong. Quote the
     measurement, not the conclusion.
   - **Superseded fact** — the plan rests on something a later event killed (check inline
     `(superseded … by [[…]])` markers and the standing-negative scan).
   - **Cost already paid** — a Mistake note showing this exact approach cost time before.

3. **Push back in the user's own words.** Quote the note verbatim with its filename. Paraphrase is
   how the force gets lost. If a note contradicts the plan, say so plainly rather than softening it
   into "you may wish to consider".

4. **Say when there is nothing.** If the vault holds no relevant opposition, say exactly that in one
   line and stop. **Do not manufacture concerns** — an invented objection trains the user to ignore
   this command, which costs more than the objection was worth. "Nothing in the vault argues against
   this" is a complete and useful answer.

5. **Distinguish stale from wrong.** A note can oppose the plan and *be out of date*. Check its
   recency markers and whether a later note supersedes it before treating it as authoritative — the
   vault has been wrong in both directions.

**Output:** the objections, strongest first, each as one line of claim + its source note. Then a
one-line verdict: *proceed*, *proceed with a named guard*, or *stop and check X first*. No essay.

Related: `/memory:health` finds rot; this finds relevance. Run it before big or irreversible calls —
a migration, a schema change, a decision that ends a rollback path.
