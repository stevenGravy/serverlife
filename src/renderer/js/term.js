import { state } from './state.js';
import { urlAt, openLink } from './links.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { themeById, toneOf, paletteByName, appThemePalette } from './themes.js';
import { fontStack } from './fonts.js';

export const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1c2128',
  cursor: '#1f6feb',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(31,111,235,.22)',
  black: '#24292f',    brightBlack: '#57606a',
  red: '#cf222e',      brightRed: '#a40e26',
  green: '#116329',    brightGreen: '#1a7f37',
  yellow: '#4d2d00',   brightYellow: '#633c01',
  blue: '#0969da',     brightBlue: '#218bff',
  magenta: '#8250df',  brightMagenta: '#a475f9',
  cyan: '#1b7c83',     brightCyan: '#3192aa',
  white: '#6e7781',    brightWhite: '#8c959f',
};

export const DARK_THEME = {
  background: '#0f1117',
  foreground: '#d8dee9',
  cursor: '#4c8dff',
  cursorAccent: '#0f1117',
  selectionBackground: 'rgba(76,141,255,.28)',
  black: '#1c202b',    brightBlack: '#4a5266',
  red: '#f85149',      brightRed: '#ff7b72',
  green: '#3fb950',    brightGreen: '#56d364',
  yellow: '#d29922',   brightYellow: '#e3b341',
  blue: '#4c8dff',     brightBlue: '#79b8ff',
  magenta: '#a371f7',  brightMagenta: '#bc8cff',
  cyan: '#39c5cf',     brightCyan: '#56d4dd',
  white: '#b1bac4',    brightWhite: '#f0f6fc',
};

/** The palette matching whatever theme the document is currently showing. */
export function activeTheme() {
  const root = document.documentElement;
  const attr = root.getAttribute('data-theme');
  const tone = toneOf(attr);
  const base = tone === 'light' ? LIGHT_THEME
    : tone === 'dark' ? DARK_THEME
      : (window.matchMedia('(prefers-color-scheme: light)').matches ? LIGHT_THEME : DARK_THEME);

  /*
   * A named palette wins over both the theme and any skin: someone who asked
   * for Solarized asked for Solarized, not for it to be repainted by a
   * seasonal skin.
   */
  const named = paletteByName(state.settings?.terminalPalette);
  if (named) return { ...base, ...named };

  // A named app theme brings its own sixteen colours — unless a skin is
  // repainting everything, in which case the skin is what is on screen.
  const appTheme = themeById(attr);
  if (appTheme && !root.getAttribute('data-skin')) {
    return { ...base, ...appThemePalette(appTheme) };
  }

  // A skin repaints the UI through CSS variables; read them back so the
  // terminal follows without every skin having to restate a 16-colour palette.
  if (!root.getAttribute('data-skin')) return base;
  const css = getComputedStyle(root);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const accent = v('--accent', base.blue);
  return {
    ...base,
    background: v('--bg', base.background),
    foreground: v('--text', base.foreground),
    cursor: accent,
    cursorAccent: v('--bg', base.cursorAccent),
    // xterm takes 8-digit hex, which is the cheapest way to get translucency
    // out of a variable that is only ever a solid colour.
    selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? accent + '47' : base.selectionBackground,
    black: v('--panel-2', base.black),
    red: v('--red', base.red),
    green: v('--green', base.green),
    yellow: v('--amber', base.yellow),
    blue: accent,
    magenta: v('--purple', base.magenta),
    white: v('--text-dim', base.white),
    brightWhite: v('--text', base.brightWhite),
    brightBlack: v('--muted', base.brightBlack),
  };
}

// Kept for callers that just want "the current one".
export const THEME = DARK_THEME;

/**
 * Thin wrapper over xterm that owns the DOM element, addons and resize
 * plumbing. Byte transport is supplied by the caller via `onInput` / `write`.
 */
export class TermView {
  constructor({ settings, onInput, onResize, onTitle }) {
    this.onInput = onInput;
    this.onResize = onResize;
    this.onTitle = onTitle;
    this.disposed = false;

    this.term = new Terminal({
      fontFamily: fontStack(settings?.fontFamily),
      fontSize: settings?.fontSize || 13,
      lineHeight: 1.18,
      letterSpacing: 0,
      cursorBlink: settings?.cursorBlink ?? true,
      cursorStyle: settings?.cursorStyle || 'bar',
      scrollback: settings?.scrollback || 10000,
      allowProposedApi: true,
      /*
       * A glyph the font has not got is drawn from whichever fallback font
       * does have it, and that font's idea of a character's width is its own.
       * Powerline arrows, box drawing and emoji are the usual offenders: they
       * come out wider than the cell and spill over the character next door,
       * which is most of what "the text goes wacky" looks like. This scales
       * them down to the cell instead.
       */
      rescaleOverlappingGlyphs: true,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      theme: activeTheme(),
    });

    this.fit = new FitAddon();
    this.search = new SearchAddon({ highlightLimit: 2000 });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    /*
     * A click on a link asks before it opens one. The text under the pointer
     * came from the far end of an SSH session, and a single stray click on a
     * scrolling log should not be able to send an address nobody read to the
     * browser. `links.js` holds the question and the preference that silences
     * it; this only has to stop short of opening by itself.
     */
    this.term.loadAddon(new WebLinksAddon((_e, uri) => { openLink(uri); }));
    try {
      const u11 = new Unicode11Addon();
      this.term.loadAddon(u11);
      this.term.unicode.activeVersion = '11';
    } catch { /* falls back to the default Unicode widths */ }

    this.term.onData((d) => this.onInput?.(d));
    this.term.onBinary((d) => this.onInput?.(d));
    this.term.onTitleChange((t) => this.onTitle?.(t));
    this.term.onResize(({ cols, rows }) => this.onResize?.(cols, rows));

    /*
     * OSC 52 is how a remote program — tmux's own mouse-copy, vim, a coding
     * agent's "copy to clipboard" — tells the terminal what the system
     * clipboard should hold. Without it, mouse-tracking on the far end (tmux
     * with `mouse on`, in particular) draws its own reverse-video highlight
     * and forwards the drag down the pty instead of letting xterm make a
     * local selection, so there is no DOM selection for Cmd+C to copy and
     * the text never reaches the Mac. Catching the sequence and handing it
     * to the OS clipboard is what iTerm2, kitty and WezTerm already do.
     *
     * This arrives with no user gesture behind it, so the page's own
     * `navigator.clipboard` would be refused by the browser's permission
     * model; going through the main process over IPC is the one path that
     * actually writes.
     *
     * A cap guards against a hostile or runaway remote stuffing the
     * clipboard with megabytes of data on every redraw.
     */
    this.term.parser.registerOscHandler(52, (data) => {
      const sep = data.indexOf(';');
      const payload = sep < 0 ? '' : data.slice(sep + 1);
      if (!payload || payload === '?' || payload.length > 200_000) return true;
      try {
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
        window.api.clipboard.write(new TextDecoder('utf-8').decode(bytes));
      } catch { /* malformed OSC 52 payload */ }
      return true;
    });
  }

  attach(container) {
    this.container = container;
    this.term.open(container);
    this._paintViewport();
    /*
     * A right-click on a selection is for the menu, not for the program.
     *
     * With mouse reporting on — tmux with `mouse on`, vim with `mouse=a`,
     * htop — xterm sends the right button down the pty, and any input clears
     * the selection. That happens on mousedown, before `contextmenu` fires,
     * so the menu opened on nothing and Copy was greyed out. xterm means to
     * leave a right-click on a selection alone and only half does; stopping
     * it here, in the capture phase, keeps it from reaching the reporting
     * listener at all. `contextmenu` is its own event and still arrives.
     */
    container.addEventListener('mousedown', (e) => {
      if (e.button === 2 && this.term.hasSelection()) e.stopPropagation();
    }, true);
    // WebGL gives a large win on busy output; fall back silently if the
    // context is unavailable or lost.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try { webgl.dispose(); } catch { /* the context is already lost */ }
        this.webgl = null;
        /*
         * The canvas is gone and xterm falls back to the DOM renderer, which
         * starts empty — without a repaint the pane keeps showing whatever
         * the dead context last drew.
         */
        this.repaint();
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
    } catch { /* no WebGL: xterm keeps its DOM renderer */ }
    this._watchPixelRatio();

    this._ro = new ResizeObserver(() => this.fitSoon());
    this._ro.observe(container);
    requestAnimationFrame(() => this.fitNow());
  }

  /**
   * The glyph atlas is built for one device pixel ratio, and nothing tells
   * xterm when that changes.
   *
   * WebGL caches every glyph it has drawn in a texture sized for the screen
   * it was first drawn on. Drag the window to a display with a different
   * scale — a Retina laptop to an external monitor is how it usually happens,
   * and a scale change in System Settings does it too — and those cached
   * glyphs are painted at the wrong size: text goes soft or smeared, and rows
   * drawn before and after the move disagree with each other. Throwing the
   * atlas away is the whole fix; it is rebuilt on the next frame.
   *
   * A `resolution` media query is the only reliable notification, and it has
   * to be re-armed each time because the query names the ratio it watches for.
   */
  _watchPixelRatio() {
    if (this.disposed) return;
    try { this._dprQuery?.removeEventListener('change', this._onDpr); } catch { /* the listener may never have been added */ }
    const dpr = window.devicePixelRatio || 1;
    this._dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
    this._onDpr = () => {
      try { this.webgl?.clearTextureAtlas(); } catch { /* no WebGL atlas to clear */ }
      this.repaint();
      this._watchPixelRatio();
    };
    this._dprQuery.addEventListener('change', this._onDpr);
  }

  /** Redraw every visible row, after something the renderer cannot see. */
  repaint() {
    if (this.disposed) return;
    try { this.term.refresh(0, this.term.rows - 1); } catch { /* the terminal may be disposed */ }
  }

  fitNow() {
    if (this.disposed || !this.container) return;
    clearTimeout(this._fitTimer);
    const { offsetWidth: w, offsetHeight: h } = this.container;
    if (w < 20 || h < 20) return;
    try { this.fit.fit(); } catch { /* a hidden pane has nothing to fit */ }
  }

  /**
   * A fit at the end of a resize, not on every frame of one.
   *
   * Each fit that changes the size sends SIGWINCH down the pty, and dragging a
   * window edge produces one per frame. A full-screen program on the far side
   * — vim, htop, less — redraws on every one of them, and sixty redraws a
   * second arriving over SSH interleave into exactly the garbled screen this
   * is meant to avoid. Waiting for the drag to settle costs nothing: xterm
   * keeps painting the old grid meanwhile.
   */
  fitSoon() {
    if (this.disposed) return;
    clearTimeout(this._fitTimer);
    this._fitTimer = setTimeout(() => this.fitNow(), 80);
  }

  write(data) { if (!this.disposed) this.term.write(data); }
  writeln(data) { if (!this.disposed) this.term.writeln(data); }
  focus() { if (!this.disposed) this.term.focus(); }
  clearScreen() { this.term.clear(); }
  selection() { return this.term.getSelection(); }

  /**
   * Everything in the buffer, scrollback included, as text.
   *
   * Walks the buffer rather than keeping a shadow copy of the stream: the
   * buffer is already what is on screen, wrapped lines and all, and a copy
   * would double the memory of every session for something asked for rarely.
   * Trailing blank lines are dropped — a 10,000-line scrollback holding forty
   * lines of output should not save 9,960 empty ones.
   */
  allText({ trimTrailing = true } = {}) {
    const buf = this.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    if (trimTrailing) {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    }
    return lines.join('\n');
  }
  /**
   * The URL under a point on screen, or null.
   *
   * The addon underlines links and the browser knows where the pointer is,
   * but neither will say what was under a *right*-click — xterm hands the
   * context menu to the host application and keeps its link state to itself.
   * So this reads the buffer, which is the one place the answer exists.
   *
   * Two details matter. A wrapped line is several buffer rows and one piece
   * of text, so a URL that runs over the right-hand edge is only a URL once
   * the rows are stitched back together. And the character offset of a cell
   * is not the cell's column: a wide glyph covers two columns and contributes
   * one character, so the prefix is translated rather than counted.
   */
  linkAt(clientX, clientY) {
    if (this.disposed) return null;
    try {
      const screen = this.container?.querySelector('.xterm-screen');
      if (!screen) return null;
      const r = screen.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;

      const cols = this.term.cols, rows = this.term.rows;
      const col = Math.min(cols - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * cols)));
      const row = Math.min(rows - 1, Math.max(0, Math.floor(((clientY - r.top) / r.height) * rows)));

      const buf = this.term.buffer.active;
      const y = buf.viewportY + row;

      // Back to the first row of this logical line, then forward to its last.
      let top = y;
      while (top > 0 && buf.getLine(top)?.isWrapped) top--;
      let bottom = y;
      while (bottom + 1 < buf.length && buf.getLine(bottom + 1)?.isWrapped) bottom++;

      let text = '';
      let index = -1;
      for (let i = top; i <= bottom; i++) {
        const line = buf.getLine(i);
        if (!line) continue;
        if (i === y) index = text.length + (line.translateToString(false, 0, col)?.length ?? col);
        text += line.translateToString(false);
      }
      if (index < 0) return null;
      const hit = urlAt(text, index);
      return hit ? hit.url : null;
    } catch { return null; }
  }

  /**
   * The bottom of what is actually on screen, as text.
   *
   * Not the same thing as the bytes that arrived. A full-screen program —
   * an editor, a pager, a coding agent drawing a permission box — paints by
   * moving the cursor around and rewriting lines, so the end of the stream
   * is whichever line it happened to redraw last, not the bottom of the
   * display. Anything that wants to know what the user is looking at has to
   * read the buffer, which is the one place that answer exists.
   */
  screenTail(rows = 16) {
    if (this.disposed) return '';
    try {
      const buf = this.term.buffer.active;
      const top = buf.baseY;
      const lines = [];
      for (let y = top; y < top + this.term.rows; y++) {
        lines.push(buf.getLine(y)?.translateToString(true) ?? '');
      }
      /*
       * The bottom of the *content*, not of the display. A screen is a fixed
       * height and a shell that has printed ten lines leaves forty blank
       * rows under them; taking the last rows literally returns nothing at
       * all, which is how a perfectly visible prompt goes unnoticed.
       */
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      return lines.slice(-rows).join('\n');
    } catch { return ''; }
  }

  hasSelection() { return this.term.hasSelection(); }

  /* ---------------- scrollback search ---------------- */

  /**
   * Highlighting every match (not just the current one) is what makes search
   * in a long scrollback useful — you can see at a glance where the hits are.
   */
  get _searchOptions() {
    const t = this.term.options.theme || {};
    return {
      regex: false,
      wholeWord: false,
      caseSensitive: false,
      decorations: {
        matchBackground: t.yellow || '#d29922',
        matchBorder: 'transparent',
        matchOverviewRuler: t.yellow || '#d29922',
        activeMatchBackground: t.blue || '#4c8dff',
        activeMatchBorder: 'transparent',
        activeMatchColorOverviewRuler: t.blue || '#4c8dff',
      },
    };
  }

  /** Fires with {resultIndex, resultCount} as the search set changes. */
  onSearchResults(cb) {
    try { return this.search.onDidChangeResults(cb); } catch { return { dispose() {} }; }
  }

  findNext(q, opts = {}) {
    if (!q) { this.clearSearch(); return false; }
    return this.search.findNext(q, { ...this._searchOptions, incremental: false, ...opts });
  }

  findPrev(q, opts = {}) {
    if (!q) { this.clearSearch(); return false; }
    return this.search.findPrevious(q, { ...this._searchOptions, ...opts });
  }

  /** Type-ahead: keeps the current match under the cursor while typing. */
  findIncremental(q) {
    if (!q) { this.clearSearch(); return false; }
    return this.search.findNext(q, { ...this._searchOptions, incremental: true });
  }

  clearSearch() {
    try { this.search.clearDecorations(); } catch { /* no search has run */ }
    try { this.search.clearActiveDecoration(); } catch { /* no search has run */ }
  }

  setTheme(theme) {
    if (this.disposed) return;
    this.term.options.theme = theme;
    this._paintViewport();
  }

  /*
   * The few pixels under the last whole row belong to xterm's viewport,
   * which its stylesheet paints black whatever the palette. On a light or
   * coloured theme that is a black bar along the bottom of every terminal.
   */
  _paintViewport() {
    const vp = this.term.element?.querySelector('.xterm-viewport');
    if (vp) vp.style.backgroundColor = this.term.options.theme?.background || '';
  }

  setFontSize(px) {
    this.term.options.fontSize = Math.max(8, Math.min(28, px));
    this.fitNow();
  }
  get fontSize() { return this.term.options.fontSize; }

  get cols() { return this.term.cols; }
  get rows() { return this.term.rows; }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { this._ro?.disconnect(); } catch { /* already disconnected */ }
    clearTimeout(this._fitTimer);
    try { this._dprQuery?.removeEventListener('change', this._onDpr); } catch { /* the listener may never have been added */ }
    try { this.term.dispose(); } catch { /* already disposed */ }
  }
}
