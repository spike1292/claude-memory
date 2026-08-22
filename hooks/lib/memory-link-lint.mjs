#!/usr/bin/env node
// SessionStart: name the L1 notes that are reachable only from the MOC.
//
// The "≥2 wikilinks, linked both ways" convention is documented in CLAUDE.md, but prose did not
// hold it: /memory:health found MOC-only notes in three consecutive audits (2026-08-07 four notes,
// 2026-08-08 jira-zscaler-403, 2026-08-08 prod-error-baseline). REFLECTIONS.md committed to a lint
// on the third recurrence. This is it.
//
// MOC-only is not corruption — the note is findable. It is invisible to the note graph, so nothing
// leads you to it while reading a sibling. Reporting it at session start is what makes it fixable.
// ponytail: names only, no auto-fix — deciding WHICH sibling should link is the judgement call.
//
// Ported from memory-link-lint.sh on 2026-08-17, for the shape rather than the language. The shell
// version ran `grep -rlF` over the whole Memory AND Insights tree ONCE PER NOTE — O(N×(N+M)) file
// reads, which is quadratic in vault size:
//
//     10 notes   152 ms      40 notes   589 ms      120 notes   2626 ms
//
// This reads every file once and indexes the links, so it is O(N+M). Measured at 120 notes:
// 2626 ms → 61 ms. The cost had been invisible because the repo it was measured in has no L1
// notes at all, so the loop never ran.
import fs from 'node:fs';
import path from 'node:path';
import { vault, projectKey, legacyKey } from './paths.mjs';

/**
 * Every wikilink target in one note's text.
 *
 * The shell matched the literal strings `[[n]]`, `[[n|` and `[[n#`, so a target ends at the first
 * `]`, `|` or `#` — and `[[foo bar]]` is a link to `foo bar`, not to `foo`. Extracting the target
 * and comparing it whole reproduces that exactly.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function linkTargets(text) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const m of text.matchAll(/\[\[([^\]|#]*)/g)) out.add(m[1]);
  return out;
}

/**
 * `.md` files under `dir`, recursively. Missing directories are simply empty.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function mdFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * L1 notes with no inbound wikilink from anywhere except the MOC and themselves.
 * `corpus` is [absolutePath, text] pairs across Memory/ and Insights/.
 *
 * @param {string} memDir
 * @param {readonly string[]} noteNames
 * @param {readonly (readonly [string, string])[]} corpus
 * @returns {string[]}
 */
export function findOrphans(memDir, noteNames, corpus) {
  const moc = path.join(memDir, 'MEMORY.md');
  /** @type {Map<string, Set<string>>} */
  const inbound = new Map(); // target -> Set(linking file)
  for (const [file, text] of corpus) {
    if (file === moc) continue; // the MOC does not count as a sibling
    for (const t of linkTargets(text)) {
      if (!inbound.has(t)) inbound.set(t, new Set());
      /** @type {Set<string>} */ (inbound.get(t)).add(file);
    }
  }
  return noteNames.filter((n) => {
    if (n === 'MEMORY') return false;
    const from = inbound.get(n);
    if (!from) return true;
    // a note linking to itself is not inbound
    for (const f of from) if (f !== path.join(memDir, `${n}.md`)) return false;
    return true;
  });
}

/**
 * Bolded figures in a MOC hook that the note it points at does not contain.
 *
 * MOC hooks restate figures, then the note body moves and the hook does not. /memory:health caught
 * this in four consecutive audits. ponytail: bolded numbers only — unbolded prose numbers are too
 * noisy to gate on. Commas are stripped on both sides so "1,172" matches "1172".
 *
 * @param {string} mocText
 * @param {(target: string) => string | null} readNote
 * @returns {{ target: string, n: string }[]}
 */
export function findDrift(mocText, readNote) {
  /** @type {{ target: string, n: string }[]} */
  const drift = [];
  for (const line of mocText.split('\n')) {
    if (!line.startsWith('- [[')) continue;
    const target = line.slice(4).split(']]')[0];
    const body = readNote(target);
    if (body === null) continue;
    /** @type {Set<string>} */
    const nums = new Set();
    for (const b of line.matchAll(/\*\*([^*]*)\*\*/g)) {
      for (const d of b[1].replace(/,/g, '').matchAll(/[0-9]{2,}/g)) nums.add(d[0]);
    }
    if (!nums.size) continue;
    const flat = body.replace(/,/g, '');
    // `sort -u` orders lexically, and the shell emitted findings in that order.
    for (const n of [...nums].sort()) if (!flat.includes(n)) drift.push({ target, n });
  }
  return drift;
}

/**
 * Claude Code loads the first 200 lines or 25 KB of `MEMORY.md`, whichever comes first, and drops
 * the rest. Since 2026-03 its auto memory reads `~/.claude/projects/<project>/memory/MEMORY.md` —
 * the path this plugin symlinks into the vault — so our L1 index IS that file, under its cap
 * (#75, docs/decisions/2026-08-22-auto-memory.md). Nothing upstream reports the truncation for a
 * file Claude Code did not write, so this is the only place it is ever said out loud.
 */
export const AUTO_MEMORY_CAP = { bytes: 25 * 1024, lines: 200 };

// Report from here up. 80% is a heads-up while the fix is still a trim; the alternative is finding
// out by losing notes.
const NEAR = 0.8;

/**
 * What WE count: bytes, and lines ignoring a trailing newline. The 200/25 KB cap is documented
 * upstream; how it counts a trailing newline is not, so this errs one line low rather than
 * reporting a file as fitting when it does not.
 *
 * @param {string} text
 * @returns {{ bytes: number, lines: number }}
 */
export function mocSize(text) {
  const bytes = Buffer.byteLength(text);
  return { bytes, lines: bytes === 0 ? 0 : text.replace(/\n$/, '').split('\n').length };
}

/**
 * The size finding for one MOC, or '' when it is comfortably under the cap.
 *
 * @param {string} text
 * @returns {string}
 */
export function findOversize(text) {
  const { bytes, lines } = mocSize(text);
  const pct = Math.max(bytes / AUTO_MEMORY_CAP.bytes, lines / AUTO_MEMORY_CAP.lines);
  if (pct < NEAR) return '';
  const size = `${bytes.toLocaleString('en-US')} bytes / ${lines} lines`;
  const cap = `${AUTO_MEMORY_CAP.bytes.toLocaleString('en-US')}-byte / ${AUTO_MEMORY_CAP.lines} lines cap`;
  if (pct <= 1)
    return [
      // Floor here, ceil in capReport: neither direction may let a file read as the wrong side of
      // the cap, and this branch is the one that still fits.
      `MEMORY.md is at ${Math.floor(pct * 100)}% of the ${cap} Claude Code loads it under`,
      `(${size}). Past it the rest is dropped with nothing reported. Move detail into the notes.`,
    ].join('\n');
  return [
    `MEMORY.md is ${size}, past the ${cap} Claude Code loads it under: everything after`,
    'the cap is DROPPED and no other check anywhere reports it. Trim the MOC — one line per note,',
    'the content belongs in the note.',
  ].join('\n');
}

/**
 * The lint report for `cwd`, or '' when there is nothing to say.
 *
 * Returns text instead of printing it, so the whole check is testable without a subprocess.
 * One pass over the corpus — the shell version read it once per note, which is the O(N x (N+M))
 * that took 10.9 s on a 49-note project and was being killed by the 10 s hook timeout.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function lint(cwd) {
  let slug;
  try {
    slug = projectKey(cwd);
  } catch {
    slug = legacyKey(cwd);
  }
  const isDir = (/** @type {string} */ p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  let mem = path.join(vault(), 'Memory', slug);
  if (!isDir(mem)) {
    slug = legacyKey(cwd);
    mem = path.join(vault(), 'Memory', slug);
  }
  if (!isDir(mem)) return '';
  return reportFor(mem, path.join(vault(), 'Insights', slug));
}

/**
 * The report for one project's `Memory/` and `Insights/` directories, or '' when there is nothing
 * to say. Split out of `lint()` so the findings are testable against a directory, without a vault
 * and without the resolution that picks one.
 *
 * @param {string} mem
 * @param {string} ins
 * @returns {string}
 */
export function reportFor(mem, ins) {
  /** @type {[string, string][]} */
  const corpus = [];
  for (const f of [...mdFiles(mem), ...mdFiles(ins)]) {
    try {
      corpus.push([f, fs.readFileSync(f, 'utf8')]);
    } catch {
      /* unreadable - skip */
    }
  }

  let names;
  try {
    names = fs
      .readdirSync(mem)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => f.slice(0, -3));
  } catch {
    return '';
  }

  /** @type {string[]} */
  const out = [];
  const orphans = findOrphans(mem, names, corpus);
  if (orphans.length) {
    out.push(
      'MOC-only memory notes (in MEMORY.md but no inbound [[wikilink]] from any sibling — the note',
    );
    out.push(
      'graph cannot reach them). Link each from a note someone would be reading when they need it:',
    );
    for (const n of orphans) out.push(`  - ${n}`);
  }

  const moc = path.join(mem, 'MEMORY.md');
  const byName = new Map(corpus.map(([f, t]) => [f, t]));
  if (!byName.has(moc)) return out.join('\n');
  const drift = findDrift(/** @type {string} */ (byName.get(moc)), (t) => {
    const p = path.join(mem, `${t}.md`);
    return byName.has(p) ? /** @type {string} */ (byName.get(p)) : null;
  });
  if (drift.length) {
    out.push('');
    out.push(
      'MEMORY.md figure drift — a bolded number in the MOC hook is absent from the note it points',
    );
    out.push(
      'at. Usually the note was corrected and the hook was not. Check the note, then fix the hook:',
    );
    for (const d of drift) out.push(`  - [[${d.target}]] hook says ${d.n}, not found in the note`);
  }

  const oversize = findOversize(/** @type {string} */ (byName.get(moc)));
  if (oversize) {
    if (out.length) out.push('');
    out.push(oversize);
  }
  return out.join('\n');
}

/**
 * `ok`/`warn`/`fail` lines about every `Memory/<slug>/MEMORY.md` in the vault, against the cap
 * Claude Code loads them under. Tab-separated so `scripts/doctor.sh` can print them with its own
 * helpers without a JSON parser — `jq` is optional there.
 *
 * Only the project the command was run from is named: this report is what people paste into
 * issues, and the other slugs are normalised remotes of private repos. Every other MOC still gets
 * its own percentage, largest first — "each MEMORY.md against the cap" is the point of the report,
 * and a count alone cannot say whether the other one is at 99% or at 9%.
 *
 * @param {string} vaultDir
 * @param {string} slug
 * @returns {string[]}
 */
export function capReport(vaultDir, slug) {
  const memRoot = path.join(vaultDir, 'Memory');
  /** @type {{ slug: string, bytes: number, lines: number, pct: number }[]} */
  const all = [];
  let dirs;
  try {
    dirs = fs.readdirSync(memRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(memRoot, d.name, 'MEMORY.md'), 'utf8');
    } catch {
      continue;
    }
    const { bytes, lines } = mocSize(text);
    all.push({
      slug: d.name,
      bytes,
      lines,
      pct: Math.max(bytes / AUTO_MEMORY_CAP.bytes, lines / AUTO_MEMORY_CAP.lines),
    });
  }
  if (!all.length) return [];

  const cap = `${AUTO_MEMORY_CAP.bytes.toLocaleString('en-US')} bytes / ${AUTO_MEMORY_CAP.lines} lines`;
  // Ceil, not round: a file one byte past the cap rounds to "100%", which reads as fitting. It
  // overstates a small file by a percent instead, which costs nothing.
  const pct = (/** @type {number} */ p) => `${Math.ceil(p * 100)}%`;
  const fix =
    'Claude Code loads only what fits and drops the rest, reporting nothing. Trim the MOC to one line per note.';
  /** @type {string[]} */
  const out = [];
  const mine = all.find((m) => m.slug === slug);
  if (mine) {
    const size = `${mine.bytes.toLocaleString('en-US')} bytes / ${mine.lines} lines — ${pct(mine.pct)} of ${cap}`;
    if (mine.pct > 1)
      out.push(`fail\tthis project's MEMORY.md is over the load cap: ${size}\t${fix}`);
    else if (mine.pct >= NEAR)
      out.push(`warn\tthis project's MEMORY.md is near the load cap: ${size}\t${fix}`);
    else out.push(`ok\tthis project's MEMORY.md fits the load cap: ${size}`);
  }
  const others = all.filter((m) => m !== mine).sort((a, b) => b.pct - a.pct);
  if (others.length) {
    const pcts = others.map((m) => pct(m.pct)).join(', ');
    const over = others.filter((m) => m.pct > 1).length;
    const near = others.filter((m) => m.pct >= NEAR && m.pct <= 1).length;
    if (over || near)
      out.push(
        `warn\t${over} of ${others.length} other MEMORY.md over the cap, ${near} near it — ${pcts}\t` +
          'other projects are not named — this report gets pasted into issues. Run /memory:doctor from each one.',
      );
    else out.push(`ok\t${others.length} other MEMORY.md all fit the cap — ${pcts}`);
  }
  return out;
}
