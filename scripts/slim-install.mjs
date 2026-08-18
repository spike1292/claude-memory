#!/usr/bin/env node
// postinstall: strip the 320 MB of node_modules this plugin can never execute — other platforms'
// native binaries, the browser WASM backend, and the image pipeline. See scripts/lib/slim-install.mjs
// for why each one is dead weight, and stubs/README.md for why two of them need a stub rather than
// a delete. Best-effort like every hook here: a failure must never fail an install.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pruneTargets,
  providerBlobs,
  findPackages,
  isStub,
  bytes,
  STUBBED,
  DELETED,
} from './lib/slim-install.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const modules = path.join(root, 'node_modules');
let freed = 0;
const done = [];

const drop = (target, label) => {
  const size = bytes(target);
  freed += size;
  fs.rmSync(target, { recursive: true, force: true });
  if (label) done.push(label);
  return size;
};

try {
  const binDir = path.join(modules, 'onnxruntime-node', 'bin');
  for (const dir of pruneTargets(binDir)) drop(dir, `ort-node ${path.relative(binDir, dir)}`);

  let gpu = 0;
  for (const blob of providerBlobs(binDir)) gpu += drop(blob, '') || 0;
  if (gpu) done.push('gpu execution providers');

  for (const dir of findPackages(modules, STUBBED)) {
    if (isStub(dir)) continue; // already slimmed
    const stub = path.join(root, 'stubs', path.basename(dir));
    if (!fs.existsSync(stub)) continue; // stub missing — leave the real package working
    drop(dir, `${path.basename(dir)} (stubbed)`);
    fs.cpSync(stub, dir, { recursive: true });
  }

  for (const dir of findPackages(modules, DELETED)) drop(dir, path.basename(dir));

  if (freed)
    console.log(`slim-install: freed ${Math.round(freed / 2 ** 20)} MB — ${done.join(', ')}`);
} catch (err) {
  console.warn(`slim-install skipped: ${err.message}`);
}
