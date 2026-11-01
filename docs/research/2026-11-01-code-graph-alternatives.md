# Code graph alternatives to codebase-memory-mcp

Research note, 2026-11-01. Sources are comparison blogs, review sites and one GitHub discussion,
read on that day. No tool was installed or measured here. Anything not read at the primary source
is **unverified**.

**Verdict: keep `codebase-memory-mcp` (cbm).** It is the only candidate that feeds the L4 `Graph/`
layer as built, it is MIT with no paid tier, and in the one accuracy test found it is top on gitleaks
and mid-pack elsewhere — and that test is a competitor's own. For exact single-symbol answers,
Claude Code's built-in `LSP` tool covers what Serena would add.

## Caveats on the evidence

- **No community threads.** Searches of Hacker News and Reddit found nothing on cbm. Serena is the
  only tool with a large r/ClaudeAI thread (500+ upvotes, per mcp.directory — unverified).
- **The only accuracy numbers are a vendor's.** [repowise](https://repowise.dev/blog/comparisons/best-code-graph-mcp-servers)
  graded five servers against compiler-generated call graphs (Go and TypeScript, five repos,
  37,853 oracle edges) and leads its own table. Read it as a vendor claim.
- Sources disagree on cbm's tool count (11, 14, 17) and language count (158–162); likely versions.

## What cbm is

[DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) — MIT, a single
native C binary with 162 tree-sitter grammars plus language-server type resolution where
supported. Indexes Docker, Kubernetes, Helm, Terraform and CI files beside code. SQLite under
`~/.cache/codebase-memory-mcp/`, background re-index, 17 tools including `trace_path` and a
Cypher-like `query_graph`.

## The alternatives

| Tool | Graph built by | License | For | Against |
| --- | --- | --- | --- | --- |
| cbm | tree-sitter + LSP types | MIT | One dependency-free install; infra files; highest recall on gitleaks | Weak recall on syft; 17 tool schemas per turn |
| Serena | live language servers, no stored graph | GPL-3.0 (MIT core) | Exact and current; edits by symbol | 53 tools; per-symbol only; built-in `LSP` (Claude Code 2.0.74+) covers most of it |
| CodeGraph | tree-sitter, Rust kernel | MIT | 1 tool by default; file watcher | 20+ languages; 0.37 recall on zod |
| repowise | tree-sitter + typed resolution + git mining | AGPL-3.0 | Best precision/recall in its own test; history and docs | AGPL; self-graded |
| Graphify | tree-sitter + a model pass for docs/PDFs | Apache-2.0 | Maps docs and media; browser view | 0.25–0.43 recall in several cells; paid cloud |
| code-review-graph | tree-sitter | MIT | Built for PR review in CI | Recall as low as 0.026 |
| GitNexus | tree-sitter + type resolution | PolyForm Noncommercial | Impact, tracing, Cypher | Not usable at work; reviews disagree on its architecture |
| CodeGraphContext | tree-sitter, optional SCIP | MIT | Real graph database (Kuzu, Neo4j, FalkorDB) | Needs a DB; 23 languages |
| jCodeMunch | tree-sitter, optional SCIP | custom | Byte-offset symbol retrieval | $79–$1,999; custom license |
| trace-mcp | — | — | Refactoring and security scanning | 81 languages (its own count) |

Precision / recall from the repowise test, cbm column: cobra 0.912 / 0.743, gitleaks 0.934 / 0.967,
zod 0.987 / 0.694, hono 0.949 / 0.686; recall on syft 0.542 and 0.361.

## Graph vs language server

The answer in [serena#1885](https://github.com/oraios/serena/discussions/1885): they complement.
A language server answers "where is this one symbol, exactly, now". A precomputed graph answers
"what is connected to what across the repo" — transitive dependents, blast radius — which a chain
of per-symbol queries does not give cheaply. The cost is staleness until the next index.

repowise's advice matches: one graph server for exploration, a language-server tool for edits, and
one line in `CLAUDE.md` saying which answers which, since overlapping tools cost a choice per turn.

## Sources

- [repowise — Best Code Graph MCP Servers (2026)](https://repowise.dev/blog/comparisons/best-code-graph-mcp-servers)
- [DEV — code-review-graph vs Graphify vs codebase-memory-mcp](https://dev.to/coder11/code-review-graph-vs-graphify-vs-codebase-memory-mcp-the-best-code-intelligence-mcp-tools-for-ai-3ea)
- [Serena discussion #1885](https://github.com/oraios/serena/discussions/1885)
- [trace-mcp vs codebase-memory-mcp](https://trace-mcp.com/vs/codebase-memory-mcp.html)
- [ai-trove — cbm vs codegraph, Serena, grep](https://ai-trove.com/en/codebase-memory-mcp/codebase-memory-mcp-vs-alternatives)
- [Tokenade — Serena alternatives](https://tokenade.net/en/comparisons/alternatives/serena-alternatives.md)
- [wikidocs — Claude Code built-in LSP vs Serena](https://wikidocs.net/338563)
- [aicoolies — GitNexus review](https://aicoolies.com/reviews/gitnexus-review)
- [mcp.directory — Serena guide](https://mcp.directory/blog/serena-mcp-complete-guide-2026)
