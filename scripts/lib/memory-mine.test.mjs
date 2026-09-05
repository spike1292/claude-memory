// Tests for scripts/lib/memory-mine.mjs. Run: node --test scripts/lib/memory-mine.test.mjs
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { minePrompt, minePrompts, MINE_MIN, MINE_MAX } from './memory-mine.mjs';

/** @param {object} o */
const userLine = (o) => JSON.stringify({ type: 'user', ...o });

test('minePrompt reads both content shapes', () => {
  const q = 'why does the recall hook abstain so often on short prompts';
  assert.equal(minePrompt(userLine({ message: { content: q } })), q);
  assert.equal(
    minePrompt(userLine({ message: { content: [{ type: 'text', text: q }] } })),
    q,
    'a content-block array is the newer transcript shape and must mine the same',
  );
});

test('minePrompt keeps only the text blocks', () => {
  const line = userLine({
    message: {
      content: [
        { type: 'tool_result', content: 'ENOENT: no such file or directory, open /tmp/nope' },
        { type: 'text', text: 'that path is wrong, where does the index actually live' },
      ],
    },
  });
  assert.equal(minePrompt(line), 'that path is wrong, where does the index actually live');
});

test('minePrompt drops harness turns, not human ones', () => {
  const long = 'x'.repeat(MINE_MIN + 5);
  assert.equal(minePrompt(userLine({ message: { content: long }, isMeta: true })), null);
  assert.equal(minePrompt(JSON.stringify({ type: 'assistant', message: { content: long } })), null);
  assert.equal(minePrompt(userLine({ message: { content: '/memory:eval --run' } })), null);
  assert.equal(
    minePrompt(userLine({ message: { content: '<system-reminder>hi</system-reminder>' } })),
    null,
  );
  assert.equal(minePrompt(userLine({ message: { content: `Caveat: ${long}` } })), null);
  // Position is what separates the two: a slash-command line is noise, a question ABOUT one is not.
  assert.equal(
    minePrompt(userLine({ message: { content: 'what does /memory:eval --run actually score' } })),
    'what does /memory:eval --run actually score',
  );
});

test('minePrompt applies the length bounds', () => {
  assert.equal(minePrompt(userLine({ message: { content: 'do 1' } })), null);
  assert.equal(minePrompt(userLine({ message: { content: 'a'.repeat(MINE_MAX + 1) } })), null);
  assert.equal(
    minePrompt(userLine({ message: { content: 'b'.repeat(MINE_MAX) } })),
    'b'.repeat(MINE_MAX),
    'the bound is inclusive — an off-by-one here silently changes the pool size',
  );
});

test('minePrompt survives a truncated tail line', () => {
  const good = userLine({ message: { content: 'where do the semantic indexes get written to' } });
  const seen = new Set();
  const { lines, turns, kept } = minePrompts([good, '{"type":"user","message":{"conte'], seen);
  assert.equal(lines, 2);
  assert.equal(turns, 1, 'an unparseable line is not a turn — counting it inflates the drop rate');
  assert.equal(kept, 1, 'one unparseable append must not cost the lines around it');
});

test('minePrompts counts lines and turns apart', () => {
  const seen = new Set();
  const t = minePrompts(
    [
      JSON.stringify({ type: 'assistant', message: { content: 'a'.repeat(40) } }),
      userLine({ message: { content: 'do 1' } }),
      userLine({ message: { content: 'which model does the recall socket hold open' } }),
    ],
    seen,
  );
  // Lines are mostly assistant and tool records: reporting them as turns overstated the pool by
  // two orders of magnitude (lines vs turns; see MINE_MIN).
  assert.deepEqual(t, { lines: 3, turns: 2, kept: 1 });
});

test('minePrompts deduplicates across folders via the shared set', () => {
  const q = 'how is the project key derived when there is no git remote';
  const line = userLine({ message: { content: q } });
  const seen = new Set();
  // The two-folders-one-history case: 142 and 142 measured to 142 unique on 2026-09-05, so a
  // per-folder Set would double the reported pool.
  assert.equal(minePrompts([line], seen).kept, 1);
  assert.equal(minePrompts([line], seen).kept, 0);
  assert.equal(seen.size, 1);
});

test('a tool result is not a human turn', () => {
  const seen = new Set();
  const t = minePrompts(
    [
      userLine({ message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
      userLine({ message: { content: 'where does the model cache actually get redirected' } }),
    ],
    seen,
  );
  // Both arrive as `type: user`. Counting the first as a turn reported 37878 against the real count
  // in MINE_MIN's measurement, which makes the dropped count meaningless.
  assert.deepEqual(t, { lines: 2, turns: 1, kept: 1 });
});
