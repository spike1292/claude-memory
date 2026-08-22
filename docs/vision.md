# Vision

What this project is for, who it is for, what it refuses to be, the principles that govern it, and
where it is heading.

**Sections 1 to 4 describe what is true today**, and every claim in them cites a primary source;
where a statement is an **inference** drawn from repeated decisions rather than something the repo
states outright, it is labelled `[inferred]`. **Section 5 is the exception**: it states intent that
does not exist yet. Nothing there should be read as shipped.

**This is a guide, not a dated record.** It is edited in place as intent changes — unlike
`docs/decisions/` (superseded, never edited), `docs/plans/` (deleted once shipped) and
`docs/research/` (left as written). See [README.md](README.md) for the conventions those three
follow.

---

## 1. Stated vision and goals

### The problem it exists to solve

> "Claude Code has auto memory, and it reads `~/.claude/projects/<project>/memory/MEMORY.md`. This
> plugin fills that file well and adds every layer above it: per-project facts, session logs, lessons
> distilled automatically from what actually happened, a codebase graph, and hybrid semantic +
> lexical retrieval so a question phrased differently from the note still finds it."
> — [README.md, opening](../README.md)

The problem underneath has not changed: a session ends and everything learned in it is gone. What
changed is where the answer lives — Claude Code now carries a memory of its own, so this is no longer
a memory system standing alone.

### It is an extension of Claude Code's own memory, not a rival to it

Claude Code has auto memory of its own, and it reads `~/.claude/projects/<project>/memory/MEMORY.md`
— **the exact path this plugin symlinks into the vault**. That is live, not hypothetical: measured on
one machine, 23 of 24 project memory directories are symlinks into the vault, `autoMemoryDirectory`
is unset so the default path applies, and sessions show the vault's `MEMORY.md` injected and labelled
as the user's auto memory ([#75](https://github.com/spike1292/claude-memory/issues/75), measured
2026-08-21 and re-verified 2026-08-22).

The position is therefore **co-operate, deliberately**: Claude Code owns `MEMORY.md` and the
per-prompt slot, and this plugin's job is to fill that slot well and to add every layer above it —
session logs, distilled lessons, the codebase graph, hybrid retrieval, and an Obsidian vault a human
can actually read. Two consequences follow and are not optional. `MEMORY.md` must be bounded at or
under the 25 KB Claude Code loads, and crossing that bound must be **reported**, never silent.

One conflict is inherited and unresolved: Claude Code's auto memory is documented as machine-local
and not shared across machines, while the vault is explicitly synced across machines. That is
recorded rather than papered over — [#75](https://github.com/spike1292/claude-memory/issues/75).

### Who it is for

Software engineers working in a codebase with Claude Code. That is the shape of everything here: the
layers are keyed to a project, identity is the git remote, one whole layer is a codebase graph, and
what is worth writing down is defined against what the repo already records.

### Where it came from, and why it is a plugin

The system is older than this repository. It grew inside `~/.claude`, a personal Claude Code config
repo, from 2026-07-02 through twelve phases, and moved out on 2026-08-15 in a single commit. The
first commit here is the design that authorised the move
(`git show 4d1fb12:docs/superpowers/specs/2026-08-15-claude-memory-plugin-design.md`; the file was
deleted in `a6ea614` once implemented, and the git history is its only home).

That spec names three costs of the coupling, and they are why the plugin exists at all:

1. **Not installable** — anyone wanting it, "including future-Henk on a second machine", had to
   clone a personal config repo and hand-merge nine hook registrations into their own settings.
2. **Not isolated** — every intra-system reference was an absolute `$HOME/.claude/...` path, at 15
   call sites. "Nothing self-locates, so the code cannot run anywhere else." That is the origin of
   the standing rule that nothing resolves an absolute install path.
3. **Personal data entangled with shareable code** — a hard-coded vault path in the shell resolver,
   and eval case sets carrying internal project note names. That is the origin of §2's first row.

The extraction also forced a fix that had nothing to do with sharing: 722 MB of ONNX weights sat
inside `node_modules`, which in a version-pinned plugin cache would be re-downloaded on every
update. It is why all mutable state now lives in `$CLAUDE_MEMORY_HOME/`.

The spec's stated outcome is the shape the project still has: one command installs the whole system,
`~/.claude` "shrinks back to being config", and every existing `/memory:*` invocation and note
reference keeps working.

### The goals it states

1. **Continuity across sessions.** Five SessionStart hooks, one UserPromptSubmit hook, one PostToolUse validator,
   and the distiller on both `Stop` and `SessionEnd` — [hooks/hooks.json](../hooks/hooks.json),
   [README.md "What it does"](../README.md#what-it-does).
2. **Retrieval that survives paraphrase.** A vector arm and a BM25 arm, rank-fused, "which is why
   it answers both 'how long was the site down' and `WAF`" — [README.md "Retrieval"](../README.md#retrieval).
   The measured gap is the argument: on the same 28-case English set, hybrid scores 0.821 @5 against
   keyword-only at 0.250.
3. **Local-only operation.** "The embedding model runs locally via ONNX — **notes are never sent
   anywhere.**" — [README.md, opening](../README.md). `[inferred]` This is a constraint, not a
   preference: the vault is the private half of the design (§2, first row), which disqualifies every
   hosted embedder rather than merely disfavouring one. Nothing on the retrieval path makes a
   network call, and the optional integrations are held off it
   — [README.md "Optional integrations"](../README.md#optional-integrations).
4. **Notes written for an agent to retrieve, not a human to read.** "Machine-readable structure,
   source URLs kept verbatim, stated confidence rather than hedged prose."
   — [skills/protocol/SKILL.md, opening](../skills/protocol/SKILL.md).
5. **Memory exists to change what happens next, not to archive what happened.** Three mechanisms
   serve this today: the SessionStart hook surfaces recent `Mistakes/` titles before similar work,
   `/memory:challenge` makes the vault argue *against* a decision before it is made, and recall
   injects a bounded brief. `/memory:challenge` was justified by this vault's own record — lessons
   recorded after the fact had not stopped them recurring
   — [README.md "What it does"](../README.md#what-it-does),
   [README.md "Commands"](../README.md#commands). The stronger form of this goal is not built; it is
   §5.A.

### The knowledge model

Five layers, each with a distinct job — L1 facts, L2 logs, L3 auto-distilled lessons, L4 codebase
graph, and cross-project `permanent/` — [skills/protocol/SKILL.md "The layers"](../skills/protocol/SKILL.md#the-layers),
[README.md "Layout"](../README.md#layout).

Project identity is the **normalised git remote**, not the checkout path, "so the same project maps
to one memory folder on every machine and from every checkout"
— [README.md "How project identity works"](../README.md#how-project-identity-works).

What is worth storing is scoped deliberately: "Not what the repo already records. Code structure,
past fixes, git history, and CLAUDE.md are already retrievable… Write down what is **not derivable
from the code**" — [skills/protocol/SKILL.md "What is worth writing down"](../skills/protocol/SKILL.md#what-is-worth-writing-down).

---

## 2. What it deliberately refuses to be

Each of these is stated, not inferred.

| Refusal | Source |
| --- | --- |
| **Not a home for your notes.** "This is the engine. Your vault is not in it and must never be." Notes carry colleague names, account IDs, hostnames. Eval case sets too, because they are generated *from* the vault. | [README.md "Sharing"](../README.md#sharing), [CLAUDE.md](../CLAUDE.md), [docs/architecture.md "What this is"](architecture.md#what-this-is) |
| **Not a shared vault, and never a server.** "Multi-user or team vault sharing" is a stated non-goal, and nothing here syncs between people. Team knowledge travels a different way: "check the facts into the *project's own* repo under `docs/`… Personal vault, shared project docs." Today that advice is manual; §5.C makes it a mechanism, and it still never shares the vault. | [README.md "Sharing"](../README.md#sharing), and the design spec's non-goals (`git show 4d1fb12:docs/superpowers/specs/2026-08-15-claude-memory-plugin-design.md`) |
| **Not on by default in your prompts.** "Per-prompt recall ships inert on purpose. Injecting retrieved notes into every prompt changes how every session reads; that should be your decision, not a default." | [README.md "Configuration"](../README.md#configuration) |
| **Not a blocker.** "Hooks are best-effort and must never block." `validate-note` "warns; it never blocks." | [CLAUDE.md](../CLAUDE.md), [README.md "While you work"](../README.md#while-you-work) |
| **Not a guesser.** Recall "abstains when nothing scores well enough — silence is the default, not a guess." | [README.md "While you work"](../README.md#while-you-work) |
| **Not a database.** Plain Markdown on disk is the source of truth; the index is a derived cache. | [README.md, opening](../README.md), [docs/architecture.md](architecture.md) (the three homes) |
| **No Python.** Ported out 2026-08-16; CI fails if a `.py` file or a shell script calling `python` reappears. The reason is stated as one runtime fewer to be the wrong version. | [README.md "Requirements"](../README.md#requirements), [docs/architecture.md "Invariants"](architecture.md#invariants-and-who-actually-enforces-them) |
| **No Bun.** Blocked on `node:sqlite`, not on native deps; evaluated with numbers. | [docs/decisions/2026-08-17-bun.md](decisions/2026-08-17-bun.md), [README.md "Development"](../README.md#development) |
| **No build step.** "The deliverables are the files." Types are JSDoc checked by `tsc --noEmit`. | [docs/architecture.md "What this is"](architecture.md#what-this-is), [CLAUDE.md](../CLAUDE.md) |
| **No Windows.** bash and POSIX paths throughout. | [README.md "Known gaps"](../README.md#known-gaps) |
| **No linter, absent new numbers.** Two of three candidate rules were already covered free. | [docs/decisions/2026-08-20-types-and-linting.md](decisions/2026-08-20-types-and-linting.md) |
| **Not an agentic OS, but the layer one is built on.** A "Claude Code plus Obsidian OS" is three layers — a visual wrapper, a skill and automation backbone, and a memory layer. This is the third, and it commits to being a good one: plain Markdown anyone can read, a documented layer model, and a vault that can be queried. The wrapper and the automations belong to whoever builds them. Growing into the other two would reopen the same judgement that turned down a 46-command personal-knowledge toolkit: "different product, not a missing feature." | [docs/research/2026-08-21-obsidian-second-brain.md](research/2026-08-21-obsidian-second-brain.md), [README.md "Commands"](../README.md#commands) |
| **No required third-party services.** `context-mode` and `codebase-memory-mcp` are optional, not installed by the plugin, and not on the retrieval path. | [README.md "Optional integrations"](../README.md#optional-integrations), [docs/optional-integrations.md](optional-integrations.md) |
| **Docs are not work queues.** A research note "is **not** a work queue"; the ponytail audit is "a record and not a queue: do not add items here." | [docs/README.md "Research notes"](README.md#research-notes), [docs/2026-08-19-ponytail-audit.md, opening](2026-08-19-ponytail-audit.md) |

---

## 3. Principles

Some are stated as rules; others I have inferred from a pattern of decisions. Both are marked.

### Stated

- **No retrieval number ships without a case-set run behind it.** "Questions rewritten per run
  measure the questions, not the retrieval" — and this is not hypothetical: hand-written sets once
  produced "0.94 / 1.00" where the versioned set measured **0.46**, "and the inflated figure reached
  five artefacts including a public README before anything caught it."
  — [skills/protocol/SKILL.md "No retrieval number without a case-set run behind it"](../skills/protocol/SKILL.md#no-retrieval-number-without-a-case-set-run-behind-it), [README.md "Retrieval"](../README.md#retrieval),
  [CLAUDE.md](../CLAUDE.md). Corroborated in the vault by the L3 decision note *"Every retrieval
  number must have a case-set run behind it"* and the patterns *"Case-set measurements must reuse
  existing questions"* and *"Verify the instrument before quoting a metric"*.
- **Every measurement names its conditions.** A hook timing is meaningless without saying whether
  the vault was cloud-backed or local — 166 ms vs 131 ms on that difference alone.
  — [docs/README.md "Conventions for these documents"](README.md#conventions-for-these-documents), [CLAUDE.md](../CLAUDE.md). Vault pattern note: *"State
  measurement conditions with the numbers."*
- **Record what was tried and rejected, with the numbers**, so nobody re-derives it. The Bun record
  exists for exactly this. — [docs/README.md "Conventions for these documents"](README.md#conventions-for-these-documents)
- **A decision record is a snapshot.** When the answer changes, add a new dated record and link
  back rather than edit history. The repo practises this: 2026-08-18-node-hooks explicitly
  supersedes 2026-08-17-shell-vs-node-hooks, and both remain indexed.
  — [docs/README.md "Decision records"](README.md#decision-records)
- **Estimates are never printed like measurements.** Cost fields are "optional and omitted, never
  zero"; injected-context tokens are labelled estimates (`bytes / 4`), while the distiller's
  dollars come from `--output-format json`. — [CLAUDE.md](../CLAUDE.md), [CHANGELOG.md](../CHANGELOG.md)
- **A rule nobody enforces is a rule that drifts.** The invariants table's middle column is "the
  point", and it exists "because a comment once claimed a CI check that did not exist."
  — [docs/architecture.md "Invariants"](architecture.md#invariants-and-who-actually-enforces-them)
- **Document the gap between design and code.** `architecture.md` Part 2 exists "because the gap is
  not documented anywhere else, and every entry in it has already cost something or is positioned
  to." — [docs/architecture.md, opening](architecture.md)
- **A review loop ends on a clean round, not a fixed count.** Five of thirteen rounds found a defect
  introduced by the previous round's fix.
  — [docs/decisions/2026-08-19-orchestrated-change.md](decisions/2026-08-19-orchestrated-change.md),
  [CLAUDE.md](../CLAUDE.md). Vault L1 fact: *"Test the round trip, not each half."*
- **A known defect gets a fix, or a code comment and a test — never a bullet in the PR body**,
  because "a PR body is the one artefact nobody re-reads after merge."
  — [docs/decisions/2026-08-19-orchestrated-change.md](decisions/2026-08-19-orchestrated-change.md)
- **State precisely what degrades.** An earlier warning claimed the vault "stops being searchable"
  without `context-mode`, "which was never true." — [CLAUDE.md](../CLAUDE.md)
- **Simplicity outranks capability.** The ponytail audit cut 683 lines across 17 files, and the one
  declined item is kept with its reason "so it is not rediscovered as a good idea."
  — [docs/2026-08-19-ponytail-audit.md](2026-08-19-ponytail-audit.md)

- **The Markdown is the source of truth; every index is a derived cache.** Four behaviours rest on
  it: indexes live in `$CLAUDE_MEMORY_HOME/db/` and never in the plugin, `--rebuild` exists and a
  model change forces one, `/memory:prune` purges and rebuilds where a plain re-index cannot, and an
  index keyed to another model is refused rather than migrated. A vault that loses its index loses
  nothing; a vault that loses its notes has lost everything. Nothing enforces it, which is why it is
  in the invariants table marked as convention.
  — [docs/architecture.md "Invariants"](architecture.md#invariants-and-who-actually-enforces-them),
  [README.md "Troubleshooting"](../README.md#troubleshooting)

### Inferred from repeated decisions

- `[inferred]` **Silent failure is the enemy, and the design is organised against it.** The same
  shape recurs across otherwise unrelated decisions: stub-don't-delete so a wrong backend throws
  loudly instead of falling back to WASM; `/memory:doctor` hard-fails on an empty-but-readable vault
  rather than passing an "is the directory there?" check; the Python distiller's death on macOS 3.9
  was silent and is cited as the reason Python is gone; `findClaude()` on Linux no-opped
  indistinguishably from having nothing to do. — [CLAUDE.md](../CLAUDE.md),
  [README.md "Requirements"](../README.md#requirements), [README.md "Configuration"](../README.md#configuration), [CHANGELOG.md](../CHANGELOG.md)
- `[inferred]` **Cost is a first-class design constraint, not an afterthought.** Three separate
  memory bounds on the `--serve` process, a hook-startup-cost decision record, `bench-hooks.mjs` as
  the only sanctioned timing instrument, and an open issue measuring the recall brief's byte cost
  all point the same way. — [CLAUDE.md](../CLAUDE.md),
  [docs/decisions/2026-08-20-hook-startup-cost.md](decisions/2026-08-20-hook-startup-cost.md),
  [#72](https://github.com/spike1292/claude-memory/issues/72)
- `[inferred]` **Single implementation, no mirrors.** Resolution in one module, one JSONL appender,
  one model default, timeouts only in `hooks.json`, one lock. Each is justified separately by the
  same failure mode: two copies drift in silence. — [CLAUDE.md](../CLAUDE.md),
  [docs/decisions/2026-08-18-single-resolver.md](decisions/2026-08-18-single-resolver.md)
- `[inferred]` **The engine/content boundary is the project's central privacy stance**, and it is
  enforced socially rather than mechanically — by the Sharing section, the gitignore on eval sets,
  and review habit. The vault itself corroborates this as a live risk: an L3 mistake note records
  vault note paths leaking into a report, and a pattern note covers sanitising vault content for
  user-facing output. — [README.md "Sharing"](../README.md#sharing), [CLAUDE.md](../CLAUDE.md)

---

## 4. Known gaps and admitted weaknesses

**The README publishes its own list of what this does badly** — unbounded `MEMORY.md`, no note
expiry, small self-authored eval sets, a benchmark at its ceiling, opt-in redaction, unrun promotion
to `permanent/`, no Windows. That the list is in the front-page README rather than buried is itself
part of the vision. It is not restated here: read it at
[README.md "Known gaps"](../README.md#known-gaps), which stays the one copy.

What follows is the gaps that list does not carry.

- **Prompt injection is an open, live exposure.** A fetched page in a transcript can become an L3
  note with no human in the loop and be replayed into a later prompt; grepping the repo for
  `prompt injection|untrusted|never instructions` "currently returns nothing."
  — [#67](https://github.com/spike1292/claude-memory/issues/67),
  [#70](https://github.com/spike1292/claude-memory/issues/70)
- **`MEMORY.md` truncation is a two-writer problem, not only a growth problem.** Claude Code loads
  the first 200 lines or 25 KB of it; a measured work-repo index sits at 88% of that cap, and
  crossing it truncates L1 silently. The README's version of this gap is unbounded growth; the
  silent-correctness half is newer. — [#75](https://github.com/spike1292/claude-memory/issues/75)
- **Structural invariants are only partly enforced.** The entry/`lib` rule "holds in 12 of 16", and
  the CI check verifies a twin *exists*, not that the entry delegates to it.
  — [docs/architecture.md "Invariants"](architecture.md#invariants-and-who-actually-enforces-them)
- **Green tests that verify nothing** were found across eight review rounds; mutation testing of the
  guards is not done. — [#64](https://github.com/spike1292/claude-memory/issues/64)
- **The comparison page does not exist yet**, and when written must "name where this loses. Real
  ones: 722 MB of model weights, Node-only, macOS-shaped assumptions, cloud-sync conflicts, and a
  single-machine serve process. A comparison page that only wins is marketing."
  — [#42](https://github.com/spike1292/claude-memory/issues/42)

Each of those cites the issue that evidences it, not as a work list — the queue is GitHub — but
because a stated gap with no source is the thing this file exists to avoid.

### Contested / superseded

- **Shell vs Node in hooks.** [2026-08-17-shell-vs-node-hooks.md](decisions/2026-08-17-shell-vs-node-hooks.md)
  established a "do not port" list; [2026-08-18-node-hooks.md](decisions/2026-08-18-node-hooks.md)
  supersedes it — "the floors were right; they were quoted about hooks that never ran at them."
  One fence survives: `vault-memory-sync.sh` stays in shell, and CLAUDE.md notes the *reason* has
  itself shifted (risk, not language — the missing characterisation test now exists).
- **Two resolvers → one.** [2026-08-18-single-resolver.md](decisions/2026-08-18-single-resolver.md)
  retires the earlier "change one, check the other" rule.
- **Does `MEMORY.md` truncation matter enough to bound it?** The README lists unbounded growth as a
  known gap and leaves it; [#75](https://github.com/spike1292/claude-memory/issues/75) argues it is
  now a silent correctness failure and forces a co-operate-or-separate decision. Unresolved.

---

## 5. Where it is heading

**Nothing in this section exists yet.** Sections 1 to 4 describe the system; this one states intent,
and is the one place in the file where a claim is not a description. Individual issues carry the
work — this is not that queue, and it names no issue numbers, because a document that enumerates
open work is wrong the day one closes. The same shape is already banned for research notes and for
the ponytail audit ("a record and not a queue: do not add items here").

There are **no open plans, and `docs/plans/` is deliberately empty** — a plan is deleted once its
steps ship, and one that outlives its execution is rewritten as a decision record
([docs/README.md "Plans"](README.md#plans)).

### A. Three self-improvement loops

The system should get better at three levels, and they are separate work.

**A1 — it improves the engineer.** The strong form of goal 5: read what is about to be done and
return the past failures that match it, before the work starts, not after it fails. Today the vault
answers questions asked of it; this asks the question for you. Everything needed is already written
down — `Insights/Mistakes/` is the corpus and the retrieval stack is the mechanism — and nothing
joins the two to a plan in progress.

**A2 — it improves its own notes.** `/memory:health` finds contradictions, stale claims and orphans,
and then stops at reporting them. The direction is a vault that compounds by **maintenance** rather
than by rewrite, which is two cheap local steps and no model call per write: flag a claim whose stamp
is older than its freshness window at write time, and let a note that *contradicts* an earlier claim
supersede it rather than merge into it. The second is a real gap named by the survey — one
token-Jaccard threshold cannot tell "this is a duplicate" from "this reverses what we said".

The expensive alternative is rejected on cost, not on merit: Mem0 has an LLM arbitrate
ADD/UPDATE/DELETE/NOOP against the ten most similar memories, at one paid network call per fact per
write, against one headless call per session here. Graphiti/Zep's bi-temporal invalidation may be
better still and remains **un-assessed** — three of four claims about its mechanics failed
verification.
— [docs/research/2026-08-21-agent-memory-systems-survey.md](research/2026-08-21-agent-memory-systems-survey.md)

**A3 — it improves its own engine.** An [autoresearch](https://github.com/karpathy/autoresearch)-shaped
loop: propose a retrieval change, run the eval, keep it or discard it on the number. Three of that
pattern's four ingredients are already here — a verifiable metric (`memory-eval.mjs`, recall@k and
MRR), a bounded environment (`memory-synth-vault.mjs`, deterministic and seeded), and reversible git
commits. Only the loop is missing.

**It is blocked, and the block is not incidental.** A loop that tunes against a fixed case set
overfits to it, and the generated English benchmark is already at its ceiling, so it has no headroom
to detect anything. A held-out set has to exist first. This repo has already shipped inflated
retrieval figures to five artefacts including a public README; an unattended loop reproduces that
failure faster. Whatever loses gets its negative result written into `docs/decisions/`, because a
recorded negative result stops the same idea being re-derived.

### B. Two operations the vault does not have

Borrowed from Karpathy's LLM Wiki pattern, whose remaining ideas — lint, a chronological log, an
index-first catalog — this system already has as `/memory:health`, `Logs/` and `MEMORY.md`.

**Ingest an outside source.** Today the only input is your own session transcripts. An article, a
spec, a paper or a talk should be able to enter the vault and be integrated into the notes it
touches, with its source kept verbatim. Research notes here are written that way already, but by
hand.

Video is the case that sets the rule, because it cannot be fetched like a page. Both halves were
measured on 2026-08-22. A YouTube watch page **does** carry a caption track, but every format of that
endpoint — none, `json3`, `srv3`, `vtt` — returns HTTP 200 with **zero bytes**; it is gated. With
`yt-dlp` (2026.08.19) the same video's English captions arrive as a 124 KB VTT in under a second and
**no audio is downloaded** — `--skip-download --write-auto-subs`. Title, author and description come
back with no tool at all, from oEmbed and the page itself.

So ingestion degrades in rungs rather than failing or lying: `yt-dlp` for the full transcript when it
is installed, metadata when it is not, and the note records **which rung produced it** — a thin note
must never be mistaken for a full one. `yt-dlp` stays optional, like every other external tool here,
so §2's refusal of required third-party services holds.

**File a good answer back as a page.** A comparison, an analysis or a connection you asked for
currently disappears when the session ends unless someone runs `/memory:save`. Explorations should
compound the way distilled lessons do.
— [the LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

### C. Team learning, without a vault and without a server

A lesson learned on one machine should be promotable into **the project's own repository**, as plain
Markdown, where git, code review and CODEOWNERS already work and teammates already look. That turns
the README's existing manual advice into a mechanism, and it changes none of §2: the vault is still
never shared, and there is still no server.

Because it is the one path where private content leaves the machine, it is gated: show the exact text
that would be written, scan it for the known leak shapes — names, hostnames, absolute home paths,
tokens, vault paths — and write nothing until a human says yes. Never from a hook. This project has
already leaked vault paths into a report once.

### D. Bound what is injected, and make crossing a bound visible

Everything auto-loaded pays its length on every turn, forever — the reason `CLAUDE.md` links out to
`docs/` at all. `MEMORY.md` has no ceiling, the recall brief's real cost has never been measured, and
Claude Code's auto memory now reads the same file, so there are two writers. The mechanism identified
as worth borrowing is a hard character budget on injected context, with the caveat that
["a budget that never binds is dead code"](research/2026-08-21-agent-memory-systems-survey.md).

### E. Treat text from outside the user as data, not as instructions

A fetched page, an issue body or a colleague's comment can reach a note through the distiller with no
human in the loop, and be replayed into a later prompt. Nothing in the repo states the rule and
nothing enforces it. `[inferred]` This is the largest unaddressed risk class in the project, and
section B makes it larger by design — deliberate ingestion of outside sources is exactly the path
this rule has to cover first.

### F. The vault may live in git, not only in cloud storage

Documentation assumes a cloud-synced vault throughout, and the one hazard it names — sync clients
silently replacing directory symlinks — does not exist under git. Git does not sync by itself, so
notes written at session end sit uncommitted; an optional auto-commit closes that, opt-in and never
blocking.

### G. Explain itself

Four things are still unwritten: a user guide, the knowledge architecture (why the layers are shaped
the way they are, and where a given piece of knowledge goes), the ideas and algorithms behind
retrieval, and an honest comparison against other memory systems that "names where this loses". This
file is the frame for those, not a substitute — it states *why*; each of them owes the *how*.

### H. An ontology layer: meaning, not just structure

Structure today is folders plus untyped links: L1–L4 and `permanent/`, `confidence`, per-claim
recency, and `[[wikilinks]]` that say "related" and nothing more
— [skills/protocol/SKILL.md "Every note"](../skills/protocol/SKILL.md#every-note),
[skills/protocol/SKILL.md "Per-claim supersession: two dates, not one"](../skills/protocol/SKILL.md#per-claim-supersession-two-dates-not-one).

The framing worth borrowing separates two layers that are easy to confuse. A retrieval stack is
organised around the *data* and tuned for the *engine* — chunk size, pooling, fusion weight, a
similarity threshold. An ontology is organised around *concepts*, and the relationships themselves
carry the meaning: a decision **supersedes** another, a mistake was **caused by** a change, a tool
**depends on** a runtime. The result is a network rather than a hierarchy.

The reason it matters now is the reason this whole project exists. A human reading the vault infers
meaning from folder names, note titles and the shape of the links. An agent does not. A question
spanning several notes — *which decisions rest on a measurement that has since been superseded* —
cannot be answered from folder structure, and no single note answers it either.

Three parts, and one of them changes the retrieval path.

**Typed relations.** A link says *how* two notes relate — supersedes, contradicts, caused-by,
depends-on, example-of — not merely that they do. Plain Markdown, no schema, and it immediately makes
per-claim supersession machine-readable where today it is a prose marker no check can see. It also
gives A2 the distinction it needs between a duplicate and a contradiction.

**A controlled vocabulary.** A curated term list so one idea is not written five ways. This is the
same problem an ontology solves when the same entity lives in several systems under different names,
and here it attacks a measured failure: recall misses when a note's aliases are written in its own
jargon rather than an outsider's words
— [skills/protocol/SKILL.md "Retrievability: aliases are not optional"](../skills/protocol/SKILL.md#retrievability-aliases-are-not-optional). Its value has to be shown on a named case set before it is
asserted.

**Typed entity pages, bounded deliberately.** A page per tool, per system, per concept — the shape
Karpathy's wiki uses when it "updates entity pages" on ingest. **This reopens a recorded rejection**:
the 2026-08-21 research turned per-type frontmatter schemas down because that implementation carried
about 15 schemas and about 10 exceptions to its own rules, against folder layering that is "fewer
moving parts and already keyed to how retrieval works". Reopening it owes a **new dated decision
record** naming that reason and saying why it is overridden — a research note is left as written,
never edited. Two constraints come with the override: the type set is **small, fixed up front, and
named in that decision record** rather than grown per note, and folder layering stays the primary
structure, because retrieval is keyed to it. One type deserves explicit thought before inclusion — a
`person` page is colleague names, in a vault whose whole privacy stance is that such content never
leaves the machine.

**The graph is traversable, and that is the expensive half.** Typed relations that only a linter reads
would give up the actual point, which is that a question can be answered by walking the network. So
the ontology becomes a third arm beside the vector and keyword arms, and four things follow. It is
**derived from the Markdown**, never a second source of truth, and must be rebuildable like every
other index. It is a **third thing to keep fresh**, on top of the vector index and the BM25 tokens.
It **changes the retrieval path**, so nothing ships until a named case set says it helps — and the
generated English benchmark has no headroom to show it, so the measurement has to come from
elsewhere. And there is a **working precedent inside this repo**: the L4 codebase graph already
answers "who calls this" by traversal, so the pattern is proven here for code before it is applied to
knowledge.

Two honest caveats. The framing above comes from vendor content about a business-intelligence
product ([Guy in a Cube](https://www.youtube.com/watch?v=y1iw0tf4lzY)); the argument transfers, the
claims are not measured, and nothing here inherits evidence from it. And building a traversable
knowledge graph moves toward the one system the survey could not assess — Graphiti/Zep's temporal
knowledge graph, whose mechanics failed verification three times out of four. That is a reason to
measure our own rather than to borrow theirs.

### I. Hold up under many agents at once

**Two different graphs, and confusing them would be costly.** §5.H is a *knowledge* graph — notes and
typed relations, walked to answer a question. This is an *orchestration* graph — a task split across
agents that run in parallel, each looping on its own part, with a reviewer deciding whether to go
round again. Claude Code's own dynamic workflows are that shape. The two share a word and nothing
else.

Building the orchestration layer is not this project's job (§2). What *is* its job is holding up
underneath one, because a fan-out changes conditions the design predates: the distiller assumes one
session and one transcript, recall assumes one prompt in one session, and note writes assume one
writer.

Some of this is already built, and it was not built speculatively — each piece came from a real
failure. One `--serve` for the whole machine, keyed by model rather than by project
([CLAUDE.md](../CLAUDE.md)). One `--index` writer per model, enforced by a cross-process lock that
is "now the *only* index lock" — it exists because of the mixed 384/1024-dim corruption that
`assertVectorWidth()` also guards
([docs/architecture.md "Invariants"](architecture.md#invariants-and-who-actually-enforces-them)).
`/memory:save` filenames carry seconds and never overwrite, because minute precision let two
concurrent sessions compute the same name and one silently lost a session log
([commands/save.md](../commands/save.md)). Log retention is claimed with an atomic `wx` so exactly
one process per day runs the pass ([CLAUDE.md](../CLAUDE.md)).

The sharpest precedent is an attribution bug that a fan-out would multiply: a session id is
**inherited down the process tree**, so the indexer the distiller runs at the end of its own work was
logged as the SessionStart hook's worker — SessionEnd work filed under SessionStart. It took a
separate marker to say "this indexer is *that* hook's worker" rather than "this belongs to that run"
([CLAUDE.md](../CLAUDE.md), observed 2026-08-21). With N agents descending from one session, every
log line, every lock and every note has that same question to answer.

So the requirement is three things, and none of them needs an orchestrator to exist first.
Concurrent writes never clobber. A lesson records **which run produced it**, so ten agents do not
collapse into one indistinguishable author. And work is filed under the run that did it, not under
whichever ancestor happened to export the id. That the commands already carry this shape says it is
not hypothetical: `/memory:resume` warns that the newest log may describe "a different strand of
work" and tells the reader to check a second one ([commands/resume.md](../commands/resume.md)), and
`/memory:save` treats a name collision as another session having won a race rather than as an error
([commands/save.md](../commands/save.md)).

### What the outside world changes — and does not

The 2026-08-21 survey concluded that against this design, "only four mechanisms across the seven
systems are genuinely different AND portable": a write-side freshness invariant enforced by a
linter, a hard character budget on injected context, progressive-disclosure retrieval, and a
cross-encoder re-rank. It also concluded that "the vendor benchmark claims do not survive scrutiny"
and that the named-case-set discipline here is "exactly the discipline this literature says the
vendors lack."
— [docs/research/2026-08-21-agent-memory-systems-survey.md](research/2026-08-21-agent-memory-systems-survey.md)

The remaining honest unknown, stated in that note's own caveats: Graphiti/Zep's bi-temporal
fact-invalidation model "remains the single most plausible mechanism we do not have, and it has not
been properly evidenced either way in this pass."

---

## Maintaining this document

Edit it in place when intent changes; it is not a dated snapshot. When a claim here is settled by a
measurement, the measurement belongs in `docs/decisions/` and this file cites it. §5 names directions, never issue
numbers: a direction survives an issue closing, and a list of open work does not.
