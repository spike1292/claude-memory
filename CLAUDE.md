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
node hooks/distill-session.mjs   --selftest    # 22 assertions
scripts/doctor.sh                              # the /memory:doctor body; always exits 0
```

Exercising the real pipeline:

```bash
node scripts/memory-semantic.mjs --index [dir]        # idempotent; --rebuild forces re-embed
node scripts/memory-semantic.mjs --query "..." [-k 5]
node scripts/memory-semantic.mjs --coverage | --dupes | --clusters | --check-embedding
DISTILL_DRYRUN=1 python3 hooks/distill-session.py <transcript> <cwd>   # no LLM call
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
`import.meta.url`, Python uses `__file__`. `${CLAUDE_PLUGIN_ROOT}` is only reliable inside
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
`context-mode` (a CLI) backs `ctx_search`, a *second* BM25/FTS5 index that `memory-semantic.mjs`
never reads; when it is absent the distiller falls back to refreshing the plugin's own index, and
only `ctx_search` freshness is lost. `codebase-memory-mcp` (an MCP server, so PATH cannot detect
it) backs the L4 `Graph/` layer and `/memory:graph-report`; without it, skip L4 — nothing fails,
and `graph-staleness-check.sh` stays silent because it never generates a first report.

Do not write code that assumes either is present, and do not describe a missing one as breakage.
State precisely what degrades — an earlier warning claimed the vault "stops being searchable" when
`context-mode` was gone, which was never true.

**Hooks are best-effort and must never block.** Every one degrades to a no-op when its dependency is
missing, `validate-note.sh` warns rather than blocking a write, and the heavy hooks
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
- Version is written in four places — `package.json`, `.claude-plugin/plugin.json`, and both
  `.metadata.version` and `.plugins[0].version` in `.claude-plugin/marketplace.json`. Never bump
  them by hand; `scripts/release.sh` does all four and CI fails the PR if they disagree.

## Working on this repo

**`main` is protected. Never commit or push to it directly** — branch, push the branch, open a PR,
merge it. This holds for force-pushes and for admins; GitHub will reject the push.

```bash
git switch -c fix/short-description
# ... work, then:
git push -u origin HEAD && gh pr create --fill
```

CI (`.github/workflows/ci.yml`) runs the five self-tests on Node 22 and 24 against a **synthetic**
vault built by `memory-synth-vault.mjs`, plus `bash -n` over every shell file and the version-drift
check. It must be green to merge. `memory-semantic.mjs --selftest` hard-fails when it finds no
notes rather than skipping, so CI always has to build that synthetic vault first.

Two Claude workflows, deliberately not three:

- `claude-review.yml` reviews every PR — this repo requires zero approvals, so it is the only
  second reader. Its prompt carries the repo's invariants; **when a rule here changes, change it
  there too.** It skips fork PRs, which get no secrets on a `pull_request` trigger.
- `claude.yml` answers `@claude` mentions on issues and PR comments. Complementary, not a reviewer.

`/install-github-app` also generates `claude-code-review.yml`, a second auto-reviewer on the same
`pull_request` trigger. It was deleted — two reviewers means two reviews on every PR. If you re-run
the installer it will come back; delete it again, or delete `claude-review.yml` instead and accept
a generic prompt.

Both use `CLAUDE_CODE_OAUTH_TOKEN` (a Claude subscription), not `ANTHROPIC_API_KEY`. A workflow
whose guard names a different secret than the action consumes will skip forever and report success.

**A PR that edits a workflow file does not get reviewed.** `claude-code-action` runs only when the
workflow is byte-identical to the copy on the default branch — a PR could otherwise rewrite the
workflow and steal the token. On a mismatch it warns and exits *success*, so the check is green
and no review exists. Confirm with `Exiting due to workflow validation skip` in the job log before
investigating anything else. Consequence worth planning around: CI changes are exactly the changes
that never get a second reader, so review those by hand.

CI also fails if a Python dependency reappears — `.py` files and shell scripts calling `python`
are both rejected.

### Releasing

Changelog entries land with the change, under `## [Unreleased]` in `CHANGELOG.md` — Keep a
Changelog format, and the release notes are generated from that section, so it is the only place
the story is written.

```bash
scripts/release.sh 0.1.4      # bumps all four versions, closes Unreleased, opens the PR
# merge the PR, then:
git switch main && git pull
git tag v0.1.4 && git push origin v0.1.4
```

The tag — not the merge — is what publishes. `.github/workflows/release.yml` checks the tag against
`package.json`, extracts that version's changelog section, and creates the GitHub release from it.
