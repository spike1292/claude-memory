#!/usr/bin/env node
// Mechanical half of /memory:health. Run it, judge the output — it decides nothing.
//
// Why this exists: three consecutive audits hand-derived these same checks, and two of them got
// the same two wrong (REFLECTIONS.md 2026-08-10, 2026-08-14):
//   - `^confidence:` reports every note missing the field. It is nested under `metadata:`.
//   - a repo-path regex swallows the `…/` in abbreviated prose paths and calls 15 of them missing.
// Both are encoded below. Judgement stays with the auditor; this only finds candidates.
//
// Usage: node ~/.claude/scripts/memory-audit-checks.mjs [repo-dir]   (default: cwd)
// ponytail: prints findings, never edits. Deleting or rewriting a note needs confirmation anyway.

import fs from 'node:fs';

// ---------------------------------------------------------------- predicates (self-tested below)

// A claim about STATE that a later event can reverse — not an instruction. "**Never** cite an ADR
// from its filename" is advice and stays true forever; "cra2 prod has never served traffic" is a
// measurement with a shelf life. Gate on a state verb, and drop imperative openers.
const STATE_VERB =
  'served?|serves|had|has|have|been|is|are|was|were|ran|run|happened|occurred|shipped|landed|merged|deployed|fired|reached|exists?|existed|added|done|implemented|fixed|enabled|migrated|started|carried';
const STANDING = new RegExp(
  `\\b(?:never (?:${STATE_VERB})|(?:has|have|had|is|are|was|were) never|not yet (?:${STATE_VERB})|` +
    `no [a-z0-9 '\`*-]{0,25} yet\\b|(?:none|zero) (?:of )?[a-z0-9 '\`*-]{0,25}(?:traffic|usage|customers|requests)|` +
    `so far no|still no\\b|(?:has|have)(?:n't| not) (?:${STATE_VERB}))`,
  'i',
);
// Imperative advice: the line's first words tell the reader what to do.
const IMPERATIVE =
  /^[\s>*_#-]*(?:\*\*)?(?:never|do not|don't|avoid|always|prefer|use|treat|read|check|verify)\b/i;

/** @param {string} line @returns {boolean} */
export function isStandingNegative(line) {
  const t = line.trim();
  if (!t || t.startsWith('_Also asked as')) return false;
  if (IMPERATIVE.test(t)) return false;
  return STANDING.test(t);
}

// confidence: is nested under metadata:, so it is indented. A ^-anchored grep reports every note
// as missing it — the exact false positive logged in REFLECTIONS 2026-08-10 and re-hit 2026-08-14.
/** @param {string} frontmatter @returns {boolean} */
export function hasConfidence(frontmatter) {
  return /^\s*confidence:\s*(high|medium|low)\s*$/m.test(frontmatter);
}

// An abbreviated path (`libs/foo/.../bar.ts`) is prose, not a claim. Reporting it "missing" is the
// other logged false positive: 15 of 24 "absent" paths in the 2026-08-14 audit were these.
/** @param {string} context @returns {boolean} */
export function isAbbreviated(context) {
  return /…|\.\.\./.test(context);
}

// Carry-forward list: rows in REFLECTIONS.md whose disposition is still "deferred". A deferred item
// used to survive only if the next prune happened to rank it — two duplicate pairs deferred on
// 2026-08-08 were still there on 2026-08-14, because the 2026-08-08 prune merged three *different*
// pairs. The row IS the ledger: closing an item means editing its disposition, not just doing it.
/**
 * @param {string} text
 * @returns {{ entry: string, finding: string, disposition: string }[]}
 */
export function parseDeferred(text) {
  /** @type {{ entry: string, finding: string, disposition: string }[]} */
  const out = [];
  let entry = '?';
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*—\s*(\S+)/);
    if (h) entry = `${h[1]} ${h[2]}`;
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const disposition = cells[cells.length - 1];
    if (/^\s*-+\s*$/.test(cells[0]) || /^disposition$/i.test(disposition)) continue; // header / separator
    if (entry === '?') continue; // a disposition belongs to a dated entry; tables above the first one are not findings
    // Anchor to the opening token: a "**declined** — complementary, not deferred" row is CLOSED.
    if (!/^[\s*_]*deferred\b/i.test(disposition)) continue;
    out.push({ entry, finding: cells[0], disposition });
  }
  return out;
}

// Bi-temporal bookkeeping: a fact has two dates — when it was TRUE (`valid_from`, and once reversed
// `superseded_on`) and when the vault LEARNED it (`modified`). Prose alone cannot answer "what did
// we believe on Tuesday", and a note headed "⚠ SUPERSEDED" in the body is invisible to every check.
// This finds claims that announce supersession in prose without recording it in frontmatter.
// Supersession here is per-CLAIM, not per-note. L1 notes are large and multi-claim: when the CRA2
// cutover landed it reversed one section of `cra2-ecs-runtime-facts` while the rest stayed true, so
// a note-level `superseded_by:` would have been a lie. The marker is therefore inline and sits with
// the claim it kills: `(superseded YYYY-MM-DD by [[note]])`. Note-level frontmatter is still honoured
// for the rarer case where an entire note is dead.
// Only CLAIM-supersession, not component replacement. "Core Modules already superseded by
// `@integration/api-client-*`" and "redirects-poller superseded by the KVS pipeline" describe
// software being replaced — true statements that will never need a marker. The house style for a
// dead *claim* is line-initial and shouty: "⚠ SUPERSEDED …" or "**Superseded since …**".
const SUPERSEDED_PROSE =
  /^[\s>*_#-]*(?:⚠\s*)?\**(?:SUPERSEDED\b|Superseded (?:since|on|by)\b|No longer true\b)/m;
// The load-bearing part is "superseded <date> by [[note]]" — it may sit anywhere inside a
// parenthetical, e.g. "(measured 2026-08-12, superseded 2026-08-14 by [[x]])". Requiring the paren
// to be adjacent rejected exactly the markers this convention produces.
const SUPERSEDED_MARKER = /superseded\s+\d{4}-\d{2}-\d{2}\s+by\s+\[\[[^\]]+\]\]/i;
/**
 * @param {string} raw
 * @returns {{ declared: string|null, on: string|null, inProse: boolean, marked: boolean }}
 */
export function supersessionState(raw) {
  const fm = (raw.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  const by = (fm.match(/^\s*superseded_by:\s*(.+)$/m) || [])[1];
  const on = (fm.match(/^\s*superseded_on:\s*(.+)$/m) || [])[1];
  const body = raw.slice(fm.length);
  return {
    declared: by ? by.trim().replace(/^["'\[]+|["'\]]+$/g, '') : null,
    on: on ? on.trim() : null,
    inProse: SUPERSEDED_PROSE.test(body),
    marked: SUPERSEDED_MARKER.test(body),
  };
}

// FRESH-1, after obsidian-second-brain's freshness policy: **every stored fact must be timeless,
// dated, or a pointer.** A present-tense claim about a volatile quantity, with no stamp and outside
// a dated container, is the sentence that becomes a lie next Tuesday while still reading as truth.
// Three legal forms: timeless ("invoices are issued monthly"), snapshot ("2026-08-12: 47 tasks"),
// pointer ("where truth lives: <url>, last observed X (as of DATE)").
// Precision over recall: the quantity must sit NEXT TO the volatile noun ("965 Insights notes",
// "47 tasks"), not merely somewhere on the same line. A looser version reported 133 hits across 47
// notes — mostly ticket ids like ATL-3317 and MR numbers — which is a backlog nobody reads.
const VOLATILE =
  '(?:tasks?|jobs?|tickets?|issues?|notes?|projects?|libs?|apps?|services?|clusters?|instances?|stacks?|alarms?|errors?|events?|requests?|users?|members?|commits?|branches?|files?|pairs?|gaps?|duplicates?)';
const COUNTED = new RegExp(
  `(?<![-#!\\w/.])(?:~|about\\s+)?\\d{1,6}(?:,\\d{3})*\\s*%?\\s+(?:\\w+\\s+){0,2}${VOLATILE}\\b`,
  'i',
);
const PAST =
  /\b(was|were|had|reached|hit|closed|shipped|merged|landed|dropped|ended|became|used to|previously|at the time)\b/i;
// Any ISO date on the line makes it a snapshot — "Measured **2026-08-08** … 501 projects" is a
// dated observation whether or not the date sits in the parenthesised house style.
const STAMPED = /\d{4}-\d{2}(-\d{2})?/;
const POINTER =
  /\b(where truth lives|source of truth|read it from|query it|re-?run|check the MR|from the (?:API|dashboard))\b/i;

/** @param {string} line @returns {boolean} */
export function isUnstampedVolatileClaim(line) {
  const t = line.trim();
  if (!t || t.startsWith('|') || t.startsWith('>') || t.startsWith('_Also asked as')) return false;
  if (/^#{1,6}\s/.test(t) || /^```/.test(t)) return false;
  if (/^\w[\w-]*:\s/.test(t)) return false; // frontmatter key: value
  if (STAMPED.test(t) || POINTER.test(t) || PAST.test(t)) return false; // dated, pointed, or history
  return COUNTED.test(t.replace(/`[^`]*`/g, ' ')); // quoted code is never a claim
}

// CLAIM-1: a METRIC must name the instrument that produced it.
//
// This is the mechanical answer to the failure that recurred three times in one cycle: a number was
// believed because it looked plausible, and the thing that produced it was never checked.
//   · "CLAUDE.md now mandates X"      — the file was never opened
//   · synthesis grade 0.945 vs 0.947  — the test was wrong, not the note
//   · "recall 0.94 / 1.00"            — the question set was rewritten every run
// The L1 note `instrument-must-match-healthy-signal` already taught this and did not prevent any of
// them, because prose cannot gate a write. This can: a metric without provenance is flagged.
//
// Deliberately narrow. FRESH-1 already covers plain counts going stale; this covers the class that
// actually burned us — evaluative scores, which look authoritative precisely because they are
// specific. A bare count is a fact; a metric is a claim about a measurement.
// The metric word must sit NEXT TO a value. "Filename drift hides coverage" and "ALB coverage → the
// EDGE dashboard" use these words descriptively; only "recall@5 46.4%" or "MRR 0.289" is a claim
// about a measurement. First cut matched the word anywhere on a line containing any digit and was
// ~80% false positives — the same over-loose first draft as FRESH-1 (133 hits) and the supersession
// check (2 of 3). Assume a new check is miscalibrated until its output has been read line by line.
const METRIC =
  /\b(recall(@\d+)?|precision|MRR|F1|accuracy|hit[- ]rate|error[- ]rate|p50|p90|p95|p99|latency|throughput|uptime)\b[^.;]{0,15}?\d|\d+(\.\d+)?\s*%?\s*(recall|precision|MRR|accuracy|uptime)\b/i;
// A target is not a measurement: "SLO: p90 latency < 2s" states an objective, and objectives do not
// need provenance — they need agreement.
const TARGET = /\b(SLO|SLA|objective|target|budget|threshold|goal|aim for|must stay)\b/i;
// Provenance = anything letting a reader re-run or locate the measurement: a script, a command, a
// case set, a dated "measured/verified", or an explicit sample size.
const PROVENANCE =
  /(`[^`]*(?:\.mjs|\.py|\.sh|\.jsonl|--run|--mode|--cases)[^`]*`|\b(?:measur\w+|verified|benchmark(?:ed)?|case set|sample|question set|over \d+ (?:cases|questions|notes)|n\s*=\s*\d+)\b|\d{4}-\d{2}-\d{2})/i;

// `context` is the line plus its neighbours: a claim and its provenance routinely straddle a wrap
// ("On a versioned 28-case set:\n semantic **recall@5 46.4%**"), and flagging the second half of a
// properly-sourced sentence is noise.
/** @param {string} line @param {string} [context] @returns {boolean} */
export function isUnprovenancedMetric(line, context = line) {
  const t = line.trim();
  if (!t || t.startsWith('_Also asked as') || /^\w[\w-]*:\s/.test(t)) return false;
  if (/^#{1,6}\s/.test(t) || /^```/.test(t) || t.startsWith('|')) return false;
  if (!METRIC.test(t)) return false;
  if (TARGET.test(t)) return false;
  // Advice ABOUT metrics is not a claim OF one. "Store live metrics alongside the queries that
  // produced them" is the same lesson this check enforces — flagging it is pure noise.
  if (
    IMPERATIVE.test(t) ||
    /^[\s>*_#-]*(?:\*\*)?(?:comparing|storing|measuring|tracking|reporting)\b/i.test(t)
  )
    return false;
  return !PROVENANCE.test(context);
}

// FRESH-4: a dated heading opens a snapshot region — everything under "## Measured 2026-08-08"
// claims what was true then, so it cannot rot. Region ends at the next heading of equal or higher
// level. Without this the lint flags every line of a measurement section.
/**
 * @param {string} body
 * @returns {{ line: number, text: string }[]}
 */
export function freshnessFindings(body) {
  /** @type {{ line: number, text: string }[]} */
  const out = [];
  /** @type {number|null} */
  let datedLevel = null;
  body.split('\n').forEach((line, i) => {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      if (datedLevel !== null && level <= datedLevel) datedLevel = null;
      if (/\d{4}-\d{2}(-\d{2})?/.test(h[2])) datedLevel = level;
      return;
    }
    if (datedLevel !== null) return;
    if (isUnstampedVolatileClaim(line)) out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

/**
 * @param {Iterable<string>} paths
 * @returns {Map<string, string[]>}
 */
export function buildSuffixIndex(paths) {
  const idx = new Map();
  for (const t of paths)
    for (let i = t.indexOf('/'); i !== -1; i = t.indexOf('/', i + 1)) {
      const suf = t.slice(i + 1);
      if (!idx.has(suf)) idx.set(suf, []);
      /** @type {string[]} */ (idx.get(suf)).push(t);
    }
  return idx;
}

/** @param {string} f @returns {string[]} */
export function checkFile(f) {
  if (!fs.existsSync(f)) return [];
  const raw = fs.readFileSync(f, 'utf8');
  const lines = raw.split('\n');
  /** @type {string[]} */
  const out = [];
  lines.forEach((l, n) => {
    const ctx = lines.slice(Math.max(0, n - 2), n + 2).join(' ');
    if (isUnprovenancedMetric(l, ctx))
      out.push(
        `  · line ${n + 1}: metric with no instrument named — cite the run, script, case set or date`,
      );
  });
  for (const fr of freshnessFindings(raw))
    out.push(
      `  · line ${fr.line}: volatile quantity, no stamp — make it timeless, a dated snapshot, or a pointer`,
    );
  const s = supersessionState(raw);
  if (s.inProse && !s.marked && !s.declared)
    out.push('  · reversal stated in prose only — mark it: (superseded YYYY-MM-DD by [[note]])');
  return out;
}

// A bash `[[ $var =~ re ]]` test inside a fenced block parses as a wikilink. Reported as a dangling
// link on 2026-08-22 from a note about shell arithmetic. Fences are stripped before link scanning,
// and inline code with them: a literal `[[wikilink]]` in REFLECTIONS.md false-positives otherwise.
// ponytail: backtick fences only — 0 of 442 notes use `~~~`; add it when one does.
/** @param {string} text @returns {string} */
export function stripCodeBlocks(text) {
  return text
    .replace(/^ {0,3}(`{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
}
