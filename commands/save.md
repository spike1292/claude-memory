---
description: Save a concise session summary to the Obsidian vault Logs/<slug>/
---

> **Paths.** Every shell snippet below assumes these two, set first:
> ```bash
> STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
> MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
> ```
> `$MEM` is the plugin root, `$STATE` is machine-local state (indexes, models, logs, eval cases).

Write a session summary to the vault so a future session can resume.

1. Slug: `<slug>` = the project key: normalised git remote of `pwd` (e.g. `gitlab.example.com-teamname-frontend`), **NOT the checkout path** — run `. "$MEM/hooks/lib/vault-env.sh"; project_key "$PWD"`. Vault root: `<vault>` = `. "$MEM/hooks/lib/vault-env.sh"; resolve_vault`.
   **Call `resolve_vault`, never `$CLAUDE_VAULT` directly.** The env var is optional — when it is unset, `$CLAUDE_VAULT/Logs/…` expands to `/Logs/…` and writes outside the vault or fails at `/`. Every hook calls `resolve_vault`; commands must too.
   **Never derive the slug from `pwd` directly.** A cwd-slug forks a second memory for the same repo: another machine, a worktree, or `cd`-ing into a subdirectory each get their own orphaned folder, and `/memory:resume` then reads a different one than this wrote. If `Logs/` already holds a cwd-slug folder for this repo it is a stray from before this rule — write to the project key and leave the stray for `/memory:health`.
2. Timestamp: run `date +%Y-%m-%d-%H%M%S`. **Seconds are not optional** — minute precision let two concurrent sessions compute the same filename and silently overwrite one another (cost a full session log on 2026-08-10).
3. Filename: `<vault>/Logs/<slug>/<timestamp>-<short-kebab-focus>.md`, e.g. `2026-08-10-121612-sentry-error-baseline.md`. The focus slug makes concurrent saves distinguishable at a glance; the leading timestamp keeps lexical sort chronological for `/memory:resume`.

   **Never overwrite an existing log.** Run `test -e "<path>" && echo EXISTS` first; if it exists, another session won the race — append `-2` and write that instead. A clobbered log is another session's memory and is **unrecoverable**: the vault is not version-controlled, and Synology writes `_Conflict` copies only for sync races, not for a local overwrite.

   Write it with this frontmatter, then the sections below:

```
---
title: <short title of what this session did>
date: <YYYY-MM-DD>
project: <slug>
tags: [session-log]
type: log
---
```

- `## Done` — what changed, with `file:line` refs.
- `## Decisions` — choices made and why (link `[[notes]]` where they exist).
- `## Open / next` — what's unfinished, the next concrete step.
- `## Files touched` — paths.

Keep it tight: what future-me needs to resume, not a transcript. If `$ARGUMENTS` is given, use it as the title/focus.
