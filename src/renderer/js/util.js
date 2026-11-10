export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/**
 * A row where a single click already does something real (open a session)
 * and a double-click does something else real (open it in a fresh tab
 * instead) — so, unlike a row where click only selects, the single click's
 * action has to wait out the double-click window rather than fire
 * immediately, or a double-click would trigger the single-click action
 * first and the double-click action second. Spread the result into an
 * `el()` attrs object: `{..., ...clickOrDblClick(onOne, onTwo)}`.
 */
export function clickOrDblClick(onClick, onDblClick, delay = 300) {
  let t = null;
  return {
    onClick: (e) => { if (t) return; t = setTimeout(() => { t = null; onClick(e); }, delay); },
    ondblclick: (e) => { if (t) { clearTimeout(t); t = null; } onDblClick(e); },
  };
}

export function fmtBytes(n) {
  if (n === null || n === undefined) return '';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
}

export function fmtRate(bps) {
  if (!bps || bps < 1) return '';
  return fmtBytes(bps) + '/s';
}

export function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const mon = d.toLocaleString('en', { month: 'short' });
  const day = String(d.getDate()).padStart(2, ' ');
  if (sameYear) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${mon} ${day} ${hh}:${mm}`;
  }
  return `${mon} ${day}  ${d.getFullYear()}`;
}

/**
 * A moment read the way a clock on the wall reads it — 12-hour with the
 * half of the day spelled out, and the timezone named, because "session
 * ended" is exactly the line someone pastes into a message to someone in a
 * different zone, and a bare 24-hour time leaves them guessing which one.
 * `fmtDate`'s compact form stays as it is for the listings that use it.
 */
export function fmtDateTimeTz(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString('en', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' });
  return `${date}, ${time}`;
}

/**
 * A span of time, at the precision that span deserves.
 *
 * Milliseconds for a command that barely ran, seconds for a short one, and
 * hours or days once it is long — a recorded session left open overnight read
 * as "1593m 13s", which is a number to be converted rather than a duration to
 * be read.
 */
export function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return ms + 'ms';
  const s = Math.round(ms / 1000);
  if (s < 60) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** POSIX path helpers (remote paths are always POSIX). */
export const posix = {
  join(dir, name) {
    if (!dir || dir === '/') return '/' + name;
    return dir.endsWith('/') ? dir + name : dir + '/' + name;
  },
  parent(p) {
    if (!p || p === '/') return '/';
    const t = p.replace(/\/+$/, '');
    const i = t.lastIndexOf('/');
    return i <= 0 ? '/' : t.slice(0, i);
  },
  basename(p) {
    if (!p) return '';
    const t = p.replace(/\/+$/, '');
    return t.slice(t.lastIndexOf('/') + 1) || '/';
  },
};

export function debounce(fn, ms = 150) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Sort directories first, then by name, case-insensitive. */
/**
 * How two names are ordered, everywhere a list of them is shown.
 *
 * Case-insensitive, because `Downloads` and `docs` belong next to each other
 * and nobody thinks of a capital letter as a sort key. Numeric, because
 * `node-2` comes before `node-10` to every human being and after it to every
 * plain string comparison — on a fleet with numbered machines that is the
 * difference between a list you can read and one you have to search.
 */
export function compareNames(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base', numeric: true });
}

/**
 * A directory listing in order.
 *
 * `foldersFirst` is the convention every file manager starts with — the
 * folders in a block at the top, then the files — and it is what most people
 * want most of the time. It is also exactly wrong when the question is "what
 * changed here last" or "what is the biggest thing in this directory": a
 * date sort with the folders held above it answers neither, because the
 * newest thing on the screen might be the fourth row or the fortieth.
 * Turning it off sorts everything together, by whichever column is in force.
 */
export function sortEntries(entries, { key = 'name', dir = 1, foldersFirst = true } = {}) {
  const isDir = (e) => e.type === 'directory' || e.targetType === 'directory';
  return [...entries].sort((a, b) => {
    const ad = isDir(a), bd = isDir(b);
    if (foldersFirst && ad !== bd) return ad ? -1 : 1;
    let r = 0;
    if (key === 'size') r = (a.size || 0) - (b.size || 0);
    else if (key === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
    else r = compareNames(a.name, b.name);
    if (r) return r * dir;
    /*
     * Ties break on the name, and *not* in the sort's direction.
     *
     * Two files of the same size, or written in the same second, have to
     * come out in a fixed order or the list reshuffles itself every time it
     * is drawn. Alphabetical either way round, too: reversing the tiebreak
     * along with the column means "newest first" and "oldest first" disagree
     * about the order of things with identical timestamps, which looks like
     * a glitch rather than a sort.
     */
    return key === 'name' ? 0 : compareNames(a.name, b.name);
  });
}

export function fileIcon(entry) {
  const isDir = entry.type === 'directory' || entry.targetType === 'directory';
  if (isDir) return '\u{1F4C1}';
  if (entry.type === 'symlink') return '\u{1F517}';
  const ext = (entry.name.split('.').pop() || '').toLowerCase();
  if (entry.mode && (entry.mode & 0o111) && entry.type === 'file') return '\u{2699}';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) return '\u{1F5BC}';
  if (['zip', 'gz', 'tar', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst'].includes(ext)) return '\u{1F4E6}';
  if (['js', 'ts', 'py', 'go', 'rs', 'c', 'h', 'cpp', 'java', 'rb', 'php', 'sh', 'bash', 'zsh'].includes(ext)) return '\u{1F4C4}';
  if (['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'xml'].includes(ext)) return '\u{2699}';
  if (['md', 'txt', 'log', 'rst'].includes(ext)) return '\u{1F4DD}';
  if (['pem', 'key', 'crt', 'cer', 'pub'].includes(ext)) return '\u{1F511}';
  return '\u{1F4C4}';
}

/** Escape a string for safe use inside a single-quoted shell argument. */
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

export function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

/* ------------------------------------------------------------------ */
/* Marking things: colours and icons                                   */
/* ------------------------------------------------------------------ */

/**
 * The colours a host or a folder can be marked with.
 *
 * Eight, named rather than free-form: the point is to tell two things apart
 * at a glance, which a fixed set does better than a colour wheel, and every
 * one of them has to stay legible against both themes. It lives here rather
 * than beside either of the things that use it so that a host and the folder
 * it sits in can be given the same red and actually match.
 */
export const HOST_COLORS = [
  { value: '', label: 'None', css: '' },
  { value: 'red', label: 'Red — production', css: '#f85149' },
  { value: 'amber', label: 'Amber — staging', css: '#d29922' },
  { value: 'green', label: 'Green — development', css: '#3fb950' },
  { value: 'blue', label: 'Blue', css: '#4c8dff' },
  { value: 'purple', label: 'Purple', css: '#bc8cff' },
  { value: 'cyan', label: 'Cyan', css: '#39c5cf' },
  { value: 'pink', label: 'Pink', css: '#f778ba' },
  { value: 'grey', label: 'Grey', css: '#8b949e' },
];

/** A colour name as something CSS can use, or '' for "not coloured". */
export function colorCss(name) {
  return HOST_COLORS.find((c) => c.value === name && c.css)?.css || '';
}

/**
 * The icons offered in the picker.
 *
 * A suggested set, not a limit — the picker takes anything you paste, so a
 * team with its own convention is not stuck with this one. Chosen for what
 * people actually label machines with: the environment, the job, the
 * operating system, and the handful of states worth seeing from across the
 * room.
 */
export const ICON_CHOICES = [
  '\u{1F525}', '\u{1F680}', '\u{1F6E0}️', '\u{1F9EA}', '\u{1F512}', '\u{1F310}',
  '\u{1F4BE}', '\u{1F5A5}️', '☁️', '\u{1F433}', '\u{1F427}', '\u{1FA9F}',
  '\u{1F34E}', '\u{1F4C8}', '\u{1F50E}', '\u{1F4E6}', '⚙️', '\u{1F9F0}',
  '\u{1F6A6}', '\u{1F9EF}', '\u{1F514}', '\u{1F4DE}', '\u{1F4DA}', '\u{1F5C3}️',
  '\u{1F7E2}', '\u{1F7E1}', '\u{1F534}', '\u{1F7E3}', '⭐', '\u{1F480}',
];
