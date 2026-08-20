// The `--stats` half of /memory:doctor: what per-prompt recall actually did, from its own log.
// The CLI entry is scripts/doctor-perf.mjs.
//
// Two gates decide whether a prompt gets a brief — cosine 0.55 and BM25 6.0 — and both were tuned
// on small hand-made sets, one of which cannot ship. The comments beside them say to "read the
// abstain rate in the log" before moving them; until this existed, nothing could. This is the
// instrument, not a change to what it measures.
//
// Read-only, and the same hard rule as doctor-perf.mjs: no server, no model, no index write. It
// opens no database itself — the index note set arrives as a value, so this module stays testable
// on a runtime without `node:sqlite`, exactly as indexStats() takes its counts.
//
// It must also read log lines written before the fields it reports existed. Every metric below is
// therefore counted over the lines that HAVE the key, and reports how many did not, rather than
// treating a missing `ms` as a fast recall.

import fs from 'node:fs';
import path from 'node:path';
import { table } from './doctor-perf.mjs';
import { MAX_CHARS } from '../../hooks/lib/memory-recall.mjs';

/**
 * @typedef {{
 *   t?: string, slug?: string, abstained?: boolean, reason?: string, top?: string | null,
 *   score?: number, injected?: number, chars?: number, via?: string,
 *   ms?: number, k?: number, notes?: string[],
 * }} RecallLine
 */
/** @typedef {{ decisions: number, injected: number, scores: number[], latencies: number[] }} ArmStats */

export const DEFAULT_DAYS = 7;
const TOP_N = 10;

/**
 * The daily log files in the window, oldest first.
 *
 * The window is counted in FILES, not in days elapsed: names are dated and recall only writes a
 * file on a day it ran, so "the last 7 files" is the last 7 days recall was armed. Nothing here
 * reads the clock — a machine that has been off for a month still reports its last week of use.
 *
 * @param {string} dir
 * @param {number} [days]
 * @returns {string[]}
 */
export function logFiles(dir, days = DEFAULT_DAYS) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((f) => /^recall-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .slice(-Math.max(1, days))
    .map((f) => path.join(dir, f));
}

/**
 * Every parseable line from those files. An unparseable line is skipped, not thrown on: the file
 * is append-only from a hook that can be killed mid-write, so a torn last line is expected.
 *
 * @param {readonly string[]} files
 * @returns {RecallLine[]}
 */
export function readLines(files) {
  /** @type {RecallLine[]} */
  const out = [];
  for (const f of files) {
    let raw;
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (v && typeof v === 'object') out.push(v);
      } catch {
        /* torn or hand-edited line */
      }
    }
  }
  return out;
}

/**
 * Nearest-rank percentile over an unsorted list. Empty is null, never 0 — a missing measurement
 * and a measured zero must not print the same.
 *
 * @param {readonly number[]} values
 * @param {number} p
 * @returns {number | null}
 */
export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

// The absence of `via` is the BM25 fallback — a documented contract of the log format, not an
// oversight, so it is read here rather than repaired.
//
// The 'no index' abstain is the exception: the ENTRY writes it before either arm exists — no
// socket, no BM25 — and it carries no `via`, so it would land in the keyword bucket and make the
// fallback look fast and useless. On an install whose index moved, every keyword row would be that.
// Bucketed separately here rather than given a `via` at the hook, which would change the contract.
/** @param {RecallLine} l @returns {string} */
const armOf = (l) => (l.reason?.startsWith('no index') ? '(no index)' : (l.via ?? 'keyword'));

/**
 * Which notes of a decision actually reached the prompt.
 *
 * `notes` is the candidate list in render order and `injected` is how many of them survived the
 * character budget, so the injected set is a prefix. Lines written before those fields existed
 * carry only `top`, which is the first of them — one note, correctly, rather than none.
 *
 * @param {RecallLine} l
 * @returns {string[]}
 */
export function injectedNotes(l) {
  if (l.abstained) return [];
  if (Array.isArray(l.notes)) return l.notes.slice(0, l.injected ?? l.notes.length);
  return typeof l.top === 'string' ? [l.top] : [];
}

/**
 * The log files are MACHINE-WIDE — one `logs/` directory, every project appending to the same daily
 * file — and every line carries its `slug`. The never-injected list can only be resolved for one
 * project (its index is per slug), so mixing projects would report one project's notes against
 * every project's retrievals. Measured on this machine 2026-08-20: a 7-file window held 5 slugs at
 * 791/186/20/8/1 decisions, so the headline rate was mostly another project's. Passing
 * `slug: null` deliberately keeps every line; passing a slug drops the rest, and the report says
 * how many it dropped rather than quietly narrowing.
 *
 * @param {readonly RecallLine[]} lines
 * @param {readonly string[] | null} [indexNotes]
 * @param {string | null} [slug]
 */
export function summarize(lines, indexNotes = null, slug = null) {
  const seen = lines.length;
  lines = slug ? lines.filter((l) => l.slug === slug) : lines;
  /** @type {Map<string, ArmStats>} */
  const arms = new Map();
  /** @type {Map<string, number>} */
  const reasons = new Map();
  /** @type {Map<string, number>} */
  const injections = new Map();
  let injected = 0;
  let untimed = 0;
  let unlisted = 0;
  let trimmed = 0;

  for (const l of lines) {
    const arm = armOf(l);
    const a = arms.get(arm) ?? { decisions: 0, injected: 0, scores: [], latencies: [] };
    a.decisions++;
    if (typeof l.score === 'number') a.scores.push(l.score);
    if (typeof l.ms === 'number') a.latencies.push(l.ms);
    else untimed++;
    if (!l.abstained) {
      a.injected++;
      injected++;
      // A line older than `notes` names only its top hit, so up to three notes it really did inject
      // are invisible. That does not merely blur the most-injected table — it puts those notes in
      // the NEVER-injected list, which is the one output the whole feature exists to produce.
      if (!Array.isArray(l.notes)) unlisted++;
      if (typeof l.k === 'number' && typeof l.injected === 'number' && l.k > l.injected) trimmed++;
    } else {
      const r = l.reason ?? '(no reason)';
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }
    arms.set(arm, a);
    for (const n of injectedNotes(l)) injections.set(n, (injections.get(n) ?? 0) + 1);
  }

  // `indexNotes?.length`, not `indexNotes`: an index that opens but holds no rows comes back as an
  // empty array, and `[]` would report "all 0 indexed notes have surfaced" — the opposite of true.
  const never = indexNotes?.length ? indexNotes.filter((n) => !injections.has(n)) : null;
  return {
    decisions: lines.length,
    injected,
    abstained: lines.length - injected,
    untimed,
    unlisted,
    trimmed,
    first: lines.find((l) => l.t)?.t ?? null,
    last: [...lines].reverse().find((l) => l.t)?.t ?? null,
    arms: [...arms.entries()].sort((a, b) => b[1].decisions - a[1].decisions),
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]),
    top: [...injections.entries()].sort((a, b) => b[1] - a[1]),
    never,
    indexed: indexNotes?.length ? indexNotes.length : null,
    emptyIndex: Array.isArray(indexNotes) && indexNotes.length === 0,
    slug,
    otherProjects: seen - lines.length,
  };
}

/** @param {number | null} v @param {number} [digits] @returns {string} */
const num = (v, digits = 0) => (v === null ? '-' : v.toFixed(digits));

/** @param {number} n @param {number} of @returns {string} */
const pct = (n, of) => (of ? `${n} (${Math.round((n / of) * 100)}%)` : '0');

/**
 * The recall section body.
 *
 * @param {ReturnType<typeof summarize>} s
 * @returns {string}
 */
export function render(s) {
  if (!s.decisions)
    return s.otherProjects
      ? `not measured: none of the ${s.otherProjects} logged decisions in this window belong to ` +
          `${s.slug}. The log is machine-wide; this project has not run with recall armed.`
      : 'not measured: no recall decisions logged in this window.';

  const window = s.first && s.last ? ` (${s.first.slice(0, 10)} … ${s.last.slice(0, 10)})` : '';
  const out = [
    s.slug
      ? `${s.decisions} decisions for ${s.slug}${window}` +
        (s.otherProjects
          ? ` — ${s.otherProjects} more in this window belong to other projects`
          : '')
      : `${s.decisions} decisions, every project on this machine${window}`,
    `injected ${pct(s.injected, s.decisions)}   abstained ${pct(s.abstained, s.decisions)}`,
    '',
    // Scores are NOT comparable across the two rows: the server arm is cosine (gate 0.55) and the
    // keyword arm is absolute BM25 (gate 6.0). Read each row against its own gate.
    table(
      ['arm', 'decisions', 'injected', 'score p50', 'score p90', 'ms p50', 'ms p95'],
      s.arms.map(([name, a]) => [
        name,
        a.decisions,
        pct(a.injected, a.decisions),
        num(percentile(a.scores, 50), 2),
        num(percentile(a.scores, 90), 2),
        num(percentile(a.latencies, 50), 1),
        num(percentile(a.latencies, 95), 1),
      ]),
    ),
    'server = the fused vector arm, keyword = the BM25 fallback, (no index) = neither ran. Scores',
    'are on different scales: cosine against a 0.55 gate, BM25 against 6.0 — never compare rows.',
    'ms is the WHOLE armed path from process start, not the arm alone, so a keyword row includes',
    'node startup and any server round trip that failed or timed out before it.',
  ];

  if (s.untimed)
    out.push(
      '',
      `${s.untimed} of ${s.decisions} decisions predate latency logging — not counted in ms.`,
    );
  if (s.unlisted)
    out.push(
      '',
      `${s.unlisted} of ${s.injected} injections predate candidate logging — only their top note is`,
      'counted, so the never-injected list below is an UPPER BOUND until they age out of the window.',
    );
  // NOT "the budget", which was the first wording and was wrong for half the records: the keyword
  // arm renders with a trailing weak-hit floor (MIN_SCORE / 2) that renderLines checks BEFORE the
  // character budget, so its candidates can be dropped for being weak rather than for being long.
  // Only the semantic arm renders floorless, where k > injected does mean the budget.
  if (s.trimmed)
    out.push(
      '',
      `${s.trimmed} injection(s) rendered fewer notes than the arm offered — the ${MAX_CHARS}-char ` +
        'budget, or (keyword arm only) the trailing weak-hit floor.',
    );

  if (s.reasons.length)
    out.push(
      '',
      'abstained by reason',
      // Count first: `table` pads every column but the last, and a reason is long and variable.
      table(
        ['n', 'reason'],
        s.reasons.map(([r, n]) => [n, r]),
      ),
    );

  if (s.top.length)
    out.push(
      '',
      `most injected notes (of ${s.top.length} ever injected)`,
      table(
        ['n', 'note'],
        s.top.slice(0, TOP_N).map(([n, c]) => [c, n]),
      ),
    );

  if (s.never === null) {
    out.push(
      '',
      s.emptyIndex
        ? 'never-injected notes: not measured — this project has an index and it holds no notes.'
        : 'never-injected notes: not measured — no readable index for this project.',
    );
  } else if (!s.never.length) {
    out.push('', `never-injected notes: none — all ${s.indexed} indexed notes have surfaced.`);
  } else {
    out.push(
      '',
      `never injected: ${s.never.length} of ${s.indexed} indexed notes`,
      s.never
        .slice(0, TOP_N)
        .map((n) => `  ${n}`)
        .join('\n') + (s.never.length > TOP_N ? `\n  … ${s.never.length - TOP_N} more` : ''),
      'A note nobody retrieves is dead weight — or is phrased in words no prompt uses.',
    );
  }

  return out.join('\n');
}

/**
 * The whole `--stats` report, as one string.
 *
 * @param {{
 *   logDir: string,
 *   days?: number,
 *   indexNotes?: readonly string[] | null,
 *   slug?: string | null,
 * }} options
 * @returns {string}
 */
export function report({ logDir, days = DEFAULT_DAYS, indexNotes = null, slug = null }) {
  const files = logFiles(logDir, days);
  const summary = summarize(readLines(files), indexNotes, slug);
  const body = render(summary);
  const head = files.length
    ? `${files.length} log file(s), most recent first: ${files
        .slice(-3)
        .reverse()
        .map((f) => path.basename(f))
        .join(', ')}`
    : `no recall logs in ${logDir} — recall is off, or has never run armed.`;
  // This is the only doctor section that prints VAULT CONTENT — note names, from a private vault —
  // and the command body tells the reader to show doctor output verbatim, next to a header calling
  // a paste of the whole thing what an issue wants. The warning ships with the data rather than
  // only in the docs, because the two get separated the moment someone copies the report.
  const named = summary.top.length || summary.never?.length;
  const caution = named
    ? '\n\nThe note names above come from your vault. Everything else in /memory:doctor is safe to' +
      '\npaste into a public issue; this section is not.'
    : '';
  return `\nrecall analytics\n${`${head}\n\n${body}${caution}`.replace(/^(?=.)/gm, '  ')}\n`;
}
