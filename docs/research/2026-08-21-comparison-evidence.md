# Evidence for `docs/comparison.md`: six more systems, plus licence and install weight for all thirteen

Research note for [#42](https://github.com/spike1292/claude-memory/issues/42). Read 2026-08-21.
This is the **evidence**, not the comparison page — #42's deliverable is written from this, not
instead of it.

Scope was set to avoid redoing work. The seven systems in
[the earlier survey](2026-08-21-agent-memory-systems-survey.md) and
[the obsidian-second-brain note](2026-08-21-obsidian-second-brain.md) are re-examined here on
**one axis only** — licence and install weight, which those notes were thin on (four licence
mentions across seven systems, no install figures). Everything else about them stands as written.

Every claim below cites a URL. Every vendor claim carries the date it was read, because #42
requires it and because three of the six new systems had moved since their last public description.

**Four things moved under the previous survey's feet, and all four change what the comparison page
can say.** They are stated up front because a comparison written from stale knowledge of these
would be wrong rather than merely incomplete:

1. **Claude Code's own auto memory now writes `MEMORY.md` plus topic files into
   `~/.claude/projects/<project>/memory/`, keyed on the git repository, on by default.** That is
   this plugin's L1 shape and this plugin's exact path. The baseline moved onto our ground.
2. **Letta is no longer MemGPT-shaped.** Its memory is MemFS — a git-backed Markdown filesystem
   with **no vector index by default**. The 2023 paper describes a design its own vendor has left.
3. **OpenMemory is gone as a memory product.** It was deleted from the mem0 monorepo on
   2026-07-29; `mem0ai/openmemory` today is a session-porting CLI for moving conversations between
   coding harnesses. There is nothing there to compare against.
4. **Cursor has no Memories feature to compare.** `/docs/context/memories` 301-redirects to
   `/docs/rules`, and no page in Cursor's sitemap contains the string "memor" (checked 2026-08-21).

---

## 1. Claude Code's own memory — the baseline

Read 2026-08-21 from <https://docs.claude.com/en/docs/claude-code/memory> (fetched as
`.../memory.md`). All facts in this section are from that page unless noted.

**What it is.** Two mechanisms, both loaded at the start of every conversation, both plain
Markdown, both explicitly "context, not enforced configuration":

| | CLAUDE.md files | Auto memory |
| --- | --- | --- |
| Who writes it | You | Claude |
| Scope | Project, user, or org | Per repository, shared across worktrees |
| Loaded into | Every session | Every session (first 200 lines or 25 KB) |

**CLAUDE.md scopes**, in load order (broadest first): managed policy
(`/Library/Application Support/ClaudeCode/CLAUDE.md` on macOS, `/etc/claude-code/CLAUDE.md` on
Linux/WSL, `C:\Program Files\ClaudeCode\CLAUDE.md` on Windows) → user (`~/.claude/CLAUDE.md`) →
project (`./CLAUDE.md` or `./.claude/CLAUDE.md`) → local (`./CLAUDE.local.md`, gitignored). Files
above the working directory load in full at launch; files in subdirectories load on demand.

**Imports** use `@path/to/import`, relative to the importing file, recursive to a **maximum depth
of four hops**. Import parsing skips code spans and fenced blocks, so `` `@README` `` stays
literal. An import in a *project* file that resolves outside the working directory triggers a
one-time approval dialog; user-scope files are trusted without it (except in Cowork sessions).
Claude Code reads `CLAUDE.md`, **not** `AGENTS.md` — the documented bridge is `@AGENTS.md` at the
top of a CLAUDE.md, or a symlink.

**`.claude/rules/`** holds topic files discovered recursively. A rule with no `paths` frontmatter
loads at launch at the same priority as `.claude/CLAUDE.md`; a rule with `paths` globs loads only
when Claude reads a matching file. Since v2.1.198 matching also works through a symlinked path.

**Auto memory** — the part that matters most to this comparison:

- **On by default.** Toggle via `/memory`, `autoMemoryEnabled` in settings, or
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- Storage is `~/.claude/projects/<project>/memory/`, where `<project>` is **derived from the git
  repository**, so all worktrees and subdirectories of one repo share one directory. Relocatable
  via `autoMemoryDirectory` (absolute or `~/`-prefixed) from any settings scope.
- The directory holds a `MEMORY.md` index plus optional topic files (`debugging.md`,
  `api-conventions.md`, …). Topic files are **not** loaded at startup; Claude reads them on demand.
- **The first 200 lines or 25 KB of `MEMORY.md`, whichever comes first, load every session.**
  Content past that is dropped. Claude Code measures the file after each write and nags, then
  errors, when it is over — measuring only what loads (frontmatter and block HTML comments are
  stripped before the check, since v2.1.211).
- Files with YAML frontmatter get a `modified` ISO-8601 timestamp written on each save
  (v2.1.214+). Claude Code never adds frontmatter to a file that has none.
- **Machine-local. "Files are not shared across machines or cloud environments."**
- Excluded from the `cleanupPeriodDays` transcript retention sweep.
- Subagents do not inherit the main conversation's auto memory; a subagent can have its own.

**Retrieval: there is none.** `MEMORY.md` is injected wholesale up to the cap; topic files are
found by Claude reading the index and deciding to open one. No embedding, no ranking, no gate.

**The `#` shortcut is not in the current documentation.** Neither `memory.md` nor
`interactive-mode.md` mentions it (searched 2026-08-21). The documented way to add a memory is to
say so in natural language ("remember that the API tests require a local Redis instance"), which
routes to auto memory; adding to CLAUDE.md is "ask Claude directly" or edit via `/memory`. **Do
not claim `#` was removed** — absence from docs is not removal. Claim only that it is undocumented
as of this date.

**Licence / install weight.** Part of Claude Code. Zero additional install, zero dependencies,
zero bytes of model weights. This is the number every other row on the page is measured against.

**Where this leaves us.** The baseline now has: plain Markdown, a per-repo directory, an index
file with a hard byte budget, on-demand topic files, automatic write, and per-file recency
stamps. What it does *not* have is retrieval — no semantic arm, no lexical arm, no ranking, and
nothing above 25 KB is reachable except by Claude guessing a filename from the index. **That gap
is the entire remaining case for this plugin, and the comparison page should say so in one line
rather than listing eight differences.** Two secondary gaps: auto memory is explicitly not shared
across machines (our vault is, via the user's own sync), and it has no session-end distillation
step (it writes during the session, when Claude notices).

Worth flagging as a *risk*, not a loss: `autoMemoryDirectory` is a first-class setting that points
auto memory anywhere. It makes this plugin's `~/.claude/projects/<cwd-slug>/memory` symlink a
workaround for a problem Claude Code now solves natively, and the two mechanisms currently write
to overlapping paths under different project-key rules (ours: normalised git remote; theirs: also
git-derived, but Claude Code owns the naming). Not researched further here; it deserves its own
issue.

---

## 2. basic-memory (basicmachines-co) — closest competitor in shape

Sources: <https://github.com/basicmachines-co/basic-memory>,
<https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/pyproject.toml>,
<https://docs.basicmemory.com/raw/start-here/what-is-basic-memory.md>,
<https://docs.basicmemory.com/raw/start-here/quickstart-local.md>. All read 2026-08-21.

**What it is.** An MCP server over plain Markdown. Notes are files you can edit in any editor;
the assistant calls `search_notes`, `read_note`, `write_note`. Its own framing: "Local-first
knowledge management combining Zettelkasten with knowledge graphs" (pyproject `description`).

**Memory model.** Markdown files plus extracted "observations and relations" forming a semantic
graph, plus a search index synced from the files. Files are the source of truth and the index is
derived — the same authority model as ours and memsearch's.

**Retrieval.** Hybrid keyword + semantic. The install docs state "All installs include semantic
search for hybrid (keyword + meaning-based) search". The dependency list names the mechanism:
`sqlite-vec>=0.1.6` and `fastembed>=0.7.4` (local ONNX embeddings) as **required** dependencies,
with `pymilvus` behind an optional `milvus` extra. **No retrieval numbers are published** in the
repo or the docs read here.

**Licence: AGPL-3.0.** `LICENSE` is the GNU Affero GPL v3 text; `pyproject.toml` declares
`license = { text = "AGPL-3.0-or-later" }`; GitHub's licence API resolves `AGPL-3.0`. This is the
single most consequential licence finding in this note — AGPL is a materially different
proposition from the MIT/Apache-2.0 that everything else in this space ships under, and it belongs
in the comparison table as a fact, not as a judgement.

**Install weight.** Python ≥ 3.12. `brew install basic-memory` (own tap) or
`uv tool install basic-memory`. **50 declared runtime dependencies** in `pyproject.toml`,
including FastAPI, SQLAlchemy + Alembic, `psycopg`/`asyncpg`, `litellm`, `openai`, `logfire`,
`pillow` and `pyright`. No Docker required for local mode; Postgres is supported but SQLite is the
local default. Model weights: `fastembed` downloads its embedding model on first use — **size not
determinable from primary sources**; no figure is published in the repo or docs, and it depends on
which fastembed model is selected. Notes default to `~/basic-memory/`.

**Where data lives.** Local Markdown by default. A hosted Cloud product (sync, web editor, teams,
snapshots, per-note file history, WorkOS SSO for partners) is the commercially pushed path — the
local quickstart itself opens with "Prefer not to install anything? Basic Memory Cloud connects
your AI in about 2 minutes".

**Maturity.** Created 2024-12-02, 3.7k stars, pushed 2026-08-21.

**Honest read for the comparison.** This is the nearest neighbour and it wins on reach: any
MCP-capable assistant, a team product, a cloud sync story, an editor. It loses on weight (50
Python deps and a second runtime, against our zero-dependency-beyond-Node engine), on licence
compatibility for anyone embedding it, and on published retrieval evidence — like almost everyone
here, it publishes none. We should not claim it loses on retrieval *quality*; nobody has measured
either of us against the other.

---

## 3. Editor memory: Cursor and GitHub Copilot

### Cursor — rules only; no Memories feature to compare

Read 2026-08-21 from <https://cursor.com/docs/rules> (the page `/docs/context/rules` and
`/docs/context/memories` both resolve to).

- **`/docs/context/memories` 301-redirects to `/docs/rules`.** The rules page contains zero
  occurrences of "Memories". **No URL in `https://cursor.com/sitemap.xml` (1,137 lines, 468 `<loc>`
  entries) contains the substring "memor".** `https://cursor.com/docs/llms.txt` is 404.
- Conclusion, dated: **as of 2026-08-21 Cursor's documentation describes no persistent memories
  feature.** It may have existed before and it may return; primary sources today document rules
  only. Do not describe a Cursor Memories feature on the comparison page without re-checking.
- **What it does have.** Project rules are `.mdc` files in `.cursor/rules/` with `description`,
  `globs` and `alwaysApply` frontmatter; a plain `.md` there is ignored. Precedence is Team Rules →
  Project Rules → User Rules, all merged, earlier sources winning conflicts. Rules can `@filename`
  other files. Rules can be imported from a GitHub repo into `.cursor/rules/imported/<repoName>`.
  Nested `AGENTS.md` files in subdirectories are supported and combine with parents.
- The docs are explicit that this is prompt-level, not memory: "Large language models don't retain
  memory between completions. Rules provide persistent, reusable context at the prompt level."

**Licence / install weight:** proprietary, part of the editor. Not applicable as a separate row.

### GitHub Copilot — two systems, one local and one hosted

Sources: <https://code.visualstudio.com/docs/agents/run/memory>,
<https://docs.github.com/en/copilot/concepts/agents/copilot-memory>,
<https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide>.
All read 2026-08-21. Both features are labelled **preview / public preview**.

**Instructions files** (the CLAUDE.md analogue): `.github/copilot-instructions.md` repository-wide,
plus path-specific `NAME.instructions.md` files in `.github/instructions/`, plus `.github/prompts/`.

**The memory tool** (VS Code, local, preview, `chat.tools.memory.enabled`):

| Scope | Path | Across sessions | Across workspaces |
| --- | --- | --- | --- |
| User | `/memories/` | Yes | Yes |
| Repository | `/memories/repo/` | Yes | No |
| Session | `/memories/session/` | No | No |

User memory's **first 200 lines are loaded into context at the start of every session** — the same
constant Claude Code uses. Storage is local files. Commands: `Chat: Show Memory Files`,
`Chat: Clear All Memory Files`; **deleting an individual memory file is not supported yet**. The
Plan agent uses session memory to hold `plan.md`.

**Copilot Memory** (GitHub-hosted, preview, separate system):

- Repository-scoped facts and user-level preferences, captured **automatically** by Copilot agents
  rather than written by the user.
- Shared across surfaces: Copilot cloud agent, Copilot code review, Copilot CLI. Code review uses
  repository facts only, never user preferences.
- **Facts are stored with citations into the code and re-validated against the current branch
  before use**; only validated facts are applied. User preferences store citations that may include
  direct user quotes, validated by "best judgement".
- **Anything unused is deleted after 28 days**; the timer resets on successful validated use.
- Repository facts can only be *created* by users with write access; they are readable by anyone
  with Copilot Memory access to that repo. On Business/Enterprise, user preferences are owned by the
  billing entity and are exportable/deletable by an administrator.
- **The two official docs contradict each other on the default.** VS Code says "Copilot Memory is
  turned off by default and must be enabled in your GitHub settings"; GitHub Docs says "For
  individual plans, it's on by default" (enterprise/org requires an admin policy first). Both read
  2026-08-21. Quote the discrepancy, not one side of it.

**Licence / install weight:** proprietary, subscription (all paid Copilot plans). Not applicable
as a separate row.

**Honest read.** Copilot Memory has two mechanisms this plugin does not: **citation-backed
validation before use** and **automatic expiry of unused facts**. Our notes have per-claim recency
in the protocol and an explicit "no expiry" entry in README's Known gaps. That is a genuine idea to
steal, and the comparison page should not pretend otherwise. The cost is that repository memories
leave the machine and land in GitHub's store.

---

## 4. Letta (formerly MemGPT) — a different category, and no longer the paper's design

Sources: <https://arxiv.org/abs/2310.08560>, <https://docs.letta.com/llms.txt>,
<https://docs.letta.com/concepts/memfs/index.md>, <https://github.com/letta-ai/letta>. Read
2026-08-21.

**The paper.** *MemGPT: Towards LLMs as Operating Systems*, **arXiv:2310.08560**, submitted
2023-10-12, last revised 2024-02-12 (v2). It proposes "virtual context management" — an OS-style
hierarchy that pages data between an in-context tier and external storage, with interrupts for
control flow — evaluated on document analysis and multi-session chat.

**What Letta is today.** An agent framework and harness, not a notes tool: CLI
(`npm install -g @letta-ai/letta-code`, Node ≥ 22.19), desktop app, web app, an App Server, an
Agent SDK, messaging-channel integrations, scheduled tasks, subagents. **This is a different
category from a memory plugin and the comparison page should say so in one line rather than
scoring it on our axes.**

**But its memory model is now directly relevant, because it converged on ours.** MemFS:

- Memory is a **git repository owned by the agent**, projected onto whatever machine the agent runs
  on as a real checkout the agent edits with ordinary file tools.
- Memories are **Markdown with YAML frontmatter**, addressed by path. Files under `system/` load
  into the system prompt every turn; everything else stays out of context, **but the file tree
  itself is always in the system prompt so directory and file names act as signposts.**
- **"MemFS does not include a semantic or vector index by default."** Agents find memory with
  normal file-search and read tools. Keyword search needs the `@letta-ai/memfs-search` mod;
  semantic/hybrid additionally requires QMD installed and indexed.
- Every edit is a git commit — version history, conflict resolution, and a clear boundary between
  saved memory and uncommitted work. Memory subagents ("dreaming", "memory doctor") use **git
  worktrees** to update memory concurrently.

**Licence: Apache-2.0** (`letta-ai/letta` LICENSE file; GitHub resolves `Apache-2.0`). 24.3k stars,
created 2023-10-11, pushed 2026-08-16.

**Install weight.** CLI is `npm install -g @letta-ai/letta-code`, Node 22.19+. Self-hosting is
documented as fully local — "All agent state (messages, memory, provider connections) stays
on-device, and no Letta account is required" — with an optional always-on App Server. No model
weights of its own (it calls a model provider). Package byte size **not determinable from primary
sources**: no published tarball size was found, and `npm view` was not run for this note.

**Two things to take, honestly stated.** Git-as-memory-store gives version history and conflict
resolution for free — our vault sits on a consumer sync client instead, and cloud-sync conflicts are
already a named loss below. And "the file tree is always in the system prompt" is a cheap
progressive-disclosure mechanism close to what the previous survey rated WORTH STEALING #3, without
the round-trip cost.

---

## 5. OpenMemory MCP — no longer exists as a memory product

Sources: <https://api.github.com/repos/mem0ai/mem0/commits?path=openmemory>,
<https://github.com/mem0ai/openmemory>, <https://docs.mem0.ai/llms.txt>. Read 2026-08-21.

- The `openmemory/` directory was removed from the mem0 monorepo by commit **"chore: remove
  OpenMemory from the monorepo (#6530)", dated 2026-07-29**.
  `https://raw.githubusercontent.com/mem0ai/mem0/main/openmemory/README.md` is 404.
- The string "openmemory" does not appear anywhere in `https://docs.mem0.ai/llms.txt` (39.8 KB,
  the full docs index).
- **`mem0ai/openmemory` today is a different product**: "Open-source CLI & TUI to port AI coding
  sessions across Claude Code, Codex, and OpenCode" — MIT, pushed 2026-07-29. It moves conversation
  sessions between harnesses (`openmemory port --from <src> --to <dest>`). It is not a memory store
  and not a competitor. Installed by piping a shell script from raw.githubusercontent.
- Third-party repos named "OpenMemory" exist (e.g. `CaviraOSS/OpenMemory`, Apache-2.0, active). They
  are unrelated to mem0 and were **not** researched; do not conflate them.

**What replaces it as mem0's self-hosted path.** Mem0 OSS (`pip install mem0ai` /
`npm install mem0ai`), plus a bundled REST server + dashboard via Docker Compose. From
`server/docker-compose.yaml` (read 2026-08-21) the compose stack is three services: the mem0
FastAPI app, **`pgvector/pgvector:pg17` Postgres**, and a Next.js dashboard — so **Docker and a
database are required** for that path. From `docs.mem0.ai/open-source/configuration`: "Mem0 OSS
works out of the box with OpenAI defaults", prerequisites include "API keys for your chosen LLM and
embedder providers", and the recommended self-hosted vector store is Qdrant (`docker run -p 6333:6333
qdrant/qdrant`). Local-only operation is possible via the Ollama LLM/embedder components, but it is
not the default and is not the documented recommendation — the docs say plainly "**Mem0 Platform
(managed) is the recommended path** … Route to OSS only when the user has an explicit self-hosting
requirement."

**For the comparison page:** one row, saying the local/self-hosted mem0 story needs Docker, a
vector database, and — unless deliberately reconfigured — an OpenAI API key, which is a network
call per write and per read. Then a footnote that OpenMemory, the thing people will search for, no
longer exists under that name.

---

## 6. Obsidian RAG / semantic search plugins

### Smart Connections (brianpetro)

Sources: <https://github.com/brianpetro/obsidian-smart-connections> (LICENSE, README,
manifest.json, package.json), read 2026-08-21. Version **4.7.2**, `minAppVersion` 1.8.7,
`isDesktopOnly: false`.

- **Embeddings are local by default and require no API key** — "ships with a local embedding model
  that just works", "Embeddings are created locally by default. Your notes stay on your machine."
  Works on mobile.
- **The specific default model is not determinable from the repo read here.** The README names no
  model; `smart_env.config.js` contains no model key or adapter name; the embedding implementation
  is the `smart-embed-model` package, resolved as `file:../jsbrains/smart-embed-model` — a sibling
  checkout outside this repository. Determining the model means reading the `jsbrains` monorepo,
  which was not done. Do not guess it.
- **No retrieval numbers are published.** The README discusses score display ("Exact numbers depend
  on the embedding model") but names no case set, corpus, or recall figure.
- **Licence: not an OSI licence — a custom "Smart Plugins License Agreement", © 2025 Jobsi, Inc.**
  GitHub resolves it as `NOASSERTION`. It is MIT-shaped in its grant, with an added clause 2
  forbidding use as a substantial component of any product or service that (a) primarily
  interoperates with Obsidian or a similar note-taking app, **and** (b) is offered as a
  general-purpose solution to multiple unrelated customers, **and** (c) competes with a commercial
  offering of the licensor. Private use, internal organisational use, and bespoke client work are
  explicitly exempt. **This is the one licence on the page a reader could get wrong by assuming
  "open source", so state the SPDX as "custom (NOASSERTION)" and link the file.**
- Install weight: an Obsidian community plugin — no runtime, no database, no Docker. Model weights
  downloaded on first index; size not published.

### Copilot for Obsidian (logancyang)

Sources: <https://github.com/logancyang/obsidian-copilot> (LICENSE, README, manifest.json), read
2026-08-21. Version **4.0.2**, `minAppVersion` 1.11.4.

- **It has pivoted away from being a RAG-over-notes plugin.** manifest description as of this date:
  "Run AI agents such as Claude Code, Codex, and OpenCode inside your vault." It connects an
  existing Claude Code or Codex install, or opencode with a hosted/BYOK/local model.
- Retrieval is "local Miyo search" — "your notes remain files in your vault, and local Miyo indexes
  stay on your device". The Miyo index internals were not researched.
- **Embeddings are local *or* hosted, and the hosted path sends note text off the machine**: "A
  Copilot-hosted embedding model receives the note text being indexed", processed by "Brevilabs's
  backend and its vetted enterprise model providers". Free without a licence when using your own
  agent account, provider key, or local model.
- **No retrieval numbers are published.**
- **Licence: AGPL-3.0** (LICENSE is the AGPL v3 text; GitHub resolves `AGPL-3.0`). 7.6k stars,
  pushed 2026-08-21.
- Install weight: Obsidian community plugin; desktop-only for the Agent feature "because its
  backends run local processes".

**Honest read for both.** Neither is a competitor to the *write* side — they index notes you
already wrote and neither has a distiller, a hook, or a per-prompt injection path. Smart
Connections is the closest thing to our retrieval arm alone, running locally, on mobile, with zero
setup, which is a real win over `/memory:install`. Neither publishes a retrieval number, so on our
one measured axis there is nothing to compare against.

---

## 7. Gap-fill: licence and install weight, all thirteen

Licences below are read from the **LICENSE file** via GitHub's licence API (which detects from that
file, not the README) plus the first lines of the file itself, and cross-checked against the package
manifest where one declares a licence. Repo metadata read 2026-08-21.

| System | SPDX (from LICENSE) | Created | Pushed | Install weight |
| --- | --- | --- | --- | --- |
| **this plugin** | `MIT` (LICENSE + `package.json`) | — | — | Node ≥ 22.5, `jq`; 380 MB `node_modules` slimmed to 59 MB, shared across versions; **722 MB ONNX weights**; no DB server, no Docker |
| obsidian-second-brain | `MIT` | 2026-03-24 | 2026-08-21 | Python; not measured here |
| claude-mem | `Apache-2.0` | 2025-08-31 | 2026-08-20 | JavaScript; not measured here |
| Mem0 (OSS) | `Apache-2.0` | 2023-06-20 | 2026-08-21 | `pip install mem0ai`; **defaults to OpenAI API key**; recommended vector store Qdrant (Docker); bundled server = Docker Compose with `pgvector/pgvector:pg17` + Next.js dashboard |
| Graphiti | `Apache-2.0` | 2024-08-08 | 2026-08-21 | not measured here |
| Zep | `Apache-2.0` | 2023-04-29 | 2026-08-19 | not measured here |
| memsearch (`zilliztech/memsearch`) | `MIT` (`pyproject`: `license = "MIT"`) | 2026-02-09 | 2026-08-21 | Python ≥ 3.10, **9 required deps**; Milvus Lite embedded by default; local ONNX embedder is the **`onnx` extra**, not a base dependency; base install pulls `openai` |
| MCP `server-memory` | **`NOASSERTION`** — repo is mid-transition MIT → Apache-2.0; `package.json` says `SEE LICENSE IN LICENSE` | 2024-11-19 | 2026-08-20 | npm, **one runtime dependency** (`@modelcontextprotocol/sdk`); JSON knowledge graph, no DB, no model |
| basic-memory | **`AGPL-3.0`** (`pyproject`: `AGPL-3.0-or-later`) | 2024-12-02 | 2026-08-21 | Python ≥ 3.12, **50 required deps**; `sqlite-vec` + `fastembed` (local weights, size unpublished); SQLite local, Postgres optional; no Docker |
| Letta | `Apache-2.0` | 2023-10-11 | 2026-08-16 | `npm i -g @letta-ai/letta-code`, Node ≥ 22.19; git repo per agent; no bundled model |
| Cursor | proprietary | — | — | part of the editor |
| GitHub Copilot | proprietary | — | — | subscription; Copilot Memory is GitHub-hosted |
| Smart Connections | **custom, `NOASSERTION`** ("Smart Plugins License Agreement", © Jobsi, Inc.) | 2022-12-26 | 2026-08-21 | Obsidian plugin; local model, no API key; weight unpublished |
| Copilot for Obsidian | **`AGPL-3.0`** | 2023-03-31 | 2026-08-21 | Obsidian plugin; local or hosted embeddings |

**Not determinable from primary sources**, with what was tried:

- **The seven earlier systems' install weight**, beyond the manifests quoted above. Reading each
  repo's dependency tree properly is a second pass; the licence axis was the one #42 needs and it is
  complete. `memsearch` and `mem0` are filled in because their manifests were already open.
- **`fastembed`'s downloaded model size for basic-memory.** No figure in the repo or docs; it varies
  by selected model. Not guessed.
- **Smart Connections' default embedding model.** README, `manifest.json`, `package.json` and
  `smart_env.config.js` all read; the model lives in the sibling `jsbrains/smart-embed-model`
  package, outside this repository.
- **Letta CLI package size.** No published figure found; `npm view` not run.
- **What "memory-mcp" meant in the earlier survey.** That note's own Caveats say no claim about it
  survived verification and it was "likely not researched", and no repo URL is recorded. The row
  above is for `@modelcontextprotocol/server-memory` (the official Knowledge Graph Memory Server),
  which is the most likely referent, **but that identification is inferred, not sourced.** Either
  confirm it or drop the row.

---

## Where ours loses — verified against this repo, 2026-08-21

#42 names five. All five hold; the wording needs correcting on two, and there are three more.

**Verified as stated:**

1. **722 MB of model weights.** `CLAUDE.md:156`, `docs/architecture.md:56` ("ONNX weights
   (~722 MB)"). Plus ~1.3 GB resident when the `--serve` model is loaded
   (`scripts/lib/doctor-perf.mjs:329`). Every alternative on this page except memsearch's ONNX
   extra either calls an API or ships a much smaller model.
2. **Node-only.** `package.json` `engines.node: ">=22.5"`, hard because the engine uses
   `node:sqlite`. Bun is excluded for the same reason
   ([decision record](../decisions/2026-08-17-bun.md)).
3. **Single-machine serve process.** One `--serve` per machine keyed by model, over a **unix domain
   socket** under `run/` (`doctor-perf.mjs`). Indexes are machine-local (`db/semantic-<slug>-<model>.db`).
   Nothing is shared across machines except the Markdown itself, and only as fast as the user's sync
   client. Claude Code's auto memory has the same property and says so; we should say it as plainly.
4. **Cloud-sync conflicts.** Documented at `README.md:197` and `docs/architecture.md:79` — a sync
   client replaces a *directory* symlink inside the vault with an empty directory and renames the
   original to `<name>_<DEVICE>_<date>_Conflict`. File symlinks survive. This has cost notes before.

**Needs re-wording, because the repo does not say what #42 says:**

5. **"macOS-shaped assumptions" is not what the code shows; "POSIX-shaped, no Windows" is.**
   Grepping `hooks/` and `scripts/` for `darwin`, `macos`, `sw_vers`, `/Library/`, `osascript`,
   `pbcopy`, `stat -f`, Homebrew: the only hits are `slim-install.mjs`'s platform *table*
   (`darwin`/`linux`/`win32`, correctly parameterised and tested for all three) and one BSD-sed
   comment in `doctor.sh:200`. The real loss is Windows: bash hooks, POSIX paths, and a unix-socket
   serve process. `README.md` already states "macOS / Linux — bash + node; no Windows support".
   **Say "no Windows", and say the sed dialect is the one macOS-specific detail.**
6. **Our own README Known-gaps line is stale and must not be copied onto the comparison page.**
   `README.md:227` reads "**No Windows support.** bash, python3, and POSIX paths throughout" —
   but there is no Python; it was removed on 2026-08-16 and CI fails if a `.py` file reappears
   (`CLAUDE.md:141`). Fix the README line rather than propagating it.

**Three more, found while verifying:**

7. **Install is not one step and cannot be.** `/memory:install` is mandatory because Claude Code
   installs from the lockfile but skips lifecycle scripts, so `onnxruntime-node`'s native binary is
   missing and the package directory exists while the runtime is unusable (`README.md`). Against
   Smart Connections' "install and enable, that is it" and Claude Code auto memory's zero steps,
   this is the sharpest install-weight loss on the page.
8. **The plugin cache multiplies.** Claude Code keeps every installed version; six versions measured
   381 MB each = **2.2 GB** on 2026-08-18 before `scripts/share-modules.mjs` symlinks them at one
   shared runtime (`CLAUDE.md`). Nobody else on this page has this failure mode, because nobody else
   ships a native runtime inside a version-pinned plugin cache.
9. **Notes have no expiry and `MEMORY.md` has no size cap** (`README.md` Known gaps). Both baselines
   now beat us here: Claude Code enforces 200 lines / 25 KB on `MEMORY.md` and errors when it is
   exceeded; Copilot Memory deletes anything unused for 28 days. This is the clearest "where ours
   loses" that is also a concrete to-do.

**Where we win, stated once so the page is not only losses.** We are the only system on this page
that **publishes retrieval numbers with a named case set** (`README.md`: English paraphrases n=28,
recall@5 0.821, MRR 0.546; Dutch n=15, recall@5 0.867; keyword-only on the same English set,
recall@5 0.250) and the only one whose docs state the rule that a figure without its case set is
not a measurement. Every other system read for this note publishes either nothing or vendor-run
benchmarks. That is a defensible claim, and it is the only quality claim we can make without
measuring someone else's system — which we have not done and should not imply.

**Optional integrations, precisely (not competitors).** From `docs/optional-integrations.md`:
without `context-mode` on PATH, `ctx_search`'s separate index goes stale and the distiller falls
back to refreshing `memory-semantic.mjs`'s own index instead — **recall is unaffected, because
`memory-semantic.mjs` carries its own vector arm and its own BM25 arm in its own SQLite file and is
the primary retrieval path.** Without `codebase-memory-mcp`, there is no L4 `Graph/` digest and no
`/memory:graph-report`; **L1–L3 are unaffected.** The comparison page must reproduce this wording
and not the retired claim that the vault "stops being searchable".

---

## A proposed table shape for `docs/comparison.md`

Ponytail applies: this is deliberately short. Eight columns, thirteen rows is unreadable and most
cells would say "same". Proposed: **one table with six columns**, then per-system prose only where a
row cannot carry the point.

| System | Store | Write trigger | Retrieval | Local? | Weight |
| --- | --- | --- | --- | --- | --- |

- **Store** — "Markdown files" / "Markdown + git" / "SQLite + vectors" / "hosted". Carries #42's
  portability axis; a reader infers git-diffable and hand-editable from it.
- **Write trigger** — "you write it" / "agent, during session" / "agent, at session end" /
  "per message pair". This is the axis that actually separates the systems and the earlier survey
  found it (capture cadence).
- **Retrieval** — "none (all in context)" / "file reads" / "keyword" / "vector+BM25 fused", with a
  **bold marker for any system publishing numbers against a named case set**. Today that is one
  system, which is itself the finding.
- **Local?** — "yes" / "yes, API key by default" / "hosted". Not a yes/no: mem0 OSS and Obsidian
  Copilot are the interesting cells.
- **Weight** — one phrase: "none", "one npm dep", "50 Python deps", "Docker + Postgres",
  "722 MB weights".

**Licence gets its own short table, not a column** — SPDX plus a one-line note only where it is not
a plain permissive licence (basic-memory AGPL, Obsidian Copilot AGPL, Smart Connections custom,
MCP server-memory mid-transition). Four rows of note, nine rows of "MIT/Apache-2.0, nothing to say".

**Rows to cut rather than pad:**

- **Zep and Graphiti collapse to one row.** Same vendor, same category, and the earlier survey's own
  Caveats say Graphiti is "effectively un-assessed" — writing two rows would imply a depth of
  examination that does not exist.
- **OpenMemory gets a footnote, not a row.** It no longer exists as a memory product.
- **Cursor gets one row and it is about rules, not memory.** There is nothing else to compare.
- **`codebase-memory-mcp` and `context-mode` are not in the table at all** — a "not a competitor"
  row invites exactly the misreading it is trying to prevent. One paragraph, with the precise
  degradation sentences from `docs/optional-integrations.md`.
- **Letta gets a row with an explicit category caveat**, because a reader comparing an agent
  framework to a notes plugin on "install weight" is being misled by the table's shape.

**Two things the page must carry outside the table:**

1. **A dated line at the top**: "every vendor claim on this page was checked on 2026-08-21; four of
   the thirteen had changed materially in the six weeks before that." That is the honest framing and
   it is also the reason the page needs a date.
2. **The "where ours loses" section, unabridged**, using the nine items above rather than #42's five
   — with the wording corrections. A page that only wins is marketing; a page that lists the wrong
   losses is worse, because a reader who checks one finds the rest untrustworthy.

---

## Sources

Claude Code:

- <https://docs.claude.com/en/docs/claude-code/memory> (read as `.../memory.md`)
- <https://docs.claude.com/en/docs/claude-code/interactive-mode.md> (searched for `#`; no hit)

basic-memory:

- <https://api.github.com/repos/basicmachines-co/basic-memory/license>
- <https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/pyproject.toml>
- <https://docs.basicmemory.com/llms.txt>
- <https://docs.basicmemory.com/raw/start-here/what-is-basic-memory.md>
- <https://docs.basicmemory.com/raw/start-here/quickstart-local.md>

Cursor:

- <https://cursor.com/docs/rules> (and the 301 from `/docs/context/rules`, `/docs/context/memories`)
- <https://cursor.com/sitemap.xml>

GitHub Copilot:

- <https://code.visualstudio.com/docs/agents/run/memory>
- <https://docs.github.com/en/copilot/concepts/agents/copilot-memory>
- <https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide>
- <https://docs.github.com/en/copilot/concepts/prompting/response-customization>

Letta / MemGPT:

- <https://arxiv.org/abs/2310.08560>
- <https://docs.letta.com/llms.txt>
- <https://docs.letta.com/concepts/memfs/index.md>
- <https://api.github.com/repos/letta-ai/letta/license>

mem0 / OpenMemory:

- <https://api.github.com/repos/mem0ai/mem0/commits?path=openmemory>
- <https://raw.githubusercontent.com/mem0ai/mem0/main/server/docker-compose.yaml>
- <https://raw.githubusercontent.com/mem0ai/openmemory/main/README.md>
- <https://docs.mem0.ai/llms.txt>
- <https://docs.mem0.ai/open-source/configuration.md>

Obsidian plugins:

- <https://raw.githubusercontent.com/brianpetro/obsidian-smart-connections/main/LICENSE>
- <https://raw.githubusercontent.com/brianpetro/obsidian-smart-connections/main/manifest.json>
- <https://raw.githubusercontent.com/brianpetro/obsidian-smart-connections/main/package.json>
- <https://raw.githubusercontent.com/brianpetro/obsidian-smart-connections/main/README.md>
- <https://raw.githubusercontent.com/logancyang/obsidian-copilot/master/README.md>
- <https://raw.githubusercontent.com/logancyang/obsidian-copilot/master/manifest.json>
- <https://api.github.com/repos/logancyang/obsidian-copilot/license>

Licence and metadata for the seven already surveyed:

- `https://api.github.com/repos/<owner>/<repo>/license` and `/repos/<owner>/<repo>` for
  `eugeniughelbur/obsidian-second-brain`, `thedotmack/claude-mem`, `mem0ai/mem0`, `getzep/graphiti`,
  `getzep/zep`, `zilliztech/memsearch`, `modelcontextprotocol/servers`
- <https://raw.githubusercontent.com/zilliztech/memsearch/main/pyproject.toml>
- <https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/memory/package.json>

This repo (for "where ours loses"): `README.md`, `CLAUDE.md`, `package.json`,
`docs/architecture.md`, `docs/optional-integrations.md`, `scripts/lib/slim-install.mjs`,
`scripts/lib/doctor-perf.mjs`, `scripts/doctor.sh`.
