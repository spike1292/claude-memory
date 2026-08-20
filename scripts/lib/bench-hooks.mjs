// Hook startup cost — the logic half. The CLI entry is scripts/bench-hooks.mjs.
//
// Every hook in this plugin is a Node process, and every session event pays that process's whole
// startup: interpreter, imports, and whatever the hook does before it decides there is nothing to
// do. docs/decisions/2026-08-18-node-hooks.md measured three of them once, by hand, into a table
// that cannot be re-run. This makes the measurement repeatable.
//
// Two rules the measurement has to obey, both learned the hard way in this repo:
//
//   - NEVER the real vault. Hooks write markers and detach children, and vault-memory-sync moves
//     files. The fixture below is a temp vault plus a temp HOME and a temp CLAUDE_MEMORY_HOME, and
//     assertIsolated() refuses to run if any of the three points outside the scratch root.
//   - NEVER an empty vault. The shell link lint looked like a 74 ms hook in this repo, which has no
//     L1 notes, while taking 10.9 s on a 49-note project. Note count is an input, and a record
//     quoting a number from here states it.
//
// Every hook is measured on the path where it decides there is nothing to do — no detached
// indexer, no headless `claude`. That is the path a session pays on every event, and it is the only
// one that can be run 20 times in a row without doing 20 real re-indexes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** ms with one decimal — anything finer is below the noise of a process spawn. */
export const ms = (/** @type {number} */ n) => (Number.isFinite(n) ? n.toFixed(1) : '-');

/**
 * min / median / p90 / max over wall times.
 *
 * Median and not mean as the headline: one GC pause or one laptop thermal event moves a mean and
 * does not move a median, and n is small on purpose (a bench nobody runs is worth nothing).
 *
 * @param {number[]} samples
 */
export function stats(samples) {
  const xs = [...samples].sort((a, b) => a - b);
  if (!xs.length) return { n: 0, min: NaN, median: NaN, p90: NaN, max: NaN };
  const at = (/** @type {number} */ q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  const mid =
    xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  return { n: xs.length, min: xs[0], median: mid, p90: at(0.9), max: xs[xs.length - 1] };
}

/**
 * A markdown table, so a run can be pasted straight into a decision record.
 *
 * @param {{name: string, n: number, min: number, median: number, p90: number, max: number}[]} rows
 */
export function formatTable(rows) {
  const out = [
    '| what | n | min | median | p90 | max |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const r of rows)
    out.push(
      `| ${r.name} | ${r.n} | ${ms(r.min)} | ${ms(r.median)} | ${ms(r.p90)} | ${ms(r.max)} |`,
    );
  return out.join('\n');
}

/**
 * Refuse to bench against anything the user cares about.
 *
 * A hook run by this script writes debounce markers and can detach a child; pointed at the real
 * vault it would also be racing vault-memory-sync. The check is on the env the children get,
 * because that is what paths.mjs resolves from.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} root
 */
export function assertIsolated(env, root) {
  for (const k of ['HOME', 'CLAUDE_MEMORY_HOME', 'CLAUDE_VAULT']) {
    const v = env[k];
    if (!v) throw new Error(`bench-hooks: ${k} must be set to a scratch path`);
    if (!path.resolve(v).startsWith(path.resolve(root) + path.sep))
      throw new Error(`bench-hooks: ${k}=${v} is outside the scratch root ${root}`);
  }
  return true;
}

/**
 * @param {string} title
 * @param {string[]} links
 */
const note = (title, links) =>
  `---\ntitle: ${title}\ndate: 2026-08-20\n---\n\n${title}. ` +
  links.map((l) => `[[${l}]]`).join(' ') +
  '\n';

/**
 * A vault with real note counts, under `root`.
 *
 * Notes are linked in a ring so the link lint has a graph to walk rather than a pile of orphans,
 * with every tenth one left MOC-only so it has something to report. Content is deliberately dull:
 * this measures per-note file I/O and parsing, not retrieval quality — that is memory-eval's job,
 * against memory-synth-vault's fixed corpus.
 *
 * @param {string} root
 * @param {{slug: string, notes?: number}} opts
 */
export function makeFixture(root, { slug, notes = 50 }) {
  const vault = path.join(root, 'vault');
  const memory = path.join(vault, 'Memory', slug);
  const mistakes = path.join(vault, 'Insights', slug, 'Mistakes');
  const emptyVault = path.join(root, 'vault-empty');
  for (const d of [memory, mistakes, emptyVault, path.join(root, 'home'), path.join(root, 'state')])
    fs.mkdirSync(d, { recursive: true });

  const names = Array.from({ length: notes }, (_, i) => `note-${String(i).padStart(3, '0')}`);
  for (let i = 0; i < names.length; i++) {
    const linked =
      i % 10 === 0 ? [] : [names[(i + 1) % names.length], names[(i + 2) % names.length]];
    fs.writeFileSync(path.join(memory, `2026-08-20-${names[i]}.md`), note(names[i], linked));
  }
  fs.writeFileSync(path.join(memory, 'MEMORY.md'), note('Memory', names));
  for (let i = 0; i < Math.max(1, Math.round(notes / 5)); i++)
    fs.writeFileSync(
      path.join(mistakes, `2026-08-20-mistake-${i}.md`),
      note(`Mistake ${i}`, [names[i % names.length]]),
    );

  // A short transcript: long enough for the distiller's gate to stat and count it, short enough
  // that the gate says "trivial session" instead of detaching a headless `claude`. The floor is
  // MIN_MESSAGES (15), not STOP_MIN_MESSAGES (400) — SessionEnd, which is what this row sends,
  // skips the higher one, so 40 lines detached a real worker on every sample.
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ role: 'user', content: 'hi' })}\n`.repeat(10));

  return {
    vault,
    emptyVault,
    memory,
    mistakes,
    transcript,
    note: path.join(memory, `2026-08-20-${names[0]}.md`),
  };
}

/**
 * The env every child gets: scratch HOME, scratch state, scratch vault, recall left inert.
 *
 * @param {string} root
 * @param {Record<string, string | undefined>} base
 */
export function benchEnv(root, base = process.env) {
  const env = { ...base };
  env.HOME = path.join(root, 'home');
  env.CLAUDE_MEMORY_HOME = path.join(root, 'state');
  env.CLAUDE_VAULT = path.join(root, 'vault');
  delete env.MEMORY_RECALL_ENABLED;
  return env;
}

/**
 * What gets timed, as data rather than code, so the table and the tests agree by construction.
 *
 * `stdin` is the payload Claude Code would send. `env` is merged over benchEnv() for the one row
 * that needs recall armed: the hook ships inert, and quoting the inert cost as "the recall hook"
 * would be timing an excluded path — this repo's own recurring mistake.
 *
 * @param {{cwd: string, transcript: string, note: string, emptyVault: string}} f
 */
export function hookSpecs({ cwd, transcript, note: notePath, emptyVault }) {
  const payload = (/** @type {Record<string, unknown>} */ o) => JSON.stringify({ cwd, ...o });
  const start = payload({ hook_event_name: 'SessionStart', source: 'startup' });
  return [
    { name: 'insights-surface', entry: 'hooks/insights-surface.mjs', stdin: start, env: {} },
    { name: 'memory-link-lint', entry: 'hooks/memory-link-lint.mjs', stdin: start, env: {} },
    {
      // Pointed at an empty scratch vault, and that is what keeps this row on the gate path.
      // With the populated one resolveSlug() matches, plan() says run, and the hook detaches a
      // real memory-semantic.mjs --index child that loads the model — under a scratch root the
      // bench then deletes. Empty vault means resolveSlug() returns null after the same
      // projectKey() and stat work, so the number is the gate and nothing spawns.
      name: 'semantic-index-refresh',
      entry: 'hooks/semantic-index-refresh.mjs',
      stdin: start,
      env: { CLAUDE_VAULT: emptyVault },
    },
    {
      name: 'graph-staleness-check',
      entry: 'hooks/graph-staleness-check.mjs',
      stdin: start,
      env: {},
    },
    {
      name: 'validate-note',
      entry: 'hooks/validate-note.mjs',
      stdin: payload({ tool_input: { file_path: notePath } }),
      env: {},
    },
    {
      name: 'distill-session (gate)',
      entry: 'hooks/distill-session.mjs',
      stdin: payload({
        hook_event_name: 'SessionEnd',
        transcript_path: transcript,
        session_id: 'bench',
      }),
      env: {},
    },
    {
      name: 'memory-recall (inert)',
      entry: 'hooks/memory-recall.mjs',
      stdin: payload({ prompt: 'what did we decide about the vault' }),
      env: {},
    },
    {
      name: 'memory-recall (armed, no index)',
      entry: 'hooks/memory-recall.mjs',
      stdin: payload({ prompt: 'what did we decide about the vault' }),
      env: { MEMORY_RECALL_ENABLED: '1' },
    },
  ];
}

/**
 * The floor rows: what a hook costs before it is a hook.
 *
 * This is the half "time each hook" cannot answer on its own — a hook 40 ms above bare node is
 * doing 40 ms of work, while a hook 40 ms above nothing is mostly interpreter.
 *
 * @param {string} pluginRoot
 */
export function baselineSpecs(pluginRoot) {
  const href = (/** @type {string} */ rel) =>
    JSON.stringify(pathToFileURL(path.join(pluginRoot, rel)).href);
  return [
    { name: 'node -e "" (floor)', args: ['-e', ''] },
    { name: '+ import paths.mjs', args: ['-e', `import(${href('hooks/lib/paths.mjs')})`] },
    { name: '+ import hook-io.mjs', args: ['-e', `import(${href('hooks/lib/hook-io.mjs')})`] },
    { name: '+ import node:sqlite', args: ['-e', 'import("node:sqlite")'] },
  ];
}

/**
 * One timed run. Wall time of the whole child, which is what a session event waits on.
 *
 * @param {string} node
 * @param {string[]} args
 * @param {{env: Record<string, string | undefined>, cwd: string, stdin?: string}} opts
 */
export function timeOnce(node, args, { env, cwd, stdin = '' }) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(node, args, { env, cwd, input: stdin, encoding: 'utf8' });
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  return { dt, status: r.status };
}

/**
 * Time one command n times, discarding a warm-up run.
 *
 * The warm-up is not superstition: the first spawn pays the OS page cache for the interpreter and,
 * for the hook rows, writes the project-key cache every later run reads.
 *
 * @param {string} node
 * @param {string[]} args
 * @param {{env: Record<string, string | undefined>, cwd: string, stdin?: string}} opts
 * @param {number} n
 */
export function sample(node, args, opts, n) {
  /** @type {number[]} */
  const samples = [];
  let failures = 0;
  timeOnce(node, args, opts);
  for (let i = 0; i < n; i++) {
    const r = timeOnce(node, args, opts);
    if (r.status !== 0) failures++;
    samples.push(r.dt);
  }
  return { ...stats(samples), failures };
}

/**
 * Run the whole bench. Returns rows; printing is the entry's job.
 *
 * `onRow` exists so a 20-iteration run over twelve rows reports as it goes rather than after
 * twenty seconds of silence.
 *
 * @param {{root: string, pluginRoot: string, cwd: string, slug: string, n?: number,
 *   notes?: number, node?: string, onRow?: (row: {name: string, n: number, min: number,
 *   median: number, p90: number, max: number, failures: number}) => void}} opts
 */
export function bench({
  root,
  pluginRoot,
  cwd,
  slug,
  n = 20,
  notes = 50,
  node = process.execPath,
  onRow = () => {},
}) {
  const fixture = makeFixture(root, { slug, notes });
  const env = benchEnv(root);
  assertIsolated(env, root);

  /** @type {any[]} */
  const rows = [];
  const push = (/** @type {any} */ r) => {
    rows.push(r);
    onRow(r);
  };

  for (const b of baselineSpecs(pluginRoot))
    push({ name: b.name, ...sample(node, b.args, { env, cwd }, n) });

  for (const h of hookSpecs({
    cwd,
    transcript: fixture.transcript,
    note: fixture.note,
    emptyVault: fixture.emptyVault,
  }))
    push({
      name: h.name,
      ...sample(
        node,
        [path.join(pluginRoot, h.entry)],
        { env: { ...env, ...h.env }, cwd, stdin: h.stdin },
        n,
      ),
    });

  return { rows };
}

/** A scratch root under the OS temp dir. The caller removes it; --keep is what stops that. */
export function scratchRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bench-hooks-'));
}
