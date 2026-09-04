// Characterisation test for hooks/vault-memory-sync.sh. Run: node --test hooks/vault-memory-sync.test.mjs
//
// PLACEMENT, deliberately off-pattern. The repo convention is `<name>.test.mjs` beside the `lib/`
// module it tests, but this module is a *shell script with no lib twin* — the standing rule in
// CLAUDE.md is that it stays bash, because it moves files and repoints symlinks in a live
// cloud-synced vault and has cost 24 notes once (2026-08-08). So the test sits beside the script it
// drives, `hooks/vault-memory-sync.test.mjs`, and drives it as a black box: spawn bash, feed it a
// hook payload on stdin, then assert on the filesystem it left behind. `node --test` discovers
// `hooks/*.test.mjs` exactly as it discovers `hooks/lib/*.test.mjs`, so CI needed no change.
//
// This is a CHARACTERISATION test, written 2026-08-19 as item 10 of the refactor backlog (deleted; see H4 in docs/architecture.md). It
// records what the script does TODAY so a future port can be diffed against it. Several assertions
// below record behaviour that is arguably wrong; each is marked `CHARACTERISED, NOT ENDORSED` and
// says what the defect is. Do not "fix" the script to make one of those pass differently without
// first deciding the behaviour change is wanted — the whole point of this file is that the last
// unreviewed change to this script deleted notes.
//
// ISOLATION IS THE POINT. The script repoints `$HOME/.claude/projects/<slug>/memory`, so isolating
// CLAUDE_VAULT alone is NOT enough — a leak repoints the developer's real memory symlink at a
// throwaway vault. Every run below gets a scratch HOME, and the child env is BUILT, never
// inherited. The last subtest proves the real ~/.claude is byte-identical afterwards.
//
// Portable to Ubuntu CI: no Synology, no real vault, and no `jq` dependency — the payload cwd is
// also passed as the child's working directory, so the script's `cat | jq` line reaches the same
// answer through its `$PWD` fallback when jq is absent.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { legacyKey } from './lib/paths.mjs';

const SCRIPT = fileURLToPath(new URL('./vault-memory-sync.sh', import.meta.url));
const REAL_HOME = os.homedir();
const hasJq = (() => {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// --- scratch world ---------------------------------------------------------------------------

/**
 * A complete throwaway HOME + vault + state dir, plus the built (never inherited) child env.
 *
 * realpathSync on purpose: macOS hands out /var/folders/... which is a symlink to /private/var.
 * The slug is derived from a path string, so an unresolved one would make bash's $PWD fallback and
 * the payload cwd disagree and the slug would differ between them.
 */
/** @type {string[]} */
const worlds = [];

/** @param {string} label */
function scratch(label) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `vms-${label}-`)));
  worlds.push(tmp);
  const home = path.join(tmp, 'home');
  const vault = path.join(tmp, 'vault');
  const memHome = path.join(tmp, 'state');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_VAULT: vault,
    CLAUDE_MEMORY_HOME: memHome,
    // No LANG/LC_*: nothing here sorts or collates. Everything else is deliberately absent so an
    // env var set on the developer's machine cannot change what this test measures.
  };
  assert.notStrictEqual(env.HOME, REAL_HOME, 'scratch HOME must not be the real one');
  return { tmp, home, vault, memHome, env };
}

/**
 * @param {ReturnType<typeof scratch>} world
 * @param {string} name
 * @param {string | null} [remote]
 */
function makeRepo(world, name, remote) {
  const repo = path.join(world.tmp, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo], { env: world.env });
  if (remote)
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote], { env: world.env });
  return repo;
}

/**
 * Run the hook exactly as SessionStart does: payload on stdin, cwd set, built env.
 * `pwd` defaults to the payload cwd — they agree in every subtest but the jq one, which is
 * the only place the two sources of truth can be told apart.
 *
 * @param {ReturnType<typeof scratch>} world
 * @param {string} repo
 * @param {string} [pwd]
 */
function runSync(world, repo, pwd = repo) {
  return execFileSync('bash', [SCRIPT], {
    cwd: pwd,
    env: world.env,
    input: JSON.stringify({ cwd: repo }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const slugOf = legacyKey;
const write = (/** @type {string} */ p, /** @type {string} */ s) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
};
const sha = (/** @type {string} */ p) =>
  crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Every path under root as `type\trelpath\tpayload`, sorted. Symlink targets, file hashes.
 *
 * @param {string} root
 * @returns {string[]}
 */
function manifest(root) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ dir) => {
    for (const e of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isSymbolicLink()) out.push(`link\t${rel}\t${fs.readlinkSync(full)}`);
      else if (e.isDirectory()) {
        out.push(`dir\t${rel}\t`);
        walk(full);
      } else out.push(`file\t${rel}\t${sha(full)}`);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/**
 * Content hashes of every regular file under root — the "nothing was deleted" oracle.
 *
 * @param {string} root
 */
function contents(root) {
  return new Set(
    manifest(root)
      .filter((l) => l.startsWith('file\t'))
      .map((l) => l.split('\t')[2]),
  );
}

/**
 * A read-only fingerprint of the REAL ~/.claude — the memory symlinks this script repoints, the
 * global CLAUDE.md it may rewrite, and the state dir it writes a breadcrumb into. Tolerates every
 * piece being absent, which is the normal case on Ubuntu CI.
 *
 * TYPES AND LINK TARGETS ONLY, NO mtimes. An earlier version hashed the mtime of ~/.claude-memory,
 * which this plugin's own hooks write to every session (`plugin-root`, `run/` sockets, `db/`,
 * `logs/`) — measured 2026-08-19, that directory's mtime had moved 11 minutes earlier from
 * ordinary session activity. A concurrent SessionStart during the ~2.4 s run would then fail this
 * subtest with an accusation of a HOME leak that never happened, and a safety oracle that cries
 * wolf gets muted. A leak repoints a symlink or replaces a link with a directory; that is what is
 * checked, and nothing here can change it legitimately.
 */
function realHomeFingerprint() {
  const lines = [];
  const projects = path.join(REAL_HOME, '.claude', 'projects');
  if (fs.existsSync(projects)) {
    for (const name of fs.readdirSync(projects).sort()) {
      const mem = path.join(projects, name, 'memory');
      let st;
      try {
        st = fs.lstatSync(mem);
      } catch {
        continue;
      }
      lines.push(
        st.isSymbolicLink()
          ? `${name}\tlink\t${fs.readlinkSync(mem)}`
          : `${name}\t${st.isDirectory() ? 'dir' : 'file'}`,
      );
    }
  } else lines.push('projects\tabsent');
  for (const p of [
    path.join(REAL_HOME, '.claude', 'CLAUDE.md'),
    path.join(REAL_HOME, '.claude-memory'),
  ]) {
    try {
      const st = fs.lstatSync(p);
      lines.push(`${p}\t${st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file'}`);
    } catch {
      lines.push(`${p}\tabsent`);
    }
  }
  return lines;
}

// --- the suite -------------------------------------------------------------------------------

test('vault-memory-sync.sh (characterisation)', async (t) => {
  // Taken BEFORE anything runs. Asserted again in the last subtest.
  const realBefore = realHomeFingerprint();
  // Each world is a git repo + a vault + a state dir; eleven per run left 300 of them behind in
  // $TMPDIR (2.7 GB, measured 2026-08-19) because nothing removed them.
  t.after(() => {
    for (const dir of worlds) fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('fresh project: creates every layer dir, the symlink, and the breadcrumb', () => {
    const w = scratch('fresh');
    const repo = makeRepo(w, 'alpha', 'https://github.com/Example/Alpha.git');
    const key = 'github.com-example-alpha';

    const stdout = runSync(w, repo);

    const mem = path.join(w.home, '.claude', 'projects', slugOf(repo), 'memory');
    assert.ok(fs.lstatSync(mem).isSymbolicLink(), 'memory must be a symlink');
    assert.strictEqual(fs.readlinkSync(mem), path.join(w.vault, 'Memory', key));
    assert.ok(fs.existsSync(path.join(mem, '.')), 'the symlink must resolve to a real directory');

    for (const rel of [
      `Memory/${key}`,
      `Logs/${key}`,
      `Insights/${key}/Patterns`,
      `Insights/${key}/Mistakes`,
      `Insights/${key}/Decisions`,
      `Graph/${key}`,
      'permanent',
    ]) {
      assert.ok(fs.statSync(path.join(w.vault, rel)).isDirectory(), `missing vault dir ${rel}`);
    }

    // The breadcrumb /memory:* commands fall back to when ${CLAUDE_PLUGIN_ROOT} is absent.
    assert.strictEqual(
      fs.readFileSync(path.join(w.memHome, 'plugin-root'), 'utf8'),
      fs.realpathSync(path.dirname(path.dirname(SCRIPT))),
    );

    // The standing retrieval rules go to stdout, which Claude Code injects as session context.
    assert.match(stdout, /# Memory \(plugin: /);
    assert.match(stdout, new RegExp(`Memory/${key}/`));
    assert.match(
      stdout,
      /Expand the query into domain vocabulary/,
      'the retrieval rules must survive',
    );
  });

  await t.test('legacy_key -> project_key migration: every note survives, none deleted', () => {
    const w = scratch('migrate');
    const repo = makeRepo(w, 'beta', 'git@github.com:Example/Beta.git');
    const slug = slugOf(repo);
    const key = 'github.com-example-beta';

    // The pre-2026-08-08 layout: every layer keyed on the cwd slug.
    const before = [];
    for (const [layer, sub] of [
      ['Memory', ''],
      ['Logs', ''],
      ['Insights', 'Patterns'],
      ['Graph', ''],
    ]) {
      for (let i = 0; i < 3; i++) {
        const p = path.join(w.vault, layer, slug, sub, `note-${i}.md`);
        write(p, `# ${layer} ${i}\nbody\n`);
        before.push(p);
      }
    }
    const contentsBefore = contents(w.vault);
    assert.strictEqual(contentsBefore.size, 12, 'sanity: 12 distinct notes staged');

    runSync(w, repo);

    // 1. Count them: none lost.
    const contentsAfter = contents(w.vault);
    for (const h of contentsBefore) {
      assert.ok(
        contentsAfter.has(h),
        'a note staged before the migration is no longer in the vault',
      );
    }

    // 2. They are where the new key says, not the old slug.
    for (const [layer, sub] of [
      ['Memory', ''],
      ['Logs', ''],
      ['Insights', 'Patterns'],
      ['Graph', ''],
    ]) {
      const dir = path.join(w.vault, layer, key, sub);
      assert.deepStrictEqual(
        fs.readdirSync(dir).sort(),
        ['note-0.md', 'note-1.md', 'note-2.md'],
        `${layer} did not migrate`,
      );
      assert.ok(!fs.existsSync(path.join(w.vault, layer, slug)), `${layer}/<slug> should be gone`);
    }

    // 3. The symlink resolves at the new key.
    const mem = path.join(w.home, '.claude', 'projects', slug, 'memory');
    assert.strictEqual(fs.readlinkSync(mem), path.join(w.vault, 'Memory', key));
    assert.deepStrictEqual(fs.readdirSync(mem).sort(), ['note-0.md', 'note-1.md', 'note-2.md']);
  });

  await t.test(
    'migration refuses to merge when the destination exists — legacy notes are stranded',
    () => {
      const w = scratch('nomerge');
      const repo = makeRepo(w, 'gamma', 'https://github.com/Example/Gamma.git');
      const slug = slugOf(repo);
      const key = 'github.com-example-gamma';

      write(path.join(w.vault, 'Memory', slug, 'old.md'), 'OLD\n');
      write(path.join(w.vault, 'Memory', key, 'new.md'), 'NEW\n');
      const contentsBefore = contents(w.vault);

      runSync(w, repo);

      // Nothing deleted, which is the guarantee that matters.
      for (const h of contentsBefore) assert.ok(contents(w.vault).has(h), 'a note was deleted');
      assert.strictEqual(
        fs.readFileSync(path.join(w.vault, 'Memory', key, 'new.md'), 'utf8'),
        'NEW\n',
      );

      // CHARACTERISED, NOT ENDORSED. `[ -d "$old" ] && [ ! -e "$new" ]` means a half-completed
      // migration (or a `mkdir -p "$dest"` from an earlier run of THIS script) leaves `old.md`
      // orphaned under the legacy slug forever, silently: it is never merged, never reported, and
      // nothing retrieves it — memory-semantic indexes by key. The refusal to merge is deliberate
      // and correct; the SILENCE is the defect. Documented 2026-08-19, deliberately not fixed here.
      assert.strictEqual(
        fs.readFileSync(path.join(w.vault, 'Memory', slug, 'old.md'), 'utf8'),
        'OLD\n',
      );
    },
  );

  await t.test('repointing an existing symlink COPIES — the 2026-08-08 24-note guarantee', () => {
    const w = scratch('repoint');
    const repo = makeRepo(w, 'delta', 'https://github.com/Example/Delta.git');
    const slug = slugOf(repo);
    const key = 'github.com-example-delta';

    // An already-populated memory dir under a DIFFERENT root — the exact shape of the incident:
    // someone ran a hook with CLAUDE_VAULT pointed at a throwaway directory.
    const otherRoot = path.join(w.tmp, 'other-vault', 'Memory', key);
    write(path.join(otherRoot, 'keep.md'), 'KEEP\n');
    write(path.join(otherRoot, 'clash.md'), 'FROM-OLD\n');
    fs.mkdirSync(path.join(w.home, '.claude', 'projects', slug), { recursive: true });
    const mem = path.join(w.home, '.claude', 'projects', slug, 'memory');
    fs.symlinkSync(otherRoot, mem);

    // The destination already holds a note of the same name with different content.
    write(path.join(w.vault, 'Memory', key, 'clash.md'), 'FROM-NEW\n');

    runSync(w, repo);

    // The old target is INTACT. This is the assertion the incident is about: copy, never move.
    assert.deepStrictEqual(fs.readdirSync(otherRoot).sort(), ['clash.md', 'keep.md']);
    assert.strictEqual(fs.readFileSync(path.join(otherRoot, 'keep.md'), 'utf8'), 'KEEP\n');

    assert.strictEqual(fs.readlinkSync(mem), path.join(w.vault, 'Memory', key));
    assert.strictEqual(
      fs.readFileSync(path.join(mem, 'keep.md'), 'utf8'),
      'KEEP\n',
      'copied across',
    );
    // `cp -n` does not clobber: the destination's version of a same-named note wins, and the old
    // one stays readable at its old path. A duplicate is recoverable; an overwrite is not.
    assert.strictEqual(fs.readFileSync(path.join(mem, 'clash.md'), 'utf8'), 'FROM-NEW\n');
  });

  await t.test('a real memory DIR is migrated by move — and same-named notes are lost', () => {
    const w = scratch('realdir');
    const repo = makeRepo(w, 'epsilon', 'https://github.com/Example/Epsilon.git');
    const slug = slugOf(repo);
    const key = 'github.com-example-epsilon';

    const mem = path.join(w.home, '.claude', 'projects', slug, 'memory');
    write(path.join(mem, 'moved.md'), 'MOVED\n');
    write(path.join(mem, 'clash.md'), 'FROM-DIR\n');
    write(path.join(w.vault, 'Memory', key, 'clash.md'), 'FROM-VAULT\n');

    runSync(w, repo);

    assert.ok(fs.lstatSync(mem).isSymbolicLink());
    assert.strictEqual(fs.readFileSync(path.join(mem, 'moved.md'), 'utf8'), 'MOVED\n');

    // CHARACTERISED, NOT ENDORSED — a real data-loss path, found 2026-08-19 writing this test.
    // The branch is `find -maxdepth 1 -type f -exec mv -n {} "$dest"/ \;` then
    // `rmdir "$mem" 2>/dev/null || rm -rf "$mem"`. `mv -n` SKIPS a name that already exists in the
    // vault, leaving it behind in $mem; $mem is then non-empty, so `rmdir` fails and `rm -rf`
    // deletes it. The local note is gone with no copy and no message. Unlike the symlink branch
    // above (which copies, so a clash merely duplicates), this branch destroys the loser.
    // Not fixed here on purpose: the standing rule is that this script gets a test first.
    assert.strictEqual(
      fs.readFileSync(path.join(w.vault, 'Memory', key, 'clash.md'), 'utf8'),
      'FROM-VAULT\n',
    );
    const fromDir = crypto.createHash('sha256').update('FROM-DIR\n').digest('hex');
    assert.ok(!contents(w.vault).has(fromDir), 'the losing note is not in the vault');
    assert.ok(
      !contents(w.home).has(fromDir),
      'and it is not anywhere under HOME either — it is gone',
    );
  });

  await t.test('a subdirectory inside a real memory dir is DELETED, not migrated', () => {
    const w = scratch('subdir');
    const repo = makeRepo(w, 'zeta', 'https://github.com/Example/Zeta.git');
    const slug = slugOf(repo);

    const mem = path.join(w.home, '.claude', 'projects', slug, 'memory');
    write(path.join(mem, 'top.md'), 'TOP\n');
    write(path.join(mem, 'nested', 'deep.md'), 'DEEP\n');

    runSync(w, repo);

    const dest = path.join(w.vault, 'Memory', 'github.com-example-zeta');
    assert.strictEqual(fs.readFileSync(path.join(dest, 'top.md'), 'utf8'), 'TOP\n');

    // CHARACTERISED, NOT ENDORSED. The script's own header says "only moves regular files when
    // repointing — memory dirs hold .md files, not subdirs", so this is a stated assumption rather
    // than an oversight. But the failure mode when the assumption breaks is silent deletion:
    // `find -maxdepth 1 -type f` never sees `nested/`, `rmdir` then fails on the non-empty dir, and
    // `rm -rf` removes it and everything under it. Anything that ever creates a subdirectory under
    // a project's memory dir loses it on the next SessionStart. Documented 2026-08-19, not fixed.
    assert.ok(!fs.existsSync(path.join(dest, 'nested')), 'subdir is not migrated');
    assert.ok(!fs.existsSync(path.join(mem, 'nested')), 'and it is deleted from the source');
  });

  await t.test('idempotent: a second run leaves byte-identical state', () => {
    const w = scratch('idem');
    const repo = makeRepo(w, 'eta', 'https://github.com/Example/Eta.git');
    const slug = slugOf(repo);
    write(path.join(w.vault, 'Memory', slug, 'legacy.md'), 'LEGACY\n');

    runSync(w, repo);
    const afterFirst = [
      manifest(w.vault),
      manifest(path.join(w.home, '.claude')),
      manifest(w.memHome),
    ];
    runSync(w, repo);
    const afterSecond = [
      manifest(w.vault),
      manifest(path.join(w.home, '.claude')),
      manifest(w.memHome),
    ];

    assert.deepStrictEqual(afterSecond, afterFirst, 'second run must be a no-op');
  });

  await t.test('a repo with no `origin` remote keys on the repo dir name (#21)', () => {
    const w = scratch('noremote');
    // Uppercase AND a `.git` suffix in the DIRECTORY name: #21's regression was running the full
    // remote-normalising pipeline on this branch, which stripped `.git` and re-keyed the repo into
    // a different vault folder. The shell it replaced only lowercased the basename.
    const repo = makeRepo(w, 'NoRemote.git', null);
    runSync(w, repo);

    const mem = path.join(w.home, '.claude', 'projects', slugOf(repo), 'memory');
    assert.strictEqual(fs.readlinkSync(mem), path.join(w.vault, 'Memory', 'noremote.git'));
    assert.ok(
      !fs.existsSync(path.join(w.vault, 'Memory', 'noremote')),
      '`.git` must NOT be stripped here',
    );
    assert.ok(
      !fs.existsSync(path.join(w.vault, 'Memory', slugOf(repo))),
      'must not fall back to the cwd slug',
    );
  });

  await t.test('a non-git directory falls back to the cwd slug, so no migration runs', () => {
    const w = scratch('nogit');
    const dir = path.join(w.tmp, 'plain');
    fs.mkdirSync(dir);
    runSync(w, dir);

    // slug == key here, so the `if [ "$slug" != "$key" ]` migration block is skipped entirely.
    const slug = slugOf(dir);
    const mem = path.join(w.home, '.claude', 'projects', slug, 'memory');
    assert.strictEqual(fs.readlinkSync(mem), path.join(w.vault, 'Memory', slug));
  });

  await t.test(
    'the 0.1.1/0.1.2 marker files migrate into config.json and nothing else moves',
    () => {
      const w = scratch('markers');
      const repo = makeRepo(w, 'theta', 'https://github.com/Example/Theta.git');
      const otherVault = path.join(w.tmp, 'marker-vault');
      fs.mkdirSync(otherVault, { recursive: true });
      write(path.join(w.memHome, 'vault'), `${otherVault}\n`);
      write(path.join(w.memHome, 'recall-enabled'), '');

      runSync(w, repo);

      const cfg = JSON.parse(fs.readFileSync(path.join(w.memHome, 'config.json'), 'utf8'));
      assert.deepStrictEqual(cfg, { vault: otherVault, recall: true });
      assert.ok(!fs.existsSync(path.join(w.memHome, 'vault')));
      assert.ok(!fs.existsSync(path.join(w.memHome, 'recall-enabled')));

      // CHARACTERISED, NOT ENDORSED. The migration writes config.json but the vault for THIS run was
      // already resolved at line 9, before the migration ran — so the first session after an upgrade
      // still builds its tree in the env/default vault and only the NEXT session honours the
      // migrated value. Harmless here (a `mkdir -p` of empty layer dirs), and the ordering comment
      // claims the opposite ("Runs first in the session, so later hooks read the merged result"),
      // which is true of later HOOKS but not of this script. Recorded 2026-08-19, not fixed.
      assert.ok(fs.existsSync(path.join(w.vault, 'Memory', 'github.com-example-theta')));
      assert.ok(
        !fs.existsSync(path.join(otherVault, 'Memory')),
        'config.json is not honoured until next run',
      );
    },
  );

  await t.test('the PAYLOAD cwd wins over $PWD, not the other way round', (st) => {
    // The one decision this suite could not otherwise see. Every other subtest passes the payload
    // cwd AND sets it as the process cwd, so `cat | jq -r '.cwd'` and the `$PWD` fallback agree and
    // two mutants survive: deleting the jq line, and reading the wrong key. That line decides WHICH
    // project's memory symlink gets repointed — a SessionStart fires with the session's cwd in the
    // payload while the hook process may be anywhere. Verified 2026-08-19: with payload=alpha and
    // $PWD=beta, jq present keys the run on alpha; with jq off PATH it keys on beta instead.
    if (!hasJq) return st.skip('jq not installed — the payload arm is unreachable');
    const w = scratch('payload-cwd');
    const payloadRepo = makeRepo(w, 'iota', 'https://github.com/Example/Iota.git');
    const otherRepo = makeRepo(w, 'kappa', 'https://github.com/Example/Kappa.git');

    runSync(w, payloadRepo, otherRepo);

    const mem = path.join(w.home, '.claude', 'projects', slugOf(payloadRepo), 'memory');
    assert.strictEqual(
      fs.readlinkSync(mem),
      path.join(w.vault, 'Memory', 'github.com-example-iota'),
    );
    assert.ok(
      !fs.existsSync(path.join(w.home, '.claude', 'projects', slugOf(otherRepo))),
      'the $PWD project must not be touched when the payload names another',
    );
    assert.ok(!fs.existsSync(path.join(w.vault, 'Memory', 'github.com-example-kappa')));
  });

  await t.test('the real $HOME was never touched', () => {
    // The proof. Every run above got a built env whose HOME pointed into a mkdtemp dir; if any of
    // them had leaked, the real ~/.claude/projects/*/memory symlinks would now point at a scratch
    // vault that is about to be garbage. Tolerates a missing ~/.claude — that is Ubuntu CI.
    // Compared entry by entry against what was recorded BEFORE, never as set equality: a
    // concurrent SessionStart in any other repo creates a new ~/.claude/projects/<slug>/memory
    // during the ~4 s run, and demanding the sets match would fail on that addition — the same
    // cry-wolf this oracle dropped mtimes to avoid, arriving from the other direction
    // (2026-08-19). An ADDED entry cannot be a leak from here; a CHANGED or VANISHED one can,
    // and those still fail.
    const key = (/** @type {string} */ line) => line.split('\t')[0];
    const now = new Map(realHomeFingerprint().map((l) => [key(l), l]));
    for (const line of realBefore) {
      assert.strictEqual(
        now.get(key(line)),
        line,
        `the real ~/.claude changed during this suite: ${key(line)}`,
      );
    }
  });
});
