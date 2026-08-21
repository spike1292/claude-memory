---
description: Diagnose the memory install — runtime, dependencies, vault, index, recall, with --perf where the RAM and disk went, --stats whether recall is helping and --hooks whether the hooks are alive. Read-only.
---

Run the check script and show its output verbatim as a checklist. It is read-only and always
exits 0, so treat the printed FAIL/WARN lines as the result, not the exit code.

```bash
STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
"$MEM/scripts/doctor.sh"
```

Add `--perf` to that command when the user asked about speed, memory or disk:

```bash
"$MEM/scripts/doctor.sh" --perf
```

Add `--stats` instead when the user asked whether recall is working, what it retrieves, how often it
stays silent, or which notes never surface:

```bash
"$MEM/scripts/doctor.sh" --stats
```

Add `--hooks` instead when the user asked whether the hooks are running, why a session start feels
slow, or whether something stopped working silently:

```bash
"$MEM/scripts/doctor.sh" --hooks
```

Then, in at most three lines:

- If there are **FAIL** lines, name the single first thing to do (usually `/memory:install`).
- If there are only **WARN** lines, say plainly which capability is degraded — most warnings are
  "this feature is off", not "this is broken". Per-prompt recall being off is the intended default.
- If everything passed, say so and stop. Do not suggest improvements nobody asked for.

Do not splice the user's words into either command line. Decide which of the forms above to
run and type it out; the flags may be combined, but only do that if the user asked about more than
one.

`--perf` appends a performance report: resident search servers with their RSS and whether the model
is currently loaded, the recall round trip against a socket that is **already** listening, every
index on the machine with its size and chunk count, and the disk split under
`$CLAUDE_MEMORY_HOME`. Pass it through when the user asks why memory is slow, why RAM is high, or
what is using the disk — and when reporting those numbers, say plainly which ones are normal: a
second index on an inactive model is dead weight, more than one server is the 16 GB failure mode,
and a first query far slower than the second is just an index loading on demand.

It never starts a server or re-indexes, so "not measured: no socket" is a state, not a fault.

`--stats` appends the recall analytics report, read from the daily `recall-*.jsonl` logs (the last 7
days recall ran; `--stats=30` widens the window) plus this project's index. The logs are
machine-wide and the index is not, so the report is scoped to the project you run it from and says
how many decisions in the window belonged to other projects. It reports how often recall injected versus abstained,
the abstention reasons, score and latency distributions per arm, the notes injected most, and the
indexed notes never injected at all. Read it with three things in mind: **abstention is the design**,
not a fault, so a high abstain rate is only a problem if the injections are also poor; the two arms'
scores are on **different scales** (cosine against 0.55, BM25 against 6.0) and must never be compared
across rows; and a **never-injected note is not necessarily dead** — it may simply be phrased in
words no prompt has used yet. Lines logged before latency existed are counted as unmeasured, not as
zero.

**The `--stats` section prints note names from the user's vault.** Everything else `/memory:doctor`
prints is safe to paste into a public issue; that section is not. Show it to the user, and if they
are about to file an issue with it, say so and offer the rates without the note lists.

`--hooks` appends the hook analytics report, read from the daily `hooks-*.jsonl` logs (the last 7
days a hook ran; `--hooks=30` widens the window) plus `hooks.json` for the declared timeouts. It
reports invocation counts, p50/p95/max duration, the outcome breakdown, and how many invocations ran
at or past half their timeout — **one row per hook AND event**, so `distill-session · Stop` (a cheap
decision fired every assistant turn) and `distill-session · SessionEnd` (the run that reads the
transcript) are separate rows with separate budgets. Read it with three things in mind: **`ms` is the
whole process**, node startup included, because that is what the timeout applies to; a `· worker`
row is the detached background run and has no timeout, so never read it as a slow hook; and the
outcome column is the point — `noop-missing-dep` means a hook is doing nothing at all and needs
`/memory:doctor` proper. `debounced` and `child-guard` are deliberate skips, and a high skip rate is
not a fault by itself — read it against what the hook is for. `distill-session · Stop` is a crash
fallback that stands down on nearly every assistant turn, so 100% `debounced` there is the healthy
state. It is a finding where work was expected: a `· SessionEnd` row that never spawns, or a
`graph-staleness-check` held off by a lock nothing releases. The
bash hook (`vault-memory-sync`) is not instrumented, and `graph-staleness-check`'s background run
is timed by nothing; the report names both, so their absence is not a hook that failed to run.

**The sample is censored at the timeout.** A hook killed at its limit is killed by a signal and
writes no line, so a real breach never appears — the near-timeout column counts only how close the
survivors ran. Read a hook whose count drops, or that stops appearing at all, as the breach. Say
this if the user is reading the column as proof that nothing times out.

Unlike `--stats`, this section prints no note names, and paths inside a failure reason are redacted
to `<path>` before they are printed — a raw `ENOENT` carries the vault root, a note filename and the
OS username, and this report is the one someone pastes into an issue. It does still print the
**project slug**, which is the normalised git remote, so for a private or work repo it names the
repo. Say that before the user pastes it anywhere public. The full, unredacted message stays in
`$CLAUDE_MEMORY_HOME/logs/hooks-*.jsonl` on their own machine, which is where it is useful.

Do not offer to retune a gate, a timeout or a debounce window from what any of this prints unless
the user asks — moving a gate is a
separate change that needs its own case-set run behind it.

Run it from the project directory you care about: the index check resolves the project key from
`pwd`, so running it from elsewhere reports on a different project's index.
