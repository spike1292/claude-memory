# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). For a plugin, "the API" is
what a user's setup depends on: config keys, command names, vault layout, and
`$CLAUDE_MEMORY_HOME`. A change that forces a re-index or moves a note counts as breaking.

## [Unreleased]

### Removed

- **The Python dependency.** `hooks/distill-session.py` is now `hooks/distill-session.mjs`. Node
  ≥ 22.5 was already a hard requirement for `node:sqlite`, so Python only added a second runtime
  that could be the wrong version — and usually was: macOS ships 3.9, which cannot parse the
  `str | None` annotations the distiller used, so `Insights/` silently stopped being written on a
  stock Mac. Verified equivalent against the original on write, dedup, and reconcile paths, which
  produce byte-identical vaults. CI now rejects any `.py` file or shell script calling `python`.
- One of the three mirrored config implementations. The distiller imports `hooks/lib/paths.mjs`
  instead of re-deriving vault, config, and `project_key` resolution, so that logic exists twice
  now (bash + Node) rather than three times.

### Changed

- **`context-mode` is documented as optional, and degrades instead of drifting.** When the CLI is
  absent the SessionEnd distiller now refreshes the plugin's own semantic index rather than
  refreshing nothing, so notes written this session stay retrievable; only `ctx_search` goes
  stale. The old warning claimed the vault "stops being searchable", which was never true —
  `memory-semantic.mjs` owns its own vector and BM25 arms and never read from context-mode.
- `/memory:doctor` reports both optional integrations under their own heading, with the precise
  cost of each being absent.
- Pinned `actions/checkout` and `actions/setup-node` to v7, clearing GitHub's Node 20 runtime
  deprecation warning.

### Added

- Documentation for the two optional integrations — `context-mode` (backs `ctx_search`) and
  `codebase-memory-mcp` (backs the L4 `Graph/` layer and `/memory:graph-report`). Neither is
  installed by this plugin, neither is required, and neither is on the retrieval path. Because
  `codebase-memory-mcp` is an MCP server rather than a CLI, `/memory:doctor` detects it by the
  presence of an L4 digest instead of by looking on PATH.

- `CLAUDE.md` — architecture and conventions for future Claude Code sessions.
- CI on every pull request: the five self-tests on Node 22 and 24, `bash -n` over every shell
  hook, and a check that the version agrees across all four places it is written.
- Release automation: pushing a `v*` tag publishes a GitHub release with that version's changelog
  section. `scripts/release.sh` prepares the version bump and opens the PR.
- `main` is protected: no direct pushes, no force-pushes, CI must be green to merge.
- Claude reviews every pull request (`.github/workflows/claude-review.yml`), weighted toward what
  breaks silently here — vault content reaching a public repo, state written inside the
  version-pinned plugin dir, blocking hooks, mirrored config logic drifting apart, and retrieval
  changes with no case-set numbers behind them. It comments; it never approves or merges.

## [0.1.3] - 2026-08-15

### Changed

- **One settings file, `$CLAUDE_MEMORY_HOME/config.json`.** Replaces the two marker files 0.1.1
  and 0.1.2 briefly used; `vault-memory-sync.sh` migrates them on first run. Config is read when
  the hook runs, so it no longer depends on what a process inherited or when the value was written.

## [0.1.2] - 2026-08-15

### Fixed

- Per-prompt recall can be armed from a file, not only from the environment. It had never fired:
  the env var it read did not reach the hook.

## [0.1.1] - 2026-08-15

### Fixed

- The vault resolves from a config file rather than `CLAUDE_VAULT` alone. A `CLAUDE_VAULT` added to
  `settings.local.json` mid-session did not reach that session's hooks, so SessionStart built an
  empty vault at the default path and repointed the memory symlink at it.

## [0.1.0] - 2026-08-15

### Added

- The memory system extracted from `~/.claude` into a self-contained plugin: SessionStart /
  UserPromptSubmit / PostToolUse / SessionEnd hooks, the `/memory:*` commands, the `/memory:protocol`
  skill, `/memory:doctor`, and the README.
- Hybrid retrieval — a local ONNX vector arm and a keyword arm, rank-fused, with per-model indexes.
- Session distillation into `Insights/`, deduped on write.

[Unreleased]: https://github.com/spike1292/claude-memory/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/spike1292/claude-memory/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/spike1292/claude-memory/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/spike1292/claude-memory/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/spike1292/claude-memory/releases/tag/v0.1.0
