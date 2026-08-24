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

That is this vault, described by someone else.

**Corrected after reading the specification, same day.** The blog describes **v0.1**; the spec has
moved to **v0.2**, and the field list above is not what it says. Read from the verbatim spec at
`serradura/okf` → `gems/okf/lib/okf/skill/reference/SPEC.md`:

| OKF v0.2 §4.1 | Required? | This vault today |
| --- | --- | --- |
| `type` | **REQUIRED — the only one** | `metadata.type`, one level down |
| `title` | optional | the filename, which already equals `name:` |
| `description` | optional | `description:` — same field, same meaning |
| `resource` | optional | absent |
| `tags` | optional | absent |
| trust · lifecycle · provenance · attestation | optional families, new in v0.2 | `confidence`, per-claim supersession, `originSessionId` — the same ideas under other names |
| *"other producer-defined key/value pairs"* | — | **the whole `metadata:` block is already legal** |

So conformance is smaller than the first pass suggested: **promote one field and add two.** Nothing
has to be removed, because the spec explicitly admits producer-defined keys.

Three things the blog did not say, and they matter:

- **`index.md` and `log.md` are reserved filenames** at any level, for a directory listing and an
  update history. `MEMORY.md` is doing `index.md`'s job under a different name — and cannot simply be
  renamed, because Claude Code's auto-memory reads it at a fixed path.
- **A Link is "a standard markdown link from one concept to another."** This vault's protocol says
  `[[wikilinks]]`, never markdown links. OKF does not forbid wikilinks, but a conforming consumer
  parsing links per spec **will not see this vault's graph at all**. This is the one genuine conflict
  and it is not cosmetic — the note graph is the part with the most hand-work in it.
- **A Concept ID is the file path minus `.md`**, so the vault's "filename equals `name:`" rule already
  satisfies identity; the layer folders become path prefixes for free.

**Tooling exists and is Claude Code-native**, which means conformance can be measured rather than
argued: `scaccogatto/okf-skills` (MIT, 334 stars) ships a deterministic conformance checker, a graph
renderer and a GitHub Action, and is v0.2 throughout — it notes that everything in Google's community
list at `GoogleCloudPlatform/knowledge-catalog` was still v0.1 on 2026-07-27. `serradura/okf`
(Apache-2.0) is a Ruby CLI with `validate` and `lint` exit codes plus an MCP server.

**Why it is worth doing.** The gap that keeps recurring in this design is that the memory layer serves
Claude Code and nothing else, while four agents now run on this machine. OKF is the interchange format
for exactly that problem, and it is vendor-neutral rather than one vendor's API. An ecosystem already
exists: `scaccogatto/okf-skills` (334, an authoring and validation toolkit for Claude Code),
`serradura/okf` (135, Apache-2.0), `Sudhakaran88/okf-conformance` (16), `zosmaai/pi-llm-wiki` (525,
Obsidian-compatible).

**Measured, same day, so nobody re-runs it.** `Sudhakaran88/okf-conformance` — Node, zero
dependencies, aligned to v0.2 and green against Google's four published reference bundles — over
`Memory/<slug>/`, 17 notes. Use `--json`: it otherwise writes `okf-report.json` *into the bundle*.

```
concepts 17 · links 16 · errors 17 · warnings 2 · conformant: false
  16  M3  missing required `type`
   1  M2  missing YAML frontmatter block
   1  S1  no root index.md
   1  S3  internal link does not resolve
```

**The wikilink question is answered, and the answer is total.** Those same 17 notes hold **48
wikilinks and 19 markdown links; the validator counted 16.** It sees markdown links only, so a
conforming consumer gets every document and **none of the graph**.

That reframes the cost. The interop goal was documents readable by four agents, which top-level
`type` alone buys. The edges were never what the other agents needed: recall here is semantic + BM25
over note *text*, and the graph's real consumers are Obsidian and this repo's own link lint, both of
which read wikilinks natively. Treating the wikilink graph as a producer-defined extension is
therefore the cheap and honest reading — not a compromise.

Two findings point at `MEMORY.md` (M2 and S1) and **neither is fixable**: Claude Code's auto-memory
pins both its path and its frontmatter-free shape. Accept them.

The S3 warning was a **real bug, unrelated to OKF** — a markdown link in the vault climbing four
levels out of it into the checkout. Fixed on sight.

**Deferred** (owner, 2026-08-24): conformance is not being done now. What it costs is measured and
recorded above; `Insights/`, `permanent/` and `Logs/` remain unvalidated.

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
