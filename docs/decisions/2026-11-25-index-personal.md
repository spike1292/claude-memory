# Index `Personal/` notes

Date: 2026-11-25. Supersedes decision 4 of #113 ("Personal/ stays out of recall, the index and the
distiller" — the index and recall parts).

## Decision

`Personal/Research/` and `Personal/Wiki/` are on the `vaultSources()` allow-list as a cross-project
layer (`layer: 'Personal'`), added the same way as `permanent/`. Recall, `--clusters`/`--dupes` and
the vault-mcp connector (which reads the same list) all see them. The owner made this call on
2026-11-25.

## Why

The notes hold research the owner wants to find again. A note nobody can search is a note nobody reads.

## Consequences

- Any project's recall can return a personal note. The vault-mcp connector exposes them (intended).
  [2026-10-13-vault-mcp.md](2026-10-13-vault-mcp.md) reads `vaultSources()`, so it needs no edit.
- `Personal` is a working layer, not `permanent`: `--clusters` may propose consolidating it.
- Existing indexes pick the notes up on the next `--index`.
- The `<private>` rule is kept. It protects secrets in every note, not just personal ones. Only the
  Personal-specific advice ("wrap copied source text in `<private>`") is dropped, because its sole
  purpose was keeping personal text out of an indexed layer, and that layer is now indexed.
