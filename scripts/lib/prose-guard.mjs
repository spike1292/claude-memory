#!/usr/bin/env node
// Logic half; the CLI entry is scripts/prose-guard.mjs.
//
// A diff budget for prose. #87 ran three review rounds and each answered a finding by fixing the
// code AND writing a comment explaining what had been wrong, so the file went from 1.17 comment
// lines per code line to 1.42 before anyone noticed. This prints the number while the change is
// still open, for nothing.
//
// It REPORTS and does not fail. A threshold on comment length was declined with reasons in
// docs/decisions/2026-08-23-comment-reader-distance.md — it fires on the load-bearing blocks first,
// which are the only record of several silent failures. The enforcement is the reviewer and the
// cut-pass rule in CLAUDE.md; this is the cheap instrument that tells you to run one.
//
// A conflicting-measurement SCANNER was built here first and deleted: see the decision record. It
// scored 0 against the real drift it was written for.

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
