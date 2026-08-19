#!/usr/bin/env node
// Print the review instructions from .github/workflows/claude-review.yml.
//
// Run the CI reviewer's own prompt locally, before pushing, so its findings arrive as an edit
// rather than as a comment on a PR you then have to repush. See scripts/lib/review-prompt.mjs for
// why the prompt stays inline in the workflow rather than living in a file of its own.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewPrompt } from './lib/review-prompt.mjs';

// import.meta.url, never an absolute install path — this file is read out of a version-pinned
// plugin cache whose location is not knowable in advance.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = path.join(root, '.github', 'workflows', 'claude-review.yml');

let yaml;
try {
  yaml = fs.readFileSync(workflow, 'utf8');
} catch {
  console.error(`review-prompt: cannot read ${path.relative(root, workflow)}`);
  process.exit(1);
}

const prompt = reviewPrompt(yaml);
if (!prompt) {
  console.error(
    'review-prompt: no `prompt: |` block in claude-review.yml. The workflow was restructured; ' +
      'update scripts/lib/review-prompt.mjs to match.',
  );
  process.exit(1);
}

console.log(prompt);
