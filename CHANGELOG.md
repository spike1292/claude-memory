# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). For a plugin, "the API" is
what a user's setup depends on: config keys, command names, vault layout, and
`$CLAUDE_MEMORY_HOME`. A change that forces a re-index or moves a note counts as breaking.

## [Unreleased]

### Added

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
