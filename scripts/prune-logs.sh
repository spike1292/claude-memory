#!/usr/bin/env bash
# Archive session logs older than N days (default 90) into <logs-dir>/Archive/.
# Dates come from the filename (YYYY-MM-DD-*.md), not mtime — Synology sync churns mtime.
# Moving only (reversible); never deletes. Usage: prune-logs.sh <logs-dir>
set -euo pipefail
DAYS=${PRUNE_DAYS:-90}
dir="${1:?usage: prune-logs.sh <logs-dir>}"
[ -d "$dir" ] || { echo "no logs dir: $dir"; exit 0; }

now=$(date +%s)
cutoff=$((now - DAYS * 86400))
moved=0
mkdir -p "$dir/Archive"
shopt -s nullglob
for f in "$dir"/*.md; do
  base=$(basename "$f")
  d=${base:0:10}
  case "$d" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) continue ;; esac
  fe=$(date -j -f "%Y-%m-%d" "$d" +%s 2>/dev/null || date -d "$d" +%s 2>/dev/null || echo 0)
  if [ "$fe" -gt 0 ] && [ "$fe" -lt "$cutoff" ]; then
    mv "$f" "$dir/Archive/"
    moved=$((moved + 1))
  fi
done
echo "archived $moved log(s) older than ${DAYS}d from $dir"
