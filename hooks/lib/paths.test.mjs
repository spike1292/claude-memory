// Tests for hooks/lib/paths.mjs. Run: node --test hooks/lib/paths.test.mjs
//
// The oracle used to be vault-env.sh — every project-key assertion ran the shell and compared.
// That stopped meaning anything on 2026-08-18, when resolution became single-implementation and
// the shell started ASKING Node: the comparison would have passed by construction while testing
// nothing. The oracle is now the EXPECTED KEY, written out, plus a table over the URL shapes the
// old sed pipeline handled.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync as run } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normaliseRemote, legacyKey } from './paths.mjs';

const MODULE = fileURLToPath(new URL('./paths.mjs', import.meta.url));

test('paths', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-'));
  process.env.CLAUDE_MEMORY_HOME = path.join(tmp, 'state');

  // A fresh process per call — short-lived hooks are the whole reason the disk cache exists,
  // and an in-process Map would hide every bug this is meant to catch.
  const fresh = (/** @type {string} */ d) =>
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const p=await import(${JSON.stringify(MODULE)});` +
          `console.log(p.projectKey(${JSON.stringify(d)}))`,
      ],
      { encoding: 'utf8', env: process.env },
    ).trim();

  // ONE subtest on purpose, not four. The remote changes below must land in the SAME SECOND as the
  // write before them — that is the whole point, since whole-second mtime alone cannot see them.
  // Splitting them would let seconds tick over between steps, mtime would start discriminating, and
  // the size/inode assertions would keep passing while no longer testing what they claim.
  await t.test('project-key cache tracks the shell across same-second remote changes', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    run('git', ['init', '-q', repo]);
    run('git', [
      '-C',
      repo,
      'remote',
      'add',
      'origin',
      'https://gitlab.example.com/Team/Alpha.git',
    ]);
    const ALPHA = 'gitlab.example.com-team-alpha';
    assert.strictEqual(fresh(repo), ALPHA, 'cold lookup');
    assert.strictEqual(fresh(repo), ALPHA, 'cached lookup must agree with the cold one');

    // A changed remote changes the key, and the cache must not outlive it. Size is what
    // discriminates here; this assertion failed for real when the stamp was seconds-only.
    run('git', [
      '-C',
      repo,
      'remote',
      'set-url',
      'origin',
      'https://gitlab.example.com/Team/Beta.git',
    ]);
    assert.strictEqual(
      fresh(repo),
      'gitlab.example.com-team-beta',
      'same-second remote change must invalidate — this is what the size is for',
    );

    // The nastiest shape: same second AND identical byte length, so neither mtime nor size moves.
    // Only the inode does. This is the case a seconds-only stamp would have missed forever.
    run('git', [
      '-C',
      repo,
      'remote',
      'set-url',
      'origin',
      'https://gitlab.example.com/Team/Beto.git',
    ]);
    assert.strictEqual(
      fresh(repo),
      'gitlab.example.com-team-beto',
      'same-second, same-length remote change must invalidate — this is what the inode is for',
    );

    const sub = path.join(repo, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    assert.strictEqual(
      fresh(sub),
      'gitlab.example.com-team-beto',
      'a subdirectory must key to the same project',
    );
  });

  await t.test('a non-git dir falls back to the path slug', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    assert.strictEqual(fresh(plain), legacyKey(plain), 'non-git dir falls back to the path slug');
  });

  await t.test('a repo with NO origin remote keys on the directory name, lowercased only', () => {
    // The shell this replaced ran `basename "$_top" | tr 'A-Z' 'a-z'` on this branch. The
    // 2026-08-18 port ran the whole normaliseRemote() pipeline instead, which also strips a
    // trailing `.git` — silently re-keying such a repo to a DIFFERENT vault folder. `.git` in the
    // name is what makes this visible; the lowercase is what the branch is actually for.
    const bare = path.join(tmp, 'Foo.git');
    fs.mkdirSync(bare);
    run('git', ['init', '-q', bare]);
    assert.strictEqual(fresh(bare), 'foo.git', 'must NOT strip .git — this is not a remote URL');
  });

  await t.test('a corrupt cache recomputes instead of throwing', () => {
    // This runs inside hooks, so it must never throw.
    const repo = path.join(tmp, 'repo');
    const cf = path.join(
      /** @type {string} */ (process.env.CLAUDE_MEMORY_HOME),
      'cache',
      'project-keys.json',
    );
    fs.mkdirSync(path.dirname(cf), { recursive: true });
    fs.writeFileSync(cf, '{ not json');
    assert.strictEqual(
      fresh(repo),
      'gitlab.example.com-team-beto',
      'corrupt cache must recompute, not throw — this runs inside hooks',
    );
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});

// The five `sed -e` expressions this replaced, one case each. Ported 2026-08-18; before that the
// only check on them was that Node forked bash to run the same pipeline.
test('normaliseRemote reproduces the sed pipeline', () => {
  const cases = [
    ['https://gitlab.example.com/Team/Alpha.git', 'gitlab.example.com-team-alpha'],
    ['git://example.com/a/b.git', 'example.com-a-b'],
    // scp syntax: the FIRST colon becomes a slash, and only the first (sed had no /g).
    ['git@github.com:spike1292/claude-memory.git', 'github.com-spike1292-claude-memory'],
    ['ssh://git@example.com:22/a/b.git', 'example.com-22-a-b'],
    // Credentials are stripped, never keyed on.
    ['https://user:token@example.com/a/b.git', 'example.com-a-b'],
    ['https://example.com/a/b/', 'example.com-a-b'],
    ['https://example.com/a/b///', 'example.com-a-b'],
    ['https://example.com/a/b', 'example.com-a-b'],
  ];
  for (const [url, want] of cases) assert.strictEqual(normaliseRemote(url), want, url);
});

test('normaliseRemote lowercases ASCII ONLY, like tr A-Z a-z', () => {
  // The porting hazard: toLowerCase() is unicode-aware and would map these, where the shell's
  // `tr 'A-Z' 'a-z'` leaves them alone. A host with a non-ASCII capital would key differently on
  // the two sides and silently split one project's vault folder in two.
  assert.strictEqual(normaliseRemote('https://EXAMPLE.com/A/B'), 'example.com-a-b');
  assert.strictEqual(normaliseRemote('https://exämple.com/Ä/b'), 'exämple.com-Ä-b');
  assert.strictEqual(normaliseRemote('https://example.com/İ/b'), 'example.com-İ-b');
});
