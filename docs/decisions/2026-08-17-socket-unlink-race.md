# The `--serve` socket unlink race, and why only `ECONNREFUSED` earns an unlink

**Date:** 2026-08-17 · **Status:** shipped

## The pileup this fixed

Servers used to pile up because `--serve` unlinked the socket unconditionally and rebound over it.
The previous server kept running with a listening fd on an unlinked inode: reachable by nobody,
exiting only when its 30-minute idle timer fired. Measured 2026-08-17 on a 16GB machine: **six
`--serve` processes at once**, each 797MB-1.5GB `phys_footprint` — mostly swapped out, so they cost
the machine without showing up in RSS.

## The fix

`socketIsLive()` probes the socket first (costs ~1ms) and only an `ECONNREFUSED` (nobody bound, the
file is a leftover) earns an unlink. A connect that neither succeeds nor errors is treated as LIVE
— not stealing from a server that might be there is the safe direction, and a genuinely wedged one
still dies on its idle timer.
