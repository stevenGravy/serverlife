#!/usr/bin/env node
/**
 * Unit tests, bundled and then run.
 *
 * The renderer is ES modules, and `package.json` says `"type": "commonjs"`
 * because the main process is CommonJS — so node, handed one of those `.js`
 * files directly, reads it as CommonJS and refuses the first `export`. Rather
 * than renaming eighty files or adding a second package.json, each test is
 * bundled with the esbuild that is already a dependency and the bundle is
 * what runs. It costs about a second and needs nothing installed.
 *
 *   node tools/run-tests.mjs            every tests/*.test.mjs
 *   node tools/run-tests.mjs tags       only the ones whose name matches
 *
 * The tests themselves are plain `node:test`, so a failure prints the usual
 * TAP output and the exit code is what CI reads.
 */

import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'tests');
if (!existsSync(testDir)) {
  console.error('No tests/ directory.');
  process.exit(1);
}

const filter = process.argv[2] || '';
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!files.length) {
  console.error(filter ? `No tests match "${filter}".` : 'No tests found.');
  process.exit(1);
}

/*
 * The bundles are written inside the project, not in the system temp dir.
 *
 * Node's own packages stay external — the point is to test the real module,
 * not a copy of its dependencies — and a bundle sitting in /tmp cannot
 * resolve them: there is no node_modules above it. Anything importing a
 * renderer module that reaches xterm failed on the import rather than on the
 * code. Under `node_modules/.cache` the lookup walks up to the project's own
 * and finds them.
 */
const cache = path.join(root, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const out = mkdtempSync(path.join(cache, 'serverlife-tests-'));
try {
  await esbuild.build({
    entryPoints: files.map((f) => path.join(testDir, f)),
    outdir: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    // node:test and friends stay external; everything under src/ is inlined,
    // which is the point — the test imports the real module, not a copy.
    packages: 'external',
    logLevel: 'warning',
    sourcemap: 'inline',
    // esbuild would otherwise write `.js`, which this package declares to be
    // CommonJS — the very thing the bundling is here to get around.
    /*
     * Dynamic imports stay dynamic, as chunks, rather than being folded into
     * the bundle. A module that reaches a terminal emulator *in a code path
     * the test never runs* should not have to load one to be tested — and
     * with everything inlined it did, which is why the parser in
     * quickconnect.js could not be tested without xterm.
     */
    splitting: true,
    outExtension: { '.js': '.mjs' },
    /*
     * The same loaders the app is built with. A test that imports a renderer
     * module pulls in whatever that module imports, and the guide is bundled
     * as text — without this, testing anything that reaches it fails on the
     * markdown rather than on the code.
     */
    loader: { '.css': 'empty', '.md': 'text' },
    /*
     * Where the project is, for the tests that reach into the main process.
     * Those modules are CommonJS and are loaded with `require` rather than
     * bundled, and a relative path in a bundle resolves against the temp
     * directory it was written to — which is not where the app lives.
     */
    define: { __PROJECT_ROOT__: JSON.stringify(root) },
  });

  /*
   * The test files, not the chunks beside them. With dynamic imports kept
   * lazy, esbuild writes shared chunks into the same directory — and handing
   * those to `node --test` runs a module as though it were a test, which
   * fails on whatever it expects to have been set up for it.
   */
  const wanted = new Set(files.map((f) => f.replace(/\.mjs$/, '') + '.mjs'));
  const bundled = readdirSync(out)
    .filter((f) => wanted.has(f))
    .map((f) => path.join(out, f));
  /*
   * Never run node --test with no files: it goes looking for tests itself,
   * finds the unbundled sources, and fails on the first `export` with a
   * message about CommonJS that has nothing to do with the test.
   */
  if (!bundled.length) {
    console.error('Nothing was bundled — no tests were run.');
    process.exit(1);
  }
  const r = spawnSync(process.execPath, ['--test', ...bundled], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
} finally {
  rmSync(out, { recursive: true, force: true });
}
