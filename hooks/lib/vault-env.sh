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

# --- vault root ---------------------------------------------------------------
# Three sources, in order: the env var, a machine-local config FILE, the default.
#
# The config file is not redundant. `env` in ~/.claude/settings.local.json does NOT
# reach hook subprocesses (verified 2026-08-15 the hard way: with only the env var
# set, the SessionStart hook resolved to the default, built an empty vault there and
# repointed the memory symlink at it). A hook must be able to find the vault with no
# inherited environment at all, so the file is the load-bearing mechanism and the env
# var is the override.
#
#   echo "/path/to/vault" > "$(memory_home)/vault"     # what /memory:install writes
resolve_vault() {
  if [ -n "${CLAUDE_VAULT:-}" ]; then printf '%s' "$CLAUDE_VAULT"; return; fi
  _cfg="$(memory_home)/vault"
  if [ -f "$_cfg" ]; then
    _v=$(head -n1 "$_cfg" | tr -d '\r\n')
    if [ -n "$_v" ]; then printf '%s' "$_v"; return; fi
  fi
  printf '%s' "$HOME/Documents/ClaudeVault"
}

# Which of the three won — for /memory:doctor, so "wrong vault" is diagnosable.
vault_source() {
  if [ -n "${CLAUDE_VAULT:-}" ]; then printf 'CLAUDE_VAULT env'; return; fi
  _cfg="$(memory_home)/vault"
  if [ -f "$_cfg" ] && [ -n "$(head -n1 "$_cfg" | tr -d '\r\n')" ]; then
    printf '%s' "$_cfg"; return
  fi
  printf 'built-in default'
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
project_key() {
  _d="${1:-$PWD}"
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
