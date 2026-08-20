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
#
# `--perf` appends the performance report — server RSS, index sizes, disk split, recall round trip.
# One entry point rather than a second command: the perf numbers are only readable next to the
# wiring checks, and a paste of the whole thing is what an issue wants. It is Node
# (scripts/doctor-perf.mjs), because every line of it loops.
set -uo pipefail

perf=0
for arg in "$@"; do
  case "$arg" in
    --perf) perf=1 ;;
    -h|--help) echo "usage: doctor.sh [--perf]"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)"; exit 0 ;;
  esac
done

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
# Was a hard fail while every hook was bash and parsed its payload with jq. After the 2026-08-18
# port that is ONE hook — vault-memory-sync.sh — and it degrades: `jq ... || true` then falls back
# to $PWD, which at SessionStart is normally the right directory anyway. A warning states the real
# cost; a failure would send someone installing jq to fix something that is not broken.
command -v jq      >/dev/null 2>&1 && ok "jq"      || warn "jq not on PATH" \
  "only vault-memory-sync.sh needs it, to read cwd from the hook payload; without it that hook falls back to \$PWD, which is wrong only when Claude Code reports a cwd different from the shell's. brew install jq"
command -v claude  >/dev/null 2>&1 && ok "claude CLI" \
  || warn "claude CLI not on PATH" "the distiller and the graph-report refresh shell out to it headlessly; both degrade to no-ops."

echo
echo "optional integrations"
# Neither is required. Both are separate tools with their own indexes; the plugin's own
# retrieval path does not read from either. Reported so a missing one is a known state
# rather than a mystery, and so the cost of its absence is stated precisely.
if command -v context-mode >/dev/null 2>&1; then
  ok "context-mode CLI — ctx_search index kept fresh at SessionEnd"
else
  warn "context-mode CLI not on PATH (optional)" \
    "ctx_search drifts behind the notes on disk. The plugin's own index is UNAFFECTED — memory-semantic.mjs carries its own vector and BM25 arms — and the distiller refreshes it instead. Restore ctx_search with: npm i -g context-mode (then /memory:prune)"
fi
# codebase-memory-mcp is an MCP server, not a CLI, so PATH cannot see it. The Graph layer is the
# observable evidence: a GRAPH_REPORT.md exists only if the server has run for this project.
gslug=$(project_key "$PWD")
if [ -f "$VAULT/Graph/$gslug/GRAPH_REPORT.md" ]; then
  ok "codebase-memory-mcp — L4 graph digest present for $gslug"
else
  warn "no L4 graph digest for this project (optional)" \
    "L1-L3 memory is unaffected. If codebase-memory-mcp is configured, run /memory:graph-report to create one; if it is not, skip L4 entirely — nothing else depends on it."
fi

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
  # Same skipped-lifecycle-script gap, different symptom: nothing breaks, the install is just
  # 320 MB of binaries that cannot load here (other platforms, browser WASM, image pipeline).
  # Claude Code keeps every installed version of a plugin — it does not replace the cache on
  # update. Six versions of this plugin measured 381 MB each, 2.2 GB total, on 2026-08-18. The
  # runtime is identical across them, so one shared copy in $STATE is the whole fix.
  if [ -L "$ROOT/node_modules" ]; then
    ok "node_modules shared from $STATE ($(du -shL "$ROOT/node_modules" 2>/dev/null | cut -f1 | tr -d ' '))"
  else
    case "$ROOT" in
      */plugins/cache/*)
        vers=$(dirname "$ROOT")
        n=$(find "$vers" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
        tot=$(du -sm "$vers" 2>/dev/null | cut -f1)
        if [ "${n:-1}" -gt 1 ]; then
          warn "$n installed versions, ${tot} MB total — each keeps its own node_modules" \
            "run /memory:install, or: (cd \"$ROOT\" && node scripts/share-modules.mjs)"
        fi
        ;;
    esac
  fi

  # -L on purpose: once node_modules is a symlink into $STATE, du without it measures the link
  # (0 MB) and this check would pass by measuring nothing.
  nm_mb=$(du -smL "$ROOT/node_modules" 2>/dev/null | cut -f1)
  if [ "${nm_mb:-0}" -gt 150 ]; then
    warn "node_modules is ${nm_mb} MB" "unslimmed. Run /memory:install, or: (cd $ROOT && node scripts/slim-install.mjs)"
  else
    ok "node_modules slimmed (${nm_mb:-?} MB)"
  fi
fi

if [ -d "$STATE/models" ] && [ -n "$(ls -A "$STATE/models" 2>/dev/null)" ]; then
  # -L: models/ is the largest thing in $STATE and the one directory the size breakdown below
  # deliberately does not re-walk, so this line is its only measurement. Without -L a symlinked
  # models/ reports 0 here and nothing else would catch it (2026-08-19, review of #24).
  ok "model weights cached in state ($(du -shL "$STATE/models" 2>/dev/null | cut -f1))"
else
  warn "no model weights in $STATE/models" "first query downloads ~700 MB. Run /memory:install to warm them."
fi
# Weights inside the plugin are discarded by the next /plugin update, silently costing a
# 700 MB re-download. Catch the redirect having failed.
if [ -d "$ROOT/node_modules/@huggingface/transformers/.cache" ]; then
  warn "weights are cached inside the plugin, not in $STATE/models" \
       "a /plugin update will discard them. The HF cache redirect in hooks/lib/paths.mjs is not taking effect."
fi

echo
echo "state size"
# Unbounded growth stays invisible until someone trips over it: the 2.2 GB of duplicated
# node_modules above was found by accident, and everything else under $STATE has exactly the
# same shape with nothing watching it. -L for the same reason as the node_modules check —
# once a subdirectory is a symlink into a shared install, du without it measures the link (0)
# and this section would report a healthy state by measuring nothing (2026-08-18).
#
# The total measures $STATE itself, not the sum of the directories below it. Summing a fixed list
# omits whatever is not on the list — and the first review of this section caught it omitting
# node_modules/, the one directory the 2.2 GB incident above was actually about. One walk of the
# real thing cannot drift from what is in there; a hand-maintained list can, and did.
state_mb=$(du -smL "$STATE" 2>/dev/null | cut -f1)
# Breakdown of what the total is made of. models/ and node_modules/ are reported above with their
# own thresholds, so they are not repeated here — du walks them once for the total and that is
# already the slowest part of this report.
for d in db logs eval run cache; do
  [ -d "$STATE/$d" ] || continue
  ok "$d/ $(du -shL "$STATE/$d" 2>/dev/null | cut -f1 | tr -d ' ')"
done
# ~722 MB of the expected total is the ONNX weights in models/, so the threshold has to sit well
# above that. Past 2 GB something else grew: logs/ and eval/ only append, and db/ keeps one index
# per model PER PROJECT, so a machine with many repos accumulates indexes nothing ever deletes.
if [ "${state_mb:-0}" -gt 2048 ]; then
  warn "state is ${state_mb} MB" "nothing prunes it automatically. Run /memory:prune, then delete db/semantic-*.db for projects you no longer index and old eval/ runs."
else
  ok "state total ${state_mb:-?} MB"
fi

echo
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
           "you are pointed at the wrong one — nothing will be recalled and new notes land in the empty one. Fix: set \"vault\": \"$other\" in $(config_file)"
    else
      warn "vault is empty" "expected on a first install; notes appear as you work."
    fi
  fi
else
  fail "vault does not exist: $VAULT" "create it, or set \"vault\" in $(config_file)"
fi
# Config belongs in the plugin's own file, not in ~/.claude/settings.json `env` — that is
# the ecosystem convention, and a file is read when the hook runs rather than depending on
# what the process inherited or when the value was written.
if [ ! -f "$(config_file)" ]; then
  warn "no config file at $(config_file)" \
       "running on defaults and env vars. Run /memory:install to write one."
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
# One server per MODEL, serving every project — not per slug+model, which held one ~1.3GB model
# per indexed repo.
sock="$STATE/run/search-$model.sock"
[ -S "$sock" ] && ok "resident search server listening" \
  || warn "search server not running" "first recall of the session spawns it (~1.5s), then answers take ~60ms. Not an error."
stale=$(find "$STATE/run" -name 'search-*.sock' ! -name "search-$model.sock" 2>/dev/null | wc -l | tr -d ' ')
# `|| true`: a false test is the LAST command here, and this script must exit 0 whatever it finds.
[ "${stale:-0}" -gt 0 ] && warn "$stale leftover socket(s) in run/" \
  "from the per-project scheme or another model. The next server start evicts them." || true

# The graph-regen lock (#34). Held = a full re-index is running somewhere on this machine and every
# other session will nudge instead of starting a second one. Read-only: never reclaim it here.
lock="$STATE/run/graphgen.lock"
if [ -f "$lock" ]; then
  lock_pid=$(awk '{print $1}' "$lock" 2>/dev/null)
  lock_at=$(awk '{print $2}' "$lock" 2>/dev/null)
  # Each field validated SEPARATELY before any arithmetic, because a lock truncated mid-write to
  # just "123" leaves a digit-only pid and an empty age — concatenating them hid that, and the age
  # then defaulted to 0 and reported a 56-year-old lock instead of a gone owner. An unusable age
  # zeroes the pid too, so both land on the same verdict lockHolder() reaches via Number.isFinite.
  case "${lock_pid:-}" in (*[!0-9]*|'') lock_pid=0 ;; esac
  case "${lock_at:-}" in (*[!0-9]*|'') lock_pid=0; lock_at=0 ;; esac
  age=$(( $(date +%s) - ${lock_at:-0} ))
  # The staleness window is ASKED FOR, not copied: a second 3600 here would drift the moment
  # LOCK_MAX_SECONDS moves, and doctor would then call a held lock stale (or the reverse).
  # Deliberately NOT guarded by `command -v node`, unlike the perf block: a missing node leaves
  # lock_max empty and the branch below already reports that, where the perf block has no output
  # to fall back to. Do not "fix" this into a guard that silently skips the check.
  # pathToFileURL, not a bare path: import() of an absolute path is read as a package specifier.
  lock_max=$(node -e 'import(require("node:url").pathToFileURL(process.argv[1]).href).then((m) => console.log(m.LOCK_MAX_SECONDS))' \
    "$ROOT/hooks/lib/graph-staleness-check.mjs" 2>/dev/null)
  case "${lock_max:-}" in (*[!0-9]*|'') lock_max='' ;; esac
  # `-gt 0`: `kill -0 0` signals our own process group and succeeds, so pid 0 would read as alive.
  if [ "${lock_pid:-0}" -le 0 ] || ! kill -0 "$lock_pid" 2>/dev/null; then
    warn "stale graphgen lock in run/" "its owner is gone. The next stale session reclaims it; nothing to do."
  elif [ -z "$lock_max" ]; then
    warn "graphgen lock held by live pid $lock_pid (${age}s)" "could not read LOCK_MAX_SECONDS, so whether it is still within its window is unknown. See the runtime section."
  elif [ "$age" -lt "$lock_max" ]; then
    ok "graph re-index running (pid $lock_pid, ${age}s) — other sessions will not start a second one"
  else
    warn "stale graphgen lock in run/" "held for ${age}s, past the ${lock_max}s window. The next stale session reclaims it; nothing to do."
  fi
fi

echo
echo "recall"
if [ "$(recall_config)" = "true" ]; then
  ok "per-prompt recall armed (\"recall\": true in $(basename "$(config_file)"))"
elif [ "${MEMORY_RECALL_ENABLED:-}" = "1" ]; then
  warn "recall armed by env var only" \
       "works where the environment reaches the hook, but a value added mid-session does not. Prefer \"recall\": true in $(config_file)"
else
  warn "per-prompt recall is OFF" "ships inert by design. Arm it with \"recall\": true in $(config_file)"
fi
# Recall logs every decision, including abstentions. No log at all means it never ran.
if recall_enabled && [ -z "$(ls "$STATE/logs"/recall-*.jsonl 2>/dev/null)" ]; then
  warn "recall is armed but has never logged a decision" \
       "expected until a session runs with it armed; if it persists, the hook is not firing."
fi

if [ "$perf" -eq 1 ]; then
  # Read-only like everything else here: it never starts a server, loads a model or re-indexes, so
  # a missing socket is reported as "not measured" rather than spawned into existence.
  if command -v node >/dev/null 2>&1; then
    echo
    echo "performance"
    # `^.` and not `^`: indenting a blank line would leave trailing whitespace behind.
    node "$ROOT/scripts/doctor-perf.mjs" "$PWD" 2>&1 | sed 's/^./  &/'
  else
    echo
    warn "cannot report performance without node" "see the runtime section above."
  fi
fi

echo
if [ "$fails" -gt 0 ]; then
  echo "$fails failure(s), $warns warning(s) — semantic recall will not work until the failures are fixed."
elif [ "$warns" -gt 0 ]; then
  echo "no failures, $warns warning(s) — core memory works; see the warnings for what is degraded."
else
  echo "all checks passed."
fi
exit 0
