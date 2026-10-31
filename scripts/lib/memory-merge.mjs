// Merging duplicate vault notes into one survivor: /memory:prune step 2.
//
// Logic half; the CLI entry is scripts/memory-merge.mjs. Redundant notes MOVE to
// `<vault>/.trash/pruned-<date>/`, never unlink: auto mode refuses an unlink of a vault note.
//
// Tests: node --test scripts/lib/memory-merge.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { FENCE, INLINE_CODE, linkTargets } from '../../hooks/lib/memory-link-lint.mjs';
import { frontmatter } from './memory-mark.mjs';

const SKIP = new Set(['.git', '.trash']);
const ALIAS = /^_Also asked as: (.*?)\.?_[ \t]*$/m;

/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How Obsidian resolves a link target: `[[ Folder/Name.md ]]` is `name`. @param {string} t */
export const linkKey = (t) => path.basename(t.trim()).replace(/\.md$/i, '').toLowerCase();

/** `[[target`, in any form Obsidian resolves to `name`. @param {string} name */
const linkHead = (name) => `\\[\\[\\s*(?:[^\\]|#\\n]*/)?${esc(name)}(?:\\.md)?\\s*(?=[\\]|#])`;

/**
 * Every note under the vault, by name. `.git` and `.trash` are not the vault.
 *
 * @param {string} vault
 * @returns {Map<string, string[]>}
 */
export function noteIndex(vault) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  /** @type {string[]} */
  const stack = [vault];
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(full);
      } else if (e.name.endsWith('.md')) {
        const name = e.name.slice(0, -3);
        out.set(name, [...(out.get(name) ?? []), full]);
      }
    }
  }
  return out;
}

/**
 * @param {string} body
 * @returns {string[]}
 */
export function aliasesOf(body) {
  const m = body.match(ALIAS);
  return m
    ? m[1]
        .split(/,\s*/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/**
 * @param {string[][]} lists
 * @returns {string[]}
 */
function unionAliases(lists) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const a of lists.flat()) if (!seen.has(a.toLowerCase())) seen.set(a.toLowerCase(), a);
  return [...seen.values()];
}

/**
 * @param {string} raw
 * @returns {[string, string]}
 */
function split(raw) {
  const fm = /** @type {RegExpMatchArray} */ (raw.match(/^---\n[\s\S]*?\n---\n/))[0];
  return [fm, raw.slice(fm.length)];
}

/**
 * Every link to a `rename` key (lowercased) pointed at its value. Code is left alone, as Obsidian
 * leaves it: a `[[x]]` inside backticks is not a link.
 *
 * @param {string} text
 * @param {Map<string, string>} rename
 * @returns {string}
 */
export function rewriteLinks(text, rename) {
  /** @type {[number, number][]} */
  const code = [...text.matchAll(FENCE), ...text.matchAll(INLINE_CODE)].map((m) => [
    /** @type {number} */ (m.index),
    /** @type {number} */ (m.index) + m[0].length,
  ]);
  const re = new RegExp([...rename.keys()].map(linkHead).join('|'), 'gi');
  return text.replace(re, (m, /** @type {number} */ at) =>
    code.some(([a, b]) => at >= a && at < b) ? m : `[[${rename.get(linkKey(m.slice(2)))}`,
  );
}

/**
 * The survivor's links to itself, which a rewrite creates: the distiller's back-link and
 * supersede marker, then any other `[[self]]` reduced to its text.
 *
 * @param {string} text
 * @param {string} self
 * @returns {string}
 */
export function dropSelfLinks(text, self) {
  const s = esc(self);
  return text
    .replace(new RegExp(`^[ \\t]*Supersedes a claim in \\[\\[${s}\\]\\]\\.[ \\t]*\\n`, 'gm'), '')
    .replace(new RegExp(` ?Supersedes a claim in \\[\\[${s}\\]\\]\\.`, 'g'), '')
    .replace(new RegExp(` by \\[\\[${s}\\]\\]`, 'g'), '')
    .replace(
      new RegExp(`${linkHead(self)}(?:#[^\\]|]*)?(?:\\|([^\\]]*))?\\]\\]`, 'gi'),
      (_, label) => label ?? self,
    )
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * The survivor's new text: its body, each redundant body under a `**Merged**` line, then one
 * alias line holding the union.
 *
 * @param {string} survivorRaw
 * @param {{ name: string, raw: string }[]} redundant
 * @returns {string}
 */
export function mergeText(survivorRaw, redundant) {
  const [fm, body] = split(survivorRaw);
  const aliases = [aliasesOf(body)];
  let out = body.replace(ALIAS, '').trimEnd() + '\n';
  for (const r of redundant) {
    const [rfm, rbody] = split(r.raw);
    aliases.push(aliasesOf(rbody));
    const title = rfm.match(/^title: "?(.*?)"?$/m)?.[1] || rbody.match(/^## (.*)$/m)?.[1] || r.name;
    const date = rfm.match(/^date: (\S+)/m)?.[1] || r.name.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    const text = rbody
      .replace(/^## .*\n/m, '')
      .replace(ALIAS, '')
      .trim();
    out += `\n**Merged ${date ? `${date} ` : ''}(${title}):**\n\n${text}\n`;
  }
  const union = unionAliases(aliases);
  if (union.length) out += `\n_Also asked as: ${union.join(', ')}._\n`;
  return fm + out;
}

/**
 * @typedef {{ name: string, file: string }} Note
 * @typedef {{ survivor: Note, redundant: Note[] }} Group
 * @typedef {{ groups: Group[], edits: string[], moves: { from: string, to: string }[] }} Plan
 */

/**
 * Resolve and check the WHOLE plan before anything is written. Throws one error listing every
 * problem: a missing or ambiguous name, a name used twice, a cross-folder group, a note with no
 * frontmatter, or a trash path already taken.
 *
 * @param {string} vault
 * @param {readonly (readonly string[])[]} groups `[survivor, ...redundant]` per group
 * @param {string} today YYYY-MM-DD
 * @returns {Plan}
 */
export function planMerge(vault, groups, today) {
  const index = noteIndex(vault);
  /** @type {string[]} */
  const errors = [];
  /** @type {Set<string>} */
  const used = new Set();
  /** @param {string} arg @returns {Note | null} */
  const resolve = (arg) => {
    const name = path.basename(arg).replace(/\.md$/, '');
    if (used.has(name)) errors.push(`named twice in the plan: ${name}`);
    used.add(name);
    const hits = index.get(name) ?? [];
    if (hits.length !== 1) {
      errors.push(`${hits.length ? 'ambiguous' : 'not found in the vault'}: ${name}`);
      return null;
    }
    if (frontmatter(fs.readFileSync(hits[0], 'utf8')) === null)
      errors.push(`no frontmatter, refusing to edit: ${hits[0]}`);
    return { name, file: hits[0] };
  };

  /** @type {Group[]} */
  const out = [];
  const moves = [];
  for (const g of groups) {
    if (g.length < 2) {
      errors.push(`a group needs a survivor and at least one redundant note: ${g.join(' ')}`);
      continue;
    }
    const survivor = resolve(g[0]);
    const redundant = g.slice(1).map(resolve);
    if (!survivor || redundant.some((r) => !r)) continue;
    const notes = /** @type {Note[]} */ (redundant);
    for (const r of notes) {
      if (path.dirname(r.file) !== path.dirname(survivor.file)) {
        errors.push(`cross-folder, refusing: ${r.name} is not beside ${survivor.name}`);
        continue;
      }
      const rel = path.relative(vault, path.dirname(r.file));
      const to = path.join(vault, '.trash', `pruned-${today}`, rel, `${r.name}.md`);
      if (fs.existsSync(to)) errors.push(`already in the trash, move it out first: ${to}`);
      moves.push({ from: r.file, to });
    }
    out.push({ survivor, redundant: notes });
  }
  if (errors.length) throw new Error(errors.join('\n'));

  const names = new Set(out.flatMap((g) => g.redundant.map((r) => r.name.toLowerCase())));
  const gone = new Set(moves.map((m) => m.from));
  const edits = new Set(out.map((g) => g.survivor.file));
  for (const files of index.values())
    for (const f of files) if (!gone.has(f) && linksTo(f, names)) edits.add(f);
  return { groups: out, edits: [...edits], moves };
}

/** @param {string} file @param {Set<string>} names */
const linksTo = (file, names) =>
  [...linkTargets(fs.readFileSync(file, 'utf8'))].some((t) => names.has(linkKey(t)));

/**
 * Write the plan: fold each group into its survivor, point every inbound link at the survivor,
 * move the redundant notes to the trash. Returns the files still linking to a moved note.
 *
 * @param {string} vault
 * @param {Plan} plan
 * @returns {string[]}
 */
export function applyMerge(vault, plan) {
  /** @type {Map<string, string>} */
  const rename = new Map();
  for (const g of plan.groups) {
    const redundant = g.redundant.map((r) => ({ ...r, raw: fs.readFileSync(r.file, 'utf8') }));
    fs.writeFileSync(
      g.survivor.file,
      mergeText(fs.readFileSync(g.survivor.file, 'utf8'), redundant),
    );
    for (const r of g.redundant) rename.set(r.name.toLowerCase(), g.survivor.name);
  }
  const survivors = new Map(plan.groups.map((g) => [g.survivor.file, g.survivor.name]));
  for (const f of plan.edits) {
    let text = rewriteLinks(fs.readFileSync(f, 'utf8'), rename);
    const self = survivors.get(f);
    if (self) text = dropSelfLinks(text, self);
    fs.writeFileSync(f, text);
  }
  for (const m of plan.moves) {
    fs.mkdirSync(path.dirname(m.to), { recursive: true });
    fs.renameSync(m.from, m.to);
  }
  const gone = new Set(rename.keys());
  return [...noteIndex(vault).values()].flat().filter((f) => linksTo(f, gone));
}
