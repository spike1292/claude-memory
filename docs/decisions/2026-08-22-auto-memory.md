# Claude Code's auto memory reads our `MEMORY.md`: co-operate, and bound it

2026-08-22 — settles [#75](https://github.com/spike1292/claude-memory/issues/75). Evidence in
[docs/research/2026-08-21-comparison-evidence.md](../research/2026-08-21-comparison-evidence.md) §8;
the position is stated as identity in [docs/vision.md](../vision.md) §1.

## What is true on disk

Claude Code's own auto memory reads `~/.claude/projects/<project>/memory/MEMORY.md` — the exact path
this plugin symlinks into the vault. Measured on this machine, 2026-08-22:

| measurement | value |
| --- | --- |
| `~/.claude/projects/*/memory` entries | 24 |
| …that are symlinks into the vault | 23 |
| …that are a leftover real directory | 1 (a stale cwd-slug, scoped out in #75) |
| `autoMemoryDirectory` set in any settings scope | no |

A session in this repo shows the vault's `MEMORY.md` injected and labelled *"user's auto-memory,
persists across conversations"*. This is not a future collision; it has been live for weeks.

## The decision

**Co-operate.** Claude Code owns `MEMORY.md` and the per-prompt slot. This plugin fills that slot
well and adds every layer above it. The alternative — `autoMemoryDirectory` pointed elsewhere so the
two trees never meet — was recommended once in #75 and rejected, for three reasons that only became
clear from the evidence note:

- **`autoMemoryDirectory` replaces the whole directory**, with no `<project>` segment documented as
  appended. A user-scope value may collapse every repo into one directory. Separating would need a
  per-repo setting we would have to document and users would have to maintain.
- **The project keys do not agree and never will.** Claude Code slugs from the git repository; we
  normalise the git remote. Two clones of one repo get two of theirs and one of ours. No setting
  reconciles that, so "separate" does not buy a clean mapping either.
- **Separating buys nothing we are actually losing.** The co-operating arrangement's real cost is
  the load cap, and that cap is ours to respect in either design.

What co-operating does cost, stated rather than hidden: a dependency on Claude Code continuing to
follow a symlink at that path, which is undocumented, and which it has fenced at five other
`.claude` paths. If that changes, our notes stop being injected — they are not lost, because the
vault is the source of truth and every index is derived.

## The bound

Claude Code keeps the first **200 lines or 25 KB** of `MEMORY.md`, whichever comes first, and drops
the rest. Its own over-limit error goes to Claude in the transcript, after *its* writes — for a
`MEMORY.md` it did not author there is no documented load-time check at all. So nothing upstream
reports the truncation, to anyone.

That makes the bound ours. It is one constant, `AUTO_MEMORY_CAP` in
`hooks/lib/memory-link-lint.mjs`, read in two places:

- **The SessionStart lint** reports the MOC's size from 80% of the cap, and says outright that
  content is being dropped past 100%.
- **`/memory:doctor`** reports every `Memory/<slug>/MEMORY.md` in the vault against the cap. Only
  the project it is run from is named — that report is what people paste into issues, and the other
  slugs are normalised remotes of private repos.

Measured the day this landed: this repo's index is at 7% of the cap, and a work repo's is at 86%.
That second number is why 80% is the warning threshold rather than 95%.

**Nothing trims the file.** Deciding what leaves the MOC is judgement, the same reason the link lint
names orphans rather than linking them. Reporting is the bound; trimming stays a human act.

## The frontmatter stamp: keep it, write nothing, strip nothing

#75 asked whether to welcome the `modified` stamp Claude Code writes into files that already have
YAML frontmatter, on the assumption it had not started. It had. Re-measured 2026-08-22 over
`Memory/` in this vault:

| field | notes carrying it | of |
| --- | --- | --- |
| `metadata.modified` | 41 | 59 |
| `node_type` | 55 | 59 |

The original check reported 0 because it grepped `^modified:` and the field is nested under
`metadata:`. That is a recorded failure mode in this vault — `confidence:` is nested the same way,
and `scripts/lib/memory-audit-checks.mjs` exists partly to assert it. **A `^`-anchored grep over
vault frontmatter is a defect**; reuse the audit checks rather than re-grepping.

This plugin writes none of those fields, and against a stamped note `hooks/validate-note.mjs` exits
0, `hasConfidence()` is true and `checkFile()` reports nothing. So the answer is **keep**: they pass
through untouched. We do not write them (they are not ours to define), and we do not strip them
(stripping would fight a second writer over a field that costs us nothing and dates a note usefully).

## The conflict this inherits, unresolved

Claude Code's auto memory is documented as machine-local and *"not shared across machines"*. This
vault is explicitly synced across machines. Co-operating adopts that contradiction knowingly.

In practice the sync is what makes the vault worth having and nothing has broken, but the honest
statement is that we depend on a file being shared that upstream assumes is not. The concrete risk
is a second machine's Claude Code rewriting a `MEMORY.md` mid-sync and producing a Synology conflict
copy. That has not been observed. It is not fixed here, and it is not to be discovered again as a
mystery.
