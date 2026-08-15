#!/usr/bin/env bash
# SessionStart: name the L1 notes that are reachable only from the MOC.
#
# The "≥2 wikilinks, linked both ways" convention is documented in CLAUDE.md, but prose did not
# hold it: /memory:health found MOC-only notes in three consecutive audits (2026-08-07 four notes,
# 2026-08-08 jira-zscaler-403, 2026-08-08 prod-error-baseline). REFLECTIONS.md committed to a lint
# on the third recurrence. This is it.
#
# MOC-only is not corruption — the note is findable. It is invisible to the note graph, so nothing
# leads you to it while reading a sibling. Reporting it at session start is what makes it fixable.
# ponytail: names only, no auto-fix — deciding WHICH sibling should link is the judgement call.
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/vault-env.sh"
VAULT=$(resolve_vault)
cwd=$(cat | jq -r '.cwd // empty' 2>/dev/null || true)
[ -z "${cwd:-}" ] && cwd="$PWD"
slug=$(project_key "$cwd")
mem="$VAULT/Memory/$slug"
[ -d "$mem" ] || { slug=$(legacy_key "$cwd"); mem="$VAULT/Memory/$slug"; }
[ -d "$mem" ] || exit 0

ins="$VAULT/Insights/$slug"
orphans=""
for f in "$mem"/*.md; do
  [ -e "$f" ] || continue
  n=$(basename "$f" .md)
  [ "$n" = "MEMORY" ] && continue
  # Inbound = [[n]] or [[n|alias]] / [[n#heading]] in any note EXCEPT the MOC and the note itself.
  if ! grep -rlF --include='*.md' -e "[[$n]]" -e "[[$n|" -e "[[$n#" "$mem" "$ins" 2>/dev/null \
       | grep -qv -e "^$mem/MEMORY.md$" -e "^$f$"; then
    orphans="$orphans $n"
  fi
done

if [ -n "$orphans" ]; then
  echo "MOC-only memory notes (in MEMORY.md but no inbound [[wikilink]] from any sibling — the note"
  echo "graph cannot reach them). Link each from a note someone would be reading when they need it:"
  for n in $orphans; do echo "  - $n"; done
fi

# --- figure drift: a bolded number in a MOC hook that its target note does not contain ----------
# MOC hooks restate figures, then the note body moves and the hook does not. /memory:health caught
# this in four consecutive audits (2026-08-07 core-modules kernel, 2026-08-08 reversed p99,
# 2026-08-10 hyperhub 51->25-vs-28 AND verify-before-claiming "nine" against an 11-item list).
# The link check above proves a mechanical check beats another round of prose.
# ponytail: bolded numbers only — unbolded prose numbers are too noisy to gate on.
moc="$mem/MEMORY.md"
[ -f "$moc" ] || exit 0
drift=""
while IFS= read -r line; do
  case "$line" in '- [['*) ;; *) continue ;; esac
  target=${line#- [[}; target=${target%%]]*}
  note="$mem/$target.md"
  [ -f "$note" ] || continue
  # digits inside **bold** spans, commas stripped, ≥2 digits (single digits are noise)
  nums=$(printf '%s\n' "$line" | grep -o '\*\*[^*]*\*\*' | tr -d ',' \
         | grep -oE '[0-9]{2,}' | sort -u || true)
  [ -z "$nums" ] && continue
  body=$(tr -d ',' < "$note")
  for n in $nums; do
    printf '%s' "$body" | grep -qF "$n" || drift="$drift$target|$n"$'\n'
  done
done < "$moc"

if [ -n "$drift" ]; then
  echo
  echo "MEMORY.md figure drift — a bolded number in the MOC hook is absent from the note it points"
  echo "at. Usually the note was corrected and the hook was not. Check the note, then fix the hook:"
  printf '%s' "$drift" | while IFS='|' read -r t n; do
    [ -n "$t" ] && echo "  - [[$t]] hook says $n, not found in the note"
  done
fi
