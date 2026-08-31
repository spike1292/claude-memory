// Marking a note as manually adjudicated: `reconcile: manual` in its frontmatter, meaning the
// distiller must never auto-fold a later restatement into it.
//
// Logic half; the CLI entry is scripts/memory-mark.mjs. Not a flag on memory-semantic.mjs on
// purpose — docs/architecture.md, "Declined, and kept declined".
//
// Tests: node --test scripts/lib/memory-mark.test.mjs
import fs from 'node:fs';
import path from 'node:path';

const FIELD = 'reconcile: manual';

/** Matches the field as its OWN frontmatter line — never the same words in prose. */
const MARKED = /^reconcile:[ \t]*manual[ \t]*$/m;

/**
 * The frontmatter block of a note, or null when it has none.
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function frontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? m[1] : null;
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
export function isMarked(raw) {
  const fm = frontmatter(raw);
  return !!fm && MARKED.test(fm);
}

/**
 * The note's text with the mark added or removed, or null when it already reads that way.
 *
 * Returning null rather than identical text is what lets the caller report "already marked" instead
 * of rewriting a file and claiming a change it did not make — the mtime alone would re-embed the
 * note on the next incremental index.
 *
 * @param {string} raw
 * @param {boolean} [want]
 * @returns {string | null}
 */
export function applyMark(raw, want = true) {
  const fm = frontmatter(raw);
  if (fm === null) return null;
  if (isMarked(raw) === want) return null;
  return want
    ? raw.replace(/\n---\n/, `\n${FIELD}\n---\n`)
    : raw.replace(/^reconcile:[ \t]*manual[ \t]*\n/m, '');
}

/**
 * Find a note by NAME anywhere under the vault.
 *
 * Names are addressed rather than paths because names are unique vault-wide — the semantic index
 * keys by filename stem — and because `--dupes`, the report a caller is reading these names out of,
 * prints names and not paths.
 *
 * @param {string} vault
 * @param {string} name
 * @returns {string | null}
 */
export function resolveNote(vault, name) {
  if (name.endsWith('.md') && fs.existsSync(name)) return name;
  const wanted = `${name.replace(/\.md$/, '')}.md`;
  /** @type {string[]} */
  const stack = [vault];
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === wanted) return full;
    }
  }
  return null;
}

/** @typedef {{ name: string, file?: string, status: 'marked'|'unmarked'|'unchanged'|'missing'|'no-frontmatter' }} MarkResult */

/**
 * @param {string} vault
 * @param {readonly string[]} names
 * @param {boolean} [want]
 * @returns {MarkResult[]}
 */
export function markNotes(vault, names, want = true) {
  /** @type {MarkResult[]} */
  const out = [];
  for (const name of names) {
    const file = resolveNote(vault, name);
    if (!file) {
      out.push({ name, status: 'missing' });
      continue;
    }
    const raw = fs.readFileSync(file, 'utf8');
    const next = applyMark(raw, want);
    if (next === null) {
      // Refusing a note with no frontmatter rather than inventing a block: a note shaped unlike
      // this vault's notes is not one to guess at, and a second writer corrupting the first's
      // frontmatter is a whole class of bug this repo has already paid for.
      out.push({ name, file, status: frontmatter(raw) === null ? 'no-frontmatter' : 'unchanged' });
      continue;
    }
    fs.writeFileSync(file, next);
    out.push({ name, file, status: want ? 'marked' : 'unmarked' });
  }
  return out;
}
