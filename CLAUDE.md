# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code **plugin** (`memory@claude-memory`) — hooks, slash commands, and a skill that give
Claude Code a layered memory backed by a plain-Markdown Obsidian vault. There is no build step and
no application; the deliverables are the files themselves, loaded by Claude Code from a
version-pinned cache dir.

**This repo is the engine. The vault is not in it and must never be** — notes and generated eval
case sets contain private content. See the Sharing section of `README.md`.

## Commands

Tests are `*.test.mjs` files beside the module they test; the runner is Node's built-in one, so
there is no framework and no test dependency.

```bash
node --test                                    # every *.test.mjs — this is what CI runs
node --test --test-concurrency=1               # CI's exact form; see below for why
node --test hooks/lib/distill-session.test.mjs # one file
scripts/release.sh --selftest                  # still bash, 13 cases; node --test cannot run it
scripts/doctor.sh                              # the /memory:doctor body; always exits 0
npm run format                                 # prettier --write .   (CI runs format:check)
```

**Prettier is pinned and invoked via `npx`, never a devDependency.** Claude Code auto-runs `npm ci`
on plugin install and that installs devDependencies, so a `prettier` entry there would ship into
every user's version-pinned plugin cache to format code they will never edit.
Bump the version in `package.json`'s scripts and in `.github/workflows/ci.yml` together.

**It formats code only.** `.prettierignore` excludes `*.md`, `*.yml` and `package-lock.json`:
CLAUDE.md and `commands/*.md` are read by Claude Code as instructions, the workflow comments record
dated measurements, and Prettier reflows prose. Formatting a generated lockfile buys nothing.

**`node_modules` is slimmed after install and that is load-bearing, not cosmetic.** A
`postinstall` runs `scripts/slim-install.mjs`, which takes 380 MB down to 59 MB: it deletes
onnxruntime-node's binaries for every platform but this one (176 MB, bundled in the tarball, so npm
cannot skip them) and replaces `sharp` and `onnxruntime-web` with the ~1 KB stubs in `stubs/`
(147 MB of image pipeline and browser WASM backend that no text-embedding path touches). Three
things about it:

- **Stub, never delete.** Both are *static* imports in `transformers.node.mjs`; removing them fails
  module resolution before any code runs. The stubs throw when touched, so a wrong-backend
  regression is loud rather than a silent WASM fallback.
- **npm `overrides` cannot do this.** Pointed at a local stub, npm writes a lockfile it then
  rejects itself (`npm ci`: "Missing: sharp@ from lock file"), and Claude Code installs plugins with
  `npm ci`. Workspace overrides install the real package anyway. Measured 2026-08-18.
- **One copy is shared across installed versions.** Claude Code keeps every version it has
  installed — it does *not* replace the cache on update — so the install cost multiplies: six
  versions of this plugin measured 381 MB each, link count 1, **2.2 GB** on 2026-08-18.
  `scripts/share-modules.mjs` moves the runtime to `$CLAUDE_MEMORY_HOME/node_modules` and symlinks
  every version dir at it (Node resolves through symlinks, so nothing else changes). It deletes
  directories, so it refuses to run anywhere but inside a `plugins/cache/` path — a checkout keeps
  its own. `/memory:doctor` reports the multi-version cost when it is not yet shared.
- **It fails safe, which means it fails silently.** An upstream layout change makes it prune
  nothing and everything keeps working at 380 MB. The `install` job in `ci.yml` is the only thing
  that notices — it is the one place a real `npm ci` runs, since every other suite mocks the
  embedding runtime.

**Concurrency is pinned to 1 in CI on purpose.** The suites share `$CLAUDE_MEMORY_HOME` (the
project-key cache) and the per-model index, and `hooks/lib/paths.test.mjs` asserts that two git
writes land in the *same second*. In parallel both become racy, and the failure mode is a test that
passes for the wrong reason rather than one that fails.

**Assertion counts are not written down anywhere.** The runner reports them. Four hand-maintained
counts had already drifted by 2026-08-17 (`distill-session` claimed 22 against a real 21).

Exercising the real pipeline:

```bash
node scripts/memory-semantic.mjs --index [dir]        # idempotent; --rebuild forces re-embed
node scripts/memory-semantic.mjs --query "..." [-k 5]
node scripts/memory-semantic.mjs --coverage | --dupes | --clusters | --check-embedding
DISTILL_DRYRUN=1 node hooks/distill-session.mjs <transcript> <cwd>    # no LLM call
```

Never point a test at the real vault. Generate a deterministic synthetic one and pass
`--vault`/`--slug`:

```bash
node scripts/memory-synth-vault.mjs --out /tmp/bench --notes 300 --seed 7
node scripts/memory-semantic.mjs --vault /tmp/bench --slug bench --index --rebuild
node scripts/memory-eval.mjs --vault /tmp/bench --slug bench --run --cases /tmp/bench/cases-paraphrase.jsonl
```

`hooks/vault-memory-sync.sh` repoints the live `~/.claude/projects/*/memory` symlink at whatever the
vault resolves to, so isolate `HOME`, not just `CLAUDE_VAULT`, when testing hooks.

## Architecture

**Full map: [docs/architecture.md](docs/architecture.md)** — the three homes, the module graph, the
six key flows as diagrams, and the invariants table with an *enforced by* column. Its second half,
"how things really work", records where this section's rules do not hold in the code: the entry/`lib`
inversion, the mutual `hooks/`↔`scripts/` dependency, the four implicit services, and the twelve
load-bearing hacks. Read it before a refactor; edit it in place when the code moves.

**Every Node hook and script is a thin entry over a `lib/` module.** `hooks/<name>.mjs` and
`scripts/<name>.mjs` own argv, stdin and stdout and nothing else; the logic and its tests live in
`hooks/lib/<name>.mjs` + `<name>.test.mjs`. `hooks/hooks.json` and `commands/*.md` name the entry
paths, so those filenames are a contract — add logic to the `lib/` twin, not to the entry.

A `lib/` module must import without side effects, and CI checks it: while the logic lived in the
same file as the CLI, importing one helper ran the whole hook — spawning a headless `claude`,
writing notes, reindexing — which happened three times and needed an entry-point guard to suppress.
The split retired that guard entirely rather than making it more careful.

**Resolution is single-implementation: `hooks/lib/paths.mjs`.** Vault path, `$CLAUDE_MEMORY_HOME`,
recall arming, `project_key` and `legacy_key` are resolved in Node and nowhere else.
`hooks/lib/vault-env.sh` no longer resolves anything — it `eval`s one `node scripts/env.mjs` call
and exposes the same function names it always did. There is nothing to keep in step any more; the
old "change one, check the other" rule is retired.

Two consequences worth knowing before you touch it. **Values are `eval`ed**, so
`shellQuote()` in `hooks/lib/env-shell.mjs` is a correctness boundary, not politeness — it is
tested against bash itself. And **the accessors run in `$(...)` subshells**, so `vault-env.sh` loads
eagerly in the parent shell at source time; a caller needing a different directory must call
`_memory_env_load "$dir"` itself, which `vault-memory-sync.sh` does. Without that each accessor
forks node again.

There is **no Python.** `distill-session.py` was ported to `distill-session.mjs` on 2026-08-16; it
now imports `paths.mjs` rather than carrying a third copy of the resolution logic, and CI fails if
a `.py` file or a shell script calling `python` reappears. Everything is bash + Node ≥ 22.5.

**Node only — Bun cannot run this** (`node:sqlite` does not exist in Bun; the native deps are
*not* the obstacle). Evaluated with numbers in
[docs/decisions/2026-08-17-bun.md](docs/decisions/2026-08-17-bun.md) — do not re-litigate without
new ones.

**Settings resolve env → `$CLAUDE_MEMORY_HOME/config.json` → built-in default**, in that order, and
are read *when the hook runs*. Do not move settings into `~/.claude/settings.json`'s `env` block: a
value written there mid-session does not reach that session's hooks, and the SessionStart hook will
happily build an empty vault at the default path. `CLAUDE_MEMORY_HOME` is the exception — it
relocates the config file itself, so it can only be an env var.

**All mutable state lives in `$CLAUDE_MEMORY_HOME/` (`db/ models/ logs/ run/ eval/`), never in the
plugin.** Each release installs into its own version-pinned cache dir; anything
inside would take the indexes and 722 MB of ONNX weights with it. `paths.useModelCache()` exists
because transformers.js v4 ignores `HF_HOME`/`TRANSFORMERS_CACHE` and must be redirected by mutating
its own `env.cacheDir`.

**Nothing resolves an absolute install path**: bash uses `BASH_SOURCE`, Node uses
`import.meta.url`. `${CLAUDE_PLUGIN_ROOT}` is only reliable inside
`hooks/hooks.json` command strings; command bodies fall back to the `$CLAUDE_MEMORY_HOME/plugin-root`
breadcrumb that `vault-memory-sync.sh` rewrites every session.

**Project identity is the normalised git remote**, not the checkout path (`project_key` in
`vault-env.sh`), so one repo maps to one vault folder from any machine or subdirectory. `legacy_key`
(cwd-slug) still exists because Claude Code names `~/.claude/projects/<slug>/` after it.

**Retrieval** (`scripts/memory-semantic.mjs`) is a vector arm plus a BM25 keyword arm, rank-fused.
Two facts that bite:

- **Model profiles are not interchangeable.** Dim, chunk size, query/doc prefixes, pooling, and
  dupe/cluster thresholds are all per-model and none transfer. Wrong pooling is silent — bge-m3
  scored 25% @5 mean-pooled vs 68% cls-pooled and returned confident, plausible, wrong rankings.
- **Batch size is 1 on purpose.** Padding changes the embedding, and competing notes sit ~0.001
  apart. Verify with `--check-embedding` before touching it.

Indexes are keyed per model (`db/semantic-<slug>-<model>.db`); a model change is refused by every
mode except `--index`. The active model comes from `scripts/lib/model-default.mjs` — one place, on
purpose, because a drifting default makes recall stop silently instead of erroring.

**`hooks/memory-recall.mjs`** (UserPromptSubmit, opt-in) talks to a resident `--serve` socket for
60 ms lookups, spawns it detached when absent, and falls through to keyword search — a prompt must
never wait on it. Its cosine gate (0.55) is separate from the BM25 gate; the bands overlap, so it
errs toward abstaining.

**One `--serve` for the whole machine, keyed by MODEL, and three separate bounds on its memory.**
The server holds the model and answers for every project; the slug is a *request field*, and indexes
load on demand and cache. That inverts the old design, which fixed the slug before the socket existed
and therefore needed one ~1.3 GB model per indexed repo. Anything else under `run/` is a leftover and
gets evicted on startup, which is also the migration path off the per-slug names.

The three bounds are not interchangeable and each covers what the others cannot:

- **`enableCpuMemArena: false`** in `session_options` — onnxruntime's BFCArena grows to the largest
  shapes it has ever seen and never returns them. This is the only bound that survives a bad input.
- **`embed()` clamps to `MAX_CHARS`** — documents were chunked, queries were not, and a query was
  capped only by bge-m3's own 8192-token max. Attention is heads × seq² per layer (~4.3 GB for one
  of 24 layers at that length), so this is what stops the arena being asked for gigabytes at all.
- **`modelIdleMs` (5 min) unloads the model; `serveIdleMs` (30 min) exits the process.** Two timers
  because they are two costs: `pipeline.dispose()` → `InferenceSession.release()` takes ~450 MB of
  `MALLOC_LARGE` down to ~2.4 MB while the socket, indexes and BM25 tokens survive, so the process
  that lingers is the cheap one. Measured 2026-08-17.

The hook spawns on any miss — including its 700 ms timeout expiring during warm-up — so redundant
spawns are routine; `--serve` probes the socket and exits in ~55 ms rather than stealing it, and only
an unbound socket (`ECONNREFUSED`) may be unlinked. Six servers once ran at once on a 16 GB machine.

**Two optional integrations, neither installed by this plugin, neither on the retrieval path.**
`context-mode` backs `ctx_search` (a second index `memory-semantic.mjs` never reads);
`codebase-memory-mcp` backs the L4 `Graph/` layer. Details in
[docs/optional-integrations.md](docs/optional-integrations.md).

Do not write code that assumes either is present, and do not describe a missing one as breakage.
State precisely what degrades — an earlier warning claimed the vault "stops being searchable" when
`context-mode` was gone, which was never true.

**Two shell files remain: `hooks/vault-memory-sync.sh` and `scripts/doctor.sh`.** Every other hook
is Node. `hooks/lib/hook-io.mjs` is the shared plumbing for the gates — stdin payload, debounce
markers, `findClaude()`, `detach()` — and it exists because three bash scripts had each grown their
own copy of all four, already drifted.

**Fork count decides, not language — but count them before quoting a floor.** bash's floor is ~5 ms
and Node's ~40 ms, so a hook that loops over notes belongs in Node and a bare **gate** belongs in
bash. The three gates ported on 2026-08-18 were not bare: each sourced `vault-env.sh` (15 ms) and
forked `git`/`jq` several times, so they ran at 43–58 ms, and moving them to Node was a net **−7.6
ms**. A floor is not a budget:
[docs/decisions/2026-08-18-node-hooks.md](docs/decisions/2026-08-18-node-hooks.md), superseding
[2026-08-17](docs/decisions/2026-08-17-shell-vs-node-hooks.md).

Three things that still bite: **do not port `vault-memory-sync.sh`** (it moves files and repoints
symlinks in a live vault, and has cost 24 notes once — the reason is risk, not language, and it
needs a characterisation test first); **quote no timing without saying whether the vault was
cloud-backed or pinned offline**, which alone moves a hook 166 ms vs 131 ms; and **measure against a
vault with real note counts** — the shell link lint looked like a 74 ms hook in this repo, which has
no L1 notes, while taking 10.9 s on a 49-note project.

The project-key cache (`cache/project-keys.json`) is now Node's alone; shell reads it only by
asking Node. Its stamp is `<whole seconds>:<size>:<inode>` and all three fields are load-bearing —
seconds alone leave a *permanent* hole, because a `git remote set-url` in the same second is never
noticed afterwards.

**Hooks are best-effort and must never block.** Every one degrades to a no-op when its dependency is
missing, `validate-note.mjs` warns rather than blocking a write, and the heavy hooks
(`distill-session`, `graph-staleness-check`, `semantic-index-refresh`) detach, debounce, and guard
against recursing into themselves via a `*_CHILD` env var — they spawn headless `claude`, which
fires SessionStart again.

## Conventions

- **No retrieval number ships without a case-set run behind it.** Rewriting the questions per run
  measures the questions. Any figure quoted anywhere names the case set it came from.
- Load `/memory:protocol` (`skills/protocol/SKILL.md`) before writing or auditing a vault note —
  filename/frontmatter rules, per-claim recency and supersession, aliases, graduation to `permanent/`.
- Comments here carry the *why*, usually with the date and measurement that settled it. Keep that
  when editing; several of them are the only record of a silent failure.
- `jq` is assumed by hooks but not by `vault-env.sh`, which parses config with sed as a fallback
  (BSD sed — use `sed -E`, basic regex has no `\|`).
- Porting between the two runtimes is not mechanical. JS `\w` is ASCII-only where Python's is
  unicode-aware (so slugs need `\p{L}\p{N}` with the `u` flag), and `toISOString()` is UTC where
  `date.today()` is local — note filenames are dated, so that one is visible.
- Version is written in five places — `package.json`, `package-lock.json`,
  `.claude-plugin/plugin.json`, and both `.metadata.version` and `.plugins[0].version` in
  `.claude-plugin/marketplace.json`. Never bump them by hand; `scripts/release.sh` writes all five
  and CI fails the PR if they disagree. `package-lock.json` was the one that drifted, unnoticed,
  through three releases.

## Working on this repo

**`main` is protected. Never commit or push to it directly** — branch, push, open a PR, merge.
Enforced for admins and force-pushes.

```bash
git switch -c fix/short-description
git push -u origin HEAD && gh pr create --fill
```

Everything else — what CI checks, the two review workflows, why a PR that edits `claude-review.yml`
never gets reviewed (per-file, so `ci.yml` edits *are* reviewed), and the release process — is in
[docs/ci-and-releases.md](docs/ci-and-releases.md).

Three of those matter while you are still editing:

- **`claude-review.yml`'s prompt carries this repo's invariants. When a rule here changes, change
  it there too.**
- **Never bump versions by hand.** `scripts/release.sh` writes all five; CI fails on drift.
- **Merging the release PR publishes.** There is no manual tagging step.
- **Put the changelog entry under `## [Unreleased]` in the same PR** — that section becomes the
  release notes verbatim.
