# stubs/

Two ~1 KB packages that stand in for dependencies `@huggingface/transformers` pulls but this
plugin never executes. They are wired in via `overrides` in the root `package.json`.

| stub               | replaces | why                                                                       |
| ------------------ | -------- | ------------------------------------------------------------------------- |
| `sharp`            | 17 MB    | image pipeline (`sharp` + its `@img/*` libvips binaries); this is text-only |
| `onnxruntime-web`  | 130 MB   | browser WASM backend; in Node the runtime is `onnxruntime-node`             |

Both are **static** imports in `transformers.node.mjs`, so deleting them breaks module
resolution before any code runs — a stub is the only shape that works. Each throws when
touched, so a wrong-backend regression fails loudly instead of silently embedding through WASM.

Verified 2026-08-18 on `@huggingface/transformers@4.2.0`: `--check-embedding` reports cosine
1.000000 and `node --test` passes 60/60 with both stubs active. Re-check on a major bump —
if transformers ever routes text through `sharp`, the stub turns that into a loud throw.
