// Tests for hooks/lib/semantic-index-refresh.mjs.
// Run: node --test hooks/lib/semantic-index-refresh.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveSlug,
  runtimeInstalled,
  plan,
  outcomeOf,
  REASONS,
  workerEnv,
} from './semantic-index-refresh.mjs';
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

test('outcomeOf separates a missing dependency from a quiet decision', () => {
  // The whole point of the outcome field. An install whose embedding runtime never finished is
  // permanently doing nothing, and it exits 0 and prints the same nothing as a project that simply
  // has no vault memory yet.
  // Through the CONSTANTS plan() itself returns. A test holding its own copy of the string cannot
  // see plan() and outcomeOf() stop agreeing — the drift would just quietly report `ran`.
  assert.strictEqual(outcomeOf({ run: false, reason: REASONS.noRuntime }), 'noop-missing-dep');
  assert.strictEqual(outcomeOf({ run: false, reason: REASONS.noScript }), 'noop-missing-dep');
  assert.strictEqual(outcomeOf({ run: false, reason: REASONS.noVault }), 'ran');
  // And end to end: an empty vault root reaches the noVault branch through plan(), not a literal.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sir-empty-'));
  assert.strictEqual(outcomeOf(plan(process.cwd(), { vaultRoot: empty })), 'ran');
  const ran = /** @type {const} */ ({
    run: true,
    slug: 's',
    script: '/x',
    args: /** @type {string[]} */ ([]),
    logFile: '/l',
  });
  assert.strictEqual(outcomeOf({ ...ran, spawned: true }), 'spawned');
  // A fork that failed is not a re-index that happened. Nothing else would ever contradict it:
  // with no child, no worker line is written either.
  assert.strictEqual(outcomeOf({ ...ran, spawned: false }), 'error');
});

test('the indexer worker line is scoped by a marker, not just by the session id', () => {
  const env = workerEnv('s1');
  assert.strictEqual(env.MEMORY_HOOK_SESSION, 's1');
  // Without the marker, the re-index the DISTILLER runs at the end of every distillation inherits
  // the session id and is logged as this hook's worker — a SessionEnd re-index filed under
  // SessionStart. Observed end to end on 2026-08-21 before this was added.
  assert.strictEqual(env.MEMORY_INDEX_HOOK, '1');

  // And the indexer reads the same spelling. A rename on either side stops the worker line being
  // written at all, silently — the exact failure mode this log exists to make impossible.
  const indexer = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/memory-semantic.mjs'),
    'utf8',
  );
  assert.match(indexer, /process\.env\.MEMORY_INDEX_HOOK/);
});
