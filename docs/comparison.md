# How this compares to other memory systems

Claims about other systems were checked on **2026-08-21** and, where a system moved since,
re-checked on **2026-10-10**. Each claim links the research note it comes from, and the 2026-10-10
note wins where the two differ. These systems change monthly, so read every row as dated.

Sources: [comparison evidence](research/2026-08-21-comparison-evidence.md) (2026-08-21),
[seven-system survey](research/2026-08-21-agent-memory-systems-survey.md) (2026-08-21),
[obsidian-second-brain](research/2026-08-21-obsidian-second-brain.md) (2026-08-21),
[agent memory, Aug → Oct](research/2026-10-10-agent-memory-landscape.md) (2026-10-10).

## The one-line case

Claude Code's own auto memory already writes a `MEMORY.md` index plus topic files into
`~/.claude/projects/<project>/memory/`, which is this plugin's path and L1 shape, and it is on by
default. **It has no documented retrieval: no embedding, no keyword ranking, no gate.** Its
changelog has mentioned a model-driven "memory recall" since 2.1.286, but the memory docs do not
describe it ([2026-10-10](research/2026-10-10-agent-memory-landscape.md#claude-code-auto-memory-first-party)).
Ranked retrieval over a vault, measured against a named case set, is what this plugin adds.

## The table

"Published numbers" means retrieval figures against a named case set, not a vendor leaderboard.

| System | Store | Write trigger | Retrieval | Local? | Weight |
| --- | --- | --- | --- | --- | --- |
| **this plugin** | Markdown vault | agent, at session end | vector + BM25, rank-fused; **published numbers** ([README](../README.md#retrieval)) | yes | Node ≥ 22.5; ONNX weights ([size](architecture.md)); no DB server |
| Claude Code auto memory | Markdown | agent, during session | none documented (index loaded, topic files read on demand) | yes, machine-local | none (built in) |
| claude-mem | SQLite + FTS5 + Chroma | five lifecycle hooks, continuous | keyword + vector, 3-step MCP drill-down | yes | not determinable |
| Mem0 (OSS) | vector store | each `add` call; ADD-only since 2026-04 | semantic, BM25 and entity scores fused | API key by default | Docker + vector DB for the bundled server |
| Graphiti / Zep | temporal knowledge graph | LLM call per ingest | semantic + BM25 + graph, reranked | API key by default (OpenAI) | graph DB; not determinable |
| memsearch | Markdown + Milvus Lite | LLM summary per turn | dense + BM25 + RRF; reranker is now a network call | yes | 9 Python deps; local embedder is an extra |
| basic-memory | Markdown + SQLite index | assistant via MCP `write_note` | hybrid keyword + semantic | yes (cloud offered) | 50 Python deps; model size not determinable |
| Letta (MemFS) | Markdown + git | agent | file reads; no vector index by default | yes | Node ≥ 22.19; not determinable |
| Hindsight | Postgres + pgvector | `retain` call, LLM extraction | four arms + RRF + cross-encoder | yes | Postgres; not determinable |
| Copilot Memory | GitHub-hosted | agent, automatic | facts re-validated against the branch before use | hosted | subscription |
| Cursor | `.cursor/rules/*.mdc` | you write it | none: rules are prompt context | yes | part of the editor |
| Smart Connections | Obsidian vault | you write it | local embeddings | yes, no API key | Obsidian plugin; model size not determinable |
| Copilot for Obsidian | Obsidian vault | you write it | local or hosted embeddings | hosted embedding sends note text off-machine | Obsidian plugin |

"Not determinable" means no figure exists in the primary sources read; what was tried is in the
[evidence note](research/2026-08-21-comparison-evidence.md#7-gap-fill-licence-and-install-weight-all-thirteen).
It does not mean zero.

Letta is an agent framework, not a memory plugin; its row compares only the memory layer. Mem0's
add path and the memsearch reranker changed after 2026-08-21
([2026-10-10](research/2026-10-10-agent-memory-landscape.md)). The rest of the landscape note's
systems (Cognee, MemOS, Supermemory, A-MEM, LangMem, Memobase) are left out: none targets Claude Code or
adds a mechanism the table does not already show.

**Dropped:** the earlier survey listed "memory-mcp" but recorded no source or claim for it. The
guess that it meant `@modelcontextprotocol/server-memory` is unsourced, so it has no row.

**OpenMemory**, which a search for local mem0 will find, was deleted from the mem0 monorepo on
2026-07-29; `mem0ai/openmemory` is now a session-porting CLI, not a memory store
([evidence](research/2026-08-21-comparison-evidence.md#5-openmemory-mcp--no-longer-exists-as-a-memory-product)).

## Licences

Read from each LICENSE file, 2026-08-21 (newer systems 2026-10-10). Everything not listed is MIT
or Apache-2.0. Three a reader would get wrong:

| System | Licence |
| --- | --- |
| basic-memory | **AGPL-3.0** |
| Copilot for Obsidian | **AGPL-3.0** |
| Smart Connections | **not OSI**: a custom agreement with an anti-competitive-product clause (GitHub: `NOASSERTION`) |

Claude Code, Copilot and Cursor are proprietary.

## Where ours loses

- **Weight.** Hundreds of MB of ONNX weights and a resident model process, where most rows call an
  API or ship a smaller model ([retrieval](retrieval.md)).
- **Install is two steps.** `/memory:install` is required because Claude Code skips lifecycle
  scripts, so the native runtime is missing after a plain plugin install ([usage](usage.md)).
  Auto memory needs zero steps; Smart Connections needs one.
- **The plugin cache multiplies.** Claude Code keeps every installed version; `share-modules.mjs`
  exists because each carried its own runtime (CLAUDE.md).
- **Node only**, because the engine uses `node:sqlite`
  ([decision](decisions/2026-08-17-bun.md)).
- **No Windows.** Bash hooks, POSIX paths and a unix-socket server. Two macOS-only spots remain:
  `/memory:doctor`'s `~/Library/CloudStorage` vault guess matches nothing on Linux, and
  `findClaude()`'s Homebrew path was a Linux bug, fixed in #76.
- **One machine.** The `--serve` process and the indexes are machine-local; only the Markdown
  syncs, at the speed of whatever syncs the vault. Auto memory says the same of itself.
- **Sync conflicts.** A cloud-sync client can replace a directory symlink inside the vault with an
  empty directory ([architecture](architecture.md)).
- **No expiry.** Copilot Memory deletes facts unused for 28 days; our notes never age unless a
  claim carries an `as of` stamp ([README, Known gaps](../README.md#known-gaps)).
- **Our eval sets are small and self-authored.** The published numbers measure one vault, not
  memory systems in general; nobody has measured another row against ours.

## Not in the table

`codebase-memory-mcp` is an optional integration, not a competitor. It is not on the retrieval
path: without it, recall still works and L1–L3 are unaffected
([optional integrations](optional-integrations.md)).
