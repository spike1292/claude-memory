#!/usr/bin/env bash
# Enforce: every project's auto-memory dir lives in the Obsidian vault (per-project subfolder),
# and the global ~/.claude/CLAUDE.md lives there too. Idempotent; safe to run every SessionStart.
# ponytail: only moves regular files when repointing — memory dirs hold .md files, not subdirs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib/vault-env.sh"
VAULT=$(resolve_vault)

# Breadcrumb so /memory:* commands can find the plugin. ${CLAUDE_PLUGIN_ROOT} is only
# guaranteed inside hooks.json command strings; a command body running in the Bash tool
# may not have it. This file is the fallback, rewritten every session so a /plugin update
# to a new version dir cannot leave it stale.
MEM_HOME=$(memory_home); mkdir -p "$MEM_HOME"
printf '%s' "$(cd "$HERE/.." && pwd)" > "$MEM_HOME/plugin-root"

# One-time migration off the two marker files that 0.1.1/0.1.2 briefly used, before
# settling on one config.json like every other plugin. Runs first in the session, so
# later hooks read the merged result.
if [ ! -f "$MEM_HOME/config.json" ] && { [ -f "$MEM_HOME/vault" ] || [ -f "$MEM_HOME/recall-enabled" ]; }; then
  _mv=$(head -n1 "$MEM_HOME/vault" 2>/dev/null | tr -d '\r\n')
  _mr=false; [ -f "$MEM_HOME/recall-enabled" ] && _mr=true
  {
    printf '{\n'
    [ -n "$_mv" ] && printf '  "vault": "%s",\n' "$_mv"
    printf '  "recall": %s\n}\n' "$_mr"
  } > "$MEM_HOME/config.json"
  rm -f "$MEM_HOME/vault" "$MEM_HOME/recall-enabled"
fi

cwd=$(cat | jq -r '.cwd // empty' 2>/dev/null || true)
[ -z "${cwd:-}" ] && cwd="$PWD"

# Two different names, deliberately:
#   slug = cwd with / -> -   : Claude Code owns ~/.claude/projects/<slug>/, we can't rename it.
#   key  = git remote ident  : the vault folder, stable across machines and checkout paths.
slug=$(legacy_key "$cwd")
key=$(project_key "$cwd")

mem="$HOME/.claude/projects/$slug/memory"
dest="$VAULT/Memory/$key"

# One-time migration off the old cwd-slug vault naming (pre-2026-08-08). Only moves
# when the destination is free — never merges two folders behind your back.
if [ "$slug" != "$key" ]; then
  for layer in Memory Logs Insights Graph; do
    old="$VAULT/$layer/$slug"
    new="$VAULT/$layer/$key"
    if [ -d "$old" ] && [ ! -e "$new" ]; then
      mkdir -p "$(dirname "$new")"
      mv "$old" "$new"
    fi
  done
fi

# Per-project vault subfolders for every memory layer (idempotent).
mkdir -p "$dest" \
  "$VAULT/Logs/$key" \
  "$VAULT/Insights/$key/Patterns" \
  "$VAULT/Insights/$key/Mistakes" \
  "$VAULT/Insights/$key/Decisions" \
  "$VAULT/Graph/$key" \
  "$VAULT/permanent"

if [ -L "$mem" ]; then
  # already a symlink — repoint if it targets the wrong place.
  cur=$(readlink "$mem")
  if [ "$cur" != "$dest" ]; then
    # COPY, never move. The old target is a populated vault; $dest may live under a
    # completely different root (e.g. someone testing with CLAUDE_VAULT=/tmp/...).
    # Moving there and then discarding that root destroys L1 memory — it did exactly
    # that on 2026-08-08, costing 24 notes that only a backup got back. A stray
    # duplicate is recoverable; a move is not.
    [ -d "$cur" ] && find "$cur" -maxdepth 1 -type f -exec cp -n {} "$dest"/ \;
    rm "$mem"; ln -s "$dest" "$mem"
  fi
elif [ -d "$mem" ]; then
  # real dir Claude already created — migrate contents, replace with symlink
  find "$mem" -maxdepth 1 -type f -exec mv -n {} "$dest"/ \;
  rmdir "$mem" 2>/dev/null || rm -rf "$mem"
  ln -s "$dest" "$mem"
else
  mkdir -p "$(dirname "$mem")"
  ln -s "$dest" "$mem"
fi

# --- Config lives in git (~/.claude), NOT in the vault -------------------------
# Direction was inverted 2026-08-08: ~/.claude is a git repo (github spike1292/claude),
# so committing CLAUDE.md and commands/ as symlinks-into-the-vault shipped dangling
# links to every clone. Real files now live here; the vault gets a link back.
#
# Symlink rule learned the hard way: a link *into* the vault is fine (the memory-dir
# link above), but a link *inside* the vault is not — Synology Drive silently replaces
# directory symlinks with empty dirs. File symlinks survive. So CLAUDE.md gets a vault
# link (for Obsidian) and commands/ does not.

# CLAUDE.md: real file in the repo; migrate back if an old-layout symlink is found.
gc="$HOME/.claude/CLAUDE.md"
if [ -L "$gc" ]; then
  tgt=$(readlink "$gc")
  if [ -f "$tgt" ]; then rm "$gc"; cp "$tgt" "$gc"; fi   # vault copy -> real repo file
fi
# Vault-side convenience link (recreate if Synology clobbered or dropped it).
if [ -f "$gc" ] && [ "$(readlink "$VAULT/CLAUDE.md" 2>/dev/null)" != "$gc" ]; then
  [ -d "$VAULT/CLAUDE.md" ] && rmdir "$VAULT/CLAUDE.md" 2>/dev/null || true
  [ -f "$VAULT/CLAUDE.md" ] && [ ! -L "$VAULT/CLAUDE.md" ] && mv -n "$VAULT/CLAUDE.md" "$VAULT/CLAUDE.md.bak" || true
  rm -f "$VAULT/CLAUDE.md"; ln -s "$gc" "$VAULT/CLAUDE.md"
fi

# Drop the empty stub Synology leaves behind. The commands themselves ship inside this
# plugin now, so there is nothing in ~/.claude/commands/memory left to migrate.
rmdir "$VAULT/Commands/memory" 2>/dev/null || true
rmdir "$VAULT/Commands" 2>/dev/null || true

# The vault re-index (SessionEnd distiller) needs the context-mode CLI. It resolves out of an
# fnm/nvm multishell dir, so switching Node versions silently drops it from PATH and the vault
# quietly stops being searchable. Warn here — distill.log is not somewhere anyone looks.
# Silent when present, so this costs nothing in the normal case.
command -v context-mode >/dev/null 2>&1 || cat <<'WARN'
⚠ context-mode CLI not on PATH — the vault re-index at SessionEnd will be SKIPPED, so
  ctx_search results will drift behind the notes on disk. This usually means a Node version
  switch (fnm/nvm) dropped the global install.
  Fix: npm i -g context-mode     then: /memory:prune  (to catch up what was missed)
WARN

# --- standing retrieval rules --------------------------------------------------
# A plugin cannot append to CLAUDE.md, and these three rules change behaviour in the moment
# rather than when a note is written — so they go in the session context, not in the on-demand
# /memory:protocol skill. Kept to ~15 lines: this is paid every session.
cat <<CTX

# Memory (plugin: $(cd "$HERE/.." && pwd))

Layers in the vault: L1 facts \`Memory/$key/\` · L2 logs \`Logs/$key/\` · L3 lessons
\`Insights/$key/{Patterns,Mistakes,Decisions}/\` · L4 graph \`Graph/$key/\` · cross-project \`permanent/\`.

**Retrieval — \`$(cd "$HERE/.." && pwd)/scripts/memory-semantic.mjs --query "..." [-k 5]\` is the tool.**
It runs vector + keyword arms and rank-fuses them, so it wins on described-not-named questions AND
on identifiers. Local embeddings, so private notes never leave the machine.

1. **Expand the query into domain vocabulary first — the single biggest recall lever.** The lexical
   arm is keyword-only: "firewall" never matches \`WAF\`, "short outage" never matches \`cutover\`, and
   generic words are weighted to nothing. Do not search the user's phrasing verbatim; restate it as
   the terms the answer would be written in, and search both.
2. **Do NOT pass \`--layer\` to narrow results.** It filters the note set instead of re-ranking it,
   deleting gold answers that live in another layer. Measured: EN recall@5 67.9% → 53.6%.
3. **Scope \`ctx_search\` to the layer you want** — unscoped, it is Insights-dominated (many small
   dense notes outrank few large ones). Project facts → \`vault-memory-<repo>\`; "have I hit this
   before" → \`vault-insights-<repo>\`. Answer an L1 miss by scoping, not by piling on aliases.

Writing or auditing a note? Load the \`/memory:protocol\` skill first — filename/frontmatter rules,
per-claim recency and supersession, aliases, and when knowledge graduates to \`permanent/\`.
CTX

exit 0
