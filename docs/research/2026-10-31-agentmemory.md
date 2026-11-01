# agentmemory: what it is, what others say, and whether to switch

Research note, 2026-10-31. Repo facts come from the GitHub API and the raw README on that day.
Outside opinion comes from Hacker News (Algolia API), a GitHub discussion and two review sites.
Anything not read at the primary source is marked **unverified**.

**Verdict: do not switch.** agentmemory solves a different problem (one memory server shared by many
agents) and gives up what this repo is built on: plain Markdown in git, a strong embedding model,
and held-out evals. One idea is worth taking (#223); two add evidence to open issues (#122, #70);
one we already have.

## What it is

[rohitg00/agentmemory](https://github.com/rohitg00/agentmemory) — Apache-2.0, created 2026-02-25,
v0.9.31 on 2026-10-26.

- A local server on the iii-engine runtime: REST on `:3111`, a live viewer on `:3113`, data in
  `state_store.db` under the platform data dir. A random bearer secret is created on first start.
- Captures nearly everything through 12 Claude Code hooks: prompts, every tool call with input and
  output, failures, sub-agents, the final reply of each turn. A privacy filter strips keys first.
- Four tiers: working (raw observations) → episodic (session summaries) → semantic (facts) →
  procedural (workflows). Ebbinghaus decay, reinforcement on access, contradiction detection, a
  version chain where superseded memories drop out of recall.
- Retrieval: BM25 always; vectors and a graph arm only when configured; RRF k=60, max 3 results per
  session.
- **Defaults are keyless.** No LLM compression ("synthetic compression" instead) and no vectors.
  Local embeddings are opt-in and use `all-MiniLM-L6-v2` (384-dim).
- About 15 agents through native plugins, MCP or REST. 54 MCP tools by default, 8 with
  `AGENTMEMORY_TOOLS=core`.

## Health on 2026-10-31

| | |
|---|---|
| Stars / forks | 30,048 / 2,652 |
| Open issues + PRs | 529 |
| Commits | 592 by 71 people; rohitg00 wrote 443 (75%) |
| Releases | ~15 in May 2026, then about one a month (v0.9.28 07-19, v0.9.29 08-16, v0.9.30 10-06, v0.9.31 10-26) |

Open bugs filed in the last week: Windows worker start fails (#1618) or boot hangs (#1643); a
worker-boot race makes the first state reads fail and stalls vector recovery (#1623); a stale pid
after reboot loops the start forever (#1615); graph migration stops at ~20k nodes (#1617); facet
tags outlive deleted memories (#1624, #1614); the MCP catalog lists disabled tools that then return
500 (#1613); `targetLayer` is accepted and ignored (#1608). Earlier fixes include cross-project
memory leakage (#662) and agent-scope isolation on recall (v0.9.27).

## Benchmarks

**Theirs.** [2026-10-28 retrieval evaluation](https://github.com/rohitg00/agentmemory/blob/main/docs/benchmarks/2026-10-28-retrieval-evaluation.md):
LongMemEval-S, 470 answerable questions, BM25 only. Recall-all@5 84.7% vs 72.1% for a lexical
baseline; any-hit@5 96.2% vs 88.7%. The doc says itself that it does not exercise the daemon,
hooks, compression, vectors, graph or an answering model. The repo tagline still reads "#1 …
based on real-world benchmarks"; the README's own comparison says scores across systems are not a
head-to-head ranking.

**Earlier claim.** In [MemPalace #747](https://github.com/MemPalace/mempalace/discussions/747) the
maintainer reported 95.2% R@5 (BM25 + MiniLM hybrid). A reply in the same thread points out that
R@5 is retrieval, LongMemEval is a QA benchmark, and reporting one as the other inflates by 20–30
points. That critique applies to most vendors in the
[landscape note](2026-10-10-agent-memory-landscape.md), not only this one.

**Independent.** An HN comment in the
[OKF Agent Memory thread](https://news.ycombinator.com/item?id=49581240) ran six tools on 19k
LongMemEval sessions laid out as real `~/.claude` and `~/.codex` trees, 100 single-session
questions. The author built one of the six (deja) and says so.

| Tool | Index | hit@1 / 100 | found@50 |
|---|---|---|---|
| deja (plain BM25) | 29 s | 18 | 67 |
| agentmemory | 95 s import | 14 | 65 |
| MemPalace | ~3 h | 14 | — |
| claude-mem | no-op out of the box | — | — |

Their conclusion: BM25 ties embeddings at 1/100th the cost; the cliffs are reranking (found@50 67
vs hit@5 35) and staleness, and "the only fix I found was letting explicit user corrections outrank
the transcript".

## What others say

- [DevelopersDigest](https://www.developersdigest.tech/blog/github-trending-agentmemory-2026-05-16):
  useful only if you audit what it remembers. A memory can keep a wrong assumption, a stale branch
  name or a one-off hack alive; 53 MCP tools is a large permission surface; hooks capture more than
  users expect; plugins and hooks are executable supply chain.
- [AgentConn](https://agentconn.com/agents/agentmemory/), [Trendshift](https://trendshift.io/repositories/25123):
  praise for publishing a benchmark table; no testing of their own.
- [SignalForges deep dive](https://signalforges.com/pages/rohitg00-agentmemory-best-practices-2026-05-13/):
  403 on fetch. From the search snippet only (**unverified**): default LLM compression is a no-op
  and the privacy filter's scope needs checking.
- No Reddit discussion found. Most HN hits for "agentmemory" are other projects.

## Compared with this repo

| | claude-memory | agentmemory |
|---|---|---|
| Store | Markdown in an Obsidian vault, in git | `state_store.db` |
| Capture | Distilled facts at SessionEnd | Every tool call, compressed |
| Retrieval | bge-m3 (CLS) + BM25, RRF | BM25; MiniLM vectors opt-in |
| Write-time LLM | headless `claude -p` | none by default; bring a key or Ollama |
| Agents | Claude Code, Copilot CLI | ~15 |
| Runtime | hooks + optional `--serve` socket | server + engine, two ports, a secret |
| Evidence | held-out case sets, frozen sha256 | self-run BM25 component test |

Where it wins: agent coverage, a live viewer, crash-safe capture with an offline spool, a
credential filter on capture, decay as a default.

Where it loses for us: memory is not readable or diffable; the default install has no semantic arm,
and the opt-in one is a model we would expect to lose to bge-m3 (unmeasured on our case sets);
capturing every tool call is the opposite of distilling; the moving parts are where the open bugs
are.

## What to take

1. **Redact credentials in the distiller** — #223. We strip only `<private>` spans, and the vault
   auto-commits.
2. **Use-reinforced decay** — evidence added to #122 (item 2) and landscape idea 6. The signal
   already exists in `scripts/lib/recall-stats.mjs`.
3. **User corrections outrank other evidence** — evidence added to #70.
4. **Re-inject memory after compaction** — already ours. The SessionStart entries in
   `hooks/hooks.json` have no matcher, so they fire on `source: compact` too, and none of them
   skips it.
