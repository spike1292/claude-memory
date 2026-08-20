#!/usr/bin/env node
// Point every installed version of this plugin at one node_modules in $CLAUDE_MEMORY_HOME.
// Run from /memory:install. Unlike the other scripts here this one deletes directories, so it
// refuses to run anywhere but inside a plugin cache — a git checkout must be left alone.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  isPluginInstall,
  isRemovable,
  isRealDir,
  isLink,
  siblingCopies,
} from './lib/share-modules.mjs';
import { bytes } from './lib/slim-install.mjs';

const versionDir = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const state = process.env.CLAUDE_MEMORY_HOME || path.join(os.homedir(), '.claude-memory');
const shared = path.join(state, 'node_modules');
const here = path.join(versionDir, 'node_modules');

if (!isPluginInstall(versionDir)) {
  console.error(`refusing: ${versionDir} is not a plugin install (no plugins/cache in the path).`);
  console.error(
    'This is for the installed plugin, not a checkout — a checkout keeps its own node_modules.',
  );
  process.exit(1);
}

/** @type {(p: string) => number} */
const remove = (p) => {
  if (!isRemovable(p)) throw new Error(`refusing to remove ${p}`);
  const size = bytes(p);
  fs.rmSync(p, { recursive: true, force: true });
  return size;
};

let freed = 0;

// 1. Establish the shared copy. rename() is a no-copy move when $CLAUDE_MEMORY_HOME is on the
//    same filesystem, and a fallback is needed when it is not.
if (!isRealDir(shared)) {
  if (!isRealDir(here) || isLink(here)) {
    console.error(`nothing to share: ${here} is missing. Run npm ci first (step 4).`);
    process.exit(1);
  }
  fs.mkdirSync(state, { recursive: true });
  try {
    fs.renameSync(here, shared);
  } catch {
    fs.cpSync(here, shared, { recursive: true, verbatimSymlinks: true });
    remove(here);
  }
  console.log(`moved node_modules to ${shared}`);
}

// 2. This version, then every other installed version, points at it.
for (const dir of [here, ...siblingCopies(versionDir)]) {
  if (isLink(dir)) continue; // already shared
  if (isRealDir(dir)) freed += remove(dir);
  fs.symlinkSync(shared, dir, 'dir');
}

const total = Math.round(bytes(shared) / 2 ** 20);
console.log(
  freed
    ? `shared node_modules: reclaimed ${Math.round(freed / 2 ** 20)} MB, ${total} MB now kept once`
    : `shared node_modules: already consolidated (${total} MB)`,
);
