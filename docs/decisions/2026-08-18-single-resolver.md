# One resolver: Node resolves, shell asks

**Date:** 2026-08-18 · **Status:** shipped · **Retires the "two mirrors" rule in `CLAUDE.md`**

## Question

`hooks/lib/vault-env.sh` was the source of truth for vault path, `$CLAUDE_MEMORY_HOME`, recall
arming and `project_key`; `hooks/lib/paths.mjs` mirrored all of it for Node and forked bash for
`project_key` so that at least the sed pipeline had one implementation. Can that duplication go?

## Answer

Yes. `paths.mjs` resolves; `vault-env.sh` `eval`s one `node scripts/env.mjs` call.

The five `sed -e` expressions moved to `normaliseRemote()` in `paths.mjs`, so Node no longer forks
bash. `vault-env.sh` went from **167 lines to 85** and keeps every function name it had, so both
callers were nearly unchanged.

Only two shell files consume it — `hooks/vault-memory-sync.sh` and `scripts/doctor.sh` — which is
what made this cheap. It was not worth doing while there were six.

## Cost, measured

`n=25`, warm caches, vault on **local disk**:

| | before | after | |
| --- | ---: | ---: | --- |
| shell caller: source + `resolve_vault` + `memory_home` + `project_key` + `legacy_key` | 34.3 ms | 61.5 ms | **+27.2 ms** |
| Node `projectKey`, cache **miss** (cold process, `n=15`) | 82.2 ms | 64.3 ms | **−17.9 ms** |
| Node `projectKey`, cache hit | — | — | unchanged |

**The shell side got slower and that is the trade, not a regression to fix.** It is paid by exactly
one hook per session (`vault-memory-sync.sh`, itself an I/O-bound 107–239 ms) and by `doctor.sh`,
which a human runs by hand. The Node side — every other hook in the system — got faster on a cache
miss, which is what happens on the first run in a repo and after any `.git/config` change.

## What this bought

- **~110 lines of duplicated resolution deleted**, and with them the `config_get` sed fallback, the
  `_git_config_for` / `_stat_stamp` / `project_key_cached` cache-reading apparatus, and the rule
  that every change had to be made twice.
- **The URL normaliser is testable.** It now has a table of the eight URL shapes it must handle,
  plus a case for the porting hazard: `tr 'A-Z' 'a-z'` is ASCII-only where `toLowerCase()` is
  unicode-aware, so a host name with a non-ASCII capital would have keyed differently on the two
  sides and split one project's vault folder in two. `normaliseRemote()` lowercases ASCII only.
- **`shellQuote()` is a real boundary with a real test.** Values are `eval`ed on the shell side, so
  a bare `$`, a backtick or a quote in a vault path is an injection. The test's oracle is bash
  itself: quote it, echo it back, compare byte for byte.

## Two things that will bite

- **The accessors run in `$(...)` subshells.** A load performed inside one sets variables that die
  with it, so the next call forks node again — five accessors, five forks. `vault-env.sh` therefore
  loads **eagerly in the parent shell at source time**, and a caller wanting a different directory
  calls `_memory_env_load "$dir"` itself. `vault-memory-sync.sh` does; it takes cwd from the hook
  payload. Verified with `bash -x`: one `node` invocation per script.
- **The degraded path is not a second implementation.** When node is missing, `vault-env.sh` falls
  back to environment variables and built-in defaults only — no `config.json`, no git — sets
  `MEMORY_ENV_DEGRADED=1`, and reports the vault source as "built-in default (node unavailable)".
  It exists so `/memory:doctor` can run far enough to say *why* nothing works, which is the one job
  that cannot be delegated to the runtime being diagnosed. `project_key` degrades to the legacy
  cwd-slug on purpose: that is also the pre-migration folder name, so a fallback lands somewhere
  `vault-memory-sync.sh` already knows how to migrate.

## The test oracle had to change

`paths.test.mjs` compared every project-key assertion against `vault-env.sh` itself — "the shell is
the oracle throughout". After this change the shell *asks Node*, so that comparison would have
passed by construction while testing nothing. The oracle is now the expected key, written out, plus
the URL-shape table. The same-second cache-invalidation assertions (size, then inode) are unchanged
and still the reason those three stamp fields exist.
