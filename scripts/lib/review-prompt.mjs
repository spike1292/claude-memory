/**
 * Extracts the review instructions out of `.github/workflows/claude-review.yml` — inline on purpose; see docs/ci-and-releases.md, "The review prompt stays inline in that file".
 */

/**
 * Indentation width of a line, or null for a blank one (blanks never close a block scalar).
 * @param {string} line
 * @returns {number | null}
 */
function indentOf(line) {
  if (line.trim() === '') return null;
  return line.length - line.trimStart().length;
}

/**
 * The review instructions: the dedented body of the workflow's `prompt: |` block scalar, or null if absent.
 * @param {string} yaml
 * @returns {string | null}
 */
export function reviewPrompt(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((/** @type {string} */ l) => /^\s*prompt:\s*\|/.test(l));
  if (start === -1) return null;

  const keyIndent = /** @type {number} */ (indentOf(lines[start]));
  /** @type {string[]} */
  const body = [];
  for (const line of lines.slice(start + 1)) {
    const ind = indentOf(line);
    // A blank line inside a block scalar is content, not a terminator — only a line at or left of
    // the key's own indentation (e.g. the `claude_args: |` sibling that follows) ends it.
    if (ind !== null && ind <= keyIndent) break;
    body.push(line);
  }

  while (body.length && body[body.length - 1].trim() === '') body.pop();
  if (!body.length) return null;

  const margin = Math.min(
    ...body.filter((l) => l.trim() !== '').map((l) => /** @type {number} */ (indentOf(l))),
  );
  return body.map((l) => l.slice(margin)).join('\n');
}
