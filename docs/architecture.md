# Architecture

The shape of the system, the flows that matter, the invariants and who enforces them, and the
hacks that are load-bearing.

**Two halves.** [Part 1](#part-1--the-architecture) is the design: what talks to what, and why.
[Part 2](#part-2--how-things-really-work) is the reality: where the design is not what the code
does, which seams are missing, and which shortcuts are holding weight. Part 2 exists because the
gap is not documented anywhere else, and every entry in it has already cost something or is
positioned to.

The fixes for what Part 2 records live in [refactor-backlog.md](refactor-backlog.md), ordered by
impact per hour.

Keeping this current: see [Maintaining this document](#maintaining-this-document).

---

# Part 1 — the architecture

## What this is

A Claude Code plugin (`memory@claude-memory`). No build step, no application: the deliverables are
the files, loaded by Claude Code from a version-pinned cache dir. bash + Node >= 22.5, one runtime
dependency (`@huggingface/transformers`), `node:sqlite` for storage, `node:test` for tests.

The engine is this repo. The notes are a private Obsidian vault that must never be in it.

## The three homes

Every design constraint in the system traces back to this split. Nothing else about the layout
makes sense without it.

```
  ┌───────────────────────────────────────────────────────────────────────┐
  │ PLUGIN CACHE   ~/.claude/plugins/cache/claude-memory/memory/<version>/ │
  │                                                                       │
  │  hooks/  scripts/  commands/  skills/  stubs/                         │
  │  node_modules/ ──────────────────────────────┐                        │
  │                                              │ symlink (0.3.1+)       │
  │  VERSION-PINNED. Claude Code keeps every     │                        │
  │  version it ever installed. Nothing mutable  │                        │
  │  may live here — it would be duplicated per  │                        │
  │  version and orphaned on update.             │                        │
  └──────────────────────────────────────────────┼────────────────────────┘
                                                 │
  ┌──────────────────────────────────────────────▼────────────────────────┐
  │ MACHINE STATE   $CLAUDE_MEMORY_HOME   (default ~/.claude-memory/)      │
  │                                                                       │
  │  config.json      settings, read WHEN THE HOOK RUNS                   │
  │  db/              semantic-<slug>-<model>.db  + .index-<model>.lock   │
  │  models/          ONNX weights (~722 MB) — redirected here, see H2    │
  │  logs/            semantic-index.log, recall decisions                │
  │  run/             search-<model>.sock                                 │
  │  eval/            case sets (gitignored: contain vault content)       │
  │  node_modules/    the one shared runtime copy                         │
  │  plugin-root      breadcrumb, rewritten every SessionStart            │
  │                                                                       │
  │  SURVIVES UPDATES. All mutable state, deliberately outside the plugin.│
  └───────────────────────────────────────────────────────────────────────┘

  ┌───────────────────────────────────────────────────────────────────────┐
  │ VAULT   <cloud-synced Obsidian dir>                                   │
  │                                                                       │
  │  Memory/<project-key>/      L1 facts + MEMORY.md (the index)          │
  │  Logs/<project-key>/        L2 session logs      (+ Archive/)         │
  │  Insights/<project-key>/    L3 lessons: Patterns/ Mistakes/ Decisions/│
  │  Graph/<project-key>/       L4 GRAPH_REPORT.md (codebase-memory-mcp)  │
  │  permanent/                 cross-project, graduated notes            │
  │                                                                       │
  │  PRIVATE. Never in git. Cloud sync churns mtime — see R1 in Part 2.   │
  └───────────────────────────────────────────────────────────────────────┘

  Symlink INTO the vault:  ~/.claude/projects/<cwd-slug>/memory -> <vault>/Memory/<project-key>/
  Symlink INSIDE the vault: never. Synology replaces directory symlinks with empty dirs and
  renames the original to <name>_<DEVICE>_<date>_Conflict. File symlinks survive. (2026-08-08)
```

**Project identity is the normalised git remote** (`project_key`), not the checkout path — one repo
maps to one vault folder from any machine or subdirectory. `legacy_key` (the cwd slug) still exists
because Claude Code names `~/.claude/projects/<slug>/` after it. Both live in
[`hooks/lib/paths.mjs`](../hooks/lib/paths.mjs).

## Module map

```
                        ┌──────────────────────────┐
                        │   hooks/lib/paths.mjs    │  THE KERNEL, AND THE RESOLVER
                        │  vault() vaultSource()   │  every Node module imports it
                        │  memoryHome() stateDir() │  config() is memoised — see H8
                        │  config() recallEnabled()│
                        │  projectKey() (+ cache)  │  normaliseRemote() ported from
                        │  normaliseRemote()       │  five sed -e on 2026-08-18
                        │  useModelCache()         │  mutates a 3rd-party global — H2
                        └────────────┬─────────────┘
                                     │ asked by (one node fork per script)
                                     ▲
                        ┌────────────┴─────────────┐
                        │  hooks/lib/vault-env.sh  │  85 lines, RESOLVES NOTHING
                        │  eval "$(node env.mjs)"  │  eager load — see H13
                        │  degraded path if no node│  2 callers: vault-memory-sync,
                        └──────────────────────────┘  doctor.sh

                                     │
        ┌──────────────┬─────────────┼──────────────┬──────────────────┐
        ▼              ▼             ▼              ▼                  ▼
  ┌───────────┐  ┌───────────┐ ┌───────────┐ ┌────────────┐  ┌─────────────────┐
  │ insights- │  │ memory-   │ │ validate- │ │  distill-  │  │ scripts/lib/    │
  │ surface   │  │ link-lint │ │ note      │ │  session   │  │ memory-semantic │
  │           │  │           │ │     │     │ │            │  │ (pure fns only) │
  └───────────┘  └───────────┘ └─────┼─────┘ └─────┬──────┘  └────────┬────────┘
        │              │             │             │                  │
        └──────────────┴──── all gates share ──────┘ imports          │ imported by
                    ┌──────────────────────┐         ▼                ▼
                    │ hooks/lib/hook-io.mjs│  ┌────────────────────┐ ┌────────────────────────┐
                    │ stdin · debounce ·   │  │ scripts/lib/       │ │ scripts/               │
                    │ detach() ·findClaude()│ │ memory-audit-checks│ │ memory-semantic.mjs    │
                    └──────────────────────┘  └────────────────────┘ │ 920 lines — see G1     │
                                                                     │ CLI · model lifecycle ·│
                                                                     │ SCHEMA OWNER · indexer·│
                                                                     │ 4 reports·loadIndex·   │
                                                                     │ DAEMON                 │
                                                                     └────────────────────────┘
```

**The arrow reversed on 2026-08-18.** `vault-env.sh` was the source of truth and `paths.mjs`
mirrored it, forking bash for `project_key`. Now `paths.mjs` owns every rule and the shell asks —
[decision record](decisions/2026-08-18-single-resolver.md).

`hooks/` and `scripts/` are **invocation channels, not layers** — see [B1](#b1--hooks-and-scripts-are-not-layers).

## Key flows

### Flow 1 — session start

```
Claude Code fires SessionStart
   │
   ├─▶ hooks/vault-memory-sync.sh          15s   resolve vault, migrate legacy_key ->
   │      (bash; DO NOT PORT — see H4)           project_key folders, repoint
   │                                             ~/.claude/projects/<slug>/memory,
   │                                             rewrite $STATE/plugin-root
   │
   ├─▶ hooks/insights-surface.mjs          10s   print <=15 newest L3 Mistakes
   │      -> lib/insights-surface.mjs            (Insights/<slug>/Mistakes/)
   │
   ├─▶ hooks/memory-link-lint.mjs          10s   report MOC-only notes + drift
   │      -> lib/memory-link-lint.mjs            names only, never auto-fixes
   │
   ├─▶ hooks/semantic-index-refresh.mjs    10s   plan() decides, then detaches
   │      -> lib/semantic-index-refresh.mjs      `node memory-semantic.mjs --index`
   │      (detached; see R1)                     NO lock of its own — the indexer
   │                                             takes a per-model one
   │
   └─▶ hooks/graph-staleness-check.mjs     10s   plan() -> silent | nudge | regen
          -> lib/graph-staleness-check.mjs       staleness by RECORDED COMMIT, not
          (detached; needs codebase-memory-mcp)  mtime; 24h debounce per repo
```

Every Node hook is guarded `command -v node >/dev/null 2>&1 && node ... || exit 0`. Every hook is
best-effort: a missing dependency is a no-op, never a block.

### Flow 2 — a prompt (recall)

```
UserPromptSubmit  ──▶  hooks/memory-recall.mjs
                          │
                          ├─ recallEnabled()? ────────── no ──▶ exit 0   (SHIPS INERT)
                          ├─ prompt.length >= 25? ────── no ──▶ exit 0
                          │
                          ├─ slug = projectKey(cwd);  model = activeModel()
                          │
                          ├─ run/search-<model>.sock exists?
                          │     │
                          │   yes│  ┌──────────────────────────────────────────────┐
                          │     └─▶│ write {q, k, slug}\n     ── 700 ms timeout ──▶│
                          │        │ read  {slug, results:[{note,layer,heading,    │
                          │        │        text,matched,score}]}                  │
                          │        └──────────────────────────────────────────────┘
                          │              ▲ the wire format is hand-written on both
                          │                sides; only QUIT is shared — see H5
                          │
                          ├─ got results? ── yes ──▶ filter score >= MIN_COS 0.55
                          │                          take <=4, <=900 chars
                          │                          emit "- [[note]] (layer): ..."
                          │
                          └─ no  ──▶ spawn --serve DETACHED for next time
                                     └▶ FALLBACK: BM25 over
                                        SELECT ... WHERE heading = ?   (binds CARD)
                                        gate MIN_SCORE 6.0   (the lib's bm25() since
                                                              2026-08-19 — H6)

  Every decision is logged, abstentions included. A prompt must NEVER wait on this.
  The entry owns stdin, the socket, node:sqlite and stdout; every gate, score and log
  record above is hooks/lib/memory-recall.mjs, which takes rows as values.
```

### Flow 3 — the search daemon

```
  ONE server per MACHINE, keyed by MODEL. The slug is a REQUEST FIELD.
  (Before 0.3.0 the slug was fixed at spawn — that meant one ~1.3 GB model per repo.)

  spawn ──▶ probe run/search-<model>.sock
              ├─ live?         ──▶ exit ~55 ms  (never steal the socket)
              ├─ ECONNREFUSED? ──▶ unlink, continue
              └─ evict leftovers matching the pre-0.3.0 name

  listen ──▶ warm the model on startup
              │
              │  request: indexFor(slug) ─▶ mtimeCache keyed on the .db mtime
              │                             (stat fails -> NaN -> always reload)
              │           embed(QUERY_PREFIX + q)  [clamped to MAX_CHARS]
              │           searchIn(index, q, qvec, k, preFiltered)
              │              ├─ vector arm: linear cosine scan (no ANN)
              │              ├─ lexical arm: BM25 k1=1.2 b=0.75
              │              └─ fuseRRF(k=60, w=2)
              │
              ├─ modelIdleMs  5 min ─▶ pipeline.dispose() -> InferenceSession.release()
              │                        ~450 MB MALLOC_LARGE -> ~2.4 MB. Socket, indexes
              │                        and BM25 tokens survive. Declines while busy.
              └─ serveIdleMs 30 min ─▶ unlink socket, exit

  THREE memory bounds, none interchangeable:
    1. enableCpuMemArena:false  — the only one that survives a bad input (BFCArena never
                                  returns what it grew to)
    2. embed() clamps MAX_CHARS — attention is heads x seq^2 per layer (~4.3 GB for ONE of
                                  bge-m3's 24 layers at its 8192-token max)
    3. the two idle timers      — two costs, so two timers
```

### Flow 4 — session end (distillation)

```
SessionEnd AND Stop  ──▶ hooks/distill-session.mjs   ONE FILE, TWO MODES
                            │
                            ├─ no argv ─▶ GATE: gatePlan(payload)
                            │    CLAUDE_DISTILL_CHILD set        -> skip
                            │    stop_hook_active                -> skip
                            │    < 15 messages                   -> skip
                            │    not SessionEnd and < 400        -> skip
                            │    not SessionEnd and within 2h    -> skip
                            │    else: writeMarker + detach() the worker below
                            │
                            └─ argv ────▶ WORKER: distill(transcript, cwd)
                                   │
                                   ├─ projectKey(cwd), fall back to legacy_key if the
                                   │  vault has not been migrated yet
                                   ├─ transcriptToText(); < 200 chars -> stop
                                   ├─ runExtractor():  claude -p --model haiku
                                   │     150 s timeout, 16 MB buffer,
                                   │     env CLAUDE_DISTILL_CHILD=1  ◀── the ONLY thing
                                   │     stopping the child's own Stop hook recursing
                                   │     (DISTILL_DRYRUN=1 returns canned data — H9)
                                   ├─ writeNotes(): per note, findNearDuplicate()
                                   │     token overlap >= 0.40 -> reconcile() instead of
                                   │     a new file.  A FALSE MERGE DELETES A LESSON.
                                   └─ reindex(): context-mode `cm index` x5 (120 s each)
                                        or, if absent, memory-semantic.mjs --index (600 s)

  Note the timeout arithmetic: a 15 s hook wrapping work budgeted to 600 s. Correct only
  because detach() in hook-io.mjs is spawn(detached) + unref() + stdio to a log fd — a
  child holding a pipe would keep the gate's event loop alive.
```

### Flow 5 — install

```
Claude Code installs a plugin with `npm ci`, WHICH SKIPS LIFECYCLE SCRIPTS.
That is why /memory:install exists at all.

  npm ci
    └─ postinstall -> scripts/slim-install.mjs        380 MB ──▶ 59 MB
         ├─ delete onnxruntime-node binaries for every platform but this one   176 MB
         │    (+ CUDA/TensorRT providers on linux)
         ├─ replace sharp + @img with stubs/sharp                               17 MB
         └─ replace onnxruntime-web  with stubs/onnxruntime-web                130 MB
              STUB, NEVER DELETE: both are STATIC imports in transformers.node.mjs,
              so removal fails resolution before any code runs. The stubs THROW, so a
              wrong-backend regression is loud instead of a silent WASM fallback.

  /memory:install step 6 -> scripts/share-modules.mjs
         move node_modules to $CLAUDE_MEMORY_HOME, symlink every version dir at it.
         Claude Code does NOT replace the cache on update: 6 versions x 381 MB = 2.2 GB
         measured 2026-08-18. Refuses to run outside a plugins/cache/ path (it deletes
         directories); a git checkout keeps its own.
```

### Flow 6 — release

```
  conventional commits ──▶ scripts/release.sh ──▶ writes SIX fields in FOUR files
                                                    package.json                .version
                                                    package-lock.json           .version
                                                    package-lock.json           .packages[""].version
                                                    .claude-plugin/plugin.json  .version
                                                    marketplace.json            .metadata.version
                                                    marketplace.json            .plugins[0].version
  bump rules (release.sh, 13 selftest cases):
     breaking (!: or BREAKING CHANGE) -> minor while major is 0, else major
     any feat:                        -> minor
     fix:/chore:/perf: only           -> patch      (perf is NOT a feature)

  Merging the release PR publishes. There is no manual tagging step.
  The `## [Unreleased]` section becomes the release notes VERBATIM.
```

## Invariants, and who actually enforces them

The middle column is the point. A rule nobody enforces is a rule that drifts, and this table
exists because a comment once claimed a CI check that did not exist.

| Invariant | Enforced by | Notes |
| --- | --- | --- |
| `lib/` modules import without side effects | **CI** — `ci.yml` "lib/ modules import without side effects" | imports each and fails on *any* output |
| `hooks/lib/` modules import cleanly under a **bad config** too | **CI** step | added 2026-08-19; the side-effect check above runs with a valid model, so it passed a `lib/` whose import graph `console.log`+`exit(1)`s on an unknown one — onto hook stdout, above the fail-open try |
| `node:test` imported only by `*.test.mjs` | **CI** step | a top-level import prints the whole report to stdout, which Claude Code reads |
| `node:sqlite` imported only by entry points | **CI** step | added 2026-08-18; the side-effect check cannot catch it (it suppresses `ExperimentalWarning`) |
| No Python anywhere | **CI** step | `git ls-files '*.py'` + `git grep -l python -- '*.sh'` |
| Version agrees in 6 fields / 4 files | **CI** `version` job | `release.sh` writes them; never bump by hand |
| Bump derivation is correct | **CI** — `release.sh --selftest`, 13 cases | bash, so it cannot run under `node --test` |
| Install stays slim (<100 MB) and stubs are `0.0.0-stub` | **CI** `install` job | the only place a real `npm ci` runs |
| transformers loads against the stubs | **CI** `install` job | static-import shape check, no weights pulled |
| Formatting | **CI** `format` job — `prettier@3.6.2 --check` | **excludes `*.md`, `*.yml`, lockfile** |
| Test concurrency is 1 | **CI** run command | shared `$CLAUDE_MEMORY_HOME`; `paths.test.mjs` asserts two writes in the same second |
| `main` is protected | **GitHub settings** (not in this repo) | admins and force-pushes included |
| One index per model; a wrong-model index is refused | **code** — `loadIndex()` checks `meta.model` | asked of the whole index, not the `--layer` slice |
| Vectors are the profile's width | **code** — `assertVectorWidth()` | guards the mixed 384/1024 corruption that created the lock |
| One `--index` writer per model | **code** — `.index-<model>.lock`, `mkdir` + stale reclaim | cross-process, and now the *only* index lock (2026-08-18) |
| Resolution has one implementation | **code** — `vault-env.sh` cannot resolve; it `eval`s `node scripts/env.mjs` | there is nothing left to keep in step, so nothing to enforce |
| Shell-bound values are `eval`-safe | **test** — `shellQuote()` round-trips through bash itself | a `$`, backtick or quote in a vault path is an injection otherwise |
| Entry files are thin wrappers over `lib/` | **NOTHING** | holds in **12 of 16**. 15 have a twin (only `scripts/env.mjs` does not), but a twin is not the invariant: three entries keep the real behaviour beside one. Re-counted 2026-08-19 after `scripts/prune-logs.mjs` was added as a compliant 16th; see [G1](#g1--the-entrylib-rule-is-inverted-where-it-matters) |
| No retrieval number without a case set | **NOTHING** — convention | already violated once, `MIN_SCORE = 6.0` |
| Embedding batch size is 1 | **NOTHING** — comment only | padding changes the embedding; competing notes sit ~0.001 apart |
| All mutable state in `$CLAUDE_MEMORY_HOME` | **partial** — `.gitignore` covers `*.db`, `*.log`, `*.sock` | nothing checks the positive case |
| Model profiles never share thresholds | **NOTHING** — comment only | copied thresholds once made both scans report a clean vault |

---

# Part 2 — how things really work

Everything above is the design. Below is what the code does.

## G1 — the entry/`lib/` rule is inverted where it matters

The stated rule: `hooks/<name>.mjs` owns argv, stdin and stdout **and nothing else**. True for
**12 of the 16** hook and CLI entries, and the two numbers people quote here are different claims:
**15** entries have a `lib/` twin — `scripts/env.mjs`, at 16 lines, is the only one that does not —
but three of those 15 keep the real behaviour in the entry anyway, so having a twin is the weaker
property and 12 is the invariant. `memory-recall.mjs` joined the compliant side on 2026-08-19, and
`scripts/prune-logs.mjs` arrived compliant the same day: 42 lines of argv, `PRUNE_DAYS` and stdout
over a 111-line twin. It is the first entry that was *born* out of a shell script rather than
carved out of an existing `.mjs`, which is why it needed no carving.
In the three below it is still reversed:

| Entry | Entry | Lib | Entry tested? |
| --- | ---: | ---: | --- |
| [`scripts/memory-semantic.mjs`](../scripts/memory-semantic.mjs) | **911** | 690 | no |
| [`scripts/memory-audit-checks.mjs`](../scripts/memory-audit-checks.mjs) | **321** | 241 | no |
| [`scripts/memory-eval.mjs`](../scripts/memory-eval.mjs) | **257** | 84 | no |

`hooks/memory-recall.mjs` was the fourth row — 253 lines over no lib at all. It is now 153 lines of
stdin, socket, `node:sqlite` and stdout over a 148-line
[`hooks/lib/memory-recall.mjs`](../hooks/lib/memory-recall.mjs) with the gates, the ranking, the
formatting and the log-record shapes, and a test file where the prompt path had none.

**This is not cosmetic.** All four CI invariants key off the `lib/` boundary, so code left in an
entry is **exempt by construction** — and the `node:sqlite`-only-in-entries rule actively pushes
database code there. The 920-line file is the least-checked file in the repo.

`scripts/memory-semantic.mjs` is a god object with seven responsibilities in one module scope: CLI
parsing, ONNX model lifecycle (`loadEmbedder`/`unloadEmbedder`/`embed`), **sole owner of the SQLite
schema** (`CREATE TABLE chunks`), the indexer, four analysis reports, the search engine
(`loadIndex`; `searchIn` moved to the lib on 2026-08-19), and a network daemon. Dispatch is
straight-line `if (flag('--x')) { ... process.exit() }` — block order *is* precedence, and `flag('--serve')` is
tested in five separate places. The file cannot be imported, only executed, which is why it has no
test.

The split was drawn along *"is it testable?"*, not *"is it a boundary?"*. `searchIn()` — the
function that decides what you actually see — stayed on the untested side until 2026-08-19, when it
moved to `lib/` unchanged and got its first test. It was always pure (a bundle in, ranked rows out),
so nothing but the argv-derived `--layer` binding held it there. That binding is now a last
parameter, `preFiltered` — a boolean saying the corpus was already narrowed, not a layer to filter
by; it only switches off the reserve that would otherwise guarantee Memory rows a share of results.
`loadIndex()` stays, and stays untested: it opens the database, and `lib/` may not import
`node:sqlite`. That is the shape of the remaining gap — what is left in the entry is left there
*because* of a CI rule, not by accident.

## B1 — `hooks/` and `scripts/` are not layers

```
  hooks/lib/validate-note.mjs ──────────▶ scripts/lib/memory-audit-checks.mjs
  hooks/lib/memory-recall.mjs ──────────▶ scripts/lib/lexical.mjs
  scripts/env.mjs ──────────────────────▶ hooks/lib/env-shell.mjs
                                                        │
  scripts/lib/memory-semantic.mjs ──┐                    │
  scripts/lib/memory-eval.mjs ──────┤                    │
  scripts/lib/memory-synth-vault.mjs┤                    │
  scripts/lib/model-default.mjs ────┼────────────────────┴──▶ hooks/lib/paths.mjs
  scripts/memory-semantic.mjs ──────┘
```

The arrows point both ways, and #20 added one: `scripts/env.mjs` is the only entry whose `lib/` twin
is neither same-named nor in the sibling directory. That is defensible — it renders what `paths.mjs`
resolves, so it belongs beside it — but it is the pattern breaking again rather than an exception to
it.

2026-08-19 added the `hooks/` → `scripts/` arrow at the top: the recall hook's twin takes `CARD`,
`STOP`, `lexTokens` and `bm25` from `scripts/lib/lexical.mjs` rather than keeping a fourth copy. It
points at that file and **not** at `memory-semantic.mjs`, where the four grew up, because a hook
entry imports its `lib/` twin statically — above the fail-open try and above the arming gate — and
`memory-semantic.mjs`'s module scope does `console.log` + `process.exit(1)` on an unknown model.
`lexical.mjs` imports nothing at all and costs 0.26-0.42 ms of module init instead of 3.8-4.4 ms
(8 runs each, 2026-08-19, local APFS — module init reads no vault, so the cloud-vs-offline split
does not apply to this figure).

The directory names describe **who invokes the file**, not a dependency direction. There is exactly
one real layer — `paths.mjs` — and it is misfiled under `hooks/`, so eight files reach up through
`../../hooks/lib/` to get it.

Consequence: `validate-note` is a `PostToolUse` hook firing on **every Write/Edit in every session**,
and it pulls the whole `/memory:health` audit engine in by import. Deliberate (the comment says
imported-not-spawned, to avoid a fork), but it puts the audit module's import cost on the edit path.

## Implicit services — four, none with a definition

| Service | Invoked from | Contract lives where |
| --- | --- | --- |
| the search daemon | `memory-recall.mjs` over a unix socket | **hand-written on both sides**; only `QUIT` is shared |
| the SQLite index | `memory-semantic.mjs` writes, `memory-recall.mjs` reads with its own SQL | the `CREATE TABLE`, and the card heading — `CARD` in `scripts/lib/lexical.mjs` since 2026-08-19, bound as a parameter by every reader |
| headless `claude` | `lib/distill-session.mjs` → `claude -p --model haiku` | argv, hardcoded model |
| `context-mode` CLI | `lib/distill-session.mjs` → `cm index` ×5 | argv, and a **different** identity scheme (H7) |

## Known hacks

Each of these is load-bearing. None is an accident; most have a dated measurement behind them.

**H1 — `projectKey()` forks bash. — CLOSED 2026-08-18 (#20).** `paths.mjs` used to shell out
(`bash -c '. "$0"; project_key "$1"'`) so the sed pipeline over git remote URLs stayed
single-implementation: the most-called identity function in the system was a subprocess. The
pipeline moved into `normaliseRemote()` and the shell now asks Node instead. Cache miss went
**82.2 → 64.3 ms**; the disk cache stays, because git itself still forks.

What the closure cost, and why it is worth recording: applying the ported pipeline to *both*
branches of `computeProjectKey` silently re-keyed repos with no `origin` remote (`foo.git/` → `foo`).
Caught in review, fixed in #21. A key that moves is a vault folder that moves — when consolidating
two implementations into one, the branch nobody was thinking about is the one that shifts.

**H2 — `useModelCache()` mutates a third-party global.** `transformers.env.cacheDir` is assigned
directly because transformers.js v4 ignores both `HF_HOME` and `TRANSFORMERS_CACHE` (verified
2026-08-15). This one assignment is the only thing keeping 722 MB of weights out of the
version-pinned plugin dir. A rename upstream is silent; `doctor.sh` checks for the symptom.

**H3 — stubs that throw.** `stubs/sharp` and `stubs/onnxruntime-web` are ~1 KB modules replacing
147 MB. They exist rather than being deleted because both are *static* imports. npm `overrides`
cannot do this — pointed at a local stub npm writes a lockfile it then rejects, and Claude Code
installs with `npm ci`. Measured 2026-08-18.

**H4 — `vault-memory-sync.sh` is fenced off by policy.** 163 lines that move files and repoint a
live symlink in a cloud-synced dir. It has cost 24 notes once, and two documents carry a standing
prohibition on porting it. **The fence is unchanged. What changed on 2026-08-19 is the second
half of this entry**: `hooks/vault-memory-sync.test.mjs` drives it as a black box from a scratch
`HOME`, mutation-checked on a throwaway copy of the repo so it is known to *fail* when
the script is broken — so the riskiest file is no longer the least covered one, and a port would
now have a baseline to be diffed against. That was the stated precondition for ever touching it,
not permission: the script is still bash and still must not be ported.

Writing that test found four behaviours to characterise, recorded there as `CHARACTERISED, NOT
ENDORSED` and deliberately left unfixed, because a fix without a test is exactly what lost the
notes. Two are silent loss on the next SessionStart — `mv -n` skips a note whose name already
exists in the vault and the following `rm -rf` deletes it; a subdirectory under a real memory dir
is never migrated and is deleted with its parent. The third is silence rather than loss: refusing
to merge a legacy-slug folder into an existing destination strands those notes under the old key
forever, unreported and unindexed. The fourth is an ordering bug rather than a defect in the
migration itself: the vault is resolved before the marker-file → `config.json` migration runs, so
the session that performs the migration does not honour it. Four markers in the file, four here,
four in the changelog — count them against each other, not from memory. Two branches remain uncharacterised — the `~/.claude/CLAUDE.md`
migration and the `Commands/` stub `rmdir` — and mutants that turn either into an `rm -rf` still
survive the suite.

**H5 — the socket protocol is written twice.** Client sends `{q, k, slug}`; server destructures
`{q, k = 5, slug = SLUG}` and replies with six fields. The same file also emits a *different*,
three-field response for `--json` query mode — so the eval harness and the recall hook score
against structurally different views of the same search. No version field. The client's
`r.text ?? ''` is the tell that this has already been noticed.

**H6 — text processing is forked three ways** (four until 2026-08-19).

| Where | Stopwords | Filter | Splitter |
| --- | ---: | --- | --- |
| `scripts/lib/lexical.mjs` (`STOP`/`lexTokens`), re-exported by `memory-semantic.mjs` | 71 | `len > 2` | `/[^a-z0-9]+/` |
| `scripts/memory-audit-checks.mjs` | 62 | `len > 3` | keeps hyphens |
| `hooks/lib/distill-session.mjs` (`tokens`) | own array | `len > 2` + singularise | `\p{L}\p{N}` |

The recall hook was the fourth row — 71 stopwords with `with` listed twice, its own tokeniser, and
its own inline BM25, so **the fallback scored by a different implementation than the primary path it
falls back from**. `hooks/lib/memory-recall.mjs` imports `STOP`/`lexTokens`/`bm25` from the lib as
of 2026-08-19; the two were equivalent (the duplicate `with` collapses in a `Set`, and the inline
BM25 was `bm25()` with `k1 = 1.2`, `b = 0.75` pre-substituted), so nothing about ranking moved — but
the twin passes both **explicitly**, because `MIN_SCORE` is an absolute BM25 value and a tune made
for the CLI's arm would otherwise rescale it silently.

What had deferred the merge was module-init cost on the prompt path, and that measurement is also
why the shared four live in `scripts/lib/lexical.mjs` rather than in `memory-semantic.mjs` where
they grew up: importing that module costs 3.8-4.4 ms, `lexical.mjs` 0.26-0.42 ms (8 runs each,
warm, marginal after `paths.mjs`, 2026-08-19). The correctness reason in `B1` is the stronger one —
a hook's `lib/` twin is imported above the fail-open try, so it may only reach modules that cannot
print and cannot exit — but the number alone would have decided it too. Recall's gate still has no
case set behind it (item 12).

**H7 — two identity schemes, adjacent.** In `reindex()`, the directory indexed is
`VAULT/<layer>/<project_key>` while the source label is `vault-<layer>-${basename(cwd)}`. Two
checkouts of one repo at different paths give one vault folder and two `ctx_search` source labels.

**H8 — `config()` is memoised for process lifetime.** Correct for a 40 ms hook. For the 30-minute
daemon it means an edit to `config.json` is invisible until the process idles out, with nothing
surfacing that.

**H9 — the LLM seam is an env var, not an injection.** `DISTILL_DRYRUN=1` branches around
`runExtractor()` and returns canned data. The extractor is not replaceable; it is branched past.

**H10 — mean pooling on a CLS-documented model.** `bge-small-en` is configured `pool: 'mean'`
*against its own model card*, because on the 28-case EN set cls scores @1 21.4% versus mean's 32.1%.
Whatever the Xenova q8 export does is not what the card describes. **Do not "fix" this.**

**H11 — ten copies of path resolution in Markdown.** All ten `commands/*.md` open with the same
`$STATE`/`$MEM` preamble and several inline `. "$MEM/hooks/lib/vault-env.sh"; project_key "$PWD"`.
Prettier is configured to skip `*.md`, no CI step greps them, and no test executes them. Path
resolution now has **two** implementations rather than four — `paths.mjs`, plus ten hand-copied
Markdown preambles. #20 removed the other two (`vault-env.sh` stopped resolving; `doctor.sh` sources
it). The Markdown copies are untouched and are now the whole of the remaining duplication.

**H12 — two locks guard one resource. — CLOSED 2026-08-18 (#20).**
`$MEM_HOME/.semantic-index.lock` (shell, SessionStart only, 30-minute stale reclaim) sat alongside
`$DB_DIR/.index-<model>.lock` (Node, per model). Only the Node one protected integrity — both
`distill` and `/memory:prune` call `--index` directly and took only that. The shell lock's
contention path was `exit 0` with **no output**, so it deleted work silently. Removed; the per-model
lock is now the only index lock.

**H13 — `vault-env.sh` must load eagerly, in the parent shell.** Its accessors are called as
`$(resolve_vault)`, which runs in a subshell — so a load performed *inside* one sets variables that
die with it, and the next accessor forks `node` again. Five accessors, five forks. It therefore
calls `_memory_env_load "$PWD"` at **source time**, and a caller wanting a different directory
(`vault-memory-sync.sh` takes cwd from the hook payload) must call it itself. Verified with
`bash -x`: one `node` invocation per script. This is a correctness requirement wearing the costume
of an optimisation.

**H14 — `shellQuote()` is an `eval` boundary, not politeness.** `scripts/env.mjs` emits
`NAME='value'` lines that `vault-env.sh` runs through `eval`. A vault path is user-supplied, so a
bare `$`, a backtick or a quote is an injection. POSIX single-quoting suppresses every expansion,
and `'\''` is the only escape it needs. The test's oracle is bash itself: quote it, echo it back,
compare byte for byte.

## Where failure is silent

The system's defences are excellent where it has already been burned and absent where it has not.
These are the paths where a fault produces no error — ranked by expected cost.

| # | Failure | Mechanism | Blast radius |
| --- | --- | --- | --- |
| ~~R1~~ | ~~**Full re-embed storm**~~ — **CLOSED 2026-08-19 (#27)** | mtime is now a fast-path hint, not the decision: a note whose mtime moved is read and hashed (`contentHash()`), and re-embedded only if the bytes actually changed. Synology churn costs one read per touched note and the new mtime is written back, so the next run takes the fast path again | — |
| ~~R2~~ | ~~**Silently skipped indexing**~~ — **CLOSED 2026-08-18 (#20)** | the shell lock that produced it is deleted; the per-model `--index` lock reports contention to its log instead of `exit 0` | — |
| R3 | **False merge deletes a lesson** | `findNearDuplicate` at 0.40 token overlap, unattended, on `haiku`-generated titles; a merge writes an "Also seen" addendum and **looks like success** | one note, unrecoverable |
| R4 | **Recall's keyword arm dies** — **CLOSED 2026-08-19** | changing the card sentinel in `chunkNote()` used to make recall's raw SQL return 0 rows → `avgdl` is `NaN` → all scores `NaN` → abstain, and **abstention is its normal behaviour**, so nothing showed. The sentinel is `CARD` and all three readers now **bind it as a SQL parameter**, recall included since its SELECT moved behind `hooks/lib/memory-recall.mjs`. A rename can no longer miss a site. The source-scan test in `memory-semantic.test.mjs` was kept and inverted: it now fails if a bare heading literal is re-inlined into the hook | was: keyword arm dead, no signal |
| R5 | **Unbounded `$CLAUDE_MEMORY_HOME`** — **halved 2026-08-19 (#24)** | growth is unchanged (no `VACUUM`; per-project × per-model `.db` files accumulate; `models/` accumulates per model; `prune-logs.mjs` touches only the vault) but it is no longer unobserved: `doctor.sh` reports the size of `$STATE` and warns past 2 GB, and the hook logs — the one component that grew without bound — are capped at 1 MB in `logBanner()`/`openLog()` | bounded logs; the rest is multi-GB but now **noticed early** |
| R6 | **Weights re-downloaded per version** | H2 breaks on a transformers rename | ~700 MB × versions |
| R7 | **Slimming prunes nothing** | `slim-install.mjs` walks a hardcoded upstream layout and *fails safe* | 380 MB/version; only the `install` CI job notices |
| R8 | **Symlink-dereference bugs** | the class, not an instance: two found so far (`du` without `-L`; the runtime probe in `semantic-index-refresh`). Both fixed, the second now pinned by a test that symlinks `node_modules` and asserts `runtimeInstalled()` sees through it. Every new check against `$CLAUDE_MEMORY_HOME` is another draw | a check that measures nothing |
| — | **Runaway `claude` recursion** | `CLAUDE_DISTILL_CHILD` is the only guard, on a hook registered for both `SessionEnd` **and** `Stop` | low probability, **unbounded** cost |

There is **no auth and no billing surface** — single user, one unix socket. The nearest analogues:
the slug is a request field, so one connection to the socket can query *every* indexed project, not
only the current one — the socket is `chmod 0600` at `listen()` (unreleased), which restricts that
to the owning user but is defence in depth rather than a guarantee, since macOS does not enforce
unix-socket permissions uniformly; and the `haiku` call above is the only metered thing in the
system.

**Data corruption proper is well defended** — the per-model write lock, `assertVectorWidth` at read,
and `loadIndex`'s model check. The residual irreversible-loss risk is not in SQLite. It is in the
vault, concentrated in the vault-mutating movers. Both were covered on 2026-08-19:
`scripts/prune-logs.mjs` was ported out of shell and tested (backlog #9), and
`hooks/vault-memory-sync.sh` got a characterisation test while keeping its `H4` fence (backlog
#10). Coverage is not the same as safety here — the pruner's defects were fixed, the sync
script's three were only pinned, so the two silent-loss paths in `H4` are still live and are now
the largest known irreversible-loss risk in the system.

## The one-paragraph read

A **procedural core with one shared kernel and four out-of-band services**, wearing the folder names
of a layered plugin. `paths.mjs` is the kernel and, since #20, the sole resolver — everything
depends on it, and the two shell programs left on the runtime path — `vault-memory-sync.sh` and
`doctor.sh`, joined by `vault-env.sh` which is sourced rather than run — depend on it too, by
asking. (`release.sh` is the exception that proves the rule: a dev tool, zero references to
`node`, `env.mjs` or `vault-env.sh`, and so no dependency on the kernel at all.) `prune-logs.sh`
was the fifth until 2026-08-19 and never asked: it resolved nothing and took its directory as an
argument, which is why porting it cost nothing anywhere else. `scripts/memory-semantic.mjs`
is a monolith that is simultaneously CLI, schema owner and daemon, and the rest of the system reaches
it over a socket, over SQLite, and over `execFileSync`, never over an import. The `lib/` split is a
**testability seam, not an architectural one**, which is exactly why it holds in the simple modules
and dissolves in the complex ones — including the three #20 added, which comply precisely because
they are simple.

---

# Maintaining this document

- **Part 1 describes intent; Part 2 describes reality.** When you close a gap, Part 1 absorbs the
  new truth and the Part 2 entry stays where it is, marked **CLOSED** with the date and the PR.
  Never delete it. (The first draft said "move the entry to Part 1", and the first three closures —
  `H1`, `H12`, `R2` in #20 — showed why that does not work: once the hack is gone there is nothing
  to *say* in Part 1 beyond what the design section already says, while the record of what was
  wrong, and what closing it cost, is worth keeping exactly where someone hunting the same shape
  will look. `H1` carries the re-keying bug its own closure introduced.)
- **The invariants table is the highest-value section — keep the middle column honest.** "Enforced
  by: NOTHING" is a useful, true statement. A rule listed as enforced when it is not is the exact
  mistake this table was written to prevent.
- **Same conventions as the rest of `docs/`**: every measurement names its conditions, every
  retrieval number names its case set, and a decision that changes gets a new dated record in
  `decisions/` rather than a quiet edit here.
- **This is a guide, not a decision record** — it *should* be edited in place as the code moves.
- Line numbers rot; this document cites **files and function names**, and only names line numbers
  where the exact position is the point. Keep it that way.
