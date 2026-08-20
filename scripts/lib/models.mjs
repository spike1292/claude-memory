// Model profiles, in a module of their OWN and not beside the resolver that uses them.
//
// memory-semantic.mjs resolves the active model at import time and calls process.exit(1) when it
// does not know it, so importing that file just to read the key list takes any caller down with a
// bad config value — which is exactly when a diagnostic is being run. Same reason lexical.mjs was
// split out for the recall hook. This file resolves nothing and must stay that way.

// Model profiles. Embedding models are asymmetric in different ways — BGE-en wants an instruction
// on the query only, E5 wants `query:`/`passage:` on both sides, bge-m3 wants neither. Getting the
// prefix wrong degrades retrieval silently, so it belongs with the model, not in a comment.
// Override with MEMORY_SEMANTIC_MODEL=<key>.
// BATCH SIZE IS 1 FOR EVERY MODEL, deliberately — verify with `--check-embedding`.
// Batching pads each text to the longest in its group and the padding CHANGES the output. Measured
// 2026-08-15, same string alone vs batched: bge-m3 cosine 0.986, bge-small 0.9966, e5 0.9973 — all
// three fail. Competing notes in this index sit ~0.001 apart, so a 0.014 shift does not perturb a
// ranking, it decides one, and a vector's value came to depend on which unrelated notes shared its
// batch. It surfaced as two rebuilds of BYTE-IDENTICAL notes scoring differently and was one
// sentence away from being written up as "run-to-run noise" — which would have set a permanent fake
// noise floor under every future A/B. Batching also loses on speed with real notes (0.14 s/chunk
// unpadded vs 0.28), because padding makes short chunks cost as much as the longest one beside them;
// the benchmark that said otherwise used equal-length strings, which never occur in a vault.
export const MODELS = {
  // `dupeMin` is model-specific and NOT transferable: E5 packs everything into a high, narrow band,
  // so bge-small-en's 0.86 reports 29,560 pairs under e5-multi — noise that looks like a backlog.
  // Mean, NOT cls — measured, against the model card. BGE-v1.5 is documented as CLS-pooled, but on
  // the 28-case EN set cls scores @1 21.4% / MRR 0.337 against mean's 32.1% / 0.415. Whatever the
  // Xenova q8 export does, it is not what the card describes. Do not "fix" this to cls.
  'bge-small-en': {
    id: 'Xenova/bge-small-en-v1.5',
    dim: 384,
    maxChars: 1800,
    pool: 'mean',
    q: 'Represent this sentence for searching relevant passages: ',
    d: '',
    dupeMin: 0.86,
    clusterMin: 0.8,
  },
  // Multilingual, same 384 dims. Better Dutch at k>=3 (NL @5 66.7% vs bge's 40.0%) but a large
  // English regression (@1 10.7% vs 32.1%): its similarity band is compressed, so ranking barely
  // discriminates. Available for Dutch-heavy work; not the default.
  'e5-multi': {
    id: 'Xenova/multilingual-e5-small',
    dim: 384,
    maxChars: 1600,
    pool: 'mean',
    q: 'query: ',
    d: 'passage: ',
    dupeMin: 0.95,
    clusterMin: 0.92,
  },
  // 1024-dim multilingual. The 2026-08-15 "disqualified on cost" verdict was measuring my own
  // chunking, not the model: maxChars was 4000 here against 1800 everywhere else, and m3 accepts
  // 8192 tokens where bge-small truncates at 512 — so m3 alone actually processed the long tail,
  // at quadratic attention cost. Benchmarked at EQUAL length it is 9.6x bge-small (384ms vs 40ms
  // per 1800-char text), below its 17x parameter ratio. Aligned to 1800 so the A/B varies the
  // model and nothing else.
  //
  // dupeMin/clusterMin MEASURED 2026-08-17, and they were badly wrong before that: they had been
  // copied from e5-multi (0.95/0.92) and never calibrated, which made both scans report a clean
  // vault. Sweep over the 74-note claude-memory Insights set, against which a /memory:health audit
  // had already hand-identified 16 same-lesson pairs:
  //
  //   --dupes --min   0.95  0.90  0.86  0.84  0.80  0.75      --clusters --min  0.92 .. 0.76  0.72
  //   pairs              0     0     1     6     9    16      topics               0 .. 0       2
  //
  // Real duplicates occupy 0.75-0.869; the first coincidental pair appears at 0.714. m3's band sits
  // LOW and wide, the opposite of e5-multi's high narrow one — which is exactly why the number does
  // not transfer, in either direction. At 0.95 the scan found 0 of 16.
  //
  // clusterMin 0.72 is its own measurement, not dupeMin scaled: at 0.76 and above --clusters
  // returned nothing, at 0.72 it surfaced two real uncovered topics (shell-vs-Node fork cost;
  // conventional-commit version derivation), both with a typical-member similarity of ~0.89.
  //
  // Two real duplicates in that set scored BELOW 0.70 and no threshold would have found them; they
  // were caught by reading. This scan proposes, the human judges — do not read a clean run as proof.
  'bge-m3': {
    id: 'Xenova/bge-m3',
    dim: 1024,
    maxChars: 1800,
    d: '',
    q: '',
    pool: 'cls',
    dupeMin: 0.75,
    clusterMin: 0.72,
  },
};
