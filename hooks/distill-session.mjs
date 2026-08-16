#!/usr/bin/env node
// Distill a Claude Code session transcript into Obsidian Insight notes.
//
// Called detached by distill-session.sh. Reads the JSONL transcript, asks a cheap model
// (haiku, headless `claude -p`) to extract patterns/mistakes/decisions, and writes deduped
// markdown notes into the vault. Best-effort: any failure just logs.
//
// Self-check:  node distill-session.mjs --selftest
// Dry run (no LLM call, canned insights):
//   DISTILL_DRYRUN=1 node distill-session.mjs <transcript> <cwd>
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
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as paths from './lib/paths.mjs';

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
export function slugify(text) {
  const s = text.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim();
  return s.replace(/[\s_]+/g, '-').slice(0, 60) || 'untitled';
}

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'in', 'to', 'with', 'and', 'or', 'not', 'is',
  'are', 'be', 'as', 'on', 'at', 'by', 'from', 'into', 'via', 'when', 'then', 'its', 'this',
  'that', 'must', 'should', 'can', 'do', 'does', 'dont', 'was', 'were', 'it']);

// Jaccard over slug tokens above which a new note is treated as a restatement of an existing
// one. 0.45 merges the known regressions (allow-failure/masks-child ~0.6, resource-group/
// process-mode ~0.5 after singularising) without collapsing distinct lessons that merely share
// vocabulary.
const RECONCILE_AT = 0.45;

/** Significant, lightly-singularised tokens of a slug — the reconciliation key. */
export function tokens(slug) {
  const out = new Set();
  for (const t of slug.split('-')) {
    if (t.length > 2 && !STOP.has(t)) out.add(t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
  }
  return out;
}

/**
 * Existing note in `dir` that already carries this lesson, or null.
 *
 * Same-folder only, deliberately: a Pattern and a Mistake on one topic are complementary by
 * design, not duplicates.
 */
export function findNearDuplicate(dir, sl) {
  const now = tokens(sl);
  if (!now.size) return null;
  let best = null, bestScore = 0;
  let entries;
  try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return null; }
  for (const f of entries) {
    const old = tokens(f.slice(0, -3).replace(/^\d{4}-\d{2}-\d{2}-/, ''));
    if (!old.size) continue;
    let inter = 0;
    for (const t of now) if (old.has(t)) inter++;
    const score = inter / (now.size + old.size - inter);
    if (score > bestScore) { best = path.join(dir, f); bestScore = score; }
  }
  return bestScore >= RECONCILE_AT ? best : null;
}

/**
 * UPDATE the existing note in place instead of ADDing a near-duplicate file.
 *
 * Folds in the new phrasing's aliases (retrieval surface) and a dated one-line addendum (the new
 * detail), so nothing is lost but no new file is spawned.
 */
export function reconcile(file, title, body, aliasLine, today) {
  let text = fs.readFileSync(file, 'utf8');
  if (aliasLine) {
    const m = text.match(/^_Also asked as: (.+)_\s*$/m);
    if (m) {
      const have = new Set(m[1].split(',').map((a) => a.trim().toLowerCase().replace(/\.+$/, '')));
      const add = aliasLine.split(',').map((a) => a.trim())
        .filter((a) => a && !have.has(a.toLowerCase().replace(/\.+$/, '')));
      if (add.length) {
        const merged = `_Also asked as: ${m[1].replace(/\.+$/, '')}, ${add.join(', ')}._`;
        text = text.slice(0, m.index) + merged + text.slice(m.index + m[0].length);
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

/** Pull the first JSON object out of a model response (tolerates fences/prose). */
export function extractJson(raw) {
  const cleaned = raw.trim().replace(/^```(?:json)?|```$/gm, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return {};
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return {}; }
}

/** Flatten a JSONL transcript to role-tagged text + tool names. */
export function transcriptToText(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
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
          if (Array.isArray(r)) r = r.filter((b) => b && typeof b === 'object').map((b) => b.text ?? '').join(' ');
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
 *  file a late-evening session under tomorrow. Note filenames are dated, so this is visible. */
export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------------------------------------------------------- environment

function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

function findClaude() {
  for (const cand of [which('claude'), path.join(os.homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (cand && fs.existsSync(cand)) return cand;
  }
  return null;
}

/** project_key via vault-env.sh — one implementation. Falls back to the cwd-slug if bash or
 *  git is unavailable, which is what the shell version does too. */
function projectKey(cwd) {
  try { return paths.projectKey(cwd); } catch { return paths.legacyKey(cwd); }
}

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
    console.error(`distill: extractor failed: ${e.message}`);
    return {};
  }
}

// ---------------------------------------------------------------- notes

function writeNotes(insights, slug) {
  const today = todayStr();
  const base = path.join(VAULT, 'Insights', slug);
  let written = 0, merged = 0;

  const emit = (folder, tag, title, body, aliases) => {
    const d = path.join(base, folder);
    fs.mkdirSync(d, { recursive: true });
    const sl = slugify(title);
    // dedup: skip if a note with this slug already exists (any date)
    const existing = fs.readdirSync(d).filter((f) => f.endsWith('.md'));
    if (existing.some((f) => f.endsWith(`-${sl}.md`) || f.slice(0, -3) === sl)) return;
    // paraphrase aliases -> retrievable by meaning, not just keywords (maintains cheap recall)
    const line = Array.isArray(aliases)
      ? aliases.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()).join(', ')
      : '';
    // Reconcile before appending: a restatement of an existing lesson updates that note rather
    // than spawning a near-duplicate. Without this the distiller keeps re-creating notes
    // /memory:prune has just merged away.
    const dup = findNearDuplicate(d, sl);
    if (dup) { reconcile(dup, title, body, line, today); merged++; return; }
    const text = line ? `${body.replace(/\s+$/, '')}\n\n_Also asked as: ${line}._\n` : body;
    // YAML-safe: quote the title so colons/quotes in it don't break frontmatter
    const safeTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const fm = `---\ntitle: "${safeTitle}"\ndate: ${today}\nproject: ${slug}\ntags: [${tag}]\ntype: insight\n---\n\n`;
    fs.writeFileSync(path.join(d, `${today}-${sl}.md`), fm + text);
    written++;
  };

  for (const it of insights.patterns || []) {
    if (it?.title) emit('Patterns', 'pattern', it.title, `## ${it.title}\n\n${it.description ?? ''}\n`, it.aliases);
  }
  for (const it of insights.mistakes || []) {
    if (it?.title) emit('Mistakes', 'mistake', it.title,
      `## ${it.title}\n\n**Error:** ${it.error ?? ''}\n\n**Fix:** ${it.fix ?? ''}\n`, it.aliases);
  }
  for (const it of insights.decisions || []) {
    if (it?.title) emit('Decisions', 'decision', it.title,
      `## ${it.title}\n\n**Decision:** ${it.decision ?? ''}\n\n**Why:** ${it.why ?? ''}\n`, it.aliases);
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
 */
function reindex(cwd, slug) {
  const cm = which('context-mode');
  if (!cm) {
    // This CLI resolves out of an fnm/nvm multishell dir, so switching Node versions silently
    // drops it from PATH. Say what was lost precisely — the old message claimed the vault stops
    // being searchable, which was never true of the plugin's own index.
    console.error('distill: context-mode not on PATH — ctx_search will drift behind the notes on '
      + 'disk. The plugin\'s own index is unaffected and is being refreshed instead. '
      + 'To restore ctx_search: npm i -g context-mode (then /memory:prune to catch up).');
    refreshOwnIndex(cwd);
    return;
  }
  for (const [layer, label] of [
    ['Insights', `vault-insights-${(path.basename(cwd) || 'vault').toLowerCase()}`],
    ['Memory', `vault-memory-${(path.basename(cwd) || 'vault').toLowerCase()}`],
    ['Logs', `vault-logs-${(path.basename(cwd) || 'vault').toLowerCase()}`],
    ['Graph', `vault-graph-${(path.basename(cwd) || 'vault').toLowerCase()}`],
  ]) {
    const d = path.join(VAULT, layer, slug);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
    try {
      execFileSync(cm, ['index', d, '--project', cwd, '--source', label],
        { encoding: 'utf8', timeout: 120_000, stdio: 'pipe' });
    } catch (e) {
      console.error(`distill: reindex ${layer} failed: ${e.message}`);
    }
  }
  // permanent/ is cross-project (not slug-scoped): index the shared dir under this project so its
  // notes are searchable here too. Global source label.
  const pdir = path.join(VAULT, 'permanent');
  if (fs.existsSync(pdir) && fs.statSync(pdir).isDirectory()) {
    try {
      execFileSync(cm, ['index', pdir, '--project', cwd, '--source', 'vault-permanent'],
        { encoding: 'utf8', timeout: 120_000, stdio: 'pipe' });
    } catch (e) {
      console.error(`distill: reindex permanent failed: ${e.message}`);
    }
  }
}

/**
 * Fallback when context-mode is absent: refresh the index this plugin actually owns, so the notes
 * just written are retrievable now rather than at the next SessionStart. --index is idempotent,
 * compares mtimes and exits before loading the model when nothing changed, and takes its own lock,
 * so racing the SessionStart refresh is safe.
 */
function refreshOwnIndex(cwd) {
  const script = path.join(paths.scriptsDir, 'memory-semantic.mjs');
  if (!fs.existsSync(script)) return;
  try {
    execFileSync(process.execPath, [script, '--index', cwd],
      { encoding: 'utf8', timeout: 600_000, stdio: 'pipe' });
    console.error('distill: refreshed the plugin semantic index');
  } catch (e) {
    console.error(`distill: semantic index refresh failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------- selftest

function selftest() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-'));

  assert.strictEqual(slugify('Use $web Container!'), 'use-web-container');
  // \w vs \p{L}: the ASCII-only port of this would return "rsum-cach"
  assert.strictEqual(slugify('Résumé cache'), 'résumé-cache');
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(extractJson('noise {"a": 2} tail'), { a: 2 });
  assert.deepStrictEqual(extractJson('not json'), {});

  assert.strictEqual(todayStr(new Date(2026, 7, 6)), '2026-08-06');

  // project_key must agree with hooks/lib/vault-env.sh across URL forms. It now IS vault-env.sh,
  // so this asserts that sed pipeline rather than a second copy of it.
  const r = path.join(tmpBase, 'r');
  for (const [url, want] of [
    ['git@gitlab.example.com:TeamName/Frontend.git', 'gitlab.example.com-teamname-frontend'],
    ['https://gitlab.example.com/TeamName/Frontend.git', 'gitlab.example.com-teamname-frontend'],
    ['https://user:tok@gitlab.example.com/TeamName/Frontend', 'gitlab.example.com-teamname-frontend'],
  ]) {
    fs.rmSync(r, { recursive: true, force: true });
    execFileSync('git', ['init', '-q', r], { stdio: 'pipe' });
    execFileSync('git', ['-C', r, 'remote', 'add', 'origin', url], { stdio: 'pipe' });
    const got = projectKey(r);
    assert.strictEqual(got, want, `${url} -> ${got}, want ${want}`);
  }
  // non-git dir falls back to the legacy cwd-slug
  const plain = path.join(tmpBase, 'plain');
  fs.mkdirSync(plain);
  assert.strictEqual(projectKey(plain), paths.legacyKey(plain));

  const d = path.join(tmpBase, 'notes');
  fs.mkdirSync(d);
  // the two pairs that actually regressed after a /memory:prune merge
  fs.writeFileSync(path.join(d, '2026-08-06-parent-pipeline-allow-failure-true-hides-child-job-cancellat.md'),
    '---\ntitle: x\n---\n\n## x\n\nbody\n\n_Also asked as: why did the deploy vanish, parent hid it._\n');
  fs.writeFileSync(path.join(d, '2026-08-06-gitlab-resource-groups-process-mode-is-api-only-not-yaml.md'),
    '---\ntitle: y\n---\n\n## y\n\nbody\n');
  assert.ok(findNearDuplicate(d, 'parent-pipeline-allow-failure-masks-child-pipeline-cancellat'));
  assert.ok(findNearDuplicate(d, 'resource-group-process-mode-defaults-to-unordered-and-is-api'));
  // distinct lessons that merely share vocabulary must NOT collapse
  assert.strictEqual(findNearDuplicate(d, 'media-cache-key-with-query-aware-allowlist'), null);
  assert.strictEqual(findNearDuplicate(d, 'gitlab-ci-trigger-uses-branch-ref-not-commit-sha'), null);

  // reconcile: unions aliases, appends dated addendum, creates no file
  const target = path.join(d, '2026-08-06-parent-pipeline-allow-failure-true-hides-child-job-cancellat.md');
  const before = fs.readdirSync(d).filter((f) => f.endsWith('.md')).length;
  reconcile(target, 'Parent masks child cancellation',
    '## t\n\n**Error:** child jobs died silently\n', 'pipeline looked green', '2026-08-07');
  const out = fs.readFileSync(target, 'utf8');
  assert.strictEqual(fs.readdirSync(d).filter((f) => f.endsWith('.md')).length, before,
    'reconcile must not create a file');
  assert.ok(out.includes('pipeline looked green') && out.includes('why did the deploy vanish'),
    'aliases must union');
  assert.strictEqual(out.split('_Also asked as:').length - 1, 1,
    'must not append a second alias line');
  assert.ok(out.includes('**Also seen 2026-08-07') && out.includes('child jobs died silently'));
  reconcile(target, 'again', '## t\n\nmore\n', '', '2026-08-07');
  assert.strictEqual(fs.readFileSync(target, 'utf8').split('**Also seen 2026-08-07').length - 1, 1,
    'one addendum per day');

  // transcript flattening + the <private> redaction, which is the one guard with a privacy cost
  const tr = path.join(tmpBase, 't.jsonl');
  fs.writeFileSync(tr, [
    JSON.stringify({ message: { role: 'user', content: 'hello <private>my api key</private> bye' } }),
    'not json at all',
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash' }] } }),
  ].join('\n'));
  const flat = transcriptToText(tr);
  assert.ok(!flat.includes('my api key'), '<private> must never survive into the extractor');
  assert.ok(flat.includes('[REDACTED]') && flat.includes('[assistant:tool] Bash'));

  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log('selftest: 22 assertions passed');
}

// ---------------------------------------------------------------- main

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--selftest') { selftest(); return; }
  if (argv.length < 2) {
    console.error('usage: distill-session.mjs <transcript> <cwd>');
    process.exit(1);
  }
  const [transcript, cwd] = argv;
  let slug = projectKey(cwd);
  // Pre-migration fallback: vault-memory-sync.sh renames the folders at SessionStart, but this
  // runs at SessionEnd of a session that may have started before the rename.
  const legacy = paths.legacyKey(cwd);
  if (slug !== legacy && !fs.existsSync(path.join(VAULT, 'Insights', slug))
      && fs.existsSync(path.join(VAULT, 'Insights', legacy))) {
    slug = legacy;
  }
  if (!fs.existsSync(transcript) || !fs.statSync(transcript).isFile()) return;
  const convo = transcriptToText(transcript);
  if (convo.length < 200) return;
  const insights = runExtractor(convo);
  const { written, merged } = writeNotes(insights, slug);
  // reindex unconditionally: Memory/Logs can change without new Insights (e.g. /remember, manual
  // note edits), and reindex() skips missing dirs.
  // ponytail: re-reads dirs every session end; append-only so deletions still need
  // /memory:prune's purge — the distiller only keeps additions fresh.
  reindex(cwd, slug);
  console.log(`distill: wrote ${written} note(s), merged ${merged} into existing, for ${slug}`);
}

main();
