# claude-memory — design

**Date:** 2026-08-15
**Status:** approved, not yet implemented
**Target repo:** `github.com/spike1292/claude-memory` (public)

## Context

The layered-memory system (vault sync, session distillation, semantic recall, audit
and eval tooling) grew inside `~/.claude`, the personal Claude Code config repo. That
repo tracks 36 files, of which 20 are the memory system and 9 are unrelated third-party
hooks. The coupling has three costs:

1. **Not installable.** Anyone who wants the memory system — including future-Henk on a
   second machine — has to clone a personal config repo and hand-merge nine hook
   registrations into their own `settings.json`.
2. **Not isolated.** Every intra-system reference is an absolute `$HOME/.claude/...`
   path (15 call sites). Nothing self-locates, so the code cannot run anywhere else.
3. **Personal data is entangled with shareable code.** `hooks/lib/vault-env.sh` carries a
   hard-coded Synology path. The eval case sets contain internal project note names.

Extracting into a standalone Claude Code plugin fixes all three, and forces a fix for a
latent bug: the 722 MB of ONNX model weights currently live *inside*
`node_modules/@huggingface/transformers/.cache`, which in a version-pinned plugin cache
would be re-downloaded on every plugin update.

**Outcome:** `/plugin marketplace add spike1292/claude-memory` installs the whole system.
`~/.claude` shrinks back to being config. Every existing `/memory:*` invocation and every
existing note reference keeps working unchanged.

## Non-goals

- Rewriting or improving the memory algorithms. This is a move, verified by unchanged
  retrieval numbers.
- Supporting Windows. The system is bash + python3 + node; Windows support is out of scope.
- Multi-user or team vault sharing.

## Naming

| Thing | Name | Why |
| --- | --- | --- |
| Repo | `claude-memory` | Descriptive, matches the GitHub URL. |
| Marketplace | `claude-memory` | Matches the repo. |
| **Plugin** | **`memory`** | Claude Code namespaces plugin commands as `/<plugin>:<command>`. Naming the plugin `memory` preserves `/memory:save`, `/memory:health`, … exactly. Renaming to `claude-memory` would break every reference in `CLAUDE.md` and in the vault notes. |

Install: `/plugin install memory@claude-memory`.

## Repository layout

```
claude-memory/
├── .claude-plugin/
│   ├── marketplace.json      name "claude-memory"; plugins:[{name:"memory", source:"./"}]
│   └── plugin.json           name "memory", version, author, homepage, repository
├── .gitignore                node_modules/, *.db, *.db-shm, *.db-wal, *.log, *.sock,
│                             __pycache__/, *.pyc, eval-cases-*.jsonl
├── README.md                 install, configuration, what each hook does, measured numbers
├── LICENSE
├── package.json              @huggingface/transformers ^4.2.0; engines.node >=22.5
├── package-lock.json         Claude Code auto-runs `npm ci` from this on install
├── commands/                 → /memory:<name>
│   ├── save.md  resume.md  health.md  prune.md
│   ├── synthesize.md  challenge.md  eval.md  graph-report.md
│   ├── install.md            NEW
│   └── doctor.md             NEW
├── skills/
│   └── protocol/
│       └── SKILL.md          → /memory:protocol
│                             note conventions, per-claim recency, supersession,
│                             retrievability aliases, domain-knowledge lifecycle
├── hooks/
│   ├── hooks.json            all nine registrations
│   ├── lib/
│   │   ├── vault-env.sh      resolve_vault / project_key / legacy_key
│   │   └── paths.mjs         NEW — node-side mirror: pluginRoot, memoryHome, vault, projectKey
│   ├── vault-memory-sync.sh          SessionStart
│   ├── insights-surface.sh           SessionStart
│   ├── memory-link-lint.sh           SessionStart
│   ├── semantic-index-refresh.sh     SessionStart
│   ├── graph-staleness-check.sh      SessionStart
│   ├── memory-recall.mjs             UserPromptSubmit
│   ├── validate-note.sh              PostToolUse (Write|Edit|MultiEdit)
│   ├── distill-session.sh            SessionEnd + Stop
│   └── distill-session.py            (child of distill-session.sh)
├── scripts/
│   ├── memory-semantic.mjs           the engine
│   ├── memory-audit-checks.mjs       mechanical half of /memory:health
│   ├── memory-eval.mjs               recall@k / MRR harness
│   ├── memory-synth-vault.mjs        deterministic synthetic vault + gold set
│   ├── prune-logs.sh
│   └── lib/model-default.mjs
└── docs/
    └── superpowers/specs/            this file
```

## Architecture

Four units, each with one job and a defined interface.

### 1. Path resolution — `hooks/lib/vault-env.sh` + `hooks/lib/paths.mjs`

The only thing every other unit depends on. Answers three questions: where is the vault,
what is this project's key, where does mutable state live.

`vault-env.sh` keeps its current bash contract (`resolve_vault`, `project_key`,
`legacy_key`) and stays dependency-free — no `jq`, so a fresh clone works before anything
is installed. Two changes:

- The hard-coded `$HOME/Library/CloudStorage/SynologyDrive-Prive/AI/Claude` fallback is
  **removed**. Resolution becomes `$CLAUDE_VAULT` → `$HOME/Documents/ClaudeVault`.
  Henk sets `CLAUDE_VAULT` in `~/.claude/settings.local.json`, which is already the
  documented mechanism and already in place.
- New `memory_home()`: `${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}`.

`paths.mjs` is new and exists to kill the `execSync('bash -c ". $HOME/.claude/hooks/lib/
vault-env.sh; ..."')` pattern at six node call sites. It exports `pluginRoot`,
`memoryHome()`, `vault()`, `projectKey(dir)`, resolving everything relative to
`import.meta.url` and shelling out to `vault-env.sh` only for `project_key` (which is
non-trivial sed). Single source of truth stays bash; node gets a typed-ish wrapper.

### 2. Self-location — the core mechanical change

All 15 hard-coded `$HOME/.claude/...` intra-system references are replaced with
file-relative resolution:

- bash: `. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/vault-env.sh"`
- node: `new URL('./lib/model-default.mjs', import.meta.url)`
- python: `pathlib.Path(__file__).resolve().parent`

**`${CLAUDE_PLUGIN_ROOT}` is deliberately *not* used for these.** It is only guaranteed in
`hooks/hooks.json` command strings and in `commands/*.md`. Self-location additionally works
in a dev checkout, under a symlink, and when a script is invoked directly — which is how
`--selftest` and manual debugging happen.

Sites to rewrite (from the inventory):

| File | Lines | Reference |
| --- | --- | --- |
| `hooks/{validate-note,insights-surface,graph-staleness-check,vault-memory-sync,semantic-index-refresh,memory-link-lint}.sh` | 14, 8, 20, 7, 18, 14 | `. "$HOME/.claude/hooks/lib/vault-env.sh"` |
| `hooks/memory-recall.mjs` | 45, 49, 88 | vault-env via execSync; `scripts/lib/model-default.mjs`; `scripts/memory-semantic.mjs --serve` |
| `scripts/memory-semantic.mjs` | 448, 449, 490 | vault-env via execSync |
| `scripts/memory-eval.mjs` | 96, 198 | vault-env via execSync; `memory-semantic.mjs` |
| `scripts/memory-audit-checks.mjs` | 314 | vault-env via execSync |
| `hooks/validate-note.sh` | 63 | `scripts/memory-audit-checks.mjs --check-file` |
| `hooks/distill-session.sh` | 42 | `hooks/distill-session.py` |
| `hooks/semantic-index-refresh.sh` | 27, 31 | `scripts/memory-semantic.mjs`; the `@huggingface/transformers` probe |

Three references to `~/.claude` are **legitimate and must not be rewritten** —
Claude Code owns those paths:

- `hooks/vault-memory-sync.sh:19` → `~/.claude/projects/<cwd-slug>/memory` (the symlink target Claude Code reads)
- `hooks/vault-memory-sync.sh:77` → `~/.claude/CLAUDE.md`
- `hooks/vault-memory-sync.sh:90` → `~/.claude/commands/memory` — **this one is deleted**, not rewritten. The vault stub-clearing logic it performs becomes obsolete once commands live in the plugin.

`hooks/graph-staleness-check.sh:58` calls `"$HOME/.claude/local/claude"`. That becomes
`command -v claude`, with the hook exiting 0 when the CLI is absent.

### 3. State directory — `$CLAUDE_MEMORY_HOME`, default `~/.claude-memory/`

Plugin caches are version-pinned (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`)
and replaced wholesale on update. Nothing mutable may live inside the plugin.

```
~/.claude-memory/
├── db/        semantic-<slug>-<model>.db          (currently ~/.claude/data/, 43 MB)
├── models/    ONNX weights                        (currently inside node_modules, 722 MB)
├── logs/      semantic-index.log, recall-<date>.jsonl
├── run/       <slug>.sock  (resident search server)
└── eval/      eval-cases-*.jsonl                  machine-local, never committed
```

The `models/` move is the substantive fix. `memory-semantic.mjs` must set the
transformers.js cache directory explicitly (`env.cacheDir` / `HF_HOME`) to
`$CLAUDE_MEMORY_HOME/models` before the first `pipeline()` call. Without it, every
`/plugin update` re-downloads 722 MB.

Migration is a one-time `mv` performed by `/memory:install`, so no index is rebuilt.

### 4. Hook registration — `hooks/hooks.json`

Nine registrations move out of `~/.claude/settings.json` into the plugin. Schema confirmed
against installed plugins:

```json
{ "hooks": { "<Event>": [ { "matcher": "...", "hooks": [
    { "type": "command", "command": "...", "timeout": 10, "statusMessage": "..." } ] } ] } }
```

| Event | Matcher | Script | statusMessage |
| --- | --- | --- | --- |
| SessionStart | — | `vault-memory-sync.sh` | Syncing memory to Obsidian vault |
| SessionStart | — | `graph-staleness-check.sh` | — |
| SessionStart | — | `semantic-index-refresh.sh` | — |
| SessionStart | — | `insights-surface.sh` | Surfacing past mistakes |
| SessionStart | — | `memory-link-lint.sh` | Linting memory note graph |
| UserPromptSubmit | — | `memory-recall.mjs` (timeout 10) | — |
| PostToolUse | `Write\|Edit\|MultiEdit` | `validate-note.sh` (timeout 10) | — |
| SessionEnd | — | `distill-session.sh` | — |
| Stop | — | `distill-session.sh` | — |

Two portability changes to the command strings:

- Drop the machine-specific `fnm exec --using=default --` wrapper. Use plain `node` behind a
  `command -v node >/dev/null 2>&1 || exit 0` guard, matching how every other installed
  plugin does it. The fnm caveat is documented in the README and checked by `/memory:doctor`.
- Quote `"${CLAUDE_PLUGIN_ROOT}/hooks/..."` — the path can contain spaces.

`MEMORY_RECALL_ENABLED` remains the opt-in gate for `memory-recall.mjs`, set by the user in
`settings.local.json`. The plugin does not enable per-prompt recall by default.

## Dependency handling

Claude Code auto-runs `npm ci` from `package-lock.json` on plugin install, but **does not run
lifecycle scripts**. `onnxruntime-node@1.24.3` fetches its native binary in a postinstall, so
the auto-install alone leaves the runtime unusable. Hence an explicit, user-driven install
step rather than a silent auto-heal.

**`/memory:install`** — idempotent, safe to re-run:
1. `npm ci` in `${CLAUDE_PLUGIN_ROOT}` (no-op if Claude Code already did it).
2. Run the `onnxruntime-node` install script explicitly.
3. `mkdir -p` the `$CLAUDE_MEMORY_HOME` tree.
4. Migrate `~/.claude/data/semantic-*.db` → `$CLAUDE_MEMORY_HOME/db/` and
   `~/.claude/data/eval-cases-*.jsonl` → `$CLAUDE_MEMORY_HOME/eval/` if present.
5. Warm the default model (`bge-m3`) into `$CLAUDE_MEMORY_HOME/models/`.
6. Run `/memory:doctor`.

**`/memory:doctor`** — read-only checklist, each line pass/fail with the fix:

| Check | Why it matters |
| --- | --- |
| `node --version` ≥ 22.5 | `node:sqlite` `DatabaseSync` is used unguarded. Currently an undocumented hard requirement. |
| `jq` on PATH | every bash hook needs it |
| `python3` on PATH | `distill-session.py` |
| `claude` on PATH | `distill-session.py` and `graph-staleness-check.sh` shell out to it headlessly |
| `@huggingface/transformers` resolvable | semantic search |
| `onnxruntime-node` native binding loads | postinstall actually ran |
| model weights present in `$CLAUDE_MEMORY_HOME/models` | otherwise first query downloads 722 MB |
| vault resolves and is writable | `$CLAUDE_VAULT` set or default exists |
| `$CLAUDE_MEMORY_HOME/db/` readable, index non-empty | recall will otherwise silently abstain |
| recall socket alive / server startable | per-prompt recall |
| `MEMORY_RECALL_ENABLED` set | recall is opt-in and off by default |
| `context-mode` CLI on PATH | vault re-index at SessionEnd |

**Degraded behaviour.** `semantic-index-refresh.sh` already exits quietly when
`@huggingface/transformers` is absent; it gains a single-line stderr note pointing at
`/memory:install`. Everything that does not need embeddings — vault sync, insights surfacing,
link lint, distillation, note validation, log pruning — works with zero dependencies beyond
`jq` and `python3`.

## Standing instructions

Plugins cannot inject into `CLAUDE.md`. The memory protocol splits by how often it is needed:

- **Every session** — the retrieval rules that change behaviour in the moment (expand queries
  into domain vocabulary before searching; scope `ctx_search` to the right layer; do not pass
  `--layer` to `memory-semantic.mjs`; the layer table). `vault-memory-sync.sh` already writes
  to stdout at SessionStart, which Claude Code injects as context. It emits this compact block.
- **On demand** — the full note conventions (frontmatter, confidence, per-claim recency and
  supersession, aliases, wikilink discipline, promotion lifecycle) become
  `skills/protocol/SKILL.md`, invoked as `/memory:protocol` or picked up by the model when
  writing notes. Commands and skills share one namespace, so `protocol` must not collide with
  any `commands/*.md` name.

`~/.claude/CLAUDE.md` keeps only the machine-specific parts — where `CLAUDE_VAULT` points, the
Synology symlink caveat — and points at the plugin for everything else.

## Eval and the public case set

`memory-eval.mjs:17` states the case sets are gitignored because they contain vault content.
Confirmed: `eval-cases-authored.jsonl` holds internal project questions and note names.

- **Personal case sets stay machine-local** in `$CLAUDE_MEMORY_HOME/eval/`, gitignored, never
  committed. `.gitignore` carries `eval-cases-*.jsonl` as a belt-and-braces rule.
- **The public reproducible set** is generated by `memory-synth-vault.mjs --seed <n>`, which
  builds a deterministic synthetic vault with a gold query set. That is what CI and any other
  user can run to verify the engine works, and what the README quotes.

## Verification

Extraction is verified by unchanged retrieval numbers, not by inspection.

**Baseline, captured before any change** (2026-08-15, `bge-m3`, real vault, slug
`gitlab.essent.nl-sitecoreplus-frontend`):

| Set | n | @1 | @3 | @5 | @10 | MRR |
| --- | --- | --- | --- | --- | --- | --- |
| `eval-cases-authored.jsonl` (EN) | 28 | 0.393 | 0.643 | **0.821** | 0.893 | **0.546** |
| `eval-cases-nl.jsonl` (NL) | 15 | 0.467 | 0.800 | **0.867** | 0.933 | **0.628** |

Note the trap that produced a false 3.6% on the first attempt: `memory-eval.mjs` derives the
slug from cwd, so it must be run with an explicit
`--slug gitlab.essent.nl-sitecoreplus-frontend` from any other directory.

**Acceptance gate, in order:**

1. `node scripts/memory-semantic.mjs --selftest` passes in the new repo.
2. `node scripts/memory-eval.mjs --selftest` passes.
3. `node hooks/distill-session.py --selftest` passes.
4. Synthetic-vault eval reproduces the same numbers run from the old and the new tree.
5. Plugin installed from a local marketplace path; `/memory:doctor` all-green.
6. Both real-vault evals above reproduce **to three decimals**.
7. A live session shows: vault sync symlink correct, insights surfaced, recall injecting on a
   known-good prompt, `validate-note.sh` warning on a bad frontmatter write, `distill-session`
   writing an Insight at SessionEnd.
8. `/memory:save`, `/memory:resume`, `/memory:health`, `/memory:prune`, `/memory:challenge`
   each run end-to-end.

Only after 1–8 pass does the cutover happen.

## Cutover in `~/.claude`

**Delete** (20 files): `hooks/lib/vault-env.sh`, `hooks/{vault-memory-sync,insights-surface,
memory-link-lint,semantic-index-refresh,graph-staleness-check,validate-note}.sh`,
`hooks/memory-recall.mjs`, `hooks/distill-session.{sh,py}`, `scripts/{memory-semantic,
memory-audit-checks,memory-eval,memory-synth-vault}.mjs`, `scripts/lib/model-default.mjs`,
`scripts/prune-logs.sh`, `commands/memory/*.md` (8 files).

**Stays behind:** `hooks/ast-tools-nudge.sh`, `hooks/cbm-code-discovery-gate`,
`hooks/cbm-session-reminder`, `hooks/context-mode-cache-heal.mjs`, `scripts/resolve-type.mjs`.

**Edit:**
- `settings.json` — remove the nine memory hook registrations; keep `cbm-*`,
  `context-mode-cache-heal`, `rtk`, `ast-tools-nudge`.
- `package.json` / `package-lock.json` — drop `@huggingface/transformers` and the
  `allowScripts` entry; `~/.claude` no longer needs a 1.1 GB `node_modules`.
- `.gitignore` — drop the `!/scripts/` … re-additions that only existed for memory files;
  keep what the remaining hooks need.
- `CLAUDE.md` — replace the memory sections with a pointer to the plugin, keeping only the
  machine-specific vault configuration and the Synology symlink caveat.

**Rollback:** the deletion is one commit in `~/.claude`. `git revert` restores the files, and
re-adding the nine `settings.json` entries restores the old behaviour. Because the plugin
writes state to `$CLAUDE_MEMORY_HOME` rather than `~/.claude/data`, both trees can coexist
during the trial; only the hook registrations decide which one is live.

## Risks

| Risk | Mitigation |
| --- | --- |
| `${CLAUDE_PLUGIN_ROOT}` is not expanded inside `commands/*.md` bodies | Test this first, before writing eight command files. If it fails, add a `bin/memory` self-locating dispatcher and have commands call that — one file changes, not eight. |
| `npm ci` skipping lifecycle scripts leaves `onnxruntime-node` broken | Exactly why `/memory:install` and `/memory:doctor` exist. Doctor loads the native binding rather than checking the directory exists. |
| Model-cache redirect silently ignored, weights land in `node_modules` again | Doctor asserts weights are under `$CLAUDE_MEMORY_HOME/models`, not merely that a model loads. |
| Plain `node` in hooks resolves to a different version than `fnm` default | Doctor checks `node --version` ≥ 22.5 explicitly, since `node:sqlite` fails obscurely otherwise. |
| Removing the Synology fallback breaks the current machine | `CLAUDE_VAULT` is already set in `settings.local.json`; doctor verifies the vault resolves before cutover. |
| Public repo leaks vault content via eval cases | Case sets never enter the repo; `.gitignore` carries `eval-cases-*.jsonl`; final pre-push grep for `essent`, `synology`, `henkbakker`. |
