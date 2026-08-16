# claude-memory

Layered memory for [Claude Code](https://claude.com/claude-code), backed by a plain-Markdown
Obsidian vault.

Claude Code forgets everything between sessions. This plugin gives it a vault it writes to and
reads from: per-project facts, session logs, lessons distilled automatically from what actually
happened, and hybrid semantic + lexical retrieval so a question phrased differently from the note
still finds it.

Everything is plain Markdown on your disk. The embedding model runs locally via ONNX — **notes are
never sent anywhere.**

## Install

```
/plugin marketplace add spike1292/claude-memory
/plugin install memory@claude-memory
/memory:install
/memory:doctor
```

`/memory:install` is not optional. Claude Code installs npm dependencies from the lockfile but
**skips lifecycle scripts**, and `onnxruntime-node` fetches its native binary in a postinstall — so
the package directory exists while the runtime is unusable. `/memory:install` closes that gap,
migrates any state from a previous install, and warms the model.

Without it, everything except semantic search still works.

### Requirements

| | |
| --- | --- |
| **Node ≥ 22.5** | hard requirement — the engine uses the built-in `node:sqlite` |
| `jq` | every hook parses its stdin payload with it |
| `claude` on PATH | distillation and graph refresh shell out to it headlessly; optional |
| macOS / Linux | bash + node; no Windows support |

There is **no Python dependency.** The session distiller was ported to Node on 2026-08-16 — Node
was already a hard requirement, so Python only added a second runtime that could be the wrong
version. It usually was: macOS ships 3.9, which cannot parse the `str | None` annotations the
distiller used, so on a stock Mac `Insights/` silently stopped being written.

`/memory:doctor` checks all of these and tells you what each one being absent costs you.

### Optional integrations

Both are separate tools with their own indexes. Neither is installed by this plugin, neither is
required, and **the plugin's own retrieval path does not read from either.**

| | What it adds | Without it |
| --- | --- | --- |
| [`context-mode`](#context-mode-ctx_search) CLI | `ctx_search` — a second, BM25/FTS5 index over the vault | `ctx_search` goes stale; `memory-semantic.mjs` is unaffected |
| `codebase-memory-mcp` server | the L4 `Graph/` layer and `/memory:graph-report` | no L4 digest; L1–L3 are unaffected |

#### context-mode (`ctx_search`)

The SessionEnd distiller refreshes context-mode's index so notes written this session are
searchable next session, and several commands (`/memory:health`, `/memory:challenge`,
`/memory:eval`) use `ctx_search` as their keyword arm.

It is **not** what powers recall. `scripts/memory-semantic.mjs` carries its own vector arm *and*
its own BM25 arm in its own SQLite file, and that is the primary retrieval path. When
`context-mode` is not on PATH the distiller falls back to refreshing that index instead, so the
notes you just wrote are still retrievable — only `ctx_search` drifts.

```bash
npm i -g context-mode     # reinstall for the Node version you are now on
/memory:prune             # rebuild the index to catch up what was missed
```

The CLI installs into the *current Node version's* bin dir, so an `fnm`/`nvm` version switch drops
it from PATH. That used to fail silently; both `/memory:doctor` and the SessionStart hook now say
so, and say precisely what is degraded rather than implying the vault went dark.

#### codebase-memory-mcp (the `Graph/` layer)

L4 is the only layer that is not written by this plugin. `/memory:graph-report` asks the
`codebase-memory-mcp` MCP server for a structural digest of the *code* — architecture, call
graphs, entry points, `search_graph` / `trace_path` / `get_architecture` — and writes it to
`<vault>/Graph/<project>/GRAPH_REPORT.md`. `graph-staleness-check.sh` regenerates it in the
background once the repo has commits newer than the report.

Configure the server in your Claude Code MCP settings first; it is not a CLI, so nothing on PATH
can detect it. If you never configure it, **skip L4 entirely** — no hook fails, `graph-staleness-check`
stays silent because it never auto-generates a first report, and L1–L3 work exactly as documented.

Generated bodies sit between `<!-- @generated -->` sentinels so hand-written notes under the
trailing `## Notes` heading survive a regeneration.

## Configuration

Settings live in **`~/.claude-memory/config.json`**:

```json
{
  "vault": "/absolute/path/to/your/Obsidian/vault",
  "recall": true,
  "model": "bge-m3"
}
```

| Key | Default | What it does |
| --- | --- | --- |
| `vault` | `~/Documents/ClaudeVault` | vault root |
| `recall` | `false` | arm per-prompt recall |
| `model` | `bge-m3` | also `bge-small-en`, `e5-multi`. Changing it means a full re-index. |

`/memory:install` writes this file. `/memory:doctor` prints which source each value came from, and
**hard-fails if you are pointed at an empty vault while a populated one exists** — the failure that
an "is the directory there?" check cannot see.

**Put configuration here, not in `~/.claude/settings.json`'s `env` block.** A config file is read
when the hook runs, so it does not depend on what a given process inherited or on when the value was
written — a `CLAUDE_VAULT` added to `settings.local.json` mid-session did not reach that session's
hooks, and the SessionStart hook duly built an empty vault at the default path. Both ponytail and
context-mode keep their settings in their own file for the same reason.

Environment overrides are still honoured where they do reach the process:
`CLAUDE_VAULT`, `MEMORY_RECALL_ENABLED=1`, `MEMORY_SEMANTIC_MODEL`, and `CLAUDE_MEMORY_HOME`
(which relocates the state directory itself, so it can only be an env var).

**Per-prompt recall ships inert on purpose.** Injecting retrieved notes into every prompt changes
how every session reads; that should be your decision, not a default.

## What it does

### Every session start

| Hook | What it does |
| --- | --- |
| `vault-memory-sync` | points this project's memory dir at its vault folder; emits the standing retrieval rules |
| `insights-surface` | surfaces recent `Mistakes/` titles, so past lessons are in context before similar work |
| `memory-link-lint` | names L1 notes reachable only from the MOC — an orphan in the note graph |
| `semantic-index-refresh` | refreshes the vector index in the background; a no-op costs a stat pass |
| `graph-staleness-check` | regenerates the codebase graph digest when commits have moved past it |

### While you work

`memory-recall` (UserPromptSubmit, opt-in) injects a bounded brief of relevant notes, and abstains
when nothing scores well enough — silence is the default, not a guess.

`validate-note` (PostToolUse) warns on vault writes that break the note conventions: unquoted
colons in frontmatter, a metric with no provenance, "superseded" written in prose where no
mechanical check can see it. It warns; it never blocks.

### Every session end

`distill-session` reads the transcript and extracts patterns, mistakes, and decisions into
`Insights/`, deduping against what is already there. `<private>…</private>` blocks are redacted
before extraction.

## Commands

| | |
| --- | --- |
| `/memory:save` | write a session summary to `Logs/<project>/` |
| `/memory:resume` | restore context from the latest log |
| `/memory:health` | audit for contradictions, stale claims, orphans (asks before deleting) |
| `/memory:prune` | archive old logs, dedup notes, refresh both indexes |
| `/memory:synthesize` | consolidate a cluster of notes into one `permanent/` note |
| `/memory:challenge` | make the vault argue *against* a decision you are about to make |
| `/memory:eval` | measure retrieval: recall@k and MRR against a case set |
| `/memory:graph-report` | regenerate the codebase graph digest |
| `/memory:protocol` | the note conventions, as an on-demand skill |
| `/memory:install` · `/memory:doctor` | set up and diagnose |

## Layout

```
<vault>/
├── Memory/<project>/     L1 — atomic facts, decisions; MEMORY.md is the MOC, auto-loaded
├── Logs/<project>/       L2 — timestamped session summaries
├── Insights/<project>/   L3 — auto-distilled Patterns / Mistakes / Decisions
├── Graph/<project>/      L4 — codebase graph digest
└── permanent/            cross-project notes that graduated out of a single project

$CLAUDE_MEMORY_HOME/      never in the plugin — plugin caches are wiped on update
├── db/  models/  logs/  run/  eval/
```

## How project identity works

Vault folders are keyed on the **normalised git remote**, not the checkout path:

```
git@gitlab.example.com:Group/Repo.git       ─┐
https://gitlab.example.com/Group/Repo.git   ─┼─→  gitlab.example.com-group-repo
https://user:token@gitlab.example.com/...   ─┘     (credentials stripped)
```

So the same project maps to one memory folder on every machine and from every checkout — and
`cd`-ing into a subdirectory does not fork a second, invisible memory. Repos with no remote fall
back to the directory name; non-git directories fall back to the path-slug.

`~/.claude/projects/<cwd-slug>/` keeps its own name — Claude Code owns that path — and only its
`memory` symlink is repointed.

## Sharing

**This is the engine. Your vault is not in it and must never be.** Notes routinely contain
colleague names, account IDs, internal hostnames, and personal material. The same goes for eval
case sets, which are generated *from* the vault — that is why they live in
`$CLAUDE_MEMORY_HOME/eval/` and are gitignored here.

For team knowledge, do not share the vault — check the facts into the *project's own* repo under
`docs/`, where code review and CODEOWNERS apply. Personal vault, shared project docs.

## Troubleshooting

**"embedding runtime not installed" at session start.** Claude Code installed the packages but
skipped `onnxruntime-node`'s postinstall, so the native binary is missing. `/memory:install`.

**"context-mode not on PATH" at session start.** Optional — see
[context-mode](#context-mode-ctx_search) above. Only `ctx_search` is affected; recall keeps
working.

**Notes stopped being found after deleting some.** The keyword index is append-only, so deletions
leave stale chunks behind. `/memory:prune` purges and rebuilds; a plain re-index does not.

**Weights re-downloaded after a plugin update.** They should be in `$CLAUDE_MEMORY_HOME/models`,
outside the version-pinned plugin cache. `/memory:doctor` warns if they end up inside the plugin.

**Vault on iCloud / Dropbox / Synology: never put symlinks *inside* it.** Sync clients replace
*directory* symlinks with empty directories and rename the original to a `*_Conflict` entry. File
symlinks survive. A symlink pointing *into* the vault from outside is fine — that is how the memory
directory is wired.

**Never point a hook at a throwaway vault on a live machine.** `vault-memory-sync.sh` repoints the
real `~/.claude/projects/*/memory` symlink to whatever `CLAUDE_VAULT` says. It copies rather than
moves (it used to move, which cost 24 notes once), but you will still have to repoint it back.
Isolate `HOME`, not just `CLAUDE_VAULT`, when testing.

**Duplicate notes keep reappearing after you merge them.** The distiller reconciles on write
(token-Jaccard ≥ 0.45, same folder) and updates the existing note instead of adding a near-duplicate.
If it recurs, the two titles score below the threshold; `hooks/distill-session.py` has the knob and
a self-test with real cases.

## Known gaps

- **`MEMORY.md` has no size limit** and is auto-loaded every session, so it grows unbounded.
- **Notes have no expiry**, so phase-specific facts linger after the phase ends.
- **The real-vault eval sets are small and self-authored** (28 EN, 15 NL), so one case is 3.6
  points and the numbers measure one vault, not memory systems in general. Read MRR and direction,
  not single moves.
- **The generated benchmark's English set is at its ceiling** — bge-m3 scores 100%, so it is a
  tripwire for breakage, not an instrument for improvement. One hardening attempt failed, and the
  stronger version was rejected because the acceptance test could not detect the ambiguity it would
  introduce.
- **Secret redaction is opt-in** (`<private>…</private>`), not automatic.
- **Promotion to `permanent/` is still mostly unrun.** `--clusters` reports dozens of topics with no
  consolidated note. The tooling finds them; writing them is judgement and takes time.
- **No Windows support.** bash, python3, and POSIX paths throughout.

## Retrieval

`scripts/memory-semantic.mjs --query "..."` runs a vector arm and a keyword arm and rank-fuses
them, which is why it answers both "how long was the site down" and `WAF`.

Measured on a real 3,400-chunk vault with `bge-m3`, against author-written paraphrases that share
no distinctive term with the target note:

| case set | n | recall@1 | @5 | @10 | MRR |
| --- | --- | --- | --- | --- | --- |
| English paraphrases | 28 | 0.393 | **0.821** | 0.893 | 0.546 |
| Dutch paraphrases | 15 | 0.467 | **0.867** | 0.933 | 0.628 |
| same English set, keyword-only | 28 | 0.071 | 0.250 | 0.464 | 0.158 |

Those case sets contain vault content, so they are machine-local and not in this repo. To
reproduce the numbers on your own machine, or to check a change did not regress retrieval, generate
a deterministic synthetic vault:

```bash
node scripts/memory-synth-vault.mjs --out /tmp/bench --notes 300 --seed 7
node scripts/memory-semantic.mjs --vault /tmp/bench --slug bench --index --rebuild
node scripts/memory-eval.mjs --vault /tmp/bench --slug bench --run --cases /tmp/bench/cases-paraphrase.jsonl
```

**Any recall figure quoted anywhere must name the case set it came from.** Questions rewritten per
run measure the questions, not the retrieval.

## Development

```bash
node scripts/memory-semantic.mjs --selftest    # 52 assertions + real-note chunk checks
node scripts/memory-eval.mjs     --selftest
node scripts/memory-synth-vault.mjs --selftest
node scripts/memory-audit-checks.mjs --selftest
node hooks/distill-session.mjs   --selftest
scripts/doctor.sh
```

Nothing resolves an absolute install path: bash uses `BASH_SOURCE` and node uses
`import.meta.url`. So a dev checkout, a symlink, and the version-pinned plugin cache all work
the same way. `${CLAUDE_PLUGIN_ROOT}` is used only in `hooks/hooks.json` and command bodies, where
it is guaranteed — commands fall back to the `$CLAUDE_MEMORY_HOME/plugin-root` breadcrumb the
SessionStart hook writes.

### Contributing

`main` is protected — branch, push, open a PR. CI runs the self-tests on Node 22 and 24 against a
generated synthetic vault (never a real one) and must be green to merge.

Put a note under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md) in the same PR as the change.
That section becomes the release notes verbatim, so it is the only place the change gets described.

### Releasing

```bash
scripts/release.sh 0.1.4      # bumps every version field, closes Unreleased, opens the PR
# merge it, then:
git switch main && git pull
git tag v0.1.4 && git push origin v0.1.4
```

The tag publishes the release, not the merge. Version lives in four places (`package.json`,
`.claude-plugin/plugin.json`, and two fields in `.claude-plugin/marketplace.json`); the script
writes all four and CI fails the PR if they ever drift apart.

## License

MIT
