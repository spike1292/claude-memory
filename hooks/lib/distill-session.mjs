#!/usr/bin/env node
// Distill a Claude Code session transcript into Obsidian Insight notes.
//
// Logic half; the CLI entry is hooks/distill-session.mjs. Called detached by distill-session.sh. Reads the JSONL transcript, asks a cheap model
// (haiku, headless `claude -p`) to extract patterns/mistakes/decisions, and writes deduped
// markdown notes into the vault. Best-effort: any failure just logs.
//
// Tests:       node --test hooks/lib/distill-session.test.mjs
// Dry run (no LLM call, canned insights):
//   DISTILL_DRYRUN=1 node hooks/distill-session.mjs <transcript> <cwd>
//
// Ported from distill-session.py on 2026-08-16. Python was the last non-node runtime here and
// bought nothing: node >= 22.5 is already a hard requirement for node:sqlite, while python3 was
// whatever the machine happened to ship — macOS ships 3.9, which could not even parse this file's
// `str | None` annotations, so distillation was silently dead on a stock Mac.
//
// The port also DELETES a mirror rather than moving one. vault/config/project-key resolution
// existed three times (vault-env.sh, paths.mjs, and this file's own re-implementation); it now
// exists twice, and this file imports paths.mjs instead of re-deriving anything. project_key in
// particular is a non-trivial sed over git remote URLs — there is one copy of it again.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as paths from './paths.mjs';
import {
  countLines,
  detach,
  findClaude,
  markerPath,
  nowSeconds,
  readMarker,
  which,
  withinDebounce,
  writeMarker,
} from './hook-io.mjs';

// DISTILL_VAULT stays supported for dry runs against a throwaway vault; otherwise this is
// exactly paths.vault() — env, then config.json, then the default.
const VAULT = process.env.DISTILL_VAULT || paths.vault();
const MAX_CHARS = 50_000; // tail of the conversation fed to the extractor

const EXTRACT_PROMPT = `You are distilling a coding session into durable lessons. From the transcript below, extract only genuinely reusable insights — skip anything trivial or one-off. Return STRICT JSON (no prose, no code fences) with this shape:
{"patterns":[{"title":"","description":"","aliases":["",""]}],"mistakes":[{"title":"","error":"","fix":"","aliases":["",""]}],"decisions":[{"title":"","decision":"","why":"","aliases":["",""]}]}
A thin session may yield empty TOP-LEVEL arrays (no patterns/mistakes/decisions) — that is fine. But every note you DO emit MUST carry a non-empty "aliases" array of 2-3 items. Titles must be short and specific. Each alias is a short natural-language question a future session would ask to find this note, deliberately PARAPHRASED (different words than the title) — this is what makes the note retrievable by meaning, not just its keywords. A note without aliases is incomplete; never omit them, even for a single-note session.

TRANSCRIPT:
`;

// ---------------------------------------------------------------- pure helpers (self-tested)

// \p{L}\p{N} with the u flag, NOT \w: JS's \w is ASCII-only where Python's is unicode-aware, so
// a plain port would silently strip accented characters out of every non-English title.
/**
 * @typedef {{
 *   title?: string,
 *   description?: string,
 *   error?: string,
 *   fix?: string,
 *   decision?: string,
 *   why?: string,
 *   aliases?: unknown,
 * }} InsightItem
 * @typedef {{ patterns?: InsightItem[], mistakes?: InsightItem[], decisions?: InsightItem[] }} Insights
 */

/**
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  const s = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .trim();
  return s.replace(/[\s_]+/g, '-').slice(0, 60) || 'untitled';
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'for',
  'in',
  'to',
  'with',
  'and',
  'or',
  'not',
  'is',
  'are',
  'be',
  'as',
  'on',
  'at',
  'by',
  'from',
  'into',
  'via',
  'when',
  'then',
  'its',
  'this',
  'that',
  'must',
  'should',
  'can',
  'do',
  'does',
  'dont',
  'was',
  'were',
  'it',
]);

// Jaccard over slug tokens above which a new note is treated as a restatement of an existing
// one. 0.45 merges the known regressions (allow-failure/masks-child ~0.6, resource-group/
// process-mode ~0.5 after singularising) without collapsing distinct lessons that merely share
// vocabulary.
const RECONCILE_AT = 0.45;

// Second arm, on the BODY, because the slug arm cannot see a restatement that reuses none of the
// title's words. A /memory:health audit on 2026-08-17 found 16 same-lesson pairs in this vault that
// the slug arm had let through — and only the 6 whose slugs happened to overlap ever got an
// addendum. Measured against those 16 pairs plus 7 the audit judged complementary (must NOT merge):
//
//   arm                        caught   false merges
//   slug Jaccard      >= 0.45   0/16       0/7
//   body Jaccard      >= 0.25   6/16       0/7
//   body containment  >= 0.40  11/16       0/7
//
// Jaccard loses because these pairs differ in LENGTH: a two-sentence note restating a six-sentence
// one shares most of its own vocabulary but a small fraction of the union, so the denominator buries
// it. Containment divides by the smaller set, and asymmetry stops being a penalty.
//
// 0.40, not the 0.30 that would catch 15/16: the highest complementary pair scores 0.286, so 0.40
// keeps a 0.114 margin while 0.30 leaves 0.006. The costs are asymmetric — a false merge folds one
// lesson into another and deletes the distinct one, a miss just leaves a duplicate for
// /memory:prune. Be conservative here.
//
// ponytail: token overlap, not embeddings. The ceiling is the 5/16 it still misses, pairs that share
// a lesson but almost no wording. Upgrade path: embed the new note and compare against the semantic
// index, which finds all 16 at cosine >= 0.75 — that means reindexing BEFORE this check instead of
// after, so only do it if the miss rate ever outweighs added SessionEnd latency.
const RECONCILE_BODY_AT = 0.4;

/**
 * Significant, lightly-singularised tokens of a slug — the reconciliation key.
 *
 * @param {string} slug
 * @returns {Set<string>}
 */
export function tokens(slug) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const t of slug.split('-')) {
    if (t.length > 2 && !STOP.has(t)) out.add(t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
  }
  return out;
}

/**
 * Prose tokens of a note body, via the same tokeniser the slug arm uses.
 *
 * Strips what is not the claim: frontmatter, the `##` heading (it restates the title, which the
 * slug arm already scores), the alias line (retrieval vocabulary, deliberately over-broad — leaving
 * it in inflates every pair), and `**Also seen` addenda a previous reconcile folded in.
 *
 * @param {unknown} text
 * @returns {Set<string>}
 */
export function bodyTokens(text) {
  const prose = String(text)
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^\s*#{1,6} .*$/gm, '')
    .replace(/^_Also asked as:.*$/gm, '')
    .replace(/^\*\*Also seen .*$/gm, '');
  return tokens(prose.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-'));
}

/** Overlap as a fraction of the SMALLER set — see RECONCILE_BODY_AT for why not Jaccard. */
/**
 * @param {ReadonlySet<string>} a
 * @param {ReadonlySet<string>} b
 * @returns {number}
 */
function containment(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}

/**
 * Existing note in `dir` that already carries this lesson, or null.
 *
 * Same-folder only, deliberately: a Pattern and a Mistake on one topic are complementary by
 * design, not duplicates.
 *
 * @param {string} dir
 * @param {string} sl
 * @param {string} [body]
 * @returns {string | null}
 */
export function findNearDuplicate(dir, sl, body = '') {
  const now = tokens(sl);
  /** @type {Set<string>} */
  const nowBody = body ? bodyTokens(body) : new Set();
  if (!now.size && !nowBody.size) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  // Each arm is divided by its OWN threshold, so both are expressed as "fraction of the bar" and a
  // single >= 1 gate compares them. Without that the two scales are not comparable and whichever
  // arm happens to run second wins.
  /** @type {string | null} */
  let best = null;
  let bestScore = 0;
  for (const f of entries) {
    const file = path.join(dir, f);
    let score = 0;
    const old = tokens(f.slice(0, -3).replace(/^\d{4}-\d{2}-\d{2}-/, ''));
    if (old.size && now.size) {
      let inter = 0;
      for (const t of now) if (old.has(t)) inter++;
      score = inter / (now.size + old.size - inter) / RECONCILE_AT;
    }
    // Body arm only when a body was supplied — a 2-arg call reads no files and behaves exactly as
    // before. N reads per new note; the folder is the bound, and this runs detached at SessionEnd.
    if (nowBody.size) {
      let oldBody = null;
      try {
        oldBody = bodyTokens(fs.readFileSync(file, 'utf8'));
      } catch {
        /* unreadable: skip */
      }
      if (oldBody?.size) score = Math.max(score, containment(nowBody, oldBody) / RECONCILE_BODY_AT);
    }
    if (score > bestScore) {
      best = file;
      bestScore = score;
    }
  }
  return bestScore >= 1 ? best : null;
}

/**
 * UPDATE the existing note in place instead of ADDing a near-duplicate file.
 *
 * Folds in the new phrasing's aliases (retrieval surface) and a dated one-line addendum (the new
 * detail), so nothing is lost but no new file is spawned.
 *
 * @param {string} file
 * @param {string} title
 * @param {string} body
 * @param {string} aliasLine
 * @param {string} today
 * @returns {void}
 */
export function reconcile(file, title, body, aliasLine, today) {
  let text = fs.readFileSync(file, 'utf8');
  if (aliasLine) {
    const m = text.match(/^_Also asked as: (.+)_\s*$/m);
    if (m) {
      const have = new Set(m[1].split(',').map((a) => a.trim().toLowerCase().replace(/\.+$/, '')));
      const add = aliasLine
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a && !have.has(a.toLowerCase().replace(/\.+$/, '')));
      if (add.length) {
        const merged = `_Also asked as: ${m[1].replace(/\.+$/, '')}, ${add.join(', ')}._`;
        const at = /** @type {number} */ (m.index);
        text = text.slice(0, at) + merged + text.slice(at + m[0].length);
      }
    } else {
      text = `${text.replace(/\s+$/, '')}\n\n_Also asked as: ${aliasLine}._\n`;
    }
  }
  const gist = body.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim();
  if (gist && !text.includes(`**Also seen ${today}`)) {
    text = `${text.replace(/\s+$/, '')}\n\n**Also seen ${today} (${title}):** ${gist.slice(0, 400)}\n`;
  }
  fs.writeFileSync(file, text);
}

/**
 * Pull the first JSON object out of a model response (tolerates fences/prose).
 *
 * @param {string} raw
 * @returns {Insights}
 */
export function extractJson(raw) {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?|```$/gm, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return {};
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return {};
  }
}

/**
 * Flatten a JSONL transcript to role-tagged text + tool names.
 *
 * @param {string} file
 * @returns {string}
 */
export function transcriptToText(file) {
  /** @type {string[]} */
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const msg = obj.message || {};
    const role = msg.role || obj.type || '';
    const content = msg.content;
    if (typeof content === 'string') {
      out.push(`[${role}] ${content}`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') out.push(`[${role}] ${block.text ?? ''}`);
        else if (block.type === 'tool_use') out.push(`[${role}:tool] ${block.name ?? ''}`);
        else if (block.type === 'tool_result') {
          let r = block.content ?? '';
          if (Array.isArray(r))
            r = r
              .filter((b) => b && typeof b === 'object')
              .map((b) => b.text ?? '')
              .join(' ');
          out.push(`[tool_result] ${String(r).slice(0, 400)}`);
        }
      }
    }
  }
  // Privacy guard: never distill anything the user wrapped in <private>…</private>.
  const text = out.join('\n').replace(/<private>.*?<\/private>/gis, '[REDACTED]');
  return text.slice(-MAX_CHARS);
}

/** Local calendar date, matching Python's date.today(). toISOString() would be UTC and would
 *  file a late-evening session under tomorrow. Note filenames are dated, so this is visible.
 *
 * @param {Date} [d]
 * @returns {string}
 */
export function todayStr(d = new Date()) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------------------------------------------------------- environment

// findClaude lives in hook-io.mjs: graph-staleness-check probes the same four locations, and while
// one list was here and the other was in bash they drifted without anything noticing.

/** project_key via paths.mjs, the one resolver. Falls back to the cwd-slug when git is
 *  unavailable — a hook must get an answer, never an exception.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function projectKey(cwd) {
  try {
    return paths.projectKey(cwd);
  } catch {
    return paths.legacyKey(cwd);
  }
}

/**
 * @param {string} convo
 * @returns {Insights}
 */
function runExtractor(convo) {
  if (process.env.DISTILL_DRYRUN) {
    return {
      patterns: [{ title: 'Dry run pattern', description: 'canned' }],
      mistakes: [{ title: 'Dry run mistake', error: 'e', fix: 'f' }],
      decisions: [{ title: 'Dry run decision', decision: 'd', why: 'w' }],
    };
  }
  const claude = findClaude();
  if (!claude) {
    console.error('distill: claude CLI not found');
    return {};
  }
  try {
    const stdout = execFileSync(claude, ['-p', '--model', 'haiku'], {
      input: EXTRACT_PROMPT + convo,
      encoding: 'utf8',
      timeout: 150_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CLAUDE_DISTILL_CHILD: '1' }, // guard against recursive Stop hook
    });
    return extractJson(stdout);
  } catch (e) {
    console.error(`distill: extractor failed: ${/** @type {NodeJS.ErrnoException} */ (e).message}`);
    return {};
  }
}

// ---------------------------------------------------------------- notes

/**
 * @param {Insights} insights
 * @param {string} slug
 * @returns {{ written: number, merged: number }}
 */
function writeNotes(insights, slug) {
  const today = todayStr();
  const base = path.join(VAULT, 'Insights', slug);
  let written = 0,
    merged = 0;

  /**
   * @param {string} folder
   * @param {string} tag
   * @param {string} title
   * @param {string} body
   * @param {unknown} aliases
   */
  const emit = (folder, tag, title, body, aliases) => {
    const d = path.join(base, folder);
    fs.mkdirSync(d, { recursive: true });
    const sl = slugify(title);
    // dedup: skip if a note with this slug already exists (any date)
    const existing = fs.readdirSync(d).filter((f) => f.endsWith('.md'));
    if (existing.some((f) => f.endsWith(`-${sl}.md`) || f.slice(0, -3) === sl)) return;
    // paraphrase aliases -> retrievable by meaning, not just keywords (maintains cheap recall)
    const line = Array.isArray(aliases)
      ? aliases
          .filter((a) => typeof a === 'string' && a.trim())
          .map((a) => a.trim())
          .join(', ')
      : '';
    // Reconcile before appending: a restatement of an existing lesson updates that note rather
    // than spawning a near-duplicate. Without this the distiller keeps re-creating notes
    // /memory:prune has just merged away.
    const dup = findNearDuplicate(d, sl, body);
    if (dup) {
      reconcile(dup, title, body, line, today);
      merged++;
      return;
    }
    const text = line ? `${body.replace(/\s+$/, '')}\n\n_Also asked as: ${line}._\n` : body;
    // YAML-safe: quote the title so colons/quotes in it don't break frontmatter
    const safeTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const fm = `---\ntitle: "${safeTitle}"\ndate: ${today}\nproject: ${slug}\ntags: [${tag}]\ntype: insight\n---\n\n`;
    fs.writeFileSync(path.join(d, `${today}-${sl}.md`), fm + text);
    written++;
  };

  for (const it of insights.patterns || []) {
    if (it?.title)
      emit(
        'Patterns',
        'pattern',
        it.title,
        `## ${it.title}\n\n${it.description ?? ''}\n`,
        it.aliases,
      );
  }
  for (const it of insights.mistakes || []) {
    if (it?.title)
      emit(
        'Mistakes',
        'mistake',
        it.title,
        `## ${it.title}\n\n**Error:** ${it.error ?? ''}\n\n**Fix:** ${it.fix ?? ''}\n`,
        it.aliases,
      );
  }
  for (const it of insights.decisions || []) {
    if (it?.title)
      emit(
        'Decisions',
        'decision',
        it.title,
        `## ${it.title}\n\n**Decision:** ${it.decision ?? ''}\n\n**Why:** ${it.why ?? ''}\n`,
        it.aliases,
      );
  }
  return { written, merged };
}

/**
 * Refresh the search indexes so notes written this session are findable next session.
 * Event-driven — runs right after writeNotes, inside this detached child, so the session never
 * waits. Failures never break distillation.
 *
 * context-mode is OPTIONAL. It backs `ctx_search` (BM25/FTS5), which is a SECOND index, separate
 * from the one this plugin owns. `scripts/memory-semantic.mjs` carries its own vector arm AND its
 * own BM25 arm in its own SQLite file, and that is the primary retrieval path — it does not read
 * anything context-mode writes. So when the CLI is absent the fallback is simply to refresh the
 * index we do own, and the only thing actually lost is ctx_search freshness.
 *
 * @param {string} cwd
 * @param {string} slug
 * @returns {void}
 */
function reindex(cwd, slug) {
  const cm = which('context-mode');
  if (!cm) {
    // This CLI resolves out of an fnm/nvm multishell dir, so switching Node versions silently
    // drops it from PATH. Say what was lost precisely — the old message claimed the vault stops
    // being searchable, which was never true of the plugin's own index.
    console.error(
      'distill: context-mode not on PATH — ctx_search will drift behind the notes on ' +
        "disk. The plugin's own index is unaffected and is being refreshed instead. " +
        'To restore ctx_search: npm i -g context-mode (then /memory:prune to catch up).',
    );
    refreshOwnIndex(cwd);
    return;
  }
  // The source label carries the SAME identity as the directory indexed on the next line: both are
  // `slug`. Until 2026-08-19 the label used `path.basename(cwd)` while the directory used `slug` —
  // two identity schemes on adjacent lines, so a checkout in `~/work/mem` of the repo keyed
  // `github.com-spike1292-claude-memory` indexed that project's notes under the source
  // `vault-memory-mem`.
  //
  // What that actually cost is narrower than it looks, and the narrower version is the reason:
  // context-mode partitions its content DB by checkout path (`--project cwd` → its own
  // `<hash>.db`), so two checkouts of one repo never shared an index and the old scheme could not
  // write duplicate rows over the same notes on its own. The harm was that the label did not name
  // the thing it indexed. Retrieval guidance has to tell Claude which source to scope to; with the
  // label derived from the checkout directory, that string differed per machine and per clone
  // while the notes it pointed at were one shared vault folder, and a human re-indexing by hand
  // (as /memory:prune does) had to reconstruct a name nothing else in the system uses. Now the
  // label is derivable from the note path, because it IS the note path's key.
  //
  // The property to preserve is "label == indexed directory", NOT "label == projectKey(cwd)":
  // `slug` falls back to `legacyKey` above when the vault has not been migrated yet, and legacyKey
  // is a raw cwd slug that can carry uppercase. Keep deriving both from the same `slug`.
  for (const layer of ['Insights', 'Memory', 'Logs', 'Graph']) {
    const label = `vault-${layer.toLowerCase()}-${slug}`;
    const d = path.join(VAULT, layer, slug);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
    try {
      execFileSync(cm, ['index', d, '--project', cwd, '--source', label], {
        encoding: 'utf8',
        timeout: 120_000,
        stdio: 'pipe',
      });
    } catch (e) {
      console.error(
        `distill: reindex ${layer} failed: ${/** @type {NodeJS.ErrnoException} */ (e).message}`,
      );
    }
  }
  // permanent/ is cross-project (not slug-scoped): index the shared dir under this project so its
  // notes are searchable here too. Global source label.
  const pdir = path.join(VAULT, 'permanent');
  if (fs.existsSync(pdir) && fs.statSync(pdir).isDirectory()) {
    try {
      execFileSync(cm, ['index', pdir, '--project', cwd, '--source', 'vault-permanent'], {
        encoding: 'utf8',
        timeout: 120_000,
        stdio: 'pipe',
      });
    } catch (e) {
      console.error(
        `distill: reindex permanent failed: ${/** @type {NodeJS.ErrnoException} */ (e).message}`,
      );
    }
  }
}

/**
 * Fallback when context-mode is absent: refresh the index this plugin actually owns, so the notes
 * just written are retrievable now rather than at the next SessionStart. --index is idempotent,
 * compares mtimes and exits before loading the model when nothing changed, and takes its own lock,
 * so racing the SessionStart refresh is safe.
 *
 * @param {string} cwd
 * @returns {void}
 */
function refreshOwnIndex(cwd) {
  const script = path.join(paths.scriptsDir, 'memory-semantic.mjs');
  if (!fs.existsSync(script)) return;
  try {
    execFileSync(process.execPath, [script, '--index', cwd], {
      encoding: 'utf8',
      timeout: 600_000,
      stdio: 'pipe',
    });
    console.error('distill: refreshed the plugin semantic index');
  } catch (e) {
    console.error(
      `distill: semantic index refresh failed: ${/** @type {NodeJS.ErrnoException} */ (e).message}`,
    );
  }
}

// ---------------------------------------------------------------- selftest

/**
 * Distil one transcript into notes. Returns what happened; prints nothing.
 *
 * Split out of main() so the orchestration is importable: the CLI entry only parses argv.
 *
 * @param {string} transcript
 * @param {string} cwd
 * @returns {{ written: number, merged: number, slug: string } | null}
 */
export function distill(transcript, cwd) {
  let slug = projectKey(cwd);
  // Pre-migration fallback: vault-memory-sync.sh renames the folders at SessionStart, but this
  // runs at SessionEnd of a session that may have started before the rename.
  const legacy = paths.legacyKey(cwd);
  if (
    slug !== legacy &&
    !fs.existsSync(path.join(VAULT, 'Insights', slug)) &&
    fs.existsSync(path.join(VAULT, 'Insights', legacy))
  ) {
    slug = legacy;
  }
  if (!fs.existsSync(transcript) || !fs.statSync(transcript).isFile()) return null;
  const convo = transcriptToText(transcript);
  if (convo.length < 200) return null;
  const insights = runExtractor(convo);
  const { written, merged } = writeNotes(insights, slug);
  // reindex unconditionally: Memory/Logs can change without new Insights (e.g. /remember, manual
  // note edits), and reindex() skips missing dirs.
  // ponytail: re-reads dirs every session end; append-only so deletions still need
  // /memory:prune's purge — the distiller only keeps additions fresh.
  reindex(cwd, slug);
  return { written, merged, slug };
}

// ---------------------------------------------------------------- gate (SessionEnd + Stop)

/**
 * @typedef {{ run: false, reason: string, lines?: number }} SkipGate
 * @typedef {{ run: true, transcript: string, marker: string, now: number, lines: number }} RunGate
 * @typedef {SkipGate | (RunGate & { spawned?: boolean })} GatePlan
 */

/** Below this a session has no lesson in it; distilling would be noise with an LLM call attached. */
export const MIN_MESSAGES = 15;
/** Stop only distils a LONG session — a normal one ends via SessionEnd first. */
export const STOP_MIN_MESSAGES = 400;
/** …and at most this often, so a hard-killed long session loses at most two hours of lessons. */
export const STOP_DEBOUNCE_SECONDS = 7200;

// Constants because gateOutcome() decides on them. Two literals — one in the plan, one in the
// mapper — drift apart silently: reword one and a recursion guard starts reporting as a hook that
// ran, with every test still green.
export const GATE_REASONS = {
  child: 'child run',
  stopActive: 'stop_hook_active',
  debounced: 'stop: debounced',
  noTranscript: 'no transcript path',
  badTranscript: 'transcript missing',
};

/**
 * Decide whether this event should distil, without spawning or writing.
 *
 * Dual trigger, and the two are not the same job:
 *   - SessionEnd is authoritative and always runs on a non-trivial session. Once per session keeps
 *     Insights signal-dense; distilling per turn would bury the lessons in churn.
 *   - Stop is a CRASH FALLBACK. It fires constantly during normal work, so it is gated hard.
 *
 * @param {import('./hook-io.mjs').HookPayload | null | undefined} p
 * @param {{ now?: number }} [options]
 * @returns {GatePlan}
 */
export function gatePlan(p, { now = nowSeconds() } = {}) {
  // The headless extractor runs as a `claude` session, whose Stop fires this hook again. Without
  // this the distiller distils its own distillation, recursively.
  if (process.env.CLAUDE_DISTILL_CHILD) return { run: false, reason: GATE_REASONS.child };
  // Claude Code's own Stop-loop guard. Absent on SessionEnd, harmless there.
  if (p?.stop_hook_active === true) return { run: false, reason: GATE_REASONS.stopActive };

  const transcript = p?.transcript_path;
  if (!transcript) return { run: false, reason: GATE_REASONS.noTranscript };
  try {
    if (!fs.statSync(transcript).isFile()) return { run: false, reason: 'transcript not a file' };
  } catch {
    return { run: false, reason: GATE_REASONS.badTranscript };
  }

  const lines = countLines(transcript);
  if (lines < MIN_MESSAGES) return { run: false, reason: 'trivial session', lines };

  const sid = p?.session_id || 'nosession';
  const marker = markerPath(`distill-${sid}`);

  if (p?.hook_event_name !== 'SessionEnd') {
    if (lines < STOP_MIN_MESSAGES) return { run: false, reason: 'stop: session too short', lines };
    if (withinDebounce(readMarker(marker), STOP_DEBOUNCE_SECONDS, now))
      return { run: false, reason: GATE_REASONS.debounced, lines };
  }

  return { run: true, transcript, marker, now, lines };
}

/**
 * Gate, then detach the worker.
 *
 * The worker is this module's own entry, re-invoked with argv — one file, two modes, because the
 * gate and the work are the same hook and splitting them into two entries would put the contract
 * in two places.
 *
 * @param {import('./hook-io.mjs').HookPayload | null | undefined} p
 * @returns {GatePlan}
 */
export function gate(p) {
  const plan = gatePlan(p);
  if (!plan.run) return plan;
  writeMarker(plan.marker, plan.now);
  const pid = detach(
    process.execPath,
    [path.join(paths.hooksDir, 'distill-session.mjs'), plan.transcript, p?.cwd || process.cwd()],
    {
      cwd: p?.cwd,
      logFile: path.join(paths.stateDir('logs'), 'distill.log'),
      env: { MEMORY_HOOK_SESSION: p?.session_id },
    },
  );
  // The spawn is the only part of this gate that can fail, and it fails ASYNCHRONOUSLY: a null pid
  // is the one signal there is. Ignoring it meant logging `spawned` for a run that never started —
  // a healthy-looking column with nothing anywhere to contradict it, which is the exact failure the
  // outcome field exists to end.
  return { ...plan, spawned: pid != null };
}

/**
 * The gate's outcome, for the hook log.
 *
 * `stop_hook_active` is Claude Code's own recursion guard and `child run` is this hook's, so both
 * are the same story: the hook fired inside work it had itself started. Every other skip is a real
 * decision about a real session and reads as `ran`.
 *
 * @param {GatePlan} plan
 * @returns {import('./hook-io.mjs').HookOutcome}
 */
export function gateOutcome(plan) {
  // `spawned === false` means detach() came back with no pid.
  if (plan.run) return plan.spawned === false ? 'error' : 'spawned';
  if (plan.reason === GATE_REASONS.child || plan.reason === GATE_REASONS.stopActive)
    return 'child-guard';
  if (plan.reason === GATE_REASONS.debounced) return 'debounced';
  // A transcript that is absent or unreadable is this hook's missing dependency: Claude Code hands
  // it the path, and if that stops arriving the distiller is permanently dead while exiting 0 and
  // printing nothing. Reporting it as `ran` would hide exactly the outage worth seeing.
  if (plan.reason === GATE_REASONS.noTranscript || plan.reason === GATE_REASONS.badTranscript)
    return 'noop-missing-dep';
  return 'ran';
}
