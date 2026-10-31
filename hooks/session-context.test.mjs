import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('./session-context.mjs', import.meta.url));
const run = (/** @type {string} */ input) =>
  execFileSync(process.execPath, [ENTRY], { input, encoding: 'utf8' });

test('session-context wraps plain stdout as context both Claude Code and Copilot CLI inject (#217)', () => {
  const out = JSON.parse(run('# Memory (plugin: /x)\nrules\n'));
  assert.strictEqual(out.additionalContext, '# Memory (plugin: /x)\nrules');
  assert.deepStrictEqual(out.hookSpecificOutput, {
    hookEventName: 'SessionStart',
    additionalContext: '# Memory (plugin: /x)\nrules',
  });
});

test('session-context prints nothing for empty input', () => {
  assert.strictEqual(run('\n'), '');
});
