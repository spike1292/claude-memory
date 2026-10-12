// Tests for the scripts/memory-audit-checks.mjs ENTRY against the SessionStart link lint (#99).
// Run: node --test scripts/memory-audit-checks.test.mjs
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportFor } from '../hooks/lib/memory-link-lint.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PARSER = 'hooks/lib/memory-link-lint.mjs';

/** @param {string} out @param {string} title @returns {string[]} */
const sectionOf = (out, title) => {
  const m = out.match(new RegExp(`^## ${title}[^\\n]*\\n((?:  .*\\n?)*)`, 'm'));
  return m
    ? m[1]
        .trim()
        .split('\n')
        .map((l) => l.trim().split(/ — |\s/)[0])
    : [];
};

test('the SessionStart lint and /memory:health agree on orphans and dangling links (#99)', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rt-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const [home, state, vault, repo] = ['home', 'state', 'vault', 'repo'].map((d) => {
    fs.mkdirSync(path.join(root, d));
    return path.join(root, d);
  });
  execFileSync('git', ['init', '-q', repo]);
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, HOME: home, CLAUDE_MEMORY_HOME: state, CLAUDE_VAULT: vault };
  const slug = execFileSync(
    process.execPath,
    [
      '-e',
      `import('${new URL('../hooks/lib/paths.mjs', import.meta.url)}').then(p => process.stdout.write(p.projectKey(process.argv[1])))`,
      repo,
    ],
    { env, encoding: 'utf8' },
  );
  const mem = path.join(vault, 'Memory', slug);
  fs.mkdirSync(mem, { recursive: true });
  const fence = '```bash\n[[ -f x ]] && echo\n```\n';
  for (const [name, body] of Object.entries({
    MEMORY: `- [A](a.md)\n- [B](b.md)\n- [C](c.md)\n\n${fence}`,
    a: `---\nname: a\n---\nsee [[ b ]]\n\n${fence}`,
    b: '---\nname: b\n---\nrun `[[ -n $v ]]` first\n',
    c: '---\nname: c\n---\nnothing\n',
  }))
    fs.writeFileSync(path.join(mem, `${name}.md`), body);

  const lintOrphans = reportFor(mem, path.join(vault, 'Insights', slug))
    .split('\n')
    .filter((l) => l.startsWith('  - '))
    .map((l) => l.slice(4));
  const audit = execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts/memory-audit-checks.mjs'), repo],
    {
      env,
      encoding: 'utf8',
    },
  );
  assert.match(audit, new RegExp(`# ${slug}`), 'the audit must reach the synthetic vault');
  assert.deepStrictEqual(lintOrphans, ['a', 'c']);
  assert.deepStrictEqual(sectionOf(audit, 'MOC-only'), lintOrphans);
  assert.deepStrictEqual(sectionOf(audit, 'Dangling wikilinks'), []);
  assert.deepStrictEqual(sectionOf(audit, 'Not in the MOC'), []);
});

test('no wikilink-target regex lives outside the parser module (#99)', () => {
  const allowed = new Set([
    PARSER,
    'scripts/lib/memory-promote.mjs', // memberNamesOf(): frontmatter, not a body
    'scripts/lib/memory-eval.mjs', // the eval text scrubber
  ]);
  const extract = /\\{1,2}\[\\{1,2}\[\(/;
  /** @type {string[]} */
  const found = [];
  /** @type {string[]} */
  const offenders = [];
  for (const dir of ['hooks', 'hooks/lib', 'scripts', 'scripts/lib'])
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith('.mjs') || f.endsWith('.test.mjs')) continue;
      const rel = `${dir}/${f}`;
      if (!extract.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) continue;
      found.push(rel);
      if (!allowed.has(rel)) offenders.push(rel);
    }
  assert.ok(found.includes(PARSER), 'positive control: the scan must find the parser itself');
  assert.deepStrictEqual(offenders, []);

  const callers = ['scripts/memory-audit-checks.mjs', PARSER].flatMap((rel) =>
    [
      ...fs
        .readFileSync(path.join(ROOT, rel), 'utf8')
        .matchAll(/(?<!function )\b(linkTargets|noteTargets)\(/g),
    ].map((m) => `${rel}:${m[1]}`),
  );
  for (const want of [
    'scripts/memory-audit-checks.mjs:linkTargets',
    'scripts/memory-audit-checks.mjs:noteTargets',
    `${PARSER}:linkTargets`,
    `${PARSER}:noteTargets`,
  ])
    assert.ok(callers.includes(want), `${want} must route through the parser`);
});
