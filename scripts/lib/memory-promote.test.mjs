import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GEN_END,
  proposalSlug,
  renderProposal,
  mergeProposal,
  proposeStagingNotes,
  stagingDir,
} from './memory-promote.mjs';

const gap = () => ({
  members: [
    { note: '2026-08-19-re-grep-after-any-rename-or-removal', layer: 'Patterns' },
    { note: '2026-08-19-re-grep-the-entire-repo-after-any-rename-or-removal', layer: 'Decisions' },
  ],
  best: { note: 'context-mode', s: 0.593 },
  typical: 0.798,
});

test('proposalSlug is deterministic and alphabetical', () => {
  assert.equal(
    proposalSlug(gap().members),
    'candidate-2026-08-19-re-grep-after-any-rename-or-removal',
  );
  // order of the input list must not matter
  assert.equal(proposalSlug([...gap().members].reverse()), proposalSlug(gap().members));
});

test('renderProposal carries the evidence and both members, with the sentinel pair', () => {
  const raw = renderProposal(gap(), 'candidate-x');
  assert.match(raw, /type: promotion-candidate/);
  assert.match(raw, /best_permanent_match: context-mode/);
  assert.match(raw, /best_permanent_score: 0\.593/);
  assert.match(raw, /typical_member_score: 0\.798/);
  assert.match(raw, /\[\[2026-08-19-re-grep-after-any-rename-or-removal\]\] \(Patterns\)/);
  assert.match(
    raw,
    /\[\[2026-08-19-re-grep-the-entire-repo-after-any-rename-or-removal\]\] \(Decisions\)/,
  );
  assert.ok(raw.includes('@generated:start'));
  assert.ok(raw.includes(GEN_END));
});

test('renderProposal with no permanent/ match at all writes best_permanent_match: null', () => {
  const g = { ...gap(), best: { note: null, s: 0 } };
  const raw = renderProposal(g, 'candidate-x');
  assert.match(raw, /best_permanent_match: null/);
});

test('renderProposal reports the oldest member as evidence, omitted when no member carries an mtime', () => {
  assert.doesNotMatch(renderProposal(gap(), 'candidate-x'), /oldest_member_changed/);

  const dated = {
    ...gap(),
    members: [
      { ...gap().members[0], mtime: Date.parse('2026-01-15') },
      { ...gap().members[1], mtime: Date.parse('2026-03-01') },
    ],
  };
  const raw = renderProposal(dated, 'candidate-x');
  assert.match(raw, /oldest_member_changed: 2026-01-15/);
});

test('mergeProposal preserves hand-written text after @generated:end', () => {
  const existing = `${renderProposal(gap(), 'candidate-x')}\nA human wrote this observation.\n`;
  const fresh = renderProposal({ ...gap(), typical: 0.81 }, 'candidate-x');
  const merged = mergeProposal(existing, fresh);
  assert.match(merged, /typical_member_score: 0\.81/); // evidence refreshed
  assert.ok(merged.includes('A human wrote this observation.')); // hand edit survives
});

test('mergeProposal falls back to the fresh render when no sentinel is present', () => {
  const existing = 'not a proposal file at all';
  const fresh = renderProposal(gap(), 'candidate-x');
  assert.equal(mergeProposal(existing, fresh), fresh);
});

test('mergeProposal preserves a drafted note past @generated:end after /memory:synthesize edits it', () => {
  // A drafted note keeps the marker in its body (renderProposal's own instruction says so) but its
  // frontmatter is now `type: permanent` — mergeProposal must not clobber the draft on a re-propose.
  const drafted = `---\ntype: permanent\nconfidence: high\n---\n\n${GEN_END}\n\n## Real title\n\nCited content — [[some-note]].\n`;
  const fresh = renderProposal(gap(), 'candidate-x');
  const merged = mergeProposal(drafted, fresh);
  assert.ok(merged.includes('## Real title'));
  assert.ok(merged.includes('Cited content'));
  assert.match(merged, /best_permanent_match: context-mode/); // fresh evidence still lands
});

test('proposeStagingNotes writes one file per gap under Staging/<slug>, never touching permanent/', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
  fs.mkdirSync(path.join(vault, 'permanent'), { recursive: true });
  const before = fs.readdirSync(path.join(vault, 'permanent'));

  const results = proposeStagingNotes(vault, 'my-slug', [gap()]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'written');
  assert.equal(results[0].members, 2);
  const dir = stagingDir(vault, 'my-slug');
  assert.ok(fs.existsSync(path.join(dir, results[0].file)));
  assert.deepEqual(fs.readdirSync(path.join(vault, 'permanent')), before);
});

test('proposeStagingNotes re-run on the same gap updates evidence and preserves hand edits', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
  const [first] = proposeStagingNotes(vault, 's', [gap()]);
  const full = path.join(stagingDir(vault, 's'), first.file);
  fs.appendFileSync(full, '\nHuman note added by hand.\n');

  const [second] = proposeStagingNotes(vault, 's', [{ ...gap(), typical: 0.85 }]);
  assert.equal(second.status, 'updated');
  const raw = fs.readFileSync(full, 'utf8');
  assert.match(raw, /typical_member_score: 0\.85/);
  assert.ok(raw.includes('Human note added by hand.'));
});

test('proposeStagingNotes is a no-op write when nothing changed', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
  proposeStagingNotes(vault, 's', [gap()]);
  const [second] = proposeStagingNotes(vault, 's', [gap()]);
  assert.equal(second.status, 'unchanged');
});
