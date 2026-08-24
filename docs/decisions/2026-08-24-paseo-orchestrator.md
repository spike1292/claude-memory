# Paseo is the orchestrator; the AFK runner is not built

**Date:** 2026-08-24 · **Status:** accepted, unbuilt · Supersedes the runner in
[docs/plans/2026-08-23-agentic-os-setup.md](../plans/2026-08-23-agentic-os-setup.md) build item 3.

## Decision

Run [Paseo](https://github.com/getpaseo/paseo) as the agent control plane on the VPS. Do not write
the AFK runner, do not run tmux, do not add a systemd timer.

Paseo does not touch the memory layer. `vault-mcp`, the auto-commit hook, `Personal/` and
`CLAUDE_MEMORY_MACHINE_RUN` are unchanged, and `$CLAUDE_MEMORY_HOME` is still the work/personal wall.

## What was measured

186 entries in [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators),
screened against five musts (headless on Ubuntu, phone, self-hosted, Claude Code unchanged, no inbound
port). Four survived. Every figure below is from the repositories on 2026-08-24 — file trees, release
assets and manifests — not from the list's summaries.

| | Paseo | Garcon | T3 Code | intentic |
| --- | --- | --- | --- | --- |
| Scheduled runs | daemon | server | **none** | daemon |
| Webhooks | none | none | none | yes |
| Phone | native | web app | native | browser |
| Mac app | yes | no | yes | **no** |
| Worktree per agent | yes | yes | **none found** | Docker + worktree |
| Claude · Codex · **Copilot** | **all three** | 2 of 3 | 2 of 3 | 2 of 3 |
| Oh My Pi | **49 files** | no | no | no |
| Stars · age | 14.9k · 10 mths | 62 · 6 mths | 20.2k · 6 mths | 25 · **20 days** |

**Copilot decided it.** Client work runs on the client's subscription
([[client-data-must-be-deletable]] in the vault); only Paseo can launch it. The other three would have
forced Essent work onto a personal Anthropic account.

Two claims here contradict what the projects advertise, which is why the file trees were read:

- **Paseo's README never mentions its scheduler.** It is in `packages/server/src/server/schedule/`
  (`cron.ts`, `service.ts`, `store.ts`) with a CLI — `paseo schedule create|ls|inspect|logs|pause|resume|run-once|update|delete`.
  A first pass over READMEs alone concluded that only intentic could schedule anything. That was wrong.
- **The awesome list names Oh My Pi zero times in 186 entries**, while Paseo carries 49 files of OMP
  provider code. Note that OMP (`can1357/oh-my-pi`) and Pi (`pi.dev`) are different agents; several
  tools support the second and not the first.

## Why not the others

- **T3 Code** — the nicest interface of the four, and nothing in 3,091 files starts an agent on its
  own. Choosing it keeps the runner on the build list.
- **intentic** — the only real trigger system (cron, webhooks, CI and email listeners) and a per-agent
  Docker sandbox. Twenty days old, 25 stars, no macOS build, and a sign-in at `intentic.dev` that
  holds the address of a box carrying client data. Not a foundation yet.
- **Garcon** — scheduled prompts, worktrees, mobile approvals, and Telegram alerts when a run needs
  permission. Worth revisiting if Paseo's alerting is thin; that alert is the part of unattended work
  that actually fails.

## What this deletes from the plan

| Dropped | Replaced by |
| --- | --- |
| Build item 3, the AFK runner, ~200 lines in a new repo | `paseo schedule` in the daemon |
| systemd timer every 30 minutes | the same |
| tmux | the daemon holds sessions; clients attach and detach |
| `git worktree add ~/worktrees/<task-id>` | `$PASEO_HOME/worktrees/<hash>/<slug>`, with setup hooks |
| Remote Control as the phone path | native iOS and Android clients |

The `agentic-os` repo still gets created — the unit files live there. The deletion drill moves with
the work world, which v1 does not build.

## Consequences that need a decision on the box

**Use the direct connection for work, not the relay.** Paseo's default is an outbound connection to
*their* relay, which is why no port opens. That puts a third party in the path of client sessions.
Direct TCP over Tailscale keeps the same "no inbound port" property with nobody in the middle, and it
is a per-host setting. Personal sessions may use either.

**Paseo does not sandbox.** It isolates by worktree, not by filesystem or network. Claude Code's own
bubblewrap sandbox is still what enforces the boundary, so `~/afk/sandbox.json` survives the runner
that was going to pass it.

**A scheduled run is a machine run.** Build item 5 gets more important, not less: without it
`/memory:doctor --hooks` counts Paseo's overnight work as yours.

## Verified on the Mac, Paseo 0.5.1, 2026-08-24

**The hooks fire, in full.** One `paseo run --provider claude` turn in this checkout wrote six lines
to `$CLAUDE_MEMORY_HOME/logs/hooks-2026-08-24.jsonl`, all under one session id:

| hook | event | outcome |
| --- | --- | --- |
| `semantic-index-refresh` | SessionStart | spawned, then its `worker` ran |
| `graph-staleness-check` | SessionStart | ran |
| `insights-surface` | SessionStart | ran |
| `memory-recall` | UserPromptSubmit | ran |
| `distill-session` | Stop | debounced |

That is the whole lifecycle, so the question that could have undone this choice is answered. It also
settles the sandbox worry indirectly: hooks ran outside whatever Paseo does to the agent.

**Every line carried `child: null` and a real session id, so `hook-stats.mjs` counted a machine-driven
turn as one of yours.** Build item 5 is not theoretical — it is the difference between per-session
figures that mean something and figures inflated by overnight work.

**`paseo run` takes `--env key=value`**, which is the delivery mechanism build item 5 needs, alongside
`--new-workspace worktree`, `--worktree-mode branch-off` and `--new-branch`.

**All four providers resolve on the Mac**, which is the claim that decided the choice, now measured
rather than read off a README:

```
Claude   available (daemon)      Codex     available (daemon)
copilot  available (daemon)      omp       available (daemon)
```

Two install notes that cost time and would cost it again:

- **`brew install chatgpt` does not give you Codex.** It installs the desktop app, which bundles a
  `codex` binary at `/Applications/ChatGPT.app/Contents/Resources/codex` — an alpha, inside the
  bundle, never on `PATH`. `brew install --cask codex` is the CLI. Do not `npm i -g` it: the Paseo
  daemon's `PATH` pins one specific fnm multishell directory, which dies with that shell.
- **`brew info copilot` describes the AWS ECS tool**, an unrelated formula holding the same name.
  The installed `/opt/homebrew/bin/copilot` is GitHub Copilot CLI. Check `--version`, not the formula.
- **Provider discovery happens at daemon start.** `paseo reload` re-reads config but not the provider
  scan; `paseo daemon restart` is what makes a newly installed CLI appear.

**Not verified: whether `--env` reaches the hook subprocess.** Hooks inherit the agent's environment,
so it should. The clean test — pointing `CLAUDE_MEMORY_HOME` at a throwaway directory — was declined
rather than run: a memory home with no `config.json` resolves the vault to the default, and
`vault-memory-sync.sh` then repoints the live symlink at an empty one. That has already cost this
setup 24 notes once. Settle it while building item 5, which is where a marker exists to observe.

## The wall has to run both ways, and `PASEO_HOME` is how

Copilot is signed in on the **E.ON** account (owner, 2026-08-24), so client work runs on the client's
plan as intended. That closes the question the tool choice rested on — and opens its mirror.

**A subscription bound to the client is a wall in the other direction.** Personal work driven through
Copilot puts personal code on E.ON's plan and telemetry, which is the same leak reversed. Until now
every rule here pointed one way; this one does not.

**Paseo cannot express it by workspace.** Configuration is one `config.json` per daemon home, and
providers live under `agents.providers` — global to the daemon. Precedence is defaults → `config.json`
→ env → CLI flags, with nothing project- or workspace-scoped. Provider choice is per *launch*, so
nothing stops a work provider starting in a personal workspace.

**So split the daemon the way the memory home is already split**, and for the same reason — a wall you
cannot enumerate is a wall you cannot check. **This is deferred: v1 is personal-only** (owner,
2026-08-24), so there is one daemon and Copilot simply goes unused until there is a work world to put
it in:

| World | `PASEO_HOME` | `CLAUDE_MEMORY_HOME` | Providers |
| --- | --- | --- | --- |
| Personal | `~/.paseo` | `~/.claude-memory` | claude, codex, omp; **copilot disabled** |
| Work | `~/.paseo-work` | `~/.claude-memory-work` | **copilot only**; the rest disabled |

Disabling a provider is a documented `agents.providers` field, so each side is a few lines. This costs
a second daemon and a second listen address, and it lands with phase 4 — whenever client work actually
moves onto this machine, not before.

## Still open

1. The licence. The README says AGPL-3.0; GitHub cannot classify the file. It only matters if Paseo is
   ever hosted for a client.
2. Is there an alert when a run stalls or needs permission, or is Garcon's Telegram bridge still the
   only one?
3. Who owns the push and the hooks-fired assertion after a scheduled turn — see the plan.

## Sources

- https://github.com/getpaseo/paseo — `public-docs/{security,worktrees,schedules,supported-providers,mcp}.md`
- https://github.com/andyrewlee/awesome-agent-orchestrators
- https://github.com/pingdotgg/t3code · https://github.com/intentic/intentic · https://github.com/cfal/garcon
- https://github.com/can1357/oh-my-pi
