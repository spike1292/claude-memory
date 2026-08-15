---
description: Restore context from the latest vault session log for this project
---

> **Paths.** Every shell snippet below assumes these two, set first:
> ```bash
> STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
> MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
> ```
> `$MEM` is the plugin root, `$STATE` is machine-local state (indexes, models, logs, eval cases).

Restore context — do NOT start work, just load state and confirm where we left off.

1. Slug: `<slug>` = the project key: normalised git remote of `pwd` (e.g. `gitlab.example.com-teamname-frontend`), **NOT the checkout path** — run `. "$MEM/hooks/lib/vault-env.sh"; project_key "$PWD"`. Vault root: `<vault>` = `. "$MEM/hooks/lib/vault-env.sh"; resolve_vault`. Must match `/memory:save` exactly, or resume reads a different folder than save wrote.
2. List `<vault>/Logs/<slug>/` and pick the most recent file (names are `YYYY-MM-DD-HHMMSS-<focus>.md` since 2026-08-10, `YYYY-MM-DD-HHMM.md` before that; both lead with a sortable timestamp, so lexical sort = chronological). **Sessions run concurrently**, so the newest log may describe a different strand of work — if it does not match the repo's current branch or open MRs, read the next one back as well before summarising.
   If that folder is missing or empty, check for a legacy cwd-slug folder (`printf '%s' "$PWD" | sed 's#/#-#g'`) before concluding there is no history — logs written before 2026-08-08 may still be there.
3. Read that log AND `Memory/<slug>/MEMORY.md` (the MOC).
4. Summarize in a few lines: what was done last, open decisions, and the next concrete step from `## Open / next`.

If no log exists, say so and fall back to just the MOC.
