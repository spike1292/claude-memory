// Guard for the #124 shape: a hook writes to stdout, then calls process.exit() before the pipe
// drains. A caller reading through a pipe (a pager, `| head`, a slow terminal) can lose the tail
// of the write — see hooks/memory-recall.mjs's fix. The check is line-adjacency: the line right
// after a console.log call must not be a process.exit call. It is proven against a bad fixture
// below so a change that breaks the regex fails loudly instead of passing by matching nothing.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** @param {string} source */
function findViolations(source) {
  const lines = source.split('\n');
  const codeLines = lines
    .map((text, i) => ({ text, i }))
    .filter(({ text }) => text.trim() && !text.trim().startsWith('//'));
  /** @type {number[]} */
  const violations = [];
  for (let i = 0; i < codeLines.length - 1; i++) {
    if (/console\.log\(/.test(codeLines[i].text) && /process\.exit\(/.test(codeLines[i + 1].text)) {
      violations.push(codeLines[i].i + 1); // 1-indexed line number
    }
  }
  return violations;
}

test('findViolations flags the exact #124 shape', () => {
  const bad = `if (x) {\n  console.log(out);\n  process.exit(0);\n}`;
  assert.deepEqual(findViolations(bad), [2], 'guard must catch stdout immediately before exit');
});

test('no hook entry writes stdout then exits without draining', () => {
  const entries = fs
    .readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
  assert.ok(entries.length > 0, 'expected to find hook entry files to scan');
  for (const file of entries) {
    const source = fs.readFileSync(path.join(HOOKS_DIR, file), 'utf8');
    const violations = findViolations(source);
    assert.deepEqual(
      violations,
      [],
      `${file}: console.log immediately followed by process.exit at line(s) ${violations.join(', ')}`,
    );
  }
});
