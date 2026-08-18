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
