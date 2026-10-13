---
description: Draft a consolidated note for a cluster of related notes — every claim cited — into Staging/, for /memory:adopt to promote after the held-out gate
---

> **Paths.** Every shell snippet below assumes these two, set first:
> ```bash
> STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
> MEM="${CLAUDE_PLUGIN_ROOT:-}"; [ -f "$MEM/scripts/memory-semantic.mjs" ] || MEM="$(cat "$STATE/plugin-root")"
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

1. **Let the user pick, before you read any member note.** A named topic or a named staged candidate
   skips the list. Otherwise list both sources:

   ```
   node "$MEM/scripts/memory-semantic.mjs" --clusters --top 8
   ls "$V/Staging/$S/"
   ```

   Show one numbered row per cluster: size, folder mix with its Mistakes count, and the best
   `permanent/` note with its score. `--clusters` already puts clusters with Mistakes first — they
   have *cost something* — then larger ones. Add a row for each file in `Staging/<slug>/`; a
   `candidate-*.md` carries its cluster's evidence in its frontmatter. Ask which to synthesize; the
   user may pick several. **Read no member note until the user answers** — size alone is not value,
   and most uncovered clusters do not need a note. `--propose --top 8` writes the same clusters as
   staged skeletons, if you want the evidence captured first.

   **Steps 2–4 run once per selected target**, each with its own draft and its own coverage report.

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
     this note exists. Replace the `--propose` skeleton's `type: promotion-candidate` and `status:`
     lines with this shape — `/memory:adopt` reads `type: permanent` as its "this is drafted" signal
     and refuses anything still shaped like the skeleton. **Keep the skeleton's `members:` list
     byte-for-byte, alongside the new fields — do not remove it.** It carries no reader-facing
     information; it is how a later `--propose`/`/memory:prune` run still recognises this proposal
     after step 5's rename, by member set rather than by filename. Dropping it reopens the exact bug
     the rename step exists to work around: a routine re-propose would no longer find this file and
     would mint a duplicate skeleton for a topic that is already drafted.

4. **Report coverage before writing.** List which members contributed a claim and which contributed
   nothing. A member that contributed nothing is a signal: either the cluster is too loose, or that
   note says something the synthesis missed. Say which.

5. **Show the drafts and ask once, then write each into Staging/, never into `permanent/`.** When all
   selected drafts are done, show them together and ask: stage all, or which. Each staged draft is
   its own file. If a staged
   skeleton already exists for this cluster, write the draft there — replacing everything from its
   frontmatter through the `<!-- @generated:end -->` marker, and leaving whatever a human already
   wrote below that marker untouched (the same sentinel convention `GRAPH_REPORT.md` uses). **A
   re-run of `--propose`/`/memory:prune` will never touch this file once it does this** — it reads
   `type: permanent` in the frontmatter as "already drafted" and skips it outright, rather than
   regenerating the region the draft now occupies. If none exists yet, create
   `<vault>/Staging/<slug>/<topic-slug>.md` directly. Do not delete or rewrite the member notes —
   they are the evidence the synthesis rests on, and the lifecycle keeps them as staging. At most,
   add a pointer line to the two or three that are most load-bearing.

   **Rename the file to its real topic slug** (`mv candidate-*.md <topic-slug>.md`, same directory)
   — the auto-generated `candidate-<first-member>` name is a placeholder for an unread cluster, not
   the name a promoted note should carry forever. `/memory:adopt` takes the name to adopt as its
   argument, so this is what the next step actually names. **This command's job ends here.**
   Promoting the draft into `permanent/` is `/memory:adopt`'s job, and it runs a held-out eval gate
   that this command does not — a synthesis that reads well is not evidence it helps retrieval.

6. **Offer to adopt each staged draft.** First get the floor from the current held-out score:

   ```
   node "$MEM/scripts/memory-eval.mjs" --run --kind held-out
   ```

   Round its `recall@1` down to a whole percent and state it with its source ("floor 62: held-out
   recall@1 62.5%, rounded down"). If that prints `no case set at …`, say there is no held-out set
   and do not offer adopt — never invent a floor. Otherwise ask whether to run, per draft:

   ```
   node "$MEM/scripts/memory-adopt.mjs" <topic-slug> --min-rank1 <floor>
   ```

   Run each adopt on its own, one after the other. A failed gate rolls back only that draft; the
   other drafts and adoptions stay as they are. Report each result by name.

   `--clusters` will keep reporting this topic as a gap until that command runs and the gate passes
   — that is correct, since nothing has been promoted yet. Do not claim the topic is consolidated
   because a Staging file exists.

7. **Link it in, both ways** (the standing rule, once adopted): add the pointer to `MEMORY.md` if it
   is project-scoped, and `[[wikilink]]` it from at least one sibling — a `permanent/` note reachable
   only by search is invisible to the note graph.

**Output:** per selected target, the coverage report, the draft and the Staging path it was written
to; then the floor with its source, and each adopt result — or why adopt was not offered.
