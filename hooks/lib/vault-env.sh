#!/usr/bin/env bash
# Shared vault resolution, project key, and state dir. Sourced by every hook.
# Dependency-free on purpose (no jq): a fresh install must work before anything
# else is installed.
#
#   . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/vault-env.sh"
#   VAULT=$(resolve_vault); key=$(project_key "$cwd"); HOME_DIR=$(memory_home)
#
# Resolve relative to this file, never to an absolute install path: the plugin
# runs from a version-pinned cache dir, from a dev checkout, and via symlink.

# --- settings -----------------------------------------------------------------
# $CLAUDE_MEMORY_HOME/config.json is where a user's choices live, the same way
# ponytail uses ~/.config/ponytail/config.json and context-mode uses
# ~/.context-mode/platform.json. Env vars stay supported as overrides.
#
#   { "vault": "/path/to/vault", "recall": true, "model": "bge-m3" }
#
# Config in a file rather than in ~/.claude/settings.json `env` is the ecosystem
# convention, and it is also the robust choice: a file is read when the hook runs,
# so it does not depend on what a given process inherited or on when the value was
# written. Setting CLAUDE_VAULT in settings.local.json mid-session did NOT reach
# this session's hooks on 2026-08-15, and the SessionStart hook resolved to the
# default, built an empty vault there and repointed the memory symlink at it.
#
# Deliberately flat, and read with jq when available but sed otherwise: this file is
# sourced by every hook, and a fresh install must work before anything is installed.
config_file() { printf '%s' "$(memory_home)/config.json"; }

config_get() {
  _f=$(config_file)
  [ -f "$_f" ] || return 1
  if command -v jq >/dev/null 2>&1; then
    _v=$(jq -r --arg k "$1" '.[$k] // empty' "$_f" 2>/dev/null)
  else
    # sed -E, not basic regex: BSD sed (macOS) has no \| alternation, so the boolean
    # branch silently matched nothing and `recall` read as off with jq absent.
    _v=$(tr -d '\n' < "$_f" | sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p")
    [ -n "$_v" ] || _v=$(tr -d '\n' < "$_f" \
      | sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*(true|false).*/\1/p")
  fi
  [ -n "${_v:-}" ] || return 1
  printf '%s' "$_v"
}

# --- vault root ---------------------------------------------------------------
resolve_vault() {
  if [ -n "${CLAUDE_VAULT:-}" ]; then printf '%s' "$CLAUDE_VAULT"; return; fi
  _v=$(config_get vault) && [ -n "$_v" ] && { printf '%s' "$_v"; return; }
  printf '%s' "$HOME/Documents/ClaudeVault"
}

# Which source won — for /memory:doctor, so "wrong vault" is diagnosable.
vault_source() {
  if [ -n "${CLAUDE_VAULT:-}" ]; then printf 'CLAUDE_VAULT env'; return; fi
  _v=$(config_get vault) && [ -n "$_v" ] && { printf '%s' "$(config_file)"; return; }
  printf 'built-in default'
}

# --- per-prompt recall ---------------------------------------------------------
# Off unless explicitly armed: injecting into every prompt changes how every
# session reads, so it is the user's call, not a default.
recall_enabled() {
  [ "${MEMORY_RECALL_ENABLED:-}" = "1" ] && return 0
  [ "$(config_get recall 2>/dev/null)" = "true" ] && return 0
  return 1
}

# --- mutable state ------------------------------------------------------------
# Everything that changes lives here, NEVER inside the plugin: plugin caches are
# version-pinned (~/.claude/plugins/cache/<mp>/<plugin>/<version>/) and replaced
# wholesale on update, which would discard the indexes and re-download 722 MB of
# model weights every time.
#
#   db/      semantic-<slug>-<model>.db
#   models/  ONNX weights (transformers.js cache)
#   logs/    semantic-index.log, recall-<date>.jsonl, distill.log
#   run/     <slug>.sock  (resident search server)
#   eval/    eval-cases-*.jsonl  — contains vault content, never committed
memory_home() {
  printf '%s' "${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
}

# --- project key --------------------------------------------------------------
# Identifies the PROJECT, not the checkout path, so the same repo maps to one
# vault folder on every machine: /Users/henk/Development/Frontend and
# /Users/jane/code/Frontend both key to gitlab.example.com-team-frontend.
# Falls back to the repo dir name, then to the legacy cwd-slug for non-git dirs.
# Credentials embedded in a remote URL are stripped, never keyed on.
# --- project key cache -------------------------------------------------------
# `git remote get-url` forks, and that fork measured 40.2ms of vault-memory-sync.sh's 97.7ms —
# paid again by every other shell hook, every session. paths.mjs already caches the answer in
# $CLAUDE_MEMORY_HOME/cache/project-keys.json; this reads the SAME file so the shell side stops
# paying for what Node already resolved.
#
# Validation matches paths.mjs exactly: "<whole-second mtime>:<size>:<inode>" of the .git/config
# that decides the key, "0" when there is no repo at all, and no caching when .git is a FILE
# (worktree/submodule), where the real config lives somewhere this cheap walk cannot confirm.
#
# All three, because seconds alone leave a PERMANENT hole rather than a one-second one: a
# `git remote set-url` in the same second as the cached stamp is never noticed, since nothing
# touches .git/config again afterwards. paths.mjs's self-test caught exactly that. Size closes most
# of it and the inode closes the rest — git rewrites config atomically, so every write lands on a
# new inode even when mtime and byte length are identical.
#
# Every failure path falls through to computing the key for real, so the worst case is a fork —
# exactly what happened before this existed. jq only: it is already a hard requirement for hooks,
# and hand-parsing nested JSON with sed to save a fork would be a poor trade.
# Fork-free on purpose: `dirname` once per parent directory turned a cache lookup meant to AVOID a
# fork into four of them. Parameter expansion walks the path with no subprocesses at all.
_git_config_for() {
  case "$1" in /*) _p=$1 ;; *) _p="$PWD/$1" ;; esac
  _p=${_p%/}                                 # strip one trailing slash; "" means root
  while :; do
    if [ -e "${_p:-}/.git" ]; then
      [ -d "${_p:-}/.git" ] || return 1      # .git is a file -> worktree/submodule, not cacheable
      printf '%s' "${_p:-}/.git/config"; return 0
    fi
    [ -z "${_p:-}" ] && return 2             # reached root, no repo -> cacheable, stamp 0
    _p=${_p%/*}
  done
}

_stat_stamp() {
  stat -f '%m:%z:%i' "$1" 2>/dev/null || stat -c '%Y:%s:%i' "$1" 2>/dev/null
}

# Echoes the cached key, or returns non-zero if there is no usable cache entry.
project_key_cached() {
  command -v jq >/dev/null 2>&1 || return 1
  _cf="$(memory_home)/cache/project-keys.json"
  [ -f "$_cf" ] || return 1
  _cfg=$(_git_config_for "$1"); _rc=$?
  case "$_rc" in
    0) _want=$(_stat_stamp "$_cfg") || return 1 ;;
    2) _want=0 ;;
    *) return 1 ;;
  esac
  [ -n "$_want" ] || return 1
  _got=$(jq -r --arg d "$1" '.[$d] | if type == "object" then "\(.stamp)\t\(.key)" else empty end' \
    "$_cf" 2>/dev/null) || return 1
  [ -n "$_got" ] || return 1
  _stamp=${_got%%	*}; _key=${_got#*	}
  [ "$_stamp" = "$_want" ] && [ -n "$_key" ] || return 1
  printf '%s' "$_key"
}

project_key() {
  _d="${1:-$PWD}"
  _c=$(project_key_cached "$_d") && [ -n "$_c" ] && { printf '%s' "$_c"; return; }
  _url=$(git -C "$_d" remote get-url origin 2>/dev/null || true)
  if [ -n "$_url" ]; then
    _k=$(printf '%s' "$_url" \
      | sed -e 's#^[a-z+][a-z+]*://##' -e 's#^[^@/]*@##' -e 's#:#/#' \
            -e 's#\.git$##' -e 's#/*$##' \
      | tr 'A-Z' 'a-z' | sed 's#/#-#g')
    if [ -n "$_k" ]; then printf '%s' "$_k"; return; fi
  fi
  _top=$(git -C "$_d" rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$_top" ]; then basename "$_top" | tr 'A-Z' 'a-z' | tr -d '\n'; return; fi
  printf '%s' "$_d" | sed 's#/#-#g'
}

# The pre-2026-08-08 naming: absolute cwd with / -> -. Still needed to find and
# migrate existing vault folders, and it is what Claude Code names
# ~/.claude/projects/<slug>/ after.
legacy_key() { printf '%s' "${1:-$PWD}" | sed 's#/#-#g'; }
