#!/usr/bin/env node
// Logic half; the CLI entry is scripts/prose-guard.mjs.
//
// Comments may not outnumber code in a file a change touches; CI fails at 1.00, warns at 0.75. Why
// a ceiling at all, why it is a ratchet over the files already above it, and the measurement
// scanner built and deleted before it: docs/decisions/2026-09-05-prose-ceiling.md.

export const CEILING = 1.0;
// A band below the ceiling, so a file arrives at 1.00 announced rather than by surprise. Warning
// only: the whole repo sits above it today.
export const WARN = 0.75;

/**
 * @param {string} text
 * @returns {{ comment: number, code: number, ratio: number }}
 */
export function commentRatio(text) {
  let comment = 0,
    code = 0;
  for (const l of text.split('\n')) {
    const t = l.trim();
    if (!t) continue;
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) comment++;
    else code++;
  }
  return { comment, code, ratio: code ? comment / code : 0 };
}

/**
 * Comment and code lines a unified diff ADDS. Counted from the diff rather than from the files,
 * because a change that adds 200 comment lines to a file already at 1.2 barely moves the ratio, and
 * the 200 lines are the thing worth seeing.
 *
 * @param {string} diff `git diff -U0` output
 * @returns {{ comment: number, code: number }}
 */
export function addedLines(diff) {
  let comment = 0,
    code = 0;
  for (const l of diff.split('\n')) {
    if (!l.startsWith('+') || l.startsWith('+++')) continue;
    const t = l.slice(1).trim();
    if (!t) continue;
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) comment++;
    else code++;
  }
  return { comment, code };
}

/**
 * Files above a threshold, worst first. `.test.mjs` is exempt: a test's comment is the failure it
 * pins, which is the one place restating the code earns its keep.
 *
 * @param {readonly { file: string, text: string }[]} files
 * @param {number} [threshold]
 * @returns {{ file: string, ratio: number }[]}
 */
export function above(files, threshold = CEILING) {
  return files
    .filter((f) => !f.file.endsWith('.test.mjs'))
    .map((f) => ({ file: f.file, ratio: commentRatio(f.text).ratio }))
    .filter((f) => f.ratio > threshold)
    .sort((a, b) => b.ratio - a.ratio);
}
