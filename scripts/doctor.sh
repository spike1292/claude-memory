#!/usr/bin/env bash
# Diagnose a memory-plugin install. Read-only: reports, never repairs.
#
# Every check prints one line: "ok"/"WARN"/"FAIL", what was checked, and — when it fails —
# the fix. Checks that prove a thing WORKS beat checks that a file exists: a present
# node_modules/onnxruntime-node whose postinstall was skipped is the exact failure mode this
# whole command exists for, and a directory test would call it green.
#
# Exit 0 always: this is a report, and a non-zero exit inside a slash command reads as the
# command itself being broken.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
. "$ROOT/hooks/lib/vault-env.sh"

STATE=$(memory_home)
VAULT=$(resolve_vault)
fails=0; warns=0

ok()   { printf '  ok   %s\n' "$1"; }
warn() { printf '  WARN %s\n     → %s\n' "$1" "$2"; warns=$((warns+1)); }
fail() { printf '  FAIL %s\n     → %s\n' "$1" "$2"; fails=$((fails+1)); }

echo "memory plugin: $ROOT"
echo "state:         $STATE"
echo "vault:         $VAULT"
echo

echo "runtime"
if ! command -v node >/dev/null 2>&1; then
  fail "node not on PATH" "hooks that need node exit silently. Install node >=22.5, or check your fnm/nvm default is on PATH for non-interactive shells."
else
  nv=$(node -p 'process.versions.node')
  # node:sqlite DatabaseSync landed in 22.5 and is used unguarded by the engine and the
  # recall hook. Below that they fail with an obscure ERR_UNKNOWN_BUILTIN_MODULE.
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a>22||(a===22&&b>=5))?0:1)'; then
    ok "node $nv (>= 22.5, node:sqlite available)"
  else
    fail "node $nv is below 22.5" "the engine uses the built-in node:sqlite, absent before 22.5. Upgrade node."
  fi
fi
command -v jq      >/dev/null 2>&1 && ok "jq"      || fail "jq not on PATH"      "every bash hook parses its stdin payload with jq. brew install jq"
command -v python3 >/dev/null 2>&1 && ok "python3" || warn "python3 not on PATH" "SessionEnd distillation is skipped; Insights/ stops being written."
command -v claude  >/dev/null 2>&1 && ok "claude CLI" \
  || warn "claude CLI not on PATH" "the distiller and the graph-report refresh shell out to it headlessly; both degrade to no-ops."
command -v context-mode >/dev/null 2>&1 && ok "context-mode CLI" \
  || warn "context-mode CLI not on PATH" "the SessionEnd vault re-index is skipped, so ctx_search drifts behind the notes on disk. npm i -g context-mode"

echo
echo "embedding runtime"
if [ ! -d "$ROOT/node_modules/@huggingface/transformers" ]; then
  fail "@huggingface/transformers not installed" "semantic recall is off; only keyword search answers. Run /memory:install"
else
  ok "@huggingface/transformers present"
  # The point of this check: Claude Code's plugin auto-install runs `npm ci` but skips
  # lifecycle scripts, so onnxruntime-node's native binary may never have been fetched.
  # Loading it is the only way to tell.
  if (cd "$ROOT" && node --input-type=module -e 'await import("onnxruntime-node")' >/dev/null 2>&1); then
    ok "onnxruntime-node native binding loads"
  else
    fail "onnxruntime-node present but will not load" "its postinstall was skipped. Run /memory:install (npm rebuild onnxruntime-node)"
  fi
fi

if [ -d "$STATE/models" ] && [ -n "$(ls -A "$STATE/models" 2>/dev/null)" ]; then
  ok "model weights cached in state ($(du -sh "$STATE/models" 2>/dev/null | cut -f1))"
else
  warn "no model weights in $STATE/models" "first query downloads ~700 MB. Run /memory:install to warm them."
fi
# Weights inside the plugin are discarded by the next /plugin update, silently costing a
# 700 MB re-download. Catch the redirect having failed.
if [ -d "$ROOT/node_modules/@huggingface/transformers/.cache" ]; then
  warn "weights are cached inside the plugin, not in $STATE/models" \
       "a /plugin update will discard them. The HF cache redirect in hooks/lib/paths.mjs is not taking effect."
fi

echo "vault"
echo "  resolved from: $(vault_source)"
if [ -d "$VAULT" ]; then
  ok "vault exists"
  [ -w "$VAULT" ] && ok "vault writable" || fail "vault not writable" "hooks cannot write notes. Check permissions on $VAULT"

  # "Pointed at the WRONG vault" is the failure that matters, and an existence check
  # cannot see it: on 2026-08-15 a misresolution silently created an empty scaffold at
  # the default path and repointed the memory symlink at it. Everything read as fine.
  # So: count the notes, and if there are none, go looking for a populated vault
  # elsewhere before calling this healthy.
  n=$(find "$VAULT" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -gt 0 ]; then
    ok "vault holds $n notes"
  else
    other=""
    for cand in "$HOME/Documents/ClaudeVault" \
                "$(head -n1 "$STATE/vault" 2>/dev/null)" \
                "$HOME/Library/CloudStorage"/*/*/Claude; do
      [ -n "$cand" ] && [ -d "$cand" ] && [ "$cand" != "$VAULT" ] || continue
      [ "$(find "$cand" -type f -name '*.md' 2>/dev/null | head -1)" ] && { other="$cand"; break; }
    done
    if [ -n "$other" ]; then
      fail "vault is EMPTY but a populated vault exists at $other" \
           "you are pointed at the wrong one — nothing will be recalled and new notes land in the empty one. Fix: echo '$other' > \"$STATE/vault\""
    else
      warn "vault is empty" "expected on a first install; notes appear as you work."
    fi
  fi
else
  fail "vault does not exist: $VAULT" "create it, or write the real path: echo /path/to/vault > \"$STATE/vault\""
fi
# The env var is an override, not the mechanism — `env` in settings.local.json does NOT
# reach hook subprocesses, so a config file is what actually keeps hooks on the vault.
if [ ! -f "$STATE/vault" ] && [ -z "${CLAUDE_VAULT:-}" ]; then
  warn "no $STATE/vault config file" \
       "hooks run with no inherited env, so setting CLAUDE_VAULT in settings.local.json alone does NOT reach them. Run /memory:install, or: echo '$VAULT' > \"$STATE/vault\""
fi
[ -f "$STATE/plugin-root" ] && ok "plugin-root breadcrumb written" \
  || warn "no $STATE/plugin-root" "written by the SessionStart hook; /memory:* commands fall back to it when CLAUDE_PLUGIN_ROOT is unset. Start a new session."

echo
echo "index"
slug=$(project_key "$PWD")
model="${MEMORY_SEMANTIC_MODEL:-bge-m3}"
db="$STATE/db/semantic-$slug-$model.db"
echo "  project: $slug  model: $model"
if [ -f "$db" ]; then
  if command -v node >/dev/null 2>&1; then
    n=$(node -e '
      const {DatabaseSync}=require("node:sqlite");
      try{const d=new DatabaseSync(process.argv[1],{readOnly:true});
        console.log(d.prepare("select count(*) c from chunks").get().c);}catch(e){console.log("err")}' "$db" 2>/dev/null)
    case "$n" in
      err|"") warn "index unreadable: $(basename "$db")" "run /memory:prune to rebuild, or delete it and let the SessionStart hook re-index." ;;
      0)      warn "index is empty" "nothing to recall. Check Memory/$slug exists in the vault, then start a new session." ;;
      *)      ok "index has $n chunks" ;;
    esac
  fi
else
  warn "no index for this project" "recall abstains silently. It builds on the next SessionStart if $VAULT/Memory/$slug exists."
fi
sock="$STATE/run/search-$slug-$model.sock"
[ -S "$sock" ] && ok "resident search server listening" \
  || warn "search server not running" "first recall of the session spawns it (~1.5s), then answers take ~60ms. Not an error."

echo
echo "recall"
[ "${MEMORY_RECALL_ENABLED:-}" = "1" ] && ok "per-prompt recall armed" \
  || warn "per-prompt recall is OFF" 'ships inert by design. Set {"env":{"MEMORY_RECALL_ENABLED":"1"}} in ~/.claude/settings.local.json'

echo
if [ "$fails" -gt 0 ]; then
  echo "$fails failure(s), $warns warning(s) — semantic recall will not work until the failures are fixed."
elif [ "$warns" -gt 0 ]; then
  echo "no failures, $warns warning(s) — core memory works; see the warnings for what is degraded."
else
  echo "all checks passed."
fi
exit 0
