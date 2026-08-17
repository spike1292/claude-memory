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

### `memory-link-lint.sh` → `memory-link-lint.mjs`

Not a language problem — a **shape** problem. The shell version ran `grep -rlF` across the whole
Memory *and* Insights tree **once per note**: O(N×(N+M)) file reads. The Node version reads each
file once and indexes the links, O(N+M).

| Memory notes | shell | node |
| --- | --- | --- |
| 5 | 248 ms | 59 ms |
| 25 | 756 ms | 62 ms |
| 60 | 1949 ms | 64 ms |
| **49 (real project, 1006 Insights notes)** | **10905 ms** | **243 ms** |

Node is flat; shell is quadratic. Output matches at every size tested, with one deliberate
divergence: a final `MEMORY.md` line with **no trailing newline**. `while IFS= read -r` never runs
its body for that line, so the shell silently missed any figure drift declared on it. Node reads
it. Found while reviewing the diff, not by the differential tests — every fixture they generated
ended in a newline.

**This hook was timing out in production.** `hooks.json` allows it 10 s, and the real 49-note
project measured 10.9 s — so on the largest vault the lint was being killed, silently, producing
nothing. It looked like a 74 ms hook because it had only ever been measured in *this* repo, which
has no L1 notes at all, so the loop never ran.

## Shell hooks share the Node project-key cache

`project_key` forked `git` in every shell hook — 40.2 ms of `vault-memory-sync.sh`'s 97.7 ms.
`vault-env.sh` now reads the same `project-keys.json` that `paths.mjs` writes, so the fork is gone:
**34.3 ms → 22.4 ms** per call, and `vault-memory-sync.sh` **97.7 ms → 70.9 ms** without being
ported at all.

The stamp is `"<whole-second mtime>:<size>:<inode>"` — a string both `stat` and `fs.statSync` can
produce identically. Getting this right took three tries, and the self-test caught each one:

- **float milliseconds** — `stat` gives whole seconds on BSD and GNU, so every shell lookup would
  have missed silently, leaving the cache permanently useless on the side it was built for.
- **whole seconds alone** — a `git remote set-url` in the same second as the cached stamp is never
  noticed, and since nothing touches `.git/config` afterwards the stale key is *permanent*, not
  momentary.
- **seconds + size** — closes most of it, but not a same-second rename of identical byte length
  (`Beta` → `Beto`).

The inode closes the rest: git rewrites config atomically (temp file + rename), so every write
lands on a new inode even when mtime and size are unchanged. Verified for exactly that case.

## Next, if continued

Nothing with a good ratio remains. `vault-memory-sync.sh` (70.9 ms) is the largest single hook and
is deliberately out of scope below.

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
