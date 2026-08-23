# Agentic OS: VPS brain box, vault over MCP, AFK software factory

**Status:** designed 2026-08-23, nothing built. Phase 0 not started.

This plan spans two repos. It lives here because the memory layer is the foundation and most build
items are memory-layer work; the operational half moves to a new private `agentic-os` repo, which
phase 0 creates. Each build item is marked with its repo.

## What this is for

Goals, stated by the owner:

1. Agents that review, research, triage, summarise, and do small tasks.
2. A personal second brain — personal research, personal backlog, a wiki.
3. An AFK software factory: agents pick up backlog work while the laptop is shut.
4. Remote access from laptop and phone.
5. Employer development work, on the same machine but walled off.

Big refactors stay local on the Mac. That is a carve-out, not a goal.

## Decisions already taken

Settled in the design interview. Not open for re-litigation without new facts.

| Decision | Choice | Why |
| --- | --- | --- |
| This repo's scope | Memory layer only | An agentic OS is a visual wrapper, an automation backbone, and memory. This project commits to being a good third layer and leaves the others to whoever builds them — the same judgement that rejected obsidian-second-brain's command set: a different product, not a missing feature |
| Work/personal split | Shared machine, one `$CLAUDE_MEMORY_HOME` per world | Cheaper than two boxes; a separate *process* is not a wall — see "The wall". The VPS is Codebakkers-owned, so this is permitted; the binding constraint is **deletion at contract end** — see "Deleting the work data" |
| Always-on host | Hostinger VPS, Ubuntu 24.04, 16 GB | Must be publicly reachable — see the CoWork finding |
| Vault sync | Private git repo, VPS canonical | Mac and VPS both write from phase 0, the AFK runner from phase 3; git is the only sync giving history and an undo |
| AFK factory | Claude Code native, not OpenHands | Reuses existing skills, hooks, plugin; the sandbox already ships |
| Personal content | Same vault, new top-level folders | One index, one connector, cross-links work |
| Visual wrapper | Deferred | Plumbing first |
| Personal backlog tool | Backlog.md | Acceptance criteria per task is what an AFK agent needs; ships an MCP server |
| First slice | Phase 0 + 1 | Everything else sits on it |

## The finding that forced the architecture

A Claude CoWork cloud session reaches your computer **only while the Claude Desktop app is open** —
incompatible with "laptop closed".

Custom connectors are the way through: remote MCP, working in claude.ai, Desktop, CoWork and mobile.
But Claude connects **from Anthropic's cloud, not from the device**, so the server must be reachable
over the public internet. Servers behind a VPN or home firewall do not connect.

- **The Synology NAS cannot serve CoWork** — behind the home firewall.
- **Tailscale cannot either.** It stays, for SSH and dev-server preview only.
- **A public HTTPS MCP endpoint on the VPS can.** One box feeds phone, web, CoWork and Desktop.

**Remote Control opens no inbound ports** — it makes outbound HTTPS requests and polls. So driving
Claude Code on the VPS from a phone needs no VPN. Domenic's setup routes phone traffic over Tailscale
because it targets the ChatGPT/Codex app; for Claude Code that hop is unnecessary.

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

Rules that fall out:

- **The VPS is the only always-on thing.** Mac and phone are windows onto it.
- **Two doors, on purpose.** Tailscale is the private door for the human; public HTTPS `/mcp` is the
  narrow door for Anthropic's cloud. Nothing else is public.
- **Git is the sync.** Every vault write is a commit; a bad agent run is one `git revert`.
- **Work lives on the same box in its own world**, never behind the public connector.

## The wall

A separate serve process is **not** a wall:

- The socket is `search-${MODEL_KEY}.sock` (`scripts/memory-semantic.mjs:73`) — keyed by model, not
  by project. Both worlds use bge-m3.
- A second `--serve` on that name **refuses to start** (`scripts/memory-semantic.mjs:85-87`). It does
  not evict the first: `evictableSockets()` filters `n !== ownName`
  (`scripts/lib/memory-semantic.mjs:91`).
- The slug is a **request field**. The surviving server answers for any slug whose index it can find.

So the personal server stays up, the work server declines to start, and the personal server answers a
work-slug query arriving through the **public** door. Steady state, not a race.

**The wall is `$CLAUDE_MEMORY_HOME`** — env-only (`hooks/lib/paths.mjs:161`), because it relocates
`config.json`, and `run/`, `db/` and `models/` with it. Two homes give two `run/` dirs (two sockets
that cannot see each other) and two `db/` dirs (neither server can load the other's index).

```bash
CLAUDE_MEMORY_HOME=~/.claude-memory        # personal
CLAUDE_MEMORY_HOME=~/.claude-memory-work   # work
```

`vault-mcp` binds one home; only the personal one is published. Two homes cost 722 MB of weights
twice on disk, and from phase 4 a second ~1.3 GB resident at peak (Risk: RAM).

**`node_modules` is the exception — shared, not walled.** `scripts/share-modules.mjs` puts the
runtime in `$CLAUDE_MEMORY_HOME/node_modules` and symlinks version dirs at it;
`if (isLink(dir)) continue` stops a second world repointing one. So both worlds load through
whichever home consolidated first. **Run `/memory:install` and `share-modules` from the personal
world only** — otherwise wiping the work world breaks the personal daemon and takes the connector
with it.

## The systemd unit

**The unit must not hardcode a plugin path.** Every release installs into its own version-pinned
cache dir, and `${CLAUDE_PLUGIN_ROOT}` is reliable only inside `hooks/hooks.json` command strings. A
hardcoded `ExecStart` keeps serving the old version after `/plugin update memory`, or dies with it.

Use the `plugin-root` breadcrumb every `commands/*.md` falls back to — but **not in their bash form**:
`ExecStart=` runs no shell, so `$(…)` cannot work there. Put the logic in a wrapper file rather than
reasoning about how systemd expands variables inside a quoted argument.

```ini
Environment=CLAUDE_MEMORY_HOME=/home/…/.claude-memory
ExecStart=/usr/local/bin/vault-mcp-start
```

```sh
#!/bin/sh
# /usr/local/bin/vault-mcp-start
r=$(cat "$CLAUDE_MEMORY_HOME/plugin-root" 2>/dev/null)
[ -n "$r" ] || { echo "no usable plugin-root breadcrumb in $CLAUDE_MEMORY_HOME — start a Claude Code session with that CLAUDE_MEMORY_HOME first" >&2; exit 1; }
exec /usr/bin/node "$r/scripts/vault-mcp.mjs"
```

The load-bearing parts:

- **Absolute interpreter path.** A system unit runs with a bare `PATH` and no login shell, so no
  `fnm`/`nvm` shim is on it.
- **Test the breadcrumb's content, not `cat`'s exit status.** An empty breadcrumb is reachable — the
  hook writes it with `printf … > file`, a truncate-then-write, so a killed session or full disk
  leaves a zero-byte file while `cat` still exits 0. Hence `[ -n "$r" ]`.
- **Do not add `set -e`.** `r=$(cat …)` would abort with stderr already sent to `/dev/null`, exiting
  1 in silence — the cause-free failure this guard exists to prevent.

**Both files are deployment artefacts and live in the `agentic-os` repo**, deployed from there. A
config file whose only copy is on the box is the problem this section is solving, one level up.

### Updating the plugin

`vault-memory-sync.sh` writes the breadcrumb only when a Claude Code *session* runs with
`CLAUDE_MEMORY_HOME` **set to that value** — an environment variable, not a directory you `cd` into.
And `ExecStart` reads it once, at start. So:

1. `/plugin update memory`
2. **Start a Claude Code session with `CLAUDE_MEMORY_HOME` set to the personal value.** Nothing else
   rewrites the breadcrumb. A session started with the work value — or none, where the work value is
   exported by default — updates that home and leaves the personal one stale.
3. `systemctl restart vault-mcp`

**Verify against the highest-versioned directory on disk, compared as a version** (read `version`
from each `.claude-plugin/plugin.json`, or `sort -V`). Not against the breadcrumb — the daemon got
its path from there, so they match whether or not step 2 happened. Not by text sort (`0.10.0` sorts
below `0.6.0`). Not by mtime — Claude Code writes into old installs after orphaning them, so mtime
records the last write, not the version. After a deliberate rollback, highest-version-wins is itself
wrong; take the answer from Claude Code instead.

## Deleting the work data

The VPS belongs to Codebakkers; the client work arrives through a Codecask contract. **When that
contract ends the client data must be deleted.** That makes deletability a design constraint, not an
afterthought — and the wall above is most of the answer, because one `$CLAUDE_MEMORY_HOME` plus one
vault directory is a small, enumerable footprint.

But **deletion is not one action**, and two of these places are not on the VPS at all:

| Location | Deletes with | Note |
| --- | --- | --- |
| `~/vault-work` | `rm -rf` | Notes themselves |
| `~/.claude-memory-work/` | `rm -rf` | `db/` (index), `models/`, `run/`, `logs/` — including the work world's `hooks-*.jsonl` and `recall-*.jsonl`, which are per-home |
| `~/worktrees/*` for work repos | `git worktree remove` | Checkouts, plus their `.git` |
| Work repos' git **history** | Delete the repo, not the files | `rm` of a tracked file leaves every earlier version in `.git` |
| **GitHub remote** | Delete the repository | *Not on the VPS.* See the open question — this copy may not be permitted at all |
| **Synology mirror** | Delete there too | *Not on the VPS.* The mirror is a copy by design |
| **Anthropic-side transcripts** | Cannot be deleted by you | See below |

Three things that are easy to miss:

- **Remote Control stores the session transcript on Anthropic servers** while connected — messages,
  responses and tool activity — retained under the Data usage policy. Execution and filesystem
  access stay local, but the transcript does not. If the contract forbids that, **do not enable
  Remote Control for work sessions**; it is per-session, so the personal side can keep it.
- **Embeddings are local** (bge-m3 via transformers.js), so indexing work notes sends nothing out.
  `claude -p` does send content, which is ordinary API use, but it is worth knowing which is which.
- **`node_modules` crosses the wall** (see above). It holds no client data, but it means "delete the
  work home" can break the personal daemon if the work world consolidated the runtime. Re-run
  `share-modules` from the personal world after deleting, or check the symlink first.

Write the drill down in the private `agentic-os` repo and dry-run it in phase 4 — a deletion
procedure first executed under time pressure at contract end is one that gets a location wrong.

## Install, do not build

| Thing | Job | Note |
| --- | --- | --- |
| Hostinger VPS, Ubuntu 24.04, 16 GB RAM | The brain box | Sized for peak — see Risks |
| **Node ≥ 22.5, from nodesource** | Runs `vault-mcp` and every script | `package.json` requires it for `node:sqlite`; Ubuntu 24.04's apt gives 18.19, which throws on import. Claude Code bundles its own runtime and does not put `node` on `PATH`. nodesource installs `/usr/bin/node`, the absolute path the wrapper execs; a version manager puts it elsewhere and the wrapper exits **127** — not systemd's `203/EXEC`, since the unit points at the wrapper and that exists |
| Tailscale | SSH and dev-server preview | Free tier |
| Caddy | TLS and reverse proxy for `/mcp` | Auto certificates |
| Claude Code + the `memory` plugin | Agent and memory | Same plugin, second machine |
| `bubblewrap` | Backs the Claude Code sandbox on Linux | `apt install bubblewrap` |
| GitHub private repos + Issues | Vault storage, code, code backlog | Triage labels already exist |
| `gh` CLI | How agents read and write the backlog | |
| [gh-dash](https://github.com/dlvhdr/gh-dash) | Terminal board for issues and PRs | One tmux pane on the VPS |
| [Backlog.md](https://github.com/MrLesk/Backlog.md) | Personal backlog and agent work queue | MCP server, terminal + web kanban, MIT |
| tmux | Sessions survive disconnect | |
| [last30days-skill](https://github.com/mvanhorn/last30days-skill) | Personal research agent | Drop-in, serves goal 2 on day one |
| [graphify](https://github.com/Graphify-Labs/graphify) *(optional)* | Wiki and graph from docs, SQL, PDFs | `--obsidian` and `--wiki` fit the vault |
| ~~chezmoi~~ — **not needed** | Would sync `~/.claude` across machines | `~/.claude` here is already a private git repo. Two mechanisms over one directory means the loser is overwritten with no error; `git pull` does this job |

**Do not build a sandbox.** Claude Code ships one — bubblewrap-backed on Linux, with filesystem and
network isolation, domain allowlists, `sandbox.credentials`, and `allowUnsandboxedCommands: false`.
The AFK-factory video's author hand-rolled a TypeScript sandbox because Docker was painful; that work
is now redundant.

## Build

### 1. `vault-mcp` — HTTP MCP server over the vault *(this repo)*

~150 lines. Nothing off the shelf serves the L1–L4 layers. `scripts/memory-semantic.mjs --serve`
already holds the model, answers per-slug queries, and caches indexes on demand; this is a thin
HTTP + MCP shell over that socket.

**The shell must own the socket's lifecycle.** The only thing that starts `--serve` today is
`hooks/memory-recall.mjs:174`, an opt-in `UserPromptSubmit` hook needing a live session — and the
server idle-exits after `serveIdleMs` (30 min), unlinking its socket, *"so it cannot become a daemon
nobody remembers starting; the hook respawns it on demand."* On a VPS nobody sits at, that is a dark
connector before the first session and 30 minutes after the last, with `systemctl` reporting
`active (running)` throughout. So `vault-mcp` spawns `--serve` detached on a miss and falls through
to keyword search while it warms. Do not remove the idle exit — it is what stops orphaned models.

**`node:http` plus hand-rolled JSON-RPC — no new dependency.** Publishing a vault over MCP belongs
here; the dependency does not. Claude Code runs `npm ci` into every version-pinned cache dir, and
`devDependencies` are installed too. If the shell outgrows a few hundred hand-written lines, move the
item to the new repo rather than take the dependency.

**Shape rules, harder than item 2's.** Logic in `scripts/lib/vault-mcp.mjs`, entry owning argv and
stdin only, `vault-mcp.test.mjs` beside the lib, no side effects on import. A hand-rolled JSON-RPC
parser on a **public** endpoint is the last thing here that should ship untested: its test feeds it
malformed frames, oversized bodies, and a request for a path outside the allow-list.

**Read-only in phase 1.** Bearer token. An explicit **allow-list** of exposed paths. Binds the
personal `$CLAUDE_MEMORY_HOME` and no other. Writes are phase 5.

**Verifying a cold start** (phase 1's real check). After 30+ minutes with no query from any client —
`bump()` resets the idle timer on every connection, including your own test queries — ask **two**
questions:

1. The first triggers the detached spawn. **Throw its answer away**: after an idle exit the first
   reply is keyword-only *by design*, so grading it fails a correct build.
2. Wait for warm-up, then ask the second, and compare its top result against
   `memory-semantic.mjs --query` for the same question locally. The local query never touches the
   socket, so it is always the full hybrid — a fair reference for the second reply and a guaranteed
   mismatch against the first.

Same top result means the server answered. A reply alone proves nothing: the miss path falls through
to keyword search, MRR 0.158 against 0.546 (English paraphrases, n=28, `README.md`). Do not assert
the socket instead — a socket *file* outlives a SIGKILLed server, and `socketIsLive()` returns true
on timeout.

### 2. Vault auto-commit hook *(this repo)*

~60 lines. Every vault write becomes a commit and a push — what turns `git revert` into the undo
button.

Repo shape rules first: logic in `hooks/lib/vault-autocommit.mjs`, entry owning argv and stdin only,
a test beside the lib, no side effects on import, payload read with `readStdin()` + `payload()` from
`hooks/lib/hook-io.mjs` (never `new Response(process.stdin)` — ~18 ms per call, and this fires on
every vault write), timeout in `hooks/hooks.json` and nowhere else, and `logHook()` so
`/memory:doctor --hooks` sees it.

Then the behaviours:

- **Detach and debounce.** Hooks must never block; a synchronous `git push` hangs the session when
  the network is slow or the VPS is down.
- **`pull --rebase` before push.** The VPS commits too, so a plain push is rejected.
- **Scoped `git add <path>`, never `git add -A`.** Sessions share a working tree here; a blanket add
  has already shipped another session's file to `main`.
- **Tolerate `.git/index.lock`.** Two sessions saving in the same second collide. Skip the round.
- **No-op without `.git`, and skip the push without a remote.** Git is a *new* dependency and every
  user's vault today is a plain folder. Without this, release 0.x gives them a detached `git commit`
  per note write that fails forever in silence, because the hook swallows errors by design.

### 3. AFK runner *(new repo)*

~200 lines of glue. Queue, worktrees and sandbox are off the shelf. Detailed below.

### 4. `Personal/` conventions and skills *(this repo)*

Prose, not code. Personal backlog, research-to-note, wiki upkeep. `/memory:protocol` already defines
the note rules; these add the folder layout and the skills that write into it.

### 5. `CLAUDE_MEMORY_MACHINE_RUN` in `hook-io.mjs` *(this repo)*

~5 lines, and it blocks phase 3. `logHook()` reads a closed pair of env vars to decide `child: true`,
and both are recursion guards that switch off the hook they name — so there is no way to label a
machine run without disabling something.

**Do not give it a `*_CHILD` name.** CLAUDE.md defines that suffix as a recursion guard, and both
existing names are ones. A third that guards nothing invites the next person to copy the wrong half
of the pattern. Its test asserts the stamp appears **and** the distiller still runs.

## Backlog: two jobs, two tools

**Code backlog** stays on GitHub Issues — CI, PRs, the review workflow and the triage labels already
live there. `gh` is the whole API an agent needs; `gh-dash` is the human view. GitHub Projects v2 is
scriptable via `gh api graphql`, worth adding only when several repos start to hurt.

**Personal backlog and the agent work queue** go to Backlog.md. Personal life does not belong in
GitHub Issues. It keeps plain markdown in git, matching the vault decision, and carries acceptance
criteria and a Definition of Done per task — which is how a headless agent knows it has finished.

```bash
claude mcp add backlog --scope user -- backlog mcp start
```

`backlog browser` binds `127.0.0.1` and is not reachable from the LAN or Tailscale; phone access
needs Caddy or an SSH tunnel.

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
        +--> claude -p --output-format json          (NOT --bare)
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

**Poll every 30 minutes.** Not because empty ticks cost anything — they cost one `gh issue list` and
one `backlog task list`, no tokens, since `claude -p` runs per task. The reason is human throughput:
every task that fires produces a PR wanting review. Read the real per-run cost from
`--output-format json`; one measured 2026-08-23 on Claude Opus 5 with a 1-hour cache TTL billed
63,204 cache-creation tokens at $0.63 for a two-token prompt in a loaded checkout. Do not compare
that to CLAUDE.md's 2026-08-20 figure as a trend — different model and cache TTL, and the arithmetic
refutes it (tokens 3.5×, dollars 16×). Budget per *task*. The concurrency cap of 3 is a provisional
guess, not a measurement.

**Worktrees go in `~/worktrees/`, never `.claude/worktrees/`.** Claude Code's default puts them
inside the project, and `node_modules` resolution walks up into the parent and loads the wrong
version.

**The sandbox is nailed shut, and must not strangle the step after it:**

```json
{ "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "network": { "allowedDomains": ["registry.npmjs.org", "api.github.com"] },
    "credentials": ["~/.ssh", "~/.aws", "~/.claude/.credentials.json"] } }
```

The docs warn that a broad `github.com` allow is an exfiltration path — the proxy decides from the
client-supplied hostname without inspecting TLS. Keeping the list short has consequences:

- **`git push` is not covered**, so push and PR-open run **in the runner, outside the agent**, after
  `claude -p` returns. Widening the agent's allow-list would trade a real boundary for convenience.
- **Credentials is `~/.claude/.credentials.json`, not `~/.claude`** — blocking the whole directory
  starves the plugin, which loads L1 through `~/.claude/projects/<slug>/memory/`. Reasoned, not
  measured; verify before phase 3.
- **`api.anthropic.com` is deliberately absent.** The plugin's heavy hooks spawn a headless `claude`,
  but hooks run outside the Bash sandbox, so that spawn does not need the agent's list. If the open
  question on hook sandboxing comes back the other way, this and the credentials entry are revisited
  **together** — without both, the distiller dies unreachable while the gate still logs `spawned`.

**The agent never touches `main` or the vault repo**, and the runner **marks its runs as machine
work**. `hook-stats.mjs` counts a session only when `l.session && !l.child`, and its comment records
that headless runs once "roughly doubled every count here" — so unmarked runs would show as human
sessions and wreck every per-session figure. Build item 5 exists because no marker-only env var does.

**Done is defined by the task, not the agent.** Backlog.md's acceptance criteria go into the prompt
and the PR body quotes them back.

**Do not pass `--bare`**, despite the docs recommending it for scripted calls. `claude --help`: it
skips *hooks, plugin sync, auto-memory, keychain reads and CLAUDE.md auto-discovery*, and narrows
auth to `ANTHROPIC_API_KEY` or an `apiKeyHelper` via `--settings`. Each of those is load-bearing:

| `--bare` skips (among others) | What breaks |
| --- | --- |
| Hooks | No SessionEnd distiller — no L2 log, no L3 insight; the "Summarise" agent silently stops existing |
| Plugin sync | The memory plugin is not loaded, so recall never fires |
| Auto-memory | `MEMORY.md`, the L1 index itself, is never loaded |
| CLAUDE.md auto-discovery | The agent writes PRs without the invariants its reviewer judges it by |
| Keychain reads | `~/.claude/.credentials.json` becomes dead config |

**Omitting the flag is not a defence that lasts.** The
[headless docs](https://docs.claude.com/en/docs/claude-code/headless) say `--bare` will become the
**default** for `-p`, and there is no opt-out: Claude Code 2.1.231 has no `--no-bare`, no setting,
and hooks do not run under `--bare` to read one. So the runner **asserts the side effect**: after
`claude -p` returns, check the run left its own line in `$CLAUDE_MEMORY_HOME/logs/hooks-<date>.jsonl`.

That check has traps:

- **Match on `session`.** The log is machine-wide; `appendJsonl` stamps `{ t, slug, ...record }`, so
  `cwd` is not a field and `slug` is the normalised git remote — identical across worktrees of one
  repo, so task A would pass on task B's line. `logHook` stamps `session`, and
  `claude -p --output-format json` returns the same `session_id`.
- **`<date>` is UTC** (`toISOString().slice(0,10)`), naming the day each line was written — and a run
  writes lines throughout, from `SessionStart` to `SessionEnd`. Use `date -u +%F`, and **scan both
  days**, since a run finishing at 23:59 is checked at 00:01 against tomorrow's file.
- **Report, do not adjudicate.** `appendJsonl` swallows every error, so "hooks were skipped" and
  "`logs/` was unwritable" are indistinguishable. A missing line raises "hooks produced no line —
  skipped, or the log could not be written" and flags a human. It must never print a `--bare`
  regression as though it had established one.

### The agents

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
| 0 | VPS, Tailscale, Claude Code, Remote Control, vault into private git, **create the `agentic-os` repo**, build item 2, **and move the Mac's vault out of the Synology tree** | Phone drives the VPS with the laptop shut; a note written on either box lands as a commit without anyone running git; the Mac's `config.json` points at the git clone, not inside the synced tree; `/memory:doctor` reports **no WARN and no FAIL** on both boxes after the move — a bare "no FAIL" is not enough, since on a fresh VPS a real loss prints only a WARN (Risk 2) | weekend |
| 1 | Build item 1 (`vault-mcp`) read-only, Caddy, custom connector, unit + wrapper committed to `agentic-os` | CoWork answers from the vault, on the phone; the cold-start check under item 1 passes; the update procedure leaves the daemon on the highest-versioned directory | 1–2 days |
| 2 | Backlog.md, gh-dash, build item 4 | One pile, and it is visible | 1 day |
| 3 | Build item 5, then the AFK runner and triage agent | An issue becomes a PR overnight, and `/memory:doctor --hooks` still separates machine runs from yours | 2–3 days |
| 4 | Work-side walled setup: second `$CLAUDE_MEMORY_HOME`, second vault, **and the deletion drill** | Work never crosses the wall, and a dry-run deletion accounts for every location below | 1 day |
| 5 | *Deferred:* vault-mcp writes, Obsidian command centre | — | — |

Phase 1 is the payoff. Everything before it is plumbing.

## Risks

1. **The public MCP door exposes the whole brain.** Read-only first, bearer token, explicit
   allow-list of exposed paths. This is the risk that can actually hurt.
2. **Two vault hazards, and they are not the same one.**
   - *Synology* fights git and silently replaces a directory symlink **inside** the vault with an
     empty dir, renaming the original `<name>_<DEVICE>_<date>_Conflict`. No note count recorded. Keep
     the repo outside the synced tree; let Synology mirror a plain export. **This applies to the Mac
     today** — hence the extra phase-0 step.
   - *The 24 notes* were lost on 2026-08-08 to a relocating hook sent at the wrong vault path
     (`hooks/vault-memory-sync.sh:73-78`, `scripts/memory-semantic.mjs:61-64`, `README.md:208`).
     **Only the repoint path is retired** — it now copies (`cp -n`, `:78`). The *migrate* branch
     still moves (`mv -n`, `:83`) and fires whenever `~/.claude/projects/<slug>/memory/` is a real
     directory rather than a symlink, which a path-changing step can leave behind. Run
     `/memory:doctor` after **every** step that moves a vault path — and on the VPS read its WARN as
     a FAIL: the loud FAIL needs a populated candidate, and on a fresh VPS none of `doctor.sh`'s
     three exists, so a real loss prints "vault is empty — expected on a first install".
3. **Tokens are the real bill, not the VPS.** Concurrency 3 and a 30-minute poll are provisional
   guesses; replace them from the first week of `--output-format json` output.
4. **Work data must never reach the connector.** One `$CLAUDE_MEMORY_HOME` per world. A separate
   serve process is not a wall.
5. **Claude Code auth sits on a public box.** Scope `sandbox.credentials` to
   `~/.claude/.credentials.json` — not verified. What *is* certain: do not block all of `~/.claude`,
   because the plugin reads L1 through `~/.claude/projects/<slug>/memory/`.
6. **RAM: 16 GB, not 8 — sized for peak.** Idle is cheap: `modelIdleMs` (5 min) disposes the model
   and ~450 MB of `MALLOC_LARGE` drops to ~2.4 MB while socket and indexes survive (measured
   2026-08-17). Peak is model loaded, indexes cached, three sandboxed agents — and from phase 4 a
   **second** resident model, since both worlds can hold a `--serve` at once.

Running cost: VPS €10–20/month, Tailscale free, GitHub free. Tokens are the variable.

## Open questions

- May client data be pushed to a GitHub remote at all, even a private one, and under which account?
  The deletion obligation below is satisfiable on the VPS; a GitHub remote adds a copy that is not
  on the VPS. Answer before phase 4 creates the work vault's remote, not after.
- Does the contract set a retention or deletion deadline, and does it require evidence of deletion?
  That decides whether the drill needs a written record or just an action.
- Which vault paths are safe to expose read-only? The allow-list must exist before phase 1 ships.
- Do `sandbox.credentials` semantics block reads or mask values? The plan assumes an entry can be
  scoped to a single file.
- Do hooks really run outside the Bash sandbox? The docs scope it to "every Bash command and its
  child processes" and never list hooks either way. The sandbox domain list and the `--bare` guard
  both assume it.
- Should `vault-mcp` carry a slug allow-list as defence in depth? `$CLAUDE_MEMORY_HOME` already makes
  the work index unreachable; this would be belt-and-braces, not a substitute.

## Sources

- [My Agentic Coding Setup, July 2026 — Domenic Denicola](https://domenic.me/agentic-coding-setup/)
- [Claude Code: Remote Control](https://docs.claude.com/en/docs/claude-code/remote-control) ·
  [sandboxing](https://docs.claude.com/en/docs/claude-code/sandboxing) ·
  [headless](https://docs.claude.com/en/docs/claude-code/headless)
- [Custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) ·
  [Build custom connectors](https://support.claude.com/en/articles/11503834-build-custom-connectors-via-remote-mcp-servers) ·
  [Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)
- [Backlog.md](https://github.com/MrLesk/Backlog.md) · [gh-dash](https://github.com/dlvhdr/gh-dash) ·
  [graphify](https://github.com/Graphify-Labs/graphify) ·
  [last30days-skill](https://github.com/mvanhorn/last30days-skill) ·
  [OpenHands](https://www.openhands.dev/)
- Video research (transcripts, 2026-08-23): *How I Sync One Claude CoWork Setup Across Every Device*,
  *Build A Claude Knowledge Base That Self-Improves*, *Every Level of a Claude Second Brain
  Explained*, *This Claude Code x Obsidian Agentic OS Will Be The New Meta*, *I Open-Sourced My Own
  AFK Software Factory*, *Stop Watching Tutorials — Build These 4 Claude Projects*, *How to Build the
  Most Powerful System for AI Coding*
