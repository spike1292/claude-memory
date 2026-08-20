---
description: Diagnose the memory install — runtime, dependencies, vault, index, recall, and with --perf where the RAM and disk went. Read-only.
---

Run the check script and show its output verbatim as a checklist. It is read-only and always
exits 0, so treat the printed FAIL/WARN lines as the result, not the exit code.

```bash
STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
"$MEM/scripts/doctor.sh" $ARGUMENTS
```

Then, in at most three lines:

- If there are **FAIL** lines, name the single first thing to do (usually `/memory:install`).
- If there are only **WARN** lines, say plainly which capability is degraded — most warnings are
  "this feature is off", not "this is broken". Per-prompt recall being off is the intended default.
- If everything passed, say so and stop. Do not suggest improvements nobody asked for.

`--perf` appends a performance report: resident search servers with their RSS and whether the model
is currently loaded, the recall round trip against a socket that is **already** listening, every
index on the machine with its size and chunk count, and the disk split under
`$CLAUDE_MEMORY_HOME`. Pass it through when the user asks why memory is slow, why RAM is high, or
what is using the disk — and when reporting those numbers, say plainly which ones are normal: a
second index on an inactive model is dead weight, more than one server is the 16 GB failure mode,
and a first query far slower than the second is just an index loading on demand.

It never starts a server or re-indexes, so "not measured: no socket" is a state, not a fault.

Run it from the project directory you care about: the index check resolves the project key from
`pwd`, so running it from elsewhere reports on a different project's index.
