---
description: (Re)generate the codebase graph digest from codebase-memory-mcp into the vault
---

> **Paths.** Every shell snippet below assumes these two, set first:
> ```bash
> STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
> MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
> ```
> `$MEM` is the plugin root, `$STATE` is machine-local state (indexes, models, logs, eval cases).

Generate a "God Nodes"-style codebase digest so future sessions read one summary instead of many files. Use the `codebase-memory-mcp` tools — do NOT read source files for this.

1. Slug: `<slug>` = the project key: normalised git remote of `pwd` (e.g. `gitlab.example.com-teamname-frontend`), **NOT the checkout path** — run `. "$MEM/hooks/lib/vault-env.sh"; project_key "$PWD"`. Vault root: `<vault>` = `. "$MEM/hooks/lib/vault-env.sh"; resolve_vault`. `graph-staleness-check.sh` calls `resolve_vault` too; using anything else makes the background regen and a manual run write to two different files.
   Note the **MCP project name is not the slug** — `codebase-memory-mcp` keys on the cwd path *without* a leading dash (e.g. `Users-you-Development-Frontend`). Get it from `list_projects` rather than constructing it.
2. Ensure the graph is fresh:
   - `index_status` — is this repo indexed? If not, `index_repository` first.
   - `detect_changes` — if it reports drift, re-index before continuing.
3. Gather (via MCP, not file reads):
   - `get_architecture` — project structure / key aspects.
   - `query_graph` — top nodes by fan-in/fan-out (the "God Nodes": most-connected functions/classes/modules), plus likely refactor candidates.
   - Optionally `search_graph` to name the central entry points.
4. Write `<vault>/Graph/<slug>/GRAPH_REPORT.md` using **sentinel blocks** so hand-written notes survive regeneration:
   - **Before writing, if the file exists, read it** and capture everything AFTER the `<!-- @generated:end -->` marker verbatim — that is the user's hand-maintained area. Never modify it.
   - Regenerate ONLY the frontmatter + the block between the markers. Preserve the trailing `## Notes` section (and anything past `@generated:end`) exactly as found.

```
---
title: <repo name> — Graph Report
date: <YYYY-MM-DD from `date +%Y-%m-%d`>
commit: <short HEAD sha from `git rev-parse --short HEAD`>
project: <slug>
tags: [graph-report]
type: graph
---

<!-- @generated:start — overwritten on every regen; do NOT hand-edit inside this block -->

## Overview
<!-- node/edge counts, main languages/layers -->

## God Nodes
<!-- most-connected symbols sorted by degree, each with its top connections — dense and scannable -->

## Key modules
<!-- the architectural clusters and what each owns -->

## Entry points
<!-- where execution / requests start -->

## Refactor candidates
<!-- high fan-out or tightly-coupled nodes worth watching -->

<!-- @generated:end -->

## Notes (hand-maintained — survives regeneration)

<!-- Add your own observations below. Regen never touches anything past @generated:end. -->
```

Keep the generated block a digest, not a dump. On first creation, include the empty `## Notes` section so the user has a place to write. End by printing the report path.
