---
description: Draft a consolidated note for a cluster of related notes — every claim cited — into Staging/, for /memory:adopt to promote after the held-out gate
---

> **Paths.** Every shell snippet below assumes these two, set first:
> ```bash
> STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
> MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
> ```
> `$MEM` is the plugin root, `$STATE` is machine-local state (indexes, models, logs, eval cases).

Turn a topic that many notes circle into one note that states it. `<slug>` = the project key:
`. "$MEM/hooks/lib/vault-env.sh"; project_key "$PWD"`. Vault root: `resolve_vault`.

This is the **promotion** step of the knowledge lifecycle (staging → promotion → skill/pointer). It
has essentially never run by hand — count the two layers before you start, because the ratio is the
argument for running it at all:

```bash
. "$MEM/hooks/lib/vault-env.sh"; V="$(resolve_vault)"; S="$(project_key "$PWD")"
find "$V/Insights/$S" -name '*.md' | wc -l   # staged
find "$V/permanent"   -name '*.md' | wc -l   # promoted
```

Whatever the two numbers are, the gap between them is the argument for running this at all.
`--clusters` finds where a consolidated note is missing; this drafts one. **This command never
writes to `permanent/`.** It writes into `<vault>/Staging/<slug>/`, sibling to `permanent/`, and
`/memory:adopt` is the only thing that promotes a staged draft — gated on a held-out case set so a
promotion cannot ship a number fitted to the cluster it came from (#87/#96).

**The risk this command is shaped around.** A synthesis note asserts a claim that *no single note
makes* — strictly more room to invent than distillation, and the distiller has already confabulated
twice (an invented CLAUDE.md rule; an unrelated `httpOnly` lesson welded onto a Dockerfile decision).
So the rule below is not advice, it is the format: **a claim without a source is deleted, not
softened.**

1. **Pick the target.** Either the user names a topic, an existing staged candidate is named
   (`<vault>/Staging/<slug>/candidate-*.md` — check for one first, it already carries the cluster's
   evidence in its frontmatter), or find one fresh:

   ```
   node "$MEM/scripts/memory-semantic.mjs" --clusters --top 8
   ```

   Prefer a cluster that has *cost something* — one whose members include Mistakes, or that a prune
   or audit has already tripped over. Size alone is not value; most uncovered clusters do not need a
   note. `--propose --top 8` writes the same clusters as staged skeletons instead of only printing
   them, if you want the evidence captured before you start reading.

2. **Read every member note in full.** Not the card, not the search snippet — the note. A synthesis
   built from snippets is how contradictions get smoothed into a false consensus. If the cluster is
   large, this is the expensive step and it is the one that must not be skipped.

3. **Draft, under the citation rule.**
   - **Every claim ends with the note it came from**: `… — [[2026-08-06-note-name]]`. Multiple
     sources, multiple links.
   - **A claim you cannot attribute does not go in.** If synthesis genuinely produces a new insight
     that no member states, mark it explicitly as `**Synthesis (unsourced):**` so a future reader —
     and the next audit — can see which parts are derived rather than recorded.
   - **Contradictions are the payload, not noise.** Where members disagree, say so and name both
     sides. Do not resolve it silently; if the repo can settle it, check and cite the check.
   - Note which members are *superseded* rather than merged in (`(superseded YYYY-MM-DD by [[…]])`).
   - Frontmatter: `type: permanent`, `confidence:`, `created`/`updated`, and a trailing
     `_Also asked as: …_` line in **outsider vocabulary** — the words someone uses before they know
     this note exists. Replace the `--propose` skeleton's `type: promotion-candidate` frontmatter
     with this shape entirely — `/memory:adopt` reads `type: permanent` as its "this is drafted"
     signal and refuses anything still shaped like the skeleton.

4. **Report coverage before writing.** List which members contributed a claim and which contributed
   nothing. A member that contributed nothing is a signal: either the cluster is too loose, or that
   note says something the synthesis missed. Say which.

5. **Show the draft and ask, then write it into Staging/, never into `permanent/`.** If a staged
   skeleton already exists for this cluster, write the draft there — replacing everything from its
   frontmatter through the `<!-- @generated:end -->` marker, and leaving whatever a human already
   wrote below that marker untouched (the same sentinel convention `GRAPH_REPORT.md` uses). If none
   exists yet, create `<vault>/Staging/<slug>/<topic-slug>.md`. Do not delete or rewrite the member
   notes — they are the evidence the synthesis rests on, and the lifecycle keeps them as staging. At
   most, add a pointer line to the two or three that are most load-bearing. **This command's job
   ends here.** Promoting the draft into `permanent/` is `/memory:adopt`'s job, and it runs a
   held-out eval gate that this command does not — a synthesis that reads well is not evidence it
   helps retrieval.

6. **Tell the user to adopt it:**

   ```
   node "$MEM/scripts/memory-adopt.mjs" <topic-slug> --min-rank1 <percent>
   ```

   `--clusters` will keep reporting this topic as a gap until that command runs and the gate passes
   — that is correct, since nothing has been promoted yet. Do not claim the topic is consolidated
   because a Staging file exists.

7. **Link it in, both ways** (the standing rule, once adopted): add the pointer to `MEMORY.md` if it
   is project-scoped, and `[[wikilink]]` it from at least one sibling — a `permanent/` note reachable
   only by search is invisible to the note graph.

**Output:** the coverage report, the draft, the Staging path it was written to, and the
`/memory:adopt` command to run next.
