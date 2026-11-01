// Tests for the hooks/memory-recall.mjs ENTRY — the parts hooks/lib/memory-recall.test.mjs cannot
// see, because they belong to the process rather than to the arms: the arming gate, the fail-open
// exit code, and the `ms` stamp, which exists only here because only the entry owns the clock.
// Run: node --test hooks/memory-recall.test.mjs
//
// The hook is run as a real subprocess with an isolated $CLAUDE_MEMORY_HOME. It never reaches the
// socket or a database here: with no index file it takes the 'no index' branch, which is a full
// pass through the arming gate, the payload parse and the logger.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory-recall.mjs');

/** @type {string[]} */
const homes = [];
test.after(() => {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});

/**
 * @param {{ prompt: string, recall?: boolean, extra?: Record<string, unknown> }} options
 * @returns {{ status: number, stdout: string, lines: Record<string, any>[], hookLines: Record<string, any>[], home: string }}
 */
function run({ prompt, recall = true, extra = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-entry-'));
  homes.push(home);
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', HOOK], {
      input: JSON.stringify({ prompt, cwd: process.cwd(), ...extra }),
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_MEMORY_HOME: home,
        MEMORY_RECALL_ENABLED: recall ? '1' : '0',
      },
    });
  } catch (e) {
    const err = /** @type {{ status?: number, stdout?: string }} */ (e);
    status = err.status ?? 1;
    stdout = err.stdout ?? '';
  }
  const dir = path.join(home, 'logs');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith('recall-'))
    : [];
  const lines = files.flatMap((f) =>
    fs
      .readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
  const hookFile = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => f.startsWith('hooks-'));
  const hookLines = hookFile
    ? fs
        .readFileSync(path.join(dir, hookFile), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
  return { status, stdout, lines, hookLines, home };
}

// The gates were tuned without live data and the reader half of this is worth nothing if the
// latency is missing: an unmeasured recall must not be indistinguishable from a fast one.
test('the entry stamps ms on the record and still exits 0 with no index', () => {
  const r = run({ prompt: 'what did we decide about the cutover and the rollback plan' });
  assert.equal(r.status, 0, 'recall must never block a prompt');
  assert.equal(r.stdout, '', 'no index means no brief');
  assert.equal(r.lines.length, 1);
  const [line] = r.lines;
  assert.match(line.reason, /^no index at semantic-/);
  assert.equal(line.abstained, true);
  assert.equal(typeof line.ms, 'number');
  assert.ok(line.ms >= 0 && line.ms < 60_000, `implausible elapsed time: ${line.ms}`);
  assert.equal(typeof line.t, 'string');
});

test('disarmed, the entry logs nothing at all', () => {
  const r = run({ prompt: 'what did we decide about the cutover', recall: false });
  assert.equal(r.status, 0);
  assert.deepEqual(r.lines, [], 'recall ships inert; an unarmed install leaves no trace');
});

// MIN_PROMPT: a one-word prompt has no retrievable intent, and exits before the logger exists.
test('a prompt below MIN_PROMPT exits 0 without a record', () => {
  const r = run({ prompt: 'hi' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.lines, []);
});

test('under Copilot, recall skips UserPromptSubmit and runs on userPromptTransformed (#217)', () => {
  const prompt = 'what did we decide about the cutover and the rollback plan';
  const submit = run({
    prompt,
    extra: {
      hook_event_name: 'UserPromptSubmit',
      session_id: 's',
      timestamp: '2026-10-31T00:00:00Z',
    },
  });
  assert.equal(submit.lines.length, 0, 'Copilot drops this output, so recall must not run twice');
  assert.deepEqual(
    submit.hookLines.map((l) => [l.event, l.outcome, l.harness]),
    [['UserPromptSubmit', 'debounced', 'copilot']],
  );

  const transformed = run({
    prompt,
    extra: { sessionId: 's', timestamp: 1, transformedPrompt: prompt },
  });
  assert.equal(transformed.lines.length, 1, 'reaches the index lookup');
  assert.deepEqual(
    transformed.hookLines.map((l) => [l.event, l.session, l.harness]),
    [['userPromptTransformed', 's', 'copilot']],
  );
});

// ---------------------------------------------------------------- --preview round trip (#226)

/**
 * An isolated home with an index and a stand-in `--serve` that answers every query with `reply`.
 * @param {unknown} reply
 */
async function indexed(reply) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')));
  homes.push(home);
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd);
  const saved = process.env.CLAUDE_MEMORY_HOME;
  process.env.CLAUDE_MEMORY_HOME = home;
  const { projectKey, stateDir } = await import('./lib/paths.mjs');
  const { activeModel } = await import('../scripts/lib/model-default.mjs');
  const { CARD } = await import('./lib/memory-recall.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(
    path.join(stateDir('db'), `semantic-${projectKey(cwd)}-${activeModel()}.db`),
  );
  db.exec('CREATE TABLE chunks (note TEXT, layer TEXT, heading TEXT, text TEXT)');
  const add = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)');
  add.run(
    'rollback-plan',
    'Memory',
    CARD,
    'rollback-plan\nThe cutover rollback plan restores the old cluster.',
  );
  add.run('sourdough', 'Memory', CARD, 'sourdough\nProof overnight in the fridge.');
  // BM25's MIN_SCORE is calibrated on a real corpus; two cards give every term too little idf.
  for (let i = 0; i < 40; i++)
    add.run(`filler-${i}`, 'Memory', CARD, `filler-${i}\nGardening ${i}.`);
  db.close();
  const server = net.createServer((s) => s.end(JSON.stringify(reply) + '\n'));
  await new Promise((r) =>
    server.listen(path.join(stateDir('run'), `search-${activeModel()}.sock`), () => r(null)),
  );
  if (saved === undefined) delete process.env.CLAUDE_MEMORY_HOME;
  else process.env.CLAUDE_MEMORY_HOME = saved;
  test.after(() => server.close());

  /** @param {string[]} args @param {{ input?: string, recall?: boolean }} [o] */
  const exec = (args, { input = '', recall = true } = {}) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOOK, ...args], {
        env: {
          ...process.env,
          CLAUDE_MEMORY_HOME: home,
          MEMORY_RECALL_ENABLED: recall ? '1' : '0',
        },
      });
      let stdout = '';
      c.stdout.on('data', (d) => (stdout += d));
      c.on('close', () => resolve(stdout));
      c.stdin.end(input);
    });
  const logs = () =>
    fs.existsSync(path.join(home, 'logs')) ? fs.readdirSync(path.join(home, 'logs')) : [];
  return {
    cwd,
    logs,
    /** @param {string} prompt */
    hook: (prompt) => exec([], { input: JSON.stringify({ prompt, cwd }) }),
    /** @param {string[]} args */
    preview: (args) => exec(['--preview', '--cwd', cwd, ...args], { recall: false }),
  };
}

const PROMPT = 'what did we decide about the cutover rollback plan';

for (const [arm, reply] of [
  [
    'server',
    {
      results: [
        {
          note: 'rollback-plan',
          layer: 'Memory',
          score: 0.8,
          text: 'rollback-plan\nRestores the old cluster.',
        },
        { note: 'sourdough', layer: 'Memory', score: 0.6, text: 'sourdough\nProof overnight.' },
      ],
    },
  ],
  ['keyword fallback', { results: [] }],
])
  test(`--preview prints the bytes the hook injects — ${arm} arm`, async () => {
    const r = await indexed(reply);
    const preview = await r.preview(PROMPT.split(' '));
    assert.deepEqual(
      r.logs(),
      [],
      'a preview is not a recall decision and must not be logged as one',
    );
    const hook = await r.hook(PROMPT);
    assert.match(hook, /\[\[rollback-plan\]\]/, 'the round trip must compare a real brief');
    assert.equal(preview, hook);
  });

test('--preview --file queries on the path, as the hook would on the same query', async () => {
  const r = await indexed({ results: [] });
  const { fileQuery } = await import('./lib/paths.mjs');
  const file = 'ops/cutover/rollback-plan.md';
  const preview = await r.preview(['--file', file]);
  assert.match(preview, /\[\[rollback-plan\]\]/);
  assert.equal(preview, await r.hook(fileQuery(file, r.cwd)));
});
