# The agent-memory leaderboards, and what a baseline scores on them

**Read 2026-08-25.** Five URLs were supplied. They are **one leaderboard**, and the most useful number
on it is not a vendor's — it is the one a plain SQLite full-text search gets.

This extends [Seven agent-memory systems](2026-08-21-agent-memory-systems-survey.md), whose finding
was that the vendor benchmark numbers did not survive checking. They still do not, in both
directions: the board contradicting a vendor is no more neutral than the vendor.

## Five URLs, one source

| Supplied | What it is |
| --- | --- |
| `agentmemories.ai/leaderboard/{industry,academic}/{textual,coding}` | Four routes of one SPA. All four return a **byte-identical** 175,098-byte shell |
| `huggingface.co/spaces/agent-memory-leaderboard/leaderboard` | A **static mirror of that same site** — `sdk: static`, the same `app.js`, `lastModified` 2026-08-18 |

So there is one source, not five, and no second opinion among them.

**The data is not in the HTML and not behind an API.** `/api/*` returns 404. The rendered rows come
from static JavaScript, and the readable copies are files in the HuggingFace space:

```
https://huggingface.co/spaces/agent-memory-leaderboard/leaderboard/resolve/main/
  data/generated/leaderboard_data.json        # textual, 356 KB
  data/generated/code_leaderboard_data.json   # coding,   67 KB
```

Both are `{overall, categories}` keyed `academic` / `commercial` — the site labels `commercial` as
**industry**. Every figure below is from those two files, retrieved 2026-08-25. Scores are stored as
fractions and shown here as percentages.

## Industry, textual (n=15)

| # | System | Overall | Fact recall | Temporal | Run by |
| --- | --- | --- | --- | --- | --- |
| 1 | MemoraX | **58.0** | 89.9 | 60.0 | self |
| 2 | MemOS | 45.9 | 68.9 | 56.5 | organisers |
| 5 | Cognee | 42.6 | 53.6 | 22.0 | organisers |
| 8 | Mem0 | 41.4 | 50.6 | 17.4 | organisers |
| **10** | **Vectorize Hindsight Cloud** | **38.5** | 46.4 | 16.9 | organisers |
| 13 | memory-8000 *(context-only control)* | 34.2 | | | self |
| 14 | SuperMemory | 29.6 | | | organisers |

## Industry, coding (n=15)

150 tasks — 51 new-feature, 99 bug-fix.

| # | System | Solved | Run by |
| --- | --- | --- | --- |
| 1 | MemoraX | **62.0** | self |
| 2 | claude-mem | 52.0 | self |
| 3 | hs v3 | 52.0 | self |
| 4 | MemOS | 52.0 | organisers |
| 7 | Mem0 API | 51.3 | organisers |
| 8 | Cognee | 50.7 | organisers |
| **15** | **Vectorize Hindsight Cloud** | **46.7** | organisers |

**Hindsight is last of fifteen here and tenth of fifteen on textual.** Its own academic submission
(`Hindsight AML Adapter aml-v0.3.0`) places 27th of 50 at 40.8.

`hs v3` at rank 3 is **probably** Hindsight — the site's cache-busting query string reads
`coding-hs-v3-submitted-api-20260818` — but this was not confirmed and the note does not rely on it.
If it is, the same system scores 52.0 self-run and 46.7 organiser-run.

## The finding worth keeping: a baseline ties for first

Academic coding, 43 systems:

| | Score | Behind leader | Rank |
| --- | --- | --- | --- |
| Leader (`AM-Link`) | 52.7 | — | 1 |
| **`aml-memory-baseline`** | **52.7** | **0.0** | 3 |
| `picoagent` | 51.3 | 1.3 | 17 |
| `SQLite-FTS-Baseline` | 50.0 | 2.7 | 27 |
| Last place | 46.0 | 6.7 | 43 |

**The entire field fits inside 6.7 points, and a plain baseline is tied for the lead.**

Academic textual (n=50) is looser — 21.5 points from first to last — but says the same thing:

| | Score | Behind leader |
| --- | --- | --- |
| Leader (`InvMem`) | 45.1 | — |
| `Raw Memory` | 42.3 | 2.7 |
| `SQLite-FTS-Baseline` | 41.8 | 3.3 |
| `just-a-BM25` | 38.5 | 6.6 |

`just-a-BM25` scores exactly what Hindsight Cloud scores on the industry board.

## Two reasons not to quote this board as a verdict

**Self-submitted and organiser-run results are not the same measurement, and the field mixes them.**
The `cate` field separates `Evaluated` (organisers ran it) from `Submitted (API)` / `Submitted (repo)`
(the entrant ran it). Every organiser-run commercial entry lands mid-table or lower; the top of both
industry boards is self-submitted.

**Most of the top entries are the leaderboard's own partners.** The space ships partner assets for
NetEase, Tencent Cloud, Cognee, Mem0, MemPalace, SuperMemory, MemTensor and **MemoraX** —
which wins both industry boards. Its textual margin is 12.1 points over second place, on a board
where places 2 through 8 are separated by 4.5. Hindsight is not a partner.

That is not evidence of misconduct and this note does not claim any. It is a reason the board cannot
serve as the neutral referee between two vendors' claims.

## What it settles

**Not** which memory system is best. Both available sources are interested parties: Hindsight's
LongMemEval standing comes from its own harness, and this board is run by an organisation whose
partners hold most of its top places.

**"Independently reproduced" does not survive checking, and this note asserted it before checking.**
Hindsight's README says its benchmark performance "has been independently reproduced by research
collaborators at the Virginia Tech Sanghani Center … and The Washington Post". Researchers from both
institutions are **co-authors of Hindsight's own paper** (arXiv 2512.12818, "Hindsight is 20/20"),
and the launch coverage describes the result as "validated by research with collaborators from
Vectorize, The Washington Post and Virginia Tech". A co-author is not an independent reproducer, and
the vendor's own sentence contains the word *collaborators*. The claim as originally written here
came from the README and nowhere else — the same failure this note criticises elsewhere.

Two related facts, since anyone re-reading that claim will want them. The headline gains (+211%
multi-session, +316% temporal, from 91.4% overall, announced 2025-12-16) are quoted against a
baseline none of the coverage names, so their size means nothing without it. And **LongMemEval has a
successor** — LongMemEval-V2, arXiv 2605.12493 — so the standing is on V1.

**What does survive** is the baseline result, because it is the one number nobody had an incentive to
inflate: on the coding board a stock full-text search finishes within 2.7 points of the winner, and a
bare baseline ties it. Whatever these benchmarks measure, retrieval sophistication is not moving it
much.

For this repo that argues against replacing a working two-arm retrieval with anything — the expected
gain is inside the noise of every measurement here. The gap that is real and unmeasured is different:
**Codex, Copilot and omp have no memory layer at all**, and no leaderboard position changes that.

Anything further needs our own case set run against both, per the standing rule that no retrieval
number ships without one.

## Sources

- https://agentmemories.ai/leaderboard/industry/textual · `/industry/coding` · `/academic/textual` · `/academic/coding`
- https://huggingface.co/spaces/agent-memory-leaderboard/leaderboard — and its `data/generated/*.json`
- https://benchmarks.hindsight.vectorize.io/ · https://arxiv.org/abs/2512.12818 (Hindsight's own)
- Benchmarks named by the board: LoCoMo-Refined, LongMemEval-S, LongMemEval-Refined, PersonaMem-v2,
  CLBench, BEAM, ScriptMem
