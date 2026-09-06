# Code comments: what the outside world mandates, and what it measures

Research note, 2026-09-06. Primary sources only, each cited inline. Anything obtained second hand is
marked **unverified**.

**Headline.** Every style guide governs a comment's *content*; none governs its *volume*. Every
volume threshold ever shipped in a tool is a **lower** bound, and the biggest was withdrawn. The
famous "20%" is a measured average whose authors said it predicts nothing. This repo's ceiling is
therefore inverted relative to the field — not the same as wrong. On the proposed move to warn 0.50
/ error 0.75: **not supported**, §7.

**Units, three denominators, not interchangeable.** **ratio** `C/L` (this repo's `commentRatio()`; He 2019) · **density** `C/(C+L)` (SonarQube
`comment_lines_density`) · percent of file `C/total` (Arafat & Riehle 2009, as worded). Sonar states
the mapping — *"50% means that the number of lines of code equals the number of comment lines"*
([metric definitions](https://docs.sonarsource.com/sonarqube-server/latest/user-guide/code-metrics/metrics-definition/)).
So **ratio 1.00 = density 50%**, **0.75 = 42.9%**, **density 19% = ratio 0.235**.

## 1. What tools enforce

Checked 2026-09-06 against each tool's own rule index or rule API.

| Tool | Comment rules | Volume threshold |
| --- | --- | --- |
| SonarQube | `InsufficientCommentDensity`, default `minimumCommentDensity` **25** | **REMOVED** (all 4 variants) |
| SonarQube | `S125` commented-out code, `S1135` TODO tags | active (`status: READY`) |
| PMD | `CommentRequired` (all ten properties default `ignored`), `CommentContent`, `CommentSize` | `CommentSize`: **maxLines 6**, maxLineLength 80 — per *block*, not per file |
| Checkstyle | `MissingJavadocMethod/Type/Package`, `JavadocVariable`, `TodoComment` | none |
| ESLint | 7 rules, all style/placement (`capitalized-comments`, `spaced-comment`, …) | none; index has no "density" |
| Biome | `noCommentText` only | none |
| JSHint | none (`maxcomplexity` is the only volume knob) | none |
| Code Climate | maintainability = Duplication + Cyclomatic + Cognitive Complexity + structural issues | comments not an input |

Read from a live instance: `api/rules/show?key=common-java:InsufficientCommentDensity` →
`{"name":"Source files should have a sufficient density of comment lines","params":[{"key":"minimumCommentDensity","defaultValue":"25"}],"status":"REMOVED"}`
— identical for `common-js` (2013-07-03), `common-py` (2018-09-06), `common-cs` (2014-07-21), all
updated 2023-02-27; a rule *search* for "comment density" returns `{"total":0}`. The **built-in
"Sonar way" gate has no comment condition** — its four are `new_coverage < 80`,
`new_duplicated_lines_density > 3`, `new_security_hotspots_reviewed < 100`, `new_violations > 0`
(`api/qualitygates/show?name=Sonar%20way`). **Sonar kept every content rule about comments and
dropped the volume one** — the shape of the whole field.

Sources: <https://next.sonarqube.com/sonarqube/api/rules/show?key=common-java:InsufficientCommentDensity>
· <https://docs.pmd-code.org/latest/pmd_rules_java_documentation.html> · <https://checkstyle.org/checks.html>
· <https://eslint.org/docs/latest/rules/> · <https://biomejs.dev/linter/javascript/rules/>
· <https://raw.githubusercontent.com/jshint/jshint/master/src/options.js>
· <http://web.archive.org/web/20200809001404/https://docs.codeclimate.com/docs/maintainability>
(live URL now redirects to Qlty).

## 2. History: the metric was capped by the people who invented it

Coleman, Ash, Lowther & Oman, *Using Metrics to Evaluate Software System Maintainability*, IEEE
Computer 27(8), Aug 1994, <https://www.ecs.csun.edu/~rlingard/comp589/ColemanPaper.pdf>. ~50
regression models fitted against an abridged AFOTEC maintainability survey on HP test data; the
first four-metric Maintainability Index used a raw comment count `+ aveCM`. Then:

> Preliminary results indicated that this model was too sensitive to large numbers of comments. That
> is, large comment blocks, especially in small modules, unduly inflated the resulting
> maintainability indices. To rectify this, we replaced the aveCM component with percent comments
> (perCM), and a ceiling function was placed on the factor to limit its contribution to a maximum
> value of 50.

Published form: `171 − 5.2·ln(aveVol) − 0.23·aveV(g′) − 16.2·ln(aveLOC) + 50·sin(√(2.46·perCM))`.
Computed from it, 2026-09-06: the term pays 17.2 of 50 at perCM 0.05, 23.8 at 0.10, 31.6 at 0.19,
35.3 at 0.25, 44.8 at 0.50 — **half the credit is earned by ~10% comments and the curve is flat
after.** This is the earliest primary statement of the local hypothesis, from the one model that
ever scored comment volume. **Microsoft's variant then deleted the term**: Visual Studio ships
`MAX(0,(171 − 5.2·ln(Halstead Volume) − 0.23·(Cyclomatic Complexity) − 16.2·ln(LOC))·100/171)`
([docs](https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-maintainability-index-range-and-meaning)),
three terms, comments not an input.

**No ISO standard prescribes a comment density.** ISO/IEC 5055:2021 is a catalogue of structural
weaknesses (<https://www.it-cisq.org/standards/code-quality-standards/>) with no comment measure;
ISO/IEC 25010's text is paywalled (403 on 2026-09-06) and was not read — unverified.

## 3. What the guides mandate about comment *content*

| Guide | The rule |
| --- | --- |
| [Linux kernel](https://www.kernel.org/doc/html/latest/process/coding-style.html) `coding-style.rst` ch. 8 | *"Comments are good, but there is also a danger of over-commenting. NEVER try to explain HOW your code works in a comment… Do not add boilerplate kernel-doc which simply reiterates what's obvious from the signature."* |
| [Google C++](https://google.github.io/styleguide/cppguide.html) | *"Do not state the obvious… don't literally describe what code does, unless the behavior is nonobvious."* And: *"Almost every function declaration should have comments… omitted only if the function is simple and obvious."* |
| [Google Java](https://google.github.io/styleguide/javaguide.html) §7.3 | Javadoc required on every **visible** class, member and record component; §7.3.1's self-explanatory exception is fenced — *"it is not appropriate to cite this exception to justify omitting relevant information that a typical reader might need to know."* |
| [Google Python](https://google.github.io/styleguide/pyguide.html) §3.8.5 | *"The final place to have comments is in tricky parts of the code. If you're going to have to explain it at the next code review, you should comment it now."* |
| [PEP 8](https://peps.python.org/pep-0008/), *Comments* | *"Comments that contradict the code are worse than no comments. Always make a priority of keeping the comments up-to-date when the code changes!"* |
| [PEP 257](https://peps.python.org/pep-0257/) | Docstring conventions: what a docstring is, where it goes, and its form — no volume rule. |
| [Go, *Doc Comments*](https://go.dev/doc/comment) | Doc comments on exported symbols, complete sentences, starting with the symbol's name; a package comment in exactly one file. |
| [Rust API guidelines](https://rust-lang.github.io/api-guidelines/documentation.html) | `C-EXAMPLE` — every public item has a rustdoc example. `C-FAILURE` — *"Function docs include error, panic, and safety considerations."* |

Two directions of pressure, no ratio anywhere: a **coverage floor** on public interfaces (Google
Java, Go, Rust), a **content ban** on restating the code (kernel, Google C++, Google Python).

**Ousterhout**, in the joint APoSD-vs-*Clean Code* discussion with Robert C. Martin
(<https://github.com/johnousterhout/aposd-vs-clean-code>, `main` README — both authors' own words):

- Two reasons a comment is needed — *"the first reason (abstraction)… The second general reason for
  comments is for important information that is not obvious from the code."*
- Different level of detail — *"my goal is not to restate the code… The goal here was to say* what
  *the code is doing in a logical sense, not* how *it does it."*
- Interface vs implementation — *"Without interface comments the specifications for interfaces are
  incomplete… Without implementation comments, readers are forced to rederive knowledge and
  intentions that were in the mind of the original developer."*

**Known-good**, each sourced above: why-not-what (kernel ch. 8, Google C++ "Don'ts"); error, panic
and safety conditions (Rust `C-FAILURE`); the interface specification a caller cannot read off the
signature (Google Java §7.3, Ousterhout); non-obvious performance or algorithmic constraints
(Ousterhout's `PrimeGenerator` notes on avoiding divisions); tracked deviations (`TODO(user)`,
Google C++/Python §3.12, Sonar `S1135`).

**Known-bad:** commented-out code (Sonar `S125`, active); restating the code (kernel; Google C++'s
`// Find the element in the vector. <-- Bad: obvious!`); a comment standing in for a name — Google
C++ answers its own example with `if (!IsAlreadyProcessed(element))` and *"Self-describing code
doesn't need a comment"*; boilerplate on obvious signatures (kernel ch. 8). *Changelog blocks in file
headers* are conventionally banned but **no primary source was located — unverified, do not cite.**

## 4. Staleness: where the literature actually points

| Study | Corpus | Finding |
| --- | --- | --- |
| Wen, Nagy, Bavota & Lanza 2019, ICPC, [doi:10.1109/ICPC.2019.00019](https://doi.org/10.1109/ICPC.2019.00019) | **1.3 billion AST-level changes** from the complete history of **1,500 systems**; 500 commits manually analysed | *"the largest study at date investigating how code and comments co-evolve"* — measures which code-change types trigger comment updates, and builds a taxonomy of the inconsistencies developers fix |
| Tan, Tan & Myers 2012, `@tComment`, ICST, [doi:10.1109/ICST.2012.106](https://doi.org/10.1109/ICST.2012.106) | **7 open-source projects** | Inferred null/exception properties from Javadoc text and random-tested them: **29 comment–body inconsistencies found, 16 reported, 5 already fixed** by the time of writing |
| Fluri, Würsch & Gall 2007, WCRE | 3 projects | densities *"vary widely"*; *"new code is barely commented"* — **unverified**, quoted via Arafat & Riehle; ZORA PDF served a non-PDF, ACM copy paywalled |
| Tan et al. 2007, `iComment`, SOSP, [doi:10.1145/1294261.1294276](https://doi.org/10.1145/1294261.1294276) | — | **not read**; no open copy found, no abstract from Crossref or Semantic Scholar. Named only so the next reader knows it exists. |

`@tComment`'s abstract was read from the Semantic Scholar mirror of the publisher abstract (the arXiv
copy, 1201.6078, is withdrawn). **The measured literature on comment harm is about inconsistency, not
volume** — no study found tests whether a file with many comments is worse than one with few; the
closest is §5's Aman, whose predictor is a residual, not a ratio.

## 5. Empirical density measurements

| Study | Corpus and conditions | Result (ratio units) |
| --- | --- | --- |
| Arafat & Riehle 2009, ICSE NIER, [PDF](https://dirkriehle.com/wp-content/uploads/2009/02/icse-2009-nier-for-web.pdf) | **5,229 active OSS projects**, Ohloh snapshot Mar 2008, data cut at 2007-12-31, ≥2 years old, `ohcount` | average **19%** density → **0.235** |
| He 2019, ESEC/FSE SRC, [PDF](https://hehao98.github.io/files/2019-comment.pdf) | 30 most-starred GitHub repos in each of JS, Java, C++, Python, Go, Apr 2019; `C/L`, same units as here | Java by purpose: education **0.575**, reuse **0.274**, application **0.064**. JS: 0.265 / 0.176 / 0.105 |
| Elish & Offutt, via Arafat & Riehle | 100 Java classes | 15.2%, SD 12.2% → ~0.18 |
| Siy & Votta 2001, via Arafat & Riehle | one closed-source compiler, maintenance phase | ~50% → ~1.00 |
| Sundbakken 2001, via Arafat & Riehle | components of 4 OSS projects | **0.09%–1.22%** |

The last three are **unverified** (read only in Arafat & Riehle's related-work section); their spread
— three orders of magnitude for one named quantity — is the finding. Arafat & Riehle's own two
limitations are the ones every citation drops: all comment lines count equally *"whether they provide
rich content or are auto-generated stubs"*, and —

> We analyze only active projects and **have yet to determine to what extent a high comment density
> can be used as a predictor of project success or failure.**

He states his own — *"the dataset is too small to conduct any statistic significance tests"* — and
his 9x spread by *project purpose* inside one language is the strongest argument against a
cross-project threshold.

**The one external anchor for a ceiling.** Ousterhout, on his own worked example in the
[APoSD discussion](https://github.com/johnousterhout/aposd-vs-clean-code): *"There are a lot of
comments. It's extremely rare for me to write code with this density of comments… But this code is
subtle and tricky… The long length of some of the comments is a red flag indicating that I struggled
to find a clear and simple explanation for the code."* That example measures **26 comment lines to 29
code — ratio 0.90** (counted 2026-09-06 over the fenced Java block at README lines 1272–1338 on
`main`, blanks excluded, line and block comments both counted, as `commentRatio()` does). So 1.00 is
just above what the field's most comment-friendly voice calls extremely rare — and note his actual
claim: long comments are a red flag *about the code*, which is not "too many comments are bad".

**Aman, Amasaki, Sasaki & Kawahara 2015**, IEICE Trans. E98-D(12) 2218–2228,
[doi:10.1587/transinf.2015EDP7107](https://doi.org/10.1587/transinf.2015EDP7107), free access.
Corpus: **29,620 Java methods** — Eclipse Checkstyle Plugin (1,051), Hibernate ORM (18,483), PMD
(3,970), SQuirreL SQL Client (6,116), 2001–2014. Finding: *"more-commented methods… are about 1.6 –
2.8 times more likely to be faulty than the others"*, χ² rejecting equal fault ratios at α = 0.01 in
all four projects. Two conditions cut against a ratio gate: **"more-commented" is a residual**
against a regression on that method's own LOC and complexity, not an absolute ratio, and **LCM counts
only comments inside a method body, excluding Javadoc-style headers** — much of what
`prose-guard.mjs` counts. It tests Fowler's *"deodorant to mask code smells"* framing, cited to
*Refactoring* (ref. [15]; the book was not read).

## 6. The proposal: warn 0.50 / error 0.75

Measured 2026-09-06 at `c9013e0` with the guard's own `commentRatio()` over the 53 tracked non-test
`.mjs` files.
Median non-test file **0.66**, repo-wide 0.59 (4,123 comment / 6,939 code), tests (exempt) 0.19.

| ratio ≥ | files | share |
| ---: | ---: | ---: |
| 0.30 | 44 | 83% |
| 0.50 | 34 | 64% |
| 0.60 | 30 | 57% |
| 0.75 | 17 | 32% |
| 0.90 | 10 | 19% |
| 1.00 | 2 | 4% |

**Does 0.75 as an error have outside support? No — it is exactly as local as 1.00.** The only upper
bound in any surveyed tool is PMD's `CommentSize`, `maxLines 6`, and it caps a single *block*, not a
file ratio; it does not transfer, and it is the rule shape
[2026-08-23-comment-reader-distance.md](../decisions/2026-08-23-comment-reader-distance.md) measured
and rejected here.

**Does 0.50 as a warn have outside support? No, but it is closer to the world.** The nearest external
number is Arafat & Riehle's 19% *density* — and a density is not a ratio, which is the easy error
here: `C/(C+L) = 0.19` gives `C/L = 0.19 / (1 - 0.19)` = **0.235**. A 0.50 warn is roughly **twice**
the measured open-source average (2.6x under the paper's literal "of total lines" wording). So 0.50
is not strict by outside standards; it is simply not a number anybody published.

**Ratchet or wall — a wall.** At error 0.75, **17 of 53 files (32%) fail the next time they are
touched**. 34 (64%) reach or exceed the 0.50 warn threshold, 17 of those being the same files that
also clear the error line — so the exclusive warn band, `0.50 <= ratio < 0.75`, is the other 17
(32%), with the median file at 0.66 inside it. Two-thirds of the tree at or above the warn line is
background, not a signal, against its stated job in
[2026-09-05-prose-ceiling.md](../decisions/2026-09-05-prose-ceiling.md) — *"a file arrives at the
ceiling announced rather than by surprise"*. And that record's own premise is *"a ratchet that fails
on code nobody touched is a ratchet everybody disables"*: failing a third of files on the next
unrelated edit is the same failure with a delay.

**Verdict: the evidence does not support the move.** Nothing outside licenses 0.75 as an error, and
the local distribution makes it a wall. The current 1.00, which 2 of 53 files exceed, is a ratchet.

**What a volume knob can buy, locally.** Across 152 inline review findings on this repo's 73 PRs,
comment volume was not the top complaint — correctness was, at 27%, with "comment contradicts the
code" third at 10.5% — and the prose ceiling shipping in #127 did not move the comment-stale rate
(12% before, 13% after). Consistent with §4: the measured harm is inconsistency, and a volume
threshold is not aimed at it.

> Method, 2026-09-06, PRs #1-#133: `gh api repos/spike1292/claude-memory/pulls/<n>/comments` and
> `.../reviews` over every PR, 624 records. The 152 are the top-level inline comments, all from
> `claude[bot]`, spread over 34 PRs; maintainer replies, empty review wrappers and the 172 summary
> comments are excluded. Each was hand-classified into one bucket, so the boundary between
> "comment contradicts the code" and "doc contradicts code" is a judgement call, not a rule. The
> before/after split is by PR number against #127's merge, 105 findings before and 23 after — small
> enough that the 12%/13% pair shows the absence of a large effect, not the presence of a small one.

## 7. The folk figures

**"20% comment density" is Arafat & Riehle's measured 19% average** (§5), restated as a target by
people who dropped both of their caveats; it describes what open source *was* in 2007. **"25%" is
Sonar's removed rule default** (§1), and quoting it as current is wrong as of 2026-09-06.
**Code Complete**: McConnell is often cited for a comment-per-N-statements figure; the book is not
online, no primary text was located, and **no number is attributed to him here** — unverified.

## Sources

Docs and rule APIs are linked inline in §1 and §3, all resolved 2026-09-06; papers in §2, §4 and §5.
**Not read, so not relied on:** Fluri 2007, `iComment` 2007, Woodfield/Dunsmore/Shen 1981 (ICSE,
paywalled, no abstract available), the ISO/IEC 25010 and 5055 texts, *Code Complete*, *Refactoring*.
Ours: [2026-09-05-prose-ceiling.md](../decisions/2026-09-05-prose-ceiling.md),
[2026-08-23-comment-reader-distance.md](../decisions/2026-08-23-comment-reader-distance.md),
`scripts/lib/prose-guard.mjs`, `CLAUDE.md`.
