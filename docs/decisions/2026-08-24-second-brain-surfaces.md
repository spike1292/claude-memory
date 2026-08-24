# The second brain is one folder with two surfaces

**Date:** 2026-08-24 · **Status:** accepted, unbuilt · Serves goal 2 of
[docs/plans/2026-08-23-agentic-os-setup.md](../plans/2026-08-23-agentic-os-setup.md).

## Decision

One folder of markdown in git, unchanged. Two ways to open it:

| Surface | Where | Job |
| --- | --- | --- |
| **Obsidian** | Mac, phone | Writing. The daily surface |
| **SilverBullet** | VPS, any browser | Phone and remote reading, live queries |

Both write to the same files, so neither is a second source of truth. `[[wikilinks]]` and YAML
frontmatter work in both, so the note protocol needs no change.

**Quartz is deferred** (owner, 2026-08-24), and not only for scope: SilverBullet already serves the
vault in a browser with bi-directional links, so Quartz's only unique contribution is a *public static
site* — which is also the single riskiest component here. Deferring it removes the leak surface and
costs nothing that is needed.

## Why the folder was never the thing to change

The word "Obsidian" was carrying two requirements. Separating them settles a question that kept
recurring:

- **The app** — editor, graph, mobile client. Replaceable. Foam, SilverBullet, Zettlr and others read
  the same files, and nothing in this system depends on which one is open.
- **A directory of plain markdown** — the actual requirement. It is what lets agents `grep` and `Read`
  notes with no API, what makes every write a commit, and what makes the work world deletable by
  removing directories.

The primary reader of this vault is not a person; it is four agents. A format only one application can
open is the wrong storage for an agentic OS, however good the application. That is why Trilium, SiYuan,
Joplin, AnyType, Notesnook, Outline and AFFiNE were all rejected despite better apps — each keeps its
own database.

[docs/research/2026-08-24-okf-and-llm-wiki-v2.md](../research/2026-08-24-okf-and-llm-wiki-v2.md)
sharpens this: Google's Open Knowledge Format v0.1 *is* a directory of markdown with YAML frontmatter.
The storage choice is now a standard, not a preference.

## When Quartz lands, these two things bite

Recorded now because they are easy to miss later and the failure is public.

**Its default filter publishes everything.** `RemoveDrafts` only withholds notes marked
`draft: true` — opt-out. Use **`ExplicitPublish`** instead, so a note leaves only with
`publish: true`. This vault holds private notes and, by an existing record, colleague names and
internal hostnames.

**Attachments leak past every filter.** From Quartz's own docs: *"Regardless of the filter plugin used,
all non-markdown files will be emitted and available publically in the final build"* — images, PDFs,
voice recordings. `ignorePatterns` must cover attachment folders separately. If client work ever
reaches this machine, point Quartz at a filtered export rather than at the vault.

**Wire it as `quartz/content` → the vault**, a symlink *into* the vault. Never a symlink placed inside
one — Synology Drive replaces those with empty directories and renames the original to a conflict file.

## Still open

1. **Capture.** Nothing gets an article, PDF or a phone thought into the vault today. Obsidian Web
   Clipper (MIT, official) writes markdown straight in and is the cheap answer. Karakeep is the better
   capture tool and keeps its own database, so it needs an export job before it qualifies.
2. **Does SilverBullet write index or state files into the space folder?** Not established from the
   docs. Run it for a day, then read `git status` and gitignore whatever appears.
3. **`publish: true` is a new frontmatter field.** Add it in the same pass as OKF's `tags` and
   `resource` rather than touching every note twice.

## Rejected, with the reason

| | Why not |
| --- | --- |
| Trilium · SiYuan · Joplin · AnyType · Notesnook | Own database. Agents cannot read the notes without an API |
| Outline · AFFiNE | Team wikis on Postgres. Same objection, plus a server |
| Foam | Genuinely fine — VS Code, same files, `[[wikilinks]]`. Loses only to Obsidian on preference |
| Logseq | Markdown, but imposes its own conventions on the files |
| Dendron | Unmaintained — last commit 2025-11-13 |
| Dataview | **Not rejected, but do not build on it.** Last commit 2025-11-17; its successor `datacore` has been quiet since June |
