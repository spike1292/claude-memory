# Seven agent-memory systems: what is worth stealing

Date: 2026-08-21. Method: fan-out web search, primary-source fetch, then 3-vote adversarial
verification per claim (a claim needed 2 of 3 refutals to be killed). 102 agents, 0 errors.
Every claim below carries its vote count. Sibling note:
[2026-08-21-obsidian-second-brain.md](2026-08-21-obsidian-second-brain.md).

**Systems compared:** obsidian-second-brain (eugeniughelbur), claude-mem, Mem0 (mem0ai),
Graphiti (getzep), Zep (getzep), memory-mcp, memsearch (zilliztech) — against
`memory@claude-memory`.

## Verdict

Against the baseline (local bge-m3 + BM25 with RRF, Markdown vault, SessionEnd distiller, token-Jaccard reconcile-on-write, 0.55 cosine gate), only four mechanisms across the seven systems are genuinely different AND portable to a local, single-user, no-network, plain-Markdown design: a write-side freshness invariant enforced by a linter (obsidian-second-brain), a hard character budget on injected context (obsidian-second-brain, ~900 chars / 4 notes), progressive-disclosure retrieval where an ID-bearing index is fetched before full bodies (claude-mem, memsearch), and a cross-encoder re-rank stage after fusion (memsearch). Everything else is convergent or disqualified: memsearch's dense+BM25+RRF in Milvus is our own fusion delegated to a vector DB; Mem0's extract/consolidate pipeline is our distiller with an LLM arbitrating ADD/UPDATE/DELETE/NOOP instead of a similarity threshold, at the cost of a paid network call per fact per write; Graphiti/Zep is a hosted-LLM temporal knowledge graph. The vendor benchmark claims do not survive scrutiny and should not drive any adoption decision: Mem0's own LOCOMO table shows the full-context baseline scoring HIGHER (72.90% J) than either Mem0 variant (66.88 / 68.44), so its win is latency and tokens, not accuracy; and its graph variant buys ~1.6 points while doubling stored footprint (7k→14k tokens) and tripling search latency, losing outright on single-hop and multi-hop. Graphiti's README asserts SOTA with no eval set, no baseline and no numbers, citing only its own vendor's paper. A TMLR-certified survey and the LoCoMo-Plus paper both caution that this whole benchmark family measures surface factual recall under short, static, isolated protocols — which is exactly why our named-case-set recall@k/MRR discipline stays the right gate.


## Findings

### 1. WORTH STEALING #1 — a write-side freshness invariant enforced by a linter. obsidian-second-brain requires every stored fact to be timeless, dated, or a pointer: fast-changing facts (counts, statuses, balances) are linked to their source with an `as of` stamp rather than copied in. It is a one-page spec (references/freshness-policy.md) enforced by scripts/freshness_lint.py with five typed rules — FRESH-1 (error) volatile quantitative claim without timestamp, FRESH-2 (warning) dated claim past its freshness window, FRESH-3 (error) typed pointer id missing from config, FRESH-4 exemption for dated containers, FRESH-5 (warning) suppression matching nothing — exiting 1 on error. This is freshness as an invariant, not as decay in the ranking.

**Confidence:** high · **Adversarial vote:** 3-0 (claim 11)

Verified in the shipped script, not just the README, on main 2026-08-21. This is a real gate, not a documented aspiration. It is local, stdlib-only and storage-agnostic Markdown, so it is genuinely portable — but the Python is not (this repo bans .py); it would need a Node port as a hooks/lib module behind validate-note or /memory:health. Our current equivalent is per-claim supersession in /memory:protocol plus a validate-note warn — a convention with no mechanical enforcement of the volatile-fact class. One caveat: whether the project also carries a weak freshness signal in ranking could not be fully excluded without reading its search implementation; the invariant-not-decay framing is right for the documented design.

**Sources:**
- <https://github.com/eugeniughelbur/obsidian-second-brain>
- <https://raw.githubusercontent.com/eugeniughelbur/obsidian-second-brain/main/scripts/freshness_lint.py>

### 2. WORTH STEALING #2 — a hard byte budget on injected context. obsidian-second-brain's UserPromptSubmit hook caps the injected brief at MAX_NOTES = 4 and MAX_CHARS = 900 (commented as ~250 tokens), enforced by truncation: notes stop accumulating when the running length would exceed the budget, and each note's snippet is additionally trimmed to 110 chars. We cap by note count and cosine score, never by bytes.

**Confidence:** high · **Adversarial vote:** 3-0 (claim 10)

Constants and the truncating break are in the hook source, and the README wording matches the code. Two things sharpen what is actually novel here. (a) Its abstain gate is NOT a confidence score — it is MIN_TERM_OVERLAP = 1, a lexical bar requiring the top hit to share one meaningful term with the prompt, which is materially LOOSER than our 0.55 cosine gate; the README's 'abstains when confidence is low' is marketing for a term-overlap check. So the claim that the design is 'stricter than a cosine gate alone' is true only of the byte budget, not of the gate. (b) Its per-decision audit log at <vault>/.claude-runs/recall-YYYY-MM-DD.jsonl is convergent, not novel — we already write recall-<date>.jsonl via appendJsonl() in hooks/lib/hook-io.mjs. The single transferable idea is the hard character ceiling on injected context.

**Sources:**
- <https://github.com/eugeniughelbur/obsidian-second-brain>
- <https://raw.githubusercontent.com/eugeniughelbur/obsidian-second-brain/main/hooks/obsidian-recall.py>

### 3. WORTH STEALING #3 (with caveats) — progressive-disclosure retrieval: fetch a cheap ID-bearing index first, fetch full bodies only for filtered IDs. claude-mem exposes this as a three-layer MCP workflow — `search` (~50-100 tokens/result, compact index with IDs), `timeline` (chronological context, 100-200 tokens/observation), `get_observations` (~500-1,000 tokens/result, only for IDs that survived filtering) — plus a fourth workflow-reminder tool. memsearch implements the same shape as search → expand → transcript inside a forked-context subagent. Our single-shot recall injection has no retrieval-cost mechanism of this kind.

**Confidence:** medium · **Adversarial vote:** 3-0 (claim 12); memsearch variant 1-2 (refuted)

The MECHANISM is primary-sourced and real (claude-mem v13.4.0, Apache 2.0). The MAGNITUDE is unverified vendor arithmetic and internally inconsistent — the '~10x token savings' is a hand-constructed illustration (20,000 tokens at ~10% relevance vs 3,000 at 100%, which is 6.7x not 10x), the same docs elsewhere quote '50-80% savings' (2-5x), and third-party write-ups recirculate an '18x'. No eval set, no baseline definition, no independent replication. Never repeat the number as a measurement. Adoption caveat: this costs one or more agent tool-call round trips — a drill-down loop — which is a different interaction model from our zero-latency automatic inject, not a strict improvement on it. It fits a /memory:recall-style explicit tool, not the UserPromptSubmit path. The memsearch variant of the same pattern was rated more weakly (1-2) by verifiers, so claude-mem is the better-evidenced reference implementation.

**Sources:**
- <https://github.com/thedotmack/claude-mem>
- <https://docs.claude-mem.ai/usage/search-tools>
- <https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/README.md>

### 4. WORTH EVALUATING #4 — a cross-encoder re-rank stage after fusion. memsearch ships src/memsearch/reranker.py using cross-encoder/ms-marco-MiniLM-L6-v2 via ONNX Runtime (or sentence-transformers CrossEncoder), which re-scores and re-sorts the RRF output. This is a pipeline stage we have no equivalent of; the pipelines are otherwise identical up to fusion.

**Confidence:** high · **Adversarial vote:** 3-0 (claim 8, reranker noted as qualification)

Read at source level on main. It is local and CPU-only via the same ONNX Runtime we already ship for bge-m3, so it is compatible with the no-network constraint and needs no new heavy dependency class. No published recall@k or MRR is offered for the re-rank stage by memsearch, so its value here is unknown and must be measured on our own named case set before adoption — and it adds latency inside a 700 ms recall budget, which is the constraint most likely to kill it.

**Sources:**
- <https://github.com/zilliztech/memsearch/blob/main/src/memsearch/reranker.py>
- <https://github.com/zilliztech/memsearch/blob/main/src/memsearch/store.py>

### 5. CONVERGENT, NOTHING TO TAKE — memsearch's retrieval is dense vectors plus BM25 fused with RRF (k=60, unweighted) inside Milvus, and its storage model is ours: Markdown is the source of truth, the vector index is an explicitly rebuildable derived cache, notes are per-day files at .memsearch/memory/YYYY-MM-DD.md in the project directory. Default deployment is Milvus Lite embedded at ~/.memsearch/milvus.db with a local int8 ONNX bge-m3 — same model, same fusion, same authority-of-Markdown design, just delegated to a vector database instead of node:sqlite.

**Confidence:** high · **Adversarial vote:** 3-0 (claims 8, 9)

store.py builds two AnnSearchRequests (dense COSINE on `embedding`, sparse BM25 on `sparse_vector` fed by a FunctionType.BM25 function over a SPARSE_INVERTED_INDEX) and passes them to hybrid_search(ranker=RRFRanker(k=60)). README states verbatim: 'Markdown is the source of truth. The Milvus vector index is a derived cache that can be rebuilt at any time with `memsearch index .memsearch/memory/`'. Their independent convergence on our exact design is the strongest available validation of it. Two notes: (a) Zilliz Cloud is an opt-in network/paid path and therefore NOT APPLICABLE here, as is self-hosted Milvus Server (Docker) — and a second egress path exists via the optional OpenAI/Gemini/Voyage embedding providers, so 'local by default' holds only for the default ONNX embedder; (b) their BM25 arm crashes on empty collections (avgdl=0 → NaN, upstream #306, worked around by returning [] at row_count 0) — a Milvus-side defect our own BM25 does not inherit.

**Sources:**
- <https://github.com/zilliztech/memsearch/blob/main/src/memsearch/store.py>
- <https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/README.md>

### 6. CONVERGENT WITH A COSTLY TWIST — Mem0's memory model is an LLM-driven extract/consolidate/retrieve pipeline: an LLM pass writes memories from conversation turns rather than storing raw chunks, and supersession is reconcile-on-write, where an LLM chooses ADD / UPDATE / DELETE / NOOP against the top-10 semantically similar existing memories. Architecturally this is our SessionEnd distiller plus token-Jaccard dedup, with two differences: the arbiter is an LLM rather than a >=0.45 threshold, and the trigger is per message-pair (online) rather than once per session.

**Confidence:** high · **Adversarial vote:** 3-0 (claims 1, 4)

Paper: 'The LLM itself determines which of four distinct operations to execute: ADD ... UPDATE ... DELETE for removal of memories contradicted by new information; and NOOP', with s=10 similar memories, and explicitly 'Rather than using a separate classifier, we leverage the LLM's reasoning capabilities to directly select the appropriate operation.' Code confirms it is not paper-only: _add_to_vector_store calls vector_store.search(..., top_k=10) and hands the numbered existing memories to an LLM. Minor drift between paper and code: the fourth op is spelled NONE in main.py, and current code folds extraction and update into one JSON-returning LLM call rather than a tool-call interface. NOT APPLICABLE as designed for us: one LLM call per extracted fact per write, over the network and paid, against our one headless call per session. The idea worth holding is narrower — that a contradiction is a DELETE decision distinct from a dedup decision, which our single Jaccard threshold does not distinguish. Note also that s=10 is an untuned default in both paper and code; no ablation on s exists.

**Sources:**
- <https://arxiv.org/abs/2504.19413>
- <https://arxiv.org/html/2504.19413v1>
- <https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py>
- <https://docs.mem0.ai>

### 7. DO NOT ADOPT — the temporal knowledge graph does not pay for itself, by the vendor's own numbers. Mem0's graph variant (Mem0g) scores 68.44% overall LLM-as-a-Judge vs 66.88% for plain Mem0 — ~1.6 points, which the paper itself calls 'around 2%' — while roughly doubling stored footprint from ~7k to ~14k tokens per conversation and raising p50 search latency from 0.148s to 0.476s. Per-category it LOSES on single-hop (67.13→65.71) and multi-hop (51.15→47.19), gaining only on temporal (55.51→58.13) and open-domain (72.93→75.71).

**Confidence:** high · **Adversarial vote:** 3-0 (claims 0, 5)

Both the delta and the footprint doubling are stated by the authors, not inferred: 'Mem0g roughly doubles the footprint to 14k tokens, due to the introduction of graph memories which includes nodes and corresponding relationships.' On multi-hop the paper concedes 'the expected relational advantages of Mem0g do not translate into better outcomes here, suggesting potential overhead or redundancy when navigating more intricate graph structures.' Vendor bias points the WRONG way to explain this — the finding runs against Mem0's interest in its own paid graph feature — and the known LOCOMO disputes (Mem0's audit correcting Zep's 84% claim to 58.44%) concern cross-system comparisons, not this internal A/B on one harness. Mem0g additionally requires Neo4j plus GPT-4o-mini extraction calls per update, which is disqualifying for a local no-network system regardless of the score. Two honest qualifications: the gain IS concentrated in temporal reasoning, so this refutes 'a KG is automatically worth it', not 'a KG never helps temporal validity'; and the absolute figures are the April 2025 paper's, not today's Mem0 (their research page now reports 92.5 on LOCOMO).

**Sources:**
- <https://arxiv.org/abs/2504.19413>
- <https://arxiv.org/html/2504.19413v1>

### 8. DO NOT ADOPT — Graphiti/Zep's SOTA claim is unbacked in its own README, which names no eval set, no baseline and no numbers, and cites only a paper authored by the same vendor.

**Confidence:** high · **Adversarial vote:** 3-0 (claim 2); three mechanism claims refuted 0-3

Two independent fetches of the raw README confirm the sentence 'Using Graphiti, we've demonstrated Zep is the State of the Art in Agent Memory' and that its only backing is a link to arXiv:2501.13956, authored by the Zep team (Rasmussen et al., getzep.com). A targeted second pass for benchmark tables, recall/accuracy percentages, named datasets (DMR, LongMemEval, LoCoMo) or baselines (MemGPT, Mem0, full-context) returned none — the README's GraphRAG and Zep comparison tables are qualitative feature matrices. The one number present, 'sub-200ms performance at scale', is a latency line in a product table. The paper's own figures (DMR 94.8% vs MemGPT 93.4%) remain vendor-run with no named independent replication, and Mem0's audit of Zep's LOCOMO number (84% corrected to 58.44%, getzep/zep-papers#5) is a live dispute. IMPORTANT COVERAGE GAP: three further Graphiti claims — its bi-temporal fact-invalidation model, its three-arm retrieval with graph-distance reranking, and its hosted-API-by-default deployment — were all voted down 0-3 in verification, so this report carries NO verified description of Graphiti's actual mechanics, only a verified absence of evidence for its headline. Treat Graphiti as un-assessed rather than as assessed-and-rejected on mechanism.

**Sources:**
- <https://github.com/getzep/graphiti/blob/main/README.md>
- <https://arxiv.org/abs/2501.13956>

### 9. DO NOT LET VENDOR BENCHMARKS DRIVE THE DECISION — Mem0's own LOCOMO table shows the full-context baseline scoring HIGHER than either Mem0 variant on the headline metric: Full-Context 72.90% LLM-as-a-Judge vs Mem0 66.88% and Mem0g 68.44%. The paper's win is latency and token cost (p95 1.44s vs 17.117s; ~1,764 vs ~26,000 tokens), not accuracy.

**Confidence:** high · **Adversarial vote:** 3-0 (claim 3)

The paper concedes it in prose: 'a full-context method that ingests a chunk of roughly 26,000 tokens still achieves the highest J score (approximately 73%)'. Zep's adversarial critique makes the same point and adds that LoCoMo conversations are only ~16k-26k tokens — inside a modern context window — so the benchmark barely stresses a memory system at all. Practical implication for this decision: no Mem0 LOCOMO number justifies adopting its architecture on accuracy grounds; what these systems demonstrably buy is cheaper context, which is the same thing our cosine gate and (prospectively) a byte budget buy. One interpretive caveat: Mem0's own marketing headline is '+26% over OpenAI Memory, 91% lower latency, 90% token savings', which does not itself assert superiority over full-context, so the 'undercuts vendor framing' reading is ours, not a quoted vendor claim.

**Sources:**
- <https://arxiv.org/html/2504.19413v1>
- <https://blog.getzep.com (Lies, Damn Lies, & Statistics: Is Mem0 Really SOTA in Agent Memory?)>

### 10. THE BENCHMARK FAMILY ITSELF IS WEAK, WHICH VINDICATES OUR OWN EVAL DISCIPLINE — LoCoMo, the eval set behind most vendor memory claims, 'primarily focus[es] on surface-level factual recall' and misses 'beyond-factual cognitive memory grounded in implicit constraints'; the LoCoMo-Plus paper (arXiv:2602.10715, Feb 2026) was built on top of LoCoMo specifically to cover that gap. Independently, a TMLR-certified survey (arXiv:2602.06052) warns that 'the majority of evaluation protocols largely simplify experimental assumptions and design static, pre-defined rules, with relatively short and isolated task settings', preceded by 'a significant gap remains between the reported performances and the utility in many real-world tasks'.

**Confidence:** high · **Adversarial vote:** 3-0 (claims 6, 7); the numeric drop 1-2 and the artefact generalisation 0-3 (refuted)

Both quotes verified verbatim against primary sources. LoCoMo-Plus evaluates Mem0 among others (with SeCom and A-Mem), so the Mem0 half of the vendor scope is in-scope; Zep is NOT evaluated in it, though Zep's own paper does report LoCoMo results. The survey passage is a general caution about agent-evaluation protocols and does not name Mem0 or Zep, so it is grounds for scepticism, not an independent audit of their specific numbers — the claim was correctly phrased as 'grounds for'. CITATION FIX: the survey revision dated 2026-08-04 is v4, not v3 (v3 is 2026-02-10). Note also that the specific LoCoMo→LoCoMo-Plus score drops for Mem0/SeCom/A-Mem, and the stronger 'vendor margins are eval-set artefacts' generalisation, were both voted DOWN in verification — so cite the qualitative critique, not the numbers. Bottom line for us: our standing rule that no retrieval number ships without a run on a named case set, and that rewriting the questions per run measures the questions, is exactly the discipline this literature says the vendors lack.

**Sources:**
- <https://arxiv.org/html/2602.10715v1>
- <https://arxiv.org/pdf/2602.06052>
- <https://arxiv.org/html/2602.06052v4>

### 11. CAPTURE CADENCE IS THE ONE STRUCTURAL DIFFERENCE WE SHOULD CONSIDER AND PROBABLY REJECT — claude-mem captures continuously during a session via a PostToolUse hook recording tool-usage observations (tool name, parameters, results) fire-and-forget into a buffer, with a background generator extracting facts incrementally; it runs five lifecycle hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) across six hook scripts. Mem0 has the same online cadence at message-pair granularity. Our distiller runs once, at SessionEnd.

**Confidence:** medium · **Adversarial vote:** 3-0 (claim 13)

The five-events/six-scripts count is the README's own self-report and could not be independently re-counted (no reachable hooks manifest), so treat the script count as low-stakes structural detail. The continuous-capture behaviour is corroborated from the failure side: issue #2201 reports 'full PostToolUse I/O capture' driving 345M tokens in a day, which is only possible if the hook fires per tool call mid-session. That failure IS the argument against adopting it: continuous capture converts a bounded once-per-session cost (our measured ~40k tokens of near-fixed headless overhead) into an unbounded per-tool-call one, and our own rule that hooks are best-effort and must never block cuts against a PostToolUse writer on the hot path. The defensible middle ground, if session-end distillation is ever found to lose material, is a cheap non-LLM buffer written during the session and distilled once at the end — capture continuously, extract once.

**Sources:**
- <https://raw.githubusercontent.com/thedotmack/claude-mem/main/README.md>
- <https://github.com/thedotmack/claude-mem/issues/2201>
- <https://arxiv.org/html/2504.19413v1>


## Caveats

GRAPHITI/ZEP IS EFFECTIVELY UN-ASSESSED. Four Graphiti claims went to verification and only one survived (that its README's SOTA assertion is unbacked). Its bi-temporal fact-invalidation model, its three-arm retrieval with graph-distance reranking, and its default hosted-OpenAI deployment were all voted 0-3 and are therefore NOT reported here as facts. Do not read this report as having examined and rejected Graphiti's mechanics — temporal validity windows with invalidation-instead-of-deletion remains the single most plausible mechanism we do not have, and it has not been properly evidenced either way in this pass. memory-mcp is absent from the findings entirely: no claim about it survived, and none appears in the refuted list either, so it was likely not researched.

VENDOR BENCHMARKS ARE ALL VENDOR-RUN. Every head-to-head number in this space (Mem0 vs OpenAI Memory, Zep vs MemGPT, Mem0's audit of Zep, Zep's critique of Mem0) is published by a party with a commercial interest, and no independent replication of any of it was found. The one class of vendor number that IS trustworthy is the kind quoted here most heavily: figures that run AGAINST the publisher's interest (full-context beating Mem0; Mem0g barely beating Mem0 while doubling footprint). Nothing in this report should be used to rank these systems against each other.

SELF-REPORTED MAGNITUDES ARE NOT MEASUREMENTS. claude-mem's '~10x token savings' is internally inconsistent across its own docs (6.7x by its own arithmetic, 50-80% elsewhere, 18x in third-party recirculation) and has no eval set. obsidian-second-brain's retrieval figures (keyword recall@10 1.0, paraphrase recall@10 77%, non-English 13%→63% recall@5) were voted DOWN because the README names no case set or corpus — do NOT quote them, including the tempting non-English figure.

TIME SENSITIVITY. The Mem0 paper is April 2025 and its absolute LOCOMO scores no longer describe today's Mem0 (their research page reports 92.5); cite 66.88/68.44/72.90 strictly as 'in the 2025 Mem0 paper'. LoCoMo-Plus (Feb 2026) and the TMLR survey (v4, Aug 2026) are current. Repo facts (memsearch store.py, obsidian-second-brain freshness_lint.py, claude-mem v13.4.0) are main-branch reads as of 2026-08-21 and will drift.

PORTABILITY IS NOT AUTOMATIC. The two best borrowings are Python (freshness_lint.py, obsidian-recall.py) in a repo that bans .py and fails CI on its reappearance; both need Node ports as hooks/lib modules with their own tests. The re-rank stage must clear the 700 ms recall budget and must be measured on a named case set before it ships, per our own no-number-without-a-case-set rule.

ONE COMPARATIVE FRAMING IS OURS, NOT SOURCED. Characterising Mem0's ADD/UPDATE/DELETE/NOOP as 'reconcile-on-write like ours but LLM-arbitrated' is our mapping onto our token-Jaccard >= 0.45 design; Mem0 makes no such comparison.


## Open questions

- Does Graphiti/Zep's bi-temporal model actually retain superseded facts with validity intervals and support point-in-time queries, and if so is a cheap Markdown analogue (a `superseded-by` / `valid-until` frontmatter field plus a filter at retrieval) worth building? Four verification votes failed to settle the mechanism, and it remains the most plausible genuinely-missing capability.
- What was memory-mcp? No claim about it survived verification and none was refuted, suggesting it was never researched. It should be covered before this comparison is called complete.
- Would a hard character budget on injected context actually change anything for us, given our 0.55 cosine gate already abstains often? This needs a measurement on the existing recall-<date>.jsonl logs — distribution of injected bytes per prompt — before any constant is chosen. A budget that never binds is dead code.
- Does our single token-Jaccard threshold conflate two decisions that Mem0 separates — 'this is a duplicate' (merge) versus 'this contradicts an existing note' (supersede/delete)? If contradiction is currently invisible to reconcile-on-write, that is a real gap, and the cheap local test is a lexical-negation/numeric-conflict check rather than an LLM arbiter.
- What is the cost floor of a local cross-encoder re-rank (ms-marco-MiniLM-L6-v2 int8 via the ONNX runtime we already ship) on a k=10 candidate list inside the resident --serve process, and does it improve recall@k or MRR on our existing case sets enough to justify a second model in memory?

