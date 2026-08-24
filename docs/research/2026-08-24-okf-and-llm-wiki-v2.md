# The Open Knowledge Format, LLM Wiki v2, and agentmemory

**Read 2026-08-24.** Three sources, one conclusion: the format this project already writes has become a
published standard, and the design it already follows has been written up independently by someone
else who then built it.

- https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/
- https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2 ("LLM Wiki v2", 1.6k stars)
- https://github.com/rohitg00/agentmemory (Apache-2.0, 27,350 stars, created 2026-02-25, active)

## OKF — the vault format is now a spec

Google Cloud announced the **Open Knowledge Format** on 2026-06-12. v0.1, quoting the announcement:

> a directory of markdown files with YAML frontmatter, with a small set of agreed-upon conventions
> that let wikis written by different producers be consumed by different agents without translation

> Just markdown … Just files … Just YAML frontmatter — for the small set of structured fields that
> need to be queryable: `type`, `title`, `description`, `resource`, `tags`, and `timestamp`

That is this vault, described by someone else. **Conformance is a frontmatter mapping, not a
migration:**

| OKF v0.1 | This vault today |
| --- | --- |
| `title` | the filename, which already equals `name:` |
| `description` | `description:` — same field, same meaning |
| `type` | `metadata.type` — `user` / `feedback` / `project` / `reference` |
| `timestamp` | `metadata.modified` |
| `tags` | **absent** |
| `resource` | **absent** |

Two missing fields and a rename. Nothing about the note protocol, the layers, or `permanent/` has to
change.

**Why it is worth doing.** The gap that keeps recurring in this design is that the memory layer serves
Claude Code and nothing else, while four agents now run on this machine. OKF is the interchange format
for exactly that problem, and it is vendor-neutral rather than one vendor's API. An ecosystem already
exists: `scaccogatto/okf-skills` (334, an authoring and validation toolkit for Claude Code),
`serradura/okf` (135, Apache-2.0), `Sudhakaran88/okf-conformance` (16), `zosmaai/pi-llm-wiki` (525,
Obsidian-compatible).

**Not verified:** the field list above is quoted from the announcement, not from the specification
itself. Read the spec before mapping frontmatter.

## LLM Wiki v2 — independent arrival at this protocol, plus four things missing

The gist extends Karpathy's LLM Wiki. Several of its recommendations are already shipped here, which
is worth recording because it means the design was not idiosyncratic:

| The gist says | This repo already has |
| --- | --- |
| "Every fact should carry a confidence score" | `confidence: high \| medium \| low` in frontmatter |
| "The new claim should explicitly supersede it. Linked, timestamped, old version preserved but marked stale" | per-claim supersession, `(measured X, superseded Y by [[note]])` |
| Consolidation tiers: working → episodic → semantic → procedural | L1 facts, L2 logs, L3 insights, `permanent/` |
| "**The schema document (CLAUDE.md) is the most important file in the system**" | CLAUDE.md plus `/memory:protocol` |
| Hooks for auto-ingest and context injection | SessionStart, UserPromptSubmit recall, SessionEnd distiller |

**Four things it names that this repo does not do.** These are the useful part of the source:

1. **Forgetting.** "A wiki that never forgets becomes noisy." It proposes an Ebbinghaus retention
   curve — decay exponential with time, reset on each access or reinforcement, with the rate set per
   kind: architecture decisions decay slowly, transient bugs fast. **Here, notes live forever.**
   `logs/` has a retention policy; the vault has none.
2. **Typed relationships.** `[[wikilinks]]` are untyped. The gist wants `supersedes`, `contradicts`,
   `caused-by`, `depends-on`, so a query can traverse rather than keyword-match. This repo has already
   considered it — see the vault note on bounding the ontology to a small fixed set.
3. **Contradiction resolution, not just flagging.** "Step two is resolving them" — propose which claim
   wins on source recency, authority and supporting count, with a human override.
4. **Self-healing lint.** "The lint should automatically fix what it can." This repo deliberately does
   the opposite: the link lint names orphans and trims nothing, on the grounds that reporting is the
   bound. That was a decision, not an oversight — but the gist is the counter-argument, and it should
   be answered rather than ignored.

Its **implementation spectrum** is a sensible ordering if any of this is picked up: minimal wiki →
lifecycle → structure → automation → scale → collaboration.

## agentmemory — prior art, not a candidate

Apache-2.0, 27,350 stars, TypeScript, built on the `iii` engine. `npx -y @agentmemory/agentmemory`
wires 20 agent adapters (Claude Code, Cursor, Codex, Gemini CLI, OpenCode …), serves REST and MCP on
`:3111`, and ships a viewer on `:3113` and 17 skills.

Relevant details:

- **Keyless by default**, in which case recall is BM25 only. `EMBEDDING_PROVIDER=local` downloads
  `Xenova/all-MiniLM-L6-v2` and runs on device.
- Claims 95.2% R@5 and 92% fewer tokens. **Self-reported**, unlike Hindsight's LongMemEval standing,
  which was independently reproduced.
- MiniLM-L6-v2 is a much smaller model than the bge-m3 this repo settled on after measuring; this
  project's own evidence is that model and pooling choice moves recall by tens of points and fails
  silently when wrong.

It is the same category as Hindsight and weaker on the one axis — evidence — that this repo insists
on. Worth reading, not worth adopting.

## What follows

- **OKF conformance is the cheap, high-value move.** Two frontmatter fields and a rename buy a
  vendor-neutral contract with every other agent on the machine.
- **The four gaps from the gist are a real backlog** for the memory layer, in its order: decay first
  (it is the one nothing else compensates for), then typed relations.
- **"Be the memory layer" survives, with a correction.** The bet looked weak when Hindsight and
  agentmemory turned out to exist. OKF changes the shape of it: being a *conforming producer of a
  standard format* is a stronger position than being one vendor's plugin, and it is the position this
  vault is already in by accident.
