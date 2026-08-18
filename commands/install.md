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

2. **Create the state tree.** Nothing mutable may live in the plugin — each release gets its own
   version-pinned cache dir, so anything put there is duplicated per version and lost on update.
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

6. **Share one `node_modules` across installed versions.** Claude Code keeps every version it has
   installed, each with its own copy — six versions of this plugin measured 2.2 GB on 2026-08-18.
   The runtime is identical across them, so it moves to `$STATE` once and every version dir gets a
   symlink. Node resolves through symlinks, so nothing else changes.
   ```bash
   cd "$MEM" && node scripts/share-modules.mjs
   ```
   It refuses to run outside a plugin cache, so it is a no-op error in a git checkout — that is
   correct, a checkout keeps its own. Report the reclaimed figure.

7. **Slim the install.** The same skipped-lifecycle-script gap as step 5, and worth 320 MB: the
   tarballs carry every platform's native runtime plus a browser WASM backend and an image pipeline
   this plugin never executes. Run it *after* the rebuild, which is what fetches the binary for
   *this* platform.
   ```bash
   cd "$MEM" && node scripts/slim-install.mjs && du -sh node_modules
   ```
   Expect ~59 MB. It is idempotent and prints nothing on a second run. If it reports a failure,
   nothing is broken — you keep a 380 MB install.

8. **Warm the model into `$STATE/models`.** First use otherwise downloads ~700 MB at an
   unpredictable moment, and — if the cache dir were wrong — into the plugin dir, where the next
   `/plugin update` would discard it.
   ```bash
   cd "$MEM" && node --test scripts/lib/memory-semantic.test.mjs
   du -sh "$STATE/models"
   ```
   Report the size. If `$STATE/models` is empty but a model loaded, the cache redirect is broken —
   say so loudly rather than moving on.

9. **Write the settings file.** Ask the user for the vault path — it is theirs, not a guess to make.
   Preserve any keys already in the file rather than overwriting it wholesale.
   ```bash
   cat > "$STATE/config.json" <<'JSON'
   {
     "vault": "/absolute/path/to/vault",
     "recall": false
   }
   JSON
   ```
   Configuration belongs here rather than in `~/.claude/settings.json`'s `env` block: the file is
   read when the hook runs, so it does not depend on what the process inherited or on when the value
   was written. A `CLAUDE_VAULT` added to `settings.local.json` mid-session did not reach that
   session's hooks, and the SessionStart hook built an empty vault at the default path.

   Omit `vault` only if it really is `~/Documents/ClaudeVault`.

10. **Optionally arm per-prompt recall** by setting `"recall": true`. It ships inert, because
   injecting into every prompt changes how every session reads. Mention it; do not enable it unasked.

11. **Finish with `/memory:doctor`** and report its output verbatim.
