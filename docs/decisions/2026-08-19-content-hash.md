# Why sha256 over sha1 for content hashing

**Date:** 2026-08-19 · **Status:** shipped

`contentHash()` uses `crypto.hash('sha256', raw, 'hex')`: stdlib, one-shot, no dependency. This is
change detection, not integrity, so speed would win over strength — but there is nothing to win.
Measured 2026-08-19, 8000 note-sized 4 KB strings (32 MB, several times this vault): sha256 36 ms,
sha1 24 ms. Twelve milliseconds across a whole vault, against ~1.5 s to embed ONE chunk. sha256 is
hardware-accelerated everywhere this runs and is not the digest a FIPS build disables, so it is the
boring choice.
