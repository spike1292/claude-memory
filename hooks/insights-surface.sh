#!/usr/bin/env bash
# SessionStart: surface recent L3 Mistakes titles so past errors actually reach context.
# The vault Insights layer is write-heavy but not auto-loaded (unlike MEMORY.md); this closes
# the gap. Titles only — cheap; full lessons stay in the vault / via /memory:health.
# ponytail: no bodies, capped at 15, silent when there's nothing.
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/vault-env.sh"
VAULT=$(resolve_vault)
cwd=$(cat | jq -r '.cwd // empty' 2>/dev/null || true)
[ -z "${cwd:-}" ] && cwd="$PWD"
slug=$(project_key "$cwd")
dir="$VAULT/Insights/$slug/Mistakes"
# Tolerate a not-yet-migrated vault: vault-memory-sync.sh performs the rename, but
# SessionStart hook order isn't guaranteed, so fall back for this one session.
[ -d "$dir" ] || { slug=$(legacy_key "$cwd"); dir="$VAULT/Insights/$slug/Mistakes"; }

[ -d "$dir" ] || exit 0
n=$(ls -1 "$dir"/*.md 2>/dev/null | wc -l | tr -d ' ')
[ "$n" -eq 0 ] && exit 0

echo "Past mistakes for this project (L3 memory — avoid repeating; full lessons in Insights/$slug/Mistakes/ or via /memory:health):"
ls -1 "$dir"/*.md 2>/dev/null | sort -r | head -15 | while read -r f; do
  t=$(grep -m1 '^title:' "$f" | sed 's/^title: *//')
  [ -z "$t" ] && t=$(basename "$f" .md | sed 's/^[0-9-]*//; s/-/ /g')
  echo "- $t"
done
[ "$n" -gt 15 ] && echo "(+$((n - 15)) older)"
exit 0
