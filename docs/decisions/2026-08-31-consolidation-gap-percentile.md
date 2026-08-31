# Consolidation-gap bar: 25th percentile of member distances, not the median

**Date:** 2026-08-31 · **Status:** shipped (undated in the original source comment)

## The problem

`--clusters` flags a topic as a consolidation gap when no `permanent/` note is central enough to
say the cluster is already synthesised. Absolute cosine thresholds are meaningless here: E5 puts
every pair in a narrow high band, so the nearest `permanent/` note can score ~0.91 against a topic
it has nothing to do with.

## The fix: calibrate against the cluster itself

Compare the candidate `permanent/` note's similarity to the cluster centroid against the cluster's
own member distances — self-scaling, and model-independent. A note that genuinely covers the topic
should sit as close to the centroid as a typical *member* does.

## Rejected: the median

The bar is the **25th percentile** of member distances, not the median. Requiring a synthesis note
to be more central than half the cluster is arbitrary — half the members fail that test by
definition. Measured: a hand-written synthesis of a 22-note cluster landed at 0.945 against a 0.947
median and was reported as a gap, which is the test being wrong, not the note. "As close as a
typical member" is the real question, and the 25th percentile is what answers it without that false
positive.
