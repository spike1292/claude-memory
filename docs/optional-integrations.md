# Optional integrations

One separate tool. **It is not installed by this plugin, not required, and not on the plugin's
retrieval path.** `context-mode` used to be the second: it was dropped on 2026-11-01, because no
person had committed to it since 2026-06-29 and the plugin's own index already covered its
`ctx_search` arm.

| | What it adds | Without it |
| --- | --- | --- |
| [`codebase-memory-mcp`](#codebase-memory-mcp-the-graph-layer) server | the L4 `Graph/` layer and `/memory:graph-report` | no L4 digest; L1–L3 unaffected |

`/memory:doctor` reports it under **optional integrations**, with the precise cost of its being
absent.

## codebase-memory-mcp (the `Graph/` layer)

L4 is the only layer this plugin does not write. `/memory:graph-report` asks the
`codebase-memory-mcp` MCP server for a structural digest of the *code* — architecture, call graphs,
entry points, via `search_graph` / `trace_path` / `get_architecture` — and writes it to
`<vault>/Graph/<project>/GRAPH_REPORT.md`. `hooks/graph-staleness-check.mjs` regenerates it in the
background once the repo has commits newer than the report.

Configure the server in your Claude Code MCP settings first; it is not a CLI, so nothing on PATH
can detect it — which is why `/memory:doctor` infers it from the presence of an L4 digest instead.

The background refresh needs it at **user** scope (`claude mcp add -s user codebase-memory-mcp …`).
The regen runs `--restricted`, which loads no MCP servers, so the hook passes back only the
user-scope entry from `.claude.json` (under `CLAUDE_CONFIG_DIR` if set). A local-scope entry (the
`claude mcp add` default) or a project `.mcp.json` gets the "run `/memory:graph-report`" nudge
instead: the latter is repo text, which this unattended session must not trust.

If you never configure it, **skip L4 entirely.** No hook fails, `graph-staleness-check` stays
silent because it never auto-generates a first report, and L1–L3 work exactly as documented.

Generated bodies sit between `<!-- @generated -->` sentinels, so hand-written notes under the
trailing `## Notes` heading survive a regeneration.
