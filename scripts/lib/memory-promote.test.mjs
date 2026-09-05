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

test('mergeProposal is never the right tool for a drafted note — it always overwrites the frontmatter-through-marker region', () => {
  // /memory:synthesize's draft lives BEFORE the marker (it replaces "frontmatter through the
  // marker" per commands/synthesize.md), which is exactly the region mergeProposal always
  // regenerates. Calling it on a drafted note would destroy the draft — proposeStagingNotes must
  // never do this (see the test below); this pins the reason why.
  const drafted = `---\ntype: permanent\nconfidence: high\n---\n\n## Real title\n\nCited content — [[some-note]].\n\n${GEN_END}\n`;
  const fresh = renderProposal(gap(), 'candidate-x');
  const merged = mergeProposal(drafted, fresh);
  assert.ok(
    !merged.includes('## Real title'),
    'the draft sat before the marker and was overwritten',
  );
  assert.match(merged, /type: promotion-candidate/, 'the skeleton frontmatter came back');
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

test('proposeStagingNotes never regenerates a proposal /memory:synthesize has already drafted', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
  const [first] = proposeStagingNotes(vault, 's', [gap()]);
  const full = path.join(stagingDir(vault, 's'), first.file);
  const drafted = `---\ntype: permanent\nconfidence: high\n---\n\n## Real title\n\nCited content — [[some-note]].\n\n${GEN_END}\n`;
  fs.writeFileSync(full, drafted);

  // A later run over a bigger/changed cluster (still resolving to the same candidate id) must not
  // touch the drafted file at all — this is the gap a re-propose used to destroy silently.
  const [second] = proposeStagingNotes(vault, 's', [{ ...gap(), typical: 0.99 }]);
  assert.equal(second.status, 'drafted');
  assert.equal(fs.readFileSync(full, 'utf8'), drafted);
});

test('proposeStagingNotes finds a drafted proposal after it has been renamed away from candidate-*.md', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
  const dir = stagingDir(vault, 's');
  const [first] = proposeStagingNotes(vault, 's', [gap()]);
  const oldFull = path.join(dir, first.file);
  const renamed = path.join(dir, 'the-real-topic-slug.md');
  // commands/synthesize.md instructs keeping `members:` byte-for-byte across drafting — that field,
  // not a body citation, is how a rename is recognised.
  const drafted = `---\ntype: permanent\nconfidence: high\nmembers:\n  - "[[2026-08-19-re-grep-after-any-rename-or-removal]] (Patterns)"\n  - "[[2026-08-19-re-grep-the-entire-repo-after-any-rename-or-removal]] (Decisions)"\n---\n\n## Real title\n\nCited content.\n\n${GEN_END}\n`;
  fs.renameSync(oldFull, renamed); // /memory:synthesize's `mv candidate-*.md <topic-slug>.md`
  fs.writeFileSync(renamed, drafted);

  const [second] = proposeStagingNotes(vault, 's', [{ ...gap(), typical: 0.99 }]);
  assert.equal(second.status, 'drafted');
  assert.equal(second.file, 'the-real-topic-slug.md', 'found by member set, not by the old name');
  assert.equal(fs.readFileSync(renamed, 'utf8'), drafted, 'left untouched');
  assert.deepEqual(
    fs.readdirSync(dir),
    ['the-real-topic-slug.md'],
    'no duplicate candidate-*.md skeleton was minted beside it',
  );
});

test('proposeStagingNotes leaves an unrecognized file alone rather than guessing', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
  const [first] = proposeStagingNotes(vault, 's', [gap()]);
  const full = path.join(stagingDir(vault, 's'), first.file);
  fs.writeFileSync(full, 'no frontmatter at all\n');

  const [second] = proposeStagingNotes(vault, 's', [gap()]);
  assert.equal(second.status, 'drafted');
  assert.equal(fs.readFileSync(full, 'utf8'), 'no frontmatter at all\n');
});
