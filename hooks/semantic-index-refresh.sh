#!/usr/bin/env bash
# SessionStart: keep the semantic vault index current, in the background.
#
# Why a hook and not a convention: the index only refreshed if someone ran /memory:prune. Every
# convention in this system has eventually failed that way (MOC-only notes recurred through four
# audits, path drift through two), and a stale vector index is worse than none — it answers with
# notes that were merged away hours ago. The refresh is mechanical now.
#
# Why SessionStart and not SessionEnd: the SessionEnd distiller writes new Insight notes *during*
# shutdown, so a SessionEnd refresh races it. Refreshing at the start of the next session picks up
# everything the previous one wrote, whatever order it landed in.
#
# Cost when nothing changed: the indexer compares mtimes and exits before loading the model, so a
# no-op costs a stat pass. When notes did change it re-embeds only those. Either way it is detached,
# so session start never waits.
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/vault-env.sh"
VAULT=$(resolve_vault)

cwd=$(cat | jq -r '.cwd // empty' 2>/dev/null || true)
[ -z "${cwd:-}" ] && cwd="$PWD"
slug=$(project_key "$cwd")
[ -d "$VAULT/Memory/$slug" ] || slug=$(legacy_key "$cwd")   # pre-migration fallback
[ -d "$VAULT/Memory/$slug" ] || exit 0                      # no vault memory here — nothing to index

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../scripts/memory-semantic.mjs"
[ -f "$script" ] || exit 0

# The embedding runtime is an npm install, and Claude Code's plugin auto-install skips
# lifecycle scripts — so onnxruntime-node's native binary may be missing even when the
# package dir exists. Say so once instead of failing silently at query time.
if [ ! -d "$here/../node_modules/@huggingface/transformers" ]; then
  echo "⚠ memory: embedding runtime not installed — semantic recall is off. Run /memory:install" >&2
  exit 0
fi

MEM_HOME=$(memory_home)
mkdir -p "$MEM_HOME/logs"

# One writer at a time: two sessions opening at once would race on the same SQLite file.
lock="$MEM_HOME/.semantic-index.lock"
if ! mkdir "$lock" 2>/dev/null; then
  # Reclaim a lock left behind by a killed run (older than 30 min), otherwise assume a live one.
  if [ -z "$(find "$lock" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then exit 0; fi
  rmdir "$lock" 2>/dev/null || true
  mkdir "$lock" 2>/dev/null || exit 0
fi

log="$MEM_HOME/logs/semantic-index.log"
(
  trap 'rmdir "$lock" 2>/dev/null || true' EXIT
  printf '\n=== %s %s ===\n' "$(date -u +%FT%TZ)" "$slug" >>"$log"
  node "$script" --index "$cwd" >>"$log" 2>&1 || true
) >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
