// Tests for the retention line scripts/doctor.sh prints. Run: node --test scripts/doctor-retention.test.mjs
//
// The only shell in this change, and until now the only part of it nothing exercised. Both defects
// this pins were found by review rather than by a test: the `sed` matched any `<prefix>-<date>`
// and read a stray file as ours (reporting retention as years overdue), and the number comes from
// the single resolver through `MEMORY_ENV_LOG_RETENTION_DAYS`, which nothing else runs end to end.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DOCTOR = fileURLToPath(new URL('./doctor.sh', import.meta.url));

/** @param {string[]} names @param {Record<string,string>} [env] @returns {string} */
const retentionLine = (names, env = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-ret-'));
  fs.mkdirSync(path.join(home, 'logs'));
  for (const n of names) fs.writeFileSync(path.join(home, 'logs', n), '{}\n');
  // HOME too, not just CLAUDE_MEMORY_HOME: doctor.sh reads the real vault otherwise, and a report
  // that touches someone's notes is not a test.
  const out = execFileSync('bash', [DOCTOR], {
    env: {
      ...process.env,
      CLAUDE_MEMORY_HOME: home,
      HOME: home,
      CLAUDE_VAULT: path.join(home, 'vault'),
      ...env,
    },
    encoding: 'utf8',
  });
  return out.split('\n').find((l) => l.includes('dated files')) ?? '';
};

test('doctor reports the window and the oldest file, and only ours count as ours', () => {
  const line = retentionLine([
    'backup-2018-05-05.jsonl', // a human's file with a plausible prefix
    'my-notes-export-2019-01-01.jsonl',
    '2020-01-01.jsonl', // no family at all
    'recall-2026-08-19.jsonl',
    'hooks-2026-08-20.jsonl',
  ]);
  // 2018 would be the answer if the pattern matched any prefix — and it would read as retention
  // being seven years overdue while working perfectly.
  assert.match(line, /keep 30d, oldest 2026-08-19/);
});

test('the window doctor prints is the one the hooks resolve, not a number the shell keeps', () => {
  assert.match(
    retentionLine(['hooks-2026-08-20.jsonl'], { MEMORY_LOG_RETENTION_DAYS: '7' }),
    /keep 7d/,
  );
  // Exported-but-empty is unset, and the default is resolved in ONE place — paths.mjs.
  assert.match(
    retentionLine(['hooks-2026-08-20.jsonl'], { MEMORY_LOG_RETENTION_DAYS: '' }),
    /keep 30d/,
  );
});

test('an empty logs dir says none rather than nothing', () => {
  assert.match(retentionLine([]), /keep 30d, oldest none/);
});
