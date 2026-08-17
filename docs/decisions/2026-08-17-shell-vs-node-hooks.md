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
| SessionStart, all five hooks | 798 ms | **485 ms** |

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

**`validate-note.sh` → `validate-note.mjs`** (PostToolUse, every Write/Edit). Was ~15 fork sites
plus a Node subprocess.

| | cloud-backed | pinned offline |
| --- | --- | --- |
| shell | 165.9 ms | 130.6 ms |
| node | 92.9 ms | **92.6 ms** |

Verified by differential test, not inspection: both versions over **all 1172 notes in a real vault
plus nine edge-case payloads** (empty stdin, malformed JSON, null path, outside the vault, missing
file, a directory, non-`.md`, the `.path` alternate key) — identical output throughout, with 100
warning lines emitted on each side, so it is a diff of two *working* checkers.

It also gained a 24-assertion self-test. The shell version had none; its only coverage was
`bash -n`, in a file whose entire job is catching mistakes.

## Next, if continued

`insights-surface.sh` — a spike measured **160.3 ms → 47.9 ms** with byte-identical output. Best
remaining ratio in the system.

**`validate-note.mjs` is still 92.6 ms, of which ~48 ms is spawning
`memory-audit-checks.mjs --check-file`.** A version importing those predicates instead measured
**50.3 ms**. Doing it means making `memory-audit-checks.mjs` import-safe — today it runs a
vault-wide audit at import time — which is a 542-line file `/memory:health` and `/memory:prune`
depend on. Worth ~43 ms per write; not free.

## Do not port

- **`vault-memory-sync.sh`** — repoints symlinks and moves files in a live synced vault, and has
  already cost 24 notes once. If ever: last, and only behind a differential harness.
- **`distill-session.sh`, `semantic-index-refresh.sh`** — gates. bash's low floor is the feature.

## Measurement discipline

Three measurements in this evaluation were wrong before they were right. Each looked plausible:

1. **Timing a script that never ran.** A copy of `validate-note.sh` in a scratch directory could
   not resolve `lib/vault-env.sh`, so it exited instantly. It reported 13.8 ms and briefly looked
   like the Node port was a 40 % regression.
2. **Timing an early exit.** Picking the first note in the vault timed a code path that produced no
   output. Fixed by selecting a note that *emits warnings* and asserting the output is non-empty.
3. **Timing both implementations at once.** A harness importing `validate-note.mjs` executed its
   `main()` on import, so the "imported, no subprocess" variant was still spawning the subprocess.
   This one exposed a real defect — the module now runs nothing on import.

**Before trusting a timing here: confirm the thing under test produced the output it should.** A
fast number is more often a broken harness than a win.
