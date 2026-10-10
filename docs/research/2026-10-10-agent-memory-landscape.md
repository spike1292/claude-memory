# Agent memory, 2026-08-21 → 2026-10-10: what moved, and what is worth taking

Research note, 2026-10-10. Primary sources only: GitHub READMEs, release lists, code read raw from
`raw.githubusercontent.com`, first-party docs, and arXiv abstract pages. Anything taken from a search
snippet because the primary page refused the fetch is marked **unverified**. Star counts and
`pushed` dates come from the GitHub API on 2026-10-10.

Scope was set so that nothing is read twice. The
[2026-08-21 survey](2026-08-21-agent-memory-systems-survey.md),
[comparison evidence](2026-08-21-comparison-evidence.md) and
[obsidian-second-brain note](2026-08-21-obsidian-second-brain.md) stand as written. This note covers
two things only: what changed since 2026-08-21 in systems they already covered, and systems they did
not cover (Hindsight, Cognee, MemOS, Supermemory, A-MEM, LangMem, Memobase, the Anthropic API memory
tool, ChatGPT, and the 2025–2026 benchmarks).

**Headline.** Four findings.

1. **Mem0 no longer makes the write-time decision the survey described.** Its OSS add path is now
   "Single-pass ADD-only (one LLM call, no UPDATE/DELETE)" plus MD5 hash dedup. Contradictions are
   kept, and on the hosted platform a separate "Dream" layer marks them superseded. The change landed
   between 2026-03-01 and 2026-04-15, so survey finding 6 was already out of date when it was written.
2. **The open Graphiti question is now answered from code.** One LLM call flags duplicates and
   contradictions. Deterministic date rules then set `invalid_at` and `expired_at`. Nothing is
   deleted.
3. **Two more systems now rerank fused results with a cross-encoder** (Hindsight and Graphiti). No
   one publishes an ablation of that stage, so its value to us is still unknown.
4. **The newer benchmarks put contradiction handling and abstention at the bottom.** The weakest
   category on Mem0's own BEAM run is `contradiction_resolution` (35.7 at 1M tokens). Our eval gate
   does not measure either.

## What changed in systems already covered

### Claude Code auto memory (first-party)

The npm `time` map gives these dates: 2.1.234 on 2026-08-17 (the last version in the earlier
note), 2.1.296 on 2026-10-09. Memory-relevant entries since then, from `CHANGELOG.md`:

| version | date | change |
| --- | --- | --- |
| 2.1.268 | 2026-09-10 | "Improved the MEMORY.md truncation warning to say how many lines were cut and where the cut starts" |
| 2.1.273 | 2026-09-15 | a repo-chosen memory dir is no longer "loaded into the prompt, recalled, indexed, or used by memory extraction" under `blockReadsOutsideWorkingDirectories` |
| 2.1.275 | 2026-09-17 | restored memory files carry an "age note" (a fix to its cache stability) |
| 2.1.284 | 2026-09-28 | "invisible characters and tags that imitate Claude Code's own markup are neutralized in `MEMORY.md` and recalled memory notes before they reach Claude" |
| 2.1.285 | 2026-09-29 | auto memory can no longer be turned *on* from a background session or a tool-started session |
| 2.1.286 / 2.1.288 | 2026-09-30 / 10-02 | "memory recall" depends on structured outputs and, in Claude Tag, on "the default Sonnet model" |

The changelog uses the words "recalled", "indexed" and "memory extraction", so a model-driven recall
step now exists. The memory docs still say only this: topic files are not loaded at startup, and
Claude "reads them on demand using its standard file tools". The recall mechanism is undocumented.

The earlier decision rests on one fact, and it still holds. The over-limit error fires only when
*Claude* writes `MEMORY.md`. errors.md: "Claude wrote to the auto memory index … The write
succeeded". Nothing documents a load-time warning for an index that another process wrote. The
2.1.268 "truncation warning" is not described anywhere else. One new detail: **"YAML frontmatter and
block-level HTML comments are stripped before the index is loaded, so they're excluded from the
measurement"** (since 2.1.211).

Sources: <https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>,
<https://registry.npmjs.org/@anthropic-ai/claude-code>, <https://code.claude.com/docs/en/memory>,
<https://code.claude.com/docs/en/errors.md> ("Memory index is over its read limit").

### Mem0 (66.9k★, Apache-2.0, pushed 2026-10-09)

- **Write path.** `mem0/memory/main.py` on main calls `ADDITIVE_EXTRACTION_PROMPT`. It passes the
  top 10 similar memories in as context, then skips any fact whose MD5 is already stored. `"UPDATE"`
  and `"DELETE"` now come only from the explicit `update()` and `delete()` API. The migration guide
  says: "When information changes, the new fact is stored alongside the old one. Retrieval handles
  ranking". The prompt is absent from main.py at a 2026-03-01 commit and present at 2026-04-15.
- **Retrieval (v3).** Semantic, BM25 and entity-overlap signals are "normalized and fused into a
  single combined `score`". "Only semantic search results are candidates: BM25 and entity scores
  boost ranking but don't add new candidates". In our pipeline both arms can nominate candidates.
  `rerank` now defaults to `False`.
- **Dream (platform only).** Supersede and Merge run "when a memory is added". "Superseded memories
  are not deleted and not hidden by default". `latest_only=true` filters them out. Synthesis is a
  scheduled per-user job (Pro: every 7 days; needs ≥ 20 memories). The docs do not say how a
  contradiction is detected.
- **Memory Decay (platform, opt-in).** Every search hit gets a small reinforcement. Memories that
  stay unused are dampened, never below `0.3×`: "a soft ranking bias, never a filter".
- **Benchmarks.** LoCoMo 92.5, LongMemEval 94.4, BEAM-1M 64.1, BEAM-10M 48.6, at about 6.8k tokens
  per query. These are vendor-run and "reflect Mem0's managed platform, which includes proprietary
  optimizations not available in the open-source SDK". The harness is open source
  (`mem0ai/memory-benchmarks`). The worst BEAM category is `contradiction_resolution`: 35.7 (1M)
  and 32.5 (10M). That figure runs against the vendor's own interest, so it is the one to quote.
- **User profiles** were added to the client in v2.2.0 (2026-09-23).

Sources: <https://raw.githubusercontent.com/mem0ai/mem0/main/mem0/memory/main.py>,
<https://docs.mem0.ai/migration/oss-v2-to-v3>, <https://docs.mem0.ai/platform/features/dream>,
<https://docs.mem0.ai/platform/features/memory-decay>,
<https://docs.mem0.ai/core-concepts/memory-evaluation>, <https://github.com/mem0ai/mem0/releases>.

### Graphiti / Zep (31.6k★, Apache-2.0, v0.30.2 on 2026-09-08)

This closes the survey's coverage gap, where three Graphiti mechanism claims had been voted down
0-3. All of the following is from `graphiti_core` on main:

- `EntityEdge` carries `valid_at` ("when the fact became true"), `invalid_at` ("when the fact
  stopped being true"), `expired_at` ("when the node was invalidated"), `reference_time` and
  `created_at`. That is two timelines: when a fact was true, and when the system learned it.
- `resolve_extracted_edges` runs two searches. Duplicate candidates come from a hybrid RRF search
  limited to the same endpoint pair. Invalidation candidates come from a second search over the fact
  text with no endpoint filter. One LLM call (`dedupe_edges.resolve_edge`) returns
  `duplicate_facts` and `contradicted_facts`.
- **The LLM flags and the code decides.** `resolve_edge_contradictions` ignores candidates whose
  validity windows do not overlap. Otherwise it sets `edge.invalid_at = resolved_edge.valid_at` and
  stamps `expired_at = now`. The README: "old facts are invalidated — not deleted."
- Retrieval: "semantic embeddings, keyword (BM25), and graph traversal", reranked by graph distance
  or by a cross-encoder. OpenAI is the default for both LLM and embedder. The README still publishes
  no benchmark numbers. The only figures are in the vendor's own paper (arXiv:2501.13956, v1
  2025-01-20, no revision): DMR 94.8 vs MemGPT 93.4.

Sources: <https://raw.githubusercontent.com/getzep/graphiti/main/README.md>,
<https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/edges.py>,
<https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/utils/maintenance/edge_operations.py>,
<https://arxiv.org/abs/2501.13956>, <https://github.com/getzep/graphiti/releases>.

### Letta / Letta Code (letta 25.1k★; letta-code 3.6k★, v0.34.10 on 2026-10-09)

The README: sleep-time compute is "now called 'dreaming'". `/sleeptime` configures it, and `/dream`
or `/reflect` runs it. "All context (including memory blocks) is tracked via git". Release notes
since 2026-08-21 show more upkeep moved to a background worker: "route incidental memory upkeep to
the background worker" (#4634) and "repair post-turn Git conflicts with a background worker"
(#4628). They also add a "Memory tool for MemFS v2 agents" (#4884). docs.letta.com was blocked by
the network proxy on this machine, so the MemFS v2 design itself was **not read**.

The sleep-time paper (arXiv:2504.13171, 2025-04-17) measures Stateful GSM-Symbolic and AIME: about
5× less test-time compute, and up to 13–18% better accuracy. **It is not memory-retrieval evidence.**
Do not cite it as support for dreaming in a notes vault.

Sources: <https://raw.githubusercontent.com/letta-ai/letta-code/main/README.md>,
<https://github.com/letta-ai/letta-code/releases>, <https://arxiv.org/abs/2504.13171>.

### claude-mem (99.1k★, Apache-2.0, v13.35.0 on 2026-10-09)

The design has not changed: five lifecycle hooks, SQLite + FTS5 plus Chroma, and the 3-layer
`search` → `timeline` → `get_observations` MCP flow. The README still says "~10x token savings" with
no method. What is new is breadth: installers for OpenCode, OpenClaw, DeepSeek Harness, Grok Bot and
others; optional cloud backup to cmem.ai; and `CLAUDE_MEM_MODE` for language and workflow. There is
nothing new to take.

Source: <https://raw.githubusercontent.com/thedotmack/claude-mem/main/README.md>.

### memsearch (2.7k★, v0.4.21 on 2026-09-24)

Capture is now explicitly per turn: "The plugin captures every conversation turn automatically",
with each turn summarized by an LLM. The local cross-encoder that the survey read is no longer what
the README advertises. The README now offers "Optional Jev reranking … through the TypeSafe API,
with no local model download", which is a network call. Recall is still "search → expand →
transcript".

Source: <https://raw.githubusercontent.com/zilliztech/memsearch/main/README.md>.

### basic-memory (4.1k★, AGPL-3.0, CHANGELOG v0.24.0 dated 2026-10-08)

Three changes in v0.24.0:

- "Semantic search is always on" (#1696). It falls back to keyword-only when the vector runtime
  cannot load, and says so.
- The POSIX read tools (`cat`, `grep`, `ls`, `find`, `tail`) are on by default (#1476). The agent
  greps the vault directly.
- Accepted writes stamp `created_by` and `updated_by` into frontmatter (#1608).

The last one is the same second-writer provenance problem that our auto-memory decision deals with.

Source: <https://github.com/basicmachines-co/basic-memory/blob/main/CHANGELOG.md> (read via the
contents API).

## Systems not covered before

### Hindsight (vectorize-io, 48.0k★, MIT, v0.10.3 on 2026-10-08)

- **Paper:** arXiv:2512.12818 (2025-12-14). There is also a system demo at ACL 2026. The authors
  are from Vectorize.io, The Washington Post and Virginia Tech. The README says the benchmark
  results were "independently reproduced by research collaborators" at Virginia Tech and The
  Washington Post. **Those collaborators are co-authors of the paper**, which is the same pattern
  this repo already recorded.
- **Memory model:** four networks (world, experience, opinion, observation). An opinion is
  `(text, confidence, timestamp)`. New evidence moves its confidence after an LLM labels it
  reinforce, weaken, contradict or neutral. A contradiction moves it twice as far as weakening does.
  Retain extracts "2–5 comprehensive facts per conversation". It also normalizes relative time
  phrases into an occurrence interval plus a mention timestamp.
- **Recall:** four arms in parallel (pgvector semantic, BM25, graph spreading activation, temporal),
  then RRF, then `cross-encoder/ms-marco-MiniLM-L-6-v2`, then greedy packing up to a token budget.
  **No ablation** isolates the reranker or any arm, and no recall latency is reported.
- **Numbers (vendor):** LongMemEval-S 83.6 with OSS-20B. The full-context baseline on the same
  model scores 39.0. LoCoMo 83.18 (20B) / 85.67 (120B). The introduction's "75.78% to 85.67%" mixes
  the 20B baseline with the 120B result.
- **Deployment:** Postgres + pgvector, or an embedded `pg0`. The
  `@vectorize-io/hindsight-coding-agents` package builds per-repo memory from git history and past
  sessions.

Sources: <https://arxiv.org/html/2512.12818v1>,
<https://raw.githubusercontent.com/vectorize-io/hindsight/main/README.md>.

### Cognee (31.9k★, Apache-2.0, v1.6.3 on 2026-10-07)

The verbs are now `remember`, `recall`, `improve` and `forget`. It "Runs locally for free — no API
key required": GLiNER does the extraction and a local model does the embedding. `improve` includes
"Session distillation curates accepted lessons into permanent memory", which is our distiller's job
in different words. The mechanism is not described. Its BEAM figures (0.79 at 100K on 20 questions;
0.67 at 10M, "exploratory") come from its own `eval_framework/beam/REPORT.md`, and the README says
the two are not comparable.

Source: <https://raw.githubusercontent.com/topoteretes/cognee/main/README.md>.

### MemOS (11.8k★, Apache-2.0, v2.0.34 on 2026-09-23)

The local plugin does "Hybrid retrieval (FTS5 + vector)" with dedup, and crystallizes "Skills"
across L1 traces, L2 policies and L3 world models. The plugin supports DeepSeek Harness, Hermes and
OpenClaw, not Claude Code. LoCoMo 88.83 and LongMemEval 89.20 come from its own "OmniMemEval". The
"72% lower token usage" claim has no method. Papers: arXiv:2507.03724 and arXiv:2505.22101.

Source: <https://raw.githubusercontent.com/MemTensor/MemOS/main/README.md>.

### Supermemory (31.2k★, MIT, no GitHub release since 2026-08-21)

It has a local mode (`npx supermemory local`, local embeddings, data in `./.supermemory`) and a
Claude Code plugin (`supermemoryai/claude-supermemory`). The README claims "#1" on LongMemEval,
LoCoMo and ConvoMem, plus "95% Recall@15 with a 99.4% context reduction". All of it is self-reported.

Source: <https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md>.

### Smaller or dormant

- **A-MEM** (arXiv:2502.12110, NeurIPS 2025, v11 2025-10-08). Zettelkasten-style notes. Adding a
  memory can rewrite the attributes of the notes it links to ("memory evolution"). Both repos are
  quiet: `agiresearch/A-mem` was last pushed 2025-12-12, `WujiangXu/A-mem` 2026-03-05.
- **LangMem** (1.7k★, no releases, pushed 2026-10-02). Hot-path memory tools, a background manager
  that extracts and refreshes, and prompt refinement. Nothing here is new to us.
- **Memobase** (2.9k★, pushed 2026-01-11). Dormant. Hindsight's LoCoMo table lists it as the
  strongest prior system (75.78).
- **CaviraOSS "OpenMemory"** has been renamed `CaviraOSS/LongMemory` (4.5k★). Still not researched.
- **Anthropic API memory tool** (`memory_20250818`). Client-side file operations under `/memories`.
  The docs advise capping file size and view length, path-traversal checks, and "Periodically delete
  memory files that haven't been accessed in a long time". Nothing new since the earlier note.
- **ChatGPT.** **Unverified:** both openai.com and help.openai.com returned 403. Search snippets
  date "Dreaming" (automatic memory updates "designed to tackle staleness and contradictions") to
  2026-06-04. Do not quote it until the page is read.

## Benchmarks

| benchmark | what it adds | source |
| --- | --- | --- |
| BEAM (ICLR 2026) | 100 conversations, 2,000 questions, up to 10M tokens. Has explicit `contradiction_resolution`, `knowledge_update`, `abstention` and `event_ordering` categories | arXiv:2510.27246 |
| LongMemEval-V2 (2026) | 451 questions over web/enterprise agent trajectories, up to 115M tokens. Abilities include "workflow knowledge" and "environment gotchas". Scores accuracy *and* latency | <https://github.com/xiaowu0162/LongMemEval-V2>, arXiv:2605.12493 |
| MemoryAgentBench (ICLR 2026, v4 2026-06-28) | Four competencies: accurate retrieval, test-time learning, long-range understanding, **selective forgetting**. "current methods fall short of mastering all four" | arXiv:2507.05257 |
| AMA-Bench (v4 2026-05-27) | Agent trajectories, not dialogue. Says existing systems "rely heavily on lossy similarity-based retrieval" | arXiv:2602.22769 |
| StructMemEval, MemGym | Search snippets only. **Unverified** | arXiv:2602.11243, arXiv:2605.20833 |

LongMemEval-V2's "environment gotchas" and "workflow knowledge" are the closest any public
benchmark comes to what `Insights/Mistakes/` holds. It is still web-agent data and not code. None
of these replaces our own case sets. They show which categories ours are missing.

## What we could learn / improve

Ranked by expected value per unit of work. Evidence: **strong** = first-party code or docs, or a
vendor number that runs against the vendor's own interest; **medium** = the mechanism converges
across independent systems but no one has measured the effect; **weak** = vendor claim or
single-source.

1. **Reconcile/dedup: stop recording a reversal as corroboration.** `reconcile()` in
   `hooks/lib/distill-session.mjs` appends `**Also seen <date>:**` to whatever note `bestDupe()`
   matched. A new claim that *reverses* that note is therefore filed as support. Graphiti, Mem0
   Dream and Hindsight all separate the two cases, and none deletes the old fact. The cheap
   adaptation, which adds no extra model call:
   - put the matched note's body into the distiller prompt that already runs once per session;
   - ask for `same | extends | reverses`;
   - on `reverses`, write `superseded_by` / `valid_until` frontmatter on the old note and link the
     new one, Graphiti-style. The model flags, and a rule writes the date.

   Then demote superseded notes in recall rather than hiding them. Evidence: **medium** for the
   mechanism. It is **strong** that this category is where systems fail (BEAM
   `contradiction_resolution` 35.7 on Mem0's own run). This is already named as a gap in
   [vision A2](../vision.md) and in the survey's open questions. Not yet measured here. Precondition:
   a contradiction case set (idea 2).
2. **Eval gate: add knowledge-update and abstention cases.** `memory-eval.mjs` scores whether the
   gold note ranks first. It cannot see "returned the superseded note" or "should have abstained".
   BEAM, LongMemEval and MemoryAgentBench all score these separately, and all three show them as
   weak spots. Two new case kinds:
   - a pair of notes where the later one supersedes the earlier, with the newer as gold;
   - a question with no answer in the vault, which passes only if the recall hook abstains. This
     also tests the 0.55 cosine gate directly.

   Evidence: **strong** that the categories matter. Nothing has been run here. Idea 1 should ship
   only with these cases.
3. **Recall hook: neutralize markup in injected note text.** Claude Code 2.1.284 now strips
   "invisible characters and tags that imitate Claude Code's own markup" from `MEMORY.md` and
   recalled notes. Our UserPromptSubmit brief injects vault text that the distiller wrote from
   transcripts, which can contain fetched pages. That makes this the cheap first step toward
   [vision E](../vision.md) ("text from outside the user is data"). Evidence: **strong**
   (first-party). It is small, and it can be tested with a fixture note carrying zero-width
   characters and a fake `<system-reminder>`.
4. **MEMORY.md / L1: measure the cap the way Claude Code does.** `mocSize()` in
   `hooks/lib/memory-link-lint.mjs` counts the raw file. Claude Code (≥ 2.1.211) strips frontmatter
   and block HTML comments first. Ours over-reports, which is the safe direction, so this is a
   precision fix only. The rest of the auto-memory decision holds: the over-limit error is still a
   write-time error for Claude's own writes. Evidence: **strong**. Low value.
5. **Retrieval: cross-encoder rerank after RRF stays "measure first".** Adoption has grown
   (Hindsight uses ms-marco-MiniLM-L-6-v2; Graphiti has a cross-encoder reranker). Measured
   evidence has not: Hindsight's paper has no ablation, Mem0 v3 turned `rerank` off by default, and
   memsearch moved to a remote reranker. The survey's test plan is unchanged: int8 ONNX in
   `--serve`, k = 10, measured on a held-out set, and it must fit the 700 ms recall budget. Evidence:
   **weak** for the effect.
6. **Retrieval: use-reinforced recency as a soft bias, not a filter.** Mem0's Memory Decay
   reinforces a memory on each retrieval and dampens unused ones, never below 0.3×. Our recall log
   already records the candidate paths for each prompt, so the reinforcement signal exists. Risk:
   notes that already surface would keep surfacing. It ships only behind a held-out run. Evidence:
   **weak** (vendor, no number).
7. **Distiller/synthesize: scheduled consolidation, drafts only.** Background consolidation is now
   standard: Letta dreaming, Mem0 Dream Synthesis (weekly, ≥ 20 memories), Hindsight mental models,
   Cognee `improve`, and (unverified) ChatGPT. Ours exists but is manual: `/memory:synthesize` →
   Staging → `/memory:adopt` behind the held-out gate. A scheduled synthesize that only *drafts* to
   Staging would match the pattern and keep the gate. Evidence: **weak** for value. No one publishes
   a consolidation ablation, and the sleep-time paper is about math tasks.

**Do not adopt, again or newly:**

- **Per-write LLM arbitration.** Mem0 itself backed out of it (point 1 of the headline).
- **Continuous per-turn capture.** memsearch has now joined claude-mem in doing it. The survey's
  rejection on cost stands.
- **A knowledge graph store.** Graphiti still needs a graph DB plus an LLM per ingest, and still
  publishes no README numbers.
- **Any vendor leaderboard figure.** That covers Mem0 92.5 / 94.4 (platform-only optimizations),
  Hindsight (reproduced by its co-authors), Supermemory's "#1", and MemOS (own harness).

## Caveats

- **docs.letta.com and openai.com could not be read.** The proxy redirected one and the other
  returned 403. Letta's MemFS v2 and ChatGPT Dreaming are described only as far as a README or
  search snippet allows.
- **Mem0's Dream and Decay are platform features.** The docs do not say how a contradiction is
  detected, so the "supersede" mechanism above is Graphiti's, which is the only one read in code.
- **Claude Code's recall mechanism is undocumented.** The changelog lines imply a model-driven
  recall and an extraction step, but the memory page does not describe them. Re-read before
  assuming what our `MEMORY.md` competes with.
- **Repo facts are main-branch reads as of 2026-10-10** and will drift. Every benchmark figure is
  vendor-run unless the table above says otherwise.

## Sources

Ours: `hooks/lib/distill-session.mjs` (`reconcile`), `hooks/lib/memory-recall.mjs` (`MAX_CHARS`),
`hooks/lib/memory-link-lint.mjs` (`mocSize`, `AUTO_MEMORY_CAP`), `docs/vision.md` (A2, D, E).

Theirs (all read 2026-10-10):

- <https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>
- <https://registry.npmjs.org/@anthropic-ai/claude-code>
- <https://code.claude.com/docs/en/memory>
- <https://code.claude.com/docs/en/errors.md>
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool>
- <https://raw.githubusercontent.com/mem0ai/mem0/main/mem0/memory/main.py>
- <https://docs.mem0.ai/migration/oss-v2-to-v3>
- <https://docs.mem0.ai/platform/features/dream>
- <https://docs.mem0.ai/platform/features/memory-decay>
- <https://docs.mem0.ai/core-concepts/memory-evaluation>
- <https://raw.githubusercontent.com/getzep/graphiti/main/README.md>
- <https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/edges.py>
- <https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/utils/maintenance/edge_operations.py>
- <https://arxiv.org/abs/2501.13956>
- <https://raw.githubusercontent.com/letta-ai/letta-code/main/README.md>
- <https://github.com/letta-ai/letta-code/releases>
- <https://arxiv.org/abs/2504.13171>
- <https://raw.githubusercontent.com/thedotmack/claude-mem/main/README.md>
- <https://raw.githubusercontent.com/zilliztech/memsearch/main/README.md>
- <https://github.com/basicmachines-co/basic-memory/blob/main/CHANGELOG.md>
- <https://arxiv.org/html/2512.12818v1>
- <https://raw.githubusercontent.com/vectorize-io/hindsight/main/README.md>
- <https://raw.githubusercontent.com/topoteretes/cognee/main/README.md>
- <https://raw.githubusercontent.com/MemTensor/MemOS/main/README.md>
- <https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md>
- <https://raw.githubusercontent.com/langchain-ai/langmem/main/README.md>
- <https://arxiv.org/abs/2502.12110>
- <https://arxiv.org/abs/2510.27246>
- <https://arxiv.org/abs/2507.05257>
- <https://arxiv.org/abs/2602.22769>
- <https://raw.githubusercontent.com/xiaowu0162/LongMemEval/main/README.md>
- <https://raw.githubusercontent.com/xiaowu0162/LongMemEval-V2/main/README.md>
- GitHub API `repos/<owner>/<repo>` and `/releases` for every star count, licence and release date
