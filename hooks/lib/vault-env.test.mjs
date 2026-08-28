import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'vault-env.sh');

/**
 * Source vault-env.sh in `shell` and print MEMORY_ENV_DEGRADED.
 * @param {string} shell
 * @returns {string}
 */
function degradedUnder(shell) {
  return execFileSync(shell, ['-c', `. '${SCRIPT}'; printf '%s' "$MEMORY_ENV_DEGRADED"`], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_VAULT: '', CLAUDE_MEMORY_HOME: '' },
  }).trim();
}

/**
 * @param {string} shell
 * @returns {boolean}
 */
function have(shell) {
  try {
    execFileSync('command', ['-v', shell], { shell: '/bin/sh', stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The regression: locating scripts/env.mjs used BASH_SOURCE, which is bash-only.
// Under zsh it is unset, `dirname ""` is ".", env.mjs is never found, and the
// loader falls into DEGRADED — which ignores config.json and hands back
// ~/Documents/ClaudeVault plus a cwd-slug instead of the git-remote project key.
//
// This matters beyond hooks: every commands/*.md tells the agent to source this
// file, and an agent's shell may be zsh. A wrong vault there is silent.
test('resolves without degrading under bash', () => {
  assert.equal(degradedUnder('bash'), '0', 'bash: env.mjs was not reached');
});

test('resolves without degrading under zsh', (t) => {
  if (!have('zsh')) return t.skip('zsh not installed');
  assert.equal(degradedUnder('zsh'), '0', 'zsh: env.mjs was not reached — BASH_SOURCE regression');
});

test('both shells agree on the vault and the project key', (t) => {
  if (!have('zsh')) return t.skip('zsh not installed');
  const read = (/** @type {string} */ shell) =>
    execFileSync(
      shell,
      ['-c', `. '${SCRIPT}'; printf '%s\\n%s' "$(resolve_vault)" "$(project_key "$PWD")"`],
      {
        encoding: 'utf8',
        cwd: path.join(HERE, '..', '..'),
      },
    );
  assert.equal(read('zsh'), read('bash'), 'zsh and bash resolved differently');
});
