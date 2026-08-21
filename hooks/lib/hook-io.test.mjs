// Tests for hooks/lib/hook-io.mjs. Run: node --test hooks/lib/hook-io.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logRetentionDays } from './paths.mjs';
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
  lockHolder,
  takeLock,
  writeLock,
  releaseLock,
  appendJsonl,
  pruneDatedLogs,
  logHook,
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

// The lock that stops N stale repos becoming N parallel full re-indexes (#34). Ownership is a live
// pid, so every branch below is about what happens when the owner is gone, dead or too old.
test('takeLock picks exactly one winner, and a live holder keeps it', () => {
  const f = path.join(tmp(), 'graphgen.lock');
  const now = 1000;

  assert.strictEqual(takeLock(f, process.pid, now, 3600, now), true, 'free lock is taken');
  assert.strictEqual(takeLock(f, process.pid, now, 3600, now), false, 'a live holder keeps it');
  assert.strictEqual(lockHolder(f, 3600, now), process.pid);
});

test('a lock whose owner died is reclaimed', () => {
  const f = path.join(tmp(), 'graphgen.lock');
  const now = 1000;
  // A pid that is certainly not running: reserved by POSIX, never a real process.
  writeLock(f, 0x7fffffff, now);
  assert.strictEqual(lockHolder(f, 3600, now), null, 'dead pid holds nothing');
  assert.strictEqual(takeLock(f, process.pid, now, 3600, now), true);
  assert.strictEqual(lockHolder(f, 3600, now), process.pid);
});

test('a lock older than maxSeconds is stale even when its pid is alive', () => {
  const f = path.join(tmp(), 'graphgen.lock');
  writeLock(f, process.pid, 1000);
  assert.strictEqual(lockHolder(f, 3600, 4599), process.pid, 'inside the window');
  assert.strictEqual(lockHolder(f, 3600, 4600), null, 'a wedged run is not held forever');
});

test('a missing or corrupt lock file holds nothing', () => {
  const d = tmp();
  assert.strictEqual(lockHolder(path.join(d, 'nope.lock'), 3600, 1000), null);
  const f = path.join(d, 'junk.lock');
  fs.writeFileSync(f, 'not a lock\n');
  assert.strictEqual(lockHolder(f, 3600, 1000), null);
  assert.strictEqual(takeLock(f, process.pid, 1000, 3600, 1000), true, 'and is reclaimable');
});

test('releaseLock frees it, and is safe when already gone', () => {
  const f = path.join(tmp(), 'graphgen.lock');
  takeLock(f, process.pid, 1000, 3600, 1000);
  releaseLock(f);
  assert.strictEqual(lockHolder(f, 3600, 1000), null);
  releaseLock(f);
});

test('detach returns the child pid — it is what the caller writes into its lock', () => {
  const pid = detach(process.execPath, ['-e', '']);
  assert.ok(Number.isInteger(pid) && /** @type {number} */ (pid) > 0, 'a pid, not just truthy');
});

// spawn() fails asynchronously for a missing binary. Before the handler, this crashed the process
// AFTER detach() had returned a pid — a hook that had already printed its line.
test('detach survives a missing binary instead of throwing later', async () => {
  detach('/nonexistent/binary', []);
  await new Promise((r) => setTimeout(r, 50));
});

// pid 0 is not "no such process": POSIX reads kill(0, sig) as "my own process group", so it is the
// one value that passes a finite check and then reports itself alive. A truncated lock file is the
// realistic way it gets written.
test('a lock claiming pid 0 holds nothing', () => {
  const f = path.join(tmp(), 'graphgen.lock');
  writeLock(f, 0, 1000);
  assert.strictEqual(lockHolder(f, 3600, 1000), null);
  assert.strictEqual(takeLock(f, process.pid, 1000, 3600, 1000), true, 'and is reclaimable');
});

// Reclaiming a stale lock is unlink-then-create, which is not atomic as a unit: without a guard,
// the loser's unlink deletes the winner's fresh lock and it then claims the empty path, so both
// callers believe they hold it. What is asserted here is the OUTCOME — a reclaimed lock is not
// taken twice. The inode guard that narrows the interleaving has no deterministic test: it fires
// only between another process's verdict and its unlink, which cannot be reached from a sequential
// caller, and injecting a seam to reach it would be more machinery than the guard.
test('a reclaimed lock cannot then be taken a second time', () => {
  const f = path.join(tmp(), 'graphgen.lock');
  const now = 1000;
  writeLock(f, 0x7fffffff, now); // dead owner: stale, and therefore reclaimable

  assert.strictEqual(takeLock(f, process.pid, now, 3600, now), true, 'the winner reclaims it');
  assert.strictEqual(takeLock(f, 4242, now, 3600, now), false, 'the next caller does not');
  assert.strictEqual(lockHolder(f, 3600, now), process.pid, "the winner's lock survives");
});

// The 'error' handler exists so an async spawn failure cannot crash a hook that has already
// returned a pid. It must still leave a trace: by then the caller has written that pid into a lock
// file and a 24h debounce marker, and nothing else explains why the child is gone.
test('detach records an async spawn failure in the log', async () => {
  const f = path.join(tmp(), 'graphgen.log');
  detach('/nonexistent/binary', [], { logFile: f });
  for (let i = 0; i < 100 && !fs.readFileSync(f, 'utf8').includes('spawn failed'); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(fs.readFileSync(f, 'utf8'), /spawn failed: .*ENOENT/);
});

// ---------------------------------------------------------------- structured logs
//
// The one thing every assertion below is really about: this appender sits on the per-prompt recall
// path and on every SessionStart hook, so "it cannot throw" and "it cannot be wrong about the day"
// are correctness properties, not politeness.

/** Run `fn` with $CLAUDE_MEMORY_HOME pointed at a scratch dir, and hand back its logs/ path. */
const withState = (/** @type {(logs: string) => void} */ fn) => {
  const state = tmp();
  const prev = process.env.CLAUDE_MEMORY_HOME;
  process.env.CLAUDE_MEMORY_HOME = state;
  try {
    fn(path.join(state, 'logs'));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_MEMORY_HOME;
    else process.env.CLAUDE_MEMORY_HOME = prev;
  }
};

/** @param {string} file @returns {Record<string, unknown>[]} */
const readJsonl = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test('appendJsonl stamps t and slug FIRST, then the record verbatim', () => {
  withState((logs) => {
    appendJsonl('recall', process.cwd(), { abstained: true, reason: 'nope', ms: 12.5 });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(logs, `recall-${day}.jsonl`);
    const [rec] = readJsonl(file);
    // Field ORDER is the contract, not just the field set: recall's records have been written as
    // t, slug, <entry…>, ms since the log began, and a reader diffing two days of them must not see
    // the shape change under it.
    assert.deepStrictEqual(Object.keys(rec), ['t', 'slug', 'abstained', 'reason', 'ms']);
    assert.match(String(rec.t), /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(rec.reason, 'nope');
  });
});

test('appendJsonl dates the file by the same clock it stamps the line with', () => {
  withState((logs) => {
    appendJsonl('hooks', process.cwd(), { hook: 'x' });
    // The day-claim dotfile lives here too, and sorts first — the log files are the .jsonl ones.
    const [file] = fs.readdirSync(logs).filter((f) => f.endsWith('.jsonl'));
    const [rec] = readJsonl(path.join(logs, file));
    // A line landing in yesterday's file is how a window silently loses a day. Same ISO string for
    // both, so they cannot disagree even across a midnight boundary mid-call.
    assert.strictEqual(file, `hooks-${String(rec.t).slice(0, 10)}.jsonl`);
  });
});

test('appendJsonl appends rather than replaces, and keeps families apart', () => {
  withState((logs) => {
    appendJsonl('hooks', process.cwd(), { hook: 'a' });
    appendJsonl('hooks', process.cwd(), { hook: 'b' });
    appendJsonl('recall', process.cwd(), { abstained: false });
    const day = new Date().toISOString().slice(0, 10);
    assert.strictEqual(readJsonl(path.join(logs, `hooks-${day}.jsonl`)).length, 2);
    assert.strictEqual(readJsonl(path.join(logs, `recall-${day}.jsonl`)).length, 1);
  });
});

test('appendJsonl swallows an unwritable log directory', () => {
  const state = tmp();
  // A FILE where the state dir must be: stateDir()'s mkdirSync throws, which is the closest thing
  // to a read-only or full logs/ that a test can create without root. The hook must not notice.
  fs.writeFileSync(path.join(state, 'logs'), 'not a directory');
  const prev = process.env.CLAUDE_MEMORY_HOME;
  process.env.CLAUDE_MEMORY_HOME = state;
  try {
    assert.doesNotThrow(() => appendJsonl('hooks', process.cwd(), { hook: 'x' }));
    assert.doesNotThrow(() => logHook({ hook: 'x', outcome: 'ran' }));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_MEMORY_HOME;
    else process.env.CLAUDE_MEMORY_HOME = prev;
  }
});

test('logHook omits reason and session rather than writing them empty', () => {
  withState((logs) => {
    logHook({ hook: 'validate-note', event: 'PostToolUse', cwd: process.cwd(), outcome: 'ran' });
    logHook({
      hook: 'distill-session',
      event: 'SessionEnd',
      cwd: process.cwd(),
      session: 's1',
      outcome: 'spawned',
      reason: '60 lines',
    });
    const day = new Date().toISOString().slice(0, 10);
    const [bare, full] = readJsonl(path.join(logs, `hooks-${day}.jsonl`));
    // An absent key means NOT RECORDED. A null or an empty string would read as recorded-as-empty,
    // and the two must stay tellable apart as fields get added to these lines.
    assert.ok(!('reason' in bare) && !('session' in bare));
    assert.strictEqual(full.reason, '60 lines');
    assert.strictEqual(full.session, 's1');
    assert.strictEqual(typeof bare.ms, 'number');
    assert.ok(/** @type {number} */ (bare.ms) > 0, 'ms is measured from process start, never zero');
  });
});

test('logHook caps a runaway reason instead of writing an unbounded line', () => {
  withState((logs) => {
    logHook({ hook: 'x', outcome: 'error', reason: 'e'.repeat(5000) });
    const day = new Date().toISOString().slice(0, 10);
    const [rec] = readJsonl(path.join(logs, `hooks-${day}.jsonl`));
    // The reason is usually an exception message, which can carry a whole stack or a file dump.
    assert.strictEqual(String(rec.reason).length, 200);
  });
});

test('a hook line fired inside a background claude run is flagged as one', () => {
  withState((logs) => {
    const prev = process.env.CBM_GRAPHGEN_CHILD;
    process.env.CBM_GRAPHGEN_CHILD = '1';
    try {
      logHook({ hook: 'insights-surface', cwd: process.cwd(), outcome: 'ran' });
    } finally {
      if (prev === undefined) delete process.env.CBM_GRAPHGEN_CHILD;
      else process.env.CBM_GRAPHGEN_CHILD = prev;
    }
    logHook({ hook: 'insights-surface', cwd: process.cwd(), outcome: 'ran' });
    const day = new Date().toISOString().slice(0, 10);
    const [inChild, inSession] = readJsonl(path.join(logs, `hooks-${day}.jsonl`));
    // A regeneration fires SessionStart itself, so four hooks run again with no user behind them.
    // Unflagged, they are counted as sessions and skew every percentile in the report.
    assert.strictEqual(inChild.child, true);
    assert.ok(!('child' in inSession), 'and a real session carries no flag at all');
  });
});

test('detach returns null when the command cannot start, and says so in the log file', async () => {
  const state = tmp();
  const logFile = path.join(state, 'graphgen.log');
  const missing = path.join(state, 'definitely-not-here');

  // A null pid is the ONLY signal a caller gets, because spawn reports a missing binary
  // ASYNCHRONOUSLY — and both gates now decide their outcome on it, while graph-staleness-check
  // goes further and releases its lock rather than muting the repo for 24h.
  assert.strictEqual(detach(missing, [], { logFile }), null, 'a missing binary is a null pid');

  for (let i = 0; i < 100 && !/spawn failed/.test(fs.readFileSync(logFile, 'utf8')); i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.match(fs.readFileSync(logFile, 'utf8'), /spawn failed/, 'and the log file records why');
});

// ---------------------------------------------------------------- retention

/** @param {string} dir @param {string[]} names */
const seed = (dir, names) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), '{}\n');
};

/** @param {string} value @param {() => void} fn */
const withRetention = (value, fn) => {
  const prev = process.env.MEMORY_LOG_RETENTION_DAYS;
  process.env.MEMORY_LOG_RETENTION_DAYS = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.MEMORY_LOG_RETENTION_DAYS;
    else process.env.MEMORY_LOG_RETENTION_DAYS = prev;
  }
};

test('pruneDatedLogs deletes past the window and leaves everything else alone', () => {
  withState((logs) => {
    withRetention('30', () => {
      seed(logs, [
        'recall-2026-01-01.jsonl', // older than the window
        'hooks-2026-07-01.jsonl', // older than the window
        'hooks-2026-08-20.jsonl', // inside it
        'recall-2026-08-21.jsonl', // today
        'distill.log', // a free-form log; trimLog's job, not this one
        'hooks-2026-13-99.jsonl', // shaped like ours but not a date; it only sorts high
        '2026-01-01.jsonl', // no family: not ours, whatever the date says
        'backup-2026-01-01.jsonl', // someone else's file with a plausible prefix
        'my-notes-export-2026-01-01.jsonl',
        '.retention-notes.md', // shares the claim prefix, is not a claim
        '.retention-', // the prefix and nothing else
        '.retention-2099-01-01', // a claim from a clock that was wrong: kept until that day
      ]);
      const removed = pruneDatedLogs(new Date('2026-08-21T12:00:00Z'));
      assert.deepStrictEqual(removed.sort(), ['hooks-2026-07-01.jsonl', 'recall-2026-01-01.jsonl']);
      assert.deepStrictEqual(fs.readdirSync(logs).sort(), [
        '.retention-',
        '.retention-2099-01-01',
        '.retention-notes.md',
        '2026-01-01.jsonl',
        'backup-2026-01-01.jsonl',
        'distill.log',
        'hooks-2026-08-20.jsonl',
        'hooks-2026-13-99.jsonl',
        'my-notes-export-2026-01-01.jsonl',
        'recall-2026-08-21.jsonl',
      ]);
    });
  });
});

test('an unparseable retention keeps the default window rather than emptying the directory', () => {
  withState((logs) => {
    // ' ' casts to 0 through Number() and 1e9 makes an Invalid Date — the two values that once
    // archived a whole directory while printing a success line (scripts/lib/prune-logs.mjs).
    for (const bad of [' ', '1e9', '-1', 'thirty']) {
      withRetention(bad, () => {
        seed(logs, ['hooks-2026-08-20.jsonl']);
        pruneDatedLogs(new Date('2026-08-21T12:00:00Z'));
        assert.deepStrictEqual(
          fs.readdirSync(logs),
          ['hooks-2026-08-20.jsonl'],
          `${JSON.stringify(bad)} -> ${logRetentionDays()}d, dir=${logs}, TZ=${process.env.TZ}, home=${process.env.CLAUDE_MEMORY_HOME}`,
        );
      });
    }
  });
});

test('appendJsonl prunes once a day, and says on the line how many it deleted', () => {
  withState((logs) => {
    withRetention('30', () => {
      seed(logs, ['hooks-2000-01-01.jsonl', 'recall-2000-01-02.jsonl']);
      appendJsonl('hooks', process.cwd(), { hook: 'a' }); // unclaimed day: this one prunes
      const day = new Date().toISOString().slice(0, 10);
      const [first] = readJsonl(path.join(logs, `hooks-${day}.jsonl`));
      // AFTER the caller's fields: their order is a contract (see the first test in this file),
      // and a count injected into the middle of someone's record breaks a reader that never asked
      // for it.
      assert.deepStrictEqual(Object.keys(first), ['t', 'slug', 'hook', 'pruned']);
      assert.strictEqual(
        first.pruned,
        2,
        'the work logs itself, on the line already being written',
      );
      assert.strictEqual(fs.existsSync(path.join(logs, `.retention-${day}`)), true);

      // The claim is per DIRECTORY and per DAY, so it holds across families and across processes:
      // a stale file dropped in afterwards survives until tomorrow. The first guard asked whether
      // today's file existed, which is per family and per process — nine of nine concurrent hooks
      // each ran a full pass.
      seed(logs, ['recall-2000-01-03.jsonl']);
      appendJsonl('recall', process.cwd(), { abstained: true });
      assert.strictEqual(fs.existsSync(path.join(logs, 'recall-2000-01-03.jsonl')), true);
      const [second] = readJsonl(path.join(logs, `recall-${day}.jsonl`));
      assert.ok(!('pruned' in second), 'omitted, never zero');
    });
  });
});

test("yesterday's claim does not hold today, and is swept with the logs it authorised", () => {
  withState((logs) => {
    withRetention('30', () => {
      const day = new Date().toISOString().slice(0, 10);
      seed(logs, ['hooks-2000-01-01.jsonl', '.retention-2000-01-01']);
      appendJsonl('hooks', process.cwd(), { hook: 'a' });
      assert.strictEqual(fs.existsSync(path.join(logs, 'hooks-2000-01-01.jsonl')), false);
      assert.strictEqual(
        fs.existsSync(path.join(logs, '.retention-2000-01-01')),
        false,
        'one dotfile per day would be the same unbounded directory under another name',
      );
      assert.strictEqual(fs.existsSync(path.join(logs, `.retention-${day}`)), true);
    });
  });
});

test('a claim that cannot be created means no prune, not a prune on every append', () => {
  withState((logs) => {
    withRetention('30', () => {
      const day = new Date().toISOString().slice(0, 10);
      seed(logs, ['hooks-2000-01-01.jsonl']);
      // A DIRECTORY where the claim file goes: `openSync(..., 'wx')` fails with EISDIR, the same
      // shape as a read-only logs/ (EACCES). The read-then-write stamp this replaced inverted
      // here — it could never read today back, so it pruned on EVERY append, 146 ms apiece.
      fs.mkdirSync(path.join(logs, `.retention-${day}`));
      for (let i = 0; i < 3; i++) appendJsonl('hooks', process.cwd(), { hook: `h${i}` });
      assert.strictEqual(
        fs.existsSync(path.join(logs, 'hooks-2000-01-01.jsonl')),
        true,
        'declining to prune is the honest answer: those unlinks would fail too',
      );
      assert.strictEqual(
        readJsonl(path.join(logs, `hooks-${day}.jsonl`)).length,
        3,
        'lines still land',
      );
    });
  });
});

test('the window is UTC, like the filenames — a timezone ahead of it deletes nothing extra', () => {
  const prevTz = process.env.TZ;
  // 23:30 UTC is 01:30 the NEXT local day in Amsterdam, so the local date is one ahead of the date
  // these files are named with. A local cutoff ranked today's file as older than the window and
  // unlinked it — at a retention of 0 that is the live file of the other family, deleted on every
  // append, because the day-roll guard never held either (measured 2026-08-21).
  // Both sides of the clock are pinned: TZ here, and the instant passed in. Reading the real clock
  // would make this pass or fail by the hour, since every zone matches UTC for part of the day.
  process.env.TZ = 'Europe/Amsterdam';
  try {
    withState((logs) => {
      withRetention('0', () => {
        // The claim marker is here for the SECOND use of the clock: the sweep compares it against
        // today, and a LOCAL today east of Greenwich deletes the claim the pass just made — so
        // every later append that day runs a full pass, the herd this design exists to prevent.
        seed(logs, ['recall-2026-08-21.jsonl', 'hooks-2026-08-20.jsonl', '.retention-2026-08-21']);
        assert.deepStrictEqual(pruneDatedLogs(new Date('2026-08-21T23:30:00Z')), [
          'hooks-2026-08-20.jsonl',
        ]);
        assert.deepStrictEqual(fs.readdirSync(logs).sort(), [
          '.retention-2026-08-21',
          'recall-2026-08-21.jsonl',
        ]);
      });
    });
  } finally {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  }
});

test('a pass sweeps its markers even at the largest retention there is', () => {
  withState((logs) => {
    withRetention('999999999999', () => {
      // Twelve digits used to make an Invalid Date, whose toISOString() threw and abandoned the
      // pass — logs survived, but the stale day-claims did not get swept, so logs/ grew a dotfile
      // a day: the unbounded directory this change exists to close, in a corner of it.
      seed(logs, ['hooks-2000-01-01.jsonl', '.retention-2000-01-01']);
      appendJsonl('hooks', process.cwd(), { hook: 'a' });
      assert.strictEqual(
        fs.existsSync(path.join(logs, 'hooks-2000-01-01.jsonl')),
        true,
        'a century keeps every log',
      );
      assert.strictEqual(
        fs.existsSync(path.join(logs, '.retention-2000-01-01')),
        false,
        `and still sweeps its own markers — ${logRetentionDays()}d, dir now ${JSON.stringify(fs.readdirSync(logs))}`,
      );
    });
  });
});

test('a log that cannot be unlinked is not reported as deleted, and does not stop the pass', () => {
  withState((logs) => {
    withRetention('30', () => {
      seed(logs, ['hooks-2000-01-01.jsonl', 'hooks-2000-01-02.jsonl']);
      // A DIRECTORY where a log file's name is: unlinkSync throws EPERM/EISDIR on it. The pass
      // must skip it, keep going, and not count it — "a log we cannot delete is a log that stays".
      fs.mkdirSync(path.join(logs, 'hooks-2000-01-03.jsonl'));
      const removed = pruneDatedLogs(new Date('2026-08-21T12:00:00Z'));
      assert.deepStrictEqual(removed.sort(), ['hooks-2000-01-01.jsonl', 'hooks-2000-01-02.jsonl']);
      assert.strictEqual(fs.existsSync(path.join(logs, 'hooks-2000-01-03.jsonl')), true);
    });
  });
});
