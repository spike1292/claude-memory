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
| `python3` | session distillation (`Insights/`); optional |
| `claude` on PATH | distillation and graph refresh shell out to it headlessly; optional |
| macOS / Linux | bash + python3; no Windows support |

`/memory:doctor` checks all of these and tells you what each one being absent costs you.

## Configuration

Set these in `~/.claude/settings.local.json` (machine-local, gitignored):

```json
{
  "env": {
    "CLAUDE_VAULT": "/absolute/path/to/your/Obsidian/vault",
    "MEMORY_RECALL_ENABLED": "1"
  }
}
```

| Variable | Default | What it does |
| --- | --- | --- |
| `CLAUDE_VAULT` | `~/Documents/ClaudeVault` | vault root |
| `CLAUDE_MEMORY_HOME` | `~/.claude-memory` | machine-local state: indexes, model weights, logs, eval cases |
| `MEMORY_RECALL_ENABLED` | unset (off) | arm per-prompt recall |
| `MEMORY_SEMANTIC_MODEL` | `bge-m3` | also `bge-small-en`, `e5-multi` |

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

`<project>` is the **normalised git remote** (`github.com-you-yourrepo`), not the checkout path — so
the same repo maps to one memory folder on every machine, in every worktree, from any subdirectory.

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
python3 hooks/distill-session.py --selftest
scripts/doctor.sh
```

Nothing resolves an absolute install path: bash uses `BASH_SOURCE`, node uses `import.meta.url`,
python uses `__file__`. So a dev checkout, a symlink, and the version-pinned plugin cache all work
the same way. `${CLAUDE_PLUGIN_ROOT}` is used only in `hooks/hooks.json` and command bodies, where
it is guaranteed — commands fall back to the `$CLAUDE_MEMORY_HOME/plugin-root` breadcrumb the
SessionStart hook writes.

## License

MIT
