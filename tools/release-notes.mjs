#!/usr/bin/env node
/**
 * Release notes for one version, extracted from CHANGELOG.md.
 *
 * The release workflow used to pass the whole changelog as the notes, which
 * pushed the download list — the reason most people open a release page — below
 * every version ever shipped. This prints the section for one version only, and
 * caps it, so the notes stay under a screenful and the assets stay in view.
 *
 *   node tools/release-notes.mjs [version] [--max-lines N]
 *
 * The version defaults to the one in package.json. A missing section is not an
 * error: the notes fall back to a link to the changelog, because failing the
 * release over a heading that was never written would be worse than terse notes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/stevenGravy/serverlife';
const CHANGELOG = `${REPO}/blob/main/CHANGELOG.md`;

const argv = process.argv.slice(2);
const maxIdx = argv.indexOf('--max-lines');
const maxLines = maxIdx === -1 ? 40 : parseInt(argv[maxIdx + 1], 10) || 40;
const version = argv.find((a) => !a.startsWith('--') && a !== String(maxLines))
  || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

/** The lines under `## [version]`, up to the next version heading. */
function section(md, v) {
  const lines = md.split('\n');
  // Headings are written `## [0.1.16] — 2026-09-15`; match on the bracketed
  // version alone so a changed date format cannot break the extraction.
  const isHeading = (l) => /^##\s+\[[^\]]+\]/.test(l);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[${v.replace(/\./g, '\\.')}\\]`).test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) { end = i; break; }
  }
  const body = lines.slice(start + 1, end);
  // Drop the `---` rule that separates versions, and blank edges.
  while (body.length && /^(-{3,}|\s*)$/.test(body[body.length - 1])) body.pop();
  while (body.length && !body[0].trim()) body.shift();
  return body;
}

const md = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const body = section(md, version);
const out = [];

if (!body || !body.length) {
  out.push(`ServerLife ${version}.`, '', `Changes: [CHANGELOG.md](${CHANGELOG})`);
} else if (body.length <= maxLines) {
  out.push(...body);
} else {
  // Cut where a bullet starts or at a blank line, so the notes do not end
  // mid-bullet — the changelog's bullets have no blank lines between them.
  let cut = maxLines;
  while (cut > 10 && body[cut].trim() && !/^- /.test(body[cut])) cut--;
  const kept = body.slice(0, cut);
  // A cut landing right after a `### Fixed` leaves a heading with nothing under
  // it, which reads like content went missing rather than being linked to.
  while (kept.length && /^(#{3,}\s|\s*$)/.test(kept[kept.length - 1])) kept.pop();
  out.push(...kept, '', `…and more — [full changelog](${CHANGELOG}).`);
}

out.push(
  '',
  '---',
  '',
  `Install notes and requirements: [README](${REPO}#install). `
    + 'On macOS, `install-mac.sh` below clears quarantine for you.',
);

process.stdout.write(out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n');
