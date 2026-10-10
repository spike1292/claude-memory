import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

const MARKER = path.join('onnxruntime-node', 'package.json');
const libDir = path.dirname(fileURLToPath(import.meta.url));

/** @param {{ install: boolean, shared: 'none' | 'empty' | 'partial' | 'full' }} o */
function run({ install, shared }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-run-'));
  const version = path.join(root, 'plugins', 'cache', 'claude-memory', 'memory', '1.0.0');
  const state = path.join(root, 'state');
  fs.mkdirSync(path.join(version, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(
    path.join(libDir, '..', 'share-modules.mjs'),
    path.join(version, 'scripts', 'share-modules.mjs'),
  );
  for (const f of ['share-modules.mjs', 'slim-install.mjs']) {
    fs.copyFileSync(path.join(libDir, f), path.join(version, 'scripts', 'lib', f));
  }
  const here = path.join(version, 'node_modules');
  if (install) {
    fs.mkdirSync(path.join(here, 'onnxruntime-node'), { recursive: true });
    fs.writeFileSync(path.join(here, MARKER), '{}');
  }
  if (shared !== 'none') fs.mkdirSync(path.join(state, 'node_modules'), { recursive: true });
  if (shared === 'partial') fs.writeFileSync(path.join(state, 'node_modules', 'keep'), '');
  if (shared === 'full') {
    fs.mkdirSync(path.join(state, 'node_modules', 'onnxruntime-node'));
    fs.writeFileSync(path.join(state, 'node_modules', MARKER), '{}');
  }
  const r = spawnSync(process.execPath, [path.join(version, 'scripts', 'share-modules.mjs')], {
    env: { ...process.env, CLAUDE_MEMORY_HOME: state },
    encoding: 'utf8',
  });
  return { r, here, shared: path.join(state, 'node_modules') };
}

test('an emptied shared node_modules does not swallow a fresh install', () => {
  const { r, here, shared } = run({ install: true, shared: 'empty' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(isLink(here));
  assert.ok(fs.existsSync(path.join(here, MARKER)));
  assert.ok(fs.existsSync(path.join(shared, MARKER)));
});

test('with no usable install on either side it fails and links nothing', () => {
  const { r, here, shared } = run({ install: false, shared: 'empty' });
  assert.notEqual(r.status, 0);
  assert.ok(!isLink(here));
  assert.ok(isRealDir(shared));
});

test('a non-empty shared dir without an install is refused, not deleted', () => {
  const { r, here, shared } = run({ install: true, shared: 'partial' });
  assert.notEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(shared, 'keep')));
  assert.ok(!isLink(here) && fs.existsSync(path.join(here, MARKER)));
});

test('a usable shared copy still replaces the version dir with a link', () => {
  const { r, here } = run({ install: true, shared: 'full' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reclaimed/);
  assert.ok(isLink(here) && fs.existsSync(path.join(here, MARKER)));
});

test('a first run moves the install into the shared dir', () => {
  const { r, here, shared } = run({ install: true, shared: 'none' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(isLink(here) && fs.existsSync(path.join(shared, MARKER)));
});
