# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). For a plugin, "the API" is
what a user's setup depends on: config keys, command names, vault layout, and
`$CLAUDE_MEMORY_HOME`. A change that forces a re-index or moves a note counts as breaking.

## [Unreleased]

### Fixed

- **One resident search server per slug+model, instead of one per spawn.** `--serve` unlinked the
  socket unconditionally and rebound it, so a redundant spawn stole the path and left the previous
  server running but reachable by nobody — exiting only when its 30m idle timer fired. And a
  redundant spawn is the normal case, not an edge one: `memory-recall.mjs` spawns whenever it has no
  answer, which includes its 700ms timeout expiring during the ~1.5s warm-up, so every prompt in
  that window forked another model. Measured 2026-08-17 on a 16GB machine: **six** `--serve`
  processes at once. `--serve` now probes the socket first and exits in ~55ms without loading the
  index or the model; only a socket nobody is bound to (`ECONNREFUSED`) is unlinked. Losing the bind
  race is handled too — the loser used to die on an unhandled `error` event, and since it is spawned
  detached with stdio ignored, the stack trace went nowhere.
- **Queries are clamped to `MAX_CHARS` before embedding, like documents already were.**
  `chunkNote()` caps every indexed chunk at 1800 chars for bge-m3, but a query was capped only by
  the model: the pipeline passes `truncation: true`, so the tokenizer cut at bge-m3's
  `model_max_length` of **8192 tokens**. A cap, but ~18x the token count of anything in the index —
  the recall hook embeds the user's whole prompt verbatim, and a pasted stack trace went in at 57k
  chars, so a query was also being compared against a length the index never contains. 8192 is where
  the memory goes: attention materialises heads x seq² scores per layer, which at seq 8192 is
  `16 * 8192² * 4B` ≈ **4.3GB for one of 24 layers**, and onnxruntime's arena keeps whatever
  high-water mark it reaches for the process lifetime, which for `--serve` was 30 idle minutes. Two resident servers were each holding **8.8G of
  dirty `MALLOC_LARGE`**, ~7.4G of it compressed; killing them returned it. A 46,799-char query now
  costs +76MB. Note the 8.8G→clamp link is inferred from the allocation profile, not from a
  controlled A/B — the arena was not re-measured unpatched, because doing so needs GBs on a machine
  that had 70MB free.

### Changed

- **One resident server total, not one per project, and it idles out in 5 minutes rather than 30.**
  A warm `--serve` costs 800MB-1.4GB — node, onnxruntime and the q8 weights — and there was one per
  indexed repo, so three projects meant ~2.4-4.2GB resident while you prompt in one of them. A
  starting server now asks the others to quit over their own sockets (no pidfile, no lock, nothing
  to leave stale); a server for the same project on a different model is left alone, since that is a
  model change and every mode except `--index` already refuses it. Last-writer-wins with no
  coordination: two servers for different projects starting in the same instant can evict each other
  and both die, which costs one keyword-only recall and self-heals on the next prompt.
  `MEMORY_SERVE_IDLE_MS` now also reads `serveIdleMs` from `config.json`, because hooks are what set
  it and an env value written mid-session does not reach the session that wrote it.

- **Every Node hook and script is now a thin entry over a `lib/` module, with tests in
  `*.test.mjs` beside the logic and `node --test` as the runner.** `hooks/<name>.mjs` and
  `scripts/<name>.mjs` keep their paths — `hooks.json` and `commands/*.md` name them — and own argv,
  stdin and stdout only; the logic moved to `hooks/lib/<name>.mjs` / `scripts/lib/<name>.mjs`. The
  `--selftest` flag is gone from every `.mjs` (`scripts/release.sh --selftest` stays: it is bash).
  CI is now `node --test --test-concurrency=1`, which is discovery rather than a hand-maintained
  list of nine invocations — a new test file cannot be forgotten. Concurrency is pinned because the
  suites share `$CLAUDE_MEMORY_HOME` and one test needs two git writes inside the same second.
  47 tests, each named, so a failure says which case broke instead of printing a bare assertion.
- **Assertion counts are no longer written down.** The runner reports them. Four hand-maintained
  counts had drifted (`distill-session.mjs` claimed 22 against a real 21 before the change that made
  it 28; `paths.mjs` claimed 7 against 9), which is the third recurrence of that class in this repo.

### Added

- **Prettier, pinned at 3.6.2 and run through `npx`.** `npm run format` / `format:check`, plus a CI
  job of its own — formatting does not vary by Node version, and putting it in the matrix would run
  it twice per push, which is the mistake `release.sh --selftest` already made. Deliberately **not**
  a devDependency: Claude Code auto-runs `npm ci` on plugin install and that installs dev deps, so
  it would ship into every user's version-pinned plugin cache (already 381 MB) to format code they
  never edit.

  Scope is code only. `.prettierignore` excludes `*.md`, `*.yml` and `package-lock.json` — CLAUDE.md
  and `commands/*.md` are instructions Claude Code reads, the workflow comments carry dated
  measurements, and Prettier reflows prose.

  The one-time reformat touches 27 files (+1968/−628) and is mostly one idiom: this codebase writes
  `try { … } catch { /* why */ }` on a single line throughout, and Prettier expands each to four or
  five. Verified formatting-only rather than assumed — every entry point's output is byte-identical
  before and after, `memory-synth-vault` still produces a byte-identical vault for the same seed,
  and the suite passes 47/47 on Node 22 and 24.


- Two CI checks that turn conventions into failures: **every `lib/` module must import with no
  output** (a module that runs its hook on import makes any importing test a live hook run — reading
  stdin, spawning a headless `claude`, writing notes; it happened three times), and **`node:test`
  must not be imported outside a `*.test.mjs`** (a top-level import prints the full test report to
  stdout, which Claude Code reads from hooks).

### Fixed

- **`--dupes` and `--clusters` found nothing under the default model, because bge-m3 carried
  e5-multi's thresholds.** `dupeMin`/`clusterMin` were 0.95/0.92, copied when bge-m3 became the
  default and never measured against it — and m3's similarity band sits *low and wide* where
  e5-multi's is high and narrow. On a 74-note set with sixteen hand-identified duplicates the scan
  returned **zero pairs**, so a miscalibrated threshold read as a clean vault. Measured by sweep and
  set to **0.75 / 0.72** (real duplicates occupy 0.75–0.869, the first coincidental pair is at
  0.714; `--clusters` found 0 topics at ≥0.76 and 2 real ones at 0.72). The sweep table is in the
  model profile and in `/memory:prune` step 2b, which no longer warns that the values are
  unmeasured. Two duplicates in that set scored below 0.70 and no threshold reaches them — the scan
  bounds what it can find, it does not replace reading.
- **The distiller re-created notes that `/memory:prune` had just merged away.**
  `findNearDuplicate` compared only *filename slugs*, so a lesson restated in different words
  became a new note; of sixteen same-lesson pairs found in one vault, only the six whose slugs
  happened to overlap were ever reconciled. It now also compares note **bodies**, using containment
  (overlap over the smaller token set) rather than Jaccard, because these pairs differ in length and
  a union denominator buries them. Measured against those sixteen pairs plus seven judged
  complementary: slug alone caught 0/16, body Jaccard ≥0.25 caught 6/16, body containment ≥0.40
  catches **11/16 with no false merges**. Deliberately conservative — the highest complementary pair
  scores 0.286, and a false merge deletes a distinct lesson while a miss only leaves work for
  `/memory:prune`. Frontmatter, headings, alias lines and folded-in addenda are excluded from the
  comparison. A two-argument call is unchanged and reads no files.
- **Importing a hook module ran the hook.** `hooks/distill-session.mjs` called `main()`
  unconditionally, so importing one helper spawned a headless `claude`, wrote notes and reindexed
  the vault. Six other files suppressed the same problem with a hand-rolled entry-point guard —
  seven copies in all — and **every copy was wrong**: they compared `path.resolve(process.argv[1])`,
  a purely textual path, against the already symlink-resolved `fileURLToPath(import.meta.url)`. Those
  disagree whenever a file is reached through a symlinked directory, and then `main()` silently never
  runs and the hook does nothing with no error. On macOS `/var` is a symlink to `private/var`, so the
  comparison was already false for anything under `$TMPDIR`; plugin roots are symlinks too, and
  `distill-session.sh` passes node a `BASH_SOURCE`-derived path that still contains the link.

  Fixed structurally rather than defensively: the CLI/logic split above means an entry always runs
  and a `lib/` module never does, so **the guard is gone entirely** along with
  `paths.isEntryPoint` and `paths.runningSelftest`. A guard that does not exist cannot be wrong in
  six files. CI now enforces the property the guard was standing in for — every `lib/` module must
  import with no output.

- **Merging the release PR now publishes the release.** `release.yml` also triggers on pushes to
  `main` and publishes whenever `package.json` names a version with no release yet, so the manual
  `git tag && git push` step is gone. One job creates the tag and the release together, because a
  tag pushed by `GITHUB_TOKEN` does not start another workflow run — a "tag here, react there"
  split would have created the tag and then silently never published. Idempotent: the job runs on
  every push to `main` and is a ~10 s no-op when the version is already out. Pushing a `v*` tag by
  hand still works as an escape hatch.
- **`scripts/release.sh` derives the version from the conventional commits since the last tag** —
  a breaking marker (`!:` / `BREAKING CHANGE`) bumps the major, except below 1.0 where semver lets
  anything change and it bumps the minor; any `feat:` bumps the minor; everything else the patch. Pass a version to override. `--selftest` covers each path,
  including that `feat:` must be anchored at the start of a subject and that `perf:` is not a
  feature. Not release-please or semantic-release: those generate the changelog from commit
  subjects, and here the changelog *is* the release notes — deriving the number is useful,
  generating the prose would be a downgrade.
- Corrected the rule for when a PR goes unreviewed: it is **per workflow file**, not per PR. Only
  a change to `claude-review.yml` itself blocks its review; editing `ci.yml` or `release.yml` is
  reviewed normally. The broader claim was written down first and was wrong.
- `release.yml` passes the resolved version through `env` rather than splicing `${{ }}` into the
  script text, which is the standard Actions script-injection shape, and `scripts/release.sh
  --selftest` moved out of the Node matrix (it is pure bash and was running twice per push).
- `release.yml` runs under a `concurrency: release` group, so two release-worthy merges landing
  seconds apart serialise instead of racing on `gh release create`.
- The CI version check covers `package-lock.json` as well, which had silently sat at 0.1.0 through
  three releases while the four manifest fields moved to 0.1.3.

## [0.2.0] - 2026-08-17

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
- `claude-code-review.yml`, the installer's generic auto-reviewer. It ran on the same
  `pull_request` trigger as `claude-review.yml`, so every PR got reviewed twice; the surviving one
  carries this repo's invariants and can actually comment (`pull-requests: write`).

### Changed

- **`validate-note.sh` is now `validate-note.mjs` — 132 ms → 54 ms** on the hook that runs on every
  Write/Edit (vault pinned to local disk; it was 166 ms → 93 ms cloud-backed, and a hook timing
  means nothing without saying which). The shell version forked ~15 processes (`jq`, `head`, `awk`,
  six `grep`s, `basename`, `sed`) to check one file; fork-per-operation, not the language, was the
  cost. Half the remaining win came from `memory-audit-checks.mjs` becoming import-safe, so its
  predicates run in-process instead of costing a second Node startup.
- **`memory-link-lint.sh` is now `memory-link-lint.mjs`, and it had been timing out.** The shell
  version ran `grep -rlF` over the whole Memory *and* Insights tree once per note — O(N×(N+M)) —
  which measured **10.9 s on a real 49-note project** against the hook's **10 s timeout**, so on
  the largest vault the lint was being killed silently and produced nothing. The Node version
  indexes links in a single pass, O(N+M): **243 ms**, and flat as the vault grows (60 notes:
  1949 ms → 64 ms). Output matches the shell version on every note in a real vault and on generated
  vaults up to 60 notes, with one deliberate exception: a final `MEMORY.md` line with no trailing
  newline: `while read` dropped it, so the shell silently missed drift declared on that line.
  It had looked like a 74 ms hook only because it was measured in a repo with no L1 notes, where
  the loop never ran at all.
- **Shell hooks now share the project-key cache** instead of forking `git` for it. `vault-env.sh`
  reads the same `project-keys.json` that `paths.mjs` writes: `project_key` **34.3 ms → 22.4 ms**,
  and `vault-memory-sync.sh` **97.7 ms → 70.9 ms** with no port. The stamp is
  `"<second>:<size>:<inode>"` so `stat` and `fs.statSync` compute it identically — seconds alone
  left a *permanent* stale-key hole when a remote changed within the cached second, and size alone
  missed a same-length rename; git's atomic config rewrite makes the inode decisive.
- **`insights-surface.sh` is now `insights-surface.mjs` — 124 ms → 52 ms**, and it **fixes a latent
  bug**: `t=$(grep -m1 '^title:' …)` exits non-zero for a note with no `title:` line, which under
  `set -e` aborted the `| while read` subshell. A single untitled note in `Mistakes/` silently
  dropped *every* bullet while still printing the header — so it read as "no past mistakes" rather
  than as a failure, and the intended filename fallback on the next line was unreachable.
- `scripts/memory-audit-checks.mjs` runs its vault-wide audit only when executed directly, and
  exports `checkFile()`. Importing it used to start an audit and exit the process. Verified by
  diffing the full audit, `--deferred`, and `--check-file` over all 1172 notes: identical.
- **`projectKey()` is cached on disk — roughly 50 ms off every hook invocation.** It delegates to
  `vault-env.sh` so there is one implementation of the key, but that costs a bash+git subprocess:
  72 ms in-process, the single largest cost in both the per-prompt recall hook and the per-write
  `validate-note` hook. The answer is now cached in `$CLAUDE_MEMORY_HOME/cache/project-keys.json`
  and validated against a `"<second>:<size>:<inode>"` stamp of the git config that determines it,
  so `git remote set-url` invalidates it rather than leaving a stale key. Fresh process:
  **98 ms → 49 ms**.
  `vault-env.sh` remains the only thing that computes a key; a cache miss is the worst failure.
- **`context-mode` is documented as optional, and degrades instead of drifting.** When the CLI is
  absent the SessionEnd distiller now refreshes the plugin's own semantic index rather than
  refreshing nothing, so notes written this session stay retrievable; only `ctx_search` goes
  stale. The old warning claimed the vault "stops being searchable", which was never true —
  `memory-semantic.mjs` owns its own vector and BM25 arms and never read from context-mode.
- `/memory:doctor` reports both optional integrations under their own heading, with the precise
  cost of each being absent.
- Pinned `actions/checkout` and `actions/setup-node` to v7 in every workflow, clearing GitHub's
  Node 20 runtime deprecation warning.
- Aligned the Claude workflows after `/install-github-app` ran: the review now authenticates with
  `CLAUDE_CODE_OAUTH_TOKEN` (the subscription token the installer actually wrote) instead of
  `ANTHROPIC_API_KEY`, which no longer existed and left the job skipping every PR while reporting
  success. `claude.yml` (the `@claude` mention responder) is kept.

### Added

- A self-test for the project-key cache (`node hooks/lib/paths.mjs --selftest`), which asserts
  against `vault-env.sh` itself rather than fixed strings, uses a fresh process per lookup, and
  covers the failure that would matter: a changed git remote must not keep serving the old key.
- A `docs/` tree with an index, two dated decision records ([Bun](docs/decisions/2026-08-17-bun.md),
  [shell vs Node in hooks](docs/decisions/2026-08-17-shell-vs-node-hooks.md)) and two guides
  ([optional integrations](docs/optional-integrations.md),
  [CI and releases](docs/ci-and-releases.md)). `CLAUDE.md` is loaded into context every session, so
  detail that is read occasionally now lives in files opened on purpose — 231 → 169 lines, with the
  removed material moved rather than dropped.
- Documentation for the two optional integrations — `context-mode` (backs `ctx_search`) and
  `codebase-memory-mcp` (backs the L4 `Graph/` layer and `/memory:graph-report`). Neither is
  installed by this plugin, neither is required, and neither is on the retrieval path. Because
  `codebase-memory-mcp` is an MCP server rather than a CLI, `/memory:doctor` detects it by the
  presence of an L4 digest instead of by looking on PATH.

- `CLAUDE.md` — architecture and conventions for future Claude Code sessions.
- CI on every pull request: the self-tests on Node 22 and 24, `bash -n` over every shell hook, and
  a check that the version agrees across all four places it is written.
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

[Unreleased]: https://github.com/spike1292/claude-memory/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/spike1292/claude-memory/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/spike1292/claude-memory/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/spike1292/claude-memory/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/spike1292/claude-memory/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/spike1292/claude-memory/releases/tag/v0.1.0
