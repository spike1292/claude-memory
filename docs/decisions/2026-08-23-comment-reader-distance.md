# Where a comment lives: reader distance, not line count

**Date:** 2026-08-23 · **Status:** policy, adopted; the sweep it governs is #36 PR 2

## Question

Several Node modules carry multi-paragraph comment blocks that are really design notes. They are
read on every edit, they drift from the code, and some of what they hold already exists in
`docs/architecture.md` or `docs/decisions/`. #36 opened with a length rule — *no block longer than
~6 lines survives without a docs pointer*.

That rule is wrong for this repo, and the reason is measurable rather than a matter of taste.

## Why length was rejected as the test

Long blocks here are not padding. They are where the measurements live, because a number needs its
conditions beside it and the conditions are prose. Sorted by length, the tree's longest blocks are
its most load-bearing:

| lines | block | what it holds |
| ---: | --- | --- |
| 54 | `scripts/lib/memory-synth-vault.mjs:2` | the seed-7 baseline table, a failed hardening attempt, and the reason the English set is at its ceiling and must not be quoted as evidence |
| 41 | `hooks/lib/hook-io.mjs:487` | the six-row before/after bench for adding `logHook()`, the 14.6 ms worktree exception, and a `ponytail:` marker naming its ceiling |
| 39 | `scripts/lib/memory-semantic.mjs:2` | the model comparison, and which rows are no longer comparable |

A length rule deletes those first, and CLAUDE.md says why that is a loss: *several surviving
comments are the only record of a silent failure.* Meanwhile a 5-line block restating the loop below it
passes untouched. **Length correlates with value here, not against it.**

The count, with its conditions, because a rule justified by a number should be re-checkable:
`.mjs` files under `hooks/`, `hooks/lib/`, `scripts/` and `scripts/lib/`, `*.test.mjs` excluded, a
block being consecutive lines opening with `//`, `/*` or `*`, on `main` at `71b0543`, 2026-08-23 —
**285 blocks of 6 lines or more, 129 of 11 or more, 3318 comment lines in them.** Discard every
block that opens with `/*` — JSDoc, whose scope is qualified below — and **118 of them are prose,
57 of those 11 lines or more, 1528 lines.** The triage brief on #36 quotes 123 and 48 over
`hooks/lib` + `scripts` alone; that is a third scope, and none of the three figures reproduces
another, which is the ordinary fate of a number quoted without the command that produced it.

```sh
# both counts, so the next person gets the same numbers or finds out why not
node -e 'const fs=require("fs"),p=require("path");const all=[],prose=[];
for(const d of ["hooks","hooks/lib","scripts","scripts/lib"])
for(const f of fs.readdirSync(d)){const q=p.join(d,f);if(!fs.statSync(q).isFile()||!f.endsWith(".mjs")||f.endsWith(".test.mjs"))continue;
let n=0,head=null;const flush=()=>{if(n>=6){all.push(n);if(!head.startsWith("/*"))prose.push(n)}n=0;head=null};
for(const l of fs.readFileSync(q,"utf8").split("\n")){const t=l.trim();
if(t.startsWith("//")||t.startsWith("*")||t.startsWith("/*")){if(head===null)head=t;n++}else flush()}flush()}
const r=b=>[b.length,b.filter(x=>x>=11).length,b.reduce((s,x)=>s+x,0)].join(" ");
console.log("all   ",r(all));console.log("prose ",r(prose))'
# all    285 129 3318
# prose  118 57 1528
```

## The rule: reader distance

A block's fate is decided by **who needs the fact, and when**. Three outcomes — plus a `pointer`
ledger row, below, for a reference that had to follow a moved block:

- **Stays** — someone editing *this function* needs the fact now, with the number at the reader's
  eye. One line is the target and not a cap, and the budget is per fact rather than per block: a
  mechanism that cannot be stated in one line without losing the mechanism keeps the lines it
  needs. `takeLock`'s inode re-check (`hooks/lib/hook-io.mjs:279`) is the shape — three lines, no
  number, and compressing it is how the next author rewrites it as unlink-then-create.
- **Moves** — the fact is only needed when *changing the design*: sweep tables, weighed
  alternatives, rejected approaches, historical A/B results, anything whose audience is a future
  author of this subsystem rather than its current editor.
- **Dies** — it restates the code, or restates a fact another comment already carries. Two
  comments stating one fact is the same drift as two records on one subject, one level down.

The test is not "is this true" or "is this interesting". It is: *does the next person to touch these
lines have to know it before they type?*

**JSDoc annotations are out of scope; prose inside a JSDoc block is not.** A `@param` restates the
code by design, and `tsc --noEmit` reads it — applying "dies" to the annotations would delete the
type checking. The exemption is for the annotations, **not for the delimiter**.

That matters because the scan classifies a block by its first line, so every prose-bearing JSDoc
block falls outside the 118 by construction. `trimLog` (`hooks/lib/hook-io.mjs:420`) is the shape:
30 lines, one `@param`, the rest design prose carrying `NOT ATOMIC, and deliberately not made so
(2026-08-19, raised twice in review of #24)` — which #36 names as load-bearing.
`hooks/lib/graph-staleness-check.mjs:198` is another 30 lines holding the deleted supervisor.

**So 118 is a floor on the worklist, not the worklist.** A sweep that runs the scan and stops has
skipped the block it was told to protect.

**A block may hold facts of different fates, and is then split rather than forced to one.** The
41-line block in the table above is the ordinary case: a bench table, a 14.6 ms worktree
measurement, and a `ponytail:` marker would not all land the same way — how they actually split is
PR 2's call, not this record's. The longest blocks are the most likely to be mixed, which is exactly
the set a sweep aims at. A split block gets **one ledger row per outcome** — a single row
claiming one outcome for a mixed block is how a moved fact goes missing.

## The tiebreak: fact type

Reader distance is a judgement call at the margin. When it is genuinely unclear, the shape of the
fact settles it:

- **A table, a sweep, or an argument against a rejected alternative always moves.** It is evidence
  for a decision, and a decision is not being made by the person reading the code.
- **A single measured number with its date always stays.** `scripts/lib/models.mjs:8` is both
  bullets at once, and splits cleanly: its three-model cosine sweep moves, while what it leaves
  behind is one line carrying one number and its date — `batch 1 for every model; padding shifts a
  vector 0.014 where competing notes sit ~0.001 apart (2026-08-15)`. That line stops a plausible
  optimisation before it is attempted; the sweep it came from could not, because nobody reads a
  sweep before editing a profile.

Both fire at once where the rejected alternative *is* the measurement — `hook-io.mjs`'s day-claim
block weighs three guards by the herds the first two caused. **Reader distance breaks the tie,
because it is the primary test and the tiebreak only exists for where it is silent.** Such a block
splits, and which half goes where is PR 2's call.

## Where moved text goes, chosen by tense

Two homes take almost all of it, and the choice is not free-form:

- **`docs/decisions/<date>-<slug>.md`** — a choice, with alternatives weighed and numbers behind it.
  Dated, superseded rather than edited, per the conventions in [docs/README.md](../README.md).
- **`docs/architecture.md`** — a live hack or a silent failure mode that is **still true right
  now**. It has the sections already: *Known hacks*, *Where failure is silent*, *Declined, and kept
  declined*. These are edited in place as the system changes, which is what a still-true fact needs
  and what a dated snapshot must not do.

Ask which tense the fact is in. "We measured A against B and chose B" is past, and dated:
`decisions/`. "This lock is global and a second writer would deadlock" is present, and stops being
true the day someone fixes it: `architecture.md`. **Tense outranks the two destinations' shapes**: a
post-mortem on a fixed defect weighs no alternatives and may carry no numbers, and it still goes to
`decisions/`, because it is past and the code no longer behaves that way. A standing instruction to
whoever works here next — "assume a new check is miscalibrated until its output has been read line
by line" — is neither past nor a property of the code, and goes to `CLAUDE.md`: a rare third target,
and one to reach for sparingly, since that file loads into every session.

**Group by subject, not by block.** Six to ten subjects cover the tree — retrieval gates and
thresholds, log trimming and detachment, synthetic-vault eval design, model profiles, path and
project-key resolution, install slimming. Where a record or an `architecture.md` section already
covers the subject, **append to it**; a second file on the same subject is the drift this rule
exists to stop, relocated. One subject may legitimately land in *both* homes when its facts split by
tense — `lexical.mjs`'s header holds a past measurement and a still-true import ban. That is not the
duplication the paragraph forbids; two records in `docs/decisions/` on one subject is.

**"This function" means the smallest thing the fact governs** — this function, this constant, this
profile, this file. Much of the tree is not a comment above a function: 36 of the 285 open at line 1
or 2 and are file headers, including two of the three in the table above, and others sit above a
`const`, a profile literal or a branch. Read the test against whatever the fact is about, and what
stays above a file is allowed to remain a header — a module-wide invariant has nowhere else to sit.

## The line left behind

A pointer carries the fact. Both of these are acceptable:

```js
// ponytail: gate is corpus-scaled, ~14 halves false fires — docs/decisions/<record>.md
// gate at 6.0; sweep in docs/decisions/<record>.md
```

A bare `// see docs/...` is **not**. It makes the reader open a file to learn a number, so the
common case pays the full cost of the move and gets none of its benefit — and a pointer nobody
follows is how the code and the doc start disagreeing without anyone noticing. Where the code has a
real ceiling, the line is a `ponytail:` marker naming that ceiling and its upgrade path; 14 in the
scope above already read that way, 17 across tracked `.mjs` and `.sh` (2026-08-23).

**Pointers run the other way too, and moving a block breaks them silently.** `CLAUDE.md:271` reads
"the numbers are in `hook-io.mjs` — do not replace this one without reading them". Move those
numbers and that sentence points at nothing, which is the same failure as a bare `// see docs/...`
with the arrow reversed. Before a block moves, grep for the file and the subject across `CLAUDE.md`,
`docs/`, `README.md`, `.github/workflows/claude-review.yml` **and the other modules** — comments
already point at comments (`scripts/lib/memory-semantic.mjs:339` cites `prune-logs.mjs`'s header,
`hooks/memory-recall.mjs:172` cites `hook-io.mjs`'s), so one PR can break its own pointer. **Update
every inbound reference in the same PR**, as a `pointer` ledger row. That is a fourth row type
where #36 lists three outcomes, and deliberately: a reference is not a block, so it has no
stay/move/die verdict and no destination text. A reference the sweep did not know about is the one
that rots.

## No CI guard

**Superseded 2026-09-05 by [2026-09-05-prose-ceiling.md](2026-09-05-prose-ceiling.md):** CI now fails
when comments outnumber code in a file a change touches. The objection below still stands and is
what shapes the fix — a fact worth keeping is MOVED to a doc, never deleted.

Declined, deliberately. A check that fails on long blocks fights the load-bearing comments forever,
and the first three rows of the table above are exactly what it would fire on. **The ledger is the
check** — one row per outcome: module, subject, outcome, destination, with a `pointer` row carrying
the reference's `file:line` and the block it now points at. A one-time artefact for a one-time
sweep.

## Consequences

New code is written to this rule, which is the point — the sweep is a one-off, the regrowth is not.
One thing follows that is worth stating on its own: **a doc target must be chosen before the text is
cut**, not after. Text deleted with "this is in the docs somewhere" is text lost, and the sweep's
ledger names the destination per row for that reason.
