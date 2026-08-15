---
name: protocol
description: Use when writing, editing, promoting, or auditing a note in the memory vault — the conventions for frontmatter, confidence, per-claim recency and supersession, retrievability aliases, wikilink discipline, and how knowledge graduates from a project note to permanent/. Also use when deciding whether something is worth remembering at all.
---

# Memory protocol

Notes are written for a future agent to retrieve and reason over, not for a human to read as
an essay. Machine-readable structure, source URLs kept verbatim, stated confidence rather than
hedged prose.

## The layers

| Layer | Where | Holds |
| --- | --- | --- |
| L1 facts | `Memory/<slug>/` + its `MEMORY.md` MOC | atomic facts, feedback, project decisions |
| L2 logs | `Logs/<slug>/` | timestamped session summaries (`/memory:save`) |
| L3 lessons | `Insights/<slug>/{Patterns,Mistakes,Decisions}/` | auto-distilled once per session |
| L4 graph | `Graph/<slug>/GRAPH_REPORT.md` | codebase graph digest |
| global | `permanent/{domain,tools}/` | cross-project consolidated notes |

`<slug>` is the **project key** — the normalised git remote, not the checkout path. Get it with
`. "$MEM/hooks/lib/vault-env.sh"; project_key "$PWD"`. Deriving it from `pwd` forks a second
memory for the same repo: another machine, a worktree, or `cd`-ing into a subdirectory each get
their own orphaned folder.

## What is worth writing down

Not what the repo already records. Code structure, past fixes, git history, and CLAUDE.md are
already retrievable — a note that restates them is noise that outranks something useful. Write
down what is **not derivable from the code**: decisions and their reasons, constraints, things
that were tried and failed, and corrections the user made to how you work.

If asked to remember something the repo already holds, ask what was non-obvious about it and
save that instead.

## Every note

- **kebab-case filename, and the filename MUST equal the `name:` frontmatter** so `[[name]]`
  resolves. No type prefixes.
- **Names are unique across the WHOLE vault, not just the folder.** The semantic index keys by
  filename stem, so two notes with the same name merge into one entry and every wikilink to
  them is ambiguous. It reads as full coverage while holding one note fewer.
- **YAML-safe frontmatter**: quote any value containing a `:` —
  `title: "Layered debugging: expose each bug in isolation"`. An unquoted colon silently breaks
  the whole frontmatter block.
- `confidence: high | medium | low` on facts and decisions, so an audit can pick a winner when
  two notes conflict. Omit only for the self-evident.
- **`[[wikilinks]]`, never markdown links** for internal notes. One concept per permanent note,
  linked densely (≥2 wikilinks).
- **Never delete a note without asking.**

## Link it in, both ways, at write time

A new L1 note must be added to `MEMORY.md` **and** linked with a `[[wikilink]]` from at least one
existing sibling it relates to. MOC-only notes are reachable but invisible to the note graph.

Ask: *"which existing note would someone be reading when they need this one?"* — and link from
there. This is write-time discipline, not cleanup: audits have flagged the same failure
repeatedly, which means doing it afterwards does not happen.

## Per-claim recency: timeless, snapshot, or pointer

There is no fourth form, and the illegal one is a present-tense claim about something that moves
with no date — *the sentence that becomes a lie next Tuesday while still reading as truth.*

- **Timeless** — does not decay, needs no date. "Boundary rules are enforced by ESLint."
- **Snapshot** — a dated observation, which never goes stale because it claims what was true
  *then*: `501 projects (as of 2026-08-08)`. Anything under a dated heading is already a snapshot.
- **Pointer** — for facts whose *current* value matters, store **where the truth lives**, not the
  value: `**Where truth lives:** the MR widget · last observed: 39,385 events/30d (as of 2026-08-10)`.
  A pointer ages gracefully; a bare number does not.

Convert relative dates to absolute, always.

## Per-claim supersession: two dates, not one

A fact has a date it was *true* and a date the vault *learned it changed*. Mark it where the claim
lives, inline:

```
(measured 2026-08-12, superseded 2026-08-14 by [[the-event-note]])
```

Not note-level frontmatter — L1 notes are large and multi-claim, so a note-level `superseded_by:`
kills sections that are still true. Reserve that for a wholly dead note. Writing "⚠ SUPERSEDED" in
prose alone is invisible to every mechanical check.

**Writing down an event? Name what it kills.** A note recording something *happening* — a cutover,
a migration, a decommission, a launch — usually reverses a standing claim in an older note ("X has
never served traffic", "not yet enabled", "no Y exists"). Before saving, ask *"which existing fact
does this event invalidate?"*, annotate that note as superseded, and link back from the event note
so the reversal is reachable from both ends. No lint can know which event kills which claim;
`scripts/memory-audit-checks.mjs` lists the standing-negative claims, which narrows where to look.

## Retrievability: aliases are not optional

Give durable notes 2–3 paraphrase aliases as a trailing line:

```
_Also asked as: how long was the site down · what was the cutover outage window · downtime during the migration_
```

The lexical arm is keyword-only, so aliases are the bridge for paraphrased queries. The distiller
requires them on every Insight note; hand-written notes need them just as much.

## Writing repo paths

**From the repo root, never abbreviated to a trailing segment** —
`docs/devops/cra2-migration/scripts/foo.sh`, not `scripts/foo.sh`. A suffix looks like a path and
resolves to nothing. This has recurred across audits on the same script in different notes.

## No retrieval number without a case-set run behind it

Any recall/MRR figure written into a note, a README, or a commit message must come from
`memory-eval.mjs --run` against a **versioned** case set, and must name which set. Questions
rewritten per run measure the questions, not the retrieval: hand-written sets once produced
"0.94 / 1.00" while the versioned set measured **0.46**, and the inflated figure reached five
artefacts including a public README before anything caught it.

If there is no case set, write "unmeasured" — not a number.

## Private content

Wrap secrets or sensitive text in `<private>…</private>`. The distiller redacts these blocks
before extraction, so they never reach `Insights/`.

## Knowledge lifecycle: graduate, don't scatter

Fighting the "same fix needed in 20 places, drifts each time" problem:

1. **Staging** — a lesson lands per-project in `Memory/<slug>/`, or is auto-distilled into
   `Insights/<slug>/`.
2. **Promotion** — once cross-project or stable, consolidate into `permanent/{domain,tools}/` as
   one authoritative note. **Then DELETE the project note.** Do not leave a stub: wikilinks
   resolve vault-wide, so a local pointer buys nothing and duplicate names break the index. Fold
   any project-specific caveat into the surviving note first — that caveat is usually the only
   reason the stub felt necessary.
3. **Skill/pointer** — when a domain is mature enough to package as a skill or plugin, move the
   content there and reduce the note to a one-line pointer, so there is a single source of truth.
   Record needed changes in the pointer so an issue can be filed against the skill.
