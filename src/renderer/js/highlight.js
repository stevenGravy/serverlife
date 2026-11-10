import { state } from './state.js';
import { el, clear, uid } from './util.js';
import { modal, field, textInput, select, checkbox, toast, status } from './ui.js';

/**
 * Keyword highlighting in the terminal.
 *
 * Reading a log in a terminal is mostly looking for four or five words. This
 * colours them as the output arrives, so `error` is visible without searching
 * for it — the thing every other terminal on this list has had for years.
 *
 * It works by rewriting the byte stream on its way to xterm, wrapping matches
 * in SGR sequences. Two reasons not to use the search addon's decorations: it
 * holds exactly one set at a time, so several keywords could not be lit at
 * once, and it would fight with the search box for the same slot.
 */

/* ------------------------------------------------------------------ */
/* Colours                                                             */
/* ------------------------------------------------------------------ */

export const HIGHLIGHT_COLORS = [
  { value: 'red', label: 'Red', fg: '1;31', bg: '1;97;41' },
  { value: 'amber', label: 'Amber', fg: '1;33', bg: '1;30;43' },
  { value: 'green', label: 'Green', fg: '1;32', bg: '1;30;42' },
  { value: 'blue', label: 'Blue', fg: '1;34', bg: '1;97;44' },
  { value: 'cyan', label: 'Cyan', fg: '1;36', bg: '1;30;46' },
  { value: 'magenta', label: 'Magenta', fg: '1;35', bg: '1;97;45' },
  { value: 'grey', label: 'Grey', fg: '1;90', bg: '1;97;100' },
];

function sgrFor(rule) {
  const c = HIGHLIGHT_COLORS.find((x) => x.value === rule.color) || HIGHLIGHT_COLORS[0];
  return rule.background === false ? c.fg : c.bg;
}

/* ------------------------------------------------------------------ */
/* Rules                                                              */
/* ------------------------------------------------------------------ */

/**
 * What ships on, because these are the words people are actually looking for.
 *
 * Kept as data here rather than written into settings on first run, so they
 * can improve between releases — the same arrangement the built-in macros
 * use. A default that is in the way can be switched off or edited, which
 * copies it into settings as an ordinary rule.
 */
export const DEFAULT_RULES = [
  {
    id: 'builtin-error',
    name: 'Errors',
    pattern: '\\b(error|errors|errno|fatal|critical|panic|traceback|denied|refused|failed|failure|cannot|unable to)\\b',
    regex: true,
    caseSensitive: false,
    color: 'red',
    background: true,
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-warn',
    name: 'Warnings',
    pattern: '\\b(warn|warning|warnings|deprecated|timeout|timed out|retrying|retry|degraded|throttled)\\b',
    regex: true,
    caseSensitive: false,
    color: 'amber',
    background: true,
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-ok',
    name: 'Good news',
    pattern: '\\b(success|successful|succeeded|active \\(running\\)|healthy|ready|completed|enabled)\\b',
    regex: true,
    caseSensitive: false,
    color: 'green',
    background: false,
    enabled: true,
    builtin: true,
  },
];

/** The user's own rules, plus whichever built-ins they have not overridden. */
export function allRules() {
  const own = state.settings.highlightRules || [];
  const overridden = new Set(own.map((r) => r.id));
  const hidden = new Set(state.settings.hiddenHighlightRules || []);
  return [
    ...DEFAULT_RULES.filter((r) => !overridden.has(r.id) && !hidden.has(r.id)),
    ...own,
  ];
}

/** Per-host settings: `{ on, rules: [ids], extra: [rules] }`, keyed like other host prefs. */
function hostEntry(key) {
  return (state.settings.highlightHosts || {})[key] || null;
}

/**
 * Is highlighting on for this pane?
 *
 * Three answers again, and for the same reason as agent forwarding: a host
 * that is always quiet can be excepted from a global "on", and a single noisy
 * host can be lit up without turning it on everywhere.
 */
export function highlightOn(hostKey) {
  const entry = hostKey ? hostEntry(hostKey) : null;
  if (entry && typeof entry.on === 'boolean') return entry.on;
  return state.settings.highlight !== false;
}

export function highlightSource(hostKey) {
  const entry = hostKey ? hostEntry(hostKey) : null;
  if (entry && typeof entry.on === 'boolean') return 'host';
  return 'default';
}

export async function setHighlightForHost(hostKey, value) {
  const map = { ...(state.settings.highlightHosts || {}) };
  const entry = { ...(map[hostKey] || {}) };
  if (value === null) delete entry.on; else entry.on = !!value;
  if (!Object.keys(entry).length) delete map[hostKey]; else map[hostKey] = entry;
  state.settings = await window.api.settings.set({ highlightHosts: map });
  return state.settings;
}

export async function setHighlightDefault(on) {
  state.settings = await window.api.settings.set({ highlight: !!on });
  return state.settings;
}

/** The rules in force for a host: the shared set, plus anything set for it. */
export function rulesFor(hostKey) {
  const entry = hostKey ? hostEntry(hostKey) : null;
  const off = new Set(entry?.off || []);
  const shared = allRules().filter((r) => r.enabled !== false && !off.has(r.id));
  const extra = (entry?.extra || []).filter((r) => r.enabled !== false);
  return [...shared, ...extra];
}

/* ------------------------------------------------------------------ */
/* The rewriter                                                        */
/* ------------------------------------------------------------------ */

/**
 * Compile rules once per pane. A bad pattern is dropped rather than thrown:
 * a typo in one rule should not take the terminal's output with it.
 */
export function compileRules(rules) {
  const out = [];
  for (const r of rules) {
    const body = r.regex ? r.pattern : escapeLiteral(r.pattern);
    if (!body) continue;
    try {
      out.push({
        re: new RegExp(body, r.caseSensitive ? 'g' : 'gi'),
        sgr: sgrFor(r),
        id: r.id,
      });
    } catch { /* an invalid pattern simply does not highlight */ }
  }
  return out.length ? out : null;
}

function escapeLiteral(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape sequences, so text runs can be found between them.
 *
 * Matching them matters twice over: a keyword must not be substituted *inside*
 * a sequence (which would corrupt it), and the last colour the program set has
 * to be known so it can be put back after a highlight.
 */
const ANSI_RE = /\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)|[@-Z\\-_]/g;
const SGR_RE = /^\[([0-9;]*)m$/;
const ALT_ON = /^\[\?(?:1049|47|1047)h$/;
const ALT_OFF = /^\[\?(?:1049|47|1047)l$/;

/** Per-pane rewriter state: what colour is in force, and which screen we are on. */
export function newHighlightState() {
  return { sgr: '', alt: false };
}

/**
 * Wrap every match in `chunk` with its rule's colour.
 *
 * Deliberately does no buffering across chunks: a keyword split down the
 * middle by a packet boundary is simply not highlighted that once, which is a
 * better trade than holding output back to wait for the rest of a word.
 *
 * While the program is on the alternate screen — vim, less, htop, top — this
 * gets out of the way entirely. Those draw their own colours, and a
 * highlighter recolouring an editor's buffer is vandalism rather than help.
 */
export function highlightChunk(chunk, compiled, hs) {
  if (!compiled || !chunk) return chunk;

  let out = '';
  let last = 0;
  ANSI_RE.lastIndex = 0;
  let m;
  const pieces = [];
  while ((m = ANSI_RE.exec(chunk)) !== null) {
    if (m.index > last) pieces.push({ text: chunk.slice(last, m.index) });
    pieces.push({ esc: m[0] });
    last = m.index + m[0].length;
  }
  if (last < chunk.length) pieces.push({ text: chunk.slice(last) });

  for (const p of pieces) {
    if (p.esc !== undefined) {
      out += p.esc;
      if (ALT_ON.test(p.esc)) hs.alt = true;
      else if (ALT_OFF.test(p.esc)) hs.alt = false;
      else {
        const sgr = p.esc.match(SGR_RE);
        if (sgr) {
          // A reset clears what we would otherwise put back; anything else is
          // the colour in force, which a highlight has to restore after it.
          const body = sgr[1];
          hs.sgr = (body === '' || body === '0') ? '' : p.esc;
        }
      }
      continue;
    }
    out += hs.alt ? p.text : paint(p.text, compiled, hs);
  }
  return out;
}

/**
 * One text run. Matches are found for every rule, earlier rules win an
 * overlap, and each match is wrapped in its colour followed by a restore of
 * whatever colour the program had set — so highlighting a word inside a red
 * line leaves the rest of that line red.
 */
function paint(text, compiled, hs) {
  const hits = [];
  for (const c of compiled) {
    c.re.lastIndex = 0;
    let m;
    while ((m = c.re.exec(text)) !== null) {
      if (m[0] === '') { c.re.lastIndex++; continue; }
      hits.push({ start: m.index, end: m.index + m[0].length, sgr: c.sgr });
      if (hits.length > 400) break;   // a pathological line is not worth the time
    }
    if (hits.length > 400) break;
  }
  if (!hits.length) return text;

  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let at = 0;
  for (const h of hits) {
    if (h.start < at) continue;       // overlapped by an earlier rule
    out += text.slice(at, h.start);
    out += `[${h.sgr}m` + text.slice(h.start, h.end) + '[0m' + hs.sgr;
    at = h.end;
  }
  return out + text.slice(at);
}

/* ------------------------------------------------------------------ */
/* The editor                                                          */
/* ------------------------------------------------------------------ */

async function saveRules(rules) {
  state.settings = await window.api.settings.set({ highlightRules: rules });
  return state.settings;
}

/** Edit one rule. A built-in is copied into settings the moment it is changed. */
async function editRule(rule, { hostKey = null } = {}) {
  const isNew = !rule;
  const r = rule || {
    id: uid('hl'), name: '', pattern: '', regex: false,
    caseSensitive: false, color: 'amber', background: true, enabled: true,
  };

  const nameIn = textInput({ value: r.name || '', placeholder: 'Disk pressure' });
  const patIn = textInput({ value: r.pattern || '', placeholder: 'no space left' });
  const regexIn = checkbox('It is a regular expression', !!r.regex);
  const caseIn = checkbox('Match case', !!r.caseSensitive);
  const colorSel = select(HIGHLIGHT_COLORS.map((c) => ({ value: c.value, label: c.label })), r.color || 'amber');
  const bgIn = checkbox('Fill the background (rather than colour the text)', r.background !== false);
  const sample = el('div', {
    style: 'font-family:var(--mono);font-size:11.5px;padding:8px 10px;border-radius:var(--radius);'
      + 'background:#11151c;color:#c9d1d9;margin-top:8px',
  });
  const drawSample = () => {
    clear(sample);
    const c = HIGHLIGHT_COLORS.find((x) => x.value === colorSel.value) || HIGHLIGHT_COLORS[0];
    const css = {
      red: '#f85149', amber: '#d29922', green: '#3fb950',
      blue: '#4c8dff', cyan: '#39c5cf', magenta: '#bc8cff', grey: '#8b949e',
    }[c.value];
    sample.append(
      el('span', { text: 'nginx: ' }),
      el('span', {
        style: bgIn.input.checked
          ? `background:${css};color:#0d1117;font-weight:600;padding:0 2px;border-radius:2px`
          : `color:${css};font-weight:600`,
        text: patIn.value.trim() || 'keyword',
      }),
      el('span', { text: ' while reading upstream' }));
  };
  [patIn].forEach((i) => i.addEventListener('input', drawSample));
  colorSel.addEventListener('change', drawSample);
  bgIn.input.addEventListener('change', drawSample);

  const res = await modal({
    title: isNew ? 'New highlight' : 'Edit highlight',
    subtitle: hostKey ? 'For this host only' : 'For every session',
    render: (body) => {
      body.append(
        field('Name (optional)', nameIn),
        field('Text to highlight', patIn, 'Plain text unless you tick the box below'),
        regexIn, caseIn,
        field('Colour', colorSel),
        bgIn,
        el('label', { style: 'font-size:11px;color:var(--muted);margin:10px 0 0;display:block', text: 'Preview' }),
        sample);
      drawSample();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: isNew ? 'Add' : 'Save', class: 'primary-btn',
        onClick: ({ close }) => {
          const pattern = patIn.value.trim();
          if (!pattern) return toast('Give it some text to look for', 'error');
          if (regexIn.input.checked) {
            try { new RegExp(pattern); } catch (e) { return toast('That regular expression will not compile: ' + e.message, 'error'); }
          }
          close({
            ...r,
            // A built-in that has been edited becomes an ordinary rule: it
            // keeps its id so it replaces the original rather than doubling it.
            builtin: false,
            name: nameIn.value.trim(),
            pattern,
            regex: regexIn.input.checked,
            caseSensitive: caseIn.input.checked,
            color: colorSel.value,
            background: bgIn.input.checked,
            enabled: r.enabled !== false,
          });
        },
      },
    ],
  });
  return res;
}

/**
 * The list of highlights, for everything or for one host.
 *
 * Per host as well as globally because the words that matter are not the same
 * everywhere: a mail relay's `deferred` is routine, a build box's is not.
 */
export async function openHighlightSettings({ hostKey = null, hostLabel = '' } = {}) {
  const rows = el('div', { class: 'picker-list' });
  const globalOn = checkbox('Highlight keywords in every session', state.settings.highlight !== false);
  globalOn.input.addEventListener('change', async () => {
    await setHighlightDefault(globalOn.input.checked);
    refreshAllHighlighting();
  });

  const hostSel = hostKey
    ? select([
        { value: 'default', label: `Follow the global setting (${state.settings.highlight !== false ? 'on' : 'off'})` },
        { value: 'on', label: 'Always on for this host' },
        { value: 'off', label: 'Always off for this host' },
      ], highlightSource(hostKey) === 'host' ? (highlightOn(hostKey) ? 'on' : 'off') : 'default')
    : null;
  hostSel?.addEventListener('change', async () => {
    await setHighlightForHost(hostKey, hostSel.value === 'default' ? null : hostSel.value === 'on');
    refreshAllHighlighting();
  });

  const draw = () => {
    clear(rows);
    const entry = hostKey ? hostEntry(hostKey) : null;
    const off = new Set(entry?.off || []);

    for (const r of allRules()) {
      const on = r.enabled !== false && !off.has(r.id);
      const tick = checkbox('', on);
      tick.input.addEventListener('change', async () => {
        if (hostKey) {
          // Off *here*, without touching what every other host does.
          const map = { ...(state.settings.highlightHosts || {}) };
          const e2 = { ...(map[hostKey] || {}) };
          const list = new Set(e2.off || []);
          tick.input.checked ? list.delete(r.id) : list.add(r.id);
          e2.off = [...list];
          map[hostKey] = e2;
          state.settings = await window.api.settings.set({ highlightHosts: map });
        } else {
          const own = [...(state.settings.highlightRules || [])];
          const at = own.findIndex((x) => x.id === r.id);
          if (at >= 0) own[at] = { ...own[at], enabled: tick.input.checked };
          else own.push({ ...r, builtin: false, enabled: tick.input.checked });
          await saveRules(own);
        }
        refreshAllHighlighting();
        draw();
      });

      const c = HIGHLIGHT_COLORS.find((x) => x.value === r.color) || HIGHLIGHT_COLORS[0];
      const css = {
        red: '#f85149', amber: '#d29922', green: '#3fb950',
        blue: '#4c8dff', cyan: '#39c5cf', magenta: '#bc8cff', grey: '#8b949e',
      }[c.value];

      rows.append(el('div', { class: 'picker-item' },
        tick,
        el('span', {
          style: (r.background === false
            ? `color:${css}`
            : `background:${css};color:#0d1117;padding:0 3px;border-radius:2px`)
            + ';font-family:var(--mono);font-size:11px;font-weight:600;flex:none;max-width:210px;'
            + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
          text: r.pattern,
        }),
        el('span', { class: 'pname', style: 'flex:1;opacity:.8', text: r.name || '' }),
        r.regex ? el('span', { class: 'tag', text: 'regex' }) : null,
        r.builtin ? el('span', { class: 'tag', text: 'built in' }) : null,
        el('button', {
          class: 'ghost-btn sm', text: 'Edit',
          onClick: async () => {
            const edited = await editRule(r);
            if (!edited) return;
            const own = [...(state.settings.highlightRules || [])];
            const at = own.findIndex((x) => x.id === edited.id);
            if (at >= 0) own[at] = edited; else own.push(edited);
            await saveRules(own);
            refreshAllHighlighting();
            draw();
          },
        }),
        el('button', {
          class: 'icon-btn sm', text: '×',
          title: r.builtin ? 'Hide this built-in highlight' : 'Delete this highlight',
          onClick: async () => {
            if (r.builtin) {
              const hidden = new Set(state.settings.hiddenHighlightRules || []);
              hidden.add(r.id);
              state.settings = await window.api.settings.set({ hiddenHighlightRules: [...hidden] });
            } else {
              await saveRules((state.settings.highlightRules || []).filter((x) => x.id !== r.id));
            }
            refreshAllHighlighting();
            draw();
          },
        })));
    }

    if (hostKey) {
      for (const r of (hostEntry(hostKey)?.extra || [])) {
        rows.append(el('div', { class: 'picker-item' },
          el('span', { class: 'tag', text: 'this host' }),
          el('span', {
            style: 'font-family:var(--mono);font-size:11px;flex:1',
            text: r.pattern,
          }),
          el('button', {
            class: 'icon-btn sm', text: '×',
            onClick: async () => {
              const map = { ...(state.settings.highlightHosts || {}) };
              const e2 = { ...(map[hostKey] || {}) };
              e2.extra = (e2.extra || []).filter((x) => x.id !== r.id);
              map[hostKey] = e2;
              state.settings = await window.api.settings.set({ highlightHosts: map });
              refreshAllHighlighting();
              draw();
            },
          })));
      }
    }

    if (!allRules().length) {
      rows.append(el('div', { class: 'sb-empty', text: 'Nothing is highlighted yet.' }));
    }
  };

  return modal({
    title: 'Keyword highlighting',
    subtitle: hostKey ? hostLabel : 'Applies to every session',
    width: 'min(680px, 94vw)',
    render: (body) => {
      draw();
      body.append(...[
        globalOn,
        hostSel ? field(`For ${hostLabel}`, hostSel) : null,
        el('div', { style: 'height:8px' }),
        rows,
        el('div', { class: 'hint', style: 'margin-top:9px' },
          'Highlighting stands aside while a full-screen program is running — vim, less, htop — so it '
          + 'never recolours something drawing its own screen.'),
        el('div', { style: 'margin-top:10px;display:flex;gap:6px;flex-wrap:wrap' },
          el('button', {
            class: 'primary-btn sm', text: 'Add a highlight…',
            onClick: async () => {
              const added = await editRule(null);
              if (!added) return;
              await saveRules([...(state.settings.highlightRules || []), added]);
              refreshAllHighlighting();
              draw();
            },
          }),
          hostKey ? el('button', {
            class: 'ghost-btn sm', text: 'Add for this host only…',
            onClick: async () => {
              const added = await editRule(null, { hostKey });
              if (!added) return;
              const map = { ...(state.settings.highlightHosts || {}) };
              const e2 = { ...(map[hostKey] || {}) };
              e2.extra = [...(e2.extra || []), added];
              map[hostKey] = e2;
              state.settings = await window.api.settings.set({ highlightHosts: map });
              refreshAllHighlighting();
              draw();
            },
          }) : null,
          (state.settings.hiddenHighlightRules || []).length ? el('button', {
            class: 'ghost-btn sm', text: 'Restore built-ins',
            onClick: async () => {
              state.settings = await window.api.settings.set({ hiddenHighlightRules: [] });
              refreshAllHighlighting();
              draw();
            },
          }) : null),
      ].filter(Boolean));
    },
    buttons: [{ label: 'Close', value: null }],
  });
}

/**
 * Re-read the rules into every open pane.
 *
 * Only new output is recoloured: what is already on screen was written with
 * whatever was in force at the time, and rewriting the scrollback would mean
 * replaying it — losing the cursor, the selection and the scroll position for
 * a cosmetic change.
 */
export function refreshAllHighlighting() {
  for (const pane of state.panes.values()) {
    if (typeof pane.applyHighlightSettings === 'function') pane.applyHighlightSettings();
  }
  status('Highlighting updated — it applies to new output');
}
