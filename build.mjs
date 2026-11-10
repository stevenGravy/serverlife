import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync } from 'fs';
import path from 'path';

const watch = process.argv.includes('--watch');
const outdir = 'src/renderer';

mkdirSync(path.join(outdir, 'vendor'), { recursive: true });
// xterm ships its stylesheet separately; the CSP forbids remote styles.
copyFileSync('node_modules/@xterm/xterm/css/xterm.css', path.join(outdir, 'vendor', 'xterm.css'));

const options = {
  entryPoints: ['src/renderer/js/index.js'],
  bundle: true,
  outfile: path.join(outdir, 'app.js'),
  platform: 'browser',
  /*
   * ESM rather than an IIFE, because one of the bundled libraries — noVNC —
   * uses top-level await to decide what the browser can decode, and an IIFE
   * cannot express that. The page loads it with `type="module"`, which is
   * deferred by definition, so nothing else changes.
   */
  format: 'esm',
  target: ['chrome120'],
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
  /*
   * The guide is bundled as text rather than read at runtime: inside a
   * packaged app the markdown lives in app.asar, where openPath cannot reach
   * it, and a documentation viewer that only works from a source checkout is
   * not documentation.
   */
  loader: { '.css': 'empty', '.md': 'text' },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching renderer…');
} else {
  await esbuild.build(options);
}
