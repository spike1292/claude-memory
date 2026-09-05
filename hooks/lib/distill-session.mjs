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
// Ported from distill-session.py on 2026-08-16: macOS ships Python 3.9, which could not parse
// this file's `str | None` annotations, so distillation was silently dead on a stock Mac. Why
// Python was removed entirely: CLAUDE.md "no Python", docs/decisions/2026-08-17-bun.md. Imports
// paths.mjs for project-key resolution rather than re-deriving it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import * as paths from './paths.mjs';
// Imports nothing but node:fs and node:path, so it is safe above the entry guard — unlike
// scripts/lib/memory-semantic.mjs, which process.exit()s at module scope on an unknown model
// and is therefore reached only through an await import() inside a function.
import { isMarked } from '../../scripts/lib/memory-mark.mjs';
import {
  countLines,
  detach,
  logHook,
  findClaude,
  markerPath,
  nowSeconds,
  readMarker,
  requireHookCwd,
  which,
  withinDebounce,
  writeMarker,
} from './hook-io.mjs';

// DISTILL_VAULT stays supported for dry runs against a throwaway vault; otherwise this is
// paths.requireVault() — env or config.json, never the built-in default. Resolved lazily, inside
// distill(), so importing this module (tests, the gate) never resolves a vault at all — only the
// write path does, and only when it is about to write.
/** @type {string} */
let VAULT;
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
 * @typedef {{ file: string, title: string, action: 'written'|'merged' }} WrittenNote
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
 * Is this note marked as manually adjudicated — never auto-merge into it?
 *
 * The mark exists because correctly RELATING two notes raises their similarity: cross-linking
 * moved one kept pair 0.754 -> 0.762, over the 0.75 bar, so an audit that does its job creates the
 * merge proposal it just rejected. It is note-scoped rather than pair-scoped so it also holds at
 * write time, where the incoming note is neither end of any previously judged pair.
 *
 * Reads the mark through `isMarked()`, the same function `memory-mark.mjs` writes it with. Two
 * regexes for one field is the shape of this whole PR's bug at smaller scale: the writer and the
 * reader drift, and the mark silently stops blocking anything while every test stays green.
 *
 * Unreadable fails OPEN — an unreadable note is not evidence of a human judgement, and hooks do
 * not throw.
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isManual(file) {
  try {
    return isMarked(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Existing note in `dir` whose FILENAME says it already carries this lesson, or null.
 *
 * The fallback arm, used when the search server cannot answer. It was never the good arm — it
 * caught 0 of the 16 pairs that motivated the 2026-08-17 audit — but it is free and needs no
 * index, and a distiller that cannot dedup must still write.
 *
 * The body-overlap arm that used to sit beside it is GONE, not demoted: it caught 0 of 25 real
 * duplicates and all nine of its firings were false positives. Keeping a measured-harmful arm as a
 * "fallback" would ship a known false-merge risk. See
 * docs/decisions/2026-08-23-embedding-reconcile.md before reaching for token overlap again.
 *
 * Same-folder only, deliberately: a Pattern and a Mistake on one topic are complementary by
 * design, not duplicates.
 *
 * @param {string} dir
 * @param {string} sl
 * @returns {string | null}
 */
export function findNearDuplicate(dir, sl) {
  const now = tokens(sl);
  if (!now.size) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  /** @type {string | null} */
  let best = null;
  let bestScore = 0;
  for (const f of entries) {
    const old = tokens(f.slice(0, -3).replace(/^\d{4}-\d{2}-\d{2}-/, ''));
    if (!old.size) continue;
    let inter = 0;
    for (const t of now) if (old.has(t)) inter++;
    const score = inter / (now.size + old.size - inter);
    if (score > bestScore) {
      best = path.join(dir, f);
      bestScore = score;
    }
  }
  return bestScore >= RECONCILE_AT ? best : null;
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
 * Pull the result text and the usage figures out of a `--output-format json` envelope.
 *
 * Returns null for anything that is not an envelope, which is the FALLBACK signal: an older or
 * differently-configured CLI prints the model's answer as plain text, and losing every insight
 * because the wrapper shape changed would be a far worse trade than losing a cost figure.
 *
 * Cost is not estimated from the transcript, and this is why the issue's own estimation approach
 * was dropped: measured 2026-08-20, a headless run whose entire prompt was "Reply with only the
 * word ok." reported 9 input tokens but 18,078 cache-creation and 22,363 cache-read tokens, at
 * $0.0389. The bill is a near-fixed overhead of the headless session, so a character heuristic
 * over the transcript would have been wrong by orders of magnitude rather than merely imprecise.
 *
 * @param {string} raw
 * @returns {{ text: string, isError: boolean, usage: Record<string, number> | null } | null}
 */
export function parseEnvelope(raw) {
  // First brace to last, exactly as extractJson does, so a warning line printed before the envelope
  // does not hide it. Without this a prefixed envelope lost its cost figure AND handed the raw
  // envelope object back as "insights" — junk that only writeNotes' shape check discarded, having
  // first suppressed the retry by looking non-empty.
  const text = String(raw ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  let env;
  try {
    env = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  // `result` must be a STRING. The model's own answer is JSON too, so a bare object here is much
  // more likely to be the answer itself than an envelope, and treating it as one would hand the
  // brace extractor an empty string.
  if (!env || typeof env !== 'object' || typeof env.result !== 'string') return null;

  const u = env.usage;
  /** @type {Record<string, number>} */
  const usage = {};
  const put = (/** @type {string} */ k, /** @type {unknown} */ v) => {
    if (typeof v === 'number' && Number.isFinite(v)) usage[k] = v;
  };
  put('inTok', u?.input_tokens);
  put('cacheWriteTok', u?.cache_creation_input_tokens);
  put('cacheReadTok', u?.cache_read_input_tokens);
  put('outTok', u?.output_tokens);
  put('usd', env.total_cost_usd);
  // `is_error` is the CLI saying the run failed while still exiting 0 and still billing for it.
  // Reported so the cost line can say `error`: the money is real, the insights are not, and folding
  // it into the average of successful extractions would flatter both numbers.
  return {
    text: env.result,
    isError: env.is_error === true,
    usage: Object.keys(usage).length ? usage : null,
  };
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

// findClaude lives in hook-io.mjs: graph-staleness-check probes the same locations, and while one
// list was here and the other was in bash they drifted without anything noticing.

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
 * Run the headless extractor, and record what it cost.
 *
 * `--output-format json` is asked for so the usage figures exist at all; the model's own answer is
 * then the envelope's `result` string, which the same brace extractor reads as before. An envelope
 * that does not parse falls back to reading raw stdout — the insights are the point, the cost line
 * is not, and a CLI that stops wrapping its output must not cost a night's distillation.
 *
 * The usage is logged as its OWN line (`event: 'extract'`) rather than being folded into the worker
 * line the entry writes on exit. The two measure two different things: the worker line is the whole
 * background run — extraction, note writing and the re-index after it — while this one is the single
 * API call inside it, which is the only part that costs money. A run that never reaches the call —
 * no CLI, a throw, a dry run — writes no line at all, so a cost field is never a zero standing in
 * for "not measured".
 *
 * @param {string} convo
 * @param {string} [cwd]
 * @param {string} [session] defaults to MEMORY_HOOK_SESSION, which the gate exports, so this line
 *   and the worker line around it read as one background run
 * @returns {Insights}
 */
function runExtractor(convo, cwd, session = process.env.MEMORY_HOOK_SESSION) {
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

  /**
   * Read one attempt's stdout: log what it cost, and hand back the insights in it.
   *
   * Called for a FAILED attempt too, and deliberately. A `--output-format json` run that hits an
   * execution error still prints its whole envelope, usage and dollars included, and then exits
   * non-zero — `execFileSync` throws with that envelope sitting on `e.stdout`. Discarding it meant
   * the report under-reported the bill by exactly the runs that failed, which are the ones anyone
   * would most want to find.
   *
   * @param {string} out
   * @param {boolean} failed
   * @returns {Insights}
   */
  const readAttempt = (out, failed) => {
    const envelope = parseEnvelope(out);
    if (envelope?.usage)
      logHook({
        hook: 'distill-session',
        event: 'extract',
        cwd,
        session,
        // The money was spent either way, so the line is written either way — but an envelope that
        // says `is_error`, or an attempt that threw, is not a run that produced insights, and
        // `ran` beside a cost would fold it into the average of the ones that did.
        outcome: failed || envelope.isError ? 'error' : 'ran',
        extra: envelope.usage,
      });
    return extractJson(envelope ? envelope.text : out);
  };

  const args = ['-p', '--model', 'haiku'];
  try {
    return readAttempt(
      execFileSync(claude, [...args, '--output-format', 'json'], {
        input: EXTRACT_PROMPT + convo,
        encoding: 'utf8',
        timeout: 150_000,
        maxBuffer: 16 * 1024 * 1024,
        // Never the target project's cwd: it can vanish out from under a detached worker
        // (a worktree torn down mid-run by an external tool) and the CLI refuses to even
        // start in a missing directory. The extractor only reads stdin, so any real
        // directory does.
        cwd: os.tmpdir(),
        env: { ...process.env, CLAUDE_DISTILL_CHILD: '1' }, // guard against recursive Stop hook
      }),
      false,
    );
  } catch (e) {
    const err =
      /** @type {NodeJS.ErrnoException & { stdout?: string, stderr?: string, signal?: string }} */ (
        e
      );
    console.error(`distill: extractor failed: ${err.message}`);

    // Whatever it managed to print, first: an envelope on a non-zero exit carries both the cost and
    // the answer, and even plain text may hold the JSON.
    const out = String(err.stdout ?? '');
    const envelope = parseEnvelope(out);
    const salvaged = readAttempt(out, true);
    if (Object.keys(salvaged).length) return salvaged;

    // Retry gate: refires WITHOUT --output-format only when the first attempt produced neither a
    // parsed envelope nor `total_cost_usd` anywhere in stdout/stderr — either one proves the CLI
    // understood the flag, so retrying it would silently double-bill an already-billed call.
    // Rationale + stub reproductions: docs/architecture.md "Known hacks".
    const billed =
      envelope || /total_cost_usd/.test(out) || /total_cost_usd/.test(String(err.stderr ?? ''));
    if (billed) return {};
    if (err.code === 'ETIMEDOUT' || err.signal) return {};
    try {
      console.error('distill: retrying without --output-format (no cost figure for this run)');
      return extractJson(
        execFileSync(claude, args, {
          input: EXTRACT_PROMPT + convo,
          encoding: 'utf8',
          timeout: 150_000,
          maxBuffer: 16 * 1024 * 1024,
          cwd: os.tmpdir(),
          env: { ...process.env, CLAUDE_DISTILL_CHILD: '1' },
        }),
      );
    } catch (e2) {
      console.error(`distill: retry failed: ${/** @type {NodeJS.ErrnoException} */ (e2).message}`);
      return {};
    }
  }
}

// ---------------------------------------------------------------- reconcile client

// How long a distillation waits for a cold search server. The recall hook allows 700ms because a
// human is waiting on the prompt; nothing waits on this one — it is detached at SessionEnd and has
// already spent tens of seconds in a headless `claude` call. Falling through immediately would mean
// the first distillation after a reboot dedups at its worst, on the machine most likely to be
// restating old lessons.
const SERVER_WAIT_MS = 60_000;
const SERVER_POLL_MS = 1_000;
const SERVER_REQ_MS = 10_000;

/**
 * One dupe-mode request. Resolves null on any failure — an unanswered reconcile degrades to the
 * slug arm, it never fails a distillation.
 *
 * @param {string} sockPath
 * @param {object} req
 * @returns {Promise<any>}
 */
function dupeRequest(sockPath, req) {
  return new Promise((resolve) => {
    const c = net.createConnection(sockPath);
    const done = (/** @type {any} */ v) => {
      clearTimeout(timer);
      try {
        c.destroy();
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done(null), SERVER_REQ_MS);
    let buf = '';
    c.on('connect', () => c.write(JSON.stringify(req) + '\n'));
    c.on('data', (d) => {
      buf += d;
    });
    c.on('end', () => {
      try {
        done(JSON.parse(buf));
      } catch {
        done(null);
      }
    });
    c.on('error', () => done(null));
  });
}

/**
 * Asks the resident search server for the nearest same-layer note to a candidate card.
 *
 * The reply MUST carry `mode: 'dupe'`. An older server does not error on this request — it
 * destructures a missing `q`, embeds the literal string "undefined", and answers with five
 * confident results. Servers are keyed by MODEL rather than by version, so an old one running the
 * active model is never evicted and a new distiller meets one after every update. Without the
 * marker that reply would be read as a verdict.
 *
 * @param {string} cwd
 * @param {string} slug
 * @returns {(req: object) => Promise<any>}
 */
export function dupeClient(cwd, slug) {
  /** @type {string | null} */
  let sockPath = null;
  let spawned = false;
  let dead = false;
  return async (req) => {
    if (dead) return null;
    if (!sockPath) {
      try {
        const { MODEL_KEY } = await import('../../scripts/lib/memory-semantic.mjs');
        // No index for this project means nothing to compare against, and spawning a server to
        // load a database that does not exist would buy a minute of waiting for a guaranteed null.
        // This is also what keeps a test vault off the server: the fixtures have no index.
        const db = path.join(paths.stateDir('db'), `semantic-${slug}-${MODEL_KEY}.db`);
        if (!fs.existsSync(db)) {
          dead = true;
          return null;
        }
        sockPath = path.join(paths.stateDir('run'), `search-${MODEL_KEY}.sock`);
      } catch {
        dead = true;
        return null;
      }
    }
    // WALL CLOCK, not a poll count. Counting iterations looked equivalent and was not: a server
    // that accepts the connection and then stalls costs SERVER_REQ_MS per iteration, so sixty
    // "one second" polls were up to eleven minutes of a SessionEnd hanging on a socket.
    const deadline = Date.now() + SERVER_WAIT_MS;
    for (;;) {
      if (fs.existsSync(sockPath)) {
        const r = await dupeRequest(sockPath, req);
        if (r?.mode === 'dupe') return r;
        // A reply we could parse, from a server that does not speak dupe mode: that is an older
        // server, and it will not learn. Waiting out the deadline changes nothing — the server we
        // spawn below probes the live socket and exits rather than stealing it, and the old one
        // survives until its own idle timeout. Give up now and let the slug arm answer.
        if (r) {
          dead = true;
          return null;
        }
      }
      if (!spawned) {
        spawned = true;
        detach(process.execPath, [path.join(paths.scriptsDir, 'memory-semantic.mjs'), '--serve'], {
          cwd,
        });
      }
      if (Date.now() >= deadline) {
        // One slow start is one slow start; a second note should not pay another minute for it.
        dead = true;
        return null;
      }
      await new Promise((r) => setTimeout(r, SERVER_POLL_MS));
    }
  };
}

// ---------------------------------------------------------------- notes

/**
 * @param {Insights} insights
 * @param {string} slug
 * @param {string} cwd
 * @returns {Promise<{ written: number, merged: number, declined: number, notes: WrittenNote[] }>}
 */
async function writeNotes(insights, slug, cwd) {
  const today = todayStr();
  const base = path.join(VAULT, 'Insights', slug);
  let declined = 0;
  /** @type {WrittenNote[]} */
  const notes = [];

  const ask = dupeClient(cwd, slug);
  // Notes written earlier in THIS run are invisible to the (stale) index — closes the same-run
  // dupe gap; see docs/decisions/2026-08-23-embedding-reconcile.md "Same-run comparison".
  /** @type {{ note: string, layer: string, vec: number[], file: string }[]} */
  const thisRun = [];
  /** @type {any} */
  let sem = null;
  try {
    sem = await import('../../scripts/lib/memory-semantic.mjs');
  } catch {
    /* no index stack: slug arm only */
  }

  /**
   * @param {string} folder
   * @param {string} tag
   * @param {string} title
   * @param {string} body
   * @param {unknown} aliases
   */
  const emit = async (folder, tag, title, body, aliases) => {
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
    const text = line ? `${body.replace(/\s+$/, '')}\n\n_Also asked as: ${line}._\n` : body;
    // YAML-safe: quote the title so colons/quotes in it don't break frontmatter
    const safeTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const fm = `---\ntitle: "${safeTitle}"\ndate: ${today}\nproject: ${slug}\ntags: [${tag}]\ntype: insight\n---\n\n`;
    const name = `${today}-${sl}`;
    const raw = fm + text;

    // The candidate is the note's CARD, built by the SAME chunker the indexer uses. Hand-rolling an
    // approximation here would make the write-time score and the --dupes audit two different
    // quantities, and the audit is this check's acceptance test.
    const card = sem ? sem.chunkNote(name, raw)[0]?.text : null;

    // Reconcile before appending: a restatement of an existing lesson updates that note rather
    // than spawning a near-duplicate. Without this the distiller keeps re-creating notes
    // /memory:prune has just merged away.
    /** @type {{ file: string, s: number } | null} */
    let hit = null;
    /** @type {number[] | null} */
    let vec = null;
    if (card) {
      const r = await ask({ dupe: card, slug, layer: folder, min: sem.PROFILE.dupeMin });
      if (r) {
        vec = r.vec ?? null;
        // The index is a snapshot: a note merged or renamed by /memory:prune since the last
        // --index is still in it. reconcile() reads the file with no guard, so an unchecked hit
        // here throws ENOENT and takes the whole distillation with it — and hooks never fail a
        // session. Before this change every candidate came from readdirSync and existed by
        // construction.
        const best = r.best ? path.join(d, `${r.best.note}.md`) : null;
        if (best && fs.existsSync(best)) hit = { file: best, s: r.best.s };
        const inRun = vec && sem.bestDupe(thisRun, { layer: folder, vec }, sem.PROFILE.dupeMin);
        if (inRun && (!hit || inRun.s > hit.s)) {
          const f = thisRun.find((x) => x.note === inRun.note);
          if (f) hit = { file: f.file, s: inRun.s };
        }
      }
    }
    // Server silent: the slug arm is the whole dedup. It is the fallback, not a second opinion —
    // when the embedding arm HAS answered, its verdict stands, because a lexical arm overruling it
    // is exactly the false merge the good arm just declined.
    if (!vec) {
      const dup = findNearDuplicate(d, sl);
      if (dup) hit = { file: dup, s: 1 };
    }

    if (hit) {
      // `reconcile: manual` blocks BOTH arms. A half-blocked mark is indistinguishable from a
      // broken one, and the counter is here because a mark that silently does nothing when
      // misconfigured looks exactly like a mark that is working.
      if (isManual(hit.file)) {
        declined++;
      } else {
        reconcile(hit.file, title, body, line, today);
        notes.push({ file: hit.file, title, action: 'merged' });
        return;
      }
    }

    const file = path.join(d, `${name}.md`);
    fs.writeFileSync(file, raw);
    if (vec) thisRun.push({ note: name, layer: folder, vec, file });
    notes.push({ file, title, action: 'written' });
  };

  for (const it of insights.patterns || []) {
    if (it?.title)
      await emit(
        'Patterns',
        'pattern',
        it.title,
        `## ${it.title}\n\n${it.description ?? ''}\n`,
        it.aliases,
      );
  }
  for (const it of insights.mistakes || []) {
    if (it?.title)
      await emit(
        'Mistakes',
        'mistake',
        it.title,
        `## ${it.title}\n\n**Error:** ${it.error ?? ''}\n\n**Fix:** ${it.fix ?? ''}\n`,
        it.aliases,
      );
  }
  for (const it of insights.decisions || []) {
    if (it?.title)
      await emit(
        'Decisions',
        'decision',
        it.title,
        `## ${it.title}\n\n**Decision:** ${it.decision ?? ''}\n\n**Why:** ${it.why ?? ''}\n`,
        it.aliases,
      );
  }
  const written = notes.filter((n) => n.action === 'written').length;
  const merged = notes.filter((n) => n.action === 'merged').length;
  return { written, merged, declined, notes };
}

/** 10s: local, fast git operations — the bound exists only to stop a stale index.lock or a gpg
 *  pinentry prompt (commit.gpgsign, on the vault's ambient identity) from hanging the detached
 *  distill worker forever and skipping reindex() right after it. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Commit, in one commit, exactly the notes this run wrote or merged — never `git add -A`. A
 * human may hand-edit files elsewhere in the same vault repo; a blanket add would ship that by
 * accident, which is the one thing this function exists to avoid.
 *
 * Off unless explicitly armed (paths.gitAutoCommitEnabled()), and any failure — git missing, the
 * vault not a git work tree, no git identity configured, nothing to commit — degrades to a
 * silent no-op, exactly like every other hook here. A session must never fail because of this.
 *
 * @param {WrittenNote[]} notes
 * @param {number} merged count of `notes` merged into an existing file — writeNotes() already
 *   computed this from the same partition; re-filtering here would just be a second copy of it
 * @param {string} slug
 * @returns {void}
 */
function autoCommit(notes, merged, slug) {
  if (!paths.gitAutoCommitEnabled() || notes.length === 0) return;
  const opts = { stdio: /** @type {const} */ ('ignore'), timeout: GIT_TIMEOUT_MS };
  /** @type {string[] | undefined} */
  let rel;
  try {
    // The vault itself must be the repo ROOT, not merely nested inside one. `rev-parse
    // --is-inside-work-tree` would say yes for a vault sitting anywhere under an unrelated
    // ambient repo (a whole-home dotfiles checkout, say) — fine for doctor.sh's informational
    // "any depth" report, but committing here would silently write private note content into
    // THAT repo's history, where the user's own workflow for it could push it: the exact leak
    // "never pushes" is meant to prevent, just one hop removed.
    const top = execFileSync('git', ['-C', VAULT, 'rev-parse', '--show-toplevel'], {
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
    }).trim();
    if (fs.realpathSync(top) !== fs.realpathSync(VAULT)) return;
    rel = notes.map((n) => path.relative(VAULT, n.file));
    execFileSync('git', ['-C', VAULT, 'add', '--', ...rel], { ...opts, cwd: VAULT });
    const writtenTitles = notes.filter((n) => n.action === 'written').map((n) => n.title);
    const msg =
      `distill(${slug}): wrote ${writtenTitles.length} note(s)` +
      (writtenTitles.length ? ` — ${writtenTitles.join(', ')}` : '') +
      (merged ? `; merged ${merged} into existing` : '');
    execFileSync('git', ['-C', VAULT, 'commit', '-q', '-m', msg], opts);
  } catch {
    // `add` may have already staged `rel` before `commit` failed (no identity, a pre-commit
    // hook, an index.lock) — leaving that behind is not the no-op this degrades to everywhere
    // else: it persists across every future SessionEnd, and once identity/whatever IS fixed, the
    // next successful commit's message (built from THAT run's notes only) would understate what
    // the diff actually contains. Best-effort unstage; guarded so a failure here can't escape.
    if (rel) {
      try {
        execFileSync('git', ['-C', VAULT, 'reset', '--', ...rel], { ...opts, cwd: VAULT });
      } catch {
        /* nothing more this can do */
      }
    }
  }
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
  // Pin the storage root: don't trust context-mode's own platform auto-detection (#108).
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const cmEnv = {
    ...process.env,
    CONTEXT_MODE_DIR: process.env.CONTEXT_MODE_DIR || path.join(claudeHome, 'context-mode'),
  };
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
  // INVARIANT: label and indexed directory must derive from the same `slug` (label == indexed
  // directory, NOT label == projectKey(cwd)) — `slug` falls back to `legacyKey` when the vault has
  // not been migrated yet, and legacyKey is a raw cwd slug that can carry uppercase. Regressed
  // once when the label used path.basename(cwd) instead: docs/architecture.md Known hacks H7.
  for (const layer of ['Insights', 'Memory', 'Logs', 'Graph']) {
    const label = `vault-${layer.toLowerCase()}-${slug}`;
    const d = path.join(VAULT, layer, slug);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
    try {
      execFileSync(cm, ['index', d, '--project', cwd, '--source', label], {
        encoding: 'utf8',
        timeout: 120_000,
        stdio: 'pipe',
        env: cmEnv,
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
        env: cmEnv,
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
 * @returns {Promise<{ written: number, merged: number, declined: number, slug: string } | null>}
 */
export async function distill(transcript, cwd) {
  // Both checked before anything is read or written: a write whose scope can't be resolved must
  // write nothing, not a partial note under a guessed vault or project.
  if (!cwd) throw new Error('distill: missing cwd — refusing to infer scope for a write');
  VAULT = process.env.DISTILL_VAULT || paths.requireVault();
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
  const insights = runExtractor(convo, cwd);
  const { written, merged, declined, notes } = await writeNotes(insights, slug, cwd);
  autoCommit(notes, merged, slug);
  // reindex unconditionally: Memory/Logs can change without new Insights (e.g. /remember, manual
  // note edits), and reindex() skips missing dirs.
  // ponytail: re-reads dirs every session end; append-only so deletions still need
  // /memory:prune's purge — the distiller only keeps additions fresh.
  reindex(cwd, slug);
  return { written, merged, declined, slug };
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
  stopShort: 'stop: session too short',
  trivial: 'trivial session',
  notAFile: 'transcript not a file',
  noTranscript: 'no transcript path',
  badTranscript: 'transcript missing',
  noCwd: 'no cwd',
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
  // Same shape as a missing transcript: the payload is this hook's only source of scope, and
  // spawning the worker with a guessed cwd would write into whatever project happens to be
  // current rather than the one the session ran in. requireHookCwd() is the write-path check;
  // the gate itself still never blocks, it only declines to spawn.
  try {
    requireHookCwd(p);
  } catch {
    return { run: false, reason: GATE_REASONS.noCwd };
  }

  const transcript = p?.transcript_path;
  if (!transcript) return { run: false, reason: GATE_REASONS.noTranscript };
  try {
    if (!fs.statSync(transcript).isFile()) return { run: false, reason: GATE_REASONS.notAFile };
  } catch {
    return { run: false, reason: GATE_REASONS.badTranscript };
  }

  const lines = countLines(transcript);
  if (lines < MIN_MESSAGES) return { run: false, reason: GATE_REASONS.trivial, lines };

  const sid = p?.session_id || 'nosession';
  const marker = markerPath(`distill-${sid}`);

  if (p?.hook_event_name !== 'SessionEnd') {
    if (lines < STOP_MIN_MESSAGES) return { run: false, reason: GATE_REASONS.stopShort, lines };
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
  // gatePlan already refused to run without a cwd, so this never throws in practice.
  const cwd = requireHookCwd(p);
  const pid = detach(
    process.execPath,
    [path.join(paths.hooksDir, 'distill-session.mjs'), plan.transcript, cwd],
    {
      cwd,
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
 * are the same story: the hook fired inside work it had itself started.
 *
 * Every value in GATE_REASONS is mapped, and a test proves gatePlan can emit nothing else — so the
 * trailing `ran` is unreachable for a skip today. It is the default for a reason ADDED without a
 * mapping here, which is precisely the drift that shipped once already; treat landing on it as the
 * bug, not as the intended behaviour of a new branch.
 *
 * @param {GatePlan} plan
 * @returns {import('./hook-io.mjs').HookOutcome}
 */
export function gateOutcome(plan) {
  // `spawned` is set by the acting wrapper from detach()'s pid. Absent means nobody acted, and the
  // loud reading is the right default: a false `error` is a question, a false `spawned` is the
  // silent lie this log exists to end.
  if (plan.run) return plan.spawned ? 'spawned' : 'error';
  if (plan.reason === GATE_REASONS.child || plan.reason === GATE_REASONS.stopActive)
    return 'child-guard';
  // Every stand-down on a line count or a timer is `debounced`. They fire on nearly every assistant
  // turn, and as `ran` — "did its work" — they made the busiest hook in the log look like the most
  // productive one while burying the SessionEnd run that does the work.
  if (
    plan.reason === GATE_REASONS.debounced ||
    plan.reason === GATE_REASONS.stopShort ||
    plan.reason === GATE_REASONS.trivial
  )
    return 'debounced';
  // A transcript that is absent or unreadable is this hook's missing dependency: Claude Code hands
  // it the path, and if that stops arriving the distiller is permanently dead while exiting 0 and
  // printing nothing. Reporting it as `ran` would hide exactly the outage worth seeing.
  if (
    plan.reason === GATE_REASONS.noTranscript ||
    plan.reason === GATE_REASONS.badTranscript ||
    plan.reason === GATE_REASONS.notAFile ||
    plan.reason === GATE_REASONS.noCwd
  )
    return 'noop-missing-dep';
  return 'ran';
}
