---
description: Audit memory — surface contradictions, stale claims, and orphans across Memory/ and Insights/ (asks before deleting)
---

> **Paths.** Every shell snippet below assumes these two, set first:
> ```bash
> STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
> MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
> ```
> `$MEM` is the plugin root, `$STATE` is machine-local state (indexes, models, logs, eval cases).

Find rot in the vault before it misleads a future session. `<slug>` = the project key: normalised git remote of `pwd` (e.g. `gitlab.example.com-teamname-frontend`), NOT the checkout path — run `. "$MEM/hooks/lib/vault-env.sh"; project_key "$PWD"`. Vault root: `<vault>` = `. "$MEM/hooks/lib/vault-env.sh"; resolve_vault`. Prompt-driven — read, judge, report. **Never delete or rewrite a note without explicit confirmation** (vault rule).

0. **Run the mechanical checks first — do not re-derive them by hand:**

   ```
   node "$MEM/scripts/memory-audit-checks.mjs"
   node "$MEM/scripts/memory-semantic.mjs" --coverage
   ```

   The second one answers a question no audit had ever asked: **is every note actually in the
   index?** A note missing from the index is indistinguishable from a note that ranks badly — both
   simply fail to appear — so the whole class hid behind "retrieval is imperfect". It also catches
   two files sharing a filename, which the index silently MERGES into one entry (2026-08-15:
   `structural-code-tools` existed in `Memory/` and `permanent/tools/`).

   It prints the snapshot size and every candidate for: notes missing from the MOC, dangling wikilinks (resolved against `permanent/` too), MOC-only notes, missing/mismatched frontmatter, repo paths that are absent **or abbreviated to a suffix**, standing-negative claims a later event may have reversed, and same-folder near-duplicates ≥0.45. Everything it prints is a candidate, not a verdict — steps 2-6 are where you judge.

   Three audits hand-wrote these checks and two got the same two wrong: `confidence:` is nested under `metadata:` (a `^confidence:` grep reports every note as missing it), and a path regex swallows the `…/` in abbreviated prose paths (15 of 24 "missing" paths in the 2026-08-14 audit). Both are encoded in `scripts/lib/memory-audit-checks.mjs` and covered by
   `scripts/lib/memory-audit-checks.test.mjs`. If you extend the checks, add an assertion.

1. **Gather.** First read `Insights/<slug>/REFLECTIONS.md` if it exists — the log of every prior audit. It tells you what was already found, what was fixed, and what was deliberately declined, so you don't re-report a closed item as new. Then read `Memory/<slug>/MEMORY.md` (the MOC) and every note under `Memory/<slug>/*.md` and `Insights/<slug>/{Patterns,Mistakes,Decisions}/*.md`. For large sets use `ctx_execute_file` / `ctx_search` so raw bytes stay out of context.

   **Note the snapshot size** (note count per layer) — the distiller writes notes concurrently, so record what you actually audited and report it. If the count grew mid-audit, say so rather than implying full coverage.

2. **Contradictions.** Find pairs of notes asserting conflicting facts (two decisions that disagree, a fact a later note reverses, a `[[link]]` claim the target contradicts). For each: cite both notes, state the conflict in one line, propose which wins — prefer the more recent, or the higher `confidence:`.

3. **Stale claims.** For any note naming a concrete repo artifact — file path, function, flag, command, config key — verify it still exists (prefer `codebase-memory-mcp` `search_graph`/`search_code`; fall back to the filesystem). Flag claims whose referent is gone or renamed. A claim carrying an `(as of <date>)` recency marker older than ~90 days with no re-verification is suspect even if still present.

4. **Orphans.** Find notes not reachable from `MEMORY.md` and not linked by any `[[wikilink]]` from another note. An orphan is either missing from the MOC (fixable — add the one-line pointer) or genuinely dead (removal candidate).

5. **Duplicates.** Note near-identical notes, but defer the actual merge to `/memory:prune`.

6. **Recurrence.** Compare this audit's findings against `REFLECTIONS.md`. Call out anything that has now appeared in **two or more** audits — recurring rot is a process bug, not a content bug, and the fix belongs upstream (a distiller prompt change, a hook, a convention in CLAUDE.md) rather than in the note. Say so explicitly when you see it.

7. **Report** as a checklist grouped by category — Contradictions / Stale / Orphans / Duplicates / Recurring — each item with the file(s) and a one-line proposed fix. Then ask which to apply. Apply only confirmed fixes: MOC gaps → add the pointer; contradictions → merge/annotate the surviving note; confirmed-dead notes → delete only on explicit "yes".

8. **Append to the reflection log** (always — even when nothing was found, and even when the user applies nothing). Prepend a dated entry to `Insights/<slug>/REFLECTIONS.md`, newest first, so findings compound across audits instead of evaporating with the conversation.

   **The Disposition column is a live ledger, not a record of what you felt at the time.** `memory-audit-checks.mjs --deferred` reads back every row still marked *deferred* and hands it to the next `/memory:prune`. So write `deferred` only for work that is genuinely still open, and when a later session closes an item, **go back and edit that row** — including rows in older entries. Prefer running `/memory:prune` in the same session as the audit and closing the rows immediately; the only reason the ledger exists is that this did not happen on 2026-08-08 and two pairs sat open for six days.

   ```markdown
   ## YYYY-MM-DD — audit

   **Scope:** N Memory + M Insights notes (note if the count moved mid-audit).

   | Finding | Category | Disposition |
   | --- | --- | --- |
   | one-line claim, with file(s) | contradiction/stale/orphan/duplicate | applied / declined / deferred |

   **Verified clean:** the checks that passed, one line — so a later audit knows these were actually tested, not skipped.
   **Recurring:** anything also present in an earlier entry, with the upstream fix it implies.
   ```

   Record **declined** items too, with the reason. A finding the user rejected is a decision; re-litigating it next audit wastes their time. Create the file with an `# Reflections — <slug>` heading and `tags: [reflection]` frontmatter on first run.
