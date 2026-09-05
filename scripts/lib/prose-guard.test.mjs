// Tests for scripts/lib/prose-guard.mjs. Run: node --test scripts/lib/prose-guard.test.mjs
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { commentRatio, addedLines, overCeiling, CEILING } from './prose-guard.mjs';

test('commentRatio ignores blank lines, counts both comment styles', () => {
  const r = commentRatio('// one\n/* two */\n * three\nconst a = 1;\n\n  \nconst b = 2;\n');
  assert.equal(r.comment, 3);
  assert.equal(r.code, 2);
  assert.equal(r.ratio, 1.5);
});

test('commentRatio does not divide by zero on a comment-only file', () => {
  assert.equal(commentRatio('// just a header\n').ratio, 0);
});

test('addedLines counts only additions, and not the +++ header', () => {
  const diff = [
    '--- a/x.mjs',
    '+++ b/x.mjs',
    '@@ -1,0 +1,4 @@',
    '+// a comment',
    '+ * a jsdoc line',
    '+const a = 1;',
    '+',
    '-const gone = 2;',
    ' const context = 3;',
  ].join('\n');
  const a = addedLines(diff);
  // `+++ b/x.mjs` starts with `+` and is a header, not a line of code — counting it was the bug
  // this pins. The blank addition and the removal and the context line are all excluded too.
  assert.deepEqual(a, { comment: 2, code: 1 });
});

test('overCeiling fails a file where comments outnumber code, and only that file', () => {
  const over = { file: 'a.mjs', text: '// one\n// two\nconst a = 1;\n' };
  const at = { file: 'b.mjs', text: '// one\nconst a = 1;\n' };
  const under = { file: 'c.mjs', text: '// one\nconst a = 1;\nconst b = 2;\n' };
  assert.deepEqual(
    overCeiling([over, at, under]).map((f) => f.file),
    ['a.mjs'],
  );
  // Exactly at the ceiling passes: the rule is "not MORE than code".
  assert.equal(CEILING, 1.0);
});

test('overCeiling exempts tests, where a comment names the failure it pins', () => {
  const t = { file: 'a.test.mjs', text: '// one\n// two\n// three\nconst a = 1;\n' };
  assert.deepEqual(overCeiling([t]), []);
});
