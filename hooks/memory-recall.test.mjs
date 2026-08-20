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
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory-recall.mjs');

/** @type {string[]} */
const homes = [];
test.after(() => {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});

/**
 * @param {{ prompt: string, recall?: boolean }} options
 * @returns {{ status: number, stdout: string, lines: Record<string, any>[], home: string }}
 */
function run({ prompt, recall = true }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-entry-'));
  homes.push(home);
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', HOOK], {
      input: JSON.stringify({ prompt, cwd: process.cwd() }),
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
  return { status, stdout, lines, home };
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
