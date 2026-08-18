# Optional integrations

Two separate tools, each with its own index. **Neither is installed by this plugin, neither is
required, and neither is on the plugin's retrieval path.**

| | What it adds | Without it |
| --- | --- | --- |
| [`context-mode`](#context-mode-ctx_search) CLI | `ctx_search` — a second BM25/FTS5 index over the vault | `ctx_search` goes stale; `memory-semantic.mjs` unaffected |
| [`codebase-memory-mcp`](#codebase-memory-mcp-the-graph-layer) server | the L4 `Graph/` layer and `/memory:graph-report` | no L4 digest; L1–L3 unaffected |

`/memory:doctor` reports both under **optional integrations**, with the precise cost of each being
absent.

## context-mode (`ctx_search`)

The SessionEnd distiller refreshes context-mode's index so notes written this session are
searchable next session, and three commands (`/memory:health`, `/memory:challenge`,
`/memory:eval`) use `ctx_search` as their keyword arm.

**It is not what powers recall.** `scripts/memory-semantic.mjs` carries its own vector arm *and*
its own BM25 arm in its own SQLite file, and that is the primary retrieval path. When
`context-mode` is not on PATH the distiller falls back to refreshing that index instead, so the
notes you just wrote stay retrievable — only `ctx_search` drifts.

```bash
npm i -g context-mode     # reinstall for the Node version you are now on
/memory:prune             # rebuild the index to catch up what was missed
```

The CLI installs into the *current Node version's* bin dir, so an `fnm`/`nvm` version switch drops
it from PATH. That used to fail silently; both `/memory:doctor` and the SessionStart hook now say
so, and say precisely what is degraded.

**On wording:** the warning used to claim the vault "stops being searchable". That was never true,
and overstating a degradation is how a warning gets ignored.

### The CLI is not the whole tool — the plugin also ships an MCP server

Everything above is about the **CLI**, because the CLI is all this repo touches: `distill-session`
and `doctor.sh` probe `command -v context-mode` and shell out to it to refresh the `ctx_search`
index, and nothing else.

Installed separately as a Claude Code plugin, `context-mode` also exposes an MCP server whose
tools run commands and code in a sandbox — `ctx_execute`, `ctx_execute_file` and
`ctx_batch_execute` — returning only what the code prints. **No plugin code path calls them and
none is on the retrieval path**; they matter to whoever is *working on* this repo, and `CLAUDE.md`
says when to reach for them. They are deferred MCP tools, so they need a `ToolSearch` before the
first call. Verified live on 2026-08-18; if a future session finds the names changed, this section
and the `CLAUDE.md` paragraph move together.

## codebase-memory-mcp (the `Graph/` layer)

L4 is the only layer this plugin does not write. `/memory:graph-report` asks the
`codebase-memory-mcp` MCP server for a structural digest of the *code* — architecture, call graphs,
entry points, via `search_graph` / `trace_path` / `get_architecture` — and writes it to
`<vault>/Graph/<project>/GRAPH_REPORT.md`. `hooks/graph-staleness-check.mjs` regenerates it in the
background once the repo has commits newer than the report.

Configure the server in your Claude Code MCP settings first; it is not a CLI, so nothing on PATH
can detect it — which is why `/memory:doctor` infers it from the presence of an L4 digest instead.

If you never configure it, **skip L4 entirely.** No hook fails, `graph-staleness-check` stays
silent because it never auto-generates a first report, and L1–L3 work exactly as documented.

Generated bodies sit between `<!-- @generated -->` sentinels, so hand-written notes under the
trailing `## Notes` heading survive a regeneration.
