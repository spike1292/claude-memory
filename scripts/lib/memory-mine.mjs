#!/usr/bin/env node
// Candidate eval questions, mined from Claude Code transcripts. No entry twin: `--mine` is a mode of
// scripts/memory-eval.mjs, its only caller. Separate from memory-eval.mjs because it shares nothing
// with it — that file scores retrieval, this one parses an append log another program writes.
//
// Transcripts are the one source nobody could have fitted to a result: prompts typed months before
// any tuning run (#87). Under 15 chars is "ok", "do 1"; over 400 is a pasted log, a document rather
// than a question. The pool behind both bounds is dated once in
// docs/decisions/2026-08-24-eval-harness-design.md and grows with use, so re-run `--mine`.
export const MINE_MIN = 15;
export const MINE_MAX = 400;

// Plumbing, not speech: the harness threads tool results and reminders as user turns, and `Caveat:`
// is Claude Code's own resumed-session banner.
const MINE_NOISE = /Caveat:|tool_result|system-reminder/;

/**
 * A parsed record -> the human's prompt, or null. Split from the line form so the caller can count
 * TURNS without parsing twice; lines-as-turns overstates the pool by two orders of magnitude.
 * @param {any} o
 * @returns {string|null}
 */
function mineTurn(o) {
  const t = mineText(o);
  if (t.length < MINE_MIN || t.length > MINE_MAX) return null;
  // Leading character on purpose: `/memory:eval` is a harness instruction, "what does /memory:eval
  // do" is a question, and only the position tells them apart. `<` opens an injected payload.
  if (t.startsWith('/') || t.startsWith('<')) return null;
  if (MINE_NOISE.test(t)) return null;
  return t;
}

/**
 * The speech in a record, normalised, or '' when it carries none. Empty is what separates a HUMAN
 * turn from a tool result — both arrive as `type: user`, and counting tool results as turns
 * overstated the pool tenfold.
 * @param {any} o
 * @returns {string}
 */
function mineText(o) {
  const c = o.message?.content;
  // Content is a bare string on older transcripts and a content-block array on newer ones. Only
  // `text` blocks are speech; a `tool_result` block in the same array is the harness talking.
  const raw =
    typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c
            .filter((p) => p?.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join(' ')
        : '';
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * A human turn at all? The split makes the dropped count mean "a human said this and we rejected
 * it" rather than "this file has assistant records in it".
 * @param {any} o @returns {boolean}
 */
const isUserTurn = (o) => o?.type === 'user' && !o.isMeta && mineText(o) !== '';

/**
 * One JSONL line -> the human's prompt, or null. Null rather than a throw: an append log can be
 * truncated mid-write, and one bad tail line must not cost the rest of the file.
 * @param {string} line @returns {string|null}
 */
export function minePrompt(line) {
  const o = mineParse(line);
  return o && isUserTurn(o) ? mineTurn(o) : null;
}

/** @param {string} line @returns {any} */
function mineParse(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Fold transcript lines into a candidate set, deduplicating on the prompt text.
 *
 * `seen` is the caller's because deduplication has to span FOLDERS: the same sessions appear under
 * more than one cwd-slug when a home directory is renamed. Two such folders yield 142 candidates
 * each and 142 between them (2026-09-05), so a per-folder Set doubles the apparent pool.
 * @param {Iterable<string>} lines
 * @param {Set<string>} seen mutated
 * @returns {{ lines: number, turns: number, kept: number }}
 */
export function minePrompts(lines, seen) {
  let count = 0,
    turns = 0,
    kept = 0;
  for (const l of lines) {
    count++;
    const o = mineParse(l);
    if (!o || !isUserTurn(o)) continue;
    turns++;
    const q = mineTurn(o);
    if (!q || seen.has(q)) continue;
    seen.add(q);
    kept++;
  }
  return { lines: count, turns, kept };
}
