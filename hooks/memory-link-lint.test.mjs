// Tests for the hooks/memory-link-lint.mjs ENTRY — the part hooks/lib/dupe-report.test.mjs cannot
// see: the node:sqlite reader, which only an entry may own. Real subprocess, real SQLite index,
// isolated HOME, vault and $CLAUDE_MEMORY_HOME.
// Run: node --test hooks/memory-link-lint.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_MODEL } from '../scripts/lib/model-default.mjs';
import { MODELS } from '../scripts/lib/models.mjs';
import { CARD } from '../scripts/lib/lexical.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory-link-lint.mjs');
const { id: MODEL, dim: DIM } = MODELS[DEFAULT_MODEL];

test('the entry reads the real index: duplicate pairs on the first start of the day only', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lint-entry-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const [home, state, vault, cwd, notes] = ['home', 'state', 'vault', 'proj', 'notes'].map((d) => {
    fs.mkdirSync(path.join(root, d));
    return path.join(root, d);
  });
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, HOME: home, CLAUDE_MEMORY_HOME: state, CLAUDE_VAULT: vault };
  delete env.MEMORY_SEMANTIC_MODEL;
  const slug = execFileSync(
    process.execPath,
    [
      '-e',
      `import('${new URL('./lib/paths.mjs', import.meta.url)}').then(p => process.stdout.write(p.projectKey(process.argv[1])))`,
      cwd,
    ],
    { env, encoding: 'utf8' },
  );

  fs.mkdirSync(path.join(state, 'db'));
  const db = new DatabaseSync(path.join(state, 'db', `semantic-${slug}-${DEFAULT_MODEL}.db`));
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  db.exec(
    'CREATE TABLE chunks (note TEXT, layer TEXT, file TEXT, heading TEXT, text TEXT, vec BLOB)',
  );
  db.prepare("INSERT INTO meta VALUES ('model', ?)").run(MODEL);
  const ins = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)');
  for (const [note, heading] of [
    ['a', CARD],
    ['b', CARD],
    ['a', 'Some section'],
  ]) {
    const v = new Float32Array(DIM);
    v[0] = 1; // the section twin would make 3 pairs if the reader stopped filtering on CARD
    const file = path.join(notes, `${note}.md`);
    fs.writeFileSync(file, `---\nname: ${note}\n---\n\nbody\n`);
    ins.run(note, 'Patterns', file, heading, '', new Uint8Array(v.buffer));
  }
  db.close();

  const run = () =>
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', HOOK], {
      input: JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
      encoding: 'utf8',
      env,
    });
  const first = run();
  assert.match(first, /1 same-folder duplicate pair/);
  assert.match(first, /1\.000 \[Patterns\] a \/ b/);
  assert.doesNotMatch(run(), /duplicate pair/, 'second start the same day stays quiet');
});
