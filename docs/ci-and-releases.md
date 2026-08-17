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

- the self-tests on **Node 22** (the floor `engines` promises) **and 24**
- `bash -n` over every shell file
- **no Python dependency** — fails on any `.py` file or shell script calling `python`
- **version agreement** across all four places it is written: `package.json`,
  `.claude-plugin/plugin.json`, and both `.metadata.version` and `.plugins[0].version` in
  `.claude-plugin/marketplace.json`

CI builds a **synthetic** vault with `memory-synth-vault.mjs` first, never a real one. That is not
optional: `memory-semantic.mjs --selftest` asserts against real notes on purpose and hard-fails
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

### A PR that edits a workflow file does not get reviewed

`claude-code-action` runs only when the workflow is byte-identical to the copy on the default
branch — otherwise a PR could rewrite the workflow and steal the token. On a mismatch it logs a
warning and **exits success**, so the check is green and no review exists.

Confirm with `Exiting due to workflow validation skip` in the job log before investigating anything
else.

Consequence worth planning around: **CI changes are exactly the changes that never get a second
reader.** Review those by hand.

## Releasing

Changelog entries land with the change, under `## [Unreleased]` in `CHANGELOG.md` — Keep a
Changelog format. The release notes are generated from that section verbatim, so it is the only
place the story gets written.

```bash
scripts/release.sh 0.1.4      # bumps all four versions, closes Unreleased, opens the PR
# merge the PR, then:
git switch main && git pull
git tag v0.1.4 && git push origin v0.1.4
```

**The tag publishes, not the merge.** `.github/workflows/release.yml` checks the tag against
`package.json`, extracts that version's changelog section, and creates the GitHub release from it.

Never bump versions by hand — `scripts/release.sh` writes all four and CI fails the PR if they
disagree.
