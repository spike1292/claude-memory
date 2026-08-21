// The `--hooks` half of /memory:doctor: what every hook did, and how long it took. The CLI entry
// is scripts/doctor-perf.mjs.
//
// Nine hook invocations fire per session and, until the log this reads, none of them recorded
// anything. The numbers CLAUDE.md quotes (43–58 ms for the ported gates, 74 ms here vs 10.9 s on a
// 49-note project) are one-off hand measurements on one machine, already at risk of drift. This is
// the continuous version of them.
//
// Read-only, and the same hard rule as its two siblings: no server, no model, no index write, no
// file written at all.
//
// It must also read lines written before any field it reports existed, so every metric is counted
// over the lines that HAVE the key rather than treating a missing one as a zero.

import fs from 'node:fs';
import path from 'node:path';
import { table } from './doctor-perf.mjs';
import { logFiles, readLines, percentile, DEFAULT_DAYS } from './recall-stats.mjs';

export { DEFAULT_DAYS };

/**
 * @typedef {{
 *   t?: string, slug?: string | null, hook?: string, event?: string,
 *   ms?: number, outcome?: string, reason?: string, session?: string, child?: boolean,
 * }} HookLine
 */
/**
 * @typedef {{
 *   n: number,
 *   latencies: number[],
 *   outcomes: Map<string, number>,
 *   reasons: Map<string, Map<string, number>>,
 *   worker: boolean,
 * }} HookRow
 */

// A hook that runs at half its declared timeout is not failing, and is one slow vault away from
// failing. Half is the point at which a number is worth printing rather than a threshold anything
// acts on — nothing here retunes a timeout, it only says which one is close.
export const NEAR_FRACTION = 0.5;

// The one hook that is not Node and does not log: hooks/vault-memory-sync.sh moves files and
// repoints symlinks in a live vault and is under an explicit do-not-port fence. Naming it here is
// the difference between "this hook is not measured" and "this hook did not run", which is exactly
// the distinction the outcome column exists to make everywhere else.
export const UNLOGGED = 'vault-memory-sync (bash, not instrumented)';

// graph-staleness-check is observed at its gate only. Its background run is the `claude` binary,
// which cannot log for itself, and nothing may be put in front of it to do so: graphgen.lock holds
// that process's pid, and a wrapper that died would free the lock while the work carried on — two
// concurrent re-indexes, which is what the lock is for.
export const NO_WORKER_LINE = 'graph-staleness-check (its background run is timed by nothing)';

/**
 * Every hook's declared timeout, read from the manifest AT RUNTIME.
 *
 * The limits are never copied into a log line or into this file: a duplicated timeout drifts
 * silently, and the drift would show up as near-misses that are not, or as none where there are.
 *
 * A hook declared under two events (distill-session is on SessionEnd and Stop) is reported against
 * the TIGHTER of them — the one it can actually breach.
 *
 * @param {string} manifest
 * @returns {Map<string, number>}
 */
export function timeouts(manifest) {
  /** @type {Map<string, number>} */
  const out = new Map();
  let json;
  try {
    json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch {
    return out; // no manifest, no timeout column — never a throw
  }
  for (const group of Object.values(json?.hooks ?? {})) {
    for (const matcher of Array.isArray(group) ? group : []) {
      for (const h of matcher?.hooks ?? []) {
        const m = /hooks\/([\w.-]+)\.(?:mjs|sh)/.exec(String(h?.command ?? ''));
        const secs = Number(h?.timeout);
        if (!m || !Number.isFinite(secs)) continue;
        const prev = out.get(m[1]);
        out.set(m[1], prev === undefined ? secs : Math.min(prev, secs));
      }
    }
  }
  return out;
}

/**
 * Fold the lines into one row per hook, with gate and worker kept apart.
 *
 * They are two different measurements of the same hook and averaging them would be meaningless:
 * a gate decides in milliseconds and detaches, a worker is the minutes of headless `claude` or
 * re-index that follows. Only the gate runs against a timeout.
 *
 * The log is MACHINE-WIDE — every project appends to the same daily file — so a slug filters it
 * and the report says how much it dropped, rather than quietly reporting another project's numbers.
 *
 * @param {readonly HookLine[]} lines
 * @param {string | null} [slug]
 */
export function summarize(lines, slug = null) {
  const seen = lines.length;
  lines = slug ? lines.filter((l) => l.slug === slug) : lines;
  /** @type {Map<string, HookRow>} */
  const hooks = new Map();
  let untimed = 0;
  let childLines = 0;

  for (const l of lines) {
    if (l.child) childLines++;
    const worker = l.event === 'worker';
    const name = l.hook || '(unnamed)';
    const key = worker ? `${name} (worker)` : name;
    const row =
      hooks.get(key) ??
      /** @type {HookRow} */ ({
        n: 0,
        latencies: [],
        outcomes: new Map(),
        reasons: new Map(),
        worker,
      });
    row.n++;
    if (typeof l.ms === 'number') row.latencies.push(l.ms);
    else untimed++;
    const o = l.outcome ?? '(none)';
    row.outcomes.set(o, (row.outcomes.get(o) ?? 0) + 1);
    if (l.reason) {
      const by = row.reasons.get(o) ?? new Map();
      by.set(l.reason, (by.get(l.reason) ?? 0) + 1);
      row.reasons.set(o, by);
    }
    hooks.set(key, row);
  }

  return {
    invocations: lines.length,
    untimed,
    childLines,
    first: lines.find((l) => l.t)?.t ?? null,
    last: [...lines].reverse().find((l) => l.t)?.t ?? null,
    hooks: [...hooks.entries()].sort((a, b) => b[1].n - a[1].n),
    slug,
    otherProjects: seen - lines.length,
  };
}

/**
 * How many of a hook's invocations ran within NEAR_FRACTION of its timeout.
 *
 * `null` when there is no declared timeout to compare against — a worker line, or a hook the
 * manifest does not name. A missing limit must not print as zero near-misses, which reads as
 * "measured, and fine".
 *
 * @param {readonly number[]} latencies
 * @param {number | undefined} timeoutSeconds
 * @returns {number | null}
 */
export function nearTimeout(latencies, timeoutSeconds) {
  // Both halves are "not measured", and both must print as "-". A row with a declared timeout and
  // no timings at all — every line written by a version that dropped `ms` — would otherwise show
  // p50/p95/max as "-" beside a confident 0, which reads as measured and fine.
  if (!Number.isFinite(timeoutSeconds) || !latencies.length) return null;
  const limit = /** @type {number} */ (timeoutSeconds) * 1000 * NEAR_FRACTION;
  return latencies.filter((ms) => ms >= limit).length;
}

/** @param {number | null} v @param {number} [digits] @returns {string} */
const num = (v, digits = 0) => (v === null ? '-' : v.toFixed(digits));

/**
 * The commonest reason behind one (hook, outcome) row, and how many others there were.
 *
 * @param {HookRow} row
 * @param {string} outcome
 * @returns {string}
 */
function reasonFor(row, outcome) {
  const by = [...(row.reasons.get(outcome) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]);
  if (!by.length) return '-';
  const [text] = by[0];
  const others = by.slice(1).reduce((a, [, c]) => a + c, 0);
  return others ? `${text} (+${others} other)` : `${text}`;
}

/**
 * The hook section body.
 *
 * @param {ReturnType<typeof summarize>} s
 * @param {Map<string, number>} limits
 * @returns {string}
 */
export function render(s, limits) {
  if (!s.invocations)
    return s.otherProjects
      ? `not measured: none of the ${s.otherProjects} logged invocations in this window belong to ` +
          `${s.slug}. The log is machine-wide; no hook has run for this project yet.`
      : 'not measured: no hook invocations logged in this window.';

  const window = s.first && s.last ? ` (${s.first.slice(0, 10)} … ${s.last.slice(0, 10)})` : '';
  const out = [
    s.slug
      ? `${s.invocations} invocations for ${s.slug}${window}` +
        (s.otherProjects
          ? ` — ${s.otherProjects} more in this window belong to other projects`
          : '')
      : `${s.invocations} invocations, every project on this machine${window}`,
    '',
    table(
      ['hook', 'n', 'p50 ms', 'p95 ms', 'max ms', 'timeout', `≥${NEAR_FRACTION * 100}% of it`],
      s.hooks.map(([name, r]) => {
        const limit = r.worker ? undefined : limits.get(name);
        const near = nearTimeout(r.latencies, limit);
        return [
          name,
          r.n,
          num(percentile(r.latencies, 50), 1),
          num(percentile(r.latencies, 95), 1),
          num(percentile(r.latencies, 100), 1),
          limit === undefined ? '-' : `${limit}s`,
          near === null ? '-' : near,
        ];
      }),
    ),
    '',
    'ms is the WHOLE process, from node startup, because that is what the timeout applies to.',
    'A "(worker)" row is the detached background run, not the hook: it has no timeout, and its',
    'duration is the distillation or the re-index rather than the gate decision that started it.',
    '',
    'THE SAMPLE IS CENSORED AT THE TIMEOUT. A hook killed at its limit is killed by a signal and',
    'writes no line, so a real breach is INVISIBLE here and the last column counts only how close',
    'the survivors ran. Read a hook that stops appearing, or whose n falls, as the breach.',
    '',
    'outcomes',
    // The REASON column, not just the count. Every call site records one and nothing printed it,
    // so the first question an `error` row raises — "error saying what?" — could only be answered
    // by hand-reading the JSONL. The commonest reason per row is shown; `+N other` says when the
    // row is not of one mind.
    table(
      ['hook', 'outcome', 'n', 'commonest reason'],
      s.hooks.flatMap(([name, r]) =>
        [...r.outcomes.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([o, n]) => [name, o, n, reasonFor(r, o)]),
      ),
    ),
    '',
    'ran = did its work · spawned = handed it to a detached child · debounced and child-guard =',
    'deliberately skipped · noop-missing-dep = a dependency is gone, so this hook is doing nothing',
    'at all · error = it threw. A dead hook and a healthy one are otherwise indistinguishable.',
  ];

  if (s.untimed)
    out.push('', `${s.untimed} of ${s.invocations} invocations carry no ms — not counted above.`);

  // A headless `claude` run fires SessionStart itself, so a single distillation adds four hook
  // invocations that no user ever saw. Counted, not hidden: they are real runs, they are just not
  // sessions, and "nine invocations per session" is the denominator someone will divide by.
  if (s.childLines)
    out.push(
      '',
      `${s.childLines} of ${s.invocations} were fired by a background \`claude\` run, not by a`,
      'session — one distillation or graph regen fires SessionStart again on its way through.',
    );

  out.push('', `not in this table: ${UNLOGGED}, and ${NO_WORKER_LINE}.`);
  return out.join('\n');
}

/**
 * The whole `--hooks` report, as one string.
 *
 * @param {{
 *   logDir: string,
 *   manifest: string,
 *   days?: number,
 *   slug?: string | null,
 * }} options
 * @returns {string}
 */
export function report({ logDir, manifest, days = DEFAULT_DAYS, slug = null }) {
  const files = logFiles(logDir, days, 'hooks');
  // readLines() is shared with the recall reader and is typed for ITS record. The cast is the only
  // thing telling tsc these are hook lines — without it every field below type-checks against a
  // shape with no `hook`, `outcome` or `event` in it, and a rename in logHook() would pass.
  const summary = summarize(
    /** @type {HookLine[]} */ (/** @type {unknown} */ (readLines(files))),
    slug,
  );
  const head = files.length
    ? `${files.length} log file(s), most recent first: ${files
        .slice(-3)
        .reverse()
        .map((f) => path.basename(f))
        .join(', ')}`
    : `no hook logs in ${logDir} — nothing has been logged there in this window. That is a` +
      ' session that has not run yet, a cleared logs/, a window too narrow, or a directory the' +
      ' hooks cannot write (they swallow exactly that).';
  return `\nhook analytics\n${`${head}\n\n${render(summary, timeouts(manifest))}`.replace(/^(?=.)/gm, '  ')}\n`;
}
