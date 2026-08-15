---
description: Install the local embedding runtime and set up machine-local state. Idempotent — safe to re-run.
---

Semantic recall needs a local ONNX runtime that Claude Code's plugin install cannot fully set up on
its own: it runs `npm ci` from the lockfile but **skips lifecycle scripts**, and `onnxruntime-node`
downloads its native binary in a postinstall. So the package directory can exist while the runtime
is unusable. This command closes that gap and never leaves the machine — the weights run locally, so
private notes are never sent anywhere.

Run each step, report pass/fail per step, and stop at the first hard failure.

```bash
STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
```

1. **Check Node.** `node --version` must be **≥ 22.5** — the engine uses the built-in `node:sqlite`
   `DatabaseSync`, which does not exist before then and fails with an obscure import error rather
   than a clear one. If the version is lower, stop here and say so; nothing else will work.

2. **Create the state tree.** Nothing mutable may live in the plugin — its cache dir is version-pinned
   and replaced wholesale on `/plugin update`.
   ```bash
   mkdir -p "$STATE"/{db,models,logs,run,eval}
   ```

3. **Migrate state from the pre-plugin layout**, if this machine ran the `~/.claude` version.
   Move, do not copy — two copies of an index drift apart silently. Skip any that are absent.
   ```bash
   [ -d "$HOME/.claude/data" ] && {
     mv -n "$HOME/.claude/data"/semantic-*.db      "$STATE/db/"   2>/dev/null
     mv -n "$HOME/.claude/data"/eval-cases-*.jsonl "$STATE/eval/" 2>/dev/null
     mv -n "$HOME/.claude/data"/recall-*.jsonl     "$STATE/logs/" 2>/dev/null
   }; ls "$STATE/db" | head
   ```
   Migrating rather than re-indexing matters: a full re-embed of a large vault takes minutes, and the
   existing indexes are byte-for-byte valid.

   Move any previously-downloaded model weights too — this is ~700 MB you do not want to fetch twice.
   transformers.js keeps them under `<cache>/<org>/<model>/`, so the layout carries over unchanged:
   ```bash
   for c in "$HOME/.claude/node_modules/@huggingface/transformers/.cache" \
            "$MEM/node_modules/@huggingface/transformers/.cache"; do
     [ -d "$c" ] && mv -n "$c"/* "$STATE/models/" 2>/dev/null && rmdir "$c" 2>/dev/null
   done; du -sh "$STATE/models" 2>/dev/null
   ```

4. **Install dependencies.**
   ```bash
   cd "$MEM" && npm ci --no-audit --no-fund
   ```
   If `npm ci` fails because the lockfile is out of sync, use `npm install` and report that the
   lockfile needs regenerating.

5. **Force the skipped postinstall.** This is the step the auto-install misses.
   ```bash
   cd "$MEM" && npm rebuild onnxruntime-node
   ```
   Then prove the native binding actually loads — a present directory is not evidence:
   ```bash
   cd "$MEM" && node -e "await import('onnxruntime-node'); console.log('onnxruntime ok')" --input-type=module
   ```

6. **Warm the model into `$STATE/models`.** First use otherwise downloads ~700 MB at an
   unpredictable moment, and — if the cache dir were wrong — into the plugin dir, where the next
   `/plugin update` would discard it.
   ```bash
   cd "$MEM" && node scripts/memory-semantic.mjs --selftest
   du -sh "$STATE/models"
   ```
   Report the size. If `$STATE/models` is empty but a model loaded, the cache redirect is broken —
   say so loudly rather than moving on.

7. **Set `CLAUDE_VAULT`** in `~/.claude/settings.local.json` (gitignored, machine-local) if it is not
   already set and the vault is not at the default `~/Documents/ClaudeVault`:
   ```json
   { "env": { "CLAUDE_VAULT": "/absolute/path/to/vault" } }
   ```
   Ask before writing this — it is the user's path, not a guess to make.

8. **Optionally arm per-prompt recall.** It ships inert, because injecting into every prompt changes
   how every session reads. Mention it; do not enable it unasked:
   ```json
   { "env": { "MEMORY_RECALL_ENABLED": "1" } }
   ```

9. **Finish with `/memory:doctor`** and report its output verbatim.
