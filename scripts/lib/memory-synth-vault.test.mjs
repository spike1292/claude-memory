// Tests for scripts/lib/memory-synth-vault.mjs. Run: node --test scripts/lib/memory-synth-vault.test.mjs
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mulberry32, DOMAINS } from './memory-synth-vault.mjs';

test('mulberry32 is reproducible per seed', () => {
  const r1 = mulberry32(7), r2 = mulberry32(7);
  assert.equal(r1(), r2(), 'same seed must produce the same stream — the whole point is reproducibility');
  assert.notEqual(mulberry32(7)(), mulberry32(8)(), 'different seeds must differ');
});

test('gold note names are unique', () => {
  // gold uniqueness by construction: no two cases may share a title, or scoring is ambiguous
  const titles = DOMAINS.flatMap((d) => d.cases.map((c) => `${d.product.toLowerCase()}-${c.title}`));
  assert.equal(new Set(titles).size, titles.length, 'gold note names must be unique');
});

test('paraphrase questions leak no note vocabulary', () => {
  // the paraphrase must NOT share CONTENT words with the note name — otherwise it tests keywords.
  // Function words are exempt: "with"/"that"/"from" carry no retrieval signal, and banning them
  // would force stilted questions, which is its own bias.
  const FUNCTION_WORDS = new Set(['with', 'that', 'this', 'from', 'they', 'them', 'their', 'have',
    'been', 'does', 'when', 'what', 'which', 'into', 'than', 'then', 'also', 'only', 'over', 'more',
    'some', 'such', 'were', 'will', 'would', 'could', 'should', 'about', 'after', 'before', 'does']);
  // Report EVERY violation, not the first: fixing a data set one assertion-abort at a time is a
  // rebuild per fix, and a check that hides the other nine findings understates the work.
  const leaks = [];
  for (const d of DOMAINS) for (const c of d.cases) {
    const titleWords = new Set(c.title.split('-').filter((w) => w.length > 3 && !FUNCTION_WORDS.has(w)));
    const askWords = c.ask.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter((w) => w.length > 3 && !FUNCTION_WORDS.has(w));
    const overlap = askWords.filter((w) => titleWords.has(w));
    if (overlap.length) leaks.push(`${c.title}: reuses ${overlap.join(', ')}`);
    if (c.ask.toLowerCase().includes(d.product.toLowerCase())) leaks.push(`${c.title}: names the product`);
    if (!c.nl || !c.key) leaks.push(`${c.title}: missing a query variant`);
  }
  assert.equal(leaks.length, 0, `paraphrase questions leak note vocabulary (${leaks.length}):\n  ${leaks.join('\n  ')}`);
});

test('the case set covers every domain', () => {
  // The gold-case count is the one number worth asserting: it says how much the set covers, and it
  // is derived from the data rather than written down anywhere.
  const n = DOMAINS.reduce((a, d) => a + d.cases.length, 0);
  assert.equal(n, DOMAINS.length * 5, 'every domain contributes five gold cases');
  assert.ok(DOMAINS.length >= 8, `expected at least 8 domains, got ${DOMAINS.length}`);
});
