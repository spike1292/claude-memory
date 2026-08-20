#!/usr/bin/env node
// CLI entry for the /memory:doctor --perf report. Owns argv and stdout; the logic is in
// scripts/lib/doctor-perf.mjs.
import { memoryHome, projectKey } from '../hooks/lib/paths.mjs';
import { activeModel } from './lib/model-default.mjs';
import { MODELS } from './lib/models.mjs';
import { report } from './lib/doctor-perf.mjs';
import { DatabaseSync } from 'node:sqlite';

// The entry owns the database handle; lib/ takes the numbers as values. Read-only, and null on
// anything unreadable so the report can say so rather than drop the row.
/** @type {import('./lib/doctor-perf.mjs').CountsReader} */
const counts = (file) => {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const r = {
      chunks: /** @type {{ c: number }} */ (db.prepare('select count(*) c from chunks').get()).c,
      notes: /** @type {{ c: number }} */ (
        db.prepare('select count(distinct file) c from chunks').get()
      ).c,
    };
    db.close();
    return r;
  } catch {
    return null;
  }
};

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
    counts,
  }),
);
