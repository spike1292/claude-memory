#!/usr/bin/env node
// Logic half; the CLI entry is scripts/memory-eval.mjs.
// Reproducible retrieval eval for the vault. Generates a versioned case set once, then scores any
// retrieval change against THE SAME cases.
//
// Why this exists: before it, every /memory:eval run hand-wrote a fresh set of questions. The
// numbers moved between runs (0.60 → 1.00 on 2026-08-14) but the question set moved too, so the
// comparison proved nothing — and the questions were written by someone who already knew the vault
// and knew what had just been fixed. Borrowed wholesale from obsidian-second-brain's harness, whose
// baseline states the rule plainly: **no retrieval change ships without before/after numbers on the
// same cases.**
//
// Usage:
//   node memory-eval.mjs --generate 40 [--style semantic|keyword] [--out <path>]
//   node memory-eval.mjs --run [--cases <path>] [--mode semantic|lexical] [--layer Memory] [--json]
//   node --test scripts/lib/memory-eval.test.mjs
//
// Cases live in ~/.claude/data/eval-cases-<slug>-<style>.jsonl and are GITIGNORED: they contain
// vault content. Regenerate only with --force; a changed case set invalidates every past number.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activeModel } from './model-default.mjs';
import * as paths from '../../hooks/lib/paths.mjs';

export const RECALL_KS = [1, 3, 5, 10];

// ---------------------------------------------------------------- pure helpers (self-tested)

export function titleTokens(stem) {
  return new Set(
    stem
      .toLowerCase()
      .replace(/^\d{4}-\d{2}-\d{2}-/, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );
}

// Strip everything that would leak the answer's own vocabulary or isn't prose: frontmatter,
// headings, code fences, wikilinks — and critically the `_Also asked as:` line, which is a list of
// queries the note was written to match. Generating a question from it would score our own aliases.
export function evalBody(raw) {
  let t = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/^_Also asked as:[\s\S]*$/m, ' ');
  t = t.replace(/^#{1,6} .*$/gm, ' ');
  t = t.replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, ' ');
  t = t.replace(/`[^`]*`/g, ' ');
  return t;
}

// A paraphrase question must not reuse the note's title words — that is the whole point of the
// semantic style; otherwise it degenerates into a keyword lookup and every channel scores well.
export function pickSentence(body, stem, style) {
  const tt = titleTokens(stem);
  const sents = body
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 40 && s.length <= 220 && /[a-z]/.test(s));
  if (!sents.length) return null;
  const score = (s) => {
    const toks = new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    );
    let overlap = 0;
    for (const w of toks) if (tt.has(w)) overlap++;
    return style === 'keyword' ? overlap : -overlap; // keyword wants the title words, semantic avoids them
  };
  return sents.sort((a, b) => score(b) - score(a) || b.length - a.length)[0];
}

export function metrics(perCase) {
  const n = perCase.length || 1;
  const recall = {};
  for (const k of RECALL_KS)
    recall[k] = perCase.filter((c) => c.rank > 0 && c.rank <= k).length / n;
  const mrr = perCase.reduce((a, c) => a + (c.rank ? 1 / c.rank : 0), 0) / n;
  return { recall, mrr };
}
