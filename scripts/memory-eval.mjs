#!/usr/bin/env node
// Reproducible retrieval eval — CLI entry. Generates a versioned case set once, then scores any
// retrieval change against THE SAME cases.
//
// Thin on purpose: argv, files, stdout. The scoring helpers and their tests live in
// lib/memory-eval.mjs.
//
// Usage:
//   node memory-eval.mjs --author < cases.jsonl          the way to make a REAL paraphrase set
//   node memory-eval.mjs --generate 40 [--style semantic|keyword] [--out <path>]
//   node memory-eval.mjs --run [--cases <path>] [--mode semantic|lexical] [--json]
// Flags take a space, never `=`. `--cases`/`--out` both override the per-project default on --run;
// leave them off unless you mean to score a set that is not this project's.
//
// Cases live in $CLAUDE_MEMORY_HOME/eval/ and are GITIGNORED: they contain vault content.
// Regenerate only with --force; a changed case set invalidates every past number.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activeModel } from './lib/model-default.mjs';
import * as paths from '../hooks/lib/paths.mjs';
import {
  evalBody,
  pickSentence,
  metrics,
  lexicalRank,
  goldCoverage,
  defaultCasesPath,
  minePrompts,
  unscorableReason,
  pairwise,
  gateFailures,
  casesHash,
  kindOfPath,
  KIND,
  GOLD,
  GOLD_FLOOR,
  RECALL_KS,
} from './lib/memory-eval.mjs';

// ---------------------------------------------------------------- setup

const argv = process.argv.slice(2);
/** @param {string} n @returns {boolean} */
const flag = (n) => argv.includes(n);
// A flag whose value went missing used to score the DEFAULT case set and print a number the
// operator read as belonging to the file they had just named — #97's own failure, reached by a typo
// instead of by a doc. `--cases` last in argv yielded undefined; `--cases --mode lexical` yielded
// `--mode`. Checked HERE rather than against a list of value-taking flags, because every one of
// them already passes through this function and a list would silently miss the next one added.
/**
 * @param {string} n
 * @param {boolean} [bare] value optional — only `--generate`, whose bare form means 40
 * @returns {string|null}
 */
const val = (n, bare = false) => {
  const i = argv.indexOf(n);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!bare && (!v || v.startsWith('--'))) {
    console.log(`${n} needs a value.`);
    process.exit(1);
  }
  return v ?? null;
};
// The other shape of the same hole, and the one no `val()` call can see: `--cases=other.jsonl`
// matches no flag at all, so it was dropped in silence. Refuse it rather than guess.
const equalsArg = argv.find((a) => /^--[\w-]+=/.test(a));
if (equalsArg) {
  const [name, ...rest] = equalsArg.split('=');
  console.log(`${name} takes a space-separated value. Write: ${name} ${rest.join('=')}`);
  process.exit(1);
}
// And the last shape: a misspelled flag NAME — `--casess other.jsonl` matched nothing and was
// dropped. A closed set is safe to keep by hand because it fails CLOSED: a name missing from it
// errors on first use instead of going quiet. A test ties it to the call sites.
const KNOWN_FLAGS = new Set([
  '--run',
  '--author',
  '--generate',
  '--force',
  '--json',
  '--cases',
  '--out',
  '--vault',
  '--slug',
  '--style',
  '--mode',
  '--fetch-k',
  '--mine',
  '--kind',
  '--min-rank1',
  '--freeze',
]);
const unknownFlag = argv.find((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
if (unknownFlag) {
  console.log(`unknown flag ${unknownFlag}. Known: ${[...KNOWN_FLAGS].join(' ')}`);
  process.exit(1);
}
const repo =
  argv
    .filter((a) => !a.startsWith('--'))
    .find((a) => fs.existsSync(a) && fs.statSync(a).isDirectory()) || process.cwd();
// --vault/--slug point this at a generated benchmark vault instead of the real one, which is how
// a retrieval change gets scored against a FIXED note set. Explicit flags, not CLAUDE_VAULT: an
// env override once sent a relocating hook at a throwaway path and cost 24 notes.
const VAULT = val('--vault') || paths.vault();
const SLUG = val('--slug') || paths.projectKey(repo);
// Echo the resolved project. `repo` defaults to cwd, so running this from ~/.claude silently
// evaluates the CONFIG repo's near-empty vault — hit three separate times on 2026-08-14, once per
// script, always with a confident-looking wrong answer.
console.error(`project: ${SLUG}  (from ${repo})`);
const STYLE = val('--style') || 'semantic';
// Default `tuning`, so every existing invocation resolves the file it always did. An unknown kind
// throws rather than falling through, which would print a tuning number under a held-out label.
const CASE_KIND = val('--kind') || KIND.tuning;
// Case sets are generated FROM a real vault and contain its content, so they live in
// machine-local state, never in the plugin (which is a public repo).
const DATA = paths.stateDir('eval');
let SCOPED_CASES;
try {
  SCOPED_CASES = defaultCasesPath(DATA, SLUG, STYLE, CASE_KIND);
} catch (e) {
  console.log(String(e instanceof Error ? e.message : e));
  process.exit(1);
}
const CASES = val('--cases') || val('--out') || SCOPED_CASES;
// From the FILE, never the flag: `--kind` decides which file the DEFAULT resolves to, and does not
// get to assert what an explicit `--cases` path is. It warns rather than deferring silently,
// because the freeze banner is what gets pasted into an issue as provenance.
const REPORTED_KIND = kindOfPath(CASES);
if (val('--kind') && CASE_KIND !== REPORTED_KIND)
  console.error(
    `warning: --kind ${CASE_KIND} ignored — ${path.basename(CASES)} is a ${REPORTED_KIND} set, and the file decides.`,
  );

/** @typedef {{ note: string, layer: string, file: string }} EvalNote */

/** @returns {EvalNote[]} */
function allNotes() {
  /** @type {EvalNote[]} */
  const out = [];
  /** @param {string} dir @param {string} layer */
  const add = (dir, layer) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      if (f === 'REFLECTIONS.md' || f === 'MEMORY.md') continue;
      out.push({ note: f.slice(0, -3), layer, file: path.join(dir, f) });
    }
  };
  add(path.join(VAULT, 'Memory', SLUG), 'Memory');
  for (const l of ['Patterns', 'Mistakes', 'Decisions'])
    add(path.join(VAULT, 'Insights', SLUG, l), l);
  // permanent/ is a retrieval target like any other — consolidated notes are often the BEST answer,
  // so leaving them out both hides misses and rejects valid gold notes.
  for (const d of ['', 'domain', 'tools']) add(path.join(VAULT, 'permanent', d), 'permanent');
  return out;
}

// A case set is JSONL, so a truncated write leaves one unparseable line. Bare `JSON.parse` threw a
// SyntaxError and a stack trace from inside a `.map()`, which reads as a crash rather than as the
// bad input it is — and it fired BEFORE the malformed-case guard written to report exactly this.
/**
 * @param {string} text
 * @param {string} src
 * @returns {{ q: string, gold?: unknown, layer?: string, style?: string }[]}
 */
const parseJsonl = (text, src) => {
  const out = [];
  for (const [i, l] of text.trim().split('\n').filter(Boolean).entries()) {
    try {
      out.push(JSON.parse(l));
    } catch {
      console.log(`${src}: line ${i + 1} is not valid JSON — truncated or malformed.`);
      process.exit(1);
    }
  }
  return out;
};

// A question has to contain something searchable (2026-08-23). Blank was the first version, but
// `"???"` is not blank and still tokenises to nothing: every BM25 score ties at 0, so the ranking
// is whatever order the documents arrived in. The reported figure is then not a measurement at all
// — 100% on the 3-note fixture where k exceeds the corpus, 0.0% on the 60-note bench vault. One
// letter or digit is the general form of "not empty to the retriever".
//
// `\p{L}\p{N}` with the `u` flag, never `\w`: JS's `\w` is ASCII-only where Python's is unicode-
// aware, so `\w` would reject 日本語 and every other non-Latin question in a vault that has them.
//
// `typeof` first and spelled out: `q` is JSON.parse output, so it can be a number, and
// `(42)?.trim()` throws where the type test refuses. The short form shipped for one commit.
/** @param {unknown} q @returns {boolean} */
const isQuestion = (q) => typeof q === 'string' && /[\p{L}\p{N}]/u.test(q);

// ---------------------------------------------------------------- mine

// --mine <dir>[,<dir>…]: emit candidate questions from Claude Code transcripts as {q} JSONL, with
// NO gold. It never writes a case set. Assigning gold is the human's half, and keeping the two
// halves in different hands is the whole point of a held-out set (#87) — a producer that wrote both
// would reproduce the failure that put inflated figures in five artefacts.
//
// A LIST of roots, because one project's history is spread over several cwd-slug folders and the
// deduplication has to span them: two folders holding 142 candidates each hold 142 between them
// (2026-09-05), so mining them separately would report the pool at exactly twice its size.
//
// Candidates go to stdout and the tally to stderr, so the output pipes into an editor or a
// labelling pass while the operator still sees what was dropped.
if (flag('--mine')) {
  const roots = (val('--mine') || '').split(',').filter(Boolean);
  const absent = roots.filter((r) => !fs.existsSync(r));
  if (!roots.length || absent.length) {
    console.log(
      `--mine needs transcript directories. Not found: ${absent.join(', ') || '(none given)'}`,
    );
    process.exit(1);
  }
  // Recursive: Claude Code keeps one FOLDER per cwd-slug, so a useful root is the parent of many
  // folders as often as it is one folder.
  const notDir = roots.filter((r) => !fs.statSync(r).isDirectory());
  if (notDir.length) {
    console.log(`--mine takes transcript DIRECTORIES, not files: ${notDir.join(', ')}`);
    process.exit(1);
  }
  const files = roots.flatMap((r) => {
    try {
      return fs
        .readdirSync(r, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(r, f));
    } catch (e) {
      // Skip and continue, the same as the per-file read below: mining is best-effort.
      console.error(`skipping ${r}: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  });
  const seen = new Set();
  let turns = 0;
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue; // a transcript deleted mid-walk is not an error worth stopping a mining run for
    }
    turns += minePrompts(text.split('\n'), seen).turns;
  }
  for (const q of seen) console.log(JSON.stringify({ q }));
  // Read, kept and dropped, all three: a candidate count alone cannot tell an operator whether the
  // filters are too tight or the history is too thin, and those want opposite responses.
  console.error(
    `${files.length} transcripts under ${roots.length} root(s): ${turns} user turns → ${seen.size} candidates (${turns - seen.size} dropped as noise or duplicate)`,
  );
  console.error('No gold notes attached — assign them by hand, then pipe to --author.');
  process.exit(0);
}

// ---------------------------------------------------------------- freeze

// --freeze: record a case set's identity as a sha256 sidecar. The set stays machine-local (vault
// content), so the hash is what gets quoted; `--run` verifies it whenever one exists.
if (flag('--freeze')) {
  if (!fs.existsSync(CASES)) {
    console.log(`no case set at ${CASES} to freeze.`);
    process.exit(1);
  }
  const h = casesHash(fs.readFileSync(CASES, 'utf8'));
  const side = `${CASES}.sha256`;
  // Re-freezing is how a set gets edited unnoticed, so it takes --force.
  if (fs.existsSync(side) && fs.readFileSync(side, 'utf8').trim() !== h && !flag('--force')) {
    console.log(
      `${side} records a DIFFERENT set. Re-freezing invalidates every number quoted against the old hash — pass --force if that is what you want.`,
    );
    process.exit(1);
  }
  fs.writeFileSync(side, `${h}\n`);
  console.log(`${REPORTED_KIND} set frozen: ${CASES}\n  sha256 ${h}`);
  console.log(
    'Quote this hash wherever you quote a number from this set; the questions stay local.',
  );
  process.exit(0);
}

// ---------------------------------------------------------------- generate

// --author: read {q, gold} JSONL on stdin, validate every gold note exists, and save as the case
// set. This is how a REAL paraphrase set is made: the agent writes the questions once (it is the
// LLM the upstream harness calls out to), then scoring is reproducible forever after.
if (flag('--author')) {
  const known = new Set(allNotes().map((n) => n.note));
  const lines = parseJsonl(fs.readFileSync(0, 'utf8'), 'stdin');
  const cases = [],
    bad = [];
  for (const c of lines) {
    // Same trust boundary as --run: this is input someone wrote, not a shape we can assume. Both
    // fields, because guarding `gold` and then dereferencing `c.q` two lines later just moves the
    // TypeError down the function.
    if (!isQuestion(c.q) || !Array.isArray(c.gold)) {
      console.log(
        `every case needs a question and a gold array — got: ${JSON.stringify(c).slice(0, 80)}`,
      );
      process.exit(1);
    }
    const missing = c.gold.filter((g) => !known.has(g));
    if (missing.length) {
      bad.push(`${missing.join(', ')}  (Q: ${c.q.slice(0, 60)})`);
      continue;
    }
    cases.push({ ...c, style: c.style || 'semantic-authored' });
  }
  if (bad.length) {
    console.log(`gold note(s) not found — fix these first:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  // `--run` would refuse the hash mismatch afterwards, but by then the questions are gone.
  if (fs.existsSync(`${CASES}.sha256`) && !flag('--force')) {
    console.log(
      `${CASES} is frozen. Re-authoring replaces the questions every number quoted against its hash was measured on — pass --force if that is what you want, then --freeze --force.`,
    );
    process.exit(1);
  }
  // Never write an empty set. `--author` has no --force gate, so an upstream producer that failed,
  // a `< /dev/null`, or a filter that matched nothing would silently replace the authored baseline
  // every past number was measured against — the same data loss `--generate` was just given a
  // guard for, still live on the branch that shares its parser.
  if (!cases.length) {
    console.log(`no cases on stdin — refusing to overwrite ${CASES} with nothing.`);
    process.exit(1);
  }
  fs.writeFileSync(CASES, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
  console.log(`${cases.length} authored cases → ${CASES}`);
  process.exit(0);
}

if (flag('--generate')) {
  // `--generate` extracts sentences the note contains verbatim (its banner below: BM25 finds them
  // trivially). Under the held-out name that is an inflated number with a publishable hash.
  if (CASE_KIND === KIND.heldOut) {
    console.log(
      '--generate cannot make a held-out set: it extracts sentences the notes already contain.\n' +
        'Mine candidates with --mine, assign gold by hand, then --author --kind held-out.',
    );
    process.exit(1);
  }
  // `--generate` may be bare, so `val()` cannot refuse a missing value here — and what follows is
  // then the NEXT FLAG. `Number('--force')` is NaN, the stride is NaN, the sample loop never runs,
  // and `--generate --force` wrote an EMPTY case set over a real one and exited 0. A count is
  // either a positive number or absent; anything else is a typo worth stopping for.
  const count = val('--generate', true);
  const n = !count || count.startsWith('--') ? 40 : Number(count);
  if (!Number.isInteger(n) || n < 1) {
    console.log(`--generate takes a positive count, got: ${count}`);
    process.exit(1);
  }
  if (fs.existsSync(CASES) && !flag('--force')) {
    console.log(
      `${CASES} exists. Regenerating invalidates every past number — pass --force if that is what you want.`,
    );
    process.exit(1);
  }
  const notes = allNotes();
  // Deterministic sample: sort by name and stride. Math.random would make the set unreproducible,
  // which is the exact failure this harness exists to fix.
  notes.sort((a, b) => (a.note < b.note ? -1 : 1));
  const stride = Math.max(1, Math.floor(notes.length / n));
  const cases = [];
  for (let i = 0; i < notes.length && cases.length < n; i += stride) {
    const nt = notes[i];
    const q = pickSentence(evalBody(fs.readFileSync(nt.file, 'utf8')), nt.note, STYLE);
    if (q) cases.push({ q, gold: [nt.note], layer: nt.layer, style: STYLE });
  }
  fs.writeFileSync(CASES, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
  console.log(`${cases.length} cases (${STYLE}) → ${CASES}`);
  console.log('Gitignored by the deny-by-default rule: these contain vault content.');
  console.log(
    '\n⚠ These are EXTRACTED SENTENCES, not paraphrases — the note contains them verbatim,',
  );
  console.log(
    '  so BM25 finds them trivially (2026-08-15 real-vault set: lexical recall@1 97.5% vs semantic 62.5%;',
  );
  console.log(
    '  the lexical arm has since moved to the shared tokeniser: -5 points recall@1 on',
    '  cases-paraphrase, 55.0% -> 50.0%, seed-7 bench vault; cases-keyword unchanged).',
  );
  console.log(
    '  Useful as a lexical-recall floor and an index-coverage check; NOT a paraphrase test.',
  );
  console.log('  For that, author real questions and pipe them to --author.');
  process.exit(0);
}

// ---------------------------------------------------------------- run

if (!flag('--run')) {
  console.log('usage: --generate N [--style semantic|keyword] | --run [--mode semantic|lexical]');
  process.exit(1);
}
if (!fs.existsSync(CASES)) {
  // --author, not --generate: `--generate` emits extracted sentences, which commands/eval.md calls
  // useless as a paraphrase test. Pointing the two branches at different tools taught half the
  // callers the wrong one.
  console.log(`no case set at ${CASES}. Author one first: --author (see /memory:eval)`);
  process.exit(1);
}
// existsSync is true for a directory, and readFileSync then threw EISDIR with a stack. A mistyped
// --cases is bad input, not a crash. Testing for a DIRECTORY rather than for a regular file, so
// `--cases <(jq …)` and `--cases /dev/stdin` — a pipe and a character device — still work.
if (fs.statSync(CASES).isDirectory()) {
  console.log(`${CASES} is a directory. --cases takes a .jsonl case set.`);
  process.exit(1);
}
const casesText = fs.readFileSync(CASES, 'utf8');
// A set that no longer hashes to its sidecar is not this set.
const sidecar = `${CASES}.sha256`;
let frozen = null;
if (fs.existsSync(sidecar)) {
  // Unreadable or a directory is bad input, the way a mistyped --cases is.
  let want;
  try {
    want = fs.readFileSync(sidecar, 'utf8').trim();
  } catch (e) {
    console.log(`${sidecar} exists but cannot be read: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  const got = casesHash(casesText);
  frozen = got;
  if (want !== got) {
    console.log(
      `${CASES} has changed since it was frozen.\n  frozen ${want}\n  now    ${got}\n` +
        `Every number quoted against the frozen hash was measured on different questions. Re-freeze with --freeze --force if the edit was intended.`,
    );
    process.exit(1);
  }
}
const cases =
  /** @type {{ q: string, gold: string[], owner?: string, layer?: string, style?: string }[]} */ (
    parseJsonl(casesText, CASES)
  );

// A line with no gold array is not a case. goldCoverage skips them, so a file of three good cases
// and one truncated line passed coverage as `ok` and then killed the scorer on `c.gold.includes`.
// Refuse the file: half a case set cannot produce a number anyone should read.
// Both fields, matching --author. Guarding `gold` alone left a line with gold and no question
// reaching the scorer, which then threw on `c.q` — the same crash one field over. What counts as a
// question is `isQuestion()` above; a number from no question is the thing this guard refuses,
// whether it arrives by a wrong corpus or by a blank line.
const malformed = cases.filter((c) => !isQuestion(c.q) || !Array.isArray(c.gold)).length;
if (malformed) {
  console.log(
    `${malformed} of ${cases.length} case lines are missing a question or a gold array — truncated or malformed. Refusing to report a number.\n` +
      `  case set: ${CASES}`,
  );
  process.exit(1);
}

// Refuse a case set that is not about this vault — why, and the measurement, in `goldCoverage`.
const known = new Set(allNotes().map((n) => n.note));
// Nothing to score against at all. Diagnosed before coverage, because zero resolvable gold is a
// property of the VAULT here, and the mismatch branch below would blame the case set for it.
if (!known.size) {
  console.log(
    `no notes for ${SLUG} in ${VAULT} — nothing to score against.\n` +
      `Check --vault/--slug, or sync the vault before scoring.`,
  );
  process.exit(1);
}
const cov = goldCoverage(cases, known);
if (cov.verdict === GOLD.mismatch) {
  // Both tests, because either alone reintroduces the other's bug. The path says WHETHER an
  // override matters — `--cases <the scoped path>` is not one, and "drop it" hands back the same
  // file. The flag says WHICH to name — `--out` overrides too.
  const override =
    CASES === SCOPED_CASES ? null : (['--cases', '--out'].find((f) => val(f)) ?? null);
  const fix = !override
    ? `This IS ${SLUG}'s own set, so the vault has moved out from under it. Re-author it with --author.`
    : `Drop ${override} to use this project's own set: ${SCOPED_CASES}\nAuthor one with --author if it does not exist yet.`;
  // An empty or gold-less file is a mismatch by the same arithmetic, but calling it another vault's
  // case set would be a false diagnosis of a truncated or half-written one.
  const why = cov.total
    ? `${cov.resolved}/${cov.total} gold notes in this case set exist in ${SLUG}'s vault — under the ${Math.round(GOLD_FLOOR * 100)}% floor.\n` +
      `That is a case set built from a DIFFERENT vault, not a bad score. Refusing to report a number.`
    : `This case set names no gold notes at all — it is empty, truncated, or malformed. Refusing to report a number.`;
  console.log(`${why}\n  case set: ${CASES}\n${fix}`);
  process.exit(1);
}
if (cov.verdict === GOLD.churn)
  console.error(
    `warning: ${cov.total - cov.resolved}/${cov.total} gold notes no longer exist (pruned?). Scoring the rest; every missing one counts as a miss.`,
  );

const mode = val('--mode') || 'semantic';
// A rank-window intervention (reserved slots, re-ranking) is invisible when the harness fetches a
// wider window than a session does: promoted items sort to the bottom by score, so scoring @5 from
// a k=10 fetch shows nothing at @5. --fetch-k measures what the caller actually sees; only ks up to
// it are reported, since a k=5 fetch cannot answer @10.
// Validated like --generate, and for the same reason: `--fetch-k abc` made K NaN, which emptied KS,
// which printed no recall bars at all while `--json` still reported every k as 0 and exited 0. An
// all-zero number attributed to a named case set is the failure this whole guard exists to stop.
const K = Number(val('--fetch-k') || Math.max(...RECALL_KS));
if (!Number.isInteger(K) || K < 1) {
  console.log(`--fetch-k takes a positive whole number, got: ${val('--fetch-k')}`);
  process.exit(1);
}
const KS = RECALL_KS.filter((k) => k <= K);

// --min-rank1 turns a report into a GATE: below the floor the process exits non-zero. A percentage,
// to match how the numbers are quoted. Validated like --fetch-k: NaN would compare false and pass
// every run silently, which is the failure the flag exists to prevent.
const minRaw = flag('--min-rank1') ? Number(val('--min-rank1')) : null;
if (minRaw !== null && (!Number.isFinite(minRaw) || minRaw < 0 || minRaw > 100)) {
  console.log(`--min-rank1 takes a percentage between 0 and 100, got: ${val('--min-rank1')}`);
  process.exit(1);
}
const MIN_RANK1 = minRaw === null ? null : minRaw / 100;

/** @type {{ q: string, results: { note: string }[] }[]} */
let ranked; // [{q, results:[{note}]}]
if (mode === 'semantic') {
  const args = ['--json', '-k', String(K), repo];
  // Forward the vault override, or the child searches the REAL vault while this process scores
  // against the benchmark one — two different note sets, one silent mismatch.
  if (val('--vault')) args.push('--vault', /** @type {string} */ (val('--vault')));
  if (val('--slug')) args.push('--slug', /** @type {string} */ (val('--slug')));
  for (const c of cases) args.push('--query', c.q);
  const out = execFileSync('node', [path.join(paths.scriptsDir, 'memory-semantic.mjs'), ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  ranked = out
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
} else {
  // Lexical arm: a local BM25 stand-in, NOT ctx_search. It exists so a retrieval change can be
  // compared against a keyword baseline on the same cases inside one process. It does not reproduce
  // context-mode's ranking, and a number from it is not a claim about ctx_search — nor about the
  // recall hook, which scores a different document unit. See lexicalRank's comment.
  ranked = lexicalRank(
    allNotes().map((n) => ({ note: n.note, text: evalBody(fs.readFileSync(n.file, 'utf8')) })),
    cases.map((c) => c.q),
    K,
  );
}

const scored = cases.map((c, i) => {
  const res = ranked[i]?.results || [];
  return {
    q: c.q,
    gold: c.gold[0],
    layer: c.layer,
    rank: res.findIndex((r) => c.gold.includes(r.note)) + 1,
    // A pairwise case inverts what `gold` means — it names the note that must LOSE — so it is
    // scored by pairwise() and kept out of recall@k, where it would count as a miss by design.
    pair: c.owner ? pairwise(/** @type {{gold: string[], owner: string}} */ (c), res) : null,
    unscorable: unscorableReason(c, res, known),
    top1: res[0]?.note ?? null,
  };
});
const perCase = scored.filter((c) => !c.pair);
// Unscorable pairwise cases leave BOTH sides of the tally, or `gold: []` counts as a pass in the
// line people paste (`named` is Infinity, so `owner < named` is vacuously true).
const pairs = scored.filter((c) => c.pair && !c.unscorable);
const { recall, mrr } = metrics(perCase);
const misses = perCase.filter((c) => !c.rank);
const buried = perCase.filter((c) => c.rank > 3);
const unscorable = scored.filter((c) => c.unscorable);
const pairFails = pairs.filter((c) => !c.pair?.pass);
// Before either report branch: --json exits on its own, and an automated caller is the only caller
// a gate is for.
const failures = gateFailures({
  recall1: recall[1],
  minRank1: MIN_RANK1,
  unscorable: unscorable.length,
  pairFails: pairFails.length,
  recallCases: perCase.length,
});

// Every semantic number is model-dependent, so the model IS part of the measurement. Reporting a
// recall figure without it is the provenance gap CLAIM-1 exists to catch.
const model = mode === 'semantic' ? activeModel() : 'bm25';
if (flag('--json')) {
  console.log(
    JSON.stringify(
      // goldResolved/goldTotal: the churn warning is stderr prose, so a machine reading this
      // envelope could not tell a full case set from one a prune had eaten a quarter of.
      {
        cases: CASES,
        kind: REPORTED_KIND,
        mode,
        model,
        fetchK: K,
        n: perCase.length,
        goldResolved: cov.resolved,
        goldTotal: cov.total,
        // KS, not every k. The comment on KS says a k=5 fetch cannot answer @10 — and the human
        // path honours that while this one printed the lot, so `--fetch-k 3 --json` reported an
        // @5 and an @10 that were @3 censored to the window. Indistinguishable from a measurement
        // to whatever reads this, which is the whole failure #97 is about.
        // Omitted, never zero: metrics() divides by `|| 1`, so an all-pairwise set shipped
        // `recall: {1:0,…}` to a consumer that could not tell it from a measurement.
        ...(perCase.length
          ? { recall: Object.fromEntries(KS.map((k) => [k, recall[k]])), mrr: +mrr.toFixed(3) }
          : {}),
        // Its own key: a consumer must be able to tell a case that scored zero from one never
        // scored at all.
        unscorable: unscorable.length,
        // Null when no sidecar exists — deleting one un-freezes a set silently.
        frozen,
        pairwise: { total: pairs.length, failed: pairFails.length },
        gate: failures,
      },
      null,
      2,
    ),
  );
  process.exit(failures.length ? 1 : 0);
}
// A number whose set kind is unknown is not printable (#87).
console.log(
  `${perCase.length} cases · ${REPORTED_KIND} · style ${cases[0]?.style ?? '?'} · mode ${mode} · model ${model}`,
);
// Name the file the number came from, the way the `project:` echo names the vault. Every failure
// in #97 is a figure attributed to a case set nobody checked; a number printed beside its source
// cannot be silently misread, whatever routed us to the wrong one.
console.log(`  cases: ${CASES}`);
console.log(frozen ? `  frozen: ${frozen}` : '  frozen: no (this set is not pinned)');
// metrics() divides by `|| 1`, so an all-pairwise set rendered a bar chart no case contributed to.
if (!perCase.length) console.log('  no recall cases in this set — pairwise assertions only');
else {
  for (const k of KS)
    console.log(
      `  recall@${String(k).padEnd(2)} ${(recall[k] * 100).toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(recall[k] * 40))}`,
    );
  console.log(`  MRR      ${mrr.toFixed(3)}`);
  console.log(
    `  misses (gold absent from top ${K}): ${misses.length}   buried (rank>3): ${buried.length}`,
  );
}
// What beat the gold note is the diagnosis: a keyword magnet, a near-duplicate, or a better answer.
if (misses.length) {
  console.log('\nMisses — and what ranked #1 instead:');
  for (const m of misses.slice(0, 10))
    console.log(`  want ${m.gold}\n    got ${m.top1}\n    Q: ${m.q.slice(0, 90)}`);
}
if (buried.length) {
  console.log('\nBuried (found, but below rank 3):');
  for (const b of buried.slice(0, 8))
    console.log(`  rank ${b.rank}  ${b.gold}  (beaten by ${b.top1})`);
}
if (pairs.length)
  console.log(
    `\nPairwise (owner must outrank the named note): ${pairs.length - pairFails.length}/${pairs.length} passed`,
  );
// `absent` rather than `Infinity`: an owner that never appeared is a vocabulary gap, one that came
// second is a ranking gap, and they want opposite fixes.
const rankLabel = (/** @type {number} */ r) => (Number.isFinite(r) ? String(r) : 'absent');
for (const f of pairFails.slice(0, 8))
  console.log(
    `  owner ${rankLabel(f.pair?.owner ?? Infinity)}  named ${rankLabel(f.pair?.named ?? Infinity)}  Q: ${f.q.slice(0, 70)}`,
  );
// Named, not counted: a tally cannot be gone and looked at.
if (unscorable.length) {
  console.log(`\n${unscorable.length} case(s) could not be scored at all:`);
  for (const u of unscorable.slice(0, 10))
    console.log(`  ${u.unscorable}\n    Q: ${u.q.slice(0, 80)}`);
}
if (failures.length) {
  console.log(`\nGATE FAILED:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
