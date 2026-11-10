/**
 * A pane's own look: its colours and its font, apart from the rest of the
 * window. A light pane for the production box among dark ones, a bigger,
 * plainer font for the one being shown on a call.
 *
 * `pane.style` holds what was chosen — `{ theme, font }`, either one absent
 * meaning "as the app has it". A style can also be remembered for the host
 * the pane is on (or for local shells), in `settings.paneStyles`, keyed by
 * the host's id, and a new pane on that host starts with it.
 */
import { state } from './state.js';
import { status, modal } from './ui.js';
import { activeTheme, LIGHT_THEME, DARK_THEME } from './term.js';
import { APP_THEMES, TERMINAL_PALETTES, themeById, paletteByName, appThemePalette, appThemeAnsi, themeTokens } from './themes.js';
import { fontStack, fontChoices } from './fonts.js';

/** The key a pane's style is remembered under: its host, or "local". */
export function paneStyleKey(pane) {
  if (!pane) return '';
  if (pane.kind === 'local' && !pane.aiSession) return 'local';
  const conn = pane.connId ? state.getConnection(pane.connId) : null;
  return conn?.hostId || '';
}

/** The terminal palette a theme choice means, or null for "as the app has it". */
export function paletteFor(theme) {
  if (!theme) return null;
  if (theme === 'light') return LIGHT_THEME;
  if (theme === 'dark') return DARK_THEME;
  const named = paletteByName(theme);
  if (named) return { ...(named.background && isLight(named.background) ? LIGHT_THEME : DARK_THEME), ...named };
  const t = themeById(theme);
  if (t) return { ...(t.tone === 'light' ? LIGHT_THEME : DARK_THEME), ...appThemePalette(t) };
  return null;
}

function isLight(hex) {
  const m = /^#?([0-9a-f]{6})/i.exec(hex || '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150;
}

/**
 * The window colours for a theme choice — background, panels, borders, text,
 * accent — as the app's own named themes have them, so the pane's file
 * browser and header take the look along with its terminal. A plain light or
 * dark, or a terminal palette, is turned into the same set from its
 * background, text and blue.
 */
export function uiTokensFor(theme) {
  if (!theme) return null;
  const t = themeById(theme);
  if (t) return { tone: t.tone, tokens: themeTokens(t, appThemeAnsi(t)) };
  const p = paletteFor(theme);
  if (!p || !/^#[0-9a-f]{6}$/i.test(p.background) || !/^#[0-9a-f]{6}$/i.test(p.foreground)) return null;
  const tone = isLight(p.background) ? 'light' : 'dark';
  return { tone, tokens: themeTokens({ tone, bg: p.background, fg: p.foreground, accent: p.blue || '#4c8dff' }, p) };
}

/** Put a theme's window colours on a pane, or take them off. */
function paintChrome(el, theme) {
  const prev = el.dataset.paneTokens ? el.dataset.paneTokens.split(',') : [];
  for (const k of prev) el.style.removeProperty(k);
  el.style.removeProperty('color-scheme');
  delete el.dataset.paneTokens;
  delete el.dataset.paneTone;
  const ui = uiTokensFor(theme);
  if (!ui) return;
  for (const [k, v] of Object.entries(ui.tokens)) el.style.setProperty(k, v);
  el.style.setProperty('color-scheme', ui.tone);
  el.dataset.paneTokens = Object.keys(ui.tokens).join(',');
  el.dataset.paneTone = ui.tone;
}

/** What a pane is styled as: its own choice, else what its host remembers. */
function styleOf(pane) {
  if (pane.style) return pane.style;
  const key = paneStyleKey(pane);
  return (key && (state.settings.paneStyles || {})[key]) || null;
}

/**
 * Paint a pane as its style says — or as the app does, for whatever it
 * leaves unsaid. Called when a pane is made, when its style changes, and
 * whenever the app's theme or font does, so a styled pane keeps its look.
 */
export function applyPaneStyle(pane) {
  const v = pane?.view;
  if (!v?.term) return;
  const st = styleOf(pane);
  const palette = paletteFor(st?.theme) || activeTheme();
  v.setTheme(palette);
  v.term.options.fontFamily = fontStack(st?.font || state.settings.fontFamily);
  // The few pixels of padding round the terminal are the pane's, not the
  // window's: a light pane in a dark window should not have a dark rim.
  const host = pane.element?.querySelector('.pane-term');
  if (host) host.style.background = st?.theme ? palette.background : '';
  pane.element?.classList.toggle('styled', !!(st?.theme || st?.font));
  // The rest of the pane — its header and its file browser — in the same
  // colours, by giving it the theme's variables; everything in it reads them.
  if (pane.element) paintChrome(pane.element, st?.theme || null);
  v.fitNow?.();
}

/** Every pane, after the app's own theme or font has changed. */
export function applyAllPaneStyles() {
  for (const p of state.panes.values()) applyPaneStyle(p);
}

function setStyle(pane, patch) {
  const next = { ...(styleOf(pane) || {}), ...patch };
  for (const k of Object.keys(next)) if (!next[k]) delete next[k];
  // Empty rather than null: a pane put back to the app's look must not fall
  // back to its host's.
  pane.style = next;
  applyPaneStyle(pane);
  afterChange(pane);
}

/** What the question calls the pane's host. */
function hostName(pane) {
  if (paneStyleKey(pane) === 'local') return 'local shells';
  const conn = pane.connId ? state.getConnection(pane.connId) : null;
  return conn?.label || 'this host';
}

/*
 * After a pane's look is changed: should the host keep it? Asked once per
 * pane, the first time — trying a few themes in a row asks once, not each
 * time. Once answered yes, later changes in that pane carry on to the host
 * without asking; once answered no, the pane is left to itself.
 */
async function afterChange(pane) {
  const key = paneStyleKey(pane);
  if (!key) return;
  const st = pane.style || {};
  const has = !!(st.theme || st.font);
  if (pane.styleForHost === true) { await remember(pane, has, { quiet: true }); return; }
  if (pane.styleForHost === false || !has) return;
  pane.styleForHost = null;
  const saved = (state.settings.paneStyles || {})[key];
  const answer = await modal({
    title: `Use this look for ${hostName(pane)} from now on?`,
    render: (b) => b.append(Object.assign(document.createElement('div'), {
      className: 'hint',
      textContent: (saved ? 'It replaces the look saved before. ' : '')
        + (key === 'local' ? 'New local shells' : `New panes on ${hostName(pane)}`)
        + ' will start this way. Change or clear it from Pane style on a pane, or from the right-click menu in the host list.',
    })),
    buttons: [
      { label: 'Just this pane', value: 'no' },
      { label: 'Yes, from now on', class: 'primary-btn', value: 'yes' },
    ],
  });
  pane.styleForHost = answer === 'yes';
  if (answer === 'yes') await remember(pane, true);
}

async function remember(pane, on, { quiet = false } = {}) {
  const key = paneStyleKey(pane);
  if (!key) return;
  const all = { ...(state.settings.paneStyles || {}) };
  const st = styleOf(pane);
  if (on && st && (st.theme || st.font)) all[key] = { theme: st.theme || null, font: st.font || null };
  else delete all[key];
  state.settings = await window.api.settings.set({ paneStyles: all });
  if (!quiet) status(on ? 'This look will be used for new panes on this host' : 'New panes on this host will look like the rest');
}

const tick = (on) => (on ? '✓' : '');

/** The "Pane style" entry for a pane's right-click menu. */
export function paneStyleMenu(pane) {
  if (!pane?.view?.term) return null;
  const st = styleOf(pane) || {};
  const key = paneStyleKey(pane);
  const remembered = key && (state.settings.paneStyles || {})[key];
  const themeItem = (value, label) => ({
    label, icon: tick(st.theme === value), onClick: () => setStyle(pane, { theme: value }),
  });
  const dark = APP_THEMES.filter((t) => t.tone === 'dark');
  const light = APP_THEMES.filter((t) => t.tone === 'light');
  const palettes = TERMINAL_PALETTES.filter((p) => p.theme);
  const fonts = fontChoices();
  return {
    label: 'Pane style', icon: '◐',
    key: st.theme || st.font ? 'custom' : '',
    title: 'Colours and font for this pane alone',
    submenu: [
      { label: 'As the app', icon: tick(!st.theme), onClick: () => setStyle(pane, { theme: null }) },
      themeItem('light', 'Light'),
      themeItem('dark', 'Dark'),
      { label: 'Dark themes', submenu: dark.map((t) => themeItem(t.id, t.label)) },
      { label: 'Light themes', submenu: light.map((t) => themeItem(t.id, t.label)) },
      palettes.length ? { label: 'Terminal palettes', submenu: palettes.map((p) => themeItem(p.value, p.label)) } : null,
      { sep: true },
      {
        label: 'Font', key: st.font || '',
        submenu: [
          { label: 'As the app', icon: tick(!st.font), onClick: () => setStyle(pane, { font: null }) },
          // A submenu per group: fifty-odd fonts in one panel is a wall.
          ...fonts.map((g) => ({
            label: g.group, key: String(g.fonts.length),
            submenu: g.fonts.map((f) => ({ label: f, icon: tick(st.font === f), onClick: () => setStyle(pane, { font: f }) })),
          })),
        ],
      },
      { sep: true },
      key ? {
        label: remembered ? 'Stop using this look for this host' : (key === 'local' ? 'Use this look for every local shell' : 'Use this look for this host'),
        title: 'New panes on it start this way',
        disabled: !remembered && !(st.theme || st.font),
        onClick: () => { pane.styleForHost = !remembered; remember(pane, !remembered); },
      } : null,
      {
        label: 'Reset this pane', disabled: !(st.theme || st.font),
        onClick: () => setStyle(pane, { theme: null, font: null }),
      },
    ].filter(Boolean),
  };
}

/** A theme choice by name, for menus: "Light", "Nord", "Solarized dark". */
function themeLabel(id) {
  if (id === 'light') return 'Light';
  if (id === 'dark') return 'Dark';
  return themeById(id)?.label || TERMINAL_PALETTES.find((p) => p.value === id)?.label || id;
}

/**
 * The saved look for a host, on its right-click menu in the host list —
 * there only when one has been saved: change its colours or font, or clear
 * it. Open panes on the host that follow it change with it.
 */
export function hostStyleMenu(key) {
  const saved = key && (state.settings.paneStyles || {})[key];
  if (!saved) return null;
  const save = async (next) => {
    const all = { ...(state.settings.paneStyles || {}) };
    const v = next && { theme: next.theme || null, font: next.font || null };
    if (v && (v.theme || v.font)) all[key] = v; else delete all[key];
    state.settings = await window.api.settings.set({ paneStyles: all });
    for (const p of state.panes.values()) {
      if (paneStyleKey(p) !== key) continue;
      // Panes that follow the host: those never given a look of their own,
      // and those whose look was the one saved.
      if (!p.style || p.styleForHost) { p.style = null; applyPaneStyle(p); }
    }
    status(v && (v.theme || v.font) ? 'Saved look updated' : 'Saved look cleared');
  };
  const themeItem = (value, label) => ({
    label, icon: tick(saved.theme === value), onClick: () => save({ ...saved, theme: value }),
  });
  const parts = [saved.theme ? themeLabel(saved.theme) : '', saved.font || ''].filter(Boolean).join(', ');
  return {
    label: 'Saved pane style', icon: '◐', key: parts,
    title: 'The look new panes on this host start with',
    submenu: [
      { label: 'Light', icon: tick(saved.theme === 'light'), onClick: () => save({ ...saved, theme: 'light' }) },
      { label: 'Dark', icon: tick(saved.theme === 'dark'), onClick: () => save({ ...saved, theme: 'dark' }) },
      { label: 'Dark themes', submenu: APP_THEMES.filter((t) => t.tone === 'dark').map((t) => themeItem(t.id, t.label)) },
      { label: 'Light themes', submenu: APP_THEMES.filter((t) => t.tone === 'light').map((t) => themeItem(t.id, t.label)) },
      { label: 'Terminal palettes', submenu: TERMINAL_PALETTES.filter((p) => p.theme).map((p) => themeItem(p.value, p.label)) },
      {
        label: 'Font', key: saved.font || '',
        submenu: [
          { label: 'As the app', icon: tick(!saved.font), onClick: () => save({ ...saved, font: null }) },
          ...fontChoices().map((g) => ({
            label: g.group, key: String(g.fonts.length),
            submenu: g.fonts.map((f) => ({ label: f, icon: tick(saved.font === f), onClick: () => save({ ...saved, font: f }) })),
          })),
        ],
      },
      { sep: true },
      { label: 'Clear the saved look', icon: '⌦', onClick: () => save(null) },
    ],
  };
}
