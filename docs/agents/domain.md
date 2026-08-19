# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/decisions/`** — read the decision records that touch the area you're about to work in.
  This repo names them `YYYY-MM-DD-<slug>.md` rather than the numbered `docs/adr/NNNN-*.md` the
  skills' default layout assumes; refer to one by its date and slug.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest
creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

There is no `CONTEXT.md` here yet. The nearest thing is `CLAUDE.md` plus
[docs/architecture.md](../architecture.md), which carries the module graph, the six key flows, and
the invariants table — read those when you need the repo's own vocabulary.

## File structure

Single-context repo — one package, no workspaces:

```
/
├── CLAUDE.md
├── docs/
│   ├── architecture.md
│   └── decisions/
│       ├── 2026-08-17-bun.md
│       └── 2026-08-18-node-hooks.md
├── hooks/
└── scripts/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a
test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly
avoids. Until that file exists, take the terms from `CLAUDE.md` and `docs/architecture.md` —
`project_key`, `legacy_key`, the L1–L4 layers, the vector and keyword arms, `--serve`.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language
the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag decision conflicts

If your output contradicts an existing decision record, surface it explicitly rather than silently
overriding:

> _Contradicts [2026-08-18-node-hooks](../decisions/2026-08-18-node-hooks.md) — but worth reopening
> because…_

That file says so itself: don't re-litigate the Bun or shell-vs-Node decisions without new numbers.
