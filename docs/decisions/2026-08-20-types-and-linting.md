# JSDoc types with `checkJs --strict`, checked in CI; no linter

**Date:** 2026-08-20 · **Status:** shipped · **Closes [#35](https://github.com/spike1292/claude-memory/issues/35)**

## Question

Everything is plain `.mjs` with no type checking and no linter. Two questions, asked together
because the answer to the second turned out to depend on the first: adopt types, and if so which
form; and add a linter, and if so which rules.

## Answer

**Types: JSDoc + `checkJs` + `strict`, run as `tsc --noEmit` in CI. No build step, no `.ts`.**
**Linting: none.**

## What the measurements said

`tsc` was run over every non-test `.mjs` in `hooks/` and `scripts/` — 6737 lines — before any
annotation existed.

| Configuration | Diagnostics |
| --- | --- |
| `checkJs`, no strict | 34 |
| `checkJs` + `noUnusedLocals` | +15 |
| `strict` | 499 |
| `strict` with `noImplicitAny` off | 1 |

**`checkJs` alone found zero bugs.** All 34 were inference gaps, not defects: 14 `opts = {}` option
bags inferred as `{}`, 7 `node:sqlite` `SQLOutputValue` unions that do not narrow, 3 `err.code` on
`Error`, 3 `new Response(process.stdin)`, and 2 one-offs. A checker that finds nothing in six
thousand lines is not an argument for adopting it retrospectively; its whole value is prospective.

**The 15 unused-import diagnostics were all real.** `scripts/memory-semantic.mjs` imported `os`,
`net` and `MODELS` and used none of them; `scripts/lib/memory-audit-checks.mjs` imported `execSync`,
`path` and `paths` and used none; `scripts/lib/memory-synth-vault.mjs` imported `fs`, `path` and
`paths` and used none. They are deleted rather than suppressed.

**The last row is why `strict` is all-or-nothing here.** The obvious staging plan — turn on
`strictNullChecks` first, leave `noImplicitAny` for later — does not work. With `noImplicitAny` off
every value is `any`, so the null checks never fire and the count collapses from 499 to 1. The ~384
parameter annotations are the entry fee, and null safety only begins working after they are paid.
Do not re-propose partial adoption without new numbers.

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
version-pinned cache. The version is written in `package.json`'s scripts and in `ci.yml`; bump them
together.

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

## Found while annotating, not fixed here

Two pre-existing defects, both filed separately rather than smuggled into a typing pass:

- `scripts/memory-synth-vault.mjs` ignores `--notes` below the gold+echo count — the filler loop is
  `while (allNames.length < TOTAL)`, so a low `--notes` silently yields 120 notes.
- `report()` in `scripts/lib/doctor-perf.mjs` has an `= {}` default it cannot honour: `state` is used
  unguarded. Every caller passes the bag, so the default is unreachable and misleading.
