/**
 * Named themes: the whole window and, unless another palette is chosen, the
 * terminal, in one choice.
 *
 * Each theme gives only what defines it — a background, a foreground, an
 * accent and the sixteen terminal colours — and the panels, borders and
 * dimmed text are mixed from the first two. That keeps dozens of themes from
 * being dozens of hand-tuned blocks of seventeen tokens, and keeps every one of
 * them stepping between surfaces the same way the built-in dark and light do.
 *
 * `term` is either the sixteen colours, or the id of a palette in
 * TERMINAL_PALETTES below (Nord, Dracula, Solarized, Gruvbox), so the same
 * colours are not written down twice. The palettes live here rather than
 * beside xterm so that this module is plain data, and can be tested as such.
 *
 * The rules are injected ahead of styles.css, so the cascade is unchanged:
 * a chosen accent recolours the highlight on top of a theme, and a skin still
 * repaints everything.
 */

const ansi = (s) => {
  const [black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = s.split(/\s+/);
  return { black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite };
};

export const APP_THEMES = [
  /* ---------------- dark ---------------- */
  { id: 'midnight', label: 'Midnight (true black)', tone: 'dark', bg: '#000000', fg: '#d0d4dc', accent: '#4c8dff',
    term: ansi('#1c202b #f85149 #3fb950 #d29922 #4c8dff #a371f7 #39c5cf #b1bac4 #4a5266 #ff7b72 #56d364 #e3b341 #79b8ff #bc8cff #56d4dd #f0f6fc') },
  { id: 'github-dark', label: 'GitHub dark', tone: 'dark', bg: '#0d1117', fg: '#c9d1d9', accent: '#58a6ff',
    term: ansi('#484f58 #ff7b72 #3fb950 #d29922 #58a6ff #bc8cff #39c5cf #b1bac4 #6e7681 #ffa198 #56d364 #e3b341 #79c0ff #d2a8ff #56d4dd #f0f6fc') },
  { id: 'nord', label: 'Nord', tone: 'dark', bg: '#2e3440', fg: '#d8dee9', accent: '#88c0d0', term: 'nord' },
  { id: 'dracula', label: 'Dracula', tone: 'dark', bg: '#282a36', fg: '#f8f8f2', accent: '#bd93f9', term: 'dracula' },
  { id: 'solarized-dark', label: 'Solarized dark', tone: 'dark', bg: '#002b36', fg: '#93a1a1', accent: '#268bd2', term: 'solarized-dark' },
  { id: 'gruvbox', label: 'Gruvbox dark', tone: 'dark', bg: '#282828', fg: '#ebdbb2', accent: '#fe8019', term: 'gruvbox' },
  { id: 'tokyo-night', label: 'Tokyo Night', tone: 'dark', bg: '#1a1b26', fg: '#c0caf5', accent: '#7aa2f7',
    term: ansi('#15161e #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6 #414868 #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #c0caf5') },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', tone: 'dark', bg: '#1e1e2e', fg: '#cdd6f4', accent: '#cba6f7',
    term: ansi('#45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #bac2de #585b70 #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #a6adc8') },
  { id: 'catppuccin-macchiato', label: 'Catppuccin Macchiato', tone: 'dark', bg: '#24273a', fg: '#cad3f5', accent: '#8aadf4',
    term: ansi('#494d64 #ed8796 #a6da95 #eed49f #8aadf4 #f5bde6 #8bd5ca #b8c0e0 #5b6078 #ed8796 #a6da95 #eed49f #8aadf4 #f5bde6 #8bd5ca #a5adcb') },
  { id: 'one-dark', label: 'One Dark', tone: 'dark', bg: '#282c34', fg: '#abb2bf', accent: '#61afef',
    term: ansi('#3f4451 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #abb2bf #5c6370 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #ffffff') },
  { id: 'monokai', label: 'Monokai', tone: 'dark', bg: '#272822', fg: '#f8f8f2', accent: '#a6e22e',
    term: ansi('#3e3d32 #f92672 #a6e22e #f4bf75 #66d9ef #ae81ff #a1efe4 #f8f8f2 #75715e #f92672 #a6e22e #f4bf75 #66d9ef #ae81ff #a1efe4 #f9f8f5') },
  { id: 'rose-pine', label: 'Rosé Pine', tone: 'dark', bg: '#191724', fg: '#e0def4', accent: '#c4a7e7',
    term: ansi('#26233a #eb6f92 #31748f #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4 #6e6a86 #eb6f92 #31748f #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4') },
  { id: 'everforest-dark', label: 'Everforest dark', tone: 'dark', bg: '#2d353b', fg: '#d3c6aa', accent: '#a7c080',
    term: ansi('#475258 #e67e80 #a7c080 #dbbc7f #7fbbb3 #d699b6 #83c092 #d3c6aa #859289 #e67e80 #a7c080 #dbbc7f #7fbbb3 #d699b6 #83c092 #d3c6aa') },
  { id: 'kanagawa', label: 'Kanagawa', tone: 'dark', bg: '#1f1f28', fg: '#dcd7ba', accent: '#7e9cd8',
    term: ansi('#16161d #c34043 #76946a #c0a36e #7e9cd8 #957fb8 #6a9589 #c8c093 #727169 #e82424 #98bb6c #e6c384 #7fb4ca #938aa9 #7aa89f #dcd7ba') },
  { id: 'ayu-mirage', label: 'Ayu Mirage', tone: 'dark', bg: '#1f2430', fg: '#cbccc6', accent: '#ffcc66',
    term: ansi('#191e2a #ed8274 #a6cc70 #fad07b #6dcbfa #cfbafa #90e1c6 #c7c7c7 #686868 #f28779 #bae67e #ffd580 #73d0ff #d4bfff #95e6cb #ffffff') },
  { id: 'night-owl', label: 'Night Owl', tone: 'dark', bg: '#011627', fg: '#d6deeb', accent: '#82aaff',
    term: ansi('#1d3b53 #ef5350 #22da6e #addb67 #82aaff #c792ea #21c7a8 #d6deeb #575656 #ef5350 #22da6e #ffeb95 #82aaff #c792ea #7fdbca #ffffff') },
  { id: 'material-ocean', label: 'Material Ocean', tone: 'dark', bg: '#0f111a', fg: '#a6accd', accent: '#84ffff',
    term: ansi('#546e7a #ff5370 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #a6accd #717cb4 #ff5370 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #ffffff') },
  { id: 'horizon', label: 'Horizon', tone: 'dark', bg: '#1c1e26', fg: '#e0e0e0', accent: '#e95678',
    term: ansi('#16161c #e95678 #29d398 #fab795 #26bbd9 #ee64ac #59e1e3 #e5e5e5 #6c6f93 #ec6a88 #3fdaa4 #fbc3a7 #3fc4de #f075b5 #6be4e6 #e6e6e6') },
  { id: 'cobalt2', label: 'Cobalt2', tone: 'dark', bg: '#193549', fg: '#ffffff', accent: '#ffc600',
    term: ansi('#000000 #ff0000 #38de21 #ffe50a #1460d2 #ff005d #00bbbb #bbbbbb #555555 #f40e17 #3bd01d #edc809 #5555ff #ff55ff #6ae3fa #ffffff') },
  { id: 'catppuccin-frappe', label: 'Catppuccin Frappé', tone: 'dark', bg: '#303446', fg: '#c6d0f5', accent: '#ca9ee6',
    term: ansi('#51576d #e78284 #a6d189 #e5c890 #8caaee #f4b8e4 #81c8be #b5bfe2 #626880 #e78284 #a6d189 #e5c890 #8caaee #f4b8e4 #81c8be #a5adce') },
  { id: 'palenight', label: 'Palenight', tone: 'dark', bg: '#292d3e', fg: '#a6accd', accent: '#c792ea',
    term: ansi('#676e95 #ff5370 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #a6accd #676e95 #ff5370 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #ffffff') },
  { id: 'oceanic-next', label: 'Oceanic Next', tone: 'dark', bg: '#1b2b34', fg: '#cdd3de', accent: '#6699cc',
    term: ansi('#343d46 #ec5f67 #99c794 #fac863 #6699cc #c594c5 #5fb3b3 #cdd3de #65737e #ec5f67 #99c794 #fac863 #6699cc #c594c5 #5fb3b3 #d8dee9') },
  { id: 'iceberg', label: 'Iceberg', tone: 'dark', bg: '#161821', fg: '#c6c8d1', accent: '#84a0c6',
    term: ansi('#1e2132 #e27878 #b4be82 #e2a478 #84a0c6 #a093c7 #89b8c2 #c6c8d1 #6b7089 #e98989 #c0ca8e #e9b189 #91acd1 #ada0d3 #95c4ce #d2d4de') },
  // Phosphor green on green-black, like the Matrix skin, but an error still
  // reads red and a directory still reads blue: the skin for a demo, this
  // for a working day.
  { id: 'matrix', label: 'Matrix', tone: 'dark', bg: '#020a04', fg: '#8fef9f', accent: '#00ff41',
    term: ansi('#0a1f0f #e5484d #00d936 #b5e533 #3ea8d8 #a87fd6 #30d5b0 #9fe8ae #2f6b3e #ff6b6b #00ff41 #d7ff5f #6cc4f0 #c69cf0 #5ff5cf #d4ffdc') },
  { id: 'high-contrast', label: 'High contrast', tone: 'dark', bg: '#000000', fg: '#ffffff', accent: '#409cff', term: 'high-contrast' },

  /* ---------------- light ---------------- */
  { id: 'solarized-light', label: 'Solarized light', tone: 'light', bg: '#fdf6e3', fg: '#586e75', accent: '#268bd2', term: 'solarized-light' },
  { id: 'gruvbox-light', label: 'Gruvbox light', tone: 'light', bg: '#fbf1c7', fg: '#3c3836', accent: '#af3a03',
    term: ansi('#3c3836 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #7c6f64 #928374 #9d0006 #79740e #b57614 #076678 #8f3f71 #427b58 #3c3836') },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', tone: 'light', bg: '#eff1f5', fg: '#4c4f69', accent: '#8839ef',
    term: ansi('#5c5f77 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #acb0be #6c6f85 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #bcc0cc') },
  { id: 'one-light', label: 'One Light', tone: 'light', bg: '#fafafa', fg: '#383a42', accent: '#4078f2',
    term: ansi('#383a42 #e45649 #50a14f #c18401 #4078f2 #a626a4 #0184bc #a0a1a7 #696c77 #e45649 #50a14f #c18401 #4078f2 #a626a4 #0184bc #383a42') },
  { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', tone: 'light', bg: '#faf4ed', fg: '#575279', accent: '#907aa9',
    term: ansi('#575279 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #9893a5 #797593 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #575279') },
  { id: 'everforest-light', label: 'Everforest light', tone: 'light', bg: '#fdf6e3', fg: '#5c6a72', accent: '#8da101',
    term: ansi('#5c6a72 #f85552 #8da101 #dfa000 #3a94c5 #df69ba #35a77c #a6b0a0 #829181 #f85552 #8da101 #dfa000 #3a94c5 #df69ba #35a77c #5c6a72') },
  { id: 'ayu-light', label: 'Ayu light', tone: 'light', bg: '#fafafa', fg: '#5c6166', accent: '#fa8d3e',
    term: ansi('#5c6166 #f07171 #86b300 #eba400 #399ee6 #a37acc #4cbf99 #abb0b6 #828c99 #f07171 #86b300 #eba400 #399ee6 #a37acc #4cbf99 #5c6166') },
  { id: 'tokyo-night-day', label: 'Tokyo Night Day', tone: 'light', bg: '#e1e2e7', fg: '#3760bf', accent: '#2e7de9',
    term: ansi('#3760bf #f52a65 #587539 #8c6c3e #2e7de9 #9854f1 #007197 #6172b0 #a1a6c5 #f52a65 #587539 #8c6c3e #2e7de9 #9854f1 #007197 #3760bf') },
  { id: 'github-light-hc', label: 'GitHub light high contrast', tone: 'light', bg: '#ffffff', fg: '#0e1116', accent: '#0349b4',
    term: ansi('#0e1116 #a0111f #024c1a #3f2200 #0349b4 #622cbc #1b4b91 #66707b #4b535d #86061d #055d20 #4e2c00 #1168e3 #844ae7 #3192aa #0e1116') },
  { id: 'nord-light', label: 'Nord light', tone: 'light', bg: '#eceff4', fg: '#2e3440', accent: '#5e81ac',
    term: ansi('#3b4252 #bf616a #5f7f4f #b0862f #5e81ac #b48ead #4f8a96 #4c566a #4c566a #bf616a #6b8f5a #c0963a #81a1c1 #b48ead #5e9aa6 #2e3440') },
  { id: 'quiet-light', label: 'Quiet light', tone: 'light', bg: '#f5f5f5', fg: '#333333', accent: '#4b83cd',
    term: ansi('#333333 #aa3731 #448c27 #cb9000 #325cc0 #7a3e9d #0083b2 #777777 #777777 #aa3731 #448c27 #cb9000 #325cc0 #7a3e9d #0083b2 #333333') },
  { id: 'selenized-light', label: 'Selenized light', tone: 'light', bg: '#fbf3db', fg: '#53676d', accent: '#0072d4',
    term: ansi('#53676d #d2212d #489100 #ad8900 #0072d4 #ca4898 #009c8f #909995 #909995 #cc1729 #428b00 #a78300 #006dce #c44392 #00978a #3a4d53') },
  { id: 'paper', label: 'Paper (sepia)', tone: 'light', bg: '#f4ecd8', fg: '#433422', accent: '#a0522d',
    term: ansi('#433422 #b03a2e #5a7a2e #8a6a10 #2f5d8a #8a4a7a #2e7a72 #8a7a60 #6f6050 #c0483a #6a8a3a #a07a20 #3f6d9a #9a5a8a #3e8a82 #2a2016') },
];

export const themeById = (id) => APP_THEMES.find((t) => t.id === id) || null;

/**
 * Named terminal palettes, independent of the app's own theme.
 *
 * The UI's theme is about the window; this is about the sixteen colours a
 * program's output is drawn in, and people have strong and long-standing
 * preferences there — a Solarized user wants Solarized whatever colour the
 * sidebar is. 'app' keeps the old behaviour of following the theme and any
 * skin.
 */
export const TERMINAL_PALETTES = [
  { value: 'app', label: 'Follow the app theme' },
  {
    value: 'solarized-dark',
    label: 'Solarized dark',
    theme: {
      background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', cursorAccent: '#002b36',
      selectionBackground: '#073642aa',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    value: 'solarized-light',
    label: 'Solarized light',
    theme: {
      background: '#fdf6e3', foreground: '#586e75', cursor: '#586e75', cursorAccent: '#fdf6e3',
      selectionBackground: '#eee8d5aa',
      black: '#eee8d5', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#073642',
      brightBlack: '#93a1a1', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#839496',
      brightBlue: '#657b83', brightMagenta: '#6c71c4', brightCyan: '#586e75', brightWhite: '#002b36',
    },
  },
  {
    value: 'gruvbox',
    label: 'Gruvbox dark',
    theme: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828',
      selectionBackground: '#504945aa',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
      brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  },
  {
    value: 'nord',
    label: 'Nord',
    theme: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440',
      selectionBackground: '#434c5eaa',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  {
    value: 'dracula',
    label: 'Dracula',
    theme: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36',
      selectionBackground: '#44475aaa',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  {
    value: 'high-contrast',
    label: 'High contrast',
    theme: {
      background: '#000000', foreground: '#ffffff', cursor: '#ffffff', cursorAccent: '#000000',
      selectionBackground: '#3355ffaa',
      black: '#000000', red: '#ff3b30', green: '#28cd41', yellow: '#ffcc00',
      blue: '#409cff', magenta: '#ff6ff2', cyan: '#5ac8fa', white: '#f2f2f7',
      brightBlack: '#8e8e93', brightRed: '#ff6961', brightGreen: '#5ff08a', brightYellow: '#ffe066',
      brightBlue: '#7cc0ff', brightMagenta: '#ff9df8', brightCyan: '#8fe0ff', brightWhite: '#ffffff',
    },
  },
];

/** A named app theme's own colours as a whole xterm palette. */
function fromAppTheme(t) {
  return {
    background: t.bg, foreground: t.fg, cursor: t.accent, cursorAccent: t.bg,
    selectionBackground: t.accent + '44',
    ...t.term,
  };
}

// Every app theme that brings its own colours can also be picked for the
// terminal alone; the ones that borrow an existing palette are listed already.
for (const t of APP_THEMES) {
  if (typeof t.term === 'object') TERMINAL_PALETTES.push({ value: t.id, label: t.label, theme: fromAppTheme(t) });
}

export function paletteByName(name) {
  return TERMINAL_PALETTES.find((p) => p.value === name && p.theme)?.theme || null;
}

/** The sixteen colours behind an app theme, whichever way it names them. */
export function appThemeAnsi(t) {
  return typeof t.term === 'string' ? paletteByName(t.term) : t.term;
}

/** An app theme as the terminal draws it: background, cursor and all. */
export function appThemePalette(t) {
  return typeof t.term === 'string' ? paletteByName(t.term) : fromAppTheme(t);
}

/** 'light' or 'dark' for any theme setting, or null for "follow the system". */
export function toneOf(id) {
  if (id === 'light' || id === 'dark') return id;
  return themeById(id)?.tone || null;
}

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
/** `a` moved toward `b` by `t` (0..1). */
export const mix = (a, b, t) => {
  const x = hex(a);
  const y = hex(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
};

/** WCAG relative luminance and contrast ratio. */
const luminance = (c) => {
  const [r, g, b] = hex(c).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/**
 * `c`, pushed toward black on a light theme or white on a dark one just far
 * enough to reach `min` against `against`.
 *
 * Some published palettes are softer than a window can afford — Solarized
 * light's body text, Tokyo Night Day's blue-on-grey — and they read fine in
 * an editor at one size and badly in a sidebar at another. The terminal keeps
 * the palette exactly; the chrome gets the nearest shade of the same colour
 * that is readable.
 */
function readable(c, against, min, light) {
  const toward = light ? '#000000' : '#ffffff';
  for (let k = 0; k <= 1; k += 0.02) {
    const v = mix(c, toward, k);
    if (contrast(v, against) >= min) return v;
  }
  return toward;
}

/** The seventeen UI tokens for a theme, mixed from what it defines. */
export function themeTokens(t, ansiColours) {
  const light = t.tone === 'light';
  const step = (k) => mix(t.bg, t.fg, k);
  const panel3 = step(light ? 0.11 : 0.095);
  // Body text has to hold on the darkest surface it sits on, not just the
  // background; dimmed text and the accent only have to be legible.
  const text = readable(t.fg, panel3, 4.5, light);
  const accent = readable(t.accent, t.bg, 3, light);
  return {
    '--bg': t.bg,
    '--panel': step(0.035),
    '--panel-2': step(light ? 0.07 : 0.065),
    '--panel-3': panel3,
    '--border': step(light ? 0.17 : 0.13),
    '--border-soft': step(light ? 0.09 : 0.08),
    '--text': text,
    '--text-dim': readable(mix(text, t.bg, 0.25), t.bg, 4.5, light),
    '--muted': readable(mix(text, t.bg, 0.45), t.bg, 3, light),
    '--accent': accent,
    '--accent-dim': mix(accent, t.bg, light ? 0.55 : 0.4),
    '--green': ansiColours.green,
    '--red': ansiColours.red,
    '--amber': ansiColours.yellow,
    '--purple': ansiColours.magenta,
    '--scroll-thumb': step(light ? 0.2 : 0.16),
    '--scroll-thumb-hover': step(light ? 0.3 : 0.24),
  };
}

/** The stylesheet for every named theme, as one string. */
export function themeStylesheet() {
  return APP_THEMES.map((t) => {
    const tokens = themeTokens(t, appThemeAnsi(t));
    const body = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join('\n');
    return `:root[data-theme="${t.id}"] {\n${body}\n  color-scheme: ${t.tone};\n}`;
  }).join('\n');
}
