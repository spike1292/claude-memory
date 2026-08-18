// onnxruntime-node ships every platform's native runtime in one tarball: 210 MB under
// bin/napi-v6/{darwin,linux,win32}/{arm64,x64}, of which exactly one directory can ever load.
// Measured 2026-08-18 — 175 MB is unloadable on any given machine. npm cannot skip it (the
// binaries are inside the package, not optionalDependencies), so it gets deleted after install.
import fs from 'node:fs';
import path from 'node:path';

// Directory names onnxruntime-node uses; they happen to match process.platform / process.arch.
const OSES = new Set(['darwin', 'linux', 'win32']);
const ARCHES = new Set(['arm64', 'x64', 'ia32']);

const dirs = (p) => {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // missing bin/ — nothing to prune, not an error
  }
};

/**
 * Directories under binDir that cannot load on this platform.
 * Anything whose name is not a known os/arch is left alone: an upstream layout change must
 * make this prune nothing rather than guess. Never returns binDir or a napi-v* dir itself.
 */
export function pruneTargets(binDir, platform = process.platform, arch = process.arch) {
  const out = [];
  // Unknown host: every directory would look foreign and the whole runtime would go. Do nothing.
  if (!OSES.has(platform)) return out;
  for (const napi of dirs(binDir)) {
    const napiDir = path.join(binDir, napi);
    for (const os of dirs(napiDir)) {
      if (!OSES.has(os)) continue;
      const osDir = path.join(napiDir, os);
      if (os !== platform) {
        out.push(osDir);
        continue;
      }
      for (const a of dirs(osDir)) {
        if (ARCHES.has(a) && a !== arch) out.push(path.join(osDir, a));
      }
    }
  }
  return out;
}

// --- unused packages ------------------------------------------------------------------------
// @huggingface/transformers hard-depends on sharp (image pipeline) and onnxruntime-web (browser
// WASM backend). Neither runs on the text-embedding path, together they are 147 MB, and npm has
// no way to skip them: `overrides` pointing at a local stub writes a lockfile that `npm ci` then
// rejects ("Missing: sharp@ from lock file"), and Claude Code installs plugins with `npm ci`.
// So they are installed, then replaced here by the 1 KB stubs in stubs/. Deleting outright is not
// an option — both are static imports in transformers.node.mjs, so resolution fails before any
// code runs. Measured 2026-08-18.
export const STUBBED = ['sharp', 'onnxruntime-web'];

// sharp's libvips binaries; nothing else depends on them once sharp itself is a stub.
export const DELETED = ['@img'];

const STUB_VERSION = '0.0.0-stub';

/** Every directory named `name` that sits directly inside some node_modules/, at any depth. */
export function findPackages(root, names) {
  const found = [];
  const walk = (dir) => {
    for (const e of dirs(dir)) {
      const p = path.join(dir, e);
      if (names.includes(e) || (e.startsWith('@') && names.includes(`${e}/${path.basename(p)}`))) {
        found.push(p);
        continue; // do not descend into something we are about to replace
      }
      if (e.startsWith('@')) {
        for (const scoped of dirs(p)) {
          if (names.includes(`${e}/${scoped}`)) found.push(path.join(p, scoped));
          else walk(path.join(p, scoped, 'node_modules'));
        }
        continue;
      }
      walk(path.join(p, 'node_modules'));
    }
  };
  walk(root);
  return found;
}

/** True once the stub is in place — keeps a repeated postinstall from re-copying. */
export function isStub(dir) {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version === STUB_VERSION
    );
  } catch {
    return false;
  }
}

/** Recursive byte count — only used to report what was freed. */
export function bytes(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((n, e) => n + bytes(path.join(p, e)), 0);
}
