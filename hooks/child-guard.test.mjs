// Every Node hook entry stands down inside a headless child run (#200). Real subprocesses,
// isolated HOME, vault and $CLAUDE_MEMORY_HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOKS = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
const ENTRIES = [
  ...new Set(
    Object.values(manifest.hooks)
      .flat()
      .flatMap((/** @type {{ hooks: { command: string }[] }} */ g) => g.hooks)
      .map((h) => h.command.match(/hooks\/([\w-]+)\.mjs/)?.[1])
      .filter(Boolean),
  ),
];

test('the manifest scan found the Node entries', () => {
  assert.ok(ENTRIES.length >= 7, `found ${ENTRIES}`);
});

for (const flag of ['CLAUDE_DISTILL_CHILD', 'CBM_GRAPHGEN_CHILD']) {
  for (const hook of ENTRIES) {
    test(`${hook} stands down with ${flag}=1`, (t) => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'child-guard-')));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const [home, state, vault, cwd] = ['home', 'state', 'vault', 'proj'].map((d) => {
        fs.mkdirSync(path.join(root, d));
        return path.join(root, d);
      });
      const r = spawnSync(process.execPath, [path.join(HOOKS, `${hook}.mjs`)], {
        cwd,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDE_MEMORY_HOME: state,
          CLAUDE_VAULT: vault,
          MEMORY_RECALL_ENABLED: '1',
          [flag]: '1',
        },
        input: JSON.stringify({
          cwd,
          session_id: 's1',
          hook_event_name: 'SessionStart',
          prompt: 'a prompt long enough to pass every length gate there is',
          transcript_path: path.join(root, 'none.jsonl'),
          tool_input: { file_path: path.join(vault, 'x.md') },
        }),
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '', 'injects nothing');
      const day = new Date().toISOString().slice(0, 10);
      const lines = fs
        .readFileSync(path.join(state, 'logs', `hooks-${day}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      assert.deepEqual(
        lines.map((l) => [l.hook, l.outcome]),
        [[hook, 'child-guard']],
      );
      assert.deepEqual(fs.readdirSync(vault), [], 'no vault folder made');
      assert.ok(!fs.existsSync(path.join(state, 'db')), 'no index made');
    });
  }
}
