#!/usr/bin/env bash
# Prepare a release: bump the version everywhere, close the changelog's Unreleased section,
# and open the PR. Merging that PR is the whole release — .github/workflows/release.yml sees a
# version on main with no release yet, creates the tag and publishes the notes from CHANGELOG.md.
#
#   scripts/release.sh          # version derived from the conventional commits since the last tag
#   scripts/release.sh 0.1.4    # or state it outright
#
# ponytail: sed over four known JSON fields rather than a bump tool. `npm version` only knows
# package.json, and the other three are what Claude Code actually reads.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- version -------------------------------------------------------------------
# Derived from the conventional commits since the last release, so the number is a consequence of
# the work rather than a judgement call. Pass one explicitly to override.
#
# 0.x rule: a breaking change bumps the MINOR, per semver's "anything may change" for 0.x. That is
# also what this project's changelog means by breaking — config keys, command names, vault layout,
# $CLAUDE_MEMORY_HOME, or anything that forces a re-index or moves a note.
#
# NOT release-please or semantic-release, deliberately. Those generate the changelog from commit
# subjects, and here the changelog IS the release notes — hand-written, and the only place the
# reasoning is recorded. Deriving the number is useful; generating the prose would be a downgrade.
next_version() {
  _cur="${1:-$(jq -r .version package.json)}"
  _last=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
  _range="${_last:+$_last..}HEAD"
  _subjects=$(git log --format='%s' "$_range" 2>/dev/null || true)
  _bodies=$(git log --format='%B' "$_range" 2>/dev/null || true)

  _major=${_cur%%.*}; _rest=${_cur#*.}; _minor=${_rest%%.*}; _patch=${_rest#*.}
  if printf '%s\n' "$_subjects" | grep -qE '^[a-z]+(\([^)]*\))?!:' \
     || printf '%s\n' "$_bodies" | grep -q 'BREAKING CHANGE'; then
    _why='a breaking change'; _bump=minor          # 0.x: breaking bumps the minor
  elif printf '%s\n' "$_subjects" | grep -qE '^feat(\([^)]*\))?:'; then
    _why='a feat'; _bump=minor
  else
    _why='fixes and chores only'; _bump=patch
  fi
  case "$_bump" in
    minor) _next="$_major.$((_minor + 1)).0" ;;
    patch) _next="$_major.$_minor.$((_patch + 1))" ;;
  esac
  printf '%s\t%s\t%s\t%s' "$_next" "$_why" "${_last:-<no tag>}" \
    "$(printf '%s\n' "$_subjects" | grep -c . || true)"
}

# --- selftest ------------------------------------------------------------------
# next_version branches on commit shape, and a wrong branch silently ships the wrong number.
# `scripts/release.sh --selftest` builds throwaway repos and checks each path.
if [ "${1:-}" = "--selftest" ]; then
  _t=$(mktemp -d); _fails=0
  _case() { # <expected> <current> <commit subjects...>
    _want=$1; _cur=$2; shift 2
    rm -rf "$_t/r"; mkdir -p "$_t/r"
    ( cd "$_t/r"
      git init -q .; git config user.email t@t; git config user.name t
      git commit -q --allow-empty -m 'chore: base'
      git tag v"$_cur"
      for _s in "$@"; do git commit -q --allow-empty -m "$_s"; done )
    _got=$( cd "$_t/r" && next_version "$_cur" | cut -f1 )
    if [ "$_got" = "$_want" ]; then printf '  ok   %-8s <- %s\n' "$_got" "$*"
    else printf '  FAIL want %s got %s <- %s\n' "$_want" "$_got" "$*"; _fails=$((_fails+1)); fi
  }
  _case 0.2.1 0.2.0 'fix: a thing'
  _case 0.2.1 0.2.0 'chore: tidy' 'docs: words'
  _case 0.2.1 0.2.0 'perf: faster'                       # perf is not a feature
  _case 0.3.0 0.2.0 'feat: a thing'
  _case 0.3.0 0.2.0 'fix: a thing' 'feat(scope): another'  # any feat wins over fixes
  _case 0.3.0 0.2.0 'feat!: breaking'                     # 0.x: breaking bumps the minor
  _case 0.3.0 0.2.0 'refactor(core)!: breaking'
  _case 0.2.1 0.2.0 'fix: mentions feat: in the subject text'   # must anchor at the start
  _case 1.3.0 1.2.9 'feat: ten to eleven'
  _case 0.2.11 0.2.10 'fix: two-digit patch'              # string vs number bumping
  rm -rf "$_t"
  [ "$_fails" -eq 0 ] && { echo "selftest: 10 cases passed"; exit 0; }
  echo "selftest: $_fails case(s) failed"; exit 1
fi

V="${1:-}"
if [ -z "$V" ]; then
  IFS='	' read -r V _why _since _count <<EOF
$(next_version)
EOF
  echo "version derived from $_count commit(s) since $_since: $_why -> $V"
  echo "(pass a version explicitly to override)"
  echo
fi
case "$V" in
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
  --body "Version bump to \`$V\` and changelog.

**Merging this publishes the release.** \`.github/workflows/release.yml\` sees a version on
\`main\` with no release yet, creates the \`v$V\` tag and publishes the \`[$V]\` section of
CHANGELOG.md as the notes. Nothing to tag by hand."

cat <<EOF

Prepared $V. Merging the PR publishes it — release.yml creates the v$V tag and
publishes the [$V] section of CHANGELOG.md as the release notes.

Nothing else to run.
EOF
