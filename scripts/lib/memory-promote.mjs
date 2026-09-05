// Staging proposals for the promotion step (#96): `--propose` in memory-semantic.mjs turns a
// consolidationGaps() result into a file under `<vault>/Staging/<slug>/`, sibling to `permanent/`,
// never inside it. Drafting the actual synthesis stays a human/LLM job for /memory:synthesize —
// this only emits the skeleton and the evidence that made the cluster a candidate.
//
// Logic half; the CLI entry is scripts/memory-semantic.mjs's --propose flag.
// Tests: node --test scripts/lib/memory-promote.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { checkDraftStatus } from './memory-adopt.mjs';

// Sentinel pair, same convention GRAPH_REPORT.md uses: everything after @generated:end is
// hand-maintained and a re-propose must carry it forward verbatim.
export const GEN_START =
  '<!-- @generated:start — overwritten by --propose on rerun; do NOT hand-edit inside this block -->';
export const GEN_END = '<!-- @generated:end -->';

/** @param {string} vault @param {string} slug @returns {string} */
export function stagingDir(vault, slug) {
  return path.join(vault, 'Staging', slug);
}

/**
 * Deterministic candidate id: the alphabetically-first member's stem. Not a stable identity across
 * reruns if cluster membership shifts — /memory:synthesize is instructed to `mv` the file to its
 * real topic slug once drafted, so this name is temporary by design.
 *
 * @param {readonly { note: string }[]} members
 * @returns {string}
 */
export function proposalSlug(members) {
  const first = [...members].map((m) => m.note).sort()[0];
  return `candidate-${first}`;
}

/**
 * @param {{ members: readonly { note: string, layer: string, mtime?: number }[], best: { note: string | null, s: number }, typical: number }} gap
 * @param {string} slug
 * @returns {string}
 */
export function renderProposal(gap, slug) {
  const created = new Date().toISOString().slice(0, 10);
  const memberLines = gap.members
    .slice()
    .sort((a, b) => a.note.localeCompare(b.note))
    .map((m) => `  - "[[${m.note}]] (${m.layer})"`)
    .join('\n');
  // Age is the third quantity the candidate rule can read off the cluster scan, alongside size and
  // the permanent/ gap — the oldest member's last content change, so a topic that has sat unstaged
  // for a while is visible without inventing an age THRESHOLD nobody has calibrated. Omitted, not
  // zero, when the caller has no mtime to give (e.g. a unit test fixture).
  const oldestMtime = gap.members.reduce(
    (min, m) => (m.mtime != null && (min == null || m.mtime < min) ? m.mtime : min),
    /** @type {number | null} */ (null),
  );
  const front = [
    '---',
    'type: promotion-candidate',
    'status: proposed',
    `created: ${created}`,
    `cluster_size: ${gap.members.length}`,
    `best_permanent_match: ${gap.best.note ?? 'null'}`,
    `best_permanent_score: ${gap.best.s.toFixed(3)}`,
    `typical_member_score: ${gap.typical.toFixed(3)}`,
    ...(oldestMtime == null
      ? []
      : [`oldest_member_changed: ${new Date(oldestMtime).toISOString().slice(0, 10)}`]),
    'members:',
    memberLines,
    '---',
  ].join('\n');
  const body = [
    GEN_START,
    '',
    `## ${slug} — untitled promotion candidate`,
    '',
    '_Draft this with `/memory:synthesize` — cite every claim, mark unsourced synthesis explicitly.',
    'Replace this frontmatter with the permanent shape (`type: permanent`, `confidence`, dates,',
    '`_Also asked as:_`) when drafting; /memory:adopt refuses a note still shaped like this one._',
    '',
    GEN_END,
    '',
    '## Notes (hand-maintained — survives regeneration)',
    '',
  ].join('\n');
  return `${front}\n\n${body}`;
}

/**
 * Carry forward everything after @generated:end from an UNDRAFTED skeleton (a human can append to
 * its "## Notes" section before drafting) when a later --propose regenerates the evidence block.
 * Never called on a drafted note — see proposeStagingNotes, which skips those entirely, because
 * /memory:synthesize's draft lives BEFORE the marker (replacing frontmatter through it), the exact
 * region this function always regenerates. No sentinel found means nothing to preserve.
 *
 * @param {string} existingRaw
 * @param {string} freshRaw
 * @returns {string}
 */
export function mergeProposal(existingRaw, freshRaw) {
  const existingIdx = existingRaw.indexOf(GEN_END);
  const freshIdx = freshRaw.indexOf(GEN_END);
  if (existingIdx === -1 || freshIdx === -1) return freshRaw;
  const trailing = existingRaw.slice(existingIdx + GEN_END.length);
  return freshRaw.slice(0, freshIdx + GEN_END.length) + trailing;
}

/** @typedef {{ file: string, status: 'written'|'updated'|'unchanged'|'drafted', members: number, bestScore: string }} ProposeResult */

/**
 * Write (or update) a staging proposal per gap. Never touches `permanent/`, and never touches a
 * proposal /memory:synthesize has already drafted (or anything not shaped like this module's own
 * skeleton) — regenerating it would overwrite the draft, since the draft occupies the same
 * frontmatter-through-marker region a fresh render always replaces.
 *
 * @param {string} vault
 * @param {string} slug
 * @param {readonly { members: readonly { note: string, layer: string, mtime?: number }[], best: { note: string | null, s: number }, typical: number }[]} gaps
 * @returns {ProposeResult[]}
 */
export function proposeStagingNotes(vault, slug, gaps) {
  const dir = stagingDir(vault, slug);
  fs.mkdirSync(dir, { recursive: true });
  /** @type {ProposeResult[]} */
  const out = [];
  for (const gap of gaps) {
    const topic = proposalSlug(gap.members);
    const file = `${topic}.md`;
    const full = path.join(dir, file);
    const fresh = renderProposal(gap, topic);
    let final = fresh;
    /** @type {ProposeResult['status']} */
    let status = 'written';
    if (fs.existsSync(full)) {
      const existing = fs.readFileSync(full, 'utf8');
      if (checkDraftStatus(existing) !== 'undrafted') {
        out.push({
          file,
          status: 'drafted',
          members: gap.members.length,
          bestScore: gap.best.s.toFixed(3),
        });
        continue;
      }
      final = mergeProposal(existing, fresh);
      status = final === existing ? 'unchanged' : 'updated';
    }
    if (status !== 'unchanged') fs.writeFileSync(full, final);
    out.push({ file, status, members: gap.members.length, bestScore: gap.best.s.toFixed(3) });
  }
  return out;
}
