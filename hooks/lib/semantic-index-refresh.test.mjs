// Tests for hooks/lib/semantic-index-refresh.mjs.
// Run: node --test hooks/lib/semantic-index-refresh.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSlug, runtimeInstalled, plan } from './semantic-index-refresh.mjs';
import { legacyKey } from './paths.mjs';

const vaultWith = (/** @type {readonly string[]} */ dirs) => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sir-vault-'));
  for (const d of dirs) fs.mkdirSync(path.join(v, d), { recursive: true });
  return v;
};

test('resolveSlug returns null when the project has no vault memory', () => {
  const v = vaultWith([]);
  assert.strictEqual(resolveSlug(process.cwd(), v), null);
});

test('resolveSlug falls back to the legacy key on a not-yet-migrated vault', () => {
  // vault-memory-sync performs the legacy_key -> project_key rename, but SessionStart hook order
  // is not guaranteed. Indexing the legacy folder for one session beats indexing nothing.
  const cwd = process.cwd();
  const legacy = legacyKey(cwd);
  const v = vaultWith([path.join('Memory', legacy)]);
  assert.strictEqual(resolveSlug(cwd, v), legacy);
});

test('plan abstains, with a reason, when there is nothing to index', () => {
  const v = vaultWith([]);
  const p = plan(process.cwd(), { vaultRoot: v });
  assert.strictEqual(p.run, false);
  assert.match(p.reason, /no vault memory/);
});

test('runtimeInstalled DEREFERENCES a symlinked node_modules', () => {
  // The regression this guards: since 0.3.1 the plugin's node_modules is a symlink into
  // $CLAUDE_MEMORY_HOME, and a check that stats the link rather than the target is exactly what
  // made /memory:doctor report 0 MB on 2026-08-18.
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'sir-real-'));
  fs.mkdirSync(path.join(real, 'node_modules', '@huggingface', 'transformers'), {
    recursive: true,
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sir-root-'));
  fs.symlinkSync(path.join(real, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  assert.strictEqual(runtimeInstalled(root), true, 'must see through the symlink');

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sir-bare-'));
  assert.strictEqual(runtimeInstalled(bare), false);
});
