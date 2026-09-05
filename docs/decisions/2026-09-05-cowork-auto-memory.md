# A third memory system: `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, and why we only warn about it

2026-09-05 — an agent working in this repo wrote a lesson to
`~/Library/CloudStorage/SynologyDrive-henk/Work/AI/`, a folder that has nothing to do with this
plugin or with the vault. The user caught it: "why are you writing to this location? the-vault is
in a other place."

## What is true on disk

`docs/decisions/2026-08-22-auto-memory.md` already covers Claude Code's own `autoMemoryDirectory`
feature: per-repo, reads `~/.claude/projects/<project>/memory/MEMORY.md` — the exact file this
plugin symlinks there. That decision ("co-operate") stands and is not what this record is about.

This machine's `~/.claude/settings.json` carries a different key, in `env`:

```
"CLAUDE_COWORK_MEMORY_PATH_OVERRIDE": "/Users/h32232/Library/CloudStorage/SynologyDrive-henk/Work/AI"
```

Not `autoMemoryDirectory`. `docs/research/2026-08-21-comparison-evidence.md` §8 studied
`autoMemoryDirectory` in depth and never names this variable — it did not exist in that research,
or belongs to a feature outside Claude Code proper. Whichever it is, it behaves differently from
the documented one in every way that matters here:

| | Claude Code auto memory (`autoMemoryDirectory`) | this feature (`CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`) |
| --- | --- | --- |
| scope | per repo (git-derived key) | one folder for every repo on the machine |
| file | `MEMORY.md`, plain | `MEMORY.md` index plus typed notes (`user`/`feedback`/`project`/`reference`), each with frontmatter |
| overlaps our symlink? | yes — same path | no — unrelated path, never written by this plugin |

A session in this repo is told about it directly, via a system-prompt block titled "auto memory"
that instructs the agent to write typed notes there with the `Write` tool. That instruction has no
concept of "this repo" — it is the same folder and the same instruction in every project on the
machine.

## The decision

**Warn, don't merge.** The three options considered:

- **Point it at the vault.** Rejected: the feature is not per-repo, so pointing it at
  `~/Development/the-vault` would collapse every project's notes the agent decides are "lessons"
  into one place, unscoped, and this plugin's own layered notes would sit next to notes this
  plugin's tooling knows nothing about — no frontmatter contract, no dedup, no retrieval.
- **Say nothing, rely on `CLAUDE.md`.** Already tried, in effect: `CLAUDE.md` does not currently
  mention this feature at all, and a live system-prompt instruction to write there outranks a
  paragraph the agent has to recall unprompted. This is what produced the incident.
- **Warn from `/memory:doctor`.** Adopted. The env var is trivial to detect, and naming it
  explicitly turns "an agent quietly wrote to the wrong place" into "a report you can paste into an
  issue already says this is set." Matches how `AUTO_MEMORY_CAP` is handled for the *other* auto
  memory feature — report the collision, do not try to reconcile it in code.

`/memory:doctor` now prints a `cowork auto memory` section: `ok` when the env var is unset, `WARN`
naming its value and pointing back at this record when it is set. Read-only, like the rest of the
report — it does not unset the variable or redirect the feature.

## What this does not fix

Nothing here stops a session writing to that folder — the instruction still fires from the system
prompt, and no code in this repo can suppress another product's system prompt. The warning exists
so a human notices the collision is live, the same way the `AUTO_MEMORY_CAP` line exists so a human
notices `MEMORY.md` is being truncated rather than fixing the truncation.
