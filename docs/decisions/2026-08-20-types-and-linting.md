# JSDoc types with `checkJs --strict`, checked in CI; no linter

**Date:** 2026-08-20 · **Status:** shipped · **Amended the same day: TypeScript 7** · **Closes [#35](https://github.com/spike1292/claude-memory/issues/35)**

## Question

Everything is plain `.mjs` with no type checking and no linter. Two questions, asked together
because the answer to the second turned out to depend on the first: adopt types, and if so which
form; and add a linter, and if so which rules.

## Answer

**Types: JSDoc + `checkJs` + `strict`, run as `tsc --noEmit` in CI. No build step, no `.ts`.**
**Linting: none.**

## What the measurements said

`tsc` 5.9.2 was run over every non-test `.mjs` in `hooks/` and `scripts/` — 39 files, 6737 lines —
at the commit before any annotation existed. The repo has since moved to TypeScript 7; see the
amendment at the end for what those rows become, and why the decision does not change.

| Configuration | Diagnostics |
| --- | --- |
| `checkJs`, no strict | 34 |
| `checkJs` + `noUnusedLocals` | 48 |
| `checkJs` + `noUnusedLocals` + `noUnusedParameters` | 49 |
| `strict` | 484 |
| `strict` + both unused flags | 499 |
| `strict` with `noImplicitAny` off | 91 |
| `strictNullChecks` alone | 80 |

**`checkJs` alone found zero bugs.** All 34 were inference gaps, not defects: 14 `opts = {}` option
bags inferred as `{}`, 7 `node:sqlite` `SQLOutputValue` unions that do not narrow, 5 reads of a
union return in `doctor-perf` that had no annotation to narrow it, 3 `err.code` on `Error`, 3
`new Response(process.stdin)`, and 2 one-offs. A checker that finds nothing in six
thousand lines is not an argument for adopting it retrospectively; its whole value is prospective.

**The 15 unused-symbol diagnostics were all real** — 14 dead imports and one unused parameter. The
imports: `os`, `net` and `MODELS` in `scripts/memory-semantic.mjs`; `path`, `paths` and `STOP` in
`scripts/lib/memory-semantic.mjs`; `execSync`, `path` and `paths` in
`scripts/lib/memory-audit-checks.mjs`; `fs`, `path` and `paths` in
`scripts/lib/memory-synth-vault.mjs`; `assert` and `fileURLToPath` in
`hooks/lib/distill-session.mjs`. All deleted rather than suppressed.

**Staged adoption was possible and was declined, not ruled out.** `strictNullChecks` without
`noImplicitAny` is 80 diagnostics, 32 of them genuine null-safety codes (TS18047, TS2532, TS2531,
TS18048) — real findings, reachable without writing a single parameter annotation. Full `strict`
was taken anyway because it was what the issue asked for and because the staged path leaves the 348
parameters and binding elements that `strict` reports as implicitly `any` (TS7006, TS7031) that way
indefinitely, which is the state that made the null checking worth having in the first place. Anyone re-opening this should know the cheap door existed.

> An earlier draft of this record claimed that row was **1**, and argued from it that no partial
> adoption was possible. That number came from a malformed `tsc` invocation whose single
> diagnostic was `TS5023: Unknown compiler option` — the measurement never ran. Caught in local
> review before merge. Every row above was re-measured with a verified binary and a check that no
> diagnostic was an invocation error.

## Why not real TypeScript with a build

A `dist/` would change how the plugin ships. Files are loaded straight from a version-pinned cache
dir; `hooks/hooks.json` and `commands/*.md` name entry paths as a contract, and nothing resolves an
absolute install path — bash uses `BASH_SOURCE`, Node uses `import.meta.url`. A build step puts a
compiled file where those two expect a source file, and `release.sh` and the slim-install path both
grow a stage. That is a large change to buy checking that, measured above, found no existing bug.
JSDoc keeps every source file directly runnable, which is what the hooks actually do.

## Why no linter

The issue named three candidate rules. Measured against them:

- **Unused imports and variables** — `tsc --noUnusedLocals --noUnusedParameters` already does this,
  with no new tool. It is what found the 15 above.
- **Top-level side effects in `hooks/lib`** — already a CI check, and a more specific one than a
  lint rule: it imports each module under a deliberately invalid model and fails on any output at
  all, which is the failure mode that shipped on 2026-08-19.
- **`no-floating-promises`** — the one with real value, since hooks detach and fail silently by
  design. It needs type-aware linting, so it is downstream of the types decision, not independent
  of it. Worth revisiting now that type information exists; it was not worth a dependency before.

One rule out of three does not pay for ESLint, oxlint or Biome.

## How it is wired

`tsconfig.json` exists only for `tsc --noEmit`: `allowJs`, `checkJs`, `strict`, `noUnusedLocals`,
`noUnusedParameters`, over `hooks/`, `scripts/` and `stubs/`, tests included.

`tsc` is pinned and run through `npx`, never a devDependency, for the same reason Prettier is —
Claude Code runs `npm ci` on plugin install, and a devDependency would ship into every user's
version-pinned cache. Unlike Prettier, whose pin `ci.yml` also names, the `tsc` version lives in
`package.json`'s scripts and nowhere else.

A second step asserts that every tracked `.mjs` appears in what `tsc` actually checked, compared
against `git ls-files` rather than a hardcoded number. An include glob that stops matching would
otherwise make this check pass by checking nothing, which is a failure this repo has shipped twice.

The check runs in the `install` job rather than `test`, because that is the only job that does a
real `npm ci`. **`@types/node` is not a declared dependency** — it arrives transitively with
`@huggingface/transformers`, and it is what makes `import fs from 'node:fs'` check at all. That is
load-bearing but not fragile in a silent way: if the dependency ever stops carrying it, every file
fails at once rather than the check quietly passing against nothing.

## What the annotation pass was allowed to do

Annotation only — no runtime behaviour was changed, and no constant, threshold or query was touched.
A diagnostic that could only be silenced by changing behaviour was left and reported instead. Four
`@ts-expect-error` are in the tree, each with a one-line reason: three for `new Response(process.stdin)`
(Node's undici accepts a `Readable`; the DOM `BodyInit` type does not) and one for a dynamic
`import()` of a `URL`, which Node supports and TypeScript rejects. No `@ts-ignore` and no
`@ts-nocheck`.

The largest single win was not a cast. `plan()` and `gatePlan()` in the hook modules returned object
literals whose discriminant widened to `string`/`boolean`, so TypeScript merged the branches and
made `message`, `lock`, `marker`, `claude`, `args` and `transcript` all possibly-`undefined` at
every call site — 13 diagnostics from one root cause. Annotating them as proper discriminated unions
restored narrowing and all 13 went away with no assertion anywhere. That is the shape of value this
check adds: it makes a return type that was accidentally vague into one that is stated.

## Where a cast was hiding a real defect, the defect was fixed

"Annotation only" holds everywhere except three places, and the exception is deliberate: a cast that
silences a live bug is worse than the bug, because it moves a real possibility out of sight and
tells the next reader the type system checked it. Local review found all three.

- `report()` in `scripts/lib/doctor-perf.mjs` timed the recall round trip twice and cast the second
  probe to the success shape. The second probe can fail on its own — the server may exit or evict
  the socket between the two — and `undefined.toFixed()` would have killed `/memory:doctor --perf`
  mid-report, in the one command someone runs when things are already wrong. It now prints what
  went wrong with the second probe instead.
- The same function could print `not measured: undefined`, since `ErrnoException.code` is optional
  and so is the field it lands in. Both optional, so the checker was satisfied.
- `assertVectorWidth()` in `scripts/lib/memory-semantic.mjs` read `r.vec.byteLength` behind a
  double cast through `unknown` — the strongest available "trust me", buying exactly the guarantee
  the type check was added to provide. A row arriving with no vector at all is the same corruption
  the function exists to catch, so it is now reported by the function's own message rather than
  throwing a TypeError one line earlier.

## Found while annotating, not fixed here

Two pre-existing defects, both filed separately rather than smuggled into a typing pass:

- `scripts/memory-synth-vault.mjs` ignores `--notes` below the gold+echo count — the filler loop is
  `while (allNames.length < TOTAL)`, so a low `--notes` silently yields 120 notes.
- `report()` in `scripts/lib/doctor-perf.mjs` has an `= {}` default it cannot honour: `state` is used
  unguarded. Every caller passes the bag, so the default is unreachable and misleading.

## Amendment: TypeScript 7

The pin moved from 5.9.2 to 7.0.2 the same day. TypeScript 7 is the native compiler — a Go
rewrite shipped as platform-specific binaries under `optionalDependencies`, the way esbuild does it.
On this tree it is a drop-in: zero diagnostics against the same `tsconfig.json`, `--listFiles`
unchanged so the coverage guard still works, and an identical message on a planted error. It is not
faster here in any way worth quoting — 61 files with `skipLibCheck` is ~0.15 s either way, and the
`npx` fetch dominates. Speed was not the reason; being on the supported line is.

**The platform binaries never reach a user.** That matters in this repo more than most, since
`slim-install.mjs` exists precisely because a dependency shipped every platform's native runtime in
one tarball. `tsc` is invoked through `npx`, so it lands in the npm cache and never in
`package.json`, never in the lockfile, and never in a version-pinned plugin cache.

Two behavioural differences found while migrating, neither of which changes anything here because
`tsconfig.json` was already explicit about both:

- **`strict` is on by default in 7.** The explicit `"strict": true` is now redundant and stays
  anyway: it states the intent, and it does not silently follow a future change of default.
- **`"types"` is load-bearing where it used to be optional.** Without `"types": ["node"]`, 7 does
  not pick up `@types/node` from `node_modules/@types` the way 5 did, and reports
  `TS2591: Cannot find name 'process'` on nearly every file. Ours sets it, and the case this repo
  actually cares about — `@types/node` ceasing to arrive transitively — still fails loudly:
  `TS2688: Cannot find type definition file for 'node'`, exit 1, verified rather than assumed.

The table above was measured with 5.9.2 and is left as it was taken. Under 7.0.2 the same tree gives
33 rather than 34 with strict off, 100 rather than 91 for strict-minus-`noImplicitAny`, and 89 for
`strictNullChecks` on top of an otherwise non-strict config. The decision rests on the shape — bare
`checkJs` finds no bugs, a staged path exists and was declined — and that shape holds on both
compilers.
