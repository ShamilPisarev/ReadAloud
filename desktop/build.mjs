// build.mjs — esbuild bundler for the ReadAloud desktop (Electron) app.
//
// Four bundles:
//   dist/main/main.js        — Electron main process (node, cjs).
//                              tesseract.js stays external: its node worker
//                              resolves scripts from node_modules at runtime.
//   dist/preload/player.js   — player window preload (contextBridge API)
//   dist/preload/overlay.js  — region-select overlay preload
//   dist/renderer/renderer.js— player window UI. Bundles the speech engines
//                              and chunker shared with the browser extension
//                              (../src/lib).

import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions[]} */
const configs = [
  {
    entryPoints: {
      'dist/main/main':      'src/main/main.ts',
      'dist/preload/player': 'src/preload/player.ts',
      'dist/preload/overlay': 'src/preload/overlay.ts',
    },
    bundle: true,
    outdir: '.',
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    external: ['electron', 'tesseract.js'],
    minify: false,
    sourcemap: watch,
    logLevel: 'info',
  },
  {
    entryPoints: {
      'dist/renderer/renderer': 'src/renderer/renderer.ts',
    },
    bundle: true,
    outdir: '.',
    format: 'iife',
    platform: 'browser',
    target: ['chrome130'],
    minify: !watch,
    sourcemap: watch,
    logLevel: 'info',
  },
];

if (watch) {
  const contexts = await Promise.all(configs.map(c => esbuild.context(c)));
  await Promise.all(contexts.map(ctx => ctx.watch()));
  console.log('[esbuild] watching for changes…');
} else {
  await Promise.all(configs.map(c => esbuild.build(c)));
}
