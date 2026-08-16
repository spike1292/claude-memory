#!/usr/bin/env bash
# Prepare a release: bump the version everywhere, close the changelog's Unreleased section,
# and open the PR. It does NOT tag — main is protected, so the version has to land through a
# PR first and the tag must point at the merge commit. The script prints that second step.
#
#   scripts/release.sh 0.1.4
#
# ponytail: sed over four known JSON fields rather than a bump tool. `npm version` only knows
# package.json, and the other three are what Claude Code actually reads.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

V="${1:-}"
case "$V" in
  '' ) echo "usage: scripts/release.sh <version>   e.g. 0.1.4"; exit 1 ;;
  v* ) echo "give the version without the leading v: ${V#v}"; exit 1 ;;
  [0-9]*.[0-9]*.[0-9]* ) ;;
  *  ) echo "not a semver version: $V"; exit 1 ;;
esac

# --- preconditions -------------------------------------------------------------
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty"; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "release from main"; exit 1; }
git fetch --quiet origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || {
  echo "main is not level with origin/main"; exit 1; }
git rev-parse -q --verify "refs/tags/v$V" >/dev/null && { echo "tag v$V already exists"; exit 1; }

CUR=$(jq -r .version package.json)
[ "$V" != "$CUR" ] || { echo "already at $V"; exit 1; }

# The Unreleased section must have something in it, or the release notes come out empty.
grep -q '^## \[Unreleased\]' CHANGELOG.md || { echo "CHANGELOG.md has no [Unreleased] section"; exit 1; }
awk '/^## \[Unreleased\]/{on=1;next} on&&/^## \[/{exit} on&&NF{found=1} END{exit !found}' CHANGELOG.md \
  || { echo "[Unreleased] is empty — write the changelog entry first"; exit 1; }

# --- bump ----------------------------------------------------------------------
# Field-scoped: package.json's "version" is at top level, and plugin.json's likewise, so a
# line-anchored match on the first occurrence is enough. marketplace.json carries two.
bump() { # <file> <jq-path>
  local f=$1 q=$2 tmp
  tmp=$(mktemp)
  jq --arg v "$V" "$q = \$v" "$f" > "$tmp" && mv "$tmp" "$f"
}
bump package.json '.version'
bump .claude-plugin/plugin.json '.version'
bump .claude-plugin/marketplace.json '.metadata.version'
bump .claude-plugin/marketplace.json '.plugins[0].version'

# package-lock.json names the version twice (root package + the "" entry).
if [ -f package-lock.json ]; then
  tmp=$(mktemp)
  jq --arg v "$V" '.version = $v | .packages[""].version = $v' package-lock.json > "$tmp" \
    && mv "$tmp" package-lock.json
fi

# --- changelog -----------------------------------------------------------------
DATE=$(date +%Y-%m-%d)
tmp=$(mktemp)
awk -v v="$V" -v d="$DATE" '
  /^## \[Unreleased\]/ && !done {
    print "## [Unreleased]"; print ""; print "## [" v "] - " d
    done = 1; next
  }
  { print }
' CHANGELOG.md > "$tmp" && mv "$tmp" CHANGELOG.md

# Rewrite the two link refs at the bottom: Unreleased now compares against the new tag.
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
tmp=$(mktemp)
awk -v v="$V" -v cur="$CUR" -v repo="$REPO" '
  /^\[Unreleased\]:/ {
    print "[Unreleased]: https://github.com/" repo "/compare/v" v "...HEAD"
    print "[" v "]: https://github.com/" repo "/compare/v" cur "...v" v
    next
  }
  { print }
' CHANGELOG.md > "$tmp" && mv "$tmp" CHANGELOG.md

# --- PR ------------------------------------------------------------------------
BRANCH="release/v$V"
git switch -c "$BRANCH"
git add -A
git commit -m "chore(release): $V" -m "$(awk -v v="$V" '
  $0 ~ "^## \\[" v "\\]" {on=1; next} on && /^## \[/ {exit} on {print}' CHANGELOG.md)"
git push -u origin "$BRANCH"
gh pr create --base main --head "$BRANCH" --title "chore(release): $V" \
  --body "Version bump to \`$V\` and changelog. Merge, then tag the merge commit to publish:

\`\`\`
git switch main && git pull
git tag v$V && git push origin v$V
\`\`\`"

cat <<EOF

Prepared $V. After the PR is merged:

  git switch main && git pull
  git tag v$V && git push origin v$V

The tag triggers .github/workflows/release.yml, which publishes the release with the
[$V] section of CHANGELOG.md as its notes.
EOF
