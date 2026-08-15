---
description: Consolidate a cluster of related notes into one permanent/ note — every claim cited, and the result graded against the cluster it came from
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
has essentially never run by hand: 965 Insights against 5 `permanent/` notes. `--clusters` finds
where a consolidated note is missing; this writes one.

**The risk this command is shaped around.** A synthesis note asserts a claim that *no single note
makes* — strictly more room to invent than distillation, and the distiller has already confabulated
twice (an invented CLAUDE.md rule; an unrelated `httpOnly` lesson welded onto a Dockerfile decision).
So the rule below is not advice, it is the format: **a claim without a source is deleted, not
softened.**

1. **Pick the target.** Either the user names a topic, or:

   ```
   node "$MEM/scripts/memory-semantic.mjs" --clusters --top 8
   ```

   Prefer a cluster that has *cost something* — one whose members include Mistakes, or that a prune
   or audit has already tripped over. Size alone is not value; 32 uncovered clusters exist and most
   do not need a note.

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
     this note exists.

4. **Report coverage before writing.** List which members contributed a claim and which contributed
   nothing. A member that contributed nothing is a signal: either the cluster is too loose, or that
   note says something the synthesis missed. Say which.

5. **Show the draft and ask.** Never write into `permanent/` without confirmation. Do not delete or
   rewrite the member notes — they are the evidence the synthesis rests on, and the lifecycle keeps
   them as staging. At most, add a pointer line to the two or three that are most load-bearing.

6. **Grade the result — the tool checks its own output.** After writing, re-run:

   ```
   node "$MEM/scripts/memory-semantic.mjs" --index && node "$MEM/scripts/memory-semantic.mjs" --clusters
   ```

   The cluster should **stop being reported**: coverage is judged by whether a `permanent/` note sits
   as close to the cluster centroid as a typical member does. If the gap is still reported, the note
   did not actually capture the topic — it is too abstract, too narrow, or about something else. Fix
   it or say so; do not claim the topic is consolidated because a file exists.

7. **Link it in, both ways** (the standing rule): add the pointer to `MEMORY.md` if it is
   project-scoped, and `[[wikilink]]` it from at least one sibling — a `permanent/` note reachable
   only by search is invisible to the note graph.

**Output:** the coverage report, the draft, and after writing, the re-run result — gap closed or not.
