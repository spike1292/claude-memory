// SessionStart, inside memory-link-lint: name the same-folder duplicate pairs in this project's
// index, once per project per day. Reports only — merging stays a human call (#100).
//
// Tests: node --test hooks/lib/dupe-report.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectKey, stateDir } from './paths.mjs';
import { claimDupeScan, dupeScanDone } from './hook-io.mjs';
import { activeModel } from '../../scripts/lib/model-default.mjs';
import { MODELS } from '../../scripts/lib/models.mjs';
import { CARD } from '../../scripts/lib/lexical.mjs';
import { isManual } from '../../scripts/lib/memory-mark.mjs';

const TOP = 5;

/**
 * The report, or '' when there is nothing to say, the day's scan is already claimed, or anything
 * fails. Needs only the stored vectors — never a model, never an index build.
 *
 * @param {string} cwd
 * @param {Date} [now]
 * @returns {Promise<string>}
 */
export async function dupeReport(cwd, now = new Date()) {
  try {
    const key = activeModel();
    const profile = MODELS[key];
    if (!profile) return '';
    const slug = projectKey(cwd);
    const dbPath = path.join(stateDir('db'), `semantic-${slug}-${key}.db`);
    if (!fs.existsSync(dbPath) || dupeScanDone(slug, now)) return '';
    const db = new DatabaseSync(dbPath, { readOnly: true });
    /** @type {{ note: string, layer: string, file: string, vec: Uint8Array }[]} */
    let rows;
    try {
      const stored = /** @type {{ value?: string } | undefined} */ (
        db.prepare("SELECT value FROM meta WHERE key = 'model'").get()
      )?.value;
      if (stored !== profile.id) return '';
      rows = /** @type {any} */ (
        db.prepare('SELECT note, layer, file, vec FROM chunks WHERE heading = ?').all(CARD)
      );
    } finally {
      db.close();
    }
    // A mixed-width index is silent nonsense; a partial list would hide it.
    if (rows.some((r) => r.vec?.byteLength !== profile.dim * 4)) return '';
    const cards = rows.map((r) => ({
      note: r.note,
      layer: r.layer,
      vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, profile.dim),
    }));
    const fileOf = new Map(rows.map((r) => [r.note, r.file]));
    // Imported only once the model key is known-good: this module exits the process on an unknown one.
    const { reportPairs } = await import('../../scripts/lib/memory-semantic.mjs');
    const pairs = reportPairs(cards, profile.dupeMin, (n) => isManual(fileOf.get(n) ?? ''));
    // Claimed only once the scan has succeeded, so a failed read does not spend the day. Two
    // sessions racing past dupeScanDone() both scan; `wx` lets one report.
    if (!claimDupeScan(slug, now) || !pairs.length) return '';
    const s = pairs.length === 1 ? '' : 's';
    return [
      `${pairs.length} same-folder duplicate pair${s} at or above ${profile.dupeMin} (cosine). ` +
        'Judge them in /memory:prune: merge when it adds coverage, mark a keep with reconcile: manual.',
      ...pairs.slice(0, TOP).map((p) => `  - ${p.s.toFixed(3)} [${p.layer}] ${p.a} / ${p.b}`),
      ...(pairs.length > TOP ? [`  … and ${pairs.length - TOP} more`] : []),
    ].join('\n');
  } catch {
    return '';
  }
}
