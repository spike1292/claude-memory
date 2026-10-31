import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyMerge, dropSelfLinks, planMerge, rewriteLinks } from './memory-merge.mjs';

const TODAY = '2026-10-31';
const P = path.join('Insights', 'proj', 'Patterns');
const M = path.join('Insights', 'proj', 'Mistakes');

/** @param {string} title @param {string} body @param {string} aliases */
const note = (title, body, aliases) =>
  `---\ntitle: "${title}"\ndate: 2026-10-01\n---\n\n## ${title}\n\n${body}\n\n_Also asked as: ${aliases}._\n`;

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  /** @param {string} rel @param {string} text */
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  };
  put(
    path.join(P, 'keep.md'),
    note(
      'Keep',
      'Cache at origin. (superseded 2026-10-02 by [[dup-a]]) See [[dup-b|the other]].',
      'where is cache set, Origin Cache',
    ),
  );
  put(
    path.join(P, 'dup-a.md'),
    note(
      'Dup A',
      'Origin owns Cache-Control.\n\nSupersedes a claim in [[keep]].',
      'origin cache, who sets cache-control',
    ),
  );
  put(
    path.join(P, 'dup-b.md'),
    note('Dup B', 'Same lesson, other words.', 'who sets cache-control, cdn headers'),
  );
  put(
    path.join(M, 'other.md'),
    note('Other', 'Links [[dup-a]], [[dup-b#Heading|b]] and [[keep]].', 'x'),
  );
  put(path.join('Memory', 'proj', 'MEMORY.md'), '- [[dup-a]] — a pointer\n');
  put(path.join('.trash', 'old', 'dup-a.md'), 'an older trashed copy, [[dup-b]]\n');
  return vault;
}

/** @param {string} vault @param {string} rel */
const read = (vault, rel) => fs.readFileSync(path.join(vault, rel), 'utf8');

test('a merge folds bodies, unions aliases, rewrites links, and moves the redundant notes', (t) => {
  const vault = fixture(t);
  const plan = planMerge(vault, [['keep', 'dup-a', 'dup-b']], TODAY);
  const dangling = applyMerge(vault, plan);

  assert.deepEqual(dangling, []);
  const keep = read(vault, path.join(P, 'keep.md'));
  assert.match(keep, /\*\*Merged 2026-10-01 \(Dup A\):\*\*\n\nOrigin owns Cache-Control\./);
  assert.match(keep, /\*\*Merged 2026-10-01 \(Dup B\):\*\*\n\nSame lesson, other words\./);
  const aliasLines = keep.match(/^_Also asked as: .*_$/gm);
  assert.deepEqual(aliasLines, [
    '_Also asked as: where is cache set, Origin Cache, who sets cache-control, cdn headers._',
  ]);
  assert.ok(!keep.includes('[[keep'), 'no self-link left in the survivor');
  assert.ok(!keep.includes('Supersedes a claim'), 'the back-link to itself is gone');
  assert.match(keep, /\(superseded 2026-10-02\)/);
  assert.match(keep, /See the other\./);

  assert.match(
    read(vault, path.join(M, 'other.md')),
    /^Links \[\[keep\]\], \[\[keep#Heading\|b\]\] and \[\[keep\]\]\.$/m,
  );
  assert.equal(read(vault, path.join('Memory', 'proj', 'MEMORY.md')), '- [[keep]] — a pointer\n');
  assert.equal(
    read(vault, path.join('.trash', 'old', 'dup-a.md')),
    'an older trashed copy, [[dup-b]]\n',
  );

  for (const n of ['dup-a', 'dup-b']) {
    assert.ok(!fs.existsSync(path.join(vault, P, `${n}.md`)));
    assert.ok(fs.existsSync(path.join(vault, '.trash', `pruned-${TODAY}`, P, `${n}.md`)));
  }
});

test('the whole plan is checked before anything changes', (t) => {
  const vault = fixture(t);
  const before = read(vault, path.join(P, 'keep.md'));
  assert.throws(
    () =>
      planMerge(
        vault,
        [
          ['keep', 'dup-a'],
          ['other', 'nope'],
        ],
        TODAY,
      ),
    /not found in the vault: nope/,
  );
  assert.throws(
    () => planMerge(vault, [['keep', 'other']], TODAY),
    /cross-folder, refusing: other/,
  );
  assert.throws(
    () =>
      planMerge(
        vault,
        [
          ['keep', 'dup-a'],
          ['dup-b', 'dup-a'],
        ],
        TODAY,
      ),
    /named twice/,
  );
  assert.throws(() => planMerge(vault, [['keep']], TODAY), /at least one redundant/);
  assert.equal(read(vault, path.join(P, 'keep.md')), before);
  assert.ok(fs.existsSync(path.join(vault, P, 'dup-a.md')));
});

test('the plan names every file a merge would touch, and planning alone writes nothing', (t) => {
  const vault = fixture(t);
  const before = execFileSync('find', [
    vault,
    '-type',
    'f',
    '-newer',
    path.join(vault, P, 'keep.md'),
  ]);
  const plan = planMerge(vault, [['keep', 'dup-a', 'dup-b']], TODAY);
  assert.deepEqual(
    plan.edits.map((f) => path.relative(vault, f)).sort(),
    [
      path.join(M, 'other.md'),
      path.join('Memory', 'proj', 'MEMORY.md'),
      path.join(P, 'keep.md'),
    ].sort(),
  );
  assert.deepEqual(
    plan.moves.map((m) => path.relative(vault, m.to)),
    ['dup-a', 'dup-b'].map((n) => path.join('.trash', `pruned-${TODAY}`, P, `${n}.md`)),
  );
  assert.deepEqual(
    execFileSync('find', [vault, '-type', 'f', '-newer', path.join(vault, P, 'keep.md')]),
    before,
  );
});

test('the CLI dry run prints the plan and changes nothing', (t) => {
  const vault = fixture(t);
  const entry = fileURLToPath(new URL('../memory-merge.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [entry, '--dry-run', 'keep', 'dup-a'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: vault,
      CLAUDE_VAULT: vault,
      CLAUDE_MEMORY_HOME: path.join(vault, '.state'),
    },
  });
  assert.match(out, /keep {2}<= {2}dup-a/);
  assert.match(out, /--dry-run: nothing changed/);
  assert.ok(fs.existsSync(path.join(vault, P, 'dup-a.md')));
});

test('link rewriting matches whole names only', () => {
  const rename = new Map([['dup', 'keep']]);
  assert.equal(
    rewriteLinks('[[dup]] [[dup|x]] [[dup#h]] [[dup-2]] [[a-dup]]', rename),
    '[[keep]] [[keep|x]] [[keep#h]] [[dup-2]] [[a-dup]]',
  );
  assert.equal(
    dropSelfLinks('a [[keep]] b [[keep|c]] [[keep-2]]', 'keep'),
    'a keep b c [[keep-2]]',
  );
});
