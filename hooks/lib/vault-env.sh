#!/usr/bin/env bash
# Shared vault resolution, project key, and state dir, for the two shell files that remain:
# hooks/vault-memory-sync.sh and scripts/doctor.sh.
#
#   . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/vault-env.sh"
#   VAULT=$(resolve_vault); key=$(project_key "$cwd"); HOME_DIR=$(memory_home)
#
# THIS FILE NO LONGER RESOLVES ANYTHING. It asks Node and caches the answer.
#
# Until 2026-08-18 it was the source of truth and hooks/lib/paths.mjs mirrored it — two
# implementations of one set of rules, kept in step by a comment and by paths.mjs forking bash so
# that project_key at least had a single implementation. That bargain cost a fork on the Node side
# and ~110 lines of duplicated resolution on this one. Node resolves now; this asks.
#
# One `node` call answers everything below, so a caller pays one fork rather than a source plus a
# jq read plus a git fork. Resolve relative to this file, never to an absolute install path: the
# plugin runs from a version-pinned cache dir, from a dev checkout, and via symlink.

_memory_env_dir=""      # which directory the cached answer is for
MEMORY_ENV_DEGRADED=0   # 1 when Node could not be asked; see the fallback below

# Where this file is, resolved once at source time.
#
# BASH_SOURCE is bash-only. The two shell files that source this are bash, but
# every commands/*.md tells the agent to source it too — and an agent's Bash
# tool may be zsh, where BASH_SOURCE is unset. `dirname ""` is then `.`, the
# env.mjs path misses, and _memory_env_load falls into DEGRADED: no config.json,
# so the vault silently becomes ~/Documents/ClaudeVault and the project key
# becomes a cwd-slug. That is the exact failure mode the vault resolution is
# built to prevent, arriving through the command surface instead of a hook.
#
# ${(%):-%x} is zsh's equivalent, kept inside eval so bash never parses it.
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  _memory_env_self="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
  eval '_memory_env_self="${(%):-%x}"'
else
  _memory_env_self="$0"
fi

# Ask Node once per directory. Callers use a single cwd each, so this is one fork per script.
_memory_env_load() {
  _d="${1:-$PWD}"
  [ "${_memory_env_dir:-}" = "$_d" ] && return 0
  _root="$(cd "$(dirname "$_memory_env_self")/../.." && pwd)"
  _entry="$_root/scripts/env.mjs"

  if command -v node >/dev/null 2>&1 && [ -f "$_entry" ]; then
    if _out=$(node "$_entry" "$_d" 2>/dev/null) && [ -n "$_out" ]; then
      eval "$_out"                       # values are single-quoted by shellQuote(); safe to eval
      MEMORY_ENV_DEGRADED=0
      _memory_env_dir="$_d"
      return 0
    fi
  fi

  # DEGRADED: no Node, or it failed. Environment variables and built-in defaults only — no
  # config.json, no git. This is not a second implementation of the rules; it is the minimum that
  # lets /memory:doctor run far enough to report WHY nothing works, which is the one job that
  # cannot be delegated to the runtime being diagnosed.
  MEMORY_ENV_VAULT="${CLAUDE_VAULT:-$HOME/Documents/ClaudeVault}"
  MEMORY_ENV_VAULT_SOURCE="${CLAUDE_VAULT:+CLAUDE_VAULT env}"
  MEMORY_ENV_VAULT_SOURCE="${MEMORY_ENV_VAULT_SOURCE:-built-in default (node unavailable)}"
  MEMORY_ENV_HOME="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
  # The legacy cwd-slug, deliberately: it is also the pre-migration folder name, so a fallback
  # lands somewhere vault-memory-sync.sh already knows how to migrate rather than on a new name.
  MEMORY_ENV_LEGACY_KEY=$(printf '%s' "$_d" | sed 's#/#-#g')
  MEMORY_ENV_PROJECT_KEY="$MEMORY_ENV_LEGACY_KEY"
  MEMORY_ENV_RECALL=$([ "${MEMORY_RECALL_ENABLED:-}" = "1" ] && printf 1 || printf 0)
  MEMORY_ENV_RECALL_CONFIG=""
  MEMORY_ENV_MODEL=""
  # Left EMPTY on purpose: repeating the 30-day default here would be a second place it
  # lives. A caller prints "?" and the report already says node could not be asked.
  MEMORY_ENV_LOG_RETENTION_DAYS=""
  MEMORY_ENV_DEGRADED=1
  _memory_env_dir="$_d"
}

# --- public interface ---------------------------------------------------------
# Same names and same output as before the migration, so callers did not change.

config_file() { printf '%s' "$(memory_home)/config.json"; }
log_retention_days() { _memory_env_load "$PWD"; printf '%s' "$MEMORY_ENV_LOG_RETENTION_DAYS"; }

resolve_vault() { _memory_env_load "$PWD"; printf '%s' "$MEMORY_ENV_VAULT"; }
vault_source()  { _memory_env_load "$PWD"; printf '%s' "$MEMORY_ENV_VAULT_SOURCE"; }
memory_home()   { _memory_env_load "$PWD"; printf '%s' "$MEMORY_ENV_HOME"; }
project_key()   { _memory_env_load "${1:-$PWD}"; printf '%s' "$MEMORY_ENV_PROJECT_KEY"; }
legacy_key()    { _memory_env_load "${1:-$PWD}"; printf '%s' "$MEMORY_ENV_LEGACY_KEY"; }

# Off unless explicitly armed: injecting into every prompt changes how every session reads, so it
# is the user's call, not a default. Exit status, not output — callers use it in `if`.
recall_enabled() { _memory_env_load "$PWD"; [ "$MEMORY_ENV_RECALL" = "1" ]; }

# What config.json itself says, as distinct from the effective value — /memory:doctor tells the
# two apart so it can warn that an env-only arming does not survive a mid-session write.
recall_config()  { _memory_env_load "$PWD"; printf '%s' "$MEMORY_ENV_RECALL_CONFIG"; }

# Load eagerly, in the PARENT shell, at source time.
#
# Not an optimisation — a correctness requirement. Every accessor above is called as `$(...)`, which
# runs in a subshell, so a load performed there sets variables that die with it and the next call
# forks node again. Loading here means the accessors read variables that are already set, and both
# callers pay exactly one fork.
#
# A caller that needs a DIFFERENT directory (vault-memory-sync.sh takes cwd from the hook payload)
# must call `_memory_env_load "$that_dir"` itself, in its own shell, before using the accessors.
_memory_env_load "$PWD"
