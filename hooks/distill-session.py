#!/usr/bin/env python3
"""Distill a Claude Code session transcript into Obsidian Insight notes.

Called detached by distill-session.sh. Reads the JSONL transcript, asks a cheap
model (haiku, headless `claude -p`) to extract patterns/mistakes/decisions, and
writes deduped markdown notes into the vault. Best-effort: any failure just logs.

Self-check:  python3 distill-session.py --selftest
Dry run (no LLM call, canned insights):  DISTILL_DRYRUN=1 python3 distill-session.py <transcript> <cwd>
"""
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

def resolve_vault() -> Path:
    """Mirror of hooks/lib/vault-env.sh resolve_vault(). DISTILL_VAULT stays supported
    for tests; CLAUDE_VAULT is the real knob."""
    for var in ("DISTILL_VAULT", "CLAUDE_VAULT"):
        v = os.environ.get(var)
        if v:
            return Path(v)
    return Path.home() / "Documents/ClaudeVault"


VAULT = resolve_vault()
MAX_CHARS = 50_000  # tail of the conversation fed to the extractor

EXTRACT_PROMPT = """You are distilling a coding session into durable lessons. From the transcript below, extract only genuinely reusable insights — skip anything trivial or one-off. Return STRICT JSON (no prose, no code fences) with this shape:
{"patterns":[{"title":"","description":"","aliases":["",""]}],"mistakes":[{"title":"","error":"","fix":"","aliases":["",""]}],"decisions":[{"title":"","decision":"","why":"","aliases":["",""]}]}
A thin session may yield empty TOP-LEVEL arrays (no patterns/mistakes/decisions) — that is fine. But every note you DO emit MUST carry a non-empty "aliases" array of 2-3 items. Titles must be short and specific. Each alias is a short natural-language question a future session would ask to find this note, deliberately PARAPHRASED (different words than the title) — this is what makes the note retrievable by meaning, not just its keywords. A note without aliases is incomplete; never omit them, even for a single-note session.

TRANSCRIPT:
"""


def slugify(text: str) -> str:
    s = re.sub(r"[^\w\s-]", "", text.lower()).strip()
    return re.sub(r"[\s_]+", "-", s)[:60] or "untitled"


STOP = {"the", "a", "an", "of", "for", "in", "to", "with", "and", "or", "not", "is", "are",
        "be", "as", "on", "at", "by", "from", "into", "via", "when", "then", "its", "this",
        "that", "must", "should", "can", "do", "does", "dont", "was", "were", "it"}

# Jaccard over slug tokens above which a new note is treated as a restatement of an
# existing one. 0.45 merges the known regressions (allow-failure/masks-child ~0.6,
# resource-group/process-mode ~0.5 after singularising) without collapsing distinct
# lessons that merely share vocabulary.
RECONCILE_AT = 0.45


def _tokens(slug: str) -> set:
    """Significant, lightly-singularised tokens of a slug — the reconciliation key."""
    out = set()
    for t in slug.split("-"):
        if len(t) > 2 and t not in STOP:
            out.add(t[:-1] if len(t) > 3 and t.endswith("s") else t)
    return out


def find_near_duplicate(d: Path, sl: str):
    """Existing note in `d` that already carries this lesson, or None.

    Same-folder only, deliberately: a Pattern and a Mistake on one topic are
    complementary by design, not duplicates.
    """
    new = _tokens(sl)
    if not new:
        return None
    best, best_score = None, 0.0
    for f in d.glob("*.md"):
        old = _tokens(re.sub(r"^\d{4}-\d{2}-\d{2}-", "", f.stem))
        if not old:
            continue
        score = len(new & old) / len(new | old)
        if score > best_score:
            best, best_score = f, score
    return best if best_score >= RECONCILE_AT else None


def reconcile(path: Path, title: str, body: str, alias_line: str, today: str) -> None:
    """UPDATE the existing note in place instead of ADDing a near-duplicate file.

    Folds in the new phrasing's aliases (retrieval surface) and a dated one-line
    addendum (the new detail), so nothing is lost but no new file is spawned.
    """
    text = path.read_text(encoding="utf-8")
    if alias_line:
        m = re.search(r"^_Also asked as: (.+)_\s*$", text, flags=re.MULTILINE)
        if m:
            have = {a.strip().lower().rstrip(".") for a in m.group(1).split(",")}
            add = [a.strip() for a in alias_line.split(",")
                   if a.strip() and a.strip().lower().rstrip(".") not in have]
            if add:
                merged_line = f"_Also asked as: {m.group(1).rstrip('.')}, {', '.join(add)}._"
                text = text[:m.start()] + merged_line + text[m.end():]
        else:
            text = text.rstrip() + f"\n\n_Also asked as: {alias_line}._\n"
    gist = re.sub(r"\s+", " ", re.sub(r"^#.*$", "", body, flags=re.MULTILINE)).strip()
    if gist and f"**Also seen {today}" not in text:
        text = text.rstrip() + f"\n\n**Also seen {today} ({title}):** {gist[:400]}\n"
    path.write_text(text, encoding="utf-8")


def extract_json(raw: str) -> dict:
    """Pull the first JSON object out of a model response (tolerates fences/prose)."""
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.MULTILINE).strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end < start:
        return {}
    try:
        return json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return {}


def transcript_to_text(path: Path) -> str:
    """Flatten a JSONL transcript to role-tagged text + tool names."""
    out = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = obj.get("message") or {}
        role = msg.get("role") or obj.get("type") or ""
        content = msg.get("content")
        if isinstance(content, str):
            out.append(f"[{role}] {content}")
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                t = block.get("type")
                if t == "text":
                    out.append(f"[{role}] {block.get('text', '')}")
                elif t == "tool_use":
                    out.append(f"[{role}:tool] {block.get('name', '')}")
                elif t == "tool_result":
                    r = block.get("content", "")
                    if isinstance(r, list):
                        r = " ".join(b.get("text", "") for b in r if isinstance(b, dict))
                    out.append(f"[tool_result] {str(r)[:400]}")
    text = "\n".join(out)
    # Privacy guard: never distill anything the user wrapped in <private>…</private>.
    text = re.sub(r"<private>.*?</private>", "[REDACTED]", text, flags=re.DOTALL | re.IGNORECASE)
    return text[-MAX_CHARS:]


def project_key(cwd: str) -> str:
    """Mirror of hooks/lib/vault-env.sh project_key(): identify the project by its git
    remote, not its checkout path, so one vault folder serves every machine."""
    try:
        url = subprocess.run(["git", "-C", cwd, "remote", "get-url", "origin"],
                             capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        url = ""
    if url:
        k = re.sub(r"^[a-z+]+://", "", url)
        k = re.sub(r"^[^@/]*@", "", k)          # strip user[:token]@
        k = k.replace(":", "/", 1)
        k = re.sub(r"\.git$", "", k).rstrip("/")
        k = k.lower().replace("/", "-")
        if k:
            return k
    try:
        top = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        top = ""
    if top:
        return Path(top).name.lower()
    return re.sub(r"/", "-", cwd)


def find_claude() -> str | None:
    for cand in (
        shutil.which("claude"),
        str(Path.home() / ".claude/local/claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ):
        if cand and Path(cand).exists():
            return cand
    return None


def run_extractor(convo: str) -> dict:
    if os.environ.get("DISTILL_DRYRUN"):
        return {
            "patterns": [{"title": "Dry run pattern", "description": "canned"}],
            "mistakes": [{"title": "Dry run mistake", "error": "e", "fix": "f"}],
            "decisions": [{"title": "Dry run decision", "decision": "d", "why": "w"}],
        }
    claude = find_claude()
    if not claude:
        print("distill: claude CLI not found", file=sys.stderr)
        return {}
    env = dict(os.environ, CLAUDE_DISTILL_CHILD="1")  # guard against recursive Stop hook
    try:
        proc = subprocess.run(
            [claude, "-p", "--model", "haiku"],
            input=EXTRACT_PROMPT + convo,
            capture_output=True,
            text=True,
            env=env,
            timeout=150,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        print(f"distill: extractor failed: {e}", file=sys.stderr)
        return {}
    return extract_json(proc.stdout)


def write_notes(insights: dict, slug: str) -> tuple:
    today = date.today().isoformat()
    base = VAULT / "Insights" / slug
    written = 0
    merged = 0

    def emit(folder: str, tag: str, title: str, body: str, aliases=None):
        nonlocal written, merged
        d = base / folder
        d.mkdir(parents=True, exist_ok=True)
        sl = slugify(title)
        # dedup: skip if a note with this slug already exists (any date)
        if any(f.name.endswith(f"-{sl}.md") or f.stem == sl for f in d.glob("*.md")):
            return
        # paraphrase aliases -> retrievable by meaning, not just keywords (maintains cheap recall)
        line = ""
        if aliases:
            line = ", ".join(a.strip() for a in aliases if isinstance(a, str) and a.strip())
        # Reconcile before appending: a restatement of an existing lesson updates that
        # note rather than spawning a near-duplicate. Without this the distiller keeps
        # re-creating notes /memory:prune has just merged away.
        dup = find_near_duplicate(d, sl)
        if dup is not None:
            reconcile(dup, title, body, line, today)
            merged += 1
            return
        if line:
            body = body.rstrip() + f"\n\n_Also asked as: {line}._\n"
        # YAML-safe: quote the title so colons/quotes in it don't break frontmatter
        safe_title = title.replace("\\", "\\\\").replace('"', '\\"')
        fm = f'---\ntitle: "{safe_title}"\ndate: {today}\nproject: {slug}\ntags: [{tag}]\ntype: insight\n---\n\n'
        (d / f"{today}-{sl}.md").write_text(fm + body, encoding="utf-8")
        written += 1

    for it in insights.get("patterns", []) or []:
        if it.get("title"):
            emit("Patterns", "pattern", it["title"], f"## {it['title']}\n\n{it.get('description', '')}\n", it.get("aliases"))
    for it in insights.get("mistakes", []) or []:
        if it.get("title"):
            emit("Mistakes", "mistake", it["title"],
                 f"## {it['title']}\n\n**Error:** {it.get('error', '')}\n\n**Fix:** {it.get('fix', '')}\n", it.get("aliases"))
    for it in insights.get("decisions", []) or []:
        if it.get("title"):
            emit("Decisions", "decision", it["title"],
                 f"## {it['title']}\n\n**Decision:** {it.get('decision', '')}\n\n**Why:** {it.get('why', '')}\n", it.get("aliases"))
    return written, merged


def reindex(cwd: str, slug: str) -> None:
    """Refresh the context-mode FTS index so new notes are searchable next session.
    Event-driven — runs right after write_notes, inside this detached child, so the
    session never waits. Failures never break distillation. Beats any timer/poll."""
    cm = shutil.which("context-mode")
    if not cm:
        # Fail loud into distill.log. This CLI resolves out of an fnm/nvm multishell dir, so
        # switching Node versions silently drops it from PATH — and a skipped re-index is
        # otherwise indistinguishable from a successful one: the vault just goes quietly
        # stale until someone notices search is behind.
        print("distill: context-mode not on PATH — vault re-index SKIPPED. "
              "Fix: npm i -g context-mode (then /memory:prune to catch up).",
              file=sys.stderr)
        return
    repo = (Path(cwd).name or "vault").lower()
    for layer, label in (
        ("Insights", f"vault-insights-{repo}"),
        ("Memory", f"vault-memory-{repo}"),
        ("Logs", f"vault-logs-{repo}"),
        ("Graph", f"vault-graph-{repo}"),
    ):
        d = VAULT / layer / slug
        if not d.is_dir():
            continue
        try:
            subprocess.run(
                [cm, "index", str(d), "--project", cwd, "--source", label],
                capture_output=True, text=True, timeout=120,
            )
        except (subprocess.TimeoutExpired, OSError) as e:
            print(f"distill: reindex {layer} failed: {e}", file=sys.stderr)

    # permanent/ is cross-project (not slug-scoped): index the shared dir under
    # this project so its notes are searchable here too. Global source label.
    pdir = VAULT / "permanent"
    if pdir.is_dir():
        try:
            subprocess.run(
                [cm, "index", str(pdir), "--project", cwd, "--source", "vault-permanent"],
                capture_output=True, text=True, timeout=120,
            )
        except (subprocess.TimeoutExpired, OSError) as e:
            print(f"distill: reindex permanent failed: {e}", file=sys.stderr)


def selftest():
    import tempfile

    assert slugify("Use $web Container!") == "use-web-container"
    assert extract_json('```json\n{"a":1}\n```') == {"a": 1}
    assert extract_json("noise {\"a\": 2} tail") == {"a": 2}
    assert extract_json("not json") == {}

    # project_key must agree with hooks/lib/vault-env.sh across URL forms
    with tempfile.TemporaryDirectory() as tmp:
        r = Path(tmp) / "r"
        for url, want in (
            ("git@gitlab.example.com:TeamName/Frontend.git", "gitlab.example.com-teamname-frontend"),
            ("https://gitlab.example.com/TeamName/Frontend.git", "gitlab.example.com-teamname-frontend"),
            ("https://user:tok@gitlab.example.com/TeamName/Frontend", "gitlab.example.com-teamname-frontend"),
        ):
            shutil.rmtree(r, ignore_errors=True)
            subprocess.run(["git", "init", "-q", str(r)], check=True)
            subprocess.run(["git", "-C", str(r), "remote", "add", "origin", url], check=True)
            got = project_key(str(r))
            assert got == want, f"{url} -> {got!r}, want {want!r}"
        # non-git dir falls back to the legacy cwd-slug
        d = Path(tmp) / "plain"
        d.mkdir()
        assert project_key(str(d)) == re.sub(r"/", "-", str(d))

    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        # the two pairs that actually regressed after a /memory:prune merge
        (d / "2026-08-06-parent-pipeline-allow-failure-true-hides-child-job-cancellat.md").write_text(
            "---\ntitle: x\n---\n\n## x\n\nbody\n\n_Also asked as: why did the deploy vanish, parent hid it._\n")
        (d / "2026-08-06-gitlab-resource-groups-process-mode-is-api-only-not-yaml.md").write_text(
            "---\ntitle: y\n---\n\n## y\n\nbody\n")
        assert find_near_duplicate(d, "parent-pipeline-allow-failure-masks-child-pipeline-cancellat") is not None
        assert find_near_duplicate(d, "resource-group-process-mode-defaults-to-unordered-and-is-api") is not None
        # distinct lessons that merely share vocabulary must NOT collapse
        assert find_near_duplicate(d, "media-cache-key-with-query-aware-allowlist") is None
        assert find_near_duplicate(d, "gitlab-ci-trigger-uses-branch-ref-not-commit-sha") is None

        # reconcile: unions aliases, appends dated addendum, creates no file
        target = d / "2026-08-06-parent-pipeline-allow-failure-true-hides-child-job-cancellat.md"
        before = len(list(d.glob("*.md")))
        reconcile(target, "Parent masks child cancellation",
                  "## t\n\n**Error:** child jobs died silently\n", "pipeline looked green", "2026-08-07")
        out = target.read_text()
        assert len(list(d.glob("*.md"))) == before, "reconcile must not create a file"
        assert "pipeline looked green" in out and "why did the deploy vanish" in out, "aliases must union"
        assert out.count("_Also asked as:") == 1, "must not append a second alias line"
        assert "**Also seen 2026-08-07" in out and "child jobs died silently" in out
        reconcile(target, "again", "## t\n\nmore\n", "", "2026-08-07")
        assert target.read_text().count("**Also seen 2026-08-07") == 1, "one addendum per day"

    print("selftest ok")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        selftest()
        return
    if len(sys.argv) < 3:
        print("usage: distill-session.py <transcript> <cwd>", file=sys.stderr)
        sys.exit(1)
    transcript, cwd = Path(sys.argv[1]), sys.argv[2]
    slug = project_key(cwd)
    # Pre-migration fallback: vault-memory-sync.sh renames the folders at SessionStart,
    # but this runs at SessionEnd of a session that may have started before the rename.
    legacy = re.sub(r"/", "-", cwd)
    if slug != legacy and not (VAULT / "Insights" / slug).is_dir() \
            and (VAULT / "Insights" / legacy).is_dir():
        slug = legacy
    if not transcript.is_file():
        return
    convo = transcript_to_text(transcript)
    if len(convo) < 200:
        return
    insights = run_extractor(convo)
    n, merged = write_notes(insights, slug)
    # reindex unconditionally: Memory/Logs can change without new Insights
    # (e.g. /remember, manual note edits), and reindex() skips missing dirs.
    # ponytail: re-reads dirs every session end; append-only so deletions
    # still need /memory:prune's purge — the distiller only keeps additions fresh.
    reindex(cwd, slug)
    print(f"distill: wrote {n} note(s), merged {merged} into existing, for {slug}")


if __name__ == "__main__":
    main()
