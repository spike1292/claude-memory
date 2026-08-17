// Tests for hooks/lib/paths.mjs. Run: node --test hooks/lib/paths.test.mjs
//
// The shell is the oracle throughout: every project-key assertion compares against vault-env.sh
// itself, never a hard-coded string, so these cannot drift away from the implementation.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync as run } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vaultEnvSh } from './paths.mjs';

const MODULE = fileURLToPath(new URL('./paths.mjs', import.meta.url));

test('paths', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-'));
  process.env.CLAUDE_MEMORY_HOME = path.join(tmp, 'state');

  const shell = (d) => run('bash', ['-c', '. "$0"; project_key "$1"', vaultEnvSh, d],
    { encoding: 'utf8' }).trim();
  // A fresh process per call — short-lived hooks are the whole reason the disk cache exists,
  // and an in-process Map would hide every bug this is meant to catch.
  const fresh = (d) => run(process.execPath, ['--input-type=module', '-e',
    `const p=await import(${JSON.stringify(MODULE)});`
    + `console.log(p.projectKey(${JSON.stringify(d)}))`], { encoding: 'utf8', env: process.env }).trim();

  // ONE subtest on purpose, not four. The remote changes below must land in the SAME SECOND as the
  // write before them — that is the whole point, since whole-second mtime alone cannot see them.
  // Splitting them would let seconds tick over between steps, mtime would start discriminating, and
  // the size/inode assertions would keep passing while no longer testing what they claim.
  await t.test('project-key cache tracks the shell across same-second remote changes', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    run('git', ['init', '-q', repo]);
    run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://gitlab.example.com/Team/Alpha.git']);
    assert.strictEqual(fresh(repo), shell(repo), 'cold lookup must match the shell');
    assert.strictEqual(fresh(repo), shell(repo), 'cached lookup must match the shell');

    // A changed remote changes the key, and the cache must not outlive it. Size is what
    // discriminates here; this assertion failed for real when the stamp was seconds-only.
    run('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/Team/Beta.git']);
    assert.strictEqual(fresh(repo), shell(repo), 'stale key served after the remote changed');
    assert.ok(fresh(repo).endsWith('beta'), 'same-second remote change must invalidate');

    // The nastiest shape: same second AND identical byte length, so neither mtime nor size moves.
    // Only the inode does. This is the case a seconds-only stamp would have missed forever.
    run('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/Team/Beto.git']);
    assert.strictEqual(fresh(repo), shell(repo), 'shell and node must agree after a same-length change');
    assert.ok(fresh(repo).endsWith('beto'),
      'same-second, same-length remote change must invalidate — this is what the inode is for');

    const sub = path.join(repo, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    assert.strictEqual(fresh(sub), shell(sub), 'a subdirectory must key to the same project');
  });

  await t.test('a non-git dir falls back to the path slug', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    assert.strictEqual(fresh(plain), shell(plain), 'non-git dir must fall back to the path slug');
  });

  await t.test('a corrupt cache degrades to the shell instead of throwing', () => {
    // This runs inside hooks, so it must never throw.
    const repo = path.join(tmp, 'repo');
    const cf = path.join(process.env.CLAUDE_MEMORY_HOME, 'cache', 'project-keys.json');
    fs.mkdirSync(path.dirname(cf), { recursive: true });
    fs.writeFileSync(cf, '{ not json');
    assert.strictEqual(fresh(repo), shell(repo), 'corrupt cache must fall back, not throw');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});
