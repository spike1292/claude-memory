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
| This repo's scope | Memory layer only | An agentic OS is three layers — a visual wrapper, a skill/automation backbone, and memory. This project commits to being a good third layer (readable Markdown, documented architecture, queryable vault) and leaves the other two to whoever builds them. Same judgement that rejected obsidian-second-brain's 46 commands: a different product, not a missing feature |
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

**The unit must not hardcode a plugin path.** Every release installs into its own version-pinned
cache dir, and `${CLAUDE_PLUGIN_ROOT}` is reliable only inside `hooks/hooks.json` command strings —
a systemd unit is not one. An `ExecStart` naming `…/memory/0.6.0/scripts/vault-mcp.mjs` keeps
serving 0.6.0 after `/plugin update memory`, or dies when that directory goes, and the public
connector goes dark with nothing saying why. Use the repo's existing answer, the breadcrumb every
`commands/*.md` already falls back to:
`${CLAUDE_PLUGIN_ROOT:-$(cat "$CLAUDE_MEMORY_HOME/plugin-root")}`. **VPS catch:** that breadcrumb is
rewritten by `vault-memory-sync.sh` only when a Claude Code *session* starts, so a box that only
ever runs the daemon can hold a stale one — have phase 1 check it, or write it from the unit.

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

**The same shape rules as item 2 apply, and harder.** Logic in `scripts/lib/vault-mcp.mjs` with
`scripts/vault-mcp.mjs` owning argv and stdin only, `vault-mcp.test.mjs` beside the lib, no side
effects on import. A hand-rolled JSON-RPC parser on a **public** endpoint is the last thing in this
repo that should ship untested: its test is the one that feeds it malformed frames, oversized
bodies, and a request for a path outside the allow-list.

**Read-only in phase 1.** Bearer token. An explicit **allow-list** of exposed paths, not a deny-list.
It binds to the personal `$CLAUDE_MEMORY_HOME` and no other. Writes are phase 5, after the door has
been trusted for a while.

### 2. Vault auto-commit hook *(this repo)*

~60 lines, not the ~20 first estimated. Every vault write becomes a commit and a push, which is what
turns `git revert` into the undo button.

It is a new hook, so the repo's own shape rules apply before anything else: the logic goes in
`hooks/lib/vault-autocommit.mjs` with `hooks/vault-autocommit.mjs` owning argv and stdin only, a
`vault-autocommit.test.mjs` sits beside the lib, the lib imports without side effects, the payload is
read with `readStdin()` + `payload()` from `hooks/lib/hook-io.mjs` and **never** with
`new Response(process.stdin)` (~18 ms of web-streams bootstrap for a 100-byte payload, measured
2026-08-20 — and this hook fires on every vault write), the timeout is written in `hooks/hooks.json`
and nowhere else, and the hook reports itself through `logHook()` so `/memory:doctor --hooks` can
see it.

Then five behaviours. Two are CLAUDE.md rules, one is a cost this checkout has already paid, and two
are consequences of the VPS that phase 0 creates:

- **Detach and debounce.** Hooks are best-effort and must never block. A synchronous `git push` hangs
  the session whenever the network is slow or the VPS is down.
- **`pull --rebase` before push.** The VPS commits too, so a plain push is rejected non-fast-forward.
- **Scoped `git add <path>`, never `git add -A`.** Several sessions share a working tree here; a
  blanket add has already shipped another session's file to `main` once.
- **Tolerate `.git/index.lock`.** Two sessions saving a note in the same second will collide. Skip
  the round, do not wait — the next write picks it up.
- **No-op when the vault has no `.git`, and skip the push when there is no remote.** This is the
  other half of the best-effort rule, and it is the half that decides whether this ships at all:
  git is a *new* dependency, and every user's vault today is a plain folder. Without the guard,
  release 0.x gives every one of them a detached `git commit` that forks on each note write and
  fails forever in silence, because the hook swallows errors by design.

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

Six rules, each with a reason:

1. **Poll every 30 minutes, not every minute.** Note what this is *not* about: an empty tick costs
   one `gh issue list` and one `backlog task list`, and no tokens at all — `claude -p` runs per
   task, not per tick. The reason is human throughput. Every task that fires produces a PR that
   wants reviewing, and a headless run costs a near-fixed ~40k tokens whatever the prompt (measured
   2026-08-20), so a fast tick converts a morning of labelling into a queue of PRs and a bill. Read
   the real per-run figure from `--output-format json`. One measured that way, 2026-08-23, **Claude
   Opus 5, 1-hour prompt-cache TTL**: a two-token prompt in a checkout with CLAUDE.md and plugins
   loaded — the AFK runner's exact shape — billed **63,204 cache-creation tokens at $0.63**.

   **Do not read that against CLAUDE.md's 2026-08-20 figure** (18,078 cache-creation + 22,363
   cache-read at $0.0389) as a trend. The two are not comparable and the arithmetic says so: tokens
   rose 3.5× while dollars rose 16×, which at one price per token is impossible — the model and the
   cache TTL differ, not the overhead. (Precisely: *cache-creation* rose 3.5×; against the older
   run's full 40,441-token mix it is 1.56×. Either way, nowhere near 16×.) Measure the runner's own
   model before budgeting, and quote no figure without naming what produced it.

   Budget per *task*, never per prompt length. The concurrency cap under Risks is **provisional** —
   a guess at three, not a measurement — and the first week's JSON output is what replaces it.
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
4. **The agent never touches `main` and never touches the vault repo**, and the runner **marks its
   runs as machine work** before spawning them. Code work and memory work are separate runners with
   separate permissions. The marker matters as much: `logHook()` stamps `child: true` only when a
   `*_CHILD` env var is set, and `hook-stats.mjs` counts a session only when `l.session && !l.child`
   — its own comment records that headless runs once "roughly doubled every count here". A systemd
   timer sets nothing, so 144 unmarked runs a day would show in `/memory:doctor --hooks` as 144
   human sessions, wrecking every per-session figure in the very file rule 6 scans. Export the
   marker in the unit, not in the prompt.
5. **Done is defined by the task, not by the agent.** Backlog.md's acceptance criteria go into the
   prompt and the PR body quotes them back.
6. **Do not pass `--bare`, despite the docs recommending it for scripted calls.** `claude --help`:
   it skips *hooks, plugin sync, auto-memory, keychain reads and CLAUDE.md auto-discovery*, and
   narrows auth to `ANTHROPIC_API_KEY` **or an `apiKeyHelper` passed via `--settings`**. Every one
   of those is load-bearing here:

   | `--bare` skips (among others) | What breaks |
   | --- | --- |
   | Hooks | No SessionEnd distiller, so no L2 log and no L3 insight — the "Summarise" agent silently stops existing |
   | Plugin sync | The memory plugin is not loaded, so recall never fires |
   | Auto-memory | `MEMORY.md` — the L1 index itself — is never loaded, so the agent starts with none of this project's facts |
   | CLAUDE.md auto-discovery | The agent writes PRs without the invariants its reviewer judges it by |
   | Keychain reads | Auth becomes strictly `ANTHROPIC_API_KEY` or an `apiKeyHelper` passed via `--settings`; `~/.claude/.credentials.json` in rule 3 becomes dead config |

   Failure if ignored: phase 3 ships, PRs appear overnight, no note is ever written, recall is never
   consulted, and the first run dies at auth with nothing saying why.

   **And omitting the flag is not a defence that lasts.** The
   [headless docs](https://docs.claude.com/en/docs/claude-code/headless) say `--bare` will become
   the **default** for `-p` in a future release, and there is no opt-out to pin against: Claude Code
   2.1.231 has `--bare` and no `--no-bare`, no setting, and nothing a hook could read — hooks do not
   run under `--bare` at all. So the runner must **assert the side effect instead of trusting the
   flag**: after `claude -p` returns, check that the run left **its own** line in
   `$CLAUDE_MEMORY_HOME/logs/hooks-<date>.jsonl`, and fail the task loudly when it did not.

   Three traps in that check. The first makes it **pass** for the wrong reason; the second makes it
   **fail** on a healthy run; the third makes it **claim more than it knows**:

   - **The log is machine-wide, and neither `cwd` nor `slug` narrows it.** Every project appends to
     the same daily file, and `appendJsonl` stamps `{ t, slug, ...record }` — `cwd` is an argument
     used to derive the slug, never a field. `slug` does not help either: it is the normalised git
     remote, so all three concurrent tasks, running in worktrees of one repo, stamp the same value,
     and task A's check passes on task B's line. **Match on `session`.** `logHook` stamps it
     (`hooks/lib/hook-io.mjs`, omitted only when absent) and `claude -p --output-format json`
     returns the same `session_id` in the envelope rule 1 already parses. One value, one run, exact.
     CLAUDE.md's own rule: a scan-based guard must assert that it found something.
   - **`<date>` is UTC**, from `new Date().toISOString().slice(0, 10)`, and it names the day each
     line was *written*. A run does not write one line: `hooks.json` fires on `SessionStart`,
     `UserPromptSubmit`, `PostToolUse`, `Stop` and `SessionEnd`, and seven hooks call `logHook()`,
     so lines land throughout the run and again as it ends. Two edges follow. The VPS runs
     Europe/Amsterdam, so a runner using `date +%F` looks for tomorrow's file between local midnight
     and UTC midnight, finds nothing, and raises a nightly false alarm — one hour in CET, two in
     CEST, so a reproduction attempted in January at 01:30 local sees nothing. Use `date -u +%F`.
     And the **check clock can cross UTC
     midnight after the last line was written** — a run finishing 23:59 and checked at 00:01 has
     every one of its lines in yesterday's file. **Scan both days for the `session` value**; keying
     the filename off the run's start time is not enough, because the lines straddle.
   - **A missing line has three causes, and the check cannot tell them apart.** `appendJsonl`
     swallows every error by design, so "hooks were skipped", "`logs/` was unwritable or full", and
     "the sandbox denied the write" all produce identical silence — and the third is live, because
     the hook writes from *inside* the sandbox while the runner checks from *outside* it (rule 3).
     Whether a sandboxed agent may write to `$CLAUDE_MEMORY_HOME/logs/` is on the open-questions
     list.

     **So report, do not adjudicate.** A missing line raises "hooks produced no line — skipped,
     unwritable, or sandbox-denied", flags the task for a human, and stops there. It must never
     print a `--bare` regression as though it had established one.

     A read-back probe was designed here to separate those causes and then **cut**: it cannot see
     inside the sandbox, so it never separated the one that matters, and every home for it was
     wrong. A `logHook()` family gives `/memory:doctor --hooks` one phantom `(unnamed) · (no event)`
     row whose count grows with every task (`hook-stats.mjs` keys the table by
     `l.hook || '(unnamed)'` plus the event). A new dated family is reaped by nothing
     (`pruneDatedLogs()` matches only `recall-` and `hooks-`, deliberately). One fixed filename
     races three concurrent tasks. One dotfile per run breaks the stated invariant that nothing else
     in `logs/` starts with a dot (`hooks/lib/hook-io.mjs`), and orphans on a killed runner. Two
     lines of honest reporting beat all four.

   Done that way, the check raises the alarm the day the default flips — which is the only warning
   this design gets — without inventing a diagnosis it cannot support.

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
     `CLAUDE_VAULT` resolved somewhere throwaway (`hooks/vault-memory-sync.sh:73-78`,
     `scripts/memory-semantic.mjs:61-64`, `README.md:208`). **Only the repoint path is retired**: it
     now copies (`cp -n`, `hooks/vault-memory-sync.sh:78`) before relinking, so a stray duplicate is
     its worst case. The *migrate* branch still **moves** — `find "$mem" -maxdepth 1 -type f -exec mv -n {}
     "$dest"/` (`hooks/vault-memory-sync.sh:83`) — and it fires whenever `~/.claude/projects/<slug>/
     memory/` exists as a real directory rather than a symlink, which is exactly what a path-changing
     phase-0 step can leave behind. The guard is `/memory:doctor`, which fails loudly when the
     resolved vault is empty while a populated one exists — **but do not count on that FAIL on the
     VPS**. It fires only when a populated candidate is found, and the candidates are
     `~/Documents/ClaudeVault`, `$STATE/vault` and a `CloudStorage` glob (`scripts/doctor.sh`). On a
     fresh VPS none of the three exists: the glob matches nothing off macOS, and `$STATE/vault` is a
     legacy breadcrumb this repo no longer writes. The same state then prints a WARN reading "vault
     is empty — expected on a first install", which is exactly the sentence a real loss would hide
     behind.
     **Run the doctor after every step that moves a vault path, and on the VPS read that WARN as a
     FAIL.**
3. **Tokens are the real bill, not the VPS.** Cap concurrency at 3 and poll every 30 minutes. Both
   numbers are **provisional guesses**, not measurements; replace them from the first week of
   `--output-format json` output.
4. **Work data must never reach the connector.** One `$CLAUDE_MEMORY_HOME` per world — see "The
   wall". A separate serve process is *not* a wall: the sockets collide by model name and the
   survivor answers any slug.
5. **Claude Code auth sits on a public box.** The intent is to scope `sandbox.credentials` to
   `~/.claude/.credentials.json` — **not verified**, see rule 3 and the open questions. What is
   certain is the other half: do **not** block all of `~/.claude`, because the memory plugin reads
   L1 through `~/.claude/projects/<slug>/memory/`.
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
- May a sandboxed agent write to `$CLAUDE_MEMORY_HOME/logs/`? If not, every hook line is silently
  dropped and rule 6's guard flags every healthy task for review. The rule already refuses to call
  that a `--bare` regression, so this decides how noisy the guard is, not whether it lies.
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
