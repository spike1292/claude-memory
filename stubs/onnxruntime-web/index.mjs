// Stub for onnxruntime-web. @huggingface/transformers imports it statically from
// transformers.node.mjs, so it cannot simply be absent — but nothing on the
// text-embedding path ever calls it. Throwing beats a silent wrong backend.
const die = () => {
  throw new Error(
    'onnxruntime-web is stubbed in this install (text-only build). ' +
      'If you need it, drop the override in package.json.',
  );
};

export default new Proxy(die, { get: () => die, apply: () => die() });
