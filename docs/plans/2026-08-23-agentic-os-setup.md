# Agentic OS: VPS brain box, vault over MCP, AFK software factory

**Status:** designed 2026-08-23, nothing built. Phase 0 not started.

This plan spans two repos on purpose. `docs/plans/` lives here because the memory layer is the
foundation and the first two build items are memory-layer work; the operational half moves to a new
private `agentic-os` repo once that repo exists. The split is marked per item below.

## What this is for

Five goals, stated by the owner:

1. Agents that review, research, triage, summarise, and do small tasks.
2. A personal second brain — personal research, personal backlog, a wiki.
3. An AFK software factory: agents pick up backlog work while the laptop is shut.
4. Remote access from laptop and phone.
5. Essent development, on the same machine but walled off.

Big refactors stay local on the Mac. That is not a goal for this system; it is a carve-out.

## Decisions already taken

These were settled in the design interview and are not open for re-litigation without new facts.

| Decision | Choice | Why |
| --- | --- | --- |
| This repo's scope | Memory layer only | Vault decision note `2026-08-22-be-the-memory-layer-not-the-agentic-os` — agentic OS is wrapper + automation + memory; this project is the third layer |
| Work/personal split | Shared machine, separate vaults | Cheaper than two boxes; the wall is process-level, not config-level |
| Always-on host | Hostinger VPS, Ubuntu 24.04, 16 GB | Must be publicly reachable; see the CoWork finding below |
| Vault sync | Private git repo, VPS canonical | Three writers now exist; git is the only sync that gives history and an undo |
| AFK factory | Claude Code native, not OpenHands | Reuses existing skills, hooks, plugin; the sandbox is already shipped |
| Personal content | Same vault, new top-level folders | One index, one connector, cross-links work |
| Visual wrapper | Deferred | Plumbing first |
| Personal backlog tool | Backlog.md | Acceptance criteria per task is what an AFK agent needs; ships an MCP server |
| First slice | Phase 0 + 1 | Everything else sits on it |

## The finding that forced the architecture

A Claude CoWork cloud session reaches your computer **only while the Claude Desktop app is open**.
That is incompatible with "laptop closed".

Custom connectors are the way through. They use remote MCP and work in claude.ai, Claude Desktop,
CoWork and the mobile apps. But Claude connects **from Anthropic's cloud, not from the device**, so
the MCP server must be reachable over the public internet. Servers behind a VPN or a home firewall
do not connect.

Three consequences:

- **The Synology NAS cannot serve CoWork.** It sits behind the home firewall. Dead end for goal 4.
- **Tailscale cannot serve CoWork either.** Tailscale stays, but only for SSH and dev-server preview.
- **A public HTTPS MCP endpoint on the VPS can.** One box then feeds phone, web, CoWork and Desktop.

A second finding cuts scope: **Remote Control opens no inbound ports.** The local session makes
outbound HTTPS requests and polls. So driving Claude Code on the VPS from a phone needs no VPN at
all. Domenic's setup routes phone traffic over Tailscale because it targets the ChatGPT/Codex app;
for Claude Code that hop is unnecessary.

## Topology

```
  Mac (lid closed OK)        Phone            Claude CoWork / claude.ai
        |                      |                        |
        |  Tailscale           |  Remote Control        |  public HTTPS
        +----------+-----------+  (outbound only)       |  from Anthropic's cloud
                   |                                    |
        +----------v------------------------------------v----------+
        |              HOSTINGER VPS  -  "the brain box"            |
        |                                                           |
        |  Caddy (TLS)  -->  /mcp   vault-mcp  <-- custom connector |
        |  Claude Code in tmux  (Remote Control on)                 |
        |  AFK runner: queue -> worktree -> claude -p -> PR         |
        |  ~/vault        git working copy, canonical               |
        |  ~/vault-essent git working copy, walled                  |
        |  claude-memory plugin + semantic index                    |
        +---------------------------+-------------------------------+
                                    | git push/pull
                        +-----------v-----------+
                        | GitHub private repos  |
                        |  vault, code, issues  |
                        +-----------------------+
                                    |
                        Synology NAS = backup mirror only
```

Four rules fall out:

1. **The VPS is the only always-on thing.** Mac and phone are windows onto it.
2. **Two doors, on purpose.** Tailscale is the private door for the human. Public HTTPS `/mcp` is the
   narrow door for Anthropic's cloud. Nothing else is public.
3. **Git is the sync.** Every vault write is a commit. A bad agent run is one `git revert`.
4. **Essent lives on the same box in its own world** — own vault, own repos, own index, own serve
   process, and never behind the public connector.

## Install, do not build

| Thing | Job | Note |
| --- | --- | --- |
| Hostinger VPS, Ubuntu 24.04, 16 GB RAM | The brain box | bge-m3 is ~1.3 GB resident before any agent runs |
| Tailscale | SSH and dev-server preview | Free tier |
| Caddy | TLS and reverse proxy for `/mcp` | Auto certificates |
| Claude Code + the `memory` plugin | Agent and memory | Same plugin, second machine |
| `bubblewrap` | Backs the Claude Code sandbox on Linux | `apt install bubblewrap` |
| GitHub private repos + Issues | Vault storage, code, code backlog | Five triage labels already exist |
| `gh` CLI | How agents read and write the backlog | |
| [gh-dash](https://github.com/dlvhdr/gh-dash) | Terminal board for issues and PRs | One tmux pane on the VPS |
| [Backlog.md](https://github.com/MrLesk/Backlog.md) | Personal backlog and agent work queue | MCP server, terminal + web kanban, MIT |
| chezmoi | Keeps `~/.claude` in step across Mac and VPS | |
| tmux | Sessions survive disconnect | |
| [last30days-skill](https://github.com/mvanhorn/last30days-skill) | Personal research agent | Drop-in, serves goal 2 on day one |
| [graphify](https://github.com/Graphify-Labs/graphify) *(optional)* | Wiki and graph from docs, SQL, PDFs | `--obsidian` and `--wiki` fit the vault |

**Do not build a sandbox.** Claude Code ships one: bubblewrap-backed on Linux, with filesystem and
network isolation, domain allowlists, `sandbox.credentials`, and `allowUnsandboxedCommands: false`.
The AFK-factory video's author hand-rolled a TypeScript sandbox because Docker was painful; that work
is now redundant.

## Build — four items, roughly 370 lines of code plus prose

### 1. `vault-mcp` — HTTP MCP server over the vault *(this repo)*

~150 lines. Nothing off the shelf serves the L1–L4 layers. `scripts/memory-semantic.mjs --serve`
already holds the model, answers per-slug queries, and caches indexes on demand; this is a thin
HTTP + MCP shell over that socket.

**Read-only in phase 1.** Bearer token. A deny-list that excludes `Personal/Private/` and every
Essent path. Writes are phase 5, after the door has been trusted for a while.

### 2. Vault auto-commit hook *(this repo)*

~20 lines. Every vault write becomes a commit and a push. This is what turns `git revert` into the
undo button, and it is the only reason the git-canonical decision pays for itself.

### 3. AFK runner *(new repo)*

~200 lines of glue. Queue, worktrees and sandbox are all off the shelf; the runner only joins them.
Detailed below.

### 4. `Personal/` conventions and 2–3 skills *(this repo)*

Prose, not code. Personal backlog, research-to-note, wiki upkeep. `/memory:protocol` already defines
the note rules; these add the folder layout and the skills that write into it.

## Backlog: two jobs, two tools

Backlog work is not one problem.

**Code backlog** stays on GitHub Issues — CI, PRs, the review workflow and the five triage labels
already live there. `gh` is the whole API an agent needs. `gh-dash` is the human view. GitHub
Projects v2 is scriptable through `gh api graphql` and worth adding only when two or more repos start
to hurt.

**Personal backlog and the agent work queue** go to Backlog.md. Personal life does not belong in
GitHub Issues. Backlog.md keeps plain markdown in git, which matches the vault decision, and it
carries acceptance criteria and a Definition of Done per task — which is precisely how a headless
agent knows it has finished.

```bash
claude mcp add backlog --scope user -- backlog mcp start
```

One catch: `backlog browser` binds to `127.0.0.1` and is not reachable from the LAN or from
Tailscale. Phone access needs Caddy or an SSH tunnel.

Rejected: Linear, Jira, Todoist — a second source of truth, off the machine.

## The AFK factory

```
 systemd timer (every 30 min)
        |
        v
 collect ready work
   gh issue list --label ready-for-agent
   backlog task list --status todo
        |
        v
 for each task, max 3 concurrent
        |
        +--> git worktree add ~/worktrees/<task-id>
        |
        +--> claude -p --bare
        |      --plugin-dir <memory plugin>
        |      --settings ~/afk/sandbox.json
        |      "<task body + acceptance criteria>"
        |
        +--> push branch, open PR, link the issue
        |
        +--> label ready-for-human, comment what it did
        |
        v
 claude-review.yml reviews the PR
        |
        v
 push notification -> review from the phone -> merge
```

Five rules, each with a reason:

1. **Poll every 30 minutes, not every minute.** A headless `claude -p` run costs a near-fixed ~40k
   tokens of context whatever the prompt (measured 2026-08-20). A one-minute poller burns money
   finding nothing.
2. **Worktrees go in `~/worktrees/`, never `.claude/worktrees/`.** Claude Code's default puts them
   inside the project, and `node_modules` resolution then walks up into the parent and loads the
   wrong version.
3. **The sandbox is nailed shut, not merely on:**
   ```json
   { "sandbox": {
       "enabled": true,
       "failIfUnavailable": true,
       "allowUnsandboxedCommands": false,
       "network": { "allowedDomains": ["registry.npmjs.org", "api.github.com"] },
       "credentials": ["~/.ssh", "~/.aws", "~/.claude"] } }
   ```
   The docs warn that a broad `github.com` allow is an exfiltration path, because the proxy decides
   from the client-supplied hostname without inspecting TLS. Keep the list short.
4. **The agent never touches `main` and never touches the vault repo.** Code work and memory work are
   separate runners with separate permissions.
5. **Done is defined by the task, not by the agent.** Backlog.md's acceptance criteria go into the
   prompt and the PR body quotes them back.

Five agents, of which only two are new:

| Agent | Trigger | Output | New? |
| --- | --- | --- | --- |
| Triage | New issue, or nightly | Labels, dedupe, ask for missing info | **new** |
| Implement | `ready-for-agent` | Branch + PR | **new** |
| Review | PR opened | `claude-review.yml` | exists |
| Research | Backlog task tagged research | Note under `Personal/Research/` | skill only |
| Summarise | SessionEnd | L2 log + L3 insight | exists |

## Phases

| Phase | What | Done means | Rough |
| --- | --- | --- | --- |
| 0 | VPS, Tailscale, Claude Code, Remote Control, vault into private git | Phone drives the VPS with the laptop shut; vault has history | weekend |
| 1 | `vault-mcp` read-only, Caddy, custom connector | CoWork answers from the vault, on the phone | 1–2 days |
| 2 | Backlog.md, gh-dash, `Personal/` folders, research skill | One pile, and it is visible | 1 day |
| 3 | AFK runner and triage agent | An issue becomes a PR overnight | 2–3 days |
| 4 | Essent walled setup | Work never crosses the wall | 1 day |
| 5 | *Deferred:* vault-mcp writes, Obsidian command centre | — | — |

Phase 1 is the payoff. Everything before it is plumbing.

## Risks

1. **The public MCP door exposes the whole brain.** Read-only first, bearer token, deny-list
   `Personal/Private/` and all Essent paths. This is the risk that can actually hurt.
2. **Never put the vault git repo inside a Synology-Drive-synced folder.** Synology fights git,
   leaves `_CONFLICT` files, and silently replaces directory symlinks. It has already cost 24 notes
   once. Keep the repo outside the synced tree and let Synology mirror a plain export.
3. **Tokens are the real bill, not the VPS.** Cap concurrency at 3; poll every 30 minutes.
4. **Essent data must never reach the connector.** Separate vault, separate index, separate serve
   process — a separate process, not a config flag.
5. **Claude Code auth sits on a public box.** Put `~/.claude` in `sandbox.credentials` so agents
   cannot read their own credentials.
6. **RAM.** 16 GB, not 8. The model is ~1.3 GB resident before any agent starts.

Running cost: VPS €10–20/month, Tailscale free, GitHub free. Tokens are the variable.

## Open questions

- Does the Essent employment agreement permit work repos on a personally-owned VPS? Phase 4 is
  blocked until this is answered by a human, not inferred.
- Which vault paths are safe to expose read-only through the connector? Needs an explicit allow-list
  written before phase 1 ships, not a deny-list bolted on after.
- Does `memory-semantic.mjs --serve` need a slug allow-list so one connector cannot query the Essent
  index by passing its slug as a request field?

## Sources

- [My Agentic Coding Setup, July 2026 — Domenic Denicola](https://domenic.me/agentic-coding-setup/)
- [Claude Code: Remote Control](https://docs.claude.com/en/docs/claude-code/remote-control)
- [Claude Code: sandboxing](https://docs.claude.com/en/docs/claude-code/sandboxing)
- [Claude Code: headless](https://docs.claude.com/en/docs/claude-code/headless)
- [Custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Build custom connectors via remote MCP servers](https://support.claude.com/en/articles/11503834-build-custom-connectors-via-remote-mcp-servers)
- [Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)
- [Backlog.md](https://github.com/MrLesk/Backlog.md) · [gh-dash](https://github.com/dlvhdr/gh-dash) ·
  [graphify](https://github.com/Graphify-Labs/graphify) ·
  [last30days-skill](https://github.com/mvanhorn/last30days-skill) ·
  [OpenHands](https://www.openhands.dev/)
- Video research (transcripts, 2026-08-23): *How I Sync One Claude CoWork Setup Across Every Device*,
  *Build A Claude Knowledge Base That Self-Improves*, *Every Level of a Claude Second Brain
  Explained*, *This Claude Code x Obsidian Agentic OS Will Be The New Meta*, *I Open-Sourced My Own
  AFK Software Factory*, *Stop Watching Tutorials — Build These 4 Claude Projects*, *How to Build the
  Most Powerful System for AI Coding*
