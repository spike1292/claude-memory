#!/usr/bin/env bash
# PostToolUse (Write|Edit|MultiEdit): check a vault note the moment it is written.
#
# Every other mechanism in this system runs at SessionStart or during an audit — hours or days after
# the write, when the author no longer has the context to fix it cheaply. This is the missing
# enforcement point, borrowed from obsidian-second-brain's validate-ai-first.sh, whose comment says
# it best: the vault holds its shape because every write is checked, not because a future session
# remembers all the conventions.
#
# WARNS ONLY — never blocks a write. A note half-written is still worth keeping; the point is to tell
# the author now rather than let an audit find it next week.
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/vault-env.sh"
VAULT=$(resolve_vault)

payload=$(cat 2>/dev/null || true)
file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)
[ -z "${file:-}" ] && exit 0
case "$file" in "$VAULT"/*) ;; *) exit 0 ;; esac   # only vault files
case "$file" in *.md) ;; *) exit 0 ;; esac
case "$file" in *"/REFLECTIONS.md"|*"/MEMORY.md"|*"/Logs/"*|*"/Graph/"*) exit 0 ;; esac  # operating surfaces, not notes
[ -f "$file" ] || exit 0

name=$(basename "$file" .md)
warn=()

# Frontmatter must open on line 1 and close — a missing fence silently voids every field below it.
if [ "$(head -1 "$file")" != "---" ]; then
  warn+=("no frontmatter fence on line 1 — every field below it is invisible to the tooling")
else
  fm=$(awk 'NR>1{if($0=="---"){exit} print}' "$file")
  printf '%s' "$fm" | grep -q $'\t' && warn+=("tab inside frontmatter — YAML needs spaces")
  case "$file" in
    "$VAULT"/Memory/*)
      printf '%s\n' "$fm" | grep -qE "^name:[[:space:]]*[\"']?${name}[\"']?[[:space:]]*$" \
        || warn+=("frontmatter name: must equal the filename (${name}) or [[wikilinks]] will not resolve")
      printf '%s\n' "$fm" | grep -qE "^[[:space:]]*confidence:[[:space:]]*(high|medium|low)" \
        || warn+=("no confidence: — /memory:health cannot pick a winner when two notes disagree")
      ;;
  esac
fi

# Everything after the closing frontmatter fence (whole file when there is none).
# BSD sed rejects the compact `1{/^---$/!q};1,/^---$/d` form, so use awk.
body=$(awk 'f{print; next} /^---$/{c++; if(c==2) f=1; next} c==0{print}' "$file")

# Retrievability: the alias line is the paraphrase bridge for keyword search. Measured 2026-08-14 —
# authored paraphrase questions reach the right note only ~46% of the time; aliases are part of why.
printf '%s' "$body" | grep -q '_Also asked as:' \
  || warn+=("no '_Also asked as:' line — add 2-3 paraphrases in an OUTSIDER's words, not the note's own jargon")

# A reversal announced only in prose is invisible to every check (see memory-audit-checks.mjs).
if printf '%s' "$body" | grep -qiE '(⚠ *)?\**(SUPERSEDED|superseded by|no longer true)' \
   && ! printf '%s' "$body" | grep -qiE 'superseded +[0-9]{4}-[0-9]{2}-[0-9]{2} +by +\[\['; then
  warn+=("says superseded in prose — mark the claim: (superseded YYYY-MM-DD by [[note]])")
fi

# Claim-level checks (CLAIM-1 metric provenance, FRESH-1 staleness, prose-only supersession) run
# from the tested predicates rather than being re-implemented in bash. This is the write-time half:
# an inflated recall figure once reached a public README *between* two audits, which an audit-only
# check cannot prevent.
audit="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../scripts/memory-audit-checks.mjs"
claims=""
command -v node >/dev/null 2>&1 && claims=$(node "$audit" --check-file "$file" 2>/dev/null || true)

# Suffix-path detection is deliberately NOT here. It needs the repo's full file list to decide, and
# an early version of this block silently never fired — a check that does not run is worse than no
# check, because it reads as coverage. `memory-audit-checks.mjs` does it vault-wide and is tested.

if [ ${#warn[@]} -eq 0 ] && [ -z "${claims:-}" ]; then exit 0; fi
printf 'note conventions — %s\n' "$name"
# bash 3.2 (macOS) errors on "${warn[@]}" when the array is empty under `set -u` — guard the expansion.
if [ ${#warn[@]} -gt 0 ]; then for w in "${warn[@]}"; do printf '  · %s\n' "$w"; done; fi
[ -n "${claims:-}" ] && printf '%s\n' "$claims"
exit 0
