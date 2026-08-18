// Tests for hooks/lib/env-shell.mjs. Run: node --test hooks/lib/env-shell.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { shellQuote, render, resolve, VARS } from './env-shell.mjs';

test('shellQuote survives everything a vault path can contain', () => {
  // This output is eval'd by vault-env.sh. A bare $ or backtick would expand; an unescaped quote
  // would end the string and run whatever followed it.
  const nasty = [
    "it's",
    '$HOME',
    '`whoami`',
    '$(rm -rf /)',
    'a b\tc',
    'back\\slash',
    "'; echo pwned; '",
    '"double"',
    'newline\nhere',
    '',
  ];
  for (const v of nasty) {
    // The oracle is bash itself: echo it back and compare byte for byte.
    const out = execFileSync('bash', ['-c', `printf '%s' ${shellQuote(v)}`], { encoding: 'utf8' });
    assert.strictEqual(out, v, JSON.stringify(v));
  }
});

test('render emits every contract variable, even when unset', () => {
  const out = render({});
  for (const k of VARS) assert.match(out, new RegExp(`^${k}='`, 'm'), k);
  assert.strictEqual(out.trim().split('\n').length, VARS.length);
});

test('render output is eval-safe and round-trips through bash', () => {
  const values = Object.fromEntries(VARS.map((k) => [k, `v'alue $for ${k}`]));
  const script = `${render(values)}\nprintf '%s' "$MEMORY_ENV_VAULT"`;
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.strictEqual(out, values.MEMORY_ENV_VAULT);
});

test('resolve degrades to the legacy slug rather than throwing', () => {
  // projectKey shells out to git; a hook must get an answer, not an exception.
  const r = resolve('/nonexistent/directory/for/this/test');
  assert.strictEqual(typeof r.MEMORY_ENV_PROJECT_KEY, 'string');
  assert.ok(r.MEMORY_ENV_PROJECT_KEY.length > 0);
  assert.strictEqual(r.MEMORY_ENV_LEGACY_KEY, '-nonexistent-directory-for-this-test');
});

test('recall is reported as effective AND as configured', () => {
  // /memory:doctor tells the two apart so it can warn that env-only arming does not survive a
  // value written mid-session — the 2026-08-15 failure.
  const prev = process.env.MEMORY_RECALL_ENABLED;
  process.env.MEMORY_RECALL_ENABLED = '1';
  try {
    const r = resolve(process.cwd());
    assert.strictEqual(r.MEMORY_ENV_RECALL, '1', 'env arms it');
  } finally {
    if (prev === undefined) delete process.env.MEMORY_RECALL_ENABLED;
    else process.env.MEMORY_RECALL_ENABLED = prev;
  }
});
