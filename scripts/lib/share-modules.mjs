// Claude Code keeps every installed version of a plugin, each with its own node_modules — it does
// NOT replace the cache wholesale on update. Measured 2026-08-18: six versions of this plugin,
// 381 MB each, link count 1, 2.2 GB total. Slimming the install divides that constant; it does not
// stop it multiplying. The runtime is identical across versions and is exactly what the repo's own
// rule says belongs in $CLAUDE_MEMORY_HOME, so it moves there once and every version dir gets a
// symlink. Node resolves through symlinks by default, so nothing else changes.
import fs from 'node:fs';
import path from 'node:path';

// This module deletes directories. It only ever does so inside a plugin cache, and this is the
// only thing standing between a wrong CWD and a developer's checkout.
const CACHE_MARKER = path.join('plugins', 'cache');

export function isPluginInstall(dir) {
  return dir.split(path.sep).join(path.sep).includes(CACHE_MARKER);
}

/** Refuses anything that is not a node_modules directly inside a plugin cache dir. */
export function isRemovable(p) {
  return path.basename(p) === 'node_modules' && isPluginInstall(path.dirname(p));
}

const stat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

export const isRealDir = (p) => stat(p)?.isDirectory() === true;
export const isLink = (p) => stat(p)?.isSymbolicLink() === true;

/**
 * Other installed versions of the same plugin that still carry their own copy.
 * versionDir is this version's directory; its siblings are the other versions.
 */
export function siblingCopies(versionDir) {
  const parent = path.dirname(versionDir);
  if (!isPluginInstall(parent)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && path.join(parent, e.name) !== versionDir)
    .map((e) => path.join(parent, e.name, 'node_modules'))
    .filter((p) => isRealDir(p) && !isLink(p));
}
