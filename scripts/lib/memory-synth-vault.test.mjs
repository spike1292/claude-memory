// Tests for scripts/lib/memory-synth-vault.mjs. Run: node --test scripts/lib/memory-synth-vault.test.mjs
import test from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mulberry32, DOMAINS } from './memory-synth-vault.mjs';

test('mulberry32 is reproducible per seed', () => {
  const r1 = mulberry32(7),
    r2 = mulberry32(7);
  assert.equal(
    r1(),
    r2(),
    'same seed must produce the same stream — the whole point is reproducibility',
  );
  assert.notEqual(mulberry32(7)(), mulberry32(8)(), 'different seeds must differ');
});

test('gold note names are unique', () => {
  // gold uniqueness by construction: no two cases may share a title, or scoring is ambiguous
  const titles = DOMAINS.flatMap((d) =>
    d.cases.map((c) => `${d.product.toLowerCase()}-${c.title}`),
  );
  assert.equal(new Set(titles).size, titles.length, 'gold note names must be unique');
});

test('paraphrase questions leak no note vocabulary', () => {
  // the paraphrase must NOT share CONTENT words with the note name — otherwise it tests keywords.
  // Function words are exempt: "with"/"that"/"from" carry no retrieval signal, and banning them
  // would force stilted questions, which is its own bias.
  const FUNCTION_WORDS = new Set([
    'with',
    'that',
    'this',
    'from',
    'they',
    'them',
    'their',
    'have',
    'been',
    'does',
    'when',
    'what',
    'which',
    'into',
    'than',
    'then',
    'also',
    'only',
    'over',
    'more',
    'some',
    'such',
    'were',
    'will',
    'would',
    'could',
    'should',
    'about',
    'after',
    'before',
    'does',
  ]);
  // Report EVERY violation, not the first: fixing a data set one assertion-abort at a time is a
  // rebuild per fix, and a check that hides the other nine findings understates the work.
  const leaks = [];
  for (const d of DOMAINS)
    for (const c of d.cases) {
      const titleWords = new Set(
        c.title.split('-').filter((w) => w.length > 3 && !FUNCTION_WORDS.has(w)),
      );
      const askWords = c.ask
        .toLowerCase()
        .replace(/[^a-z\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 3 && !FUNCTION_WORDS.has(w));
      const overlap = askWords.filter((w) => titleWords.has(w));
      if (overlap.length) leaks.push(`${c.title}: reuses ${overlap.join(', ')}`);
      if (c.ask.toLowerCase().includes(d.product.toLowerCase()))
        leaks.push(`${c.title}: names the product`);
      if (!c.nl || !c.key) leaks.push(`${c.title}: missing a query variant`);
    }
  assert.equal(
    leaks.length,
    0,
    `paraphrase questions leak note vocabulary (${leaks.length}):\n  ${leaks.join('\n  ')}`,
  );
});

test('the case set covers every domain', () => {
  // The gold-case count is the one number worth asserting: it says how much the set covers, and it
  // is derived from the data rather than written down anywhere.
  const n = DOMAINS.reduce((a, d) => a + d.cases.length, 0);
  assert.equal(n, DOMAINS.length * 5, 'every domain contributes five gold cases');
  assert.ok(DOMAINS.length >= 8, `expected at least 8 domains, got ${DOMAINS.length}`);
});

// The CLI, not the module: #49 was --notes being written into a summary line but never into the
// vault, which only a count of the files ON DISK can catch. Round trip, not each half.
test('--notes bounds the vault it actually writes', () => {
  const entry = fileURLToPath(new URL('../memory-synth-vault.mjs', import.meta.url));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'synthvault-'));
  /** @param {string[]} args */
  const run = (...args) =>
    // the seed goes LAST only when the case does not set one: val() takes the first occurrence,
    // so a leading --seed 7 would swallow the case that passes a bad one
    spawnSync(
      process.execPath,
      [entry, '--out', out, ...args, ...(args.includes('--seed') ? [] : ['--seed', '7'])],
      { encoding: 'utf8' },
    );
  const written = () =>
    fs
      .readdirSync(out, { recursive: true })
      .filter((f) => String(f).endsWith('.md') && !String(f).endsWith('MANIFEST.md')).length;
  const goldNames = () =>
    fs
      .readFileSync(path.join(out, 'cases-paraphrase.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).gold[0]);

  const flatGoldNames = DOMAINS.flatMap((d) =>
    d.cases.map((c) => `${d.product.toLowerCase()}-${c.title}`),
  );
  const availableGold = flatGoldNames.length;

  try {
    // below the floor, and a --notes that is not a number at all: on main the latter fell into
    // `while (n < NaN)` and silently produced the full 120
    /** @type {[string[], RegExp][]} */
    const refusals = [
      [['--notes', '2'], /minimum 3/],
      [['--notes', 'abc'], /--notes abc must be a whole number/],
      [['--notes', '3.5'], /--notes 3.5 must be a whole number/], // filler would overshoot to 4
      [['--notes', 'Infinity'], /--notes Infinity must be a whole number/], // filler never ends
      [['--notes', '4', '--echoes', '4'], /minimum 5/], // the minimum is computed, not the literal 3
      [['--notes', '60', '--echoes', '-1'], /--echoes must be a whole number/],
      [['--notes', '60', '--echoes', '0.5'], /--echoes must be a whole number/],
      [['--seed', 'abc'], /--seed must be a whole number/], // mulberry32 coerces NaN to seed 0
      [['--seed', '1.5'], /--seed must be a whole number/], // and |0 makes 1.5 the seed-1 vault
    ];
    // a refusal must leave an existing vault at --out alone: both guards run before fs.rmSync(OUT),
    // and that ordering is one refactor away from silently deleting someone's bench vault
    fs.writeFileSync(path.join(out, 'pre-existing.md'), 'not ours to delete');
    for (const [args, want] of refusals) {
      const r = run(...args);
      assert.equal(r.status, 1, `${args.join(' ')} must exit non-zero`);
      assert.match(r.stderr, want);
      assert.ok(
        fs.existsSync(path.join(out, 'pre-existing.md')),
        `${args.join(' ')} was refused but wrote to --out anyway`,
      );
    }

    // 3 is the boundary — exactly one gold note plus its echoes — and must be accepted
    // `each` is the literal the run must print, NOT the rule that produced it: re-deriving
    // `${1 + echoes} note${echoes ? 's' : ''}` here is the same rule twice, and the copy stays
    // green while the original drifts. null means this row prints no fit line at all.
    /** @type {[number, number, string[], string | null][]} */
    const sizes = [
      [3, 1, [], '3 notes each'],
      [20, 6, [], '3 notes each'],
      [60, 20, [], '3 notes each'],
      // --echoes 0 makes PER_GOLD 1 — the only input that reaches the singular, and it has to be a
      // size that truncates: at --notes 60 all 40 gold cases fit, so that row never sees the line
      [20, 20, ['--echoes', '0'], '1 note each'],
      [60, 40, ['--echoes', '0'], null],
    ];
    for (const [notes, gold, extra, each] of sizes) {
      const e = extra.indexOf('--echoes');
      const echoes = e >= 0 ? Number(extra[e + 1]) : 2;
      const r = run('--notes', String(notes), ...extra);
      assert.equal(r.status, 0, `--notes ${notes} must succeed:\n${r.stderr}`);
      assert.equal(written(), notes, `--notes ${notes} must write exactly ${notes} notes`);
      assert.match(
        r.stdout,
        new RegExp(`^${notes} notes \\(${gold} gold, ${gold * echoes} echoes,`, 'm'),
        'the summary must state the same n, and the same gold count the case set got',
      );
      // the file count alone is insensitive to the gold/filler split — filler tops the vault back
      // up either way, so MAX_GOLD could be anything and the total would still be right
      assert.equal(goldNames().length, gold, `--notes ${notes} must yield ${gold} gold cases`);
      // the truncation has to SAY so — "either honour --notes or say plainly that it cannot be"
      // is the whole of #49, and the scaling path owns the second half
      assert.equal(
        each === null,
        gold === availableGold,
        'a row states the fit line it expects, or null when the run must not print one',
      );
      if (each === null)
        // anchored: the unanchored /fits/ could be satisfied by the mkdtemp suffix in the
        // "index it:" line, which is stdout too
        assert.doesNotMatch(
          r.stdout,
          /^--notes \d+ fits/m,
          'an untruncated run must not claim it truncated',
        );
      else
        assert.match(
          r.stdout,
          new RegExp(
            `^--notes ${notes} fits ${gold} of ${availableGold} gold cases \\(${each}\\)`,
            'm',
          ),
          'truncation must be reported',
        );

      // MANIFEST.md is the artifact someone quotes a vault's parameters from, and it states the
      // two numbers #49 was about
      assert.match(
        fs.readFileSync(path.join(out, 'MANIFEST.md'), 'utf8'),
        new RegExp(`${notes} notes, ${gold} gold cases`),
        'the manifest must state the vault it was written beside',
      );

      // order, not just membership: gold is picked round-robin and re-sorted back into the
      // original order, and only that second sort keeps cases-*.jsonl byte-identical at 300
      const picked = goldNames().map((n) => flatGoldNames.indexOf(n));
      assert.ok(
        picked.every((v, k) => v >= 0 && (k === 0 || v > picked[k - 1])),
        'gold cases must be written in their original order',
      );
    }

    // truncation must not drop whole domains: gold is taken round-robin, filler is drawn from all
    // of them, so a domain-major cut left four domains carrying distractors and no gold at all
    const domains = new Set(DOMAINS.map((d) => d.product.toLowerCase()));
    run('--notes', '60');
    assert.equal(
      new Set(goldNames().map((n) => n.split('-')[0])).size,
      domains.size,
      'a truncated case set must still cover every domain',
    );

    // ...nor whole LAYERS, which is the same defect one axis over: a domain has as many cases as
    // there are layers, so keying the layer off the original index made the round-robin cut slice
    // layers instead. At --notes 60 that left Decisions and permanent with no gold at all.
    const gold = new Set(goldNames());
    /** @type {Record<string, number>} */
    const perLayer = {};
    for (const f of fs.readdirSync(out, { recursive: true })) {
      const rel = String(f);
      if (!gold.has(path.basename(rel, '.md'))) continue;
      const layer = path.dirname(rel);
      perLayer[layer] = (perLayer[layer] ?? 0) + 1;
    }
    const counts = Object.values(perLayer);
    assert.equal(
      counts.length,
      5,
      `gold must reach all five layers, got ${JSON.stringify(perLayer)}`,
    );
    assert.ok(
      Math.max(...counts) - Math.min(...counts) <= 1,
      `gold must be even across layers, got ${JSON.stringify(perLayer)}`,
    );
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
