import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraftStatus, adopt } from './memory-adopt.mjs';

const UNDRAFTED = '---\ntype: promotion-candidate\nstatus: proposed\n---\n\nskeleton\n';
const DRAFTED = '---\ntype: permanent\nconfidence: high\n---\n\n## Real title\n\ncontent\n';
const NO_FRONTMATTER = 'just prose, no frontmatter at all\n';

test('checkDraftStatus reads the frontmatter type line only', () => {
  assert.equal(checkDraftStatus(UNDRAFTED), 'undrafted');
  assert.equal(checkDraftStatus(DRAFTED), 'ready');
  assert.equal(checkDraftStatus(NO_FRONTMATTER), 'wrong-type');
  // a drafted note that happens to quote its own history must not be mistaken for the skeleton
  const quoting =
    '---\ntype: permanent\n---\n\nThis note used to say "type: promotion-candidate".\n';
  assert.equal(checkDraftStatus(quoting), 'ready');
});

/** @param {Partial<import('./memory-adopt.mjs').AdoptIO>} overrides */
function fakeIo(overrides = {}) {
  /** @type {Record<string, string>} */
  const files = { '/staged.md': DRAFTED };
  const calls = { reindex: 0, gate: 0, removed: /** @type {string[]} */ ([]) };
  return {
    calls,
    io: {
      readFile: (/** @type {string} */ p) => files[p],
      writeFile: (/** @type {string} */ p, /** @type {string} */ s) => {
        files[p] = s;
      },
      removeFile: (/** @type {string} */ p) => {
        calls.removed.push(p);
        delete files[p];
      },
      exists: (/** @type {string} */ p) => p in files,
      reindex: () => {
        calls.reindex++;
      },
      runGate: () => {
        calls.gate++;
        return { failures: [] };
      },
      ...overrides,
    },
  };
}

test('adopt refuses an undrafted proposal and writes nothing', () => {
  const { io, calls } = fakeIo({ readFile: () => UNDRAFTED });
  const r = adopt(io, {
    stagedPath: '/staged.md',
    targetPath: '/permanent/x.md',
    dryRun: false,
    force: false,
  });
  assert.equal(r.status, 'undrafted');
  assert.equal(calls.reindex, 0);
});

test('adopt refuses a note that never took the permanent shape', () => {
  const { io } = fakeIo({ readFile: () => NO_FRONTMATTER });
  const r = adopt(io, {
    stagedPath: '/staged.md',
    targetPath: '/permanent/x.md',
    dryRun: false,
    force: false,
  });
  assert.equal(r.status, 'wrong-type');
});

test('adopt refuses to overwrite an existing target without --force', () => {
  const { io } = fakeIo({ exists: () => true });
  const r = adopt(io, {
    stagedPath: '/staged.md',
    targetPath: '/permanent/x.md',
    dryRun: false,
    force: false,
  });
  assert.equal(r.status, 'exists');
});

test('adopt --force overwrites an existing target and still runs the gate', () => {
  const { io, calls } = fakeIo({ exists: () => true });
  const r = adopt(io, {
    stagedPath: '/staged.md',
    targetPath: '/permanent/x.md',
    dryRun: false,
    force: true,
  });
  assert.equal(r.status, 'adopted');
  assert.equal(calls.gate, 1);
});

test('adopt --dry-run writes nothing and never runs the gate', () => {
  const { io, calls } = fakeIo();
  const r = adopt(io, {
    stagedPath: '/staged.md',
    targetPath: '/permanent/x.md',
    dryRun: true,
    force: false,
  });
  assert.equal(r.status, 'dry-run');
  assert.equal(calls.reindex, 0);
  assert.equal(calls.gate, 0);
});

test('adopt writes to permanent/, reindexes, and clears the staging file on a passing gate', () => {
  const { io, calls } = fakeIo();
  const r = adopt(io, {
    stagedPath: '/staged.md',
    targetPath: '/permanent/x.md',
    dryRun: false,
    force: false,
  });
  assert.equal(r.status, 'adopted');
  assert.equal(calls.reindex, 1);
  assert.deepEqual(calls.removed, ['/staged.md']);
});

test('adopt rolls back permanent/ and reindexes again on a failing gate, and names the reasons', () => {
  const { io, calls } = fakeIo({
    runGate: () => {
      calls.gate++;
      return { failures: ['recall@1 40.0% is below the floor 60.0%'] };
    },
  });
  const r = adopt(io, {
    stagedPath: '/staged.md',
    targetPath: '/permanent/x.md',
    dryRun: false,
    force: false,
  });
  assert.equal(r.status, 'rejected');
  assert.deepEqual(r.reasons, ['recall@1 40.0% is below the floor 60.0%']);
  assert.equal(calls.reindex, 2, 'one to pick up the new note, one to undo it');
  assert.deepEqual(
    calls.removed,
    ['/permanent/x.md'],
    'the staged proposal is left in place to retry',
  );
});
