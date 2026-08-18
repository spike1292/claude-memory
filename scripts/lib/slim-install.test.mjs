import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneTargets, providerBlobs, findPackages, isStub, STUBBED } from './slim-install.mjs';

// A fake onnxruntime-node bin/ tree. The dangerous failure is picking the wrong directory,
// so every case here is about what pruneTargets refuses to return.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-native-'));
  for (const p of [
    'napi-v6/darwin/arm64',
    'napi-v6/darwin/x64',
    'napi-v6/linux/x64',
    'napi-v6/win32/arm64',
  ]) {
    fs.mkdirSync(path.join(root, p), { recursive: true });
    fs.writeFileSync(path.join(root, p, 'onnxruntime_binding.node'), 'x');
  }
  return root;
}

test('keeps this platform+arch, drops every other', () => {
  const root = fixture();
  const got = pruneTargets(root, 'darwin', 'arm64')
    .map((p) => path.relative(root, p))
    .sort();
  assert.deepEqual(got, ['napi-v6/darwin/x64', 'napi-v6/linux', 'napi-v6/win32']);
});

test('the kept directory is never itself a target', () => {
  const root = fixture();
  for (const [platform, arch] of [
    ['darwin', 'arm64'],
    ['linux', 'x64'],
    ['win32', 'arm64'],
  ]) {
    const kept = path.join(root, 'napi-v6', platform, arch);
    for (const t of pruneTargets(root, platform, arch)) {
      assert.ok(!kept.startsWith(t), `${t} would delete the only loadable binary`);
    }
  }
});

test('unknown directory names are left alone, not guessed at', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'napi-v9/freebsd/riscv64'), { recursive: true });
  const got = pruneTargets(root, 'darwin', 'arm64').map((p) => path.relative(root, p));
  assert.ok(!got.some((p) => p.includes('freebsd')));
});

test('a missing bin/ prunes nothing instead of throwing', () => {
  assert.deepEqual(pruneTargets(path.join(os.tmpdir(), 'no-such-dir-prune-native')), []);
});

test('an unrecognised platform prunes nothing rather than everything', () => {
  const root = fixture();
  assert.deepEqual(pruneTargets(root, 'sunos', 'sparc'), []);
});

// findPackages decides what gets rm -rf'd, so the cases that matter are the ones it must NOT match.
function nm() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slim-install-'));
  const mk = (p) => fs.mkdirSync(path.join(root, p), { recursive: true });
  mk('sharp');
  mk('onnxruntime-web');
  mk('@img/sharp-darwin-arm64');
  mk('@huggingface/transformers/node_modules/sharp'); // nested copy, not hoisted
  mk('some-pkg/node_modules/onnxruntime-web');
  mk('sharp-cli'); // name merely starts with a target
  mk('other/src/sharp'); // not directly inside a node_modules/
  return root;
}

test('finds hoisted and nested copies, both plain and scoped', () => {
  const root = nm();
  const got = findPackages(root, ['sharp', 'onnxruntime-web', '@img']).map((p) =>
    path.relative(root, p),
  );
  assert.deepEqual(got.sort(), [
    '@huggingface/transformers/node_modules/sharp',
    '@img',
    'onnxruntime-web',
    'sharp',
    'some-pkg/node_modules/onnxruntime-web',
  ]);
});

test('does not match a lookalike name or a same-named source directory', () => {
  const root = nm();
  const got = findPackages(root, ['sharp']).map((p) => path.relative(root, p));
  assert.ok(!got.includes('sharp-cli'));
  assert.ok(!got.some((p) => p.startsWith('other/')));
});

test('isStub tells the 1 KB replacement from the real package', () => {
  const root = nm();
  const real = path.join(root, 'sharp');
  fs.writeFileSync(path.join(real, 'package.json'), '{"name":"sharp","version":"0.34.5"}');
  assert.equal(isStub(real), false);
  fs.writeFileSync(path.join(real, 'package.json'), '{"name":"sharp","version":"0.0.0-stub"}');
  assert.equal(isStub(real), true);
  assert.equal(isStub(path.join(root, 'onnxruntime-web')), false); // no package.json at all
});

test('the shipped stubs are what isStub accepts', () => {
  for (const name of STUBBED) {
    const dir = fileURLToPath(new URL(`../../stubs/${name}`, import.meta.url));
    assert.ok(isStub(dir), `stubs/${name} must carry the stub version`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name, name);
  }
});

test('providerBlobs takes GPU providers and leaves the CPU runtime and loader shim', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slim-gpu-'));
  const dir = path.join(root, 'napi-v6/linux/x64');
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    'libonnxruntime_providers_cuda.so',
    'libonnxruntime_providers_tensorrt.so',
    'libonnxruntime_providers_shared.so', // the loader shim — must survive
    'libonnxruntime.so.1.24.3', // the CPU runtime — must survive
    'onnxruntime_binding.node',
  ];
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  const got = providerBlobs(root)
    .map((p) => path.basename(p))
    .sort();
  assert.deepEqual(got, [
    'libonnxruntime_providers_cuda.so',
    'libonnxruntime_providers_tensorrt.so',
  ]);
});

test('providerBlobs on a macOS tree finds nothing to do', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slim-gpu-mac-'));
  const dir = path.join(root, 'napi-v6/darwin/arm64');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'libonnxruntime.1.24.3.dylib'), 'x');
  assert.deepEqual(providerBlobs(root), []);
});
