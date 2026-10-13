# How retrieval works, and why

This page explains *why* retrieval is shaped as it is. The *how* — the request path, the socket,
the timeouts — is in [architecture.md](architecture.md), Flow 2 (recall) and Flow 3 (the search
daemon). The code is `scripts/lib/memory-semantic.mjs` and `hooks/lib/memory-recall.mjs`.

Every number below links to the decision record that measured it and names its case set. The
tables stay in those records; this page does not copy them. Read a small set honestly: on the
real-vault sets one EN case is 3.6 points and one NL case 6.7.

## The two arms

A query runs two searches over the same chunks and fuses the two rankings.

**The vector arm** matches by meaning. It embeds the query and scores every chunk by cosine — a
linear scan, no ANN index. It wins when the question and the note share no distinctive word:
"which **firewall** rules apply here" reaches a note about `WAF`, and "a **short outage**" reaches
one about a `cutover`. Keyword search scores those 0 of 8
([model choice](decisions/2026-08-15-model-choice.md), "Why a vector search arm at all").

**The BM25 arm** matches by words (`k1=1.2`, `b=0.75`, one score per chunk). It wins on
identifier-shaped questions — a ticket key, a CLI name, a dated commit-style title — where an
embedding sees one token among many. On the real-vault EN set it found 4 of the 7 notes the vector
arm missed, all of that shape ([fusion tuning](decisions/2026-08-15-fusion-tuning.md), "Why fusion
exists at all").

The two arms miss *different* notes. That is the whole reason to run both.

## Rank fusion

`fuseRRF()` is Reciprocal Rank Fusion: each arm contributes `1 / (k + rank)`, with `k = 60` and the
keyword arm weighted `w = 2`. Each note is represented by its best chunk, so one long note cannot
fill the result list.

**Why ranks, not scores.** Cosine sits in a narrow band; BM25 is unbounded. A weighted sum of the
two needs a normaliser, and that normaliser would be one more per-model constant that fails in
silence. `e5-multi` failed exactly that way, with its compressed similarity band. RRF reads only
ranks, so a model with a different band cannot break it. `k = 60` flattens the top, so rank 1 and
rank 2 are close.

**Why `w = 2`.** It is the only weight at which no column regresses on either real-vault set (EN
and NL, both `tuning`). The `w = 20` that `obsidian-second-brain` swept on their vault is worse here
on every EN column: the sweep method transfers, the value does not
([fusion tuning](decisions/2026-08-15-fusion-tuning.md)).

**Why per-chunk BM25.** Scoring a whole note (`MEMORY_FUSE_LEX=note`) rewards length, so long
generic notes push out short precise ones. It lost on every column, worst on Dutch. The option
stays so the negative result can be reproduced (same record, "The lexical-scoring mode").

**Superseded notes sink, they do not vanish.** A chunk whose note carries a supersession marker has
its score multiplied by `SUPERSEDED_DEMOTE` (0.9) in both arms, for ordering only. The card and
alias chunks inherit the note's marker, or a question that matches through the alias chunk never
sees it ([superseded demote](decisions/2026-10-10-superseded-demote.md), synthetic seed 7,
`cases-supersede.jsonl`, `tuning`).

## Gating and abstention

Fusion always returns *something*. The recall hook decides whether that something is worth
injecting into a prompt, and its rule is: **when in doubt, say nothing.** A wrong note in context
costs more than a missing one.

There are two gates, because the two paths produce two different kinds of score:

- **Cosine `MIN_COS = 0.55`** — on the `--serve` path. The gate reads each hit's raw cosine, not
  the fused score; a keyword-only hit has cosine 0 and never passes. On-topic and off-topic prompts
  *overlap* in cosine, so no threshold is clean. 0.55 rejects every off-topic prompt in its sample
  and gives up one on-topic one. The sample is 10 prompts; the calibration and that warning sit
  beside the constant in `hooks/lib/memory-recall.mjs`.
- **BM25 `MIN_SCORE = 6.0`** — on the fallback path, when the server is not up. It scores only the
  card chunk. It is *low*: every on-topic prompt clears it by 2.5–3.4×, but it also lets through
  much of the off-topic band. About 14 would halve false fires at no on-topic cost, and it still
  ships at 6.0, because absolute BM25 scales with the corpus and the sweep is a direction, not a
  value ([recall gate calibration](decisions/2026-08-19-recall-gate-calibration.md), synthetic
  seed 7 at 120/300/1000 notes, `cases-paraphrase` + `cases-keyword`, plus a machine-local
  off-topic control).

The two scales mean nothing to each other — do not compare 0.55 with 6.0. Both are starting points.
`/memory:doctor --stats` shows the real answer/abstain rate from `logs/recall-<date>.jsonl`; read
that before you move either one.

## Chunking and the embedding pipeline

`chunkNote()` turns one note into three kinds of chunk:

- **The card** — the note name, its frontmatter summary and the start of the body. It speaks for
  the whole note, and its text is what the recall brief shows, whichever chunk matched.
- **The alias chunk** — the `_Also asked as:` lines, alone, led by the note name. Those lines are
  questions, which is what a query looks like. Left at the end of the last section, they were
  diluted into that section's subject: a near-verbatim query missed its note in the top 40
  ([alias chunk](decisions/2026-08-15-alias-chunk-regex.md)).
- **Sections** — each `##` section, cut at the profile's `maxChars`. Every chunk starts with the
  note's identity, so a mid-note section still belongs to its note.

Two traps here are silent. Neither raises an error; both produce numbers that look like a verdict.

**Batch size is 1.** Batching pads each text to the longest in its batch, and padding changes the
vector: bge-m3 gives cosine 0.986 between the same string alone and batched. Competing notes sit
~0.001 apart, so that shift does not perturb a ranking, it decides it. It showed up as two rebuilds
of byte-identical notes scoring differently
([model choice](decisions/2026-08-15-model-choice.md), "Batch size and padding"). Check with
`--check-embedding` before you touch it.

**Wrong pooling looks like a bad model.** bge-m3 is trained for CLS pooling. Mean-pooled, it scored
25.0% @5 on the real-vault EN set; CLS-pooled, 67.9%
([model choice](decisions/2026-08-15-model-choice.md), "Why bge-m3 was almost disqualified"). The
mean-pooled rankings were confident, plausible and wrong. The synthetic EN paraphrase set exists to
trip on exactly this ([synthetic baseline](decisions/2026-08-15-synth-vault-baseline.md)).

## Why model profiles do not transfer

A profile in `scripts/lib/models.mjs` holds `dim`, `maxChars`, the query and document prefixes, the
pooling, and the `dupeMin`/`clusterMin` thresholds. **None of them carries over to another model.**

- Pooling: above.
- Prefixes: `e5-multi` needs `query: ` / `passage: `; bge-m3 needs none. A wrong prefix is another
  silent shift.
- Chunk length: bge-m3 was once judged "too slow" because only its profile carried 4000 characters
  where the others had 1800 ([model choice](decisions/2026-08-15-model-choice.md)).
- Thresholds: bge-m3's similarities sit low and wide, e5-multi's high and narrow. e5-multi's
  `dupeMin` 0.95, copied across, found 0 of 16 known duplicates (same record, "duplicate-threshold
  calibration").

The fusion weight is per-setup too. Re-sweep it after a model change. Indexes are keyed per model
(`db/semantic-<slug>-<model>.db`), so comparing two models costs an eval run, not a rebuild each way.

## The duplicate predicate

"Are these two notes the same lesson?" has one answer, used by both callers: `dupeScore()` /
`bestDupe()` — raw cosine between card chunks of the same layer, `>= PROFILE.dupeMin`. The
distiller asks it before writing a new insight; `--dupes` asks it in an audit. One predicate is the
point: an audit that defines duplicates differently from the writer cannot check the writer. The
word-overlap arm it replaced caught 0 of 25 real duplicates on the 447-note Insights corpus
([embedding reconcile](decisions/2026-08-23-embedding-reconcile.md)).

This is not the query score. A query result is RRF-fused and is 0 for a keyword-only hit, so gating
it at `dupeMin` would be wrong in silence.

`reconcile: manual` in a note's frontmatter blocks both paths from folding anything into that note.
It exists because cross-linking two distinct notes raises their similarity, so relating them
correctly can push them over the bar.

## The serve architecture

Loading the model and an index takes seconds, too slow for a per-prompt hook. So one `--serve`
process holds the model and answers over a socket.

- **One server per machine, keyed by model.** The project slug is a field in each request, and
  indexes load on demand and stay cached. One process per project would mean one ~1.3 GB model per
  indexed repo.
- **Three memory bounds**, each covering what the others cannot:
  - `enableCpuMemArena: false` — onnxruntime's arena grows to the largest input it has seen and
    never shrinks. This is the only bound that survives one bad input.
  - `embed()` clamps to `MAX_CHARS` — documents were chunked, queries were not. Attention cost grows
    with the square of length, so an unclamped long query could ask for gigabytes.
  - Two idle timers, for two costs — `modelIdleMs` (5 min) unloads the model and keeps the cheap
    process; `serveIdleMs` (30 min) ends the process.

The hook never waits on the server. On a miss it spawns one for next time and falls back to BM25.
Redundant spawns probe the socket and exit. Numbers and mechanics: architecture.md, Flow 3.

## How it is evaluated

`scripts/memory-eval.mjs` (`/memory:eval`) scores a case set — questions with a known gold note —
and reports recall@k and MRR. **The case set is fixed, and every retrieval change is scored on the
same file.** Writing fresh questions per run measures the questions: scores moved 0.60 → 1.00 while
the question set moved under them
([eval harness design](decisions/2026-08-24-eval-harness-design.md)).

- **Synthetic vaults** (`scripts/memory-synth-vault.mjs`) hold the notes still too, and their gold is
  known by construction. Real prose, invented names. The EN set is at its ceiling — a tripwire for
  breakage, not evidence of improvement; the NL set discriminates
  ([synthetic baseline](decisions/2026-08-15-synth-vault-baseline.md)).
- **Real-vault sets** are for small deltas. They hold private content, so they stay machine-local
  under `$CLAUDE_MEMORY_HOME/eval/`.
- **Kinds.** A `tuning` set may be fitted to; a `held-out` set may not, and a figure from one quotes
  its frozen sha256 instead of its questions. `--min-rank1` is the opt-in gate, and it fails closed
  on any case it cannot score ([eval gate](decisions/2026-09-04-eval-gate.md)).

## Open work

A graph arm beside vector and keyword, so the ontology can be traversed: #85.
