/**
 * Terminal fonts: the ones worth offering, which of them this machine has,
 * and the CSS stack a choice becomes.
 *
 * The setting used to be a free-text box, which only helped someone who
 * already knew the exact family name of a font they had installed. A list
 * of what is actually here is what people expect from a terminal's settings.
 * There is no API that lists a machine's fonts without a permission prompt,
 * so the list is the coding fonts people use, each checked for presence by
 * measuring it: a family that is not installed renders in the fallback, at
 * the fallback's width, against two different fallbacks.
 */

import { BUNDLED_FONTS } from './bundledfonts.js';

/** Fallbacks for every platform, after whatever was chosen. */
export const DEFAULT_STACK = 'SFMono-Regular, Menlo, Consolas, "Cascadia Mono", "DejaVu Sans Mono", '
  + '"Liberation Mono", "Noto Sans Mono", monospace';

/** Monospaced families worth offering, roughly by how often they are used. */
export const MONO_FONTS = [
  'SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'Fira Mono', 'Cascadia Code',
  'Cascadia Mono', 'Consolas', 'Source Code Pro', 'Hack', 'IBM Plex Mono', 'Roboto Mono',
  'Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', 'Inconsolata',
  'Iosevka', 'Iosevka Term', 'Victor Mono', 'Geist Mono', 'Monaspace Neon', 'Monaspace Argon',
  'Monaspace Xenon', 'Monaspace Radon', 'Monaspace Krypton', 'Berkeley Mono', 'Input Mono',
  'Anonymous Pro', 'Space Mono', 'Red Hat Mono', 'Commit Mono', 'Intel One Mono', 'Maple Mono',
  'Hasklig', 'Operator Mono', 'Comic Mono', 'Droid Sans Mono', 'PT Mono', 'Andale Mono',
  'Lucida Console', 'Courier New', 'Courier',
  // Nerd Font builds, which carry the icons prompt themes draw with.
  'MesloLGS NF', 'MesloLGS Nerd Font', 'JetBrainsMono Nerd Font', 'FiraCode Nerd Font',
  'Hack Nerd Font', 'CaskaydiaCove Nerd Font',
];

/**
 * The CSS font-family a stored setting becomes.
 *
 * A setting is either one family name, from the list, or whatever someone
 * typed — which may already be a stack. A single name is quoted and given
 * the fallbacks; anything with a comma is taken as the stack it already is;
 * nothing is the default.
 */
export function fontStack(setting) {
  const v = String(setting || '').trim();
  if (!v) return DEFAULT_STACK;
  if (v.includes(',')) return v;
  const name = v.replace(/^["']|["']$/g, '');
  return `"${name.replace(/"/g, '')}", ${DEFAULT_STACK}`;
}

/**
 * The fonts that ship with the app: fixed-width ones for a terminal, or the
 * display faces — blackletter, pixel, marker — which are not, and draw a
 * terminal with its columns out of line.
 */
const BUNDLED = new Set(BUNDLED_FONTS.map((f) => f.family));
export function bundledFonts({ fixed }) {
  return BUNDLED_FONTS.filter((f) => f.fixed === fixed).map((f) => f.family);
}

/**
 * The font-picker choices, grouped: installed, then bundled fixed-width, then
 * bundled display faces. For a `select()` (Settings) or, via `.flat`, a menu.
 */
export function fontChoices() {
  return [
    { group: 'Installed on this machine', fonts: installedFonts() },
    { group: 'Bundled with ServerLife', fonts: bundledFonts({ fixed: true }) },
    { group: 'Bundled display fonts (not fixed-width)', fonts: bundledFonts({ fixed: false }) },
  ].filter((g) => g.fonts.length);
}

/**
 * Which of `names` this machine can draw. Needs a DOM; cached per run.
 *
 * A bundled family is left out of the answer: its @font-face would make it
 * look installed, and it is listed among the bundled ones already.
 */
let cached = null;
export function installedFonts(names = MONO_FONTS) {
  if (cached && names === MONO_FONTS) return cached;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const sample = 'mmmmmmmmmmlli01OoWw{}[]';
  const width = (font) => { ctx.font = font; return ctx.measureText(sample).width; };
  const bases = ['monospace', 'serif'].map((b) => [b, width(`72px ${b}`)]);
  const found = names.filter((n) => !BUNDLED.has(n) && bases.some(([b, w]) => width(`72px "${n}", ${b}`) !== w));
  if (names === MONO_FONTS) cached = found;
  return found;
}
