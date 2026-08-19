/**
 * Extract the review instructions out of `.github/workflows/claude-review.yml`.
 *
 * The prompt lives inline in the workflow and MUST stay there. `claude-code-action` refuses to run
 * unless the workflow file invoking it is byte-identical to the copy on the default branch — a
 * server-side check, scoped to that one file (`workflow_not_found_on_default_branch`). Moving the
 * prompt to its own file would leave the `.yml` identical while the instructions changed, so a PR
 * could be reviewed under rules it had just rewritten. Verified against the action's inputs on
 * 2026-08-19: there is no `prompt_file` input either, so the alternative was an env var, which
 * would have bought the regression for nothing.
 *
 * Inline is therefore the source of truth, and this reads it back out so the same instructions can
 * be applied locally before pushing — the reviewer that gates the PR is the one worth running early.
 * It is also the only review a PR editing `claude-review.yml` can get: the action skips those and
 * exits SUCCESS, so the check goes green having read nothing.
 *
 * A hand-rolled block-scalar reader rather than a YAML dependency: one `prompt: |` key, and every
 * dependency ships into a user's version-pinned plugin cache.
 */

/** Indentation width of a line, or null for a blank one (blanks never close a block scalar). */
function indentOf(line) {
  if (line.trim() === '') return null;
  return line.length - line.trimStart().length;
}

/**
 * Pull the value of a `<key>: |` block scalar out of YAML text.
 *
 * Returns the dedented body, or null when the key is absent — null rather than a throw, because
 * every caller wants to say something better than a stack trace about a workflow it could not read.
 */
export function extractBlockScalar(yaml, key) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*${key}:\\s*\\|`).test(l));
  if (start === -1) return null;

  const keyIndent = indentOf(lines[start]);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    const ind = indentOf(line);
    // A blank line inside a block scalar is content, not a terminator; anything at or left of the
    // key's own indentation ends it. `claude_args: |` sits directly after `prompt: |` in the real
    // workflow, which is exactly this case.
    if (ind !== null && ind <= keyIndent) break;
    body.push(line);
  }

  while (body.length && body[body.length - 1].trim() === '') body.pop();
  if (!body.length) return null;

  const margin = Math.min(...body.filter((l) => l.trim() !== '').map(indentOf));
  return body.map((l) => l.slice(margin)).join('\n');
}

/** The review instructions, given the text of `claude-review.yml`. */
export function reviewPrompt(workflowYaml) {
  return extractBlockScalar(workflowYaml, 'prompt');
}
