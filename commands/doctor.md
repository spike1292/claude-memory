---
description: Diagnose the memory install — runtime, dependencies, vault, index, recall. Read-only.
---

Run the check script and show its output verbatim as a checklist. It is read-only and always
exits 0, so treat the printed FAIL/WARN lines as the result, not the exit code.

```bash
STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
"$MEM/scripts/doctor.sh"
```

Then, in at most three lines:

- If there are **FAIL** lines, name the single first thing to do (usually `/memory:install`).
- If there are only **WARN** lines, say plainly which capability is degraded — most warnings are
  "this feature is off", not "this is broken". Per-prompt recall being off is the intended default.
- If everything passed, say so and stop. Do not suggest improvements nobody asked for.

Run it from the project directory you care about: the index check resolves the project key from
`pwd`, so running it from elsewhere reports on a different project's index.
