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
[`hooks/lib/vault-env.sh`](../hooks/lib/vault-env.sh).

## Module map

```
                        ┌──────────────────────────┐
                        │  hooks/lib/vault-env.sh  │  SOURCE OF TRUTH
                        │  resolve_vault           │  vault path, memory home,
                        │  memory_home             │  recall arming, project_key
                        │  recall_enabled          │
                        │  project_key (+ cache)   │
                        └────────────┬─────────────┘
                                     │ mirrored by, and shelled out to
                                     ▼
                        ┌──────────────────────────┐
                        │   hooks/lib/paths.mjs    │  THE KERNEL
                        │  vault() config()        │  every Node module imports it
                        │  memoryHome() stateDir() │  config() is memoised — see H8
                        │  projectKey() -> bash    │  forks bash — see H1
                        │  useModelCache()         │  mutates a 3rd-party global — H2
                        └────────────┬─────────────┘
                                     │
        ┌──────────────┬─────────────┼──────────────┬──────────────────┐
        ▼              ▼             ▼              ▼                  ▼
  ┌───────────┐  ┌───────────┐ ┌───────────┐ ┌────────────┐  ┌─────────────────┐
  │ insights- │  │ memory-   │ │ validate- │ │  distill-  │  │ scripts/lib/    │
  │ surface   │  │ link-lint │ │ note      │ │  session   │  │ memory-semantic │
  │           │  │           │ │     │     │ │            │  │ (pure fns only) │
  └───────────┘  └───────────┘ └─────┼─────┘ └─────┬──────┘  └────────┬────────┘
                                     │             │                  │
                                     │ imports     │ spawns           │ imported by
                                     ▼             ▼                  ▼
                          ┌────────────────────┐  ┌──────────────────────────────┐
                          │ scripts/lib/       │  │ scripts/memory-semantic.mjs  │
                          │ memory-audit-checks│  │ 843 lines — see G1           │
                          └────────────────────┘  │  CLI · model lifecycle ·     │
                                                  │  SCHEMA OWNER · indexer ·    │
                                                  │  4 reports · search · DAEMON │
                                                  └──────────────────────────────┘
```

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
   ├─▶ hooks/semantic-index-refresh.sh     10s   take $MEM_HOME/.semantic-index.lock,
   │      (detached; see R1/R2)                  detach `node memory-semantic.mjs --index`
   │
   └─▶ hooks/graph-staleness-check.sh      10s   regenerate GRAPH_REPORT.md if stale
          (detached; needs codebase-memory-mcp)
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
                                     └▶ FALLBACK: own BM25 over
                                        SELECT ... WHERE heading = '(card)'
                                        gate MIN_SCORE 6.0        (second impl — H6)

  Every decision is logged, abstentions included. A prompt must NEVER wait on this.
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
              │           searchIn(index, q, qvec, k)
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
SessionEnd AND Stop  ──▶ hooks/distill-session.sh  (bash gate, 15 s, detaches)
                            └─▶ hooks/distill-session.mjs -> lib/distill-session.mjs
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

  Note the timeout arithmetic: a 15 s hook wrapping work budgeted to 600 s. Only correct
  because the .sh detaches.
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
| One `--index` writer per model | **code** — `.index-<model>.lock`, `mkdir` + stale reclaim | cross-process |
| Entry files are thin wrappers over `lib/` | **NOTHING** | holds in 5 of 9; see [G1](#g1--the-entrylib-rule-is-inverted-where-it-matters) |
| No retrieval number without a case set | **NOTHING** — convention | already violated once, `MIN_SCORE = 6.0` |
| Embedding batch size is 1 | **NOTHING** — comment only | padding changes the embedding; competing notes sit ~0.001 apart |
| All mutable state in `$CLAUDE_MEMORY_HOME` | **partial** — `.gitignore` covers `*.db`, `*.log`, `*.sock` | nothing checks the positive case |
| Model profiles never share thresholds | **NOTHING** — comment only | copied thresholds once made both scans report a clean vault |

---

# Part 2 — how things really work

Everything above is the design. Below is what the code does.

## G1 — the entry/`lib/` rule is inverted where it matters

The stated rule: `hooks/<name>.mjs` owns argv, stdin and stdout **and nothing else**. True for five
entries. In the four that carry the real behaviour it is reversed:

| Entry | Entry | Lib | Entry tested? |
| --- | ---: | ---: | --- |
| [`scripts/memory-semantic.mjs`](../scripts/memory-semantic.mjs) | **843** | 628 | no |
| [`scripts/memory-audit-checks.mjs`](../scripts/memory-audit-checks.mjs) | **321** | 241 | no |
| [`scripts/memory-eval.mjs`](../scripts/memory-eval.mjs) | **257** | 84 | no |
| [`hooks/memory-recall.mjs`](../hooks/memory-recall.mjs) | **253** | *none* | no |

**This is not cosmetic.** All four CI invariants key off the `lib/` boundary, so code left in an
entry is **exempt by construction** — and the `node:sqlite`-only-in-entries rule actively pushes
database code there. The 843-line file is the least-checked file in the repo.

`scripts/memory-semantic.mjs` is a god object with seven responsibilities in one module scope: CLI
parsing, ONNX model lifecycle (`loadEmbedder`/`unloadEmbedder`/`embed`), **sole owner of the SQLite
schema** (`CREATE TABLE chunks`), the indexer, four analysis reports, the search engine
(`loadIndex`/`searchIn`), and a network daemon. Dispatch is straight-line
`if (flag('--x')) { ... process.exit() }` — block order *is* precedence, and `flag('--serve')` is
tested in five separate places. The file cannot be imported, only executed, which is why it has no
test.

The split was drawn along *"is it testable?"*, not *"is it a boundary?"*. `searchIn()` — the
function that decides what you actually see — stayed on the untested side.

## B1 — `hooks/` and `scripts/` are not layers

```
  hooks/lib/validate-note.mjs ──────────▶ scripts/lib/memory-audit-checks.mjs
                                                        │
  scripts/lib/memory-semantic.mjs ──┐                    │
  scripts/lib/memory-eval.mjs ──────┤                    │
  scripts/lib/memory-synth-vault.mjs┤                    │
  scripts/lib/model-default.mjs ────┼────────────────────┴──▶ hooks/lib/paths.mjs
  scripts/memory-semantic.mjs ──────┘
```

The arrows point both ways. The directory names describe **who invokes the file**, not a dependency
direction. There is exactly one real layer — `paths.mjs` — and it is misfiled under `hooks/`, so
seven files reach up through `../../hooks/lib/` to get it.

Consequence: `validate-note` is a `PostToolUse` hook firing on **every Write/Edit in every session**,
and it pulls the whole `/memory:health` audit engine in by import. Deliberate (the comment says
imported-not-spawned, to avoid a fork), but it puts the audit module's import cost on the edit path.

## Implicit services — four, none with a definition

| Service | Invoked from | Contract lives where |
| --- | --- | --- |
| the search daemon | `memory-recall.mjs` over a unix socket | **hand-written on both sides**; only `QUIT` is shared |
| the SQLite index | `memory-semantic.mjs` writes, `memory-recall.mjs` reads with its own SQL | the `CREATE TABLE`, and five bare `'(card)'` literals |
| headless `claude` | `lib/distill-session.mjs` → `claude -p --model haiku` | argv, hardcoded model |
| `context-mode` CLI | `lib/distill-session.mjs` → `cm index` ×5 | argv, and a **different** identity scheme (H7) |

## Known hacks

Each of these is load-bearing. None is an accident; most have a dated measurement behind them.

**H1 — `projectKey()` forks bash.** `paths.mjs` shells out (`bash -c '. "$0"; project_key "$1"'`)
so the sed pipeline over git remote URLs stays single-implementation. The most-called identity
function in the system is a subprocess. Mitigated by a cache stamped to **whole-second** mtime — a
float would make every shell-side lookup a silent miss.

**H2 — `useModelCache()` mutates a third-party global.** `transformers.env.cacheDir` is assigned
directly because transformers.js v4 ignores both `HF_HOME` and `TRANSFORMERS_CACHE` (verified
2026-08-15). This one assignment is the only thing keeping 722 MB of weights out of the
version-pinned plugin dir. A rename upstream is silent; `doctor.sh` checks for the symptom.

**H3 — stubs that throw.** `stubs/sharp` and `stubs/onnxruntime-web` are ~1 KB modules replacing
147 MB. They exist rather than being deleted because both are *static* imports. npm `overrides`
cannot do this — pointed at a local stub npm writes a lockfile it then rejects, and Claude Code
installs with `npm ci`. Measured 2026-08-18.

**H4 — `vault-memory-sync.sh` is fenced off by policy.** 160 lines, no test, moves files and
repoints a live symlink in a cloud-synced dir. It has cost 24 notes once. Two documents carry a
standing prohibition on porting it. The risk is real; so is the fact that the riskiest file has the
least coverage.

**H5 — the socket protocol is written twice.** Client sends `{q, k, slug}`; server destructures
`{q, k = 5, slug = SLUG}` and replies with six fields. The same file also emits a *different*,
three-field response for `--json` query mode — so the eval harness and the recall hook score
against structurally different views of the same search. No version field. The client's
`r.text ?? ''` is the tell that this has already been noticed.

**H6 — text processing is forked four ways.**

| Where | Stopwords | Filter | Splitter |
| --- | ---: | --- | --- |
| `scripts/lib/memory-semantic.mjs` (`STOP`/`lexTokens`) | 71 | `len > 2` | `/[^a-z0-9]+/` |
| `hooks/memory-recall.mjs` | 71 (`with` listed twice) | `len > 2` | `/[^a-z0-9]+/` |
| `scripts/memory-audit-checks.mjs` | 62 | `len > 3` | keeps hyphens |
| `hooks/lib/distill-session.mjs` (`tokens`) | own array | `len > 2` + singularise | `\p{L}\p{N}` |

BM25 is implemented twice: `bm25()` in the lib, and inline in `memory-recall.mjs`. **The recall
fallback therefore scores by a different implementation than the primary path it falls back from**,
which is why its gate had to be tuned separately — and why that gate has no case set behind it.
Root cause: `memory-recall.mjs` has no `lib/` twin, and importing the lib would drag `node:sqlite`,
`net` and the model registry onto the prompt path.

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
resolution therefore has four implementations, not two: `vault-env.sh`, `paths.mjs`, `doctor.sh`
(which correctly sources the first), and ten hand-copied preambles.

**H12 — two locks guard one resource.** `$MEM_HOME/.semantic-index.lock` (shell, SessionStart only,
30-minute stale reclaim) and `$DB_DIR/.index-<model>.lock` (Node, per model). The Node lock is the
one that protects integrity; both `distill` and `/memory:prune` call `--index` directly and take
only that one. The shell lock's contention path is `exit 0` with **no output**.

## Where failure is silent

The system's defences are excellent where it has already been burned and absent where it has not.
These are the paths where a fault produces no error — ranked by expected cost.

| # | Failure | Mechanism | Blast radius |
| --- | --- | --- | --- |
| R1 | **Full re-embed storm** | the incremental path keys on exact mtime equality — and `prune-logs.sh` states in a comment that Synology sync churns mtime | 20–40 min CPU at batch size 1; cascades into R2 |
| R2 | **Silently skipped indexing** | H12: a legitimate long `--index` or a killed session holds the shell lock; SessionStart then `exit 0`s quietly for up to 30 min | stale recall, no message |
| R3 | **False merge deletes a lesson** | `findNearDuplicate` at 0.40 token overlap, unattended, on `haiku`-generated titles; a merge writes an "Also seen" addendum and **looks like success** | one note, unrecoverable |
| R4 | **Recall's keyword arm dies** | change the `'(card)'` sentinel in `chunkNote()` → recall's raw SQL returns 0 rows → `avgdl` is `NaN` → all scores `NaN` → abstain. **Abstention is its normal behaviour.** | keyword arm dead, no signal |
| R5 | **Unbounded `$CLAUDE_MEMORY_HOME`** | no `VACUUM` anywhere; per-project × per-model `.db` files accumulate; `models/` accumulates per model; `semantic-index.log` appends with no rotation; `prune-logs.sh` touches only the vault | multi-GB, noticed late — precedent: the 2.2 GB `node_modules` found by accident |
| R6 | **Weights re-downloaded per version** | H2 breaks on a transformers rename | ~700 MB × versions |
| R7 | **Slimming prunes nothing** | `slim-install.mjs` walks a hardcoded upstream layout and *fails safe* | 380 MB/version; only the `install` CI job notices |
| R8 | **Symlink-dereference bugs** | fixed once already (`du` without `-L`); `semantic-index-refresh.sh`'s `[ ! -d .../node_modules/... ]` is correct only because `test -d` happens to dereference | a check that measures nothing |
| — | **Runaway `claude` recursion** | `CLAUDE_DISTILL_CHILD` is the only guard, on a hook registered for both `SessionEnd` **and** `Stop` | low probability, **unbounded** cost |

There is **no auth and no billing surface** — single user, one unix socket. The nearest analogues:
the socket is created with no `chmod`/`umask` and the slug is a request field, so any local process
can query any project's index (harmless on a single-user machine, not on a shared host); and the
`haiku` call above is the only metered thing in the system.

**Data corruption proper is well defended** — the per-model write lock, `assertVectorWidth` at read,
and `loadIndex`'s model check. The residual irreversible-loss risk is not in SQLite. It is in the
vault, concentrated entirely in the two untested `mv`-wielding shell scripts:
`hooks/vault-memory-sync.sh` and `scripts/prune-logs.sh`.

## The one-paragraph read

A **procedural core with one shared kernel and four out-of-band services**, wearing the folder names
of a layered plugin. `paths.mjs` is the kernel; everything depends on it and it depends on a bash
subprocess. `scripts/memory-semantic.mjs` is a monolith that is simultaneously CLI, schema owner and
daemon — and the rest of the system reaches it over a socket, over SQLite, and over `execFileSync`,
never over an import. The `lib/` split is a **testability seam, not an architectural one**, which is
exactly why it holds in the simple modules and dissolves in the complex ones.

---

# Maintaining this document

- **Part 1 describes intent; Part 2 describes reality.** When you close a gap, move the entry from
  Part 2 to Part 1 rather than deleting it, and say what closed it.
- **The invariants table is the highest-value section — keep the middle column honest.** "Enforced
  by: NOTHING" is a useful, true statement. A rule listed as enforced when it is not is the exact
  mistake this table was written to prevent.
- **Same conventions as the rest of `docs/`**: every measurement names its conditions, every
  retrieval number names its case set, and a decision that changes gets a new dated record in
  `decisions/` rather than a quiet edit here.
- **This is a guide, not a decision record** — it *should* be edited in place as the code moves.
- Line numbers rot; this document cites **files and function names**, and only names line numbers
  where the exact position is the point. Keep it that way.
