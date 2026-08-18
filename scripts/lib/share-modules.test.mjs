import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isPluginInstall,
  isRemovable,
  siblingCopies,
  isRealDir,
  isLink,
} from './share-modules.mjs';

// This module authorises rm -rf. Every test here is about what it refuses.
test('only a plugin cache path counts as an install', () => {
  assert.ok(isPluginInstall('/Users/x/.claude/plugins/cache/claude-memory/memory/0.3.0'));
  assert.ok(!isPluginInstall('/Users/x/Development/claude-memory'));
  assert.ok(!isPluginInstall('/Users/x/plugins/claude-memory')); // plugins, but not plugins/cache
});

test('refuses to remove anything that is not a node_modules inside a plugin cache', () => {
  const ok = '/Users/x/.claude/plugins/cache/p/memory/0.3.0/node_modules';
  assert.ok(isRemovable(ok));
  assert.ok(!isRemovable('/Users/x/.claude/plugins/cache/p/memory/0.3.0')); // the version dir
  assert.ok(!isRemovable('/Users/x/.claude/plugins/cache/p/memory/0.3.0/scripts'));
  assert.ok(!isRemovable('/Users/x/Development/claude-memory/node_modules')); // a checkout
  assert.ok(!isRemovable('/node_modules'));
});

function cache() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-modules-'));
  const versions = path.join(root, 'plugins', 'cache', 'claude-memory', 'memory');
  for (const v of ['0.1.0', '0.2.0', '0.3.0']) {
    fs.mkdirSync(path.join(versions, v, 'node_modules', 'pkg'), { recursive: true });
  }
  return { versions, current: path.join(versions, '0.3.0') };
}

test('finds the other versions still carrying their own copy', () => {
  const { versions, current } = cache();
  const got = siblingCopies(current)
    .map((p) => path.relative(versions, p))
    .sort();
  assert.deepEqual(got, ['0.1.0/node_modules', '0.2.0/node_modules']);
});

test('a sibling already symlinked is not offered again', () => {
  const { versions, current } = cache();
  const old = path.join(versions, '0.1.0', 'node_modules');
  fs.rmSync(old, { recursive: true });
  fs.symlinkSync(path.join(versions, '0.3.0', 'node_modules'), old, 'dir');
  assert.ok(isLink(old));
  assert.ok(!isRealDir(old) || !siblingCopies(current).includes(old));
  assert.deepEqual(
    siblingCopies(current).map((p) => path.relative(versions, p)),
    ['0.2.0/node_modules'],
  );
});

test('a version dir outside a plugin cache yields no siblings to delete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-'));
  fs.mkdirSync(path.join(root, 'sibling', 'node_modules'), { recursive: true });
  assert.deepEqual(siblingCopies(path.join(root, 'current')), []);
});
