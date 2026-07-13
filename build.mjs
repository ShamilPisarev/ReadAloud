// build.mjs — esbuild bundler for the ReadAloud MV3 extension
//
// Why esbuild instead of tsc --emit:
//   tsc outputs bare extensionless imports (`from './storage'`).
//   Chrome/Brave's ES module loader requires explicit `.js` extensions and
//   refuses to load files with bare specifiers, silently breaking every
//   entry point.  esbuild bundles all imports into a single self-contained
//   file per entry point, so the output has zero external imports.

import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

async function copyRuntimeAssets() {
  const sourceDir = 'node_modules/@huggingface/transformers/dist';
  const targetDir = 'dist/wasm';
  const files = [
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
  ];
  await mkdir(targetDir, { recursive: true });
  await Promise.all(files.map(file =>
    copyFile(`${sourceDir}/${file}`, `${targetDir}/${file}`),
  ));
}

/** @type {import('esbuild').BuildOptions} */
const config = {
  // One output file per extension entry point.
  // Keys are output paths (relative to cwd); values are source entry points.
  entryPoints: {
    'dist/background/service-worker': 'src/background/service-worker.ts',
    'dist/content/content':           'src/content/content.ts',
    'dist/popup/popup':               'src/popup/popup.ts',
    'dist/offscreen/offscreen':       'src/offscreen/offscreen.ts',
  },

  bundle:    true,   // inline all imports → no external module resolution in browser
  outdir:    '.',    // output paths are already relative to project root
  format:    'esm',  // ES modules required for service_worker type:module
  target:    ['chrome116'],
  platform:  'browser',
  sourcemap: true,
  logLevel:  'info',
};

await copyRuntimeAssets();

if (watch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log('[esbuild] watching for changes…');
} else {
  await esbuild.build(config);
}
