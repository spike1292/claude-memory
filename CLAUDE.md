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

Everything is a self-test inside the file it tests; there is no test framework.

```bash
node scripts/memory-semantic.mjs --selftest    # 52 assertions + chunk checks against real notes
node scripts/memory-eval.mjs     --selftest    # 9 assertions
node scripts/memory-synth-vault.mjs --selftest
node scripts/memory-audit-checks.mjs --selftest # 44 assertions
node hooks/distill-session.mjs   --selftest    # 28 assertions
node hooks/validate-note.mjs     --selftest    # 24 assertions
node hooks/insights-surface.mjs  --selftest    # 13 assertions
node hooks/memory-link-lint.mjs  --selftest    # 17 assertions
node hooks/lib/paths.mjs         --selftest    # 9 assertions, project-key cache vs vault-env.sh
scripts/doctor.sh                              # the /memory:doctor body; always exits 0
```

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

**Two runtimes, two mirrors of the same resolution logic.** `hooks/lib/vault-env.sh` is the
source of truth for vault path, `$CLAUDE_MEMORY_HOME`, recall arming, and `project_key`.
`hooks/lib/paths.mjs` mirrors it for Node, shelling out for `project_key` only — that sed pipeline
over git remote URLs stays single-implementation. Change one, check the other.

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
plugin.** Plugin cache dirs are version-pinned and replaced wholesale on `/plugin update`; anything
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

**Two optional integrations, neither installed by this plugin, neither on the retrieval path.**
`context-mode` backs `ctx_search` (a second index `memory-semantic.mjs` never reads);
`codebase-memory-mcp` backs the L4 `Graph/` layer. Details in
[docs/optional-integrations.md](docs/optional-integrations.md).

Do not write code that assumes either is present, and do not describe a missing one as breakage.
State precisely what degrades — an earlier warning claimed the vault "stops being searchable" when
`context-mode` was gone, which was never true.

**Shell vs Node in hooks: fork count decides, not language.** bash's floor is ~5 ms and Node's
~40 ms, but a fork costs ~3.5 ms *each*, so a hook that loops over notes belongs in Node while a
**gate** that decides cheaply and spawns belongs in bash. Numbers, what is ported, and what must
not be:
[docs/decisions/2026-08-17-shell-vs-node-hooks.md](docs/decisions/2026-08-17-shell-vs-node-hooks.md).

Three things from it that bite in the moment: **do not port `vault-memory-sync.sh`** (it moves
files and repoints symlinks in a live vault, and has cost 24 notes once); **quote no timing without
saying whether the vault was cloud-backed or pinned offline**, which alone moves a hook 166 ms vs
131 ms; and **measure against a vault with real note counts** — the shell link lint looked like a
74 ms hook in this repo, which has no L1 notes, while taking 10.9 s on a 49-note project.

`vault-env.sh` reads the same project-key cache `paths.mjs` writes, so shell hooks no longer fork
git for it. Both sides stamp with **whole-second** mtime; a float would make every shell lookup a
silent miss.

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
