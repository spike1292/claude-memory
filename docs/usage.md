# Using the memory day to day

For someone who has installed the plugin and wants to use it well. Install, configuration and
what each hook does are in the [README](../README.md); why it is shaped this way is in
[vision.md](vision.md); working **on** the repo is [CLAUDE.md](../CLAUDE.md).

## The layers, from your side

**L1 — `Memory/<project>/`: facts and decisions.** One note per fact, indexed by `MEMORY.md`,
which Claude Code loads at every session start. You write these, or ask Claude to ("remember
that…"). If a fact is wrong, edit or delete the note and its MOC line. If the MOC grows past
Claude Code's load cap, the session-start lint and `/memory:doctor` say so; what leaves the MOC is
your call.

**L2 — `Logs/<project>/`: session summaries.** Written only when you run `/memory:save`, read back
by `/memory:resume`. A missing log means nobody saved that session; nothing writes one for you.

**L3 — `Insights/<project>/`: patterns, mistakes, decisions.** Written by the `distill-session`
hook at session end, from the transcript. Recent `Mistakes/` titles come back at the next session
start. If a lesson is wrong or a duplicate, run `/memory:health` or `/memory:prune`; both ask before
they delete.

**L4 — `Graph/<project>/`: codebase graph digest.** Written by the `graph-staleness-check` hook
when commits move past the last digest, or by `/memory:graph-report`. Needs `codebase-memory-mcp`;
without it the layer stays empty and nothing else changes. Hand notes go under `## Notes` and
survive a regeneration.

**`permanent/`: cross-project notes.** Written only by `/memory:adopt`, from a
`/memory:synthesize` draft you reviewed.

## Which command, when

| Command | Run it when… |
| --- | --- |
| `/memory:save` | you stop mid-task and want the next session to pick up where you are |
| `/memory:resume` | you start a session on work a saved log describes |
| `/memory:challenge` | you are about to commit to a decision and want the vault's past failures on the same topic |
| `/memory:health` | notes look contradictory, stale or orphaned |
| `/memory:prune` | logs pile up, insights repeat, or notes you deleted still turn up in search |
| `/memory:synthesize` | several notes say parts of one thing and should become one `permanent/` note |
| `/memory:adopt` | you reviewed a `/memory:synthesize` draft and want it in `permanent/` |
| `/memory:eval` | you changed something that could move retrieval, and want a number before and after |
| `/memory:graph-report` | the graph digest is missing or out of date and you want it now |
| `/memory:install` | first install, or the runtime reports itself missing; safe to re-run |
| `/memory:doctor` | anything above behaves oddly; read-only, so run it first |

For the note conventions when you write a note by hand, load `/memory:protocol`.

## Recall is opt-in

Off by default. Set `"recall": true` in `~/.claude-memory/config.json` (or
`MEMORY_RECALL_ENABLED=1`). From the next prompt on, each prompt you send gets a short brief of the
best-matching notes added to its context — or nothing, when no note scores well enough. Without
recall, notes reach Claude only through `MEMORY.md`, the session-start hooks, and searches Claude
chooses to run. `/memory:doctor --stats` shows how often recall answered and how often it stayed
silent.

## Failure modes you will hit

- **Empty vault after a config change mid-session.** A setting added to `settings.json` does not
  reach a session already running, and the vault falls back to the default path. Put settings in
  `config.json` — see [Configuration](../README.md#configuration). `/memory:doctor` fails loudly when
  this happens.
- **A note written on another device is not found here.** The vault syncs by whatever you use
  (git push/pull, a cloud client); until that has run, the note is not on this disk. Once it is,
  the next session start re-indexes it.
- **Stale graph report.** It regenerates in the background at session start once commits move past
  it, so the first session after a big change may still read the old one. Run
  `/memory:graph-report` to force it.
- **An optional integration is missing.** Without `context-mode`, `ctx_search` is gone; without
  `codebase-memory-mcp`, L4 is empty. Recall and the vault keep working. Details:
  [optional-integrations.md](optional-integrations.md).

More symptoms and fixes: [Troubleshooting](../README.md#troubleshooting).
