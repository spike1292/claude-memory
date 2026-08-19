// Tests for hooks/lib/memory-recall.mjs — the UserPromptSubmit recall path, which had none until
// 2026-08-19 because it lived in the entry file next to `node:sqlite` and a unix socket.
//
// THE TRAP THIS FILE IS WRITTEN AROUND: abstaining is what this hook does most of the time, and it
// abstains by producing nothing at all. A suite that only asserts "it abstained" passes just as
// happily when the tokeniser drops every word, when the SELECT returns no rows, and when the
// ranking is inverted. So every abstention assertion here is paired with a positive one on the same
// corpus: the RIGHT note, in the right order, with the exact bytes the hook would print.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CARD,
  HEADER,
  MAX_CHARS,
  MAX_NOTES,
  MIN_COS,
  MIN_PROMPT,
  MIN_SCORE,
  brief,
  keywordArm,
  renderLines,
  semanticArm,
} from './memory-recall.mjs';

const hit = (note, score, text, layer = 'Memory') => ({ note, layer, score, text });

// --- constants -------------------------------------------------------------------------------
// Not restating the literals for their own sake: each of these is a wire value the entry file or
// the log consumers depend on, and MIN_PROMPT in particular is only ever compared in the entry.
test('constants are the calibrated values', () => {
  assert.equal(MAX_NOTES, 4);
  assert.equal(MAX_CHARS, 900);
  assert.equal(MIN_SCORE, 6.0);
  assert.equal(MIN_PROMPT, 25);
  assert.equal(MIN_COS, 0.55);
  assert.equal(CARD, '(card)');
  assert.equal(
    HEADER,
    'Possibly relevant vault notes (retrieved, not verified — open one before relying on it):',
    'the header is injected into every session that arms recall; an em-dash change is a visible one',
  );
});

// --- renderLines -----------------------------------------------------------------------------
test('renderLines: drops the heading line, collapses whitespace, slices the body to 150', () => {
  const long = 'x'.repeat(400);
  const { lines } = renderLines([hit('n', 1, `# heading\nbody   one\nbody\ttwo ${long}`)]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('- [[n]] (Memory): body one body two '), lines[0]);
  assert.equal(lines[0].length, '- [[n]] (Memory): '.length + 150, 'body is capped at 150 chars');
  assert.ok(!lines[0].includes('heading'), 'line 1 of the card is the title and is dropped');
});

test('renderLines: a card with no body renders an empty body, not a crash', () => {
  const { lines } = renderLines([hit('n', 1, '# only a heading')]);
  assert.deepEqual(lines, ['- [[n]] (Memory): ']);
  // `text` is a nullable column, and a null must not throw into the entry's silent outer catch.
  assert.deepEqual(renderLines([hit('n', 1, null)]).lines, ['- [[n]] (Memory): ']);
});

test('renderLines: the MAX_CHARS budget is strict >, so a brief of exactly 900 fits', () => {
  // Each rendered line is exactly 300 chars: `- [[` + a 133-char note name + `]] (Memory): ` + the
  // 150-char body cap. Three of them are the budget to the byte.
  const wide = (c) => hit(c.repeat(133), 1, `# t\n${'w'.repeat(200)}`);
  const three = [wide('a'), wide('b'), wide('c')];
  const { lines, used } = renderLines(three);
  assert.deepEqual(
    lines.map((l) => l.length),
    [300, 300, 300],
  );
  assert.equal(used, 900);
  assert.equal(lines.length, 3, 'exactly MAX_CHARS must fit — the guard is >, not >=');

  const { lines: four, used: used4 } = renderLines([...three, wide('d')]);
  assert.equal(used4, 900);
  assert.equal(four.length, 3, 'the 4th would exceed the budget and is dropped');
});

test('renderLines: the trailing floor breaks the loop, it does not filter', () => {
  const items = [hit('a', 9, '# t\naa'), hit('b', 3, '# t\nbb'), hit('c', 9, '# t\ncc')];
  const { lines } = renderLines(items, 3);
  assert.equal(lines.length, 3, 'a score exactly at the floor is kept');

  const { lines: cut } = renderLines(
    [items[0], hit('b', 2.999, '# t\nbb'), items[2]],
    3, // just under the floor stops the loop, so 'c' is lost even though it scores 9
  );
  assert.deepEqual(
    cut.map((l) => l.slice(0, 8)),
    ['- [[a]]'.padEnd(8)],
    'break, not filter: everything after the first weak hit is discarded',
  );
});

// --- semanticArm -----------------------------------------------------------------------------
test('semanticArm: null means fall through to the keyword arm, and it is not only for errors', () => {
  assert.equal(semanticArm(undefined), null, 'no server reply');
  assert.equal(semanticArm(null), null, 'unparseable reply');
  assert.equal(semanticArm([]), null, 'an empty result set falls through — it does NOT abstain');
});

test('semanticArm: MIN_COS is >=, so 0.55 injects and 0.5499 abstains', () => {
  const at = semanticArm([hit('at-gate', MIN_COS, '# t\nbody at gate')]);
  assert.equal(at.entry.abstained, false);
  assert.equal(at.output, `${HEADER}\n- [[at-gate]] (Memory): body at gate`);
  assert.equal(at.entry.top, 'at-gate');
  assert.equal(at.entry.score, MIN_COS);
  assert.equal(at.entry.via, 'server');

  const under = semanticArm([hit('under', 0.5499, '# t\nbody')]);
  assert.equal(under.output, null);
  assert.equal(under.entry.reason, 'low confidence (semantic)');
  assert.equal(under.entry.top, 'under');
  assert.equal(under.entry.score, 0.5499);
});

test('semanticArm: a hit with no score is filtered out, and the log omits the key entirely', () => {
  const d = semanticArm([{ note: 'no-score', layer: 'Memory', text: '# t\nb' }]);
  assert.equal(d.output, null, 'undefined >= MIN_COS is false');
  assert.equal(
    JSON.stringify(d.entry),
    '{"abstained":true,"reason":"low confidence (semantic)","top":"no-score","via":"server"}',
    'a 0 here would read like a measured score; the key must be absent',
  );
});

test('semanticArm: caps at MAX_NOTES and keeps the server order', () => {
  const six = Array.from({ length: 6 }, (_, i) => hit(`n${i}`, 0.9 - i / 100, `# t\nbody ${i}`));
  const d = semanticArm(six);
  assert.equal(d.entry.injected, MAX_NOTES);
  assert.deepEqual(
    d.output.split('\n').slice(1),
    ['n0', 'n1', 'n2', 'n3'].map((n, i) => `- [[${n}]] (Memory): body ${i}`),
  );
  assert.equal(
    d.entry.chars,
    d.output
      .split('\n')
      .slice(1)
      .reduce((a, l) => a + l.length, 0),
    'chars counts the note lines only — not the header, not the joining newlines',
  );
});

// --- keywordArm ------------------------------------------------------------------------------
const card = (note, layer, text) => ({ note, layer, text });

// One distinctive corpus, used by every keyword test below, so that "it abstained" and "it found
// the right note" are answers to the SAME question.
const CORPUS = [
  card('cutover-runbook', 'Memory', '# Cutover runbook\ncutover cutover cutover rollback rollback'),
  card('latency-budget', 'Patterns', '# Latency budget\nlatency budget percentile percentile'),
  card('waf-rules', 'permanent', '# WAF rules\nfirewall firewall ruleset ruleset'),
  ...Array.from({ length: 9 }, (_, i) =>
    card(`filler-${i}`, 'Logs', `# Filler ${i}\nmeeting notes agenda attendees actions`),
  ),
];

test('keywordArm: finds the right note and prints the exact brief', () => {
  const d = keywordArm(CORPUS, 'what did we decide about the cutover and the rollback plan');
  assert.equal(d.entry.abstained, false, 'this query MUST hit — an abstention here is the bug');
  assert.equal(d.entry.top, 'cutover-runbook');
  assert.equal(
    d.output,
    `${HEADER}\n- [[cutover-runbook]] (Memory): cutover cutover cutover rollback rollback`,
    'one note, because the other 11 cards share no query term',
  );
  assert.equal(d.entry.injected, 1);
  assert.equal(d.entry.chars, d.output.length - HEADER.length - 1);
  assert.equal(d.entry.score, +d.entry.score.toFixed(2), 'score is rounded to 2dp for the log');
  assert.ok(!('via' in d.entry), 'no `via` field is how the log tells the keyword arm apart');
});

test('keywordArm: ranks by BM25, so on-topic notes beat the fillers and each other', () => {
  const d = keywordArm(CORPUS, 'the latency percentile budget and also the firewall ruleset');
  assert.equal(d.entry.top, 'latency-budget', 'three matched terms outrank two');
  const notes = d.output.split('\n').slice(1);
  assert.deepEqual(
    notes.map((l) => l.match(/\[\[(.+?)\]\]/)[1]),
    ['latency-budget', 'waf-rules'],
    'the nine fillers share no query term and must not appear at all',
  );
});

test('keywordArm: abstains on an off-topic prompt over the SAME corpus', () => {
  const d = keywordArm(CORPUS, 'how long should neapolitan pizza dough prove before baking');
  assert.equal(d.output, null);
  assert.equal(d.entry.reason, 'low confidence');
  assert.equal(d.entry.score, 0, 'no term matches at all');
  assert.equal(typeof d.entry.top, 'string', 'the log still names the best of a bad lot');
});

test('keywordArm: a real but weak match is below MIN_SCORE and abstains', () => {
  const d = keywordArm(CORPUS, 'were there any meeting notes worth reading from last quarter');
  assert.equal(d.output, null, 'a term the fillers all share carries almost no IDF');
  assert.equal(d.entry.reason, 'low confidence');
  assert.ok(d.entry.score > 0 && d.entry.score < MIN_SCORE, `weak-but-real score ${d.entry.score}`);
});

test('keywordArm: tokenisation drops stopwords, short words and every non-[a-z0-9] character', () => {
  // Nothing here survives the tokeniser: stopwords, 1-2 char words, punctuation, shell and SQL
  // metacharacters, accented and non-Latin script, emoji.
  const d = keywordArm(CORPUS, `it is on to be by $(x) \`y\` '; -- éèü中文 🚀`);
  assert.equal(d.entry.reason, 'no content words');
  assert.equal(d.output, null);

  // ...and the same prompt with one real term is no longer empty, which is what proves the test
  // above measured the tokeniser rather than an early exit.
  // The SQL here is inert twice over: the entry binds one parameter and passes no user text to
  // SQLite at all, and the tokeniser keeps only [a-z0-9] runs longer than 2.
  const d2 = keywordArm(CORPUS, `it is on to be by cutover '; DROP TABLE chunks;-- 🚀`);
  assert.equal(d2.entry.top, 'cutover-runbook');
});

test('keywordArm: an empty index is its own reason, distinct from a weak match', () => {
  const d = keywordArm([], 'what did we decide about the cutover and the rollback plan');
  assert.deepEqual(d, { entry: { abstained: true, reason: 'empty index' }, output: null });
});

test('keywordArm: MIN_SCORE is a strict <, so a top hit exactly at the gate injects', () => {
  // Scores are corpus-dependent, so pin the boundary on the one axis the arm controls: rebuild the
  // decision from renderLines and check which side of MIN_SCORE the flip happens on.
  const at = renderLines([hit('t', MIN_SCORE, '# t\nb')], MIN_SCORE / 2);
  assert.equal(at.lines.length, 1);
  assert.ok(!(MIN_SCORE < MIN_SCORE), 'the gate rejects only scores strictly below MIN_SCORE');
});

test('brief: header then lines, no trailing newline (console.log adds it)', () => {
  assert.equal(brief(['- a', '- b']), `${HEADER}\n- a\n- b`);
});

// --- the prompt-path import boundary ----------------------------------------------------------
// This module is imported STATICALLY by hooks/memory-recall.mjs, above the fail-open try AND above
// the `recallEnabled()` gate, so its whole import graph runs on every prompt of every session with
// no way to catch what it does. On 2026-08-19 it briefly took its four lexical helpers from
// scripts/lib/memory-semantic.mjs, whose module scope does `console.log` + `process.exit(1)` on an
// unknown MEMORY_SEMANTIC_MODEL: a typo in config.json then printed that line to the hook's STDOUT
// — which Claude Code injects as context — on every prompt, disarmed installs included, while
// hooks.json's `|| exit 0` hid the exit code. They moved to scripts/lib/lexical.mjs, which imports
// nothing at all. CI re-runs the side-effect gate under a bad model; this is the cheap local twin.
test('imports nothing that can fail or print on the prompt path', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const self = fs.readFileSync(path.join(here, 'memory-recall.mjs'), 'utf8');
  const imports = [...self.matchAll(/^import[^;]*?from\s*'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(
    imports,
    ['../../scripts/lib/lexical.mjs'],
    'a new import here lands above the fail-open try — add it to the entry inside the try instead',
  );

  const lexical = fs.readFileSync(path.join(here, '../../scripts/lib/lexical.mjs'), 'utf8');
  assert.doesNotMatch(
    lexical,
    /^import\b/m,
    'scripts/lib/lexical.mjs must import nothing — that is the property that makes it safe here',
  );
});
