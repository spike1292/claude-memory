// One resolved environment, rendered as shell assignments — the logic half.
// The CLI entry is scripts/env.mjs.
//
// Single implementation since 2026-08-18 (previously two implementations kept in step by hand,
// with paths.mjs forking bash for project_key) — docs/decisions/2026-08-18-single-resolver.md.

import {
  vault,
  vaultSource,
  memoryHome,
  projectKey,
  legacyKey,
  recallEnabled,
  logRetentionDays,
  config,
} from './paths.mjs';

/**
 * POSIX single-quote quoting: wrap in '…' and replace each ' with '\''.
 *
 * Not optional politeness. A vault path is user-supplied and lands inside `eval` on the shell side;
 * a bare $ or backtick would be expanded, and an unescaped quote would end the string and run
 * whatever followed. Single quotes suppress every expansion there is, and the four-character
 * escape is the only thing they cannot contain.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}

/** The variables shell callers read. Names are a contract with hooks/lib/vault-env.sh. */
export const VARS = [
  'MEMORY_ENV_VAULT',
  'MEMORY_ENV_VAULT_SOURCE',
  'MEMORY_ENV_HOME',
  'MEMORY_ENV_PROJECT_KEY',
  'MEMORY_ENV_LEGACY_KEY',
  'MEMORY_ENV_RECALL',
  'MEMORY_ENV_RECALL_CONFIG',
  'MEMORY_ENV_MODEL',
  'MEMORY_ENV_LOG_RETENTION_DAYS',
];

/**
 * Render a resolved environment as `NAME='value'` lines, safe to `eval`.
 *
 * @param {Record<string, string | undefined>} values
 * @returns {string}
 */
export function render(values) {
  return VARS.map((k) => `${k}=${shellQuote(values[k] ?? '')}`).join('\n') + '\n';
}

/**
 * Resolve everything a shell caller can ask for, in one pass.
 *
 * `projectKey` is the only field that can throw (it shells out to git); a directory that is not a
 * repo, or a git that is missing, must degrade to the legacy cwd-slug rather than fail the caller.
 * That is what the shell version did, and vault-memory-sync.sh depends on it: the legacy name is
 * also the pre-migration folder name, so a fallback lands on a folder the migration already knows.
 *
 * @param {string} dir
 * @returns {Record<string, string>}
 */
export function resolve(dir) {
  let key;
  try {
    key = projectKey(dir);
  } catch {
    key = legacyKey(dir);
  }
  const recallCfg = config().recall;
  return {
    MEMORY_ENV_VAULT: vault(),
    MEMORY_ENV_VAULT_SOURCE: vaultSource(),
    MEMORY_ENV_HOME: memoryHome(),
    MEMORY_ENV_PROJECT_KEY: key,
    MEMORY_ENV_LEGACY_KEY: legacyKey(dir),
    MEMORY_ENV_RECALL: recallEnabled() ? '1' : '0',
    MEMORY_ENV_RECALL_CONFIG: recallCfg === undefined ? '' : String(recallCfg),
    MEMORY_ENV_MODEL: config().model ?? '',
    MEMORY_ENV_LOG_RETENTION_DAYS: String(logRetentionDays()),
  };
}

/** @param {string} dir */
export const shellEnv = (dir) => render(resolve(dir));
