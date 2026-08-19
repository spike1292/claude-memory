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

## Guides

| | |
| --- | --- |
| [Architecture](architecture.md) | The shape of the system, the flows, the invariants and who enforces them — plus a "how things really work" half for the gaps between the two. |
| [Refactor backlog](refactor-backlog.md) | Atomic tasks ordered by impact per hour, each tracing to a gap named in the architecture guide. Delete items as they land. |
| [Optional integrations](optional-integrations.md) | `context-mode` and `codebase-memory-mcp` — what each adds, what its absence costs. |
| [CI, review, and releases](ci-and-releases.md) | Branch protection, the review workflows, the release flow. |

## Plans

Dated like the decision records. What is *about* to be done, in what order, and what done looks
like — where a decision record says why something already is the way it is. Plan mode writes to
`~/.claude/plans/`, which is a symlink into a private vault; move an approved plan here so it is
visible to whoever reads the repo. Keep the Status section current, and delete a plan once every
step has shipped — the changelog is the record from then on.

| | |
| --- | --- |
| [Refactor backlog, via 6 workflows](plans/2026-08-18-refactor-backlog.md) | How the backlog's 13 items are batched into six PRs, why the batching is what it is, and the review phase each run carries. |

## Specs

| | |
| --- | --- |
| [Plugin design](superpowers/specs/2026-08-15-claude-memory-plugin-design.md) | The original extraction of the memory system into a plugin. |

## Conventions for these documents

- **Every measurement names its conditions.** A hook timing means nothing without saying whether
  the vault was cloud-backed or pinned to local disk — the same hook measures 166 ms or 131 ms on
  that difference alone. Same rule as retrieval numbers naming their case set.
- **Record what was tried and rejected, with the numbers.** The point of the Bun record is that
  nobody has to re-derive it — including the part everyone gets wrong (the native dependencies are
  fine).
- **A decision record is a snapshot.** If the answer changes, add a new dated record and link back
  rather than quietly editing history.
