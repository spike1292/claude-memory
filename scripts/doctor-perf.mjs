#!/usr/bin/env node
// CLI entry for the /memory:doctor --perf report. Owns argv and stdout; the logic is in
// scripts/lib/doctor-perf.mjs.
import { memoryHome, projectKey } from '../hooks/lib/paths.mjs';
import { activeModel } from './lib/model-default.mjs';
import { MODELS } from './lib/memory-semantic.mjs';
import { report } from './lib/doctor-perf.mjs';

const cwd = process.argv[2] || process.cwd();
let slug;
try {
  slug = projectKey(cwd);
} catch {
  slug = '(unresolved)';
}

process.stdout.write(
  await report({
    state: memoryHome(),
    activeModel: activeModel(),
    activeSlug: slug,
    modelKeys: Object.keys(MODELS),
  }),
);
