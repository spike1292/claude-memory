# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). For a plugin, "the API" is
what a user's setup depends on: config keys, command names, vault layout, and
`$CLAUDE_MEMORY_HOME`. A change that forces a re-index or moves a note counts as breaking.

## [Unreleased]

### Fixed

- **`vault-env.sh` silently resolved the wrong vault when sourced from zsh.** It located
  `scripts/env.mjs` via `BASH_SOURCE`, which is bash-only; under zsh that is unset, `dirname ""`
  is `.`, the entry is never found, and `_memory_env_load` falls into DEGRADED — which by design
  ignores `config.json` and returns `~/Documents/ClaudeVault` plus a cwd-slug instead of the
  git-remote project key. The two shell files that source it are bash, so hooks were unaffected;
  the reachable surface is the command files — nine of them, including `/memory:save` and
  `/memory:resume`, tell the agent to source it directly, and an agent's Bash tool may be zsh.
  A save then wrote to an empty scaffold at the default path under the wrong slug, and
  `/memory:doctor` reported the vault correctly the whole time because `doctor.sh` runs under bash.
  Path derivation is now shell-agnostic, with zsh's `${(%):-%x}` kept inside `eval` so bash never
  parses it. `hooks/lib/vault-env.test.mjs` covers it and fails without the fix.

### Changed

- **The distiller now dedups against embeddings, not word overlap.** Its body-overlap arm caught
  **0 of 25** real duplicates and every one of its nine firings was a false positive; no threshold
  separates the classes, because two notes stating one lesson in different words share almost no
  vocabulary at ~30 tokens a note. The new reconcile embeds the note's card and asks the resident
  search server for the nearest same-folder note at the calibrated `dupeMin`. It needs no
  re-index — the candidate is embedded as a query against the cards already indexed — so the
  SessionEnd latency the 2026-08-17 comment feared does not exist. The lexical body arm is deleted
  rather than kept as a fallback; with no server or no index the slug arm is the whole dedup, and a
  distiller that cannot dedup still writes. Measurements and the refutation of the 2026-08-17
  calibration: `docs/decisions/2026-08-23-embedding-reconcile.md`.
- **Two insights restating one lesson in a single distillation now produce one note.** The index is
  rebuilt after a run, so notes written seconds earlier were invisible to it and the same event was
  written twice — observed twice on 2026-08-22. The distiller keeps this run's vectors in memory and
  checks them with the same predicate.
- **One predicate decides what a duplicate is**, shared by the write-time reconcile and `--dupes`.
  They disagreed before, which is how an arm catching 0/25 survived five days of daily evidence.
- **A comment's home is decided by reader distance, not by its length** (#36). A fact needed by
  whoever edits the function stays, in one line where it fits; a table, sweep or weighed alternative
  moves to
  `docs/decisions/` (a past choice) or `docs/architecture.md` (a hack or silent failure still true);
  a restatement of the code dies. The length rule this replaces would have deleted the most
  load-bearing blocks first — the three longest in the tree are a baseline table, a before/after
  bench and a model comparison. JSDoc *annotations* are out of scope — `@param` restates the code by
  design and `tsc` reads it — but prose inside a JSDoc block is still prose and still governed, most
  of `trimLog`'s 30 lines among it. `claude-review.yml`'s prompt carries the new
  rule, since it is the reviewer that gates the sweep. Rule and measurement:
  `docs/decisions/2026-08-23-comment-reader-distance.md`. Policy only; the sweep is a second PR.

### Added

- **`reconcile: manual` — a per-note mark meaning "never auto-fold anything into this note".**
  Cross-linking two notes RAISES their similarity, so an audit that correctly relates a kept pair
  pushes it over the merge bar (0.754 → 0.762 observed). Set it with
  `node scripts/memory-mark.mjs <note> [...]`, which `/memory:prune` now runs on every pair you keep.
  It blocks both dedup arms, and each blocked merge is reported as a `declined` count beside
  `wrote` and `merged`.
- **`memory-semantic.mjs --dupe-eval --truth <file.jsonl>`** — the acceptance sweep, reporting
  caught/total with the false count beside it over every same-folder pair, plus the keeps a bar
  would wrongly propose. The harness ships; the truth file names a private vault's notes and is
  gitignored, exactly like the retrieval case sets.

- **`memory-eval.mjs` now refuses an argument it does not recognise instead of ignoring it.** Three
  shapes were discarded in silence, each making the run score the **default** case set while
  printing a recall figure the operator would read as belonging to the file they had just named:
  `--cases=other.jsonl` (`val()` has only ever read the space-separated form), a misspelled flag
  name like `--casess`, and any other unknown `--flag`. All three now exit 1; the equals form says
  which form to use, and an unknown name prints the set of known flags. A scripted invocation using
  any of them appeared to work and did not.
- **A scored `--run` prints `cases: <path>` under the summary line.** The `--json` output has always
  carried the case-set path; the human-readable one did not, so nothing in it contradicted a wrong
  belief about which set had been read. Anything parsing that text output sees one new line.
- **A value-taking flag with no value is refused instead of ignored.** `--cases` last in argv gave
  `undefined` and `--cases --mode lexical` swallowed the next flag; both scored the default set. The
  check lives in `val()` itself, so it covers every flag that reads a value rather than a list that
  could miss the next one. `--generate` keeps its documented bare form.
- **`--run` against a vault with no notes refuses rather than scoring.** Zero resolvable gold is a
  property of the vault there, and the corpus-mismatch message blamed the case set for it.
- **`--run --json` reports `goldResolved`/`goldTotal`.** The churn warning is stderr prose, so a
  machine reading the envelope could not tell a full case set from one a prune had eaten part of.
- **`--run --json` reports recall only at the ks the fetch window can answer.** A k=5 fetch cannot
  measure @10, which the human output already honoured and the envelope did not — so `--fetch-k 3`
  emitted an @5 and an @10 that were @3 censored to the window, indistinguishable from real
  figures. A consumer passing `--fetch-k 5` now gets keys `1,3,5` where it used to get `1,3,5,10`.

### Fixed

- **A malformed or misdirected case set now refuses with a message instead of crashing or
  reporting zeros.** Four inputs used to escape: a truncated JSONL line threw `SyntaxError` from
  inside a `.map()`, `--cases` pointing at a directory threw `EISDIR`, a case line missing its
  `gold` array or its `q` threw `TypeError` part-way through scoring or authoring, and a non-numeric
  `--fetch-k` emptied the recall-k list so `--json` reported every k as 0 at exit 0. That last one
  is the dangerous shape — a confident all-zero figure attributed to a named case set.
- **A question with nothing searchable in it produced a figure with no retrieval behind it.** A
  blank or punctuation-only `q` (`""`, `"   "`, `"???"`) is not missing, so it passed validation,
  tokenised to nothing, and tied every BM25 score at 0 — leaving the ranking as whatever order the
  documents arrived in. Measured 2026-08-23: recall@1 100% on a 3-note vault where k exceeds the
  corpus, 0.0% on the 60-note bench vault. A case now needs at least one letter or digit; questions
  in any script still score, since the check is `\p{L}\p{N}`, not the ASCII-only `\w`.
- **`--author` with empty stdin overwrote the case set with an empty file, exit 0.** It has no
  `--force` gate at all, so a producer that failed, a `< /dev/null`, or a filter matching nothing
  silently replaced the authored baseline every past number was measured against. It now refuses to
  write an empty set. Same data loss as the `--generate` bullet below, on the less guarded branch.
- **`--generate` followed by another flag overwrote the case set with an empty file, exit 0.**
  `--generate --force` made `Number('--force')`, so the stride was `NaN` and the sample loop never
  ran — destroying the authored baseline every past number was measured against. A flag after
  `--generate` now means the documented default of 40, and a non-numeric count is refused.
- **`/memory:eval` scored every project against whichever one authored a case set first.** The
  command passed `--cases "$STATE/eval/eval-cases-authored.jsonl"` — a name with no slug in it, in a
  machine-local directory shared by every project on the machine — which overrode the slug- and
  style-scoped default `memory-eval.mjs` already resolved correctly. Measured 2026-08-23 from this
  repo: **2 of 32** gold refs in that set resolved to a note in this vault (both in cross-project
  `permanent/`), against **53 of 53** for the same project's scoped set. The `--cases` argument is
  gone from both invocations, and the doc now says why not to reintroduce it.
- **`--run` reported a mismatched case set as a recall figure instead of refusing it.** `--author`
  has always resolved every gold note and failed on a missing one; `--run` checked only that the
  case *file* existed, so another vault's questions produced a confident 0%. It now resolves gold
  before scoring: below a 50% floor it aborts as a corpus mismatch, above it warns and scores, so a
  gold note lost to a prune stays a warning. Failures report **counts only, never note names** —
  those may belong to another project's private vault, and this output is pasted into public issues.
  The recall hook's `MIN_SCORE` sweep comment no longer names the unscoped file either; it describes
  the property an off-topic control set needs.
- **`/memory:health` reported every L1 note as missing from the MOC.** `MEMORY.md` is written with
  markdown links (`[Title](note.md)`), but `memory-audit-checks.mjs` scanned it for `[[wikilinks]]`
  only — so it called all 8 notes orphaned on 2026-08-22. MOC membership now accepts both forms;
  the note-graph checks stay wikilink-only, because a markdown link from the MOC is exactly what
  does *not* make a note reachable from a sibling.
- **The same parser drift had silently disabled the MEMORY.md figure-drift check.** `findDrift()` in
  `hooks/lib/memory-link-lint.mjs` gated on `line.startsWith('- [[')`, which is never true on a real
  MOC — `readNote` was called **0 times** against this repo's own `MEMORY.md`, so a check
  `/memory:health` had raised in four consecutive audits had been reporting nothing ever since the
  MOC moved to markdown links. Every one of its tests passed throughout, because each used the
  wikilink form: the "test written against the copy stays green while the dependency goes dead"
  failure this repo already documents. Both link forms are now accepted, and the new test asserts
  `readNote` is actually reached. There is now **one** parser for "which note does this link point
  at" — `noteTargets()` — called by both `findDrift()` and the MOC check, rather than a regex per
  caller; `linkTargets()` stays deliberately wikilink-only for the note-graph checks.
- **A bash `[[ $var =~ … ]]` test inside a fenced code block was reported as a dangling wikilink.**
  Link scanning now strips fenced and inline code first.

### Added

- **`MEMORY.md` is measured against the cap Claude Code loads it under, so truncation of L1 is
  never silent.** Claude Code's own auto memory reads
  `~/.claude/projects/<project>/memory/MEMORY.md` — the path this plugin symlinks into the vault —
  and keeps only the first 200 lines or 25 KB. For a
  file it did not write it reports nothing when it drops the rest, and nothing in this plugin
  bounded it either. The SessionStart lint now names the size from 80% of the cap up and says
  outright that content is being dropped past 100%, and `/memory:doctor` gains an `auto memory`
  section reporting every `Memory/<slug>/MEMORY.md` in the vault against it — naming only the
  project it is run from, because that report gets pasted into issues and the other slugs are
  normalised remotes of private repos. The cap is one constant read by both. Nothing trims the file:
  what leaves the MOC is judgement, the same reason the link lint names orphans rather than linking
  them. The decision to co-operate with Claude Code at that path rather than separate via
  `autoMemoryDirectory`, and the answer on the `modified`/`node_type` stamps a second writer has
  been putting in 40 of 57 vault notes (and in one of the two MOCs) since 2026-08-04 (keep them; we write none and strip none),
  are in [docs/decisions/2026-08-22-auto-memory.md](docs/decisions/2026-08-22-auto-memory.md).
  ([#75](https://github.com/spike1292/claude-memory/issues/75))

## [0.6.0] - 2026-08-22

### Added

- **[docs/vision.md](docs/vision.md) — what this is for, who it is for, what it refuses to be, and
  where it is heading**, with a primary source for every claim and `[inferred]` on anything drawn
  from a pattern of decisions rather than stated outright. It is a guide, edited in place, not a
  dated record. Section 5 is the one place in the repo that states intent rather than fact, and says
  so. `docs/architecture.md` gains the invariant it leaned on unwritten: the Markdown is the source
  of truth and every index is derived.

- **Retention for `$CLAUDE_MEMORY_HOME/logs/`, so the directory is bounded on both of its axes.**
  The free-form logs were capped at 1 MB; the dated JSONL families (`recall-<date>`, `hooks-<date>`)
  accumulated one file per active day, forever, in machine-local state no release replaces. They are
  now deleted past `logRetentionDays` — 30 days by default, settable in `config.json` or via
  `MEMORY_LOG_RETENTION_DAYS` ([#53](https://github.com/spike1292/claude-memory/issues/53)). Size
  for the appends, age for the dated files, because the read views (`/memory:doctor --stats`,
  `--hooks`) query a window of days — which retention now caps. The prune runs on the first log line
  of a new day rather than from `/memory:prune`, and a pass that deleted anything records `pruned:
  n` on that line, which `--hooks` sums. `/memory:doctor` reports the window and the oldest dated
  file beside the directory size.

- **`/memory:doctor --hooks` — what every hook did, and how long it took.** Nine hook invocations
  fire per session and none of them recorded anything, so a hook that has been permanently dead
  since a dependency vanished looked exactly like a healthy one: both exit 0 and print nothing.
  Every Node hook now appends one line per invocation to a daily-dated `hooks-*.jsonl` beside the
  recall logs — hook, event, elapsed ms, an outcome from a closed set (`ran`, `spawned`,
  `debounced`, `child-guard`, `noop-missing-dep`, `error`), a short reason, and the session id. The
  new flag aggregates the last 7 files and reports invocation counts and p50/p95/max duration per
  hook AND event — `distill-session · Stop` fires every assistant turn and stands down, while
  `distill-session · SessionEnd` is the run that reads the transcript, and merging them let the
  cheap one bury the only path that can breach a timeout —
  the outcome breakdown, and how many invocations ran at or past **half** their declared timeout.
  The timeouts are read from `hooks/hooks.json` at run time and are written down nowhere else, so
  they cannot drift. `--hooks=30` widens the window. Read-only in the same hard sense as `--perf`
  and `--stats`: it runs no hook, starts nothing, writes no file, and reports an absent log as
  "not measured".
  The `logs/` directory is machine-wide, so the report is **scoped to the project it is run from**
  and says how many invocations in the window belonged to others. Unlike `--stats` it prints no note
  names, and it redacts paths out of failure reasons — a raw `ENOENT` carries the vault root, a note
  filename and the OS username, and this is the report people paste into issues. The full message
  stays in the log file on the machine that wrote it. It does still print the project slug, the
  normalised git remote, which names a private repo.
  Two limits it states in its own output rather than leaving to be discovered: a hook killed at its
  timeout is killed by a signal and writes no line, so **a real breach is invisible** and the
  near-timeout column counts only how close the survivors ran; and a headless `claude` run fires
  SessionStart itself, so lines written inside one are flagged and counted separately from lines a
  session produced.
  ([#46](https://github.com/spike1292/claude-memory/issues/46))
- **A worker line for two of the three detached hooks.** `distill-session` and
  `semantic-index-refresh` decide in milliseconds and hand the real work to a detached child, so
  their own elapsed time measures a gate and never the work. Each background run now writes its own
  line — same session id, `event: worker` — carrying its real duration and whether it failed. The
  session id travels in `MEMORY_HOOK_SESSION`, which the gate exports. The indexer's line is guarded
  by a SECOND variable, `MEMORY_INDEX_HOOK`, and the difference is load-bearing: a session id is
  inherited down the process tree, and the distiller runs an indexer of its own at the end of every
  distillation, so guarding on the session id alone filed that SessionEnd re-index under
  SessionStart. The marker also keeps a manual `/memory:prune` out of a per-hook report.
  **`graph-staleness-check` deliberately gets none.** The pid written into `graphgen.lock` has to
  belong to a process that lives exactly as long as the work does, because `lockHolder()` frees a
  lock whose pid is dead — so nothing may sit between the hook and the headless `claude` it starts.
  The report names that gap rather than leaving its absence to read as a run that never happened.
- **A gate that detaches now reports a failed spawn.** `detach()` returns a null pid when the fork
  fails, which is the only signal there is — it fails asynchronously — and both gates previously
  discarded it and logged `spawned` regardless. A re-index or a distillation that never started now
  reads as `error`, which is the whole point of recording an outcome.
  Measured with `node scripts/bench-hooks.mjs -n 40 --notes 50` before and after: **+1.5 to +3.6 ms
  per hook** at the median, against a 31.5 ms bare-node floor. A disarmed recall is unchanged
  (36.7 → 35.7 ms) because nothing is logged above the arming gate, and an armed one is flat at the
  median despite writing two lines, since it had already resolved the project key and paid one
  append. The one new cost worth naming: `validate-note` did not previously resolve a project key.
  In an ordinary clone that is one git fork on the first Write, into a cache every later hook reads.
  **In a git worktree or a submodule it is not cached at all** — `projectKey()` refuses to cache a
  checkout whose `.git` is a file, because it cannot cheaply validate the stamp — so every
  Write/Edit forks git, measured at 14.6 ms in a worktree of this repo on 2026-08-21. The bench
  numbers above were taken in an ordinary clone and do not include it.

- **`/memory:doctor --hooks` now answers what the hooks COST, not just what they did**
  ([#47](https://github.com/spike1292/claude-memory/issues/47)). Two costs, kept visibly apart:
  - **Injected context, estimated.** The insights surfacer and the link lint record the byte size
    of what they put in the context window; recall's existing character count is folded in from its
    own log family rather than duplicated. The report gives mean/p50/p95 estimated tokens **per
    session** for each injector — averaged over every session the hook ran in, including the ones
    where it injected nothing, so an occasional injector is not billed to every session — plus the
    number of sessions it injected in, the per-session total across injectors, and a warning when
    that total crosses 2000 tokens. Lines written inside a headless `claude` run are excluded: every
    distillation fires SessionStart again, and those are real runs but not a person's session. The
    estimate is `bytes / 4`, no tokeniser and no new dependency, and every figure derived from it is
    labelled an estimate. A hook that never recorded a byte count is left out of the table rather
    than counted as free.
  - **The distiller's bill, measured.** Its headless run now asks for `--output-format json`, so
    its own usage figures are available: input, cache-creation, cache-read and output tokens plus
    the dollar cost, recorded on an `event: extract` line and reported per run and per log day (the denominator is
    printed, since a day nothing was logged has no file to count), with each column averaged
    over only the runs that carried it — the API omits cache-creation when nothing was cached, and
    counting that absence as zero halved the figure for the run that was measured. An extract line
    is a cost record rather than a hook invocation, so it is kept out of the invocation table where
    it would otherwise be judged against a timeout it is not subject to.
    A run that was billed and then failed still records what it cost, marked `error`: the money was
    spent, and the runs that fail are the ones worth finding. A CLI too old to know the flag retries
    once without it, so adding it cannot silently end distillation — but only when the first attempt
    produced no envelope, since an envelope proves the CLI understood the flag and retrying a run it
    already billed would buy a second bill nothing can record.
    Estimation was rejected on evidence — a throwaway prompt measured 9 input tokens against 18,078
    cache-creation and 22,363 cache-read at $0.0389, so the bill is a near-fixed overhead of the
    headless session and a length heuristic would have been wrong by orders of magnitude. If the
    envelope does not parse, the existing extractor runs on raw stdout exactly as before: a CLI that
    stops wrapping its output costs a cost figure, never a night's insights.
  The one injector that stays unmeasured is the bash session-sync hook, which is under a
  do-not-port fence. Its block was measured by hand instead — 1546 bytes, about 387 estimated
  tokens, rising to 472 when context-mode is not installed — and the report prints that beside the
  figures it measured rather than omitting the injector.

### Changed

- **Recall's inline JSONL appender is gone; it writes through the shared one.** Its records are
  unchanged — same field names, same order, same rule that an absent key means "not measured"
  rather than zero — and `--stats` reads exactly what it read before. Recall additionally writes a
  hook line, but only when it is armed: an inert feature must not cost every prompt a file append.

- **The plugin describes itself as an extension of Claude Code's own memory, not as a memory system
  of its own.** Claude Code's auto memory reads `~/.claude/projects/<project>/memory/MEMORY.md` —
  the path this plugin symlinks into the vault — so the two already share a file
  ([#75](https://github.com/spike1292/claude-memory/issues/75)). The marketplace and plugin
  descriptions and the README opening now say that plainly. No behaviour changed; this is what the
  plugin claims to be.

### Fixed

- **`findClaude()` looked for Homebrew only where Apple Silicon puts it, so every hook that shells
  out was a no-op on the Linux installs the README claims to support.** The fallback list — used
  when a GUI-launched session has no `claude` on `PATH` — held `/opt/homebrew/bin/claude` and
  nothing for Linux. It now also probes `/home/linuxbrew/.linuxbrew/bin/claude` and
  `~/.local/bin/claude`. The failure it caused was silent by construction: the distiller and the
  graph-report refresh both degrade to no-ops when the CLI is missing, which is indistinguishable
  from a hook that had nothing to do, so nothing reported it. `/memory:doctor` already warns when
  `claude` is off `PATH`, and that warning was the only signal.
- **`memory-synth-vault.mjs --notes` bounded the summary line but not the vault.** Gold notes and
  their echoes were written first and unconditionally, and only the filler loop consulted `--notes`;
  any value at or below the gold+echo count was ignored without a word, so `--notes 20` wrote 120
  notes and CI's `--notes 60` wrote 120 too
  ([#49](https://github.com/spike1292/claude-memory/issues/49)). The flag is now a ceiling on the
  whole vault: the gold cases scale down to what fits (`--notes 60` → 20 gold, 40 echoes), and the
  run prints how many of the available gold cases it fitted. `--notes`, `--echoes` and `--seed` must
  now be whole numbers, and a `--notes` below one gold note plus its echoes exits non-zero naming
  that minimum — `--notes abc` fell into `while (n < NaN)` and produced the full 120,
  `--notes 60 --echoes 0.5` wrote 80, `--notes Infinity` never terminated, and `--seed abc` wrote
  the seed-0 vault under a manifest reading `seed NaN`. Nothing is written before the refusal, so a
  rejected run leaves an existing vault at `--out` intact.
  Two consequences worth stating rather than discovering. **CI's synthetic vault is now the 60 notes
  its command always asked for**, down from 120, with 20 gold cases instead of 40 — the suite is
  green against it, and it feeds no retrieval figure. And **truncation keeps the gold cases spread
  across both axes the vault varies on**: round-robin across domains, because cutting the
  domain-major walk gave `--notes 60` twenty cases from four of the eight domains while filler kept
  coming from all eight; and layered by position in the selected set rather than by original index,
  because a domain has exactly as many cases as there are layers, so the first cut left `Decisions`
  and `permanent` with no gold at all. A case set whose coverage varies silently with a flag is the
  defect this fixed, one level up. `--notes 300` — the size every recall figure in this repo was
  measured at — is byte-identical to before. The one figure swept at another size, `MIN_SCORE`'s
  smallest leg, passed `--notes 100` and got 120; both places recording it now say 120.
- **`doctor.sh`'s search for a populated vault names its macOS-only candidate as such.** The
  `$HOME/Library/CloudStorage/*/*/Claude` glob matches nothing on Linux, where the recorded previous
  vault is the only candidate that carries. Marked rather than padded with guessed Linux sync paths,
  which would be candidates that are never hit and never noticed.

## [0.5.0] - 2026-08-20

### Added

- **`scripts/bench-hooks.mjs` — a repeatable measurement of what a hook costs at startup.**
  One line (`node scripts/bench-hooks.mjs -n 20 --notes 50`) times every hook against a synthetic
  vault in a scratch `HOME`/`CLAUDE_MEMORY_HOME` — it refuses to run if any of the three resolves
  outside the temp root, so it can never touch the real vault — and prints a markdown table ready
  to paste into a decision record. It measures the floor (`node -e ''`) and the imports as rows of
  their own, not just the hooks, which is what identified the change below.
  ([#37](https://github.com/spike1292/claude-memory/issues/37))
- **`/memory:doctor --stats` — what per-prompt recall actually did.** Both recall gates (cosine
  0.55, BM25 6.0) were tuned on small hand-made sets, and the comment beside each says to read the
  abstain rate in the log before moving it. Nothing could read it. The new flag aggregates the daily
  `recall-*.jsonl` files — the last 7 by default — and reports the injection and abstention rates,
  the abstentions grouped by reason, score and latency distributions split by arm, the most-injected
  notes, and the notes in this project's index that have **never** been injected. It is a second
  flag rather than more of `--perf` because it answers a different question, and because the hook
  and cost sections planned beside it belong next to this, not next to the RSS table. `--stats=30`
  widens the window. Read-only in the same hard sense as `--perf`: it starts no server, loads no
  model, writes no file of its own, and reports absent logs as "not measured" rather than arming
  recall to produce some. (Resolving the project key can refresh the shared `cache/project-keys.json`,
  exactly as `--perf` already did.)
  The `logs/` directory is machine-wide while an index is per project, so the report is **scoped to
  the project it is run from** and says how many decisions in the window belonged to others —
  measured here at 5 slugs in one 7-file window, so an unscoped rate would mostly have been another
  project's. It is also the only doctor section that prints note names from the vault, and it says
  so in its own output: safe to read, not safe to paste into a public issue.
- **Three optional fields on the recall log record**: elapsed milliseconds, the number of candidates
  the arm returned, and the candidate note paths in render order. Only `top` — a single note — was
  recorded before, so "which notes never surface" could not be answered from the log at all, and
  nothing on the recall path was timed. `injected` is a prefix of the candidate list, so a record
  where `k > injected` is one where rendering stopped early — the character budget for the semantic
  arm, and usually the trailing weak-hit floor for the keyword one, which applies it first. The
  clock lives in the hook entry, which owns it, and reads from process start, so `ms` includes
  node's own startup — the part of the wait nobody could otherwise see. The arms stay pure and
  untimed. Every new field follows `score`'s existing discipline — an unmeasured value omits its key rather than logging a
  `0` that reads like a measurement — and the reader counts each metric only over the lines that
  carry it, so log files written before this change stay readable and are reported as unmeasured
  rather than as fast. `via` semantics are unchanged: `'server'` is the fused vector arm and its
  absence is the BM25 fallback.

### Changed

- **SessionStart is ~35 ms cheaper, and every Write/Edit ~16 ms.** `insights-surface`,
  `memory-link-lint` and `validate-note` read their stdin payload with
  `await new Response(process.stdin).text()`, which boots Node's web-streams machinery to read a
  100-byte JSON object: 52.8 ms against a 34.6 ms floor, where `fs.readFileSync(0)` costs 35.1 ms.
  They now use `readStdin()`/`payload()` from `hooks/lib/hook-io.mjs`, which the gate hooks already
  did. Medians (n=20, synthetic 50-note vault on local disk): `insights-surface` 55.6 → 40.8 ms,
  `memory-link-lint` 60.2 → 42.0 ms, `validate-note` — the hottest hook in the system, it runs on
  every edit — 57.5 → 41.8 ms. No hook is import-bound: `paths.mjs` costs 5.2 ms and `node:sqlite`
  0.7 ms over the floor, so nothing was made lazy and nothing was bundled. Numbers, conditions and
  what was deliberately *not* cut:
  [docs/decisions/2026-08-20-hook-startup-cost.md](docs/decisions/2026-08-20-hook-startup-cost.md).
  ([#37](https://github.com/spike1292/claude-memory/issues/37))

## [0.4.0] - 2026-08-20

### Added

- **Type checking, as JSDoc rather than a build step.** `npm run typecheck` runs `tsc --noEmit` with
  `checkJs` and `strict` over every `.mjs` in the repo, tests included, and CI fails on any
  diagnostic. Source stays plain `.mjs` and stays directly runnable: nothing resolves an absolute
  install path and `hooks/hooks.json` names entry paths as a contract, so a `dist/` would have put a
  compiled file where both of those expect a source file. `tsc` is pinned and invoked through `npx`,
  never a devDependency, for the same reason Prettier is — and pinned to TypeScript 7, the native
  compiler, whose platform-specific binaries stay in the npm cache rather than any user's plugin
  cache precisely because `npx` runs it. A second step asserts that every tracked
  `.mjs` is actually in what `tsc` checked, because a check that passes by checking nothing has
  shipped here twice. The numbers behind the choice, all measured with 5.9.2 before the
  pin moved — 34 diagnostics under bare `checkJs` and none of them a real bug, 499 under `strict`,
  and 80 from `strictNullChecks` alone, so the staged path existed and was declined rather than
  ruled out — are in
  [docs/decisions/2026-08-20-types-and-linting.md](docs/decisions/2026-08-20-types-and-linting.md),
  which also records why no linter was added: of the three rules that were candidates, `tsc` gives
  one for free and a CI check already covers another.

- **`/memory:doctor --perf` — where the RAM, the disk and the milliseconds actually went.**
  `doctor.sh` could say whether a thing was wired up; it could not answer the question this plugin
  generates, since one `--serve` process holds a ~1.3 GB model, six of them once ran at once on a
  16 GB machine, and onnxruntime's arena never gives memory back. The flag appends four sections:
  every resident search server with its RSS, uptime and whether the model is currently loaded
  (`modelIdleMs` unloads it and leaves the socket and indexes behind, so the two states are an
  order of magnitude apart in RSS — 15 MB idle against 370 MB after a query, measured 2026-08-20 —
  and the threshold sits at the midpoint rather than near either); the recall round trip, timed
  twice, since a first query far above the second is an index loading on demand and not a slow
  server; every index on the machine with its size, chunk and note counts, marked against the
  active project and model, because an index on an inactive model is dead weight that every mode
  except `--index` refuses to touch; and the disk split under `$CLAUDE_MEMORY_HOME`.
  **Read-only is a hard rule here, not a preference**: it never starts a server, loads a model or
  re-indexes, so `not measured: no socket` is a state rather than a fault, and a socket file
  without a listener behind it — which outlives the process that bound it — reports as orphaned.
  That rule is why the round trip is only measured against a server that is already holding its
  model: a probe is a real query, the server embeds it, and embedding reloads the ~1.3 GB model that
  `modelIdleMs` had just unloaded. Measuring the unloaded state would have created the loaded one
  and reported a model load as a slow first query.
  It is a flag on the existing command rather than a second one: the numbers are only readable next
  to the wiring checks, and one paste is what an issue wants. Node rather than more bash because
  every line of it loops. The index filename split is driven by the model keys from `MODELS`, not
  by the last dash: both halves contain dashes (`semantic-github.com-spike1292-claude-memory-bge-m3.db`),
  and a second copy of that list here would drift and silently mislabel every row. Those keys come
  from a new `scripts/lib/models.mjs`, which is where the `MODELS` profiles now live: reading them
  from `memory-semantic.mjs` meant importing a module that resolves the active model at import time
  and `process.exit(1)`s on one it does not know, so a bad `model` in `config.json` truncated the
  whole report to one error line — in the exact case someone runs a diagnostic. `node:sqlite` stays
  in the entry point, which owns the handle and injects a reader, so the report module is testable
  without a database. Closes #38.

- **`hooks/vault-memory-sync.test.mjs` — a characterisation test for the one script the repo has
  always refused to touch.** 163 lines of bash that migrate `legacy_key` → `project_key`, move
  notes and repoint `~/.claude/projects/<slug>/memory`, with no test since the day it cost 24
  notes. It is driven as a black box — spawn bash, hook payload on stdin — from a scratch `HOME`
  built per subtest, never the inherited environment, because isolating `CLAUDE_VAULT` alone still
  leaves the live symlink in range; a final subtest asserts the real `~/.claude` is byte-identical
  afterwards. It asserts that the layer migration loses no note, the destination-exists guard blocks
  a merge, repointing a symlink COPIES (the 24-note guarantee), a second run is byte-identical to
  the first, a repo with no `origin` keys on the lowercased directory name with `.git` intact
  (#21), and the **payload `cwd` beats `$PWD`** — the line that decides *which* project's symlink
  gets repointed, and the one the other eleven cases cannot see, because they pass the same
  directory as both. Four cases record behaviour marked in-file as *characterised, not endorsed*
  rather than fixed, since a fix without this test is precisely what lost the notes: a subdirectory
  under a real memory dir is deleted rather than migrated, a note whose name already exists in the
  vault is deleted rather than kept, a legacy-slug folder that cannot be merged is stranded under
  the old key without a word, and the marker-file → `config.json` migration does not affect the
  run that performs it. Those four are the enumeration; `docs/architecture.md` H4 uses the same
  one. Verified by mutation on a throwaway copy of the repo, not by being
  green: reverting `cp -n` to a move, dropping the no-merge guard, deleting the `cat | jq` line so
  `$PWD` always wins, and reading `.cwdX` instead of `.cwd` each fail exactly one case and leave
  the other eleven passing. The real-`$HOME` guard records types and symlink targets only, never
  mtimes — `~/.claude-memory` is written by this plugin's own hooks every session (its mtime had
  moved 11 minutes before it was looked at on 2026-08-19), so an mtime in the oracle turns any
  concurrent session into a false accusation of a `HOME` leak, and an oracle that cries wolf gets
  muted.

- **`scripts/prune-logs.mjs` + `scripts/lib/prune-logs.mjs` — the log pruner, ported from bash and
  tested.** It moves vault files on a 90-day horizon and had no test; worse, its date arm was
  `date -j -f` on macOS falling back to `date -d` on Linux, so the branch CI could exercise was
  never the branch that ran. The port removes the fork and the split: dates still come from the
  filename (`YYYY-MM-DD-*.md`) and never from mtime, which Synology sync rewrites, and it is still
  move-only — nothing in it unlinks anything. Three deliberate differences from the shell version:
  a name that matches the date pattern but is not a calendar date is skipped rather than normalised
  (BSD `date` turned `2026-02-31` into 2026-03-03 and would have moved it), and a file whose
  destination already exists in `Archive/` is left in place and reported rather than overwritten,
  because overwriting a note is exactly the data loss this script is not allowed to cause, and
  `Archive/` is created only when something actually moves rather than unconditionally, so a prune
  that archives nothing leaves no trace.
  Five defects found reviewing the port are fixed in it rather than listed here, each with a
  regression test: `PRUNE_DAYS` is parsed as digits only and the cutoff is range-checked, because
  `PRUNE_DAYS=1000000000` made an invalid date whose `NaN-NaN-NaN` string lost the keep-comparison
  for every real date — *asking to keep more logs archived the whole directory*, today's and
  future-dated files included, where the shell it replaces archived none — and `PRUNE_DAYS=" "`
  cast to a 0-day window with the same effect; a symlinked log is archived instead of being
  dropped by an lstat-based `isFile()` that left it neither moved nor reported; the never-overwrite
  guard uses `lstat`, since `existsSync` follows a link and a dangling one at the destination read
  as free space; and a failure part-way through now reports what already moved, without which
  "move only, reversible" is not true in practice — reversing a move means knowing which files
  moved. And the cutoff year is zero-padded, because a `PRUNE_DAYS` large enough to reach a
  three-digit year (375000) lost the same lexical keep-comparison and archived everything while
  printing a success line — the `NaN-NaN-NaN` defect in another disguise, past both of its guards.
  Measured against a synthetic logs directory under a scratch `$HOME`, never the vault.

- **CI fails an entry that has no `lib/` twin.** The entry/`lib` split is this repo's central
  structural claim — `hooks/hooks.json` and `commands/*.md` name the *entry* paths, so those
  filenames are a contract and the logic belongs in the twin where it can be imported and tested
  without running the hook — and until now nothing checked it. `docs/architecture.md`'s invariants
  table said `NOTHING` in the enforced-by column, which was honest and had been true since the
  table was written. The new step loops every non-test `hooks/*.mjs` and `scripts/*.mjs` and fails
  with an `::error file=…::` naming the fix, unless the entry is allowlisted with a stated reason;
  the allowlist is one name, `scripts/env.mjs`, whose twin is `hooks/lib/env-shell.mjs` — neither
  same-named nor in the sibling directory, because it renders what `paths.mjs` resolves and belongs
  beside it. A hardcoded floor fails the step if the globs ever stop matching, since two steps in
  that file had already shipped checking nothing.
  **It checks that the twin exists, not that the entry delegates to it** — an empty twin passes,
  and the three entries that keep their real logic beside a twin still pass. What it closes is the
  shape the recall hook was in until this branch's predecessor: an entry with no twin at all, and
  therefore exempt from *every* CI invariant, because all of them key off the `lib/` boundary. The
  invariants row reads `CI (partial)` for that reason.

- **CI fails when a command or hook names a path that is not a tracked file.** `node --test` is
  discovery-based and CI only ever sees committed content, so a commit that forgets a new file is
  fully green on a repo that is broken. This branch nearly shipped it: `git rm scripts/prune-logs.sh`
  was staged while the `.mjs` entry, its `lib/` twin and both test files were still untracked —
  `/memory:prune` step 1 would have invoked a file that did not exist, and both of this branch's
  new test files would simply have vanished from the run, lowering the total and failing nothing.
  The step resolves every `$MEM`/`${CLAUDE_PLUGIN_ROOT}` path in `commands/*.md` and
  `hooks/hooks.json`, plus whatever each `.mjs` entry statically imports — `./` and `../` alike,
  since three of those entries reach the kernel through `../hooks/lib/paths.mjs` and a scan
  limited to `./` would have looked at none of them. A tracked entry with an untracked `lib/` twin
  is the same failure one level down. It uses `git ls-files`, not `test -e`: an untracked file is
  present in the working tree and would pass an existence check locally, which is exactly how this
  was missed.
  It also fails if the extraction matches nothing, so a renamed variable cannot turn the guard into
  a no-op that checks zero paths.

- **`scripts/lib/lexical.mjs` — the card sentinel, stopwords, tokeniser and BM25, in a module
  that imports nothing.** The recall hook's new `lib/` twin needs those four, and a hook entry
  imports its twin *statically*: above the fail-open try and above the `recallEnabled()` gate, so
  the whole import graph runs on every prompt of every session, armed or not, with nothing able to
  catch it. Taking them from `memory-semantic.mjs` put that module's scope there, and its scope
  resolves the active model and does `console.log(...)` + `process.exit(1)` on an unknown one. With
  `{"model": "bge-m4"}` in `config.json` the hook went from exit 0 and zero bytes to exit 1 with
  `unknown MEMORY_SEMANTIC_MODEL — known: …` on **stdout**, which `hooks.json`'s trailing
  `|| exit 0` turns back into exit 0 *keeping the line* — so Claude Code injected it as context on
  every prompt until the typo was found, on installs that had never armed recall. It also promoted
  `model-default.mjs` from a caught dynamic import to an uncatchable static one, and made a broken
  or missing `memory-semantic.mjs` — a partial install, an interrupted `npm ci` — take recall down
  with it, where before the hook only ever spawned that file as a detached child. `lexical.mjs`
  imports nothing at all, so it adds no failure mode the entry's existing `paths.mjs` import did
  not already have, and it is 0.26-0.42 ms of module init rather than 3.8-4.4 ms (8 runs each,
  local APFS; module init reads no vault, so cloud-vs-offline does not move these,
  warm, measured 2026-08-19). `memory-semantic.mjs` re-exports all four, so there is still exactly
  one implementation of each. A CI step now imports every `hooks/lib/*.mjs` **with a deliberately
  unknown model configured** and fails on any output or non-zero exit — the existing side-effect
  check runs with a valid model, which is precisely why it went green on the version that had this
  bug.

- **`scripts/review-prompt.mjs` prints the CI reviewer's own prompt.** The prompt that gates every
  PR lived only inside a YAML block scalar, so applying it locally meant retyping it. Now it is one
  command, and running it before pushing turns its findings into an edit rather than a comment to
  repush over — on a PR that edits `claude-review.yml` it is the only review available, since
  `claude-code-action` skips those and exits green. The prompt deliberately stays inline in the
  workflow: validation covers only the file invoking the action, so a prompt in its own file could
  be rewritten by the PR it reviews. A test asserts the real workflow still yields it, so
  restructuring the YAML fails `node --test` instead of silently leaving the reader empty.

- **Implementation plans are committed, under `docs/plans/`.** Plan mode writes to
  `~/.claude/plans/`, which on this machine is a symlink into a private Obsidian vault — so the
  plan for work that lands in a public repo was itself invisible to anyone reading that repo. Dated
  like `docs/decisions/` and indexed from `docs/README.md`, with the distinction between the two
  written down: a decision record says why something is the way it is, a plan says what is about to
  happen and what done looks like.

- **`/memory:doctor` reports the size of machine-local state.** Nothing had ever printed how big
  `$CLAUDE_MEMORY_HOME` was getting: nothing vacuums, per-project × per-model `.db` files
  accumulate, `models/` accumulates one set of weights per model, and the hook logs append. The
  2.2 GB of duplicated `node_modules` behind 0.3.1 was found by accident rather than by a check.
  Doctor now reports the total size of `$CLAUDE_MEMORY_HOME` and `warn`s past 2 GB — which sits
  above the ~722 MB of ONNX weights a healthy install is expected to carry — plus a breakdown of
  `db/ logs/ eval/ run/ cache/`. The total measures the directory itself rather than summing that
  breakdown, so it cannot omit what the list forgets; `models/` and the shared `node_modules/` keep
  their own existing checks instead of being walked twice. Sizes are measured with `du -L`: without
  it a symlinked subdirectory reports 0 and the check passes by measuring nothing, the same blind
  spot as the `node_modules` fix below.

- **Per-repo config for the engineering skills, under `docs/agents/`.** `issue-tracker.md` (GitHub
  Issues via `gh`, PRs not a request surface), `triage-labels.md` (the five canonical roles,
  unchanged) and `domain.md`, plus an `## Agent skills` section in `CLAUDE.md` pointing at them.
  The one deviation from the skills' default layout is recorded in all three places: decision
  records live in `docs/decisions/`, named by date, not in a numbered `docs/adr/`. Documentation
  only — no hook, script or command reads these files.

### Changed

- **The env → `config.json` → default parse for a numeric setting is written once**, as
  `positiveMs()` in `hooks/lib/paths.mjs`, where `modelIdleMs()` and `serveIdleMs()` each carried
  their own copy. Same resolution order, same fall-through on an unparseable value.

- **`hooks/memory-recall.mjs` spawns the search server through `detach()`** instead of its own
  `spawn(..., {detached, stdio:'ignore'}).unref()`, which was a second copy of the same contract.
  `hooks/lib/hook-io.mjs` qualifies for a static import there because its module scope is imports
  and constants — the rule that governs that file's imports is unchanged.

- **BREAKING — `ctx_search` source labels now carry the project key, the same identity as the vault
  folder they index. Run `/memory:prune` once per project to clear the old rows.** `reindex()` in
  `hooks/lib/distill-session.mjs` labelled sources `vault-<layer>-<basename(cwd)>` while indexing
  `VAULT/<layer>/<project_key>` — two identity schemes on adjacent lines (`H7`, backlog item 14).
  Both sides now derive from one `slug`, so a checkout at `~/work/mem` of the repo keyed
  `github.com-spike1292-claude-memory` indexes under `vault-memory-github.com-spike1292-claude-memory`
  instead of `vault-memory-mem`, and the SessionStart retrieval guidance in `vault-memory-sync.sh`
  emits `vault-memory-$key` to match. Breaking by this file's own definition: it forces a re-index.
  **Nothing purges the old rows automatically.** They are live, not theoretical — a project measured on
  2026-08-19 had 262 of them written that same day — and `sources.label` is `<source>:<file_path>`,
  so the old and new rows coexist and every note returns twice, halving the effective result window.
  context-mode's only automatic eviction is a 14-day staleness sweep on `indexed_at`, and it cannot
  help while a source is being rewritten. `/memory:prune` therefore now runs its purge-then-reindex
  even when nothing was deleted, and re-indexes all five sources rather than two — a project-scoped
  purge followed by two `ctx_index` calls used to leave `Logs` and `Graph` empty until the next
  SessionEnd, which was a pre-existing defect this change made visible. That prune is the migration,
  and it is a one-time cost: after it, the labels agree. Users without context-mode are unaffected — this is the optional second
  index, never the plugin's own.
  Two things the backlog item had wrong, corrected in code comments, `docs/architecture.md` H7 and
  `commands/prune.md` rather than repeated: context-mode partitions its content DB by checkout path
  (`--project cwd` → its own `<hash>.db`), so two checkouts of one repo never shared an index and
  the old scheme could not overwrite itself — the cost was a label that named the checkout instead
  of the notes, so nothing else in the system could reconstruct it. And the invariant that holds is
  **label == indexed directory**, not label == `projectKey(cwd)`: `distill()` falls back to
  `legacyKey` on a vault that SessionStart has not migrated yet, and both sides move together.

- **`MIN_SCORE = 6.0` finally has a case set behind it — and the sweep says it is too low, so it is
  recorded rather than changed.** It was the one retrieval number in the repo with only a prose
  comment, against the convention that every figure names the case set it came from. Swept on the
  synthetic bench vault (`memory-synth-vault.mjs --seed 7`, re-run at 120/300/1000 notes — the
  smallest leg was invoked as `--notes 100`, which built 120 before #49 made the flag a ceiling)
  over the 80 on-topic prompts that script emits, with the 28 questions of the authored case set —
  which ask about *this* repo — as an off-topic control against the bench corpus, where every fire
  is by construction noise. **6.0 is not too high**: the weakest on-topic prompt scores 15.2-20.3,
  so no gate up to 12 suppresses a single one of the 80. **It is too low**: it sits inside the
  off-topic band and lets 17/19/28 of the 28 through, where ~14 halves that at zero on-topic cost at
  all three corpus sizes. Left at 6.0 deliberately — moving it changes behaviour on every prompt,
  absolute BM25 is corpus-scaled, and the off-topic control is contaminated (both corpora are
  software prose). The numbers, the instrument and that reasoning are in the comment beside the
  constant.

- **`--mode lexical` in the eval was not the instrument the plan assumed, and was itself a
  fork.** The premise for the item above was that #29 had made recall's BM25 and the eval's one
  implementation. It had not: the eval entry still inlined its own tokeniser (no stopword removal,
  no query-term de-duplication) and its own BM25, an `H6` fork `docs/architecture.md` never listed
  — and it scores *whole notes* where the hook scores only the `(card)` chunk. On the bench cases
  the two disagree hard: gold at rank 1 for 50%/25% against `keywordArm`'s 100%/100%. The ranking
  moved to `lexicalRank()` in `scripts/lib/memory-eval.mjs` over the shared `lexTokens`/`bm25`,
  where it is testable; unlike the recall merge this one *did* move numbers (bench `cases-paraphrase`
  recall@1 55.0% → 50.0%), so the figures it invalidated are now dated in `commands/eval.md` and in
  the `--generate` output. `commands/eval.md` and the architecture guide now say plainly that a
  number from this mode says nothing about `MIN_SCORE`. Five dead imports left the lib with it.

- **`hooks/memory-recall.mjs` has a `lib/` twin, and the recall path has its first tests.** The
  UserPromptSubmit hook was 253 lines with no lib and no test — the last entry exempt from all four
  CI invariants, which key off the `lib/` boundary. It is now 153 lines owning stdin, the unix
  socket, `node:sqlite` and stdout, over a 148-line `hooks/lib/memory-recall.mjs` holding the gates, the
  ranking, the hit formatting and the log-record shapes, all taking rows and strings as values.
  `node:sqlite` and `net` stay in the entry on purpose: that is what lets the twin be imported by a
  test with neither a database nor a server. Three consequences worth naming. **Recall's private
  copies of the stopword list, the tokeniser and BM25 are gone** — it now uses
  `scripts/lib/lexical.mjs`'s, so the keyword fallback and the path it falls back from
  finally score by one implementation. The two were equivalent, which is why no ranking moved: the
  stopword lists were the same 71 words (recall's spelled `with` twice, which a `Set` collapses) and
  the inline BM25 was `bm25()` with `k1 = 1.2` and `b = 0.75` pre-substituted into the arithmetic —
  which the twin now passes **explicitly**, because `MIN_SCORE` and its `MIN_SCORE / 2` floor are
  absolute BM25 values and a tune made for the CLI's fusion arm would otherwise rescale both gates
  with nothing asserting an absolute score. **The SELECT binds `CARD`**, closing R4 in
  `docs/architecture.md` — the sentinel now has no unbound consumer left. **The price is
  +0.5 to +0.9 ms of module init on every prompt**, gate exits included, measured over 8 warm runs
  on local APFS — the hook reads `$CLAUDE_MEMORY_HOME`, never the Synology-backed vault, so the
  166 ms/131 ms cloud-vs-offline split that moves other hooks does not apply here —
  as the marginal cost after `paths.mjs`, which the entry loads anyway; end to end, spawn to close,
  that is +0.5 to +1.7 ms on the fastest of 20 gate-exit runs across three alternating passes
  against `main`, with the medians inside the noise, on a ~37 ms Node-startup floor. The first
  draft took the shared four from `memory-semantic.mjs` instead and cost 3.8-4.4 ms; the reason it
  does not is a correctness one rather than that number, and is in the `lexical.mjs` entry above.
  **Nothing a session sees changes** — the two
  arms' stdout was replayed byte-for-byte across 24 recorded prompts and the eight stub-server
  edge cases, and the JSONL log records match field for field, including the `via` key that is the
  only thing telling the arms apart and the `score` key that must stay absent when the server sends
  a hit without one. The tests are written against the hook's real hazard: abstaining is its normal
  behaviour, so every abstention assertion is paired with a positive one on the same corpus.

- **`searchIn()` — the function that decides what a session actually sees — moved into
  `scripts/lib/memory-semantic.mjs` and has tests.** It sat in the 966-line entry file, which is the
  least-checked file in the repo precisely because all four CI invariants key off the `lib/`
  boundary (G1 in `docs/architecture.md`). The body moved unchanged; only the `--layer` value, which
  was a module-level argv binding, became its last parameter. `loadIndex()` stays in the entry — it
  opens the database, and `lib/` may not import `node:sqlite`. The test rigs a corpus where the
  vector arm, the keyword arm and the fusion of the two produce three *different* orderings, so a
  dead arm cannot pass: with one arm's ranking as the expected answer, the pooling-style failure
  of the kind this repo has already paid for once would have been invisible. **Nothing a session sees changes** — this
  buys the ranking its first regression net, not a better ranking.

- **The card-chunk sentinel `'(card)'` is a constant, `CARD`, with a divergence test behind it.**
  One producer (`chunkNote`) emitted the literal and four consumers matched on it by hand — the
  failure mode (R4 in `docs/architecture.md`) was that renaming the producer left recall's keyword
  arm SELECTing 0 rows, `avgdl` `NaN`, every score `NaN`, and the hook abstaining, which is exactly
  what it does when it has nothing to say. The two SQL reads in `scripts/memory-semantic.mjs` now
  **bind** `CARD` as a parameter rather than interpolating it, so the query text is fixed and there
  is nowhere for a quote to land. `hooks/memory-recall.mjs` kept its literal at first, because
  importing the lib would put its module init on the UserPromptSubmit path, which must never wait;
  the entry below took the constant once its SQL moved behind a `lib/`, and the source-scan test
  that watched the literal now watches for it coming back. The test asserts `chunkNote`'s own output reaches
  `buildBundle`, because asserting `CARD === '(card)'` would pass after precisely the rename that
  breaks everything. **No index is rewritten and no query changes** — the sentinel's value is what it
  always was; what changes is that a future rename now fails `node --test` instead of a session.

- **`/memory:synthesize` prints the command that counts staged versus promoted notes, instead of
  quoting a number.** It carried "965 Insights against 5 `permanent/` notes" — a 2026-08-15
  measurement with no refresh path, in the one file that tells Claude whether promotion is keeping
  up with capture. A figure nothing re-measures decays into a claim, so the two `find | wc -l` lines
  that produce it are now in the command body, and the prose beside them says only what survives
  re-measurement. The undated "32 uncovered clusters exist" in step 1 got the same treatment; its
  argument never depended on the number.

- **The last three gate hooks are Node.** `semantic-index-refresh`, `graph-staleness-check` and
  `distill-session` were bash; they are now thin entries over tested `lib/` modules, and the three
  `.sh` files are deleted. Only `hooks/vault-memory-sync.sh` and `scripts/doctor.sh` remain shell.
  The 2026-08-17 rule kept them in bash on a floor of ~5 ms — but none of them was a *bare* gate:
  each sourced `vault-env.sh` (15 ms) and forked `git`/`jq` several times, and `distill-session.sh`
  parsed its payload with five separate `jq` pipelines. Measured on the gate path, local-disk vault,
  n=30: 148.3 ms → **140.7 ms** total, the win carried entirely by the distiller. Rationale and the
  full table in [docs/decisions/2026-08-18-node-hooks.md](docs/decisions/2026-08-18-node-hooks.md).
  Test count 76 → 99; the ported decisions (24h and 2h debounces, the >400-message Stop threshold,
  short-sha staleness) had no tests at all while they lived in shell.

- **One implementation of the gate plumbing.** New `hooks/lib/hook-io.mjs` holds the stdin payload
  parser, debounce markers, `detach()` and `findClaude()`. The last of those had already drifted:
  `graph-staleness-check.sh` probed four `claude` locations in bash while `distill-session.mjs`
  probed the same four in Node, with nothing keeping them in step.

- **Debounce markers and background logs move into `$CLAUDE_MEMORY_HOME`.** From
  `~/.cache/claude-distill/` and `~/.cache/claude-graphgen/` to `cache/` and `logs/` under the one
  machine-local root, so there is a single directory to inspect, size and clear. Costs one missed
  debounce per marker at upgrade — one extra background run, never a wrong one.

- **Resolution is single-implementation.** `hooks/lib/vault-env.sh` was the source of truth for the
  vault path, `$CLAUDE_MEMORY_HOME`, recall arming and `project_key`, and `hooks/lib/paths.mjs`
  mirrored all of it — forking bash for `project_key` so the sed pipeline at least had one home.
  Node resolves now and shell asks: `vault-env.sh` `eval`s one `node scripts/env.mjs` call and went
  from **167 lines to 85**, keeping every function name so both callers barely changed. The five
  `sed -e` expressions are `normaliseRemote()`, with a test table over the eight URL shapes they
  handled and one for the ASCII-lowercase hazard (`tr 'A-Z' 'a-z'` is ASCII-only where
  `toLowerCase()` is not, and a non-ASCII capital in a host name would have split one project's
  vault folder in two). Measured, local-disk vault: shell callers **+27.2 ms** (34.3 → 61.5), paid
  by one SessionStart hook and by `/memory:doctor`; Node `projectKey` on a cache miss **−17.9 ms**
  (82.2 → 64.3), paid back to every other hook. Rationale, the degraded no-Node path, and the
  subshell trap that makes eager loading a correctness requirement:
  [docs/decisions/2026-08-18-single-resolver.md](docs/decisions/2026-08-18-single-resolver.md).

### Removed

- **`--layer`, and the `preFiltered` plumbing it had become.** Measured-refuted on 2026-08-15 (EN
  recall@5 67.9% → 53.6%): it filters the corpus instead of re-ranking it, so gold answers that live
  in Insights are deleted from the window rather than out-ranked. It then took two documents and a
  test assertion to tell people not to pass it — including a rule in the retrieval guidance injected
  into every session. `memory-semantic.mjs --query`, `memory-eval.mjs --run` and `searchIn()` no
  longer accept it; the refutation itself is kept in `commands/eval.md`, which is where someone
  proposing layer scoping again will meet it. Passing `--layer` is now an ignored argument rather
  than an error. `MEMORY_FUSE_RESERVE`, the layer *quota* — also refuted, also off by default — is
  unchanged and now has the `searchIn` test the flag used to share.

- **`--size` and `--clusters --members`.** No command ever passed either. `--members` capped the
  printed membership at 6 with a `--members 99` hint, in a command whose own step 2 is "read every
  member note in full" — so the cap is gone rather than the flag alone, and `--clusters` now prints
  every member. Minimum cluster size is a constant 4.

- **`docs/refactor-backlog.md`.** All fourteen items had landed or been declined and the file said
  so in its own header; it outlived its execution, which by CLAUDE.md's rule makes it a decision
  record or nothing. The changelog and #20, #24, #27–#31 are what shipped, the lessons were already
  in [the orchestration record](docs/decisions/2026-08-19-orchestrated-change.md), the open work it
  pointed at is `H4` in `docs/architecture.md` — and the one *declined* item, relocating
  `paths.mjs`, moved there too, since a rejected idea that leaves no trace gets rediscovered as a
  good one.

- **`docs/superpowers/specs/2026-08-15-claude-memory-plugin-design.md`.** The original extraction
  spec, superseded by `docs/architecture.md`; its only inbound link was the index row listing it.

- **`extractBlockScalar`'s `key` parameter and the `reviewPrompt` wrapper around it**, and the
  `CARD`/`STOP`/`lexTokens`/`bm25` re-export shim in `scripts/lib/memory-semantic.mjs`. One key was
  ever passed, and one implementation does not need two import paths — consumers take the lexical
  vocabulary from `scripts/lib/lexical.mjs` directly, as `hooks/lib/memory-recall.mjs` already did.

- **`docs/plans/2026-08-18-refactor-backlog.md`.** Its sixth and last run merged, so it went, under
  the rule it was added with: a plan whose steps have all shipped is deleted and the changelog
  becomes the record. The half of it that was not specific to that backlog — the
  `Implement → Verify → Document → Review → Land` shape, and the nine lessons the runs paid for —
  was rewritten as [a decision record](docs/decisions/2026-08-19-orchestrated-change.md) first,
  which is what CLAUDE.md means when it says a plan outliving its execution becomes one. It batched the backlog's thirteen open items into six PRs — #24, #27, #28,
  #29, #30, #31. (The backlog it worked from went the same way later in the day; see above.)
  `docs/plans/` and its convention in CLAUDE.md stay; there is simply no plan open.

- `scripts/prune-logs.sh` — replaced by `scripts/prune-logs.mjs`, which is invoked through `node`
  rather than executed as a shell script. `/memory:prune` is unchanged for anyone who runs the
  command; a script or alias that called `"$MEM/scripts/prune-logs.sh" <logs-dir>` directly must
  become `node "$MEM/scripts/prune-logs.mjs" <logs-dir>`. `PRUNE_DAYS` still overrides the 90-day
  window, but it must now be a whole number of days — a value that is not one exits 1 and moves
  nothing, where the shell's `$((...))` treated it as 0 and archived almost everything.

- **The redundant semantic-index lock.** `$CLAUDE_MEMORY_HOME/.semantic-index.lock` guarded the same
  file as the indexer's own per-model `db/.index-<model>.lock`, at a coarser scope, and its only
  observable effect was a **silent** skip: on contention it exited 0 with no output, so a session
  that indexed nothing looked identical to one that had nothing to index.

### Fixed

- **`/memory:doctor --perf` no longer dies mid-report when the second recall probe fails.** It
  times the round trip twice, and the second probe can fail on its own — the server may exit or
  evict its socket between the two — where `undefined.toFixed()` ended the whole report with a
  stack trace, in the one command someone runs when things are already wrong. It now says what
  went wrong with the second probe and prints the rest. The same path could also report
  `not measured: undefined` when the socket error carried no `code`.

- **The graph re-index can no longer run several times at once.** The debounce that guards it is
  keyed by repo (`graphgen-<slug>`, 24h), so three stale repos opened together were three legal
  parallel runs — each a headless `claude`, an MCP server and a full index — and the machine spent
  its CPU and RAM on them (#34). `hooks/lib/hook-io.mjs` gains a lock whose owner is a **live pid**
  rather than a release call: a detached child that is killed, or a machine that sleeps, frees the
  lock by dying, and an hour-old lock is stale even when its pid is alive (a recycled pid, or a
  wedged run). The claim is a single atomic `wx` create in `check()`; an advisory
  read in `plan()` was tried and removed, because it decided nothing the create does not and it
  masked the mutation that deletes the create. Reclaiming a *stale* lock cannot be atomic — unlink
  and create are two syscalls — and a plain unlink-then-create is wrong, since the loser's unlink
  deletes the winner's fresh lock and it then claims the empty path, so both start a re-index. The
  inode is captured before the staleness verdict and re-checked after it, which narrows that
  interleaving to one syscall; closing it needs an OS-level lock Node's `fs` does not expose, and
  the code says so rather than claiming a guarantee it does not provide. A session that
  loses the lock prints `BUSY_MESSAGE` rather than going quiet, and `/memory:doctor` reports
  a held lock with its pid and age, and names a stale one as harmless. The wiring is covered by an
  integration test, not only by its constants: a scratch `$CLAUDE_MEMORY_HOME`, two real git repos
  stale against a scratch vault, and a stand-in `claude` that sleeps, so the lock left behind is
  held by a genuinely live process. `check()` takes plan options for that reason alone — a function
  that could only read the live vault could not be tested at all.
- **`detach()` no longer takes the hook down after it has already succeeded.** `spawn()` reports a
  missing binary asynchronously, so the `try/catch` never saw it and the unhandled `error` event
  became an uncaughtException *after* the pid had been returned and the hook had printed its line.
  It now returns the child pid (or `null`), which is what the lock above is written from.

- **`reindex()` called a bare `which`, so every distillation aborted right after writing its notes
  — on unreleased `main` only.** #20 deleted `distill-session.mjs`'s local copy of `which` without
  adding an import; the ReferenceError killed the child after `writeNotes()` and before the ctx and
  semantic refreshes, and nothing noticed because the hook detaches and its stderr goes to
  `distill.log`. `hook-io.mjs` now exports the one copy. Listed for the record, not as a user-facing
  fix: v0.3.1 still carries the local definition and no release followed it.

- **The index no longer re-embeds a note whose content did not change.** `--index` keyed its whole
  incremental decision on exact mtime equality, and the vault sits on Synology Drive, which rewrites
  mtime on sync without touching a byte — `scripts/prune-logs.mjs` says so in its own header. One
  sync could therefore cost a full 20-40 min re-embed at batch size 1 for content nobody edited
  (`R1` in `docs/architecture.md`, the highest-probability silent failure on that list). `chunks`
  gains a `hash` column — sha256 over the note's bytes as read — and the decision becomes two
  levels: mtime matches, skip without reading (the steady-state fast path is unchanged); mtime
  moved, read and hash, and skip the embedding when the bytes are identical, writing the new mtime
  back so the fast path applies again next time. Both write-backs are one transaction rather than
  one per note (667 ms → 31 ms over 1000 files, measured 2026-08-19).

  **No re-index is required and none is triggered.** An index built before the column holds this
  model's vectors and answers exactly as well as it did before, so `--index` backfills the hashes in
  place from the notes whose mtime it already trusts — one read per note, once. The alternative,
  forcing a rebuild, would have fired unattended on every existing install: `semantic-index-refresh`
  launches `--index` detached into a log, rows are written outside a transaction, and a rebuild
  interrupted half way leaves an index that is partial yet indistinguishable from a current one, so
  recall would have answered from a fraction of the vault with no signal.

- **An interrupted `--index` no longer leaves a note permanently half-indexed.** Chunks are inserted
  with a sentinel mtime and a NULL hash, and a file's real identity is committed only once all of
  its chunks have landed. Previously a run killed mid-file left that file carrying its current
  mtime, so every later run skipped it and the chunks that never landed were never searchable again
  — with `--coverage` reporting the note as present, since one surviving chunk satisfies it.

- **Hook logs are capped at 1 MB.** `semantic-index.log`, `distill.log` and `graphgen.log` were
  appended to forever and nothing truncated them; the last two carry a headless `claude` child's
  whole stdout and stderr. An oversized log is now trimmed to its last 256 KB before it is written
  to. The read is positioned, so a log that has already run away to hundreds of MB never enters
  memory.

- **A repo with no `origin` remote could change project key.** When the remote-URL normaliser moved
  from `vault-env.sh` into `paths.mjs`, the *other* branch of `computeProjectKey` — the fallback to
  the repository directory name — started running that whole pipeline too. The shell it replaced
  only lowercased. A checkout in `foo.git/` therefore keyed as `foo`, and one in `a:b/` as `a-b`,
  which means a different vault folder for anyone in that shape. Restored to lowercase-only, pinned
  by a test. Only ever present in this unreleased section, never in a published version.

- **`/memory:doctor` measured the symlink instead of the shared `node_modules`.** `du` without `-L`
  stats the link itself, so once the runtime moved to `$CLAUDE_MEMORY_HOME` the size check read 0 MB
  and passed by measuring nothing — precisely the case it exists to police. Found running
  `/memory:install` against a real shared install.

### Security

- **The resident search socket is `chmod 0600`.** Since 0.3.0 the slug is a *request field*, so one
  connection to `run/search-<model>.sock` can query every indexed project rather than only the one
  you are prompting in — and the socket was created at whatever the umask happened to give it. It is
  now restricted to the owning user immediately after `listen()`, inside a `try`/`catch` so a failed
  `chmod` can never stop the server serving. macOS does not enforce unix-socket permissions
  uniformly, so this is defence in depth on a shared host, not a guarantee.

## [0.3.1] - 2026-08-18

### Changed

- **One `node_modules` shared across installed plugin versions.** Claude Code keeps every version
  it has installed, each with its own copy — the docs here claimed caches were "replaced wholesale
  on update", and that is wrong: six versions of this plugin measured 381 MB each, link count 1,
  **2.2 GB** total. `scripts/share-modules.mjs` (new step 6 of `/memory:install`) moves the runtime
  to `$CLAUDE_MEMORY_HOME/node_modules` and symlinks every version dir at it, which is the same rule
  the indexes and model weights already follow. With the slimming below, six versions go from 2.2 GB
  to 59 MB kept once. The script deletes directories, so it refuses to run outside a `plugins/cache/`
  path; a git checkout keeps its own `node_modules`. `/memory:doctor` reports the multi-version cost
  until it is shared.

- **The install is 380 MB → 59 MB.** A `postinstall`
  (`scripts/slim-install.mjs`) strips what this plugin can never execute:
  onnxruntime-node ships every platform's native runtime in one tarball (176 MB of it unloadable on
  any given machine), and `@huggingface/transformers` hard-depends on `onnxruntime-web` (130 MB
  browser WASM backend) and `sharp` + `@img` (17 MB image pipeline) that no text-embedding path
  touches. The two packages are replaced by ~1 KB stubs from `stubs/` rather than deleted, because
  both are *static* imports in `transformers.node.mjs` — resolution fails before any code runs — and
  a stub that throws turns a wrong-backend regression into a loud error instead of a silent one.
  Verified: `--check-embedding` cosine 1.000000, full suite passing, `npm ci` reproducible. npm's
  own `overrides` cannot do this — pointed at a local stub it writes a lockfile that `npm ci` then
  rejects, and Claude Code installs plugins with `npm ci`. The packages are still *downloaded*;
  only the disk that the version-pinned plugin cache keeps is reclaimed. On linux it also drops
  onnxruntime's CUDA and TensorRT execution providers, which its own install script downloads on top
  of the bundled binaries — nothing here asks for a GPU provider, and macOS has never had them, so
  the CPU path is the only one this plugin has ever run.

## [0.3.0] - 2026-08-18

### Changed

- **One search server for the whole machine, keyed by model rather than by project.** The slug is
  now a request field and indexes load on demand and cache, so one process holds one model and
  answers for every project. Previously the slug was fixed before the socket existed, which forced
  one ~1.3GB model per indexed repo — three projects meant ~2.4-4.2GB resident while you prompt in
  one of them. This supersedes the evict-other-projects behaviour added earlier in this release:
  switching projects no longer costs a model reload, it costs an index load (~15MB of vectors for
  3400 chunks). Socket moves from `run/search-<slug>-<model>.sock` to `run/search-<model>.sock`;
  leftovers under the old name are evicted on startup, so the migration needs no special case.
  Verified: projA and projB served by one process from one socket, 22-32ms each.
- **The model unloads on its own timer while the process stays alive.** `modelIdleMs` (new, 5 min)
  calls `pipeline.dispose()` → `InferenceSession.release()`, which is what actually returns native
  memory — dropping the JS reference would not. Measured: `MALLOC_LARGE` dirty **451.3M → 2,464K**,
  process alive, next query reloads in 800ms and answers correctly. Because the process is then
  ~150MB rather than ~1.4GB, `serveIdleMs` goes the other way, **5 min → 30 min**: it now guards a
  cheap process, and keeping the socket, indexes and BM25 tokens warm is worth more than the exit.
- **`serveIdleMs` is configurable, not env-only.** `MEMORY_SERVE_IDLE_MS` now also reads
  `serveIdleMs` from `config.json`, because hooks are what set it and an env value written
  mid-session does not reach the session that wrote it. Garbage and non-positive values fall back
  rather than disabling the timer, which is how a 1.4GB process becomes permanent. (An intermediate
  step in this release had one server per project evicting the others at a 5-minute process
  timeout; the model-keyed server above replaced it, and 5 minutes is now the MODEL timer while the
  process — cheap once the model unloads — waits 30.)

- **Every Node hook and script is now a thin entry over a `lib/` module, with tests in
  `*.test.mjs` beside the logic and `node --test` as the runner.** `hooks/<name>.mjs` and
  `scripts/<name>.mjs` keep their paths — `hooks.json` and `commands/*.md` name them — and own argv,
  stdin and stdout only; the logic moved to `hooks/lib/<name>.mjs` / `scripts/lib/<name>.mjs`. The
  `--selftest` flag is gone from every `.mjs` (`scripts/release.sh --selftest` stays: it is bash).
  CI is now `node --test --test-concurrency=1`, which is discovery rather than a hand-maintained
  list of nine invocations — a new test file cannot be forgotten. Concurrency is pinned because the
  suites share `$CLAUDE_MEMORY_HOME` and one test needs two git writes inside the same second.
  47 tests, each named, so a failure says which case broke instead of printing a bare assertion.
- **Assertion counts are no longer written down.** The runner reports them. Four hand-maintained
  counts had drifted (`distill-session.mjs` claimed 22 against a real 21 before the change that made
  it 28; `paths.mjs` claimed 7 against 9), which is the third recurrence of that class in this repo.

### Added

- **Prettier, pinned at 3.6.2 and run through `npx`.** `npm run format` / `format:check`, plus a CI
  job of its own — formatting does not vary by Node version, and putting it in the matrix would run
  it twice per push, which is the mistake `release.sh --selftest` already made. Deliberately **not**
  a devDependency: Claude Code auto-runs `npm ci` on plugin install and that installs dev deps, so
  it would ship into every user's version-pinned plugin cache (already 381 MB) to format code they
  never edit.

  Scope is code only. `.prettierignore` excludes `*.md`, `*.yml` and `package-lock.json` — CLAUDE.md
  and `commands/*.md` are instructions Claude Code reads, the workflow comments carry dated
  measurements, and Prettier reflows prose.

  The one-time reformat touches 27 files (+1968/−628) and is mostly one idiom: this codebase writes
  `try { … } catch { /* why */ }` on a single line throughout, and Prettier expands each to four or
  five. Verified formatting-only rather than assumed — every entry point's output is byte-identical
  before and after, `memory-synth-vault` still produces a byte-identical vault for the same seed,
  and the suite passes 47/47 on Node 22 and 24.


- Two CI checks that turn conventions into failures: **every `lib/` module must import with no
  output** (a module that runs its hook on import makes any importing test a live hook run — reading
  stdin, spawning a headless `claude`, writing notes; it happened three times), and **`node:test`
  must not be imported outside a `*.test.mjs`** (a top-level import prints the full test report to
  stdout, which Claude Code reads from hooks).

### Fixed

- **onnxruntime's arena is disabled (`session_options.enableCpuMemArena: false`).** Its BFCArena
  grows to the largest shapes it has ever seen and never returns them, which is the mechanism behind
  the 8.8GB of dirty `MALLOC_LARGE` this release already addressed by clamping the input. Clamping
  bounds what is *asked for*; this bounds the *allocator*, so a future model, a larger `MAX_CHARS`
  or an `--index` run over long notes cannot reintroduce the same failure by another route.
  Measured: a 46,799-char query leaves `MALLOC_LARGE` at 451.3M, unchanged from warm.
- **An idle unload can no longer dispose a session mid-inference.** `singleFlight` guarded
  concurrent *loads*; the mirror hazard is on the release side, where the idle timer could
  `dispose()` a session another request was still running inference on — freeing it underneath
  native code, so a crash rather than a wrong answer. `embed()` now borrows the session for the
  duration and `take()` refuses while borrowed, retrying on the next idle tick. Rare (it needs an
  inference outlasting the 5-minute timer) but the same failure class as the load-side race.
- **A concurrent model reload no longer leaks a session.** `if (!embedder) embedder = await load()`
  is a check-then-act across an `await`, and it only became reachable once the model could return to
  `null` mid-life: two requests arriving after an unload both saw `null`, both loaded, and the second
  assignment dropped the first ~1.3GB session with no `dispose()`. The in-flight load is now shared.
  Measured: 4 concurrent requests into an unloaded server settle at `MALLOC_LARGE` 450.0M — one
  session, not four — and all four answer in the same ~1000ms.
- **`loadIndex()` closes its SQLite handle.** `node:sqlite` does not free it on GC: 200 unclosed
  `DatabaseSync` opens held 201 fds, unchanged after an explicit `global.gc()`. Harmless in a
  short-lived CLI, an fd leak ending in EMFILE in a 30-minute server that reopens on every mtime
  bump for every project. Measured after the fix: 12 forced reloads, 0 handles held.
- **One resident search server per slug+model, instead of one per spawn.** `--serve` unlinked the
  socket unconditionally and rebound it, so a redundant spawn stole the path and left the previous
  server running but reachable by nobody — exiting only when its 30m idle timer fired. And a
  redundant spawn is the normal case, not an edge one: `memory-recall.mjs` spawns whenever it has no
  answer, which includes its 700ms timeout expiring during the ~1.5s warm-up, so every prompt in
  that window forked another model. Measured 2026-08-17 on a 16GB machine: **six** `--serve`
  processes at once. `--serve` now probes the socket first and exits in ~55ms without loading the
  index or the model; only a socket nobody is bound to (`ECONNREFUSED`) is unlinked. Losing the bind
  race is handled too — the loser used to die on an unhandled `error` event, and since it is spawned
  detached with stdio ignored, the stack trace went nowhere.
- **Queries are clamped to `MAX_CHARS` before embedding, like documents already were.**
  `chunkNote()` caps every indexed chunk at 1800 chars for bge-m3, but a query was capped only by
  the model: the pipeline passes `truncation: true`, so the tokenizer cut at bge-m3's
  `model_max_length` of **8192 tokens**. A cap, but ~18x the token count of anything in the index —
  the recall hook embeds the user's whole prompt verbatim, and a pasted stack trace went in at 57k
  chars, so a query was also being compared against a length the index never contains. 8192 is where
  the memory goes: attention materialises heads x seq² scores per layer, which at seq 8192 is
  `16 * 8192² * 4B` ≈ **4.3GB for one of 24 layers**, and onnxruntime's arena keeps whatever
  high-water mark it reaches for the process lifetime, which for `--serve` was 30 idle minutes. Two resident servers were each holding **8.8G of
  dirty `MALLOC_LARGE`**, ~7.4G of it compressed; killing them returned it. A 46,799-char query now
  costs +76MB. Note the 8.8G→clamp link is inferred from the allocation profile, not from a
  controlled A/B — the arena was not re-measured unpatched, because doing so needs GBs on a machine
  that had 70MB free. The allocator itself is bounded separately, by
  `enableCpuMemArena: false` above.
- **`--dupes` and `--clusters` found nothing under the default model, because bge-m3 carried
  e5-multi's thresholds.** `dupeMin`/`clusterMin` were 0.95/0.92, copied when bge-m3 became the
  default and never measured against it — and m3's similarity band sits *low and wide* where
  e5-multi's is high and narrow. On a 74-note set with sixteen hand-identified duplicates the scan
  returned **zero pairs**, so a miscalibrated threshold read as a clean vault. Measured by sweep and
  set to **0.75 / 0.72** (real duplicates occupy 0.75–0.869, the first coincidental pair is at
  0.714; `--clusters` found 0 topics at ≥0.76 and 2 real ones at 0.72). The sweep table is in the
  model profile and in `/memory:prune` step 2b, which no longer warns that the values are
  unmeasured. Two duplicates in that set scored below 0.70 and no threshold reaches them — the scan
  bounds what it can find, it does not replace reading.
- **The distiller re-created notes that `/memory:prune` had just merged away.**
  `findNearDuplicate` compared only *filename slugs*, so a lesson restated in different words
  became a new note; of sixteen same-lesson pairs found in one vault, only the six whose slugs
  happened to overlap were ever reconciled. It now also compares note **bodies**, using containment
  (overlap over the smaller token set) rather than Jaccard, because these pairs differ in length and
  a union denominator buries them. Measured against those sixteen pairs plus seven judged
  complementary: slug alone caught 0/16, body Jaccard ≥0.25 caught 6/16, body containment ≥0.40
  catches **11/16 with no false merges**. Deliberately conservative — the highest complementary pair
  scores 0.286, and a false merge deletes a distinct lesson while a miss only leaves work for
  `/memory:prune`. Frontmatter, headings, alias lines and folded-in addenda are excluded from the
  comparison. A two-argument call is unchanged and reads no files.
- **Importing a hook module ran the hook.** `hooks/distill-session.mjs` called `main()`
  unconditionally, so importing one helper spawned a headless `claude`, wrote notes and reindexed
  the vault. Six other files suppressed the same problem with a hand-rolled entry-point guard —
  seven copies in all — and **every copy was wrong**: they compared `path.resolve(process.argv[1])`,
  a purely textual path, against the already symlink-resolved `fileURLToPath(import.meta.url)`. Those
  disagree whenever a file is reached through a symlinked directory, and then `main()` silently never
  runs and the hook does nothing with no error. On macOS `/var` is a symlink to `private/var`, so the
  comparison was already false for anything under `$TMPDIR`; plugin roots are symlinks too, and
  `distill-session.sh` passes node a `BASH_SOURCE`-derived path that still contains the link.

  Fixed structurally rather than defensively: the CLI/logic split above means an entry always runs
  and a `lib/` module never does, so **the guard is gone entirely** along with
  `paths.isEntryPoint` and `paths.runningSelftest`. A guard that does not exist cannot be wrong in
  six files. CI now enforces the property the guard was standing in for — every `lib/` module must
  import with no output.

- **Merging the release PR now publishes the release.** `release.yml` also triggers on pushes to
  `main` and publishes whenever `package.json` names a version with no release yet, so the manual
  `git tag && git push` step is gone. One job creates the tag and the release together, because a
  tag pushed by `GITHUB_TOKEN` does not start another workflow run — a "tag here, react there"
  split would have created the tag and then silently never published. Idempotent: the job runs on
  every push to `main` and is a ~10 s no-op when the version is already out. Pushing a `v*` tag by
  hand still works as an escape hatch.
- **`scripts/release.sh` derives the version from the conventional commits since the last tag** —
  a breaking marker (`!:` / `BREAKING CHANGE`) bumps the major, except below 1.0 where semver lets
  anything change and it bumps the minor; any `feat:` bumps the minor; everything else the patch. Pass a version to override. `--selftest` covers each path,
  including that `feat:` must be anchored at the start of a subject and that `perf:` is not a
  feature. Not release-please or semantic-release: those generate the changelog from commit
  subjects, and here the changelog *is* the release notes — deriving the number is useful,
  generating the prose would be a downgrade.
- Corrected the rule for when a PR goes unreviewed: it is **per workflow file**, not per PR. Only
  a change to `claude-review.yml` itself blocks its review; editing `ci.yml` or `release.yml` is
  reviewed normally. The broader claim was written down first and was wrong.
- `release.yml` passes the resolved version through `env` rather than splicing `${{ }}` into the
  script text, which is the standard Actions script-injection shape, and `scripts/release.sh
  --selftest` moved out of the Node matrix (it is pure bash and was running twice per push).
- `release.yml` runs under a `concurrency: release` group, so two release-worthy merges landing
  seconds apart serialise instead of racing on `gh release create`.
- The CI version check covers `package-lock.json` as well, which had silently sat at 0.1.0 through
  three releases while the four manifest fields moved to 0.1.3.

## [0.2.0] - 2026-08-17

### Removed

- **The Python dependency.** `hooks/distill-session.py` is now `hooks/distill-session.mjs`. Node
  ≥ 22.5 was already a hard requirement for `node:sqlite`, so Python only added a second runtime
  that could be the wrong version — and usually was: macOS ships 3.9, which cannot parse the
  `str | None` annotations the distiller used, so `Insights/` silently stopped being written on a
  stock Mac. Verified equivalent against the original on write, dedup, and reconcile paths, which
  produce byte-identical vaults. CI now rejects any `.py` file or shell script calling `python`.
- One of the three mirrored config implementations. The distiller imports `hooks/lib/paths.mjs`
  instead of re-deriving vault, config, and `project_key` resolution, so that logic exists twice
  now (bash + Node) rather than three times.
- `claude-code-review.yml`, the installer's generic auto-reviewer. It ran on the same
  `pull_request` trigger as `claude-review.yml`, so every PR got reviewed twice; the surviving one
  carries this repo's invariants and can actually comment (`pull-requests: write`).

### Changed

- **`validate-note.sh` is now `validate-note.mjs` — 132 ms → 54 ms** on the hook that runs on every
  Write/Edit (vault pinned to local disk; it was 166 ms → 93 ms cloud-backed, and a hook timing
  means nothing without saying which). The shell version forked ~15 processes (`jq`, `head`, `awk`,
  six `grep`s, `basename`, `sed`) to check one file; fork-per-operation, not the language, was the
  cost. Half the remaining win came from `memory-audit-checks.mjs` becoming import-safe, so its
  predicates run in-process instead of costing a second Node startup.
- **`memory-link-lint.sh` is now `memory-link-lint.mjs`, and it had been timing out.** The shell
  version ran `grep -rlF` over the whole Memory *and* Insights tree once per note — O(N×(N+M)) —
  which measured **10.9 s on a real 49-note project** against the hook's **10 s timeout**, so on
  the largest vault the lint was being killed silently and produced nothing. The Node version
  indexes links in a single pass, O(N+M): **243 ms**, and flat as the vault grows (60 notes:
  1949 ms → 64 ms). Output matches the shell version on every note in a real vault and on generated
  vaults up to 60 notes, with one deliberate exception: a final `MEMORY.md` line with no trailing
  newline: `while read` dropped it, so the shell silently missed drift declared on that line.
  It had looked like a 74 ms hook only because it was measured in a repo with no L1 notes, where
  the loop never ran at all.
- **Shell hooks now share the project-key cache** instead of forking `git` for it. `vault-env.sh`
  reads the same `project-keys.json` that `paths.mjs` writes: `project_key` **34.3 ms → 22.4 ms**,
  and `vault-memory-sync.sh` **97.7 ms → 70.9 ms** with no port. The stamp is
  `"<second>:<size>:<inode>"` so `stat` and `fs.statSync` compute it identically — seconds alone
  left a *permanent* stale-key hole when a remote changed within the cached second, and size alone
  missed a same-length rename; git's atomic config rewrite makes the inode decisive.
- **`insights-surface.sh` is now `insights-surface.mjs` — 124 ms → 52 ms**, and it **fixes a latent
  bug**: `t=$(grep -m1 '^title:' …)` exits non-zero for a note with no `title:` line, which under
  `set -e` aborted the `| while read` subshell. A single untitled note in `Mistakes/` silently
  dropped *every* bullet while still printing the header — so it read as "no past mistakes" rather
  than as a failure, and the intended filename fallback on the next line was unreachable.
- `scripts/memory-audit-checks.mjs` runs its vault-wide audit only when executed directly, and
  exports `checkFile()`. Importing it used to start an audit and exit the process. Verified by
  diffing the full audit, `--deferred`, and `--check-file` over all 1172 notes: identical.
- **`projectKey()` is cached on disk — roughly 50 ms off every hook invocation.** It delegates to
  `vault-env.sh` so there is one implementation of the key, but that costs a bash+git subprocess:
  72 ms in-process, the single largest cost in both the per-prompt recall hook and the per-write
  `validate-note` hook. The answer is now cached in `$CLAUDE_MEMORY_HOME/cache/project-keys.json`
  and validated against a `"<second>:<size>:<inode>"` stamp of the git config that determines it,
  so `git remote set-url` invalidates it rather than leaving a stale key. Fresh process:
  **98 ms → 49 ms**.
  `vault-env.sh` remains the only thing that computes a key; a cache miss is the worst failure.
- **`context-mode` is documented as optional, and degrades instead of drifting.** When the CLI is
  absent the SessionEnd distiller now refreshes the plugin's own semantic index rather than
  refreshing nothing, so notes written this session stay retrievable; only `ctx_search` goes
  stale. The old warning claimed the vault "stops being searchable", which was never true —
  `memory-semantic.mjs` owns its own vector and BM25 arms and never read from context-mode.
- `/memory:doctor` reports both optional integrations under their own heading, with the precise
  cost of each being absent.
- Pinned `actions/checkout` and `actions/setup-node` to v7 in every workflow, clearing GitHub's
  Node 20 runtime deprecation warning.
- Aligned the Claude workflows after `/install-github-app` ran: the review now authenticates with
  `CLAUDE_CODE_OAUTH_TOKEN` (the subscription token the installer actually wrote) instead of
  `ANTHROPIC_API_KEY`, which no longer existed and left the job skipping every PR while reporting
  success. `claude.yml` (the `@claude` mention responder) is kept.

### Added

- A self-test for the project-key cache (`node hooks/lib/paths.mjs --selftest`), which asserts
  against `vault-env.sh` itself rather than fixed strings, uses a fresh process per lookup, and
  covers the failure that would matter: a changed git remote must not keep serving the old key.
- A `docs/` tree with an index, two dated decision records ([Bun](docs/decisions/2026-08-17-bun.md),
  [shell vs Node in hooks](docs/decisions/2026-08-17-shell-vs-node-hooks.md)) and two guides
  ([optional integrations](docs/optional-integrations.md),
  [CI and releases](docs/ci-and-releases.md)). `CLAUDE.md` is loaded into context every session, so
  detail that is read occasionally now lives in files opened on purpose — 231 → 169 lines, with the
  removed material moved rather than dropped.
- Documentation for the two optional integrations — `context-mode` (backs `ctx_search`) and
  `codebase-memory-mcp` (backs the L4 `Graph/` layer and `/memory:graph-report`). Neither is
  installed by this plugin, neither is required, and neither is on the retrieval path. Because
  `codebase-memory-mcp` is an MCP server rather than a CLI, `/memory:doctor` detects it by the
  presence of an L4 digest instead of by looking on PATH.

- `CLAUDE.md` — architecture and conventions for future Claude Code sessions.
- CI on every pull request: the self-tests on Node 22 and 24, `bash -n` over every shell hook, and
  a check that the version agrees across all four places it is written.
- Release automation: pushing a `v*` tag publishes a GitHub release with that version's changelog
  section. `scripts/release.sh` prepares the version bump and opens the PR.
- `main` is protected: no direct pushes, no force-pushes, CI must be green to merge.
- Claude reviews every pull request (`.github/workflows/claude-review.yml`), weighted toward what
  breaks silently here — vault content reaching a public repo, state written inside the
  version-pinned plugin dir, blocking hooks, mirrored config logic drifting apart, and retrieval
  changes with no case-set numbers behind them. It comments; it never approves or merges.

## [0.1.3] - 2026-08-15

### Changed

- **One settings file, `$CLAUDE_MEMORY_HOME/config.json`.** Replaces the two marker files 0.1.1
  and 0.1.2 briefly used; `vault-memory-sync.sh` migrates them on first run. Config is read when
  the hook runs, so it no longer depends on what a process inherited or when the value was written.

## [0.1.2] - 2026-08-15

### Fixed

- Per-prompt recall can be armed from a file, not only from the environment. It had never fired:
  the env var it read did not reach the hook.

## [0.1.1] - 2026-08-15

### Fixed

- The vault resolves from a config file rather than `CLAUDE_VAULT` alone. A `CLAUDE_VAULT` added to
  `settings.local.json` mid-session did not reach that session's hooks, so SessionStart built an
  empty vault at the default path and repointed the memory symlink at it.

## [0.1.0] - 2026-08-15

### Added

- The memory system extracted from `~/.claude` into a self-contained plugin: SessionStart /
  UserPromptSubmit / PostToolUse / SessionEnd hooks, the `/memory:*` commands, the `/memory:protocol`
  skill, `/memory:doctor`, and the README.
- Hybrid retrieval — a local ONNX vector arm and a keyword arm, rank-fused, with per-model indexes.
- Session distillation into `Insights/`, deduped on write.

[Unreleased]: https://github.com/spike1292/claude-memory/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/spike1292/claude-memory/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/spike1292/claude-memory/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/spike1292/claude-memory/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/spike1292/claude-memory/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/spike1292/claude-memory/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/spike1292/claude-memory/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/spike1292/claude-memory/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/spike1292/claude-memory/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/spike1292/claude-memory/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/spike1292/claude-memory/releases/tag/v0.1.0
