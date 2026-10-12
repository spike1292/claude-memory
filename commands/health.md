---
description: Audit memory — surface contradictions, stale claims, and orphans across Memory/ and Insights/ (asks before deleting)
---

> **Paths.** Every shell snippet below assumes these two, set first:
> ```bash
> STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
> MEM="${CLAUDE_PLUGIN_ROOT:-}"; [ -f "$MEM/scripts/memory-semantic.mjs" ] || MEM="$(cat "$STATE/plugin-root")"
> ```
> `$MEM` is the plugin root, `$STATE` is machine-local state (indexes, models, logs, eval cases).

Find rot in the vault before it misleads a future session. `<slug>` = the project key: normalised git remote of `pwd` (e.g. `gitlab.example.com-teamname-frontend`), NOT the checkout path — run `. "$MEM/hooks/lib/vault-env.sh"; project_key "$PWD"`. Vault root: `<vault>` = `. "$MEM/hooks/lib/vault-env.sh"; resolve_vault`. Prompt-driven — read, judge, report. **Never delete or rewrite a note without explicit confirmation** (vault rule).

0. **Run the mechanical checks first — do not re-derive them by hand:**

   ```
   node "$MEM/scripts/memory-audit-checks.mjs"
   node "$MEM/scripts/memory-semantic.mjs" --coverage
   node "$MEM/scripts/memory-semantic.mjs" --dupes
   node "$MEM/scripts/memory-semantic.mjs" --clusters
   ```

   `--dupes` and `--clusters` are the same scans `/memory:prune` steps 2 and 3b run, at the
   profile's own thresholds. Here they only name notes for step 1 to read.

   The second one answers a question no audit had ever asked: **is every note actually in the
   index?** A note missing from the index is indistinguishable from a note that ranks badly — both
   simply fail to appear — so the whole class hid behind "retrieval is imperfect". It also catches
   two files sharing a filename, which the index silently MERGES into one entry (2026-08-15:
   `structural-code-tools` existed in `Memory/` and `permanent/tools/`).

   It prints the snapshot size and every candidate for: notes missing from the MOC, dangling wikilinks (resolved against the whole vault), links into another project's notes (listed apart, by link name only — not defects), MOC-only notes, missing/mismatched frontmatter, repo paths that are absent **or abbreviated to a suffix**, standing-negative claims a later event may have reversed, and same-folder near-duplicates ≥0.45. Everything it prints is a candidate, not a verdict — steps 2-6 are where you judge.

   Three audits hand-wrote these checks and two got the same two wrong: `confidence:` is nested under `metadata:` (a `^confidence:` grep reports every note as missing it), and a path regex swallows the `…/` in abbreviated prose paths (15 of 24 "missing" paths in the 2026-08-14 audit). Both are encoded in `scripts/lib/memory-audit-checks.mjs` and covered by
   `scripts/lib/memory-audit-checks.test.mjs`. If you extend the checks, add an assertion.

1. **Gather.** First read `Insights/<slug>/REFLECTIONS.md` if it exists — the log of every prior audit. It tells you what was already found, what was fixed, and what was deliberately declined, so you don't re-report a closed item as new. Then read `Memory/<slug>/MEMORY.md` (the MOC) in full. Then read only:

   - **every note a step-0 scan names**, in claim-line form — from the first `## ` heading on
     (`sed -n '/^## /,$p' <note>`), not the whole file;
   - **a bounded sample below the dupe threshold.** `--dupes` sorts pairs highest first, so take
     `N` from step 0's header (`same-folder pairs ≥ <dupeMin>: N`), run
     `--dupes --min <lower> --top <N + 15>`, and read only the pairs after the first `N` — at most
     **15 pairs**. None printed after them means the band is empty; write that in the **Scope**
     line rather than reading it as clean. `<lower>` is **0.70** for `bge-m3`, set from the
     `/memory:prune` step 2b sweep. The band is per-model: on any other profile none is measured,
     so skip the sample and say so in the **Scope** line.

   **A full-corpus read is not the intended path.** The scans already name every candidate the
   audit acts on, and reading every note re-derives them at a cost that grows with the vault. The
   measurements behind this, the band and the cap:
   `docs/decisions/2026-10-12-health-read-scope.md`. Steps 2–6 work from the notes gathered here; a finding may still pull in a
   note that a gathered note links to — a targeted read, not a sweep. `ctx_execute_file` /
   `ctx_search` keep raw bytes out of context if you have them.

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
