#!/usr/bin/env node
'use strict';

// Build a standalone Single Executable Application (SEA) for the *host*
// platform using Node's built-in SEA support.
//
// Unlike `bun build --compile` (see the build:binaries scripts), Node SEA
// CANNOT cross-compile: it embeds a copy of the very node binary running this
// script, so you only ever get a binary for this OS + arch. Use this when you
// don't want a second runtime (Bun) on the build machine; use Bun when you need
// to ship every platform from one place.
//
// Pipeline: bundle (esbuild) -> generate blob (node --experimental-sea-config)
// -> copy node -> inject blob (postject), re-signing on macOS.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');
const { inject } = require('postject');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const bundle = path.join(dist, 'bundle.js');
const blob = path.join(dist, 'sea-prep.blob');
const outPath = path.join(dist, `cssgrep-sea${isWin ? '.exe' : ''}`);
// The fuse string Node looks for when locating the injected blob (see the
// Node SEA docs); must match across generate + inject.
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

async function main() {
  fs.mkdirSync(dist, { recursive: true });

  // 1. Bundle the CJS entry and its (partly ESM) deps into one self-contained
  //    CJS file. SEA's main script cannot require() out of node_modules, so
  //    everything must be inlined first.
  esbuild.buildSync({
    entryPoints: [path.join(root, 'cli.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
  });

  // 2. Generate the SEA preparation blob from sea-config.json.
  execFileSync(process.execPath,
    ['--experimental-sea-config', path.join(root, 'sea-config.json')],
    { stdio: 'inherit', cwd: root });

  // 3. Copy the running node binary to serve as the executable shell.
  fs.copyFileSync(process.execPath, outPath);
  if (!isWin) fs.chmodSync(outPath, 0o755);

  // 4. macOS won't run a signed binary after we mutate it; strip the signature
  //    before injecting, re-sign (ad-hoc) afterwards.
  if (isMac) {
    try { execFileSync('codesign', ['--remove-signature', outPath]); } catch (e) {}
  }

  // 5. Inject the blob into the copied node binary.
  await inject(outPath, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: SENTINEL_FUSE,
    machoSegmentName: isMac ? 'NODE_SEA' : undefined,
  });

  if (isMac) {
    try { execFileSync('codesign', ['--sign', '-', outPath]); } catch (e) {}
  }

  process.stdout.write(`built ${path.relative(root, outPath)}\n`);
}

main().catch((e) => { process.stderr.write(`build:sea failed: ${e.message}\n`); process.exit(1); });
