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
 *   bytes?: number,
 *   inTok?: number, cacheWriteTok?: number, cacheReadTok?: number, outTok?: number, usd?: number,
 * }} HookLine
 */
/** @typedef {{ chars?: number, abstained?: boolean, t?: string, slug?: string }} RecallSize */
/**
 * @typedef {{
 *   hook: string,
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

// Bytes per token. A rule of thumb, not a tokeniser: adding one would mean a dependency shipped
// into every user's plugin cache to put a second decimal on a number nobody acts on at that
// precision. 4 is the conventional English figure and these strings are English prose with a few
// wikilinks. Everything derived from it is LABELLED an estimate, everywhere it is printed — the
// distiller's figures beside them are measured, and the two must never read alike.
export const BYTES_PER_TOKEN = 4;

// Injected context is spent before the user has typed anything: it is the session's opening cost.
// The threshold only produces a warning line — nothing here caps a list or changes a budget, which
// is deliberately somebody else's ticket.
export const INJECTED_TOKEN_BUDGET = 2000;

/**
 * Estimated tokens for a byte count. Null in, null out — a hook that injected nothing must not
 * average in as a zero beside hooks that were never measured.
 *
 * @param {number | null | undefined} bytes
 * @returns {number | null}
 */
export function estTokens(bytes) {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0
    ? Math.round(bytes / BYTES_PER_TOKEN)
    : null;
}

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
 * Keyed by `<hook>` AND by `<hook> · <event>`, because the manifest declares a limit per event and
 * the report now has a row per event. The per-hook key is the tighter of them, kept as the fallback
 * for a line whose event is missing; a row that knows its event reads its own budget, so a Stop at
 * 5 s and a SessionEnd at 15 s are never judged against each other's.
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
  for (const [event, group] of Object.entries(json?.hooks ?? {})) {
    for (const matcher of Array.isArray(group) ? group : []) {
      for (const h of matcher?.hooks ?? []) {
        const m = /hooks\/([\w.-]+)\.(?:mjs|sh)/.exec(String(h?.command ?? ''));
        const secs = Number(h?.timeout);
        if (!m || !Number.isFinite(secs)) continue;
        out.set(`${m[1]} · ${event}`, secs);
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
  /** @type {Map<string, number[]>} */
  const injected = new Map();
  /** @type {HookLine[]} */
  const extracts = [];
  /** @type {Set<string>} */
  const sessions = new Set();
  /** @type {Set<string>} */
  const days = new Set();

  for (const l of lines) {
    if (l.child) childLines++;
    if (l.session) sessions.add(l.session);
    if (l.t) days.add(l.t.slice(0, 10));
    // An injector that ran and injected nothing omits `bytes` entirely, so this counts only the
    // runs that put something in the context window. The count of those is printed beside the
    // numbers, because "3 of 40 runs injected" and "40 of 40" are different findings at the same
    // mean.
    if (typeof l.bytes === 'number') {
      const name = l.hook || '(unnamed)';
      injected.set(name, [...(injected.get(name) ?? []), l.bytes]);
    }
    if (l.event === 'extract') extracts.push(l);
    const worker = l.event === 'worker';
    const name = l.hook || '(unnamed)';
    // Keyed by hook AND EVENT. distill-session runs on both Stop and SessionEnd, and they are not
    // the same measurement: Stop fires at the end of every assistant turn and is gated hard, so
    // hundreds of cheap decisions were burying the one SessionEnd run per session that reads the
    // transcript and forks. Merged, the p95 and the near-timeout share for the only hook with a
    // 15 s timeout described the path that cannot breach it.
    const key = `${name} · ${l.event || '(no event)'}`;
    const row =
      hooks.get(key) ??
      /** @type {HookRow} */ ({
        hook: name,
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
    injected: [...injected.entries()].sort((a, b) => b[1].length - a[1].length),
    extracts,
    sessions: sessions.size,
    days: days.size,
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

// Reasons are often raw exception messages, and an ENOENT carries an absolute path: the vault
// root, the NOTE FILENAME, and the OS username inside it. This report tells the reader it holds
// nothing identifying but the project slug and invites them to paste it into an issue, so the
// redaction has to happen before it is printed. The log file on disk keeps the full message — it is
// local, and it is what someone debugging their own machine actually needs.
//
// THREE passes, in this order, and the order is the whole design. A path with a SPACE in it is the
// common case here rather than an edge case — vaults live under `~/My Vault`, `~/Google Drive`,
// `Library/Mobile Documents/…` — and the bare rule alone turned `open '/Users/bob/My Vault/x.md'`
// into `<path> Vault<path>`, publishing the vault directory's name.
//
//   1. a QUOTED path, taken whole, spaces and all;
//   2. a quoted path with NO CLOSING QUOTE, which is what logHook's 200-char cap leaves behind on a
//      long path — without this one, pass 3 gets it and the leak reopens;
//   3. the bare rule, on whatever is left.
//
// Each pass only sees what the ones before it did not take.
//
// Deliberately blunt: over-redacting a reason costs a word, under-redacting it publishes a private
// file path. Windows paths are not matched, and are not reachable — these messages come from Node's
// `fs` errors on paths these hooks pass in as absolute POSIX.
/** @param {string} text @returns {string} */
export function redact(text) {
  return (
    String(text)
      .replace(/(['"`])(?:~|\.{0,2})?\/[^'"`]*\1/g, '$1<path>$1')
      // An UNTERMINATED quoted path, which is what `logHook`'s 200-char cap leaves behind: the
      // closing quote is gone, the pass above stops matching, and the bare rule below then publishes
      // the spaced segments it was added to hide. A deep iCloud vault path passes 200 characters on
      // its own.
      .replace(/(['"`])(?:~|\.{0,2})?\/[^'"`]*$/g, '$1<path>')
      .replace(/(?:~|\.{0,2})?\/[^\s'"`)\]]*/g, '<path>')
  );
}

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
  return others ? `${redact(text)} (+${others} other)` : redact(text);
}

/**
 * The hook section body.
 *
 * @param {ReturnType<typeof summarize>} s
 * @param {Map<string, number>} limits
 * @param {readonly RecallSize[]} [recall] injecting recall decisions, from the recall log family
 * @returns {string}
 */
export function render(s, limits, recall = []) {
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
        // The row's own event first — the manifest declares a limit per event — then the per-hook
        // fallback for a line whose event is missing. A worker row is not the hook and has none.
        const limit = r.worker ? undefined : (limits.get(name) ?? limits.get(r.hook));
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
    'One row per hook AND EVENT: distill-session on Stop is a cheap decision fired every assistant',
    'turn, and on SessionEnd it is the run that reads the transcript — merged, the cheap one buries',
    'the one that can breach a timeout. A "· worker" row is the detached background run rather than',
    'the hook, so it has no timeout and its duration is the distillation or the re-index itself.',
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
    'ran = did its work · spawned = handed it to a detached child · child-guard = it fired inside',
    'work it had itself started · debounced = it stood down: its own timer, a line count below the',
    'threshold, or a lock somebody else holds · noop-missing-dep = what it needs is absent, so it',
    'can do nothing at all — sometimes permanently and correctly, when that thing is an OPTIONAL',
    'integration this install never set up · error = it threw, or the work it started never ran.',
    '',
    'A HIGH SKIP RATE IS NOT A FAULT BY ITSELF — read it against what the hook is for.',
    '`distill-session · Stop` is a crash fallback and stands down on nearly every assistant turn, so',
    '100% debounced there is the healthy state. It IS a finding where work was expected: a',
    '`· SessionEnd` row that never spawns, or a `graph-staleness-check` debounced by a lock nothing',
    'releases. Either way the hook says nothing and exits 0, which is why the column exists.',
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
  out.push(...injectedSection(s, recall));
  out.push(...costSection(s));
  return out.join('\n');
}

/**
 * What the hooks put INTO the context window, before the user has typed anything.
 *
 * Estimated, and said so on every line: bytes / BYTES_PER_TOKEN, no tokeniser. Recall is folded in
 * from its OWN log family, which already records injected characters — it gains no `bytes` field,
 * because two sources for one number is how they come to disagree.
 *
 * Recall's records carry no session id (they never have), so its column is a per-session AVERAGE
 * over the sessions the hook log saw, not a per-session breakdown. Named as an average rather than
 * quietly presented as one.
 *
 * @param {ReturnType<typeof summarize>} s
 * @param {readonly RecallSize[]} recall
 * @returns {string[]}
 */
function injectedSection(s, recall) {
  const rows = s.injected.map(([name, bytes]) => {
    const toks = bytes.map((b) => /** @type {number} */ (estTokens(b)));
    return { name, n: toks.length, p50: percentile(toks, 50), p95: percentile(toks, 95), toks };
  });

  const recallChars = recall
    .filter((r) => !r.abstained && typeof r.chars === 'number')
    .map((r) => /** @type {number} */ (r.chars));
  const recallToks = recallChars.map((c) => /** @type {number} */ (estTokens(c)));

  if (!rows.length && !recallToks.length)
    return [
      '',
      'injected context: not measured — no hook in this window recorded what it injected.',
    ];

  const mean = (/** @type {readonly number[]} */ v) =>
    v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;

  const body = [
    '',
    'injected context (ESTIMATED tokens, bytes / ' + BYTES_PER_TOKEN + ' — no tokeniser)',
    table(
      ['hook', 'runs that injected', 'mean tok', 'p50 tok', 'p95 tok'],
      rows.map((r) => [r.name, r.n, num(mean(r.toks)), num(r.p50), num(r.p95)]),
    ),
  ];

  if (recallToks.length) {
    const total = recallToks.reduce((a, b) => a + b, 0);
    body.push(
      '',
      `recall injected ~${total} tok across ${recallToks.length} prompt(s) in this window` +
        (s.sessions
          ? `, ~${Math.round(total / s.sessions)} per session averaged over the ${s.sessions} ` +
            'session(s) the hook log saw'
          : ''),
      'Recall is read from its own recall-*.jsonl records, which carry no session id — so that is',
      'an average over sessions, not a per-session figure.',
    );
  } else {
    body.push('', 'recall: not measured — no injecting recall decisions in this window.');
  }

  // The per-SESSION sum is what a user actually pays at startup, so it is summed across hooks
  // rather than compared hook by hook. Recall is excluded: it is per prompt, not per session, and
  // adding it here would silently double-count a long session.
  const perSession = rows.reduce((a, r) => a + (mean(r.toks) ?? 0), 0);
  body.push(
    '',
    `~${perSession} estimated tokens of SessionStart context per session, across ${rows.length} injector(s).`,
  );
  if (perSession > INJECTED_TOKEN_BUDGET)
    body.push(
      `WARNING: that is over the ${INJECTED_TOKEN_BUDGET}-token line this report draws. Every ` +
        'session pays it',
      'before the first prompt. Capping a list is a separate change — this only says the number.',
    );
  // Measured once, by hand, because logging it needs a second appender written in shell and that
  // hook is under a do-not-port fence: the heredoc it prints is 1545 bytes of template before
  // variable expansion (plus 341 more when context-mode is absent), so ~400 estimated tokens on
  // top of the number above. Near-fixed, which is why measuring it once is enough — but it is a
  // 2026-08-21 measurement of a template, and it moves when that template is edited.
  body.push(
    '',
    `Not counted: ${UNLOGGED} injects a near-fixed memory block — measured by hand at ~1.5 KB,`,
    `so roughly ${estTokens(1545 + 341)} more estimated tokens per session.`,
  );
  return body;
}

/**
 * What the distiller's headless run really cost — MEASURED, not estimated, and labelled so.
 *
 * The figures come from the CLI's own JSON envelope. They are dominated by cache traffic rather
 * than by the transcript: a throwaway prompt measured 9 input tokens against 18,078 cache-creation
 * and 22,363 cache-read, at $0.0389 (2026-08-20). That is why nothing here is derived from length.
 *
 * @param {ReturnType<typeof summarize>} s
 * @returns {string[]}
 */
function costSection(s) {
  if (!s.extracts.length)
    return [
      '',
      'distiller cost: not measured — no extract line in this window. A distillation that was',
      'debounced, found no CLI, or failed before the call writes no cost at all, by design.',
    ];

  const sum = (/** @type {keyof HookLine} */ k) =>
    s.extracts.reduce(
      (a, l) => a + (typeof l[k] === 'number' ? /** @type {number} */ (l[k]) : 0),
      0,
    );
  const usd = sum('usd');
  const runs = s.extracts.length;
  return [
    '',
    `distiller cost (MEASURED, from the CLI's own usage figures) — ${runs} run(s)`,
    table(
      ['', 'in', 'cache write', 'cache read', 'out', 'USD'],
      [
        [
          'total',
          sum('inTok'),
          sum('cacheWriteTok'),
          sum('cacheReadTok'),
          sum('outTok'),
          usd.toFixed(4),
        ],
        [
          'per run',
          Math.round(sum('inTok') / runs),
          Math.round(sum('cacheWriteTok') / runs),
          Math.round(sum('cacheReadTok') / runs),
          Math.round(sum('outTok') / runs),
          (usd / runs).toFixed(4),
        ],
      ].concat(s.days ? [['per day', '', '', '', '', (usd / s.days).toFixed(4)]] : []),
    ),
    'Cache traffic dominates, and it is a near-fixed cost of the headless session rather than a',
    'function of transcript length — a longer session is not a proportionally dearer distillation.',
  ];
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
  // Recall's own family, for the injected-context section only. It records injected CHARACTERS and
  // is not given a `bytes` field, because one number with two sources is one number that will
  // disagree with itself. Scoped by the same slug for the same reason every other figure here is.
  const recall = /** @type {RecallSize[]} */ (readLines(logFiles(logDir, days, 'recall'))).filter(
    (r) => !slug || r.slug === slug,
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
  return `\nhook analytics\n${`${head}\n\n${render(summary, timeouts(manifest), recall)}`.replace(/^(?=.)/gm, '  ')}\n`;
}
