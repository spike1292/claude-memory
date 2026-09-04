---
description: Retrieval-eval — measure whether memory actually surfaces the right notes for realistic questions (recall@k, MRR)
---

> **Paths.** Every shell snippet below assumes these two, set first:
> ```bash
> STATE="${CLAUDE_MEMORY_HOME:-$HOME/.claude-memory}"
> MEM="${CLAUDE_PLUGIN_ROOT:-$(cat "$STATE/plugin-root")}"
> ```
> `$MEM` is the plugin root, `$STATE` is machine-local state (indexes, models, logs, eval cases).

Check that the memory can be *found*, not just that it exists. `<slug>` = the project key: normalised git remote of `pwd` (e.g. `gitlab.example.com-teamname-frontend`), NOT the checkout path — run `. "$MEM/hooks/lib/vault-env.sh"; project_key "$PWD"`. Vault root: `<vault>` = `. "$MEM/hooks/lib/vault-env.sh"; resolve_vault`. Prompt-driven; makes no changes on its own.

0. **Two instruments, and they answer different questions.**

   **The generated benchmark** is reproducible anywhere — gold known by construction, no judgement
   calls, and the note set cannot move under you:

   ```
   node "$MEM/scripts/memory-synth-vault.mjs" --out /tmp/bench --notes 300 --seed 7
   node "$MEM/scripts/memory-semantic.mjs" --vault /tmp/bench --slug bench --index --rebuild
   node "$MEM/scripts/memory-eval.mjs" --vault /tmp/bench --slug bench --run --cases /tmp/bench/cases-paraphrase.jsonl
   ```

   Use it as a **tripwire**: its English set is at its ceiling (bge-m3 scores 100%), so it detects
   breakage — a wrong pooling mode took the real vault from @5 67.9% to 25.0% and would collapse
   this — but it cannot show an improvement. Its Dutch set does discriminate between models.

   **The real-vault case sets** are the instrument for small deltas — and the note set moves, which
   is the trap: the same 28 questions scored @1 32.1% and then 28.6% an hour apart with no retrieval
   change, because a note had been added. Before believing a delta of one or two cases, check
   whether notes were written between the runs.

   **Use the versioned case set — do not write fresh questions.**

   ```
   node "$MEM/scripts/memory-eval.mjs" --run --mode semantic
   node "$MEM/scripts/memory-eval.mjs" --run --mode lexical
   ```

   ⚠ **Do not pass `--cases` here.** Without it the script resolves
   `$STATE/eval/eval-cases-<slug>-<style>.jsonl`, scoped to THIS project. `$STATE` is machine-local
   and shared, so a case-set name with no slug in it belongs to whichever project authored one
   first (#97). If this project has no case set yet, author one with `--author` — do not borrow.

   ⚠ `--mode lexical` is a **whole-note** keyword baseline for the semantic arm. It is NOT the
   recall hook: that one scores only the `(card)` chunk, and on the bench vault's own cases the two
   disagree wildly (gold at rank 1 for 50%/25% here against `keywordArm`'s 100%/100%, 2026-08-19).
   A number from here says nothing about `MIN_SCORE` — see its comment in `hooks/lib/memory-recall.mjs`.

   **No retrieval change ships without before/after numbers on the same cases.** Every previous run of this command hand-wrote its questions, so the reported movement measured the question set as much as the retrieval — "0.60 → 1.00" compared two different sets, written by someone who knew the vault and knew what had just been fixed. The versioned set measured **46.4%** where the hand-written one said 94%.

   **Where the questions come from matters more than how many there are.** `--mine <dir>[,<dir>…]`
   reads Claude Code transcript folders (`~/.claude/projects/<cwd-slug>/`) and emits candidate
   questions as `{q}` JSONL with no gold note. Those prompts were typed before any tuning run, in
   the words actually used, so they cannot have been shaped to fit a result — which is what a
   held-out set needs and an authored paraphrase cannot give (#87). Pass every folder belonging to
   the project in one comma-separated call so deduplication spans them. Assign gold notes by hand,
   then pipe to `--author`. **Read what you mined before you keep it**: transcripts contain
   whatever was pasted into a session, including credentials — one mining run here surfaced a
   1Password item id. Case sets stay machine-local and gitignored for this reason.

   Author *new* cases only to extend coverage, never to re-run an old comparison: write `{"q":…,"gold":["note-name"]}` lines and pipe them to `--author`, which fails if a gold note does not exist. Steps 1-2 below describe how to write good questions; they now feed `--author`, not a throwaway list.

   ⚠ `--generate` produces **extracted sentences**, not paraphrases — BM25 scored 97.5% recall@1 on them (2026-08-15, real-vault generated set; the lexical arm has since moved to the shared tokeniser, which cost 5 points of recall@1 on `cases-paraphrase` — 55.0% to 50.0% on the seed-7 synthetic bench vault — and left `cases-keyword` unchanged at 25.0%). Useful as an index-coverage check; useless as a paraphrase test.

1. **Build a question set.** From notes under `Memory/<slug>/` and `Insights/<slug>/`, derive ~15–20 natural-language questions a future session would realistically ask — phrased in the user's words, deliberately **paraphrased**, NOT copied from note titles (paraphrase is what stresses retrieval). For each, record the note(s) that are the correct answer = the gold set.

2. **Retrieve through BOTH channels — they fail differently.** Run each question through:
   - `ctx_search(queries:[...])` — BM25/FTS5, wins on exact identifiers (ticket keys, `--parallel=2`, file paths).
   - `node "$MEM/scripts/memory-semantic.mjs" --query "..." -k 5` — vectors, wins on described-not-named questions. It is the only channel that bridges "firewall"→`WAF` or "short outage"→`cutover`.
   - the `MEMORY.md` MOC hooks, which are auto-loaded and therefore have 100% L1 coverage by construction — a note reachable from its hook is not truly lost, whatever search returns.

   ⚠ **Scoping the semantic tool by layer is REFUTED** (measured 2026-08-15: EN @5 67.9% →
   53.6%). Filtering the note set instead of re-ranking it deletes gold answers living in Insights
   from the window rather than out-ranking them; the `--layer` flag that did it was removed on
   2026-08-19. The 2026-08-14 advice to scope by layer still
   holds for `ctx_search`, which is a separate index with a separate failure. A layer *quota*
   (`MEMORY_FUSE_RESERVE`) was also tried and refuted: at k=5 it changes nothing, because the top-5
   already contains a Memory note — just not the right one. The misses are the gold note losing to a
   similar SIBLING, which no layer rule can reach.

3. **Report the model and the fetch window with every number.** Every semantic figure is
   model-dependent, and a rank-window change (fusion weight, quotas) is invisible if the harness
   fetches wider than a session reads — promoted items sort to the bottom, so scoring @5 from a k=10
   fetch shows nothing at @5. `memory-eval.mjs` prints the model; pass `--fetch-k 5` to measure what
   a session actually receives.

   **Score — and report `@2` for `ctx_search`, not `@5`.** `ctx_search` hard-caps visible results at **2 per query regardless of `limit` or batch size**, so recall@5 is *unmeasurable* through it; reporting @5 overstates what a session actually sees. The semantic channel honours `-k`, so score it at @5 and label the two separately.
   - **recall@k** per channel — fraction of questions whose gold note is returned.
   - **MRR** — mean of 1/(rank of first gold hit), 0 if absent.
   - List the **concrete misses**: questions where the right note ranked low or was absent.

4. **Diagnose each miss — but check the note's own alias line before concluding anything.** Two diagnoses have already been wrong here (2026-08-14): "the note lacks aliases" when it contained the failing phrasing verbatim, and "scoping fixes it" when scoping had only been tested with near-verbatim alias phrases. A miss is one of: **corpus competition** (gold is matched but buried — confirm with a deep `-k 40` run before treating it as a vocabulary problem), **vocabulary gap** (aliases written in the *note's* jargon rather than an outsider's words — the fix is outsider phrasing, not more phrasings), **MOC hook too vague**, or **a genuine gap** to capture later. Run the deep-`k` check first; it distinguishes the top two, which need opposite fixes.

5. **Report** the two numbers, the miss list with fixes, and a one-line verdict — is the memory retrievable? Offer to apply the MOC/keyword fixes; editing note bodies needs confirmation.
