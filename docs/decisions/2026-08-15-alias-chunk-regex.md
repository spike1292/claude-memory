# The alias-chunk retrieval bug, and the regex bug that survived the first fix

**Date:** 2026-08-15 · **Status:** shipped

`_Also asked as:` was given its own chunk in `chunkNote()` because the convention was designed for
FTS5, where a term only has to be present — but it sits at the END of the note, so in vector space
it lands inside the last 1800-char section whose embedding is dominated by that section's actual
subject. Measured 2026-08-15: `cra2-ecs-runtime-facts` lists "can I trust the cra2 dashboards for
alarm thresholds" almost verbatim in its alias line, and the near-identical query could not
retrieve it inside the top FORTY results. Alone, the alias line is nothing but the questions the
note answers — which is what a query looks like — so giving it its own chunk should have fixed
this.

It didn't, on the first attempt: `$` under the `/m` flag means END OF LINE, not end of string, so
the lazy quantifier in the extraction regex stopped at the first newline and the chunk held only the
first line of a wrapped (multi-line) alias block. That is how the very phrase this change was built
to rescue ("alarm thresholds", line 3 of 4 in the wrapped alias block) stayed unretrievable AFTER
the fix shipped. `(?![\s\S])` is the end-of-input assertion that `/m` cannot break, and is what the
regex uses now.
