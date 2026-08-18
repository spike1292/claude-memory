// Tests for hooks/lib/hook-io.mjs. Run: node --test hooks/lib/hook-io.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  payload,
  hookCwd,
  withinDebounce,
  nowSeconds,
  countLines,
  systemMessage,
  readMarker,
  writeMarker,
  logBanner,
  detach,
} from './hook-io.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hookio-'));

test('payload never throws — bad input is an empty payload', () => {
  assert.deepStrictEqual(payload('{"cwd":"/x"}'), { cwd: '/x' });
  assert.deepStrictEqual(payload(''), {});
  assert.deepStrictEqual(payload('not json'), {});
  assert.deepStrictEqual(payload('null'), {}, 'null parses but is not an object');
  // A hook that dies on its own input is worse than one that does nothing.
  assert.deepStrictEqual(payload(undefined), {});
});

test('hookCwd falls back to process.cwd()', () => {
  assert.strictEqual(hookCwd({ cwd: '/a' }), '/a');
  assert.strictEqual(hookCwd({}), process.cwd());
  assert.strictEqual(hookCwd(undefined), process.cwd());
});

test('withinDebounce treats a MISSING marker as not-recent', () => {
  // The bug this guards: `now - 0 < window` is false only for windows smaller than the epoch, so a
  // naive check reads "no marker" as "just ran" and the feature never fires at all.
  assert.strictEqual(withinDebounce(0, 7200, 1_000_000), false);
  assert.strictEqual(withinDebounce(1_000_000 - 10, 7200, 1_000_000), true);
  assert.strictEqual(withinDebounce(1_000_000 - 7200, 7200, 1_000_000), false, 'boundary is open');
  assert.strictEqual(withinDebounce(1_000_000 - 7201, 7200, 1_000_000), false);
});

test('nowSeconds is whole seconds, matching the marker file unit', () => {
  assert.strictEqual(nowSeconds(1_700_000_123_456), 1_700_000_123);
  assert.strictEqual(Number.isInteger(nowSeconds()), true);
});

test('markers round-trip, and unreadable ones read as 0', () => {
  const d = tmp();
  const f = path.join(d, 'm.ts');
  assert.strictEqual(readMarker(f), 0, 'absent');
  writeMarker(f, 1_700_000_000);
  assert.strictEqual(readMarker(f), 1_700_000_000);
  fs.writeFileSync(f, 'garbage\n');
  assert.strictEqual(readMarker(f), 0, 'non-numeric is 0, not NaN');
});

test('countLines matches wc -l semantics', () => {
  const d = tmp();
  const f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, 'a\nb\nc\n');
  assert.strictEqual(countLines(f), 3);
  fs.writeFileSync(f, 'a\nb\nc');
  assert.strictEqual(countLines(f), 2, 'no trailing newline — same as wc -l');
  fs.writeFileSync(f, '');
  assert.strictEqual(countLines(f), 0);
  assert.strictEqual(countLines(path.join(d, 'nope')), 0, 'missing file is 0, not a throw');
});

test('systemMessage is one JSON line Claude Code can render', () => {
  assert.deepStrictEqual(JSON.parse(systemMessage('hi "there"')), { systemMessage: 'hi "there"' });
});

test('logBanner caps a runaway log and keeps the most recent content', () => {
  const d = tmp();
  const f = path.join(d, 'semantic-index.log');
  // 1.5 MB of numbered lines, so "which lines survived" is checkable.
  const lines = [];
  for (let i = 0; i < 60_000; i++) lines.push(`line ${i} ${'x'.repeat(16)}`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.ok(fs.statSync(f).size > 1024 * 1024, 'precondition: over the cap');

  logBanner(f, 'bench', '2026-08-18T00:00:00Z');

  const after = fs.readFileSync(f, 'utf8');
  assert.ok(fs.statSync(f).size <= 1024 * 1024, 'trimmed to at or below the cap');
  assert.ok(after.endsWith('=== 2026-08-18T00:00:00Z bench ===\n'), 'banner still appended');
  assert.ok(after.includes('line 59999 '), 'the newest content survived');
  assert.ok(!after.includes('line 0 '), 'the oldest content is gone');
  assert.ok(after.startsWith('line '), 'the partial first line was dropped');
});

test('logBanner leaves a small log alone, and creates a missing one', () => {
  const d = tmp();
  const f = path.join(d, 'nested', 'distill.log');
  logBanner(f, 'a', '2026-08-18T00:00:00Z');
  logBanner(f, 'b', '2026-08-18T00:00:01Z');
  const s = fs.readFileSync(f, 'utf8');
  assert.ok(s.includes(' a ==='), 'nothing below the cap is ever trimmed');
  assert.ok(s.includes(' b ==='));
});

// detach() opens distill.log and graphgen.log, which logBanner never touches — the cap has to hold
// on this path too, and it did not when the trim lived only in logBanner.
test('detach caps a runaway log before the child writes to it', async () => {
  const d = tmp();
  const f = path.join(d, 'distill.log');
  const lines = [];
  for (let i = 0; i < 60_000; i++) lines.push(`line ${i} ${'x'.repeat(16)}`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.ok(fs.statSync(f).size > 1024 * 1024, 'precondition: over the cap');

  assert.ok(
    detach(process.execPath, ['-e', 'process.stdout.write("child ran\\n")'], { logFile: f }),
  );
  for (let i = 0; i < 100 && !fs.readFileSync(f, 'utf8').includes('child ran'); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }

  const after = fs.readFileSync(f, 'utf8');
  assert.ok(fs.statSync(f).size <= 1024 * 1024, 'trimmed to at or below the cap');
  assert.ok(after.includes('child ran'), 'the child still appended to the trimmed file');
  assert.ok(after.includes('line 59999 '), 'the newest content survived');
  assert.ok(!after.includes('line 0 '), 'the oldest content is gone');
});
