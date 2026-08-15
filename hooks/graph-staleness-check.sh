#!/usr/bin/env bash
# SessionStart: if a GRAPH_REPORT exists but the repo has commits newer than it,
# regenerate it in the background via a detached headless `claude` run, and tell
# the user. Zero repo footprint — replaces per-repo git post-commit hooks.
#
# Guards (mirrors distill-session.sh):
#   - CBM_GRAPHGEN_CHILD set  -> we ARE the background run; never recurse
#   - no report yet           -> stay silent (never auto-generate the first one)
#   - not a git work tree     -> nothing to compare against
#   - report >= HEAD          -> fresh, nothing to do
#   - debounce 24h/repo       -> don't respawn every session while stale
#   - claude CLI missing      -> fall back to a manual-run nudge
# Full index mode preserves clone/semantic edges; 24h debounce caps the cost of
# an otherwise heavy (minutes of CPU) unattended run.
set -euo pipefail

# The background run triggers SessionStart too — bail immediately if that's us.
[ -n "${CBM_GRAPHGEN_CHILD:-}" ] && exit 0

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/vault-env.sh"
VAULT=$(resolve_vault)
DEBOUNCE=86400   # 24h

cwd=$(cat | jq -r '.cwd // empty' 2>/dev/null || true)
[ -z "${cwd:-}" ] && cwd="$PWD"
slug=$(project_key "$cwd")
report="$VAULT/Graph/$slug/GRAPH_REPORT.md"
# Pre-migration fallback (see insights-surface.sh).
[ -f "$report" ] || { slug=$(legacy_key "$cwd"); report="$VAULT/Graph/$slug/GRAPH_REPORT.md"; }

[ -f "$report" ] || exit 0
git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Staleness by RECORDED COMMIT, not mtime: the vault syncs via Synology CloudStorage,
# where file mtimes are unreliable (sync sets them, not the write). The report's YAML
# frontmatter records the commit it was generated at; compare that to current HEAD.
recorded=$(grep -m1 '^commit:' "$report" 2>/dev/null | awk '{print $2}')
[ -z "$recorded" ] && exit 0          # no recorded sha -> can't judge -> stay silent
head=$(git -C "$cwd" rev-parse HEAD 2>/dev/null || echo "")
[ -z "$head" ] && exit 0
# Fresh if HEAD begins with the recorded (short) sha.
case "$head" in "$recorded"*) exit 0 ;; esac
# else: HEAD moved since the report -> stale, fall through

nudge() { printf '{"systemMessage":"Graph report is stale (commits newer than the report) — run /memory:graph-report to refresh."}\n'; }

# Debounce: don't respawn while a recent run is still settling / already done today.
cache="$HOME/.cache/claude-graphgen"; mkdir -p "$cache"
marker="$cache/$slug.ts"; now=$(date +%s)
if [ -f "$marker" ]; then
  last=$(cat "$marker" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$DEBOUNCE" ]; then nudge; exit 0; fi
fi

# Locate the claude CLI (same candidates distill-session.py probes).
claude=""
for cand in "$(command -v claude 2>/dev/null || true)" \
            "$HOME/.claude/local/claude" \
            "/opt/homebrew/bin/claude" \
            "/usr/local/bin/claude"; do
  [ -n "$cand" ] && [ -x "$cand" ] && { claude="$cand"; break; }
done
[ -z "$claude" ] && { nudge; exit 0; }

echo "$now" > "$marker"

# Detached headless regen. Runs the skill with a full re-index to preserve
# clone/semantic edges. --dangerously-skip-permissions: headless run must call
# MCP tools + Write with no prompt.
prompt="/memory:graph-report This is an automated background refresh — re-index in full mode (index_repository mode='full') so similarity/semantic edges are preserved."
nohup env CBM_GRAPHGEN_CHILD=1 "$claude" -p "$prompt" \
  --permission-mode acceptEdits --dangerously-skip-permissions \
  >>"$cache/graphgen.log" 2>&1 &

printf '{"systemMessage":"Graph report is stale — regenerating in the background (full re-index, takes a few minutes). It will be current for your next session."}\n'
exit 0
