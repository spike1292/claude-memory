#!/usr/bin/env node
// PostToolUse (Write|Edit|MultiEdit): check a vault note the moment it is written.
//
// Every other mechanism in this system runs at SessionStart or during an audit — hours or days
// after the write, when the author no longer has the context to fix it cheaply. This is the
// missing enforcement point, borrowed from obsidian-second-brain's validate-ai-first.sh, whose
// comment says it best: the vault holds its shape because every write is checked, not because a
// future session remembers all the conventions.
//
// WARNS ONLY — never blocks a write, and never exits non-zero. A note half-written is still worth
// keeping; the point is to tell the author now rather than let an audit find it next week.
//
// Ported from validate-note.sh on 2026-08-17. This is the hottest hook in the system — it runs on
// every Write/Edit — and the shell version forked ~15 processes (jq, head, awk, grep x6, basename,
// sed) plus a node subprocess, measured 165.9ms per edit. Language was never the cost; fork-per-
// operation was. Verified against the shell version on every note in the vault: identical output.
//
// Still spawns `memory-audit-checks.mjs --check-file` rather than importing it. That module runs a
// vault-wide audit at import time, so making it importable means restructuring a 542-line file
// that /memory:health and /memory:prune depend on — a separate change, worth ~45ms more.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vault, scriptsDir } from './lib/paths.mjs';

/** Frontmatter block: the lines between the opening fence on line 1 and the next `---`. */
export function frontmatter(raw) {
  const lines = raw.split('\n');
  if (lines[0] !== '---') return null;          // no fence on line 1
  const end = lines.indexOf('---', 1);
  return lines.slice(1, end === -1 ? undefined : end).join('\n');
}

/**
 * Everything after the closing frontmatter fence — and the WHOLE file when there is no
 * frontmatter, which is what makes the body checks still fire on an unfenced note.
 * Mirrors the awk in the shell version: lines before the first fence are kept too.
 */
export function noteBody(raw) {
  const out = [];
  let fences = 0, past = false;
  for (const line of raw.split('\n')) {
    if (past) { out.push(line); continue; }
    if (line === '---') { fences++; if (fences === 2) past = true; continue; }
    if (fences === 0) out.push(line);
  }
  return out.join('\n').replace(/\n+$/, '');    // $(...) strips trailing newlines
}

/** Is this path a note we check at all? Operating surfaces are not notes. */
export function isCheckable(file, vaultRoot) {
  if (!file || !file.startsWith(`${vaultRoot}/`)) return false;
  if (!file.endsWith('.md')) return false;
  return !(file.endsWith('/REFLECTIONS.md') || file.endsWith('/MEMORY.md')
    || file.includes('/Logs/') || file.includes('/Graph/'));
}

/** The convention warnings for one note. Pure: takes content, returns strings, touches nothing. */
export function warnings(file, raw, vaultRoot) {
  const name = path.basename(file, '.md');
  const warn = [];
  const fm = frontmatter(raw);

  // Frontmatter must open on line 1 and close — a missing fence silently voids every field below it.
  if (fm === null) {
    warn.push('no frontmatter fence on line 1 — every field below it is invisible to the tooling');
  } else {
    if (fm.includes('\t')) warn.push('tab inside frontmatter — YAML needs spaces');
    if (file.startsWith(path.join(vaultRoot, 'Memory') + '/')) {
      if (!new RegExp(`^name:[ \\t]*["']?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?[ \\t]*$`, 'm').test(fm)) {
        warn.push(`frontmatter name: must equal the filename (${name}) or [[wikilinks]] will not resolve`);
      }
      if (!/^[ \t]*confidence:[ \t]*(high|medium|low)/m.test(fm)) {
        warn.push('no confidence: — /memory:health cannot pick a winner when two notes disagree');
      }
    }
  }

  const body = noteBody(raw);

  // Retrievability: the alias line is the paraphrase bridge for keyword search. Measured
  // 2026-08-14 — authored paraphrase questions reach the right note only ~46% of the time.
  if (!body.includes('_Also asked as:')) {
    warn.push("no '_Also asked as:' line — add 2-3 paraphrases in an OUTSIDER's words, not the note's own jargon");
  }

  // A reversal announced only in prose is invisible to every check (see memory-audit-checks.mjs).
  if (/(⚠ *)?\**(SUPERSEDED|superseded by|no longer true)/i.test(body)
      && !/superseded +[0-9]{4}-[0-9]{2}-[0-9]{2} +by +\[\[/i.test(body)) {
    warn.push('says superseded in prose — mark the claim: (superseded YYYY-MM-DD by [[note]])');
  }
  return warn;
}

// Suffix-path detection is deliberately NOT here. It needs the repo's full file list to decide, and
// an early version of this block silently never fired — a check that does not run is worse than no
// check, because it reads as coverage. memory-audit-checks.mjs does it vault-wide and is tested.

function main() {
  let payload = '';
  try { payload = fs.readFileSync(0, 'utf8'); } catch { return; }
  let file = '';
  try {
    const j = JSON.parse(payload);
    file = j?.tool_input?.file_path || j?.tool_input?.path || '';
  } catch { return; }
  if (!file) return;

  const vaultRoot = vault();
  if (!isCheckable(file, vaultRoot)) return;
  let raw;
  try {
    if (!fs.statSync(file).isFile()) return;
    raw = fs.readFileSync(file, 'utf8');
  } catch { return; }

  const warn = warnings(file, raw, vaultRoot);

  // Claim-level checks (CLAIM-1 metric provenance, FRESH-1 staleness, prose-only supersession) run
  // from the tested predicates rather than being re-implemented here. This is the write-time half:
  // an inflated recall figure once reached a public README *between* two audits.
  let claims = '';
  try {
    claims = execFileSync(process.execPath,
      [path.join(scriptsDir, 'memory-audit-checks.mjs'), '--check-file', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n+$/, '');
  } catch { /* best effort — a failed audit must never break a write */ }

  if (!warn.length && !claims) return;
  console.log(`note conventions — ${path.basename(file, '.md')}`);
  for (const w of warn) console.log(`  · ${w}`);
  if (claims) console.log(claims);
}

// Guarded on argv[1] as well as the flag: this module exports predicates that a test could import.
if (process.argv[1] && process.argv.includes('--selftest')
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assert = await import('node:assert').then((m) => m.default);
  const V = '/v';

  assert.strictEqual(frontmatter('---\na: 1\n---\nbody'), 'a: 1');
  assert.strictEqual(frontmatter('no fence\n---\n'), null, 'fence must be on line 1');
  // An unterminated fence must not swallow the check — it reports as frontmatter, not as absent.
  assert.strictEqual(frontmatter('---\na: 1\nb: 2'), 'a: 1\nb: 2');

  // Body = after the SECOND fence, but the whole file when unfenced, so body checks still fire.
  assert.strictEqual(noteBody('---\na: 1\n---\nhello'), 'hello');
  assert.strictEqual(noteBody('plain note'), 'plain note');

  assert.ok(isCheckable(`${V}/Memory/p/a.md`, V));
  assert.ok(!isCheckable(`${V}/Logs/p/a.md`, V), 'Logs are an operating surface');
  assert.ok(!isCheckable(`${V}/Graph/p/a.md`, V));
  assert.ok(!isCheckable(`${V}/Memory/p/MEMORY.md`, V), 'the MOC is not a note');
  assert.ok(!isCheckable(`${V}/Memory/p/REFLECTIONS.md`, V));
  assert.ok(!isCheckable('/elsewhere/a.md', V), 'outside the vault');
  assert.ok(!isCheckable(`${V}/Memory/p/a.txt`, V));

  const good = '---\nname: a\nconfidence: high\n---\n\nbody\n\n_Also asked as: one, two._\n';
  assert.deepStrictEqual(warnings(`${V}/Memory/p/a.md`, good, V), []);

  const w1 = warnings(`${V}/Memory/p/a.md`, '---\nname: WRONG\n---\n\nx\n', V);
  assert.ok(w1.some((w) => w.includes('name: must equal the filename')));
  assert.ok(w1.some((w) => w.includes('no confidence:')));
  assert.ok(w1.some((w) => w.includes('_Also asked as:')));

  // Insights notes carry neither name: nor confidence: — those two are Memory/ only.
  const w2 = warnings(`${V}/Insights/p/Mistakes/a.md`, '---\ntitle: x\n---\n\nx\n\n_Also asked as: q._\n', V);
  assert.deepStrictEqual(w2, []);

  assert.ok(warnings(`${V}/Memory/p/a.md`, 'no fence at all\n\n_Also asked as: q._\n', V)
    .some((w) => w.includes('no frontmatter fence')));
  assert.ok(warnings(`${V}/Memory/p/a.md`, '---\nname: a\nconfidence: high\ntab:\there\n---\n\n_Also asked as: q._\n', V)
    .some((w) => w.includes('tab inside frontmatter')));

  const sup = '---\nname: a\nconfidence: high\n---\n\nThis is SUPERSEDED now.\n\n_Also asked as: q._\n';
  assert.ok(warnings(`${V}/Memory/p/a.md`, sup, V).some((w) => w.includes('says superseded in prose')));
  const supOk = '---\nname: a\nconfidence: high\n---\n\nGone (superseded 2026-08-01 by [[b]]).\n\n_Also asked as: q._\n';
  assert.deepStrictEqual(warnings(`${V}/Memory/p/a.md`, supOk, V), []);

  // A filename with regex metacharacters must not blow up the name: match.
  assert.doesNotThrow(() => warnings(`${V}/Memory/p/a+b(c).md`, '---\nname: a+b(c)\n---\n', V));
  assert.ok(!warnings(`${V}/Memory/p/a+b(c).md`, '---\nname: a+b(c)\nconfidence: low\n---\n\n_Also asked as: q._\n', V)
    .some((w) => w.includes('name: must equal')), 'metacharacters must match literally');

  console.log('selftest: 24 assertions passed');
} else {
  try { main(); } catch { /* a hook must never fail a write */ }
}
