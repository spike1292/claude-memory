import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBlockScalar, reviewPrompt } from './review-prompt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = path.join(root, '.github', 'workflows', 'claude-review.yml');

test('extracts a block scalar and dedents it', () => {
  const yaml = ['jobs:', '  step:', '    prompt: |', '      line one', '      line two', ''].join(
    '\n',
  );
  assert.equal(extractBlockScalar(yaml, 'prompt'), 'line one\nline two');
});

test('a following key at the same indent ends the block', () => {
  // The real workflow has `claude_args: |` immediately after `prompt: |`.
  const yaml = [
    '    prompt: |',
    '      mine',
    '    claude_args: |',
    '      --allowedTools "x"',
  ].join('\n');
  assert.equal(extractBlockScalar(yaml, 'prompt'), 'mine');
});

test('blank lines inside the block are content, not a terminator', () => {
  const yaml = ['    prompt: |', '      one', '', '      two', '    next: 1'].join('\n');
  assert.equal(extractBlockScalar(yaml, 'prompt'), 'one\n\ntwo');
});

test('relative indentation inside the block survives', () => {
  const yaml = ['    prompt: |', '      top', '        nested', '    next: 1'].join('\n');
  assert.equal(extractBlockScalar(yaml, 'prompt'), 'top\n  nested');
});

test('a missing key returns null rather than throwing', () => {
  assert.equal(extractBlockScalar('jobs:\n  step:\n    run: echo hi\n', 'prompt'), null);
  assert.equal(
    extractBlockScalar('    prompt: |\n', 'prompt'),
    null,
    'an empty block is also null',
  );
});

// This is the check that matters, and the reason there is no separate CI step: restructure the
// workflow and the local reviewer stops working, silently, because its whole job is to read a file
// nobody edits often. `node --test` runs in CI, so this fails the PR that breaks it.
test('the real claude-review.yml still yields its prompt', () => {
  const prompt = reviewPrompt(fs.readFileSync(workflow, 'utf8'));
  assert.ok(prompt, 'no `prompt: |` block found in .github/workflows/claude-review.yml');
  assert.ok(prompt.length > 1000, `prompt is suspiciously short (${prompt.length} chars)`);
  // Spot-check both ends, so a truncated extraction fails rather than passing on the first line.
  assert.match(prompt, /Read CLAUDE\.md first/, 'missing the opening instruction');
  assert.match(prompt, /PRIVACY/, 'missing the highest-weighted finding class');
  assert.match(prompt, /Post GitHub comments only/, 'missing the closing instruction');
  assert.doesNotMatch(prompt, /claude_args/, 'extraction ran past the end of the block');
});
