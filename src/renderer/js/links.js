import { state } from './state.js';

/**
 * Links in terminal output: finding them, and opening them on purpose.
 *
 * A terminal is not a web page. The text in it arrives from somewhere else —
 * a log line, a `curl` of someone's JSON, a commit message written by a
 * stranger — and the whole of it is addressable by whoever wrote that text.
 * xterm will happily underline any of it and open it on a single click, which
 * is a browser's bargain applied to a surface where it was never agreed: a
 * mis-aimed click on a scrolling log can hand a URL you never read to your
 * default browser.
 *
 * So opening is a deliberate act here. The click still works, but it asks
 * first and shows the address it would use, with the host called out — the
 * part a lookalike URL gets wrong and the part a long one hides. The asking
 * can be turned off for people who want the old bargain back.
 *
 * The matching below is deliberately its own small thing rather than a reach
 * into the addon's internals: the addon decides what to underline, this
 * decides what the right-click menu offers, and the two agreeing on ordinary
 * URLs is all that is needed.
 */

/*
 * What counts as a URL in a wall of text.
 *
 * Quotes, angle brackets and whitespace end it, because that is what text
 * around a URL is actually made of — `see <https://x/y>`, `"url":"https://…"`.
 * Control characters end it too: a line that still holds escape sequences
 * must not fold them into the address.
 */
// eslint-disable-next-line no-control-regex
const URL_RE = /(?:https?:\/\/|www\.)[^\s"'`<>\u0000-\u001f\u007f]+/gi;

/* Closers that only belong to the URL when it opened them itself. */
const PAIRS = { ')': '(', ']': '[', '}': '{', '>': '<' };

/**
 * Trim the punctuation that belongs to the sentence, not the address.
 *
 * `(see https://example.com/a)` and `https://example.com/a.` both end in a
 * character that is legal in a URL and almost never part of one. A closing
 * bracket is kept only when the URL opened it — Wikipedia's
 * `…/Foo_(disambiguation)` is the case that makes the counting worth it.
 */
export function trimTrailing(url) {
  let out = String(url || '');
  for (;;) {
    const last = out[out.length - 1];
    if (!last) break;
    if ('.,;:!?’\'"'.includes(last)) { out = out.slice(0, -1); continue; }
    const open = PAIRS[last];
    if (open) {
      const opens = out.split(open).length - 1;
      const closes = out.split(last).length - 1;
      if (closes > opens) { out = out.slice(0, -1); continue; }
    }
    break;
  }
  return out;
}

/** A bare `www.` host is a URL in everything but the scheme. */
export function normalize(url) {
  const u = String(url || '').trim();
  return /^www\./i.test(u) ? `https://${u}` : u;
}

/**
 * Only http and https are ever opened. The main process enforces this too —
 * it is the one holding `shell.openExternal` — and this is here so the menu
 * can say so before the click rather than appearing to do nothing after it.
 */
export function openable(url) {
  return /^https?:\/\/\S/i.test(normalize(url));
}

/**
 * The URL covering `index` in `text`, or null.
 *
 * Returns the raw span as well as the tidied address: callers that want to
 * show what was matched (or to know how far it reached) need the former, and
 * callers that want to open something need the latter.
 */
export function urlAt(text, index) {
  const s = String(text || '');
  if (!(index >= 0) || index >= s.length) return null;
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(s); m; m = URL_RE.exec(s)) {
    const start = m.index;
    const end = start + m[0].length;
    if (index < start) return null;          // matches arrive in order
    if (index < end) {
      const url = trimTrailing(m[0]);
      if (!url) return null;
      /*
       * Clicking the full stop after a URL is not clicking the URL. The
       * trimmed characters are part of the prose, and treating them as part
       * of the link is how a menu offers to open something the pointer was
       * not on.
       */
      if (index >= start + url.length) return null;
      return { url: normalize(url), raw: m[0], start, end: start + url.length };
    }
  }
  return null;
}

/** The host, for saying plainly where a link goes. */
export function hostOf(url) {
  try { return new URL(normalize(url)).host; } catch { return ''; }
}

/** Is a click on a link asked about first? On unless told otherwise. */
export function confirmsLinks() {
  return state.settings?.confirmLinkOpen !== false;
}

/**
 * Open a link, asking first unless that has been turned off.
 *
 * `window.open` rather than an IPC of its own: the main process already
 * intercepts it, checks the scheme and hands it to the browser, and keeping
 * one guarded path is worth more than the convenience of a second.
 */
export async function openLink(url, { ask = null } = {}) {
  const full = normalize(url);
  const { status } = await import('./ui.js');
  if (!openable(full)) {
    status('Only http and https links open in the browser');
    return false;
  }
  if (ask === null ? confirmsLinks() : ask) {
    if (!(await askToOpen(full))) return false;
  }
  window.open(full, '_blank');
  status(`Opening ${hostOf(full) || full}…`);
  return true;
}

/**
 * The question itself.
 *
 * The address is shown as text in a box that wraps, never as a link and
 * never shortened: a dialog that hides the middle of a URL is a dialog that
 * cannot be used to check one. The host gets its own line above it because
 * that is the part worth reading, and it is the part a long path pushes out
 * of sight.
 */
async function askToOpen(url) {
  const { modal, checkbox } = await import('./ui.js');
  const { el } = await import('./util.js');
  const host = hostOf(url);
  const stop = checkbox('Stop asking — open links as soon as they are clicked', false);
  const ok = await modal({
    title: 'Open this link?',
    width: 520,
    render: (body) => {
      if (host) {
        body.append(el('div', { style: 'font-size:13px;margin-bottom:8px' },
          el('span', { class: 'hint', text: 'Opens your browser at ' }),
          el('b', { text: host })));
      }
      body.append(el('div', {
        text: url,
        style: 'font-family:var(--mono);font-size:12px;word-break:break-all;'
          + 'background:var(--panel-2);border:1px solid var(--border-soft);'
          + 'border-radius:6px;padding:8px 10px;max-height:140px;overflow:auto',
      }));
      body.append(el('div', { style: 'margin-top:10px' }, stop));
    },
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Open', class: 'primary-btn', value: true },
    ],
  });
  if (ok === true && stop.input.checked) {
    try { state.settings = await window.api.settings.set({ confirmLinkOpen: false }); } catch { /* the link still opens; the setting is asked again next time */ }
  }
  return ok === true;
}
