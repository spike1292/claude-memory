# docs

`CLAUDE.md` is loaded into context at the start of **every** session, so it stays lean and links
here. That is the same unbounded-growth problem the plugin already documents for `MEMORY.md` —
anything auto-loaded pays its length on every turn, forever. Detail that is read *occasionally*
belongs in a file you open on purpose.

## Decision records

Dated, and superseded rather than edited when the answer changes.

| | |
| --- | --- |
| [Bun: evaluated and declined](decisions/2026-08-17-bun.md) | Why the plugin is Node-only. The blocker is `node:sqlite`, not the native deps. |
| [Shell vs Node in hooks](decisions/2026-08-17-shell-vs-node-hooks.md) | Fork count decides, not language. What is ported, what must not be, and the measurement traps. |
| [The last three gate hooks move to Node](decisions/2026-08-18-node-hooks.md) | Supersedes the "do not port" list above. The floors were right; they were quoted about hooks that never ran at them. |
| [One resolver: Node resolves, shell asks](decisions/2026-08-18-single-resolver.md) | Retires the "two mirrors" rule. What it cost the shell side, and what it bought. |
| [Orchestrating a change](decisions/2026-08-19-orchestrated-change.md) | `Implement → Verify → Document → Review → Land`, why `Document` precedes `Review`, and the nine lessons the six backlog runs paid for. |

## Guides

| | |
| --- | --- |
| [Architecture](architecture.md) | The shape of the system, the flows, the invariants and who enforces them — plus a "how things really work" half for the gaps between the two. |
| [Optional integrations](optional-integrations.md) | `context-mode` and `codebase-memory-mcp` — what each adds, what its absence costs. |
| [CI, review, and releases](ci-and-releases.md) | Branch protection, the review workflows, the release flow. |
| [Ponytail audit, 2026-08-19](2026-08-19-ponytail-audit.md) | A repo-wide scan for over-engineering: nine cuts, ranked; eight applied, one declined with its reason. |

## Plans

Dated like the decision records. What is *about* to be done, in what order, and what done looks
like — where a decision record says why something already is the way it is. Plan mode writes to
`~/.claude/plans/`, which is a symlink into a private vault; move an approved plan here so it is
visible to whoever reads the repo. Keep the Status section current, and delete a plan once every
step has shipped — the changelog is the record from then on.

None open. The refactor-backlog plan lived here from 2026-08-18 until 2026-08-19, when its sixth
and last run merged and it was deleted under the rule above — #24, #27, #28, #29, #30 and #31 are
what it produced, the changelog records what shipped, and the part of it that was not specific to
that backlog was rewritten as [a decision record](decisions/2026-08-19-orchestrated-change.md),
which is what the rule means by a plan becoming one. The backlog itself outlived its execution and
went the same way; what survived it is in `architecture.md` — Part 2's open markers, and the one
item that was declined.

## Research notes

Dated like the other two. What was read, what it said, and what — if anything — is worth taking.
A research note answers "what does the outside world do", where a decision record answers "why is
ours this way, and what did we measure" and a plan answers "what are we about to do". It cites its
sources by URL and ours by path, and it is written to stop the same reading being redone.

A research note is **not** a work queue. When it produces work, the work becomes issues and the note
stays as it was written; it is not updated to track what shipped.

| | |
| --- | --- |
| [obsidian-second-brain](research/2026-08-21-obsidian-second-brain.md) | The repo several of our own checks came from. What is already ours, what was deliberately rejected, and the three items left. |

## Conventions for these documents

- **Every measurement names its conditions.** A hook timing means nothing without saying whether
  the vault was cloud-backed or pinned to local disk — the same hook measures 166 ms or 131 ms on
  that difference alone. Same rule as retrieval numbers naming their case set.
- **Record what was tried and rejected, with the numbers.** The point of the Bun record is that
  nobody has to re-derive it — including the part everyone gets wrong (the native dependencies are
  fine).
- **A decision record is a snapshot.** If the answer changes, add a new dated record and link back
  rather than quietly editing history.
