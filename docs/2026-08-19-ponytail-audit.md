# Ponytail audit — 2026-08-19

A repo-wide scan for over-engineering: dead flexibility, single-implementation abstractions,
wrappers that only delegate, hand-rolled stdlib, config nobody sets. Complexity only — correctness,
security and performance are a different pass, and nothing here claims a bug.

Written against `8d66a61`. **Status: eight of nine applied on 2026-08-19; one declined.** The
changelog is the record of what shipped — what this file keeps is the ranking, the line counts, and
the one item that was rejected with its reason, so it is not rediscovered as a good idea. Like the
refactor backlog before it, this file is a record and not a queue: **do not add items here.** A new
audit gets a new dated file.

## Findings

| # | Tag | Cut | Replacement | Lines |
| --- | --- | --- | --- | --- |
| 1 | `delete` | `docs/refactor-backlog.md` (deleted here) — all fourteen items landed, and the file said so in its own header | The CHANGELOG and PRs #20, #24, #27–#31 are the record. Keep declined item 15 as one paragraph in `architecture.md` Part 2 | −195 |
| 2 | `delete` | `docs/superpowers/specs/2026-08-15-claude-memory-plugin-design.md` (deleted here) — superseded by `architecture.md`; its only inbound link was the index row in this directory's README | Nothing | −349 |
| 3 | `delete` | `--layer`, measured refuted (EN @5 67.9% → 53.6%) with two docs and a test now existing to tell people not to pass it | Delete the flag, the `preFiltered` plumbing and the eval passthrough; keep the warning as history in `commands/eval.md` | −40 |
| 4 | `yagni` | ~~The `bge-small-en` and `e5-multi` profiles in `MODELS`~~ **DECLINED** — see below | — | 0 |
| 5 | `shrink` | The env-then-config parse, written out four times | One `num(envName, configKey, default)` in `paths.mjs` | −12 |
| 6 | `shrink` | The inline detached spawn in the recall hook, a second copy of `detach()`'s contract | `detach(process.execPath, […], { cwd })` — `hook-io.mjs` imports nothing that throws, so the static-import rule holds | −12 |
| 7 | `yagni` | `reviewPrompt(yaml)`, a wrapper fixing `extractBlockScalar`'s `key` to `'prompt'` — the only argument it ever takes | Inline the key, drop the wrapper and its export | −10 |
| 8 | `delete` | `--size` and `--members` — cluster and dupe knobs no command passes; `--members` exists only to print its own hint | Hardcode 4 and 6 | −6 |
| 9 | `yagni` | The `CARD, STOP, lexTokens, bm25` re-export shim in `memory-semantic.mjs` | Point its four consumers at `lexical.mjs` | −3 |

**Proposed: −662 lines, −0 dependencies. Landed: −683 / +152 across 17 files**, the difference
being the prose each cut had to leave behind — a deleted flag that two documents warned about takes
a paragraph of history with it.

## Declined

**4 — the non-default model profiles.** `bge-small-en` and `e5-multi` are unused *by default*, which
is not the same as unused: `model` is a documented, released config key (README lists all three),
and `e5-multi` is the only profile that is any good at Dutch — NL @5 66.7% against `bge-m3`'s
40.0%. Deleting them is a breaking change to a user-settable knob for −35 lines, and the knob's
whole purpose is to be set rarely. The ponytail rule it was flagged under — no config for a value
that never changes — does not apply to a value that changes rarely and expensively. Kept.

## Where each finding lives

1. `docs/refactor-backlog.md`
2. `docs/superpowers/specs/2026-08-15-claude-memory-plugin-design.md`
3. `scripts/memory-semantic.mjs:659`, `scripts/lib/memory-semantic.mjs:638`, `scripts/memory-eval.mjs:161,211`
4. `scripts/lib/memory-semantic.mjs:264-311` — declined, unchanged
5. `hooks/lib/paths.mjs:62-99`
6. `hooks/memory-recall.mjs:124-134`
7. `scripts/lib/review-prompt.mjs:57`
8. `scripts/memory-semantic.mjs:540,597`
9. `scripts/lib/memory-semantic.mjs:50-51`

## Deliberately not flagged

- **One dependency**, `@huggingface/transformers`, and it is the whole reason the repo exists.
- **No dead modules.** Every `hooks/` and `scripts/` file is named by `hooks.json`, a command, a
  workflow or another module, and every `lib/` export has at least one non-test consumer.
- **`hooks/vault-memory-sync.test.mjs`** is 544 lines against a 163-line script. It is a
  characterisation fence around the one script that has cost 24 notes; the ratio is the point.
- **`trimLog()` and `countLines()`** are hand-rolled but each carries a recorded reason a stdlib
  call would not satisfy — a positioned read so a runaway log never enters memory, and a byte scan
  over a transcript.
