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
// The claim-level checks are IMPORTED, not spawned. Spawning `memory-audit-checks.mjs
// --check-file` cost ~48ms of the hook's 93ms; that module is now import-safe (it runs its
// vault-wide audit only when executed directly), so the predicates run in-process.
import fs from 'node:fs';
import path from 'node:path';
import { vault } from './paths.mjs';
import { checkFile } from '../../scripts/lib/memory-audit-checks.mjs';

/** Frontmatter block: the lines between the opening fence on line 1 and the next `---`. */
export function frontmatter(raw) {
  const lines = raw.split('\n');
  if (lines[0] !== '---') return null; // no fence on line 1
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
  let fences = 0,
    past = false;
  for (const line of raw.split('\n')) {
    if (past) {
      out.push(line);
      continue;
    }
    if (line === '---') {
      fences++;
      if (fences === 2) past = true;
      continue;
    }
    if (fences === 0) out.push(line);
  }
  return out.join('\n').replace(/\n+$/, ''); // $(...) strips trailing newlines
}

/** Is this path a note we check at all? Operating surfaces are not notes. */
export function isCheckable(file, vaultRoot) {
  if (!file || !file.startsWith(`${vaultRoot}/`)) return false;
  if (!file.endsWith('.md')) return false;
  return !(
    file.endsWith('/REFLECTIONS.md') ||
    file.endsWith('/MEMORY.md') ||
    file.includes('/Logs/') ||
    file.includes('/Graph/')
  );
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
      if (
        !new RegExp(
          `^name:[ \\t]*["']?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?[ \\t]*$`,
          'm',
        ).test(fm)
      ) {
        warn.push(
          `frontmatter name: must equal the filename (${name}) or [[wikilinks]] will not resolve`,
        );
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
    warn.push(
      "no '_Also asked as:' line — add 2-3 paraphrases in an OUTSIDER's words, not the note's own jargon",
    );
  }

  // A reversal announced only in prose is invisible to every check (see memory-audit-checks.mjs).
  if (
    /(⚠ *)?\**(SUPERSEDED|superseded by|no longer true)/i.test(body) &&
    !/superseded +[0-9]{4}-[0-9]{2}-[0-9]{2} +by +\[\[/i.test(body)
  ) {
    warn.push('says superseded in prose — mark the claim: (superseded YYYY-MM-DD by [[note]])');
  }
  return warn;
}

// Suffix-path detection is deliberately NOT here. It needs the repo's full file list to decide, and
// an early version of this block silently never fired — a check that does not run is worse than no
// check, because it reads as coverage. memory-audit-checks.mjs does it vault-wide and is tested.

/**
 * The convention report for one written file, or '' when it is clean or not a checkable note.
 *
 * Returns text rather than printing, so it is testable without stdin or a subprocess.
 */
export function report(file) {
  const vaultRoot = vault();
  if (!isCheckable(file, vaultRoot)) return '';
  let raw;
  try {
    if (!fs.statSync(file).isFile()) return '';
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }

  const warn = warnings(file, raw, vaultRoot);

  // Claim-level checks (CLAIM-1 metric provenance, FRESH-1 staleness, prose-only supersession) run
  // from the tested predicates rather than being re-implemented here. This is the write-time half:
  // an inflated recall figure once reached a public README *between* two audits.
  let claims = [];
  try {
    claims = checkFile(file);
  } catch {
    /* best effort — never break a write */
  }

  if (!warn.length && !claims.length) return '';
  const out = [`note conventions — ${path.basename(file, '.md')}`];
  for (const w of warn) out.push(`  · ${w}`);
  if (claims.length) out.push(claims.join('\n'));
  return out.join('\n');
}
