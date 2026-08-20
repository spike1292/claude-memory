#!/usr/bin/env node
// CLI entry for the /memory:doctor --perf and --stats reports. Owns argv, the database handles and
// stdout; the logic is in scripts/lib/doctor-perf.mjs and scripts/lib/recall-stats.mjs.
//
// `--stats` is the read side of the recall log: what recall decided, how often it abstained and
// which notes it never surfaced. It is a separate flag rather than more of `--perf` because it
// answers a different question — "is this helping" rather than "why is this slow" — and because
// the hook and cost sections coming after it (#46, #47) belong beside it, not beside the RSS
// table. Both are equally read-only.
import { memoryHome, projectKey } from '../hooks/lib/paths.mjs';
import { activeModel } from './lib/model-default.mjs';
import { MODELS } from './lib/models.mjs';
import { report } from './lib/doctor-perf.mjs';
import { report as recallReport } from './lib/recall-stats.mjs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

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

// The note set of THIS project's index, for the never-injected list. A missing or unreadable db is
// null — that one line then reports "not measured" and the rest of the report stands.
/** @param {string} file @returns {string[] | null} */
const indexNotes = (file) => {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = /** @type {{ note: string }[]} */ (
      /** @type {unknown} */ (db.prepare('select distinct note from chunks').all())
    );
    db.close();
    return rows.map((r) => r.note);
  } catch {
    return null;
  }
};

// argv is positional-then-flags: `doctor-perf.mjs [cwd] [--stats[=days]]`. Anything else is
// ignored rather than an error — this is invoked from a report that must always exit 0.
const args = process.argv.slice(2);
const statsArg = args.find((a) => a === '--stats' || a.startsWith('--stats='));
const cwd = args.find((a) => !a.startsWith('--')) || process.cwd();
const days = Number(statsArg?.split('=')[1]);

// `null` rather than a placeholder when the key does not resolve: `--stats` FILTERS on this, and a
// slug no line can match would empty the whole report behind a message that reads like a bug. The
// machine-wide view is the honest answer there, and render() says which one it is showing.
/** @type {string | null} */
let slug = null;
try {
  slug = projectKey(cwd);
} catch {
  /* reported as (unresolved) in the perf report, and as machine-wide in --stats */
}

const state = memoryHome();
const model = activeModel();

process.stdout.write(
  statsArg
    ? recallReport({
        logDir: path.join(state, 'logs'),
        days: Number.isFinite(days) && days > 0 ? days : undefined,
        indexNotes: slug
          ? indexNotes(path.join(state, 'db', `semantic-${slug}-${model}.db`))
          : null,
        // The logs are machine-wide and the index is not, so the report is scoped to THIS project
        // — otherwise one project's never-injected notes would be measured against every project's
        // retrievals. doctor.sh runs this from $PWD for exactly that reason.
        slug,
      })
    : await report({
        state,
        activeModel: model,
        activeSlug: slug ?? '(unresolved)',
        modelKeys: Object.keys(MODELS),
        counts,
      }),
);
