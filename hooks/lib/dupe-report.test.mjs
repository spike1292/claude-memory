import test from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectKey, stateDir } from './paths.mjs';
import { dupeReport } from './dupe-report.mjs';
import { activeModel } from '../../scripts/lib/model-default.mjs';
import { MODELS } from '../../scripts/lib/models.mjs';

const KEY = activeModel();
const { id: MODEL, dim: DIM } = MODELS[KEY];

/** A unit vector along `axis`, nudged toward axis+1 by `tilt` — same axis ⇒ near-duplicate. */
const vec = (/** @type {number} */ axis, tilt = 0) => {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  v[axis + 1] = tilt;
  return new Uint8Array(v.buffer);
};

/**
 * What the entry's node:sqlite reader returns, by DB path. lib/ may not import node:sqlite (CI),
 * so the tests stand in for the handle; a `fail` index throws like a busy or broken read.
 * @type {Map<string, { model: string, rows: import('./dupe-report.mjs').CardRow[], fail?: boolean }>}
 */
const indexes = new Map();
/** @type {import('./dupe-report.mjs').ReadIndex} */
const read = (dbPath) => {
  const i = indexes.get(dbPath);
  if (!i || i.fail) throw new Error('unreadable index');
  return { model: i.model, rows: i.rows };
};
const dbOf = (/** @type {string} */ cwd) =>
  path.join(stateDir('db'), `semantic-${projectKey(cwd)}-${KEY}.db`);

/**
 * A project dir, a vault folder of notes, and an index of their CARD vectors.
 * @param {{ note: string, layer: string, axis: number, tilt?: number, manual?: boolean }[]} notes
 * @param {{ model?: string }} [opts]
 */
const project = (notes, { model = MODEL } = {}) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-proj-'));
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-notes-'));
  const rows = notes.map((n) => {
    const file = path.join(notesDir, `${n.note}.md`);
    const fm = n.manual ? 'reconcile: manual\n' : '';
    fs.writeFileSync(file, `---\nname: ${n.note}\n${fm}---\n\nbody of ${n.note}\n`);
    return { note: n.note, layer: n.layer, file, vec: vec(n.axis, n.tilt) };
  });
  fs.writeFileSync(dbOf(cwd), '');
  indexes.set(dbOf(cwd), { model, rows });
  return { cwd, notesDir };
};

/** @param {string} dir */
const snapshot = (dir) =>
  Object.fromEntries(
    fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]),
  );

/** @param {(t: import('node:test').TestContext) => Promise<void>} fn */
const isolated = (fn) => async (/** @type {import('node:test').TestContext} */ t) => {
  const prev = process.env.CLAUDE_MEMORY_HOME;
  process.env.CLAUDE_MEMORY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-state-'));
  try {
    await fn(t);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_MEMORY_HOME;
    else process.env.CLAUDE_MEMORY_HOME = prev;
  }
};

const NOW = new Date('2026-10-10T09:00:00Z');

test(
  'names the count and the top pairs once per project per day, and touches no note',
  isolated(async () => {
    const { cwd, notesDir } = project([
      { note: 'a', layer: 'Patterns', axis: 0 },
      { note: 'b', layer: 'Patterns', axis: 0, tilt: 0.05 },
      { note: 'c', layer: 'Decisions', axis: 0 }, // cross-folder twin: not a duplicate
      { note: 'd', layer: 'Patterns', axis: 10 },
    ]);
    const before = snapshot(notesDir);

    const text = await dupeReport(cwd, read, NOW);
    assert.match(text, /1 same-folder duplicate pair/);
    assert.match(text, /\[Patterns\] a \/ b/);
    assert.doesNotMatch(text, / c\b| d\b/);

    assert.equal(
      await dupeReport(cwd, read, NOW),
      '',
      'second session, same day: already reported',
    );
    assert.match(await dupeReport(cwd, read, new Date('2026-10-11T09:00:00Z')), /1 same-folder/);
    assert.deepEqual(snapshot(notesDir), before);
  }),
);

test(
  'a second project on the same day still gets its own report',
  isolated(async () => {
    const one = project([
      { note: 'a', layer: 'P', axis: 0 },
      { note: 'b', layer: 'P', axis: 0 },
    ]);
    const two = project([
      { note: 'x', layer: 'P', axis: 3 },
      { note: 'y', layer: 'P', axis: 3 },
    ]);
    assert.match(await dupeReport(one.cwd, read, NOW), /\[P\] a \/ b/);
    assert.match(await dupeReport(two.cwd, read, NOW), /\[P\] x \/ y/);
  }),
);

test(
  'a pair with either note marked reconcile: manual is neither shown nor counted',
  isolated(async () => {
    const { cwd } = project([
      { note: 'a', layer: 'P', axis: 0 },
      { note: 'b', layer: 'P', axis: 0, manual: true },
      { note: 'c', layer: 'P', axis: 5 },
      { note: 'd', layer: 'P', axis: 5 },
    ]);
    const text = await dupeReport(cwd, read, NOW);
    assert.match(text, /1 same-folder duplicate pair/);
    assert.match(text, /c \/ d/);
    assert.doesNotMatch(text, /a \/ b/);
  }),
);

test(
  'zero pairs adds nothing, and the day is still claimed',
  isolated(async () => {
    const { cwd } = project([
      { note: 'a', layer: 'P', axis: 0 },
      { note: 'b', layer: 'P', axis: 5 },
    ]);
    assert.equal(await dupeReport(cwd, read, NOW), '');
    assert.equal(
      fs.readdirSync(stateDir('logs')).filter((f) => f.startsWith('.dupes-')).length,
      1,
      'a clean scan still spends the day',
    );
  }),
);

test(
  'no index, or one built by another model, reports nothing and spends no claim',
  isolated(async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-proj-'));
    assert.equal(await dupeReport(bare, read, NOW), '');

    const { cwd } = project(
      [
        { note: 'a', layer: 'P', axis: 0 },
        { note: 'b', layer: 'P', axis: 0 },
      ],
      { model: 'some/other-model' },
    );
    assert.equal(await dupeReport(cwd, read, NOW), '');
    assert.deepEqual(
      fs.readdirSync(stateDir('logs')).filter((f) => f.startsWith('.dupes-')),
      [],
    );
  }),
);

test(
  'a scan that fails after the index check spends no claim, so a later session still reports',
  isolated(async () => {
    const { cwd } = project([
      { note: 'a', layer: 'P', axis: 0 },
      { note: 'b', layer: 'P', axis: 0 },
    ]);
    const idx = /** @type {{ fail?: boolean }} */ (indexes.get(dbOf(cwd)));
    idx.fail = true;
    assert.equal(await dupeReport(cwd, read, NOW), '');
    idx.fail = false;
    assert.match(await dupeReport(cwd, read, NOW), /1 same-folder duplicate pair/);
  }),
);

test(
  'one vector of the wrong width reports nothing rather than a partial list',
  isolated(async () => {
    const { cwd } = project([
      { note: 'a', layer: 'P', axis: 0 },
      { note: 'b', layer: 'P', axis: 0 },
    ]);
    indexes.get(dbOf(cwd))?.rows.push({ note: 'c', layer: 'P', file: '', vec: new Uint8Array(4) });
    assert.equal(await dupeReport(cwd, read, NOW), '');
  }),
);
