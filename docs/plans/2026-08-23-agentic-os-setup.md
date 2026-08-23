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
5. Employer development work, on the same machine but walled off.

Big refactors stay local on the Mac. That is not a goal for this system; it is a carve-out.

## Decisions already taken

These were settled in the design interview and are not open for re-litigation without new facts.

| Decision | Choice | Why |
| --- | --- | --- |
| This repo's scope | Memory layer only | Vault decision note `2026-08-22-be-the-memory-layer-not-the-agentic-os` — agentic OS is wrapper + automation + memory; this project is the third layer |
| Work/personal split | Shared machine, one `$CLAUDE_MEMORY_HOME` per world | Cheaper than two boxes; see "the wall" below — a separate *process* is not enough |
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
        |  ~/vault      + $CLAUDE_MEMORY_HOME=~/.claude-memory      |
        |  ~/vault-work + $CLAUDE_MEMORY_HOME=~/.claude-memory-work |
        |  claude-memory plugin, one index per home                 |
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
4. **Work lives on the same box in its own world** — see the next section. It is never behind the
   public connector.

## The wall, and why a separate process is not one

The first draft said work and personal get "separate serve processes". That is wrong, and the code
says why.

- The socket is `search-${MODEL_KEY}.sock` (`scripts/memory-semantic.mjs:73`) — **keyed by model, not
  by project**. Both worlds use bge-m3, so both want the same filename.
- A second `--serve` on that name **refuses to start**: it probes `socketIsLive(SERVE_SOCK)`, prints
  `already serving bge-m3`, and exits 0 (`scripts/memory-semantic.mjs:85-87`). It does not evict the
  first — `evictableSockets()` filters `n !== ownName` (`scripts/lib/memory-semantic.mjs:91`), so
  eviction only ever fires on a *different* name: another model, or a legacy per-project socket.
- The slug is a **request field**, not a startup argument. The one surviving server answers for any
  slug whose index it can find.

Composed, that is the failure: the personal server is already up, the work session's server quietly
declines to start, and the personal server then answers a work-slug query arriving through the
**public** `/mcp` door. Nothing crashes and nothing is logged as wrong. It is not a race that
sometimes bites — it is the steady state.

**The wall is `$CLAUDE_MEMORY_HOME`.** It is the one setting that can only be an environment variable
(`hooks/lib/paths.mjs:161`), because it relocates `config.json` itself — and it relocates `run/`,
`db/` and `models/` with it. Two homes means two `run/` dirs, so two sockets that cannot see or evict
each other, and two `db/` dirs, so neither server can load the other's index at all.

```bash
# personal
CLAUDE_MEMORY_HOME=~/.claude-memory
# work
CLAUDE_MEMORY_HOME=~/.claude-memory-work
```

`vault-mcp` binds to exactly one home, set in its systemd unit. Only the personal one is ever
published. Two homes also means two copies of the 722 MB of model weights; that is the price, and it
is worth it.

## Install, do not build

| Thing | Job | Note |
| --- | --- | --- |
| Hostinger VPS, Ubuntu 24.04, 16 GB RAM | The brain box | Sized for peak, not idle — see RAM under Risks |
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

## Build — four items, roughly 410 lines of code plus prose

### 1. `vault-mcp` — HTTP MCP server over the vault *(this repo)*

~150 lines. Nothing off the shelf serves the L1–L4 layers. `scripts/memory-semantic.mjs --serve`
already holds the model, answers per-slug queries, and caches indexes on demand; this is a thin
HTTP + MCP shell over that socket.

**`node:http` plus hand-rolled JSON-RPC — no new dependency.** Publishing a vault over MCP is a
general feature and belongs here; the *dependency* is what must not ship. Every release installs into
its own version-pinned cache dir and Claude Code runs `npm ci`, so a `@modelcontextprotocol/sdk`
entry lands in every user's cache whether or not they ever serve anything. `devDependencies` are not
an escape hatch: `npm ci` installs those too. If the shell ever outgrows a few hundred hand-written
lines, that is the signal to move the item to the new repo rather than take the dependency.

**Read-only in phase 1.** Bearer token. An explicit **allow-list** of exposed paths, not a deny-list.
It binds to the personal `$CLAUDE_MEMORY_HOME` and no other. Writes are phase 5, after the door has
been trusted for a while.

### 2. Vault auto-commit hook *(this repo)*

~60 lines, not the ~20 first estimated. Every vault write becomes a commit and a push, which is what
turns `git revert` into the undo button. Four things it must do, all forced by rules already in
CLAUDE.md:

- **Detach and debounce.** Hooks are best-effort and must never block. A synchronous `git push` hangs
  the session whenever the network is slow or the VPS is down.
- **`pull --rebase` before push.** The VPS commits too, so a plain push is rejected non-fast-forward.
- **Scoped `git add <path>`, never `git add -A`.** Several sessions share a working tree here; a
  blanket add has already shipped another session's file to `main` once.
- **Tolerate `.git/index.lock`.** Two sessions saving a note in the same second will collide. Skip
  the round, do not wait — the next write picks it up.

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
        +--> claude -p --output-format json          (NOT --bare, see rule 6)
        |      --settings ~/afk/sandbox.json
        |      "<task body + acceptance criteria>"
        |
        +--> RUNNER (outside the sandbox) pushes branch, opens PR, links issue
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

1. **Poll every 30 minutes, not every minute.** Note what this is *not* about: an empty tick costs
   one `gh issue list` and one `backlog task list`, and no tokens at all — `claude -p` runs per
   task, not per tick. The reason is human throughput. Every task that fires produces a PR that
   wants reviewing, and a headless run costs a near-fixed ~40k tokens whatever the prompt (measured
   2026-08-20), so a fast tick converts a morning of labelling into a queue of PRs and a bill. Read
   the real per-run figure from `--output-format json`; the concurrency cap under Risks rests on a
   measurement, never an estimate.
2. **Worktrees go in `~/worktrees/`, never `.claude/worktrees/`.** Claude Code's default puts them
   inside the project, and `node_modules` resolution then walks up into the parent and loads the
   wrong version.
3. **The sandbox is nailed shut, not merely on** — but it must not strangle the step after it:
   ```json
   { "sandbox": {
       "enabled": true,
       "failIfUnavailable": true,
       "allowUnsandboxedCommands": false,
       "network": { "allowedDomains": ["registry.npmjs.org", "api.github.com"] },
       "credentials": ["~/.ssh", "~/.aws", "~/.claude/.credentials.json"] } }
   ```
   The docs warn that a broad `github.com` allow is an exfiltration path: the proxy decides from the
   client-supplied hostname without inspecting TLS, so domain fronting gets past it. Keep the list
   short. Three consequences of keeping it short:

   - **`git push` is not covered.** It reaches `github.com` over HTTPS, or port 22 over SSH, and
     neither is on the list. Left as written, every AFK run does the work and then dies at "push
     branch, open PR", leaving a stale worktree and no PR. **Push and PR-open run outside the agent,
     in the runner**, after `claude -p` returns. The runner is our code and does not need the
     sandbox; widening the agent's allow-list to fix this trades a real boundary for convenience.
   - **Credentials is `~/.claude/.credentials.json`, not `~/.claude`.** Blocking the whole directory
     starves the memory plugin: L1 loads through `~/.claude/projects/<slug>/memory/MEMORY.md`, and
     `vault-memory-sync.sh` repoints that symlink every session. **Verify the exact `credentials`
     semantics against a real run before phase 3** — this entry is reasoned, not measured.
   - **`api.github.com` is enough for `gh issue`/`gh pr` reads** inside the agent, which is all it
     needs.
4. **The agent never touches `main` and never touches the vault repo.** Code work and memory work are
   separate runners with separate permissions.
5. **Done is defined by the task, not by the agent.** Backlog.md's acceptance criteria go into the
   prompt and the PR body quotes them back.
6. **Do not pass `--bare`, despite the docs recommending it for scripted calls.** `claude --help`:
   it skips *hooks, plugin sync, auto-memory, keychain reads and CLAUDE.md auto-discovery*, and
   forces `ANTHROPIC_API_KEY`. Every one of those is load-bearing here:

   | `--bare` skips | What breaks |
   | --- | --- |
   | Hooks | No SessionEnd distiller, so no L2 log and no L3 insight — the "Summarise" agent silently stops existing |
   | Plugin sync | The memory plugin is not loaded, so recall never fires |
   | CLAUDE.md auto-discovery | The agent writes PRs without the invariants its reviewer judges it by |
   | Keychain reads | An API key must be provisioned on the VPS, and `~/.claude/.credentials.json` in rule 3 becomes dead config |

   Failure if ignored: phase 3 ships, PRs appear overnight, no note is ever written, recall is never
   consulted, and the first run dies at auth with nothing saying why. **The docs say `--bare` will
   become the default for `-p` in a future release** — so pin the behaviour explicitly rather than
   relying on today's default, and re-check on each Claude Code upgrade.

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
| 0 | VPS, Tailscale, Claude Code, Remote Control, vault into private git, **and move the Mac's vault out of the Synology tree** | Phone drives the VPS with the laptop shut; vault has history; `config.json` on the Mac points at the git clone, not inside the synced tree; `/memory:doctor` is green after the move | weekend |
| 1 | `vault-mcp` read-only, Caddy, custom connector | CoWork answers from the vault, on the phone | 1–2 days |
| 2 | Backlog.md, gh-dash, `Personal/` folders, research skill | One pile, and it is visible | 1 day |
| 3 | AFK runner and triage agent | An issue becomes a PR overnight | 2–3 days |
| 4 | Work-side walled setup: second `$CLAUDE_MEMORY_HOME`, second vault | Work never crosses the wall | 1 day |
| 5 | *Deferred:* vault-mcp writes, Obsidian command centre | — | — |

Phase 1 is the payoff. Everything before it is plumbing.

## Risks

1. **The public MCP door exposes the whole brain.** Read-only first, bearer token, explicit
   **allow-list** of exposed paths. This is the risk that can actually hurt.
2. **Two separate vault hazards. Do not merge them — the plan's first draft did.**
   - *Synology:* it fights git, and it silently replaces a directory symlink **inside** the vault
     with an empty dir, renaming the original `<name>_<DEVICE>_<date>_Conflict`. No note count is
     recorded for this. Keep the git repo outside the synced tree; let Synology mirror a plain
     export. **This applies to the Mac today**, whose `config.json` still points inside that tree —
     hence the extra phase-0 step.
   - *The 24 notes:* those were lost on 2026-08-08 to a **relocating hook sent at the wrong vault
     path** — `vault-memory-sync.sh` moved files and repointed the symlink after a stray
     `CLAUDE_VAULT` resolved somewhere throwaway (`hooks/vault-memory-sync.sh:76`,
     `scripts/memory-semantic.mjs:66`, `README.md:208`). Moving the vault out of Synology does not
     retire this one. It stays live for every phase-0 step that changes a vault path, and the guard
     is `/memory:doctor`, which fails loudly when the resolved vault is empty while a populated one
     exists.
3. **Tokens are the real bill, not the VPS.** Cap concurrency at 3; poll every 30 minutes.
4. **Work data must never reach the connector.** One `$CLAUDE_MEMORY_HOME` per world — see "The
   wall". A separate serve process is *not* a wall: the sockets collide by model name and the
   survivor answers any slug.
5. **Claude Code auth sits on a public box.** Put `~/.claude/.credentials.json` in
   `sandbox.credentials`. Do not block all of `~/.claude` — the memory plugin reads L1 through
   `~/.claude/projects/<slug>/memory/`.
6. **RAM: 16 GB, not 8 — sized for peak.** At idle the server is cheap: `modelIdleMs` (5 min)
   disposes the model and ~450 MB of `MALLOC_LARGE` drops to ~2.4 MB while the socket and indexes
   survive (measured 2026-08-17). The peak is what needs headroom — model loaded, indexes cached,
   and up to three sandboxed agents building at once.

Running cost: VPS €10–20/month, Tailscale free, GitHub free. Tokens are the variable.

## Open questions

- Does the employer's agreement permit work repos on a personally-owned VPS? Phase 4 is blocked
  until a human answers this; it is not something to infer. The specifics stay in the private
  `agentic-os` repo.
- Which vault paths are safe to expose read-only through the connector? The allow-list must be
  written before phase 1 ships.
- Do the `sandbox.credentials` semantics block reads outright or mask values? Rule 3 assumes an entry
  can be scoped to a single file. Verify against a real run before phase 3.
- Should `vault-mcp` also carry a slug allow-list as defence in depth? `$CLAUDE_MEMORY_HOME` already
  makes the work index unreachable — a second check is belt-and-braces, not a substitute.

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
