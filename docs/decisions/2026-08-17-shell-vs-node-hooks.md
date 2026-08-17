# Shell vs Node in hooks

**Date:** 2026-08-17 · **Status:** partial migration, by rule not by sweep

## The rule

**Fork count decides, not language.**

- A hook that is a **gate** — decides cheaply, then spawns or exits — stays in **bash**. Its whole
  job finishes in ~5 ms; Node would make it 8× slower at being a doorman.
- A hook that **loops over notes** goes to **Node**. Fork-per-item costs ~3.5 ms *each*, which
  swamps the startup difference by an order of magnitude.

## Runtime floors

| | |
| --- | --- |
| bash | **4.7–5.4 ms** |
| bash + source `vault-env.sh` | 15.0 ms |
| node | **38.4–40.5 ms** |
| node + import `paths.mjs` | 42.7 ms |
| one fork (`jq` / `git` / `grep` / `find`) | 2.8–4.1 ms |

Node's floor is ~8× bash's. That is the entire argument for keeping gates in shell, and it is
outweighed after roughly a dozen forks.

## Vault I/O is a large, separate term

**Any number here depends on whether the vault is materialised on local disk.** The vault lives on
Synology Drive; pinning it permanently offline changed the numbers substantially:

| | cloud-backed | pinned offline |
| --- | --- | --- |
| `find` over vault (1172 notes) | 130 ms | **63 ms** |
| SessionStart, all five hooks | 798 ms | **485 ms** (430 ms after the ports) |

Per hook, SessionStart:

| hook | cloud-backed | pinned offline | |
| --- | --- | --- | --- |
| `vault-memory-sync.sh` | 238.7 ms | 107.1 ms | I/O-bound |
| `insights-surface.sh` | 174.0 ms | **165.2 ms** | **fork-bound — barely moved** |
| `semantic-index-refresh.sh` | 140.7 ms | 80.9 ms | gate |
| `graph-staleness-check.sh` | 130.5 ms | 68.5 ms | gate |
| `memory-link-lint.sh` | 114.0 ms | 63.0 ms | |

`insights-surface.sh` is the tell: faster disk bought it 9 ms because its cost is ~45 forks of
`grep`+`sed`, one pair per note. That is the signature of a hook that should be Node.

## Ported

### `validate-note.sh` → `validate-note.mjs`

PostToolUse, on every Write and Edit — the hottest hook in the system. Was ~15 fork sites plus a
Node subprocess.

| | cloud-backed | pinned offline |
| --- | --- | --- |
| shell | 165.9 ms | 132.3 ms |
| node, audit spawned | 92.9 ms | 92.6 ms |
| node, audit imported | — | **54.0 ms** |

The last row is the same hook after `memory-audit-checks.mjs` was made import-safe — it now runs
its vault-wide audit only when executed directly, so the claim-level predicates run in-process
instead of costing a second Node startup. That refactor was verified by diffing the full audit,
`--deferred`, and `--check-file` across all 1172 notes (107 findings): identical before and after.

The hook itself was verified against the shell original across **all 1172 notes plus nine edge-case
payloads** (empty stdin, malformed JSON, null path, outside the vault, missing file, a directory,
non-`.md`, the `.path` alternate key) — identical output throughout, with 100 warning lines emitted
on each side, so it is a diff of two *working* checkers rather than two silent ones.

It gained a 24-assertion self-test. The shell version had none; its only coverage was `bash -n`, in
a file whose entire job is catching mistakes.

### `insights-surface.sh` → `insights-surface.mjs`

SessionStart: **124 ms → 52 ms**. It forked `grep`+`sed` per note — up to 45 subprocesses to print
15 lines.

The port fixed a **latent bug the shell version had all along.** `t=$(grep -m1 '^title:' "$f")`
returns non-zero for a note with no `title:` line, and under `set -e` a failing assignment aborts
the `| while read` *subshell*. So one untitled note in `Mistakes/` silently dropped **every**
bullet — while still printing the header, so it read as "no past mistakes" rather than as a
failure. The intended fallback to the filename, on the very next line, was unreachable.

Nothing in the real vault triggered it; a crafted differential case did. 13-assertion self-test.

## Next, if continued

`memory-link-lint.sh` (73.9 ms) is the last fork-heavy read-only hook. `vault-memory-sync.sh`
(133.1 ms) is the largest single cost but is explicitly out of scope below.

## Do not port

- **`vault-memory-sync.sh`** — repoints symlinks and moves files in a live synced vault, and has
  already cost 24 notes once. If ever: last, and only behind a differential harness.
- **`distill-session.sh`, `semantic-index-refresh.sh`** — gates. bash's low floor is the feature.

## Measurement discipline

Five measurements in this evaluation were wrong before they were right. Every one of them was
*fast*, which is what made them convincing:

1. **Timing a script that never ran.** A copy of `validate-note.sh` in a scratch directory could
   not resolve `lib/vault-env.sh`, so it exited instantly. It reported 13.8 ms and briefly looked
   like the Node port was a 40 % regression.
2. **Timing an early exit.** Picking the first note in the vault timed a code path that produced no
   output. Fixed by selecting a note that *emits warnings* and asserting the output is non-empty.
3. **Timing both implementations at once.** A harness importing `validate-note.mjs` executed its
   `main()` on import, so the "imported, no subprocess" variant was still spawning the subprocess.
   This one exposed a real defect — the module now runs nothing on import.
4. **Timing a command that never started.** A loop built the command in a variable; word-splitting
   silently failed and `2>&1` swallowed it. Reported 11.4 ms for a hook whose runtime floor is
   38.8 ms — below the floor is the tell.
5. **Timing an excluded file.** The auto-picked note was `GRAPH_REPORT.md`, which the hook skips by
   design, so both sides measured an early exit and the improvement vanished.

**Before trusting a timing here: assert that the thing under test produced the output it should,
inside the timing loop.** Every measurement in this document that survived does so because the
harness counted non-empty runs. A number below the runtime floor is not a result, it is a bug.
