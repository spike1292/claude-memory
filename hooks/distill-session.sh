#!/usr/bin/env bash
# Distill the session into vault Insights/ notes. Dual trigger:
#   - SessionEnd (primary): the authoritative once-per-session pass — always runs,
#     distilling the complete transcript. Keeps Insights signal-dense (no per-turn churn).
#   - Stop (crash fallback): runs mid-session ONLY for a long session (>400 msgs) and
#     at most every 2h, so a hard-killed long session loses <=2h of lessons. Normal
#     sessions never distill on Stop — they end via SessionEnd first.
# Detaches the extractor so exit is instant. Guards, in order:
#   - CLAUDE_DISTILL_CHILD set  -> we are inside the headless extractor; never recurse
#   - stop_hook_active          -> Stop-loop guard (absent on SessionEnd; harmless)
#   - no/absent transcript      -> nothing to do
#   - trivial session (<15 msgs)-> skip
#   - event/size/debounce gate  -> see below
set -euo pipefail

[ -n "${CLAUDE_DISTILL_CHILD:-}" ] && exit 0

input=$(cat)
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0

sid=$(printf '%s' "$input" | jq -r '.session_id // "nosession"')
tpath=$(printf '%s' "$input" | jq -r '.transcript_path // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty'); [ -z "$cwd" ] && cwd="$PWD"
event=$(printf '%s' "$input" | jq -r '.hook_event_name // empty')
{ [ -n "$tpath" ] && [ -f "$tpath" ]; } || exit 0

cache="$HOME/.cache/claude-distill"; mkdir -p "$cache"
marker="$cache/$sid.ts"; now=$(date +%s)
lines=$(wc -l < "$tpath")
[ "$lines" -lt 15 ] && exit 0
# SessionEnd always runs (authoritative). Stop is a crash fallback: only for a long
# session (>400 msgs) and at most every 2h — so normal sessions never distill mid-flight.
if [ "$event" != "SessionEnd" ]; then
  [ "$lines" -lt 400 ] && exit 0
  if [ -f "$marker" ]; then
    last=$(cat "$marker" 2>/dev/null || echo 0)
    [ $((now - last)) -lt 7200 ] && exit 0
  fi
fi
echo "$now" > "$marker"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v python3 >/dev/null 2>&1 || exit 0
nohup python3 "$here/distill-session.py" "$tpath" "$cwd" >>"$cache/distill.log" 2>&1 &
exit 0
