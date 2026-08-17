# CI, review, and releases

## Branching

**`main` is protected. Never commit or push to it directly** — branch, push, open a PR, merge.
Enforced for force-pushes and for admins; GitHub rejects the push.

```bash
git switch -c fix/short-description
# ... work, then:
git push -u origin HEAD && gh pr create --fill
```

Zero approvals are required, because a solo owner cannot approve their own PR. The review workflow
below is what stands in for a second reader — it comments, it never approves.

## CI

`.github/workflows/ci.yml`, required to merge:

- `node --test --test-concurrency=1` on **Node 22** (the floor `engines` promises) **and 24**.
  Discovery, not a list — every `*.test.mjs` runs, so a new test file cannot be left out. Pinned to
  one worker because the suites share `$CLAUDE_MEMORY_HOME` and one test needs two git writes inside
  the same second; in parallel those pass for the wrong reason.
- **`lib/` modules import without side effects** — each is imported in a bare subprocess and must
  print nothing. A module that runs its hook on import turns any test that imports it into a live
  hook run: reading stdin, spawning a headless `claude`, writing notes. That was a real bug three
  times, which is why it is now a check rather than a convention.
- **`node:test` is imported only by `*.test.mjs`** — a top-level `node:test` import prints the whole
  test report to stdout even outside the runner, and Claude Code reads hook stdout.
- **`node:sqlite` is imported only by entry points** — the entry owns the handle; a `lib/` module
  that opens a database cannot be tested without one. The side-effect check above cannot catch this,
  because it suppresses `ExperimentalWarning` precisely because `node:sqlite` emits one, so such an
  import would pass silently. Matches the import, not the string: both `lib/` files mention
  `node:sqlite` in prose.
- `scripts/release.sh --selftest` (bash, 13 cases — `node --test` cannot run it)
- `bash -n` over every shell file
- **no Python dependency** — fails on any `.py` file or shell script calling `python`
- **version agreement** across every place it is written: `package.json`, `package-lock.json`,
  `.claude-plugin/plugin.json`, and both `.metadata.version` and `.plugins[0].version` in
  `.claude-plugin/marketplace.json`

CI builds a **synthetic** vault with `memory-synth-vault.mjs` first, never a real one. That is not
optional: `scripts/lib/memory-semantic.test.mjs` asserts against real notes on purpose and hard-fails
when it matches none, so an empty CI run would be an error rather than a skip.

## Review

Two Claude workflows, deliberately not three:

- **`claude-review.yml`** reviews every PR. Its prompt carries this repo's invariants — **when a
  rule changes, change it there too.** Skips fork PRs, which get no secrets on a `pull_request`
  trigger.
- **`claude.yml`** answers `@claude` mentions on issues and PR comments. Complementary, not a
  reviewer.

`/install-github-app` also generates **`claude-code-review.yml`**, a second auto-reviewer on the
same trigger. It was deleted — two reviewers means two reviews on every PR. **Re-running the
installer brings it back**; delete it again, or delete `claude-review.yml` and accept a generic
prompt.

Both authenticate with `CLAUDE_CODE_OAUTH_TOKEN` (a Claude subscription), not `ANTHROPIC_API_KEY`.
A workflow whose guard names a different secret than the action consumes will skip forever *and
report success* — that happened here, and the skip guard hid it.

### A PR that edits `claude-review.yml` does not get reviewed

`claude-code-action` runs only when **its own** workflow file is byte-identical to the copy on the
default branch — otherwise a PR could rewrite the workflow and steal the token. On a mismatch it
logs a warning and **exits success**, so the check is green and no review exists.

Confirm with `Exiting due to workflow validation skip` in the job log before investigating anything
else.

**The check is per-file, not per-PR** — corrected 2026-08-17, having first been written down the
broader way. Evidence: #2 and #4 both touched `claude-review.yml` and were skipped; #6 changed
`ci.yml` and `release.yml`, did not touch the reviewer's own file, and got a full 3-minute review
that found two real defects. So only changes to `claude-review.yml` itself go unreviewed.

## Releasing

Changelog entries land with the change, under `## [Unreleased]` in `CHANGELOG.md` — Keep a
Changelog format. The release notes are generated from that section verbatim, so it is the only
place the story gets written.

```bash
scripts/release.sh          # version derived from the commits since the last tag
scripts/release.sh 0.3.0    # or state it outright
```

That opens a PR bumping every version field and closing `[Unreleased]`. **Merging it publishes the
release** — `release.yml` sees a version on `main` with no release yet, creates the tag, and
publishes the `[0.3.0]` changelog section as the notes. No manual tagging.

### How the version is chosen

From the conventional commits since the last tag, so the number follows from the work:

| in the range | bump |
| --- | --- |
| any `!:` or `BREAKING CHANGE`, at 1.0 and above | major |
| any `!:` or `BREAKING CHANGE`, below 1.0 | minor — semver lets 0.x change anything |
| any `feat:` | minor |
| anything else (`fix`, `perf`, `chore`, `docs`, `ci`) | patch |

`scripts/release.sh --selftest` covers each path with throwaway git repos — 13 cases, including
that `feat:` must be anchored at the start of a subject, that `perf:` is not a feature, that
`0.2.10` bumps to `0.2.11` numerically rather than by string, and that the 0.x carve-out stops
applying at 1.0 (`1.2.9` + a breaking change is `2.0.0`, not `1.3.0`).

### Deliberately not release-please or semantic-release

Both generate the changelog from commit subjects. Here **the changelog is the release notes** —
hand-written, and the only place the reasoning behind a change is recorded. v0.2.0's notes run to
97 lines of *why*; the equivalent generated list would be a dozen commit titles. Deriving the
version number is useful. Generating the prose would be a downgrade.

### Escape hatch

Pushing a `v*` tag by hand publishes too, and is checked against `package.json` first. Useful for
re-cutting. Publishing is idempotent: the job runs on every push to `main` and does nothing —
about ten seconds — when the version already has a release.

Never bump versions by hand. `scripts/release.sh` writes all five fields (`package.json`,
`plugin.json`, two in `marketplace.json`, and `package-lock.json`) and CI fails the PR if they
disagree. `package-lock.json` sat at 0.1.0 through three releases before it was covered.
