// #170: inside ctx_execute, CLAUDE_PLUGIN_ROOT is context-mode's root, not ours. The preamble
// must only trust it when it is this plugin. Runs the lines as shipped, not a copy of them.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = path.join(ROOT, 'commands');

/** @param {string} file */
function preamble(file) {
  const lines = fs
    .readFileSync(path.join(COMMANDS, file), 'utf8')
    .split('\n')
    .map((l) => l.replace(/^>\s*/, '').trim());
  return {
    state: lines.filter((l) => l.startsWith('STATE=')),
    mem: lines.filter((l) => l.startsWith('MEM=')),
  };
}

const FILES = fs.readdirSync(COMMANDS).filter((f) => f.endsWith('.md'));

test('every command body carries exactly one copy of the same preamble', () => {
  assert.ok(FILES.length > 0, 'expected command files to scan');
  const seen = new Set();
  for (const f of FILES) {
    const { state, mem } = preamble(f);
    assert.equal(state.length, 1, `${f}: expected one STATE= line`);
    assert.equal(mem.length, 1, `${f}: expected one MEM= line`);
    seen.add(`${state[0]}\n${mem[0]}`);
  }
  assert.equal(seen.size, 1, `preambles differ:\n${[...seen].join('\n---\n')}`);
});

/** @param {Record<string, string | undefined>} env */
function resolveMem(env) {
  const { state, mem } = preamble(FILES[0]);
  const clean = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete clean[k];
  return execFileSync('bash', ['-uc', `${state[0]}\n${mem[0]}\nprintf %s "$MEM"`], {
    env: clean,
    encoding: 'utf8',
  });
}

test('MEM resolves to this plugin whether CLAUDE_PLUGIN_ROOT is unset, foreign or ours', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'preamble-'));
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'context-mode-'));
  const crumb = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-'));
  fs.writeFileSync(path.join(home, 'plugin-root'), crumb);
  try {
    const base = { CLAUDE_MEMORY_HOME: home };
    assert.equal(resolveMem({ ...base, CLAUDE_PLUGIN_ROOT: undefined }), crumb, 'unset');
    assert.equal(resolveMem({ ...base, CLAUDE_PLUGIN_ROOT: foreign }), crumb, 'foreign');
    assert.equal(resolveMem({ ...base, CLAUDE_PLUGIN_ROOT: ROOT }), ROOT, 'ours');
  } finally {
    for (const d of [home, foreign, crumb]) fs.rmSync(d, { recursive: true });
  }
});
