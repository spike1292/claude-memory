# claude-mem and MemOS, read properly

**Read 2026-08-25.** The two systems that place highest on the boards in
[the leaderboard note](2026-08-25-agent-memory-leaderboards.md) — claude-mem 2nd on industry coding,
MemOS 2nd on industry textual and the best *organiser-evaluated* score on either board.

One of them is this project's near-twin and has moved since we last looked. The other supports none
of the agents on this machine.

This updates two findings in
[Seven agent-memory systems](2026-08-21-agent-memory-systems-survey.md) rather than editing them.

## claude-mem — our architecture with a database instead of a vault

Apache-2.0 · 91,747 ★ · 8,047 forks · JavaScript/TypeScript · pushed 2026-08-23 (GitHub API,
2026-08-25) · <https://github.com/thedotmack/claude-mem>

The convergence with this plugin is near-total, down to the same private-content convention:

| | `memory@claude-memory` | claude-mem |
| --- | --- | --- |
| Capture cadence | SessionEnd distiller, once | PostToolUse continuous, 5 lifecycle hooks / 6 scripts |
| Storage | Markdown vault | **SQLite** (sessions, observations, summaries) + **Chroma** |
| Retrieval | bge-m3 + BM25, RRF-fused | hybrid semantic + keyword over Chroma |
| Private content | `<private>…</private>`, redacted before extraction | `<private>` tags, excluded from storage |
| Runtime | Node ≥ 22.5 | **Bun** + **uv** (Python, for vector search), SQLite bundled |
| Distillation LLM | headless `claude` | Claude Code auth, Gemini API key, or OpenRouter |
| Config | `$CLAUDE_MEMORY_HOME/config.json` | `~/.claude-mem/settings.json` |
| Agents | Claude Code | seven, below |

### Two findings from 2026-08-21 no longer hold

**The runaway-capture objection is retired.** Finding 11 of the survey argued against continuous
PostToolUse capture, and its evidence was issue #2201 — "runaway observer sessions caused 345M token
flow in one day via full PostToolUse I/O capture and stuck pending queue". **That issue was closed on
2026-04-30.** The cadence argument (bounded once-per-session vs unbounded per-tool-call) still stands
on its own; the failure that made it concrete does not.

**It is no longer Claude Code-only.** The installer detects and wires, per
<https://docs.claude-mem.ai/installation>:

> Claude Code, Cursor, Windsurf, OpenCode, Codex CLI, Antigravity CLI

plus an OpenClaw gateway installer. That is a different system from the one the survey compared:
seven agents against our one.

**The GitHub repository description overstates this** — it claims Codex, Gemini, Hermes and Copilot.
Codex is real; **Copilot and omp appear nowhere in the installation docs.** Same
README-versus-artifact trap as Paseo's unmentioned scheduler and `brew info copilot`, in the opposite
direction. Take the docs list, not the description.

### Why it is not a replacement

- **SQLite + Chroma is a database, not files.** This is the objection that rejected Trilium, SiYuan,
  Joplin and AnyType in
  [the second-brain decision](../decisions/2026-08-24-second-brain-surfaces.md): the primary reader of
  this vault is four agents, and a store only one application can open is the wrong storage.
- **It installs Bun and uv (Python).** Both are auto-installed if missing. This repo is Node-only and
  bans `.py` in CI; that rule governs our source rather than a neighbouring tool, but the install
  weight is real on a 16 GB box already holding 722 MB of ONNX weights.
- **A crypto token, `CMEM`, is associated with the project** — third-party issued, "officially
  embraced by the creator" per the README. Recorded as a governance fact about a candidate
  dependency, with no claim attached.

### What it is genuinely good for

**Co-installation, not replacement.** Its per-agent installer means it can be wired to **Codex,
Antigravity and OpenCode only**, leaving its Claude Code integration uninstalled. The vault, the
hooks and `$CLAUDE_MEMORY_HOME` are untouched, and two of the three agents that have no memory layer
at all get one.

That is the cheapest known answer to the actual gap — which is not retrieval quality, it is that
memory exists for Claude Code and nothing else.

Progressive-disclosure retrieval (survey finding 3 — `search` → `timeline` → `get_observations`)
remains the mechanism worth stealing, and remains unbuilt here.

## MemOS — the best independent score, and irrelevant to this machine

Apache-2.0 · 10,957 ★ · MemTensor · pushed 2026-08-25 · <https://github.com/MemTensor/MemOS>

Graph-structured memory with tiers that rhyme with ours — L1 traces, L2 policies, L3 world models,
plus crystallized Skills — and a stated design goal of being "inspectable and editable by design, not
a black-box embedding store".

**Its local plugin targets OpenClaw, Hermes and DeepSeek Harness.** Not Claude Code, not Codex, not
Copilot, not omp, not Antigravity. Nothing on this machine can use it.

Deployment, for the record:

| Shape | Infrastructure |
| --- | --- |
| Cloud API | hosted, `mpg-` key |
| Self-host | docker compose: MemOS API + **Neo4j + Qdrant** |
| Local plugin | SQLite, FTS5 + vector, npm — the three agents above only |

Two databases for the self-hosted path, against Hindsight's one and claude-mem's embedded pair.

**Revisit only if OpenClaw or Hermes is ever adopted.** MemTensor is also a listed partner of the
leaderboard it places 2nd on, per the caveat in the leaderboard note.

## The observation that outlives both

MemOS's README claims **LongMemEval 89.20**, measured with **OmniMemEval — MemTensor's own harness**
(`MemTensor/OmniMemEval`). Hindsight claims **state-of-the-art on LongMemEval**, measured with its
own. Two vendors, one benchmark, both winning it.

Neither is dishonest and neither is comparable. It is the same conclusion the 2026-08-21 survey
reached about Mem0 and Graphiti, arrived at from a different direction, and it is why the standing
rule — no retrieval number without a named case-set run behind it — is the only thing here that has
not needed revising.

## Sources

- <https://github.com/thedotmack/claude-mem> · <https://docs.claude-mem.ai/installation> ·
  <https://github.com/thedotmack/claude-mem/issues/2201> (closed 2026-04-30)
- <https://github.com/MemTensor/MemOS> · <https://github.com/MemTensor/OmniMemEval> ·
  <https://memos.openmem.net>
- Repository metadata from the GitHub API, 2026-08-25
