// Tests for scripts/doctor.sh. Run: node --test scripts/doctor.test.mjs
//
// One round trip, not two halves: `capReport()` is unit-tested in
// hooks/lib/memory-link-lint.test.mjs, and doctor.sh parses its tab-separated lines in bash. Both
// sides can stay green while the seam between them breaks — rename the export, change a field
// order, and /memory:doctor silently stops reporting the one truncation nothing else reports.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('./doctor.sh', import.meta.url));
const REAL_HOME = os.homedir();

/** A throwaway HOME + vault + state dir, and the built (never inherited) child env. */
function scratch() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-')));
  const home = path.join(tmp, 'home');
  const vault = path.join(tmp, 'vault');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_VAULT: vault,
    CLAUDE_MEMORY_HOME: path.join(tmp, 'state'),
  };
  assert.notStrictEqual(env.HOME, REAL_HOME, 'scratch HOME must not be the real one');
  return { tmp, vault, env };
}

/** @param {ReturnType<typeof scratch>} world */
const run = (world) =>
  execFileSync('bash', [SCRIPT], {
    env: world.env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

test('doctor reports an oversize MEMORY.md through capReport', () => {
  const world = scratch();
  try {
    // The slug is the normalised git remote of the cwd, and doctor.sh prints it. Read it back
    // rather than deriving it a second way here — a second derivation is a second thing to drift.
    const first = run(world);
    const slug = /^ {2}project: (\S+)/m.exec(first)?.[1];
    assert.ok(slug, `doctor did not print a project slug:\n${first}`);
    assert.match(first, /auto memory/, 'the section exists even with an empty vault');
    assert.match(first, /no MEMORY\.md in the vault yet/);

    const mem = path.join(world.vault, 'Memory', slug);
    fs.mkdirSync(mem, { recursive: true });
    fs.writeFileSync(path.join(mem, 'MEMORY.md'), 'x'.repeat(26 * 1024));
    fs.mkdirSync(path.join(world.vault, 'Memory', 'someone-elses-private-repo'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(world.vault, 'Memory', 'someone-elses-private-repo', 'MEMORY.md'),
      'small',
    );

    const out = run(world);
    const section = out.slice(out.indexOf('auto memory'), out.indexOf('\nindex'));
    assert.match(section, /FAIL this project's MEMORY\.md is over the load cap/, section);
    assert.match(section, /26,624 bytes \/ 1 lines — 104%/, 'the measured size reaches the report');
    assert.match(section, /1 other MEMORY\.md all fit the cap — 0%/);
    assert.ok(
      !section.includes('someone-elses-private-repo'),
      'other projects must not be named — this report is pasted into issues',
    );

    // The WARN arm of doctor's own case statement, which the two runs above never reach: delete it
    // and the near-cap band — the one the whole feature exists for — prints nothing at all.
    fs.writeFileSync(path.join(mem, 'MEMORY.md'), 'x'.repeat(Math.round(25 * 1024 * 0.9)));
    const nearOut = run(world);
    assert.match(
      nearOut.slice(nearOut.indexOf('auto memory'), nearOut.indexOf('\nindex')),
      /WARN this project's MEMORY\.md is near the load cap: 23,040 bytes \/ 1 lines — 90%/,
    );
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});
