import { el, clear, $, ICON_CHOICES, HOST_COLORS } from './util.js';

/* ------------------------------ toasts ------------------------------ */

export function toast(message, kind = 'info', ms = 3800) {
  const root = $('#toast-root');
  const node = el('div', { class: 'toast ' + kind, text: message });
  root.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ms);
  return node;
}

export function status(message, ms = 4000, kind = '') {
  const node = $('#status-msg');
  node.textContent = message || '';

  // A login in flight gets a box of its own, fixed low on the right — the
  // status bar's 11px text is too easy to miss for the one message that
  // means "something just started, hold on". Only a call that owns the
  // banner (kind === 'login') may touch it: `status()` runs constantly for
  // every unrelated transient message in the app, and any of those arriving
  // mid-login — which can take real seconds, an SSO browser round trip
  // among them — used to hide the banner as a side effect of a message that
  // had nothing to do with it, leaving only the plain status-bar text
  // behind for the rest of the login.
  const banner = $('#login-banner');
  if (kind === 'login') {
    if (message) {
      $('#login-banner-text').textContent = message;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  if (message && ms) {
    clearTimeout(status._t);
    status._t = setTimeout(() => {
      if (node.textContent === message) node.textContent = '';
      if (kind === 'login') banner.classList.add('hidden');
    }, ms);
  }
}

/* ------------------------------ modal ------------------------------ */

/**
 * Generic modal. `render` receives a body element and helpers, and returns an
 * optional cleanup. Resolves with whatever `close(value)` is called with.
 */
/**
 * A dialog.
 *
 * `resize` gives it a drag handle in the corner and remembers the size it was
 * left at, keyed by `resize`. Worth it for the ones people live in — network
 * tools, the guide — where the right size depends on what is being read, not
 * on what the dialog is.
 */
export function modal({ title, subtitle, render, buttons, width, onOpen, resize }) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const body = el('div', { class: 'modal-body' });
    /*
     * A dialog builds its body from pieces some of which are only there
     * sometimes (`cond ? row : null`). The DOM's own append prints a null as
     * the word "null" — it did, under Quick connect with nothing recent, and
     * under the phase builder's problems — so the body's append and
     * replaceChildren leave empty pieces out.
     */
    const kept = (nodes) => nodes.filter((n) => n !== null && n !== undefined && n !== false);
    const nativeAppend = body.append.bind(body);
    const nativeReplace = body.replaceChildren.bind(body);
    body.append = (...nodes) => nativeAppend(...kept(nodes));
    body.replaceChildren = (...nodes) => nativeReplace(...kept(nodes));
    const foot = el('div', { class: 'modal-foot' });
    const box = el('div', { class: 'modal' },
      el('div', { class: 'modal-head' },
        el('h2', { text: title || '' }),
        subtitle ? el('span', { class: 'sub', text: subtitle }) : null),
      body, foot);
    if (width) box.style.width = width;
    if (resize) {
      box.classList.add('resizable');
      // The size this dialog was last left at. Per-dialog rather than global:
      // a file listing and a form want different shapes.
      try {
        const saved = JSON.parse(localStorage.getItem('sl.modal.' + resize) || 'null');
        if (saved?.w) box.style.width = Math.min(saved.w, window.innerWidth - 24) + 'px';
        if (saved?.h) box.style.height = Math.min(saved.h, window.innerHeight - 24) + 'px';
      } catch { /* a blocked or empty store just means the default size */ }
      // Written on close rather than on every pixel of the drag.
      const remember = () => {
        try {
          localStorage.setItem('sl.modal.' + resize, JSON.stringify({
            w: Math.round(box.getBoundingClientRect().width),
            h: Math.round(box.getBoundingClientRect().height),
          }));
        } catch { /* a blocked store just means the default size next time */ }
      };
      box._rememberSize = remember;
    }
    backdrop.append(box);

    let cleanup = null;
    const close = (value) => {
      if (box._rememberSize) try { box._rememberSize(); } catch { /* closing matters more than remembering the size */ }
      if (cleanup) try { cleanup(); } catch { /* closing matters more than the cleanup */ }
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(value);
    };

    const onKey = (e) => {
      // Escape in a code editor is the editor's (it closes its own search box), not a way to lose what was typed.
      if (e.key === 'Escape' && e.target?.closest?.('.cm-editor')) return;
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(undefined); }
      /*
       * Enter, when nothing inside the modal actually has focus to answer
       * it. The 30ms `setTimeout` below that focuses the default button
       * loses the race against a terminal pane that re-asserts its own
       * focus the moment anything in the DOM changes near it — a dialog
       * opened over a live pane left Enter doing nothing, or (worse, for a
       * destructive one) landing wherever focus actually ended up instead
       * of the button that was supposed to own it. A control genuinely
       * focused *inside* the modal — a text field with its own Enter
       * handling, a button a click already moved focus to — is left alone;
       * this only steps in when focus is not there to ask in the first
       * place.
       */
      if (e.key === 'Enter' && !document.activeElement?.closest?.('.modal')) {
        const def = box.querySelector('[autofocus]');
        if (def) { e.stopPropagation(); e.preventDefault(); def.click(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(undefined); });

    cleanup = render ? render(body, { close, foot, box }) : null;

    for (const b of buttons || []) {
      foot.append(el('button', {
        class: b.class || 'ghost-btn',
        text: b.label,
        // The button Enter should press, when the first control in the body
        // (a "Do not ask again" checkbox) is not the answer.
        autofocus: b.autofocus,
        /*
         * Whether a button carries a value is whether the key is *there*, not
         * whether it is truthy or even defined.
         *
         * `{ label: 'Cancel', value: undefined }` is how several dialogs spell
         * "close, answering nothing" — and testing `b.value !== undefined`
         * read that as "no value, so call onClick", of which there was none.
         * The button did nothing at all: a dead Cancel on the rename prompt,
         * the layout picker and the key dialogs, where Escape was the only way
         * out.
         */
        onClick: () => ('value' in b ? close(b.value) : b.onClick?.({ close, body })),
      }));
    }

    $('#modal-root').append(backdrop);
    const focusTarget = box.querySelector('[autofocus]') || box.querySelector('input, textarea, select, button');
    setTimeout(() => focusTarget?.focus(), 30);
    onOpen?.({ close, body, box });
  });
}

/** Single-line text prompt. */
export function prompt({ title, label, value = '', placeholder, confirmLabel = 'OK', validate }) {
  return modal({
    title,
    render: (body, { close }) => {
      const input = el('input', { value, placeholder, autofocus: true, spellcheck: 'false' });
      const err = el('div', { class: 'hint', style: 'color:var(--red)' });
      const submit = () => {
        const v = input.value.trim();
        if (validate) {
          const msg = validate(v);
          if (msg) { err.textContent = msg; return; }
        }
        close(v);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
      body.append(el('div', { class: 'field' },
        label ? el('label', { class: 'field-label', text: label }) : null, input, err));
      body._submit = submit;
      setTimeout(() => input.select(), 40);
    },
    buttons: [
      { label: 'Cancel', value: undefined },
      { label: confirmLabel, class: 'primary-btn', onClick: ({ body }) => body._submit() },
    ],
  });
}

export function confirm({ title, message, detail, confirmLabel = 'Confirm', danger }) {
  return modal({
    title,
    render: (body) => {
      body.append(el('div', { style: 'font-size:13px;margin-bottom:6px', text: message || '' }));
      if (detail) body.append(el('div', { class: 'hint', style: 'white-space:pre-wrap', text: detail }));
    },
    buttons: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, class: danger ? 'ghost-btn danger-btn' : 'primary-btn', value: true },
    ],
  }).then((v) => v === true);
}

/* --------------------------- context menu --------------------------- */

let openMenu = null;

export function contextMenu(x, y, items) {
  closeContextMenu();
  const menu = buildMenu(items);
  $('#ctxmenu-root').append(menu);

  // Keep the menu inside the viewport.
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  // Never above the window: a menu taller than it scrolls instead (styles.css).
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';

  openMenu = menu;
  setTimeout(() => {
    // Dismiss on an outside press only. Closing on *any* mousedown removes the
    // menu before the button's own click event can fire, so every item would
    // silently do nothing when clicked with a real mouse.
    document.addEventListener('mousedown', onOutsidePress, true);
    document.addEventListener('keydown', escClose, true);
  }, 0);
  return menu;
}

/**
 * One panel of a menu. An item with `submenu` opens a second panel beside it
 * rather than adding four more lines to a list that is already long.
 */
function buildMenu(items) {
  const menu = el('div', { class: 'ctxmenu' });
  /*
   * A gutter for icons, but only in a panel that has some.
   *
   * Per panel rather than globally: a submenu of four logins has nothing to
   * illustrate and should not be indented as though it had. Every item in a
   * panel that *does* use icons gets the slot whether or not it fills one,
   * because a menu where the labels start at two different places is harder
   * to read than one with no icons at all.
   */
  const anyIcon = items.some((i) => i && i.icon);
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { menu.append(el('div', { class: 'sep' })); continue; }
    // A heading groups the items under it; it is not clickable.
    if (it.heading) { menu.append(el('div', { class: 'ctx-heading', text: it.label })); continue; }

    const hasSub = Array.isArray(it.submenu) && it.submenu.length;
    // `sub` is a dim second line under the label \u2014 for what identifies a
    // choice without being its name, such as a cluster's labels.
    const btn = el('button', {
      class: (hasSub ? 'has-sub' : '') + (it.sub ? ' two-line' : ''),
      disabled: it.disabled || false,
      title: it.title || null,
    },
      anyIcon ? el('span', { class: 'ctx-icon', text: it.icon || '' }) : null,
      it.sub
        ? el('span', { class: 'ctx-lines' },
            el('span', { text: it.label }),
            el('span', { class: 'ctx-sub', text: it.sub }))
        : el('span', { text: it.label }),
      /*
       * A `?` that shows a card, not a tooltip.
       *
       * The native tooltip wanted a steady second of hover on a 13px circle
       * and vanished at the first twitch, which is no way to answer "what does
       * this do" — so hovering it opens a panel beside the row with the
       * question the item answers and the command it runs.
       */
      it.help ? helpMark(it.help) : null,
      hasSub
        ? el('span', { class: 'key sub-arrow' },
            it.key ? el('span', { class: 'sub-key', text: it.key + '  ' }) : null,
            el('span', { class: 'arrow', text: '\u203A' }))
        : (it.key ? el('span', { class: 'key', text: it.key }) : null));

    if (hasSub && !it.disabled) {
      let panel = null;
      const close = () => { panel?.remove(); panel = null; };
      const open = () => {
        if (panel) return;
        panel = buildMenu(it.submenu);
        panel.classList.add('ctxsub');
        menu.append(panel);
        // Panels are position:fixed, so these are viewport coordinates.
        const br = btn.getBoundingClientRect();
        const mr = menu.getBoundingClientRect();
        const pr = panel.getBoundingClientRect();
        // Flip to the left when there is no room on the right.
        const right = mr.right + pr.width + 4 <= window.innerWidth;
        // No gap: a gap between the panels is a strip of dead space the pointer
        // can cross, which closes the submenu on the way to it.
        panel.style.left = (right ? mr.right : mr.left - pr.width) + 'px';
        panel.style.top = Math.max(8, Math.min(br.top - 4, window.innerHeight - pr.height - 8)) + 'px';
        // The panel keeps itself open while the pointer is in it.
        panel.addEventListener('mouseenter', cancelClose);
        panel.addEventListener('mouseleave', scheduleClose);
      };
      /*
       * Closing is deliberately slow, and leaving the parent panel does not do
       * it.
       *
       * The submenu is positioned outside the parent's box, so the pointer
       * moving towards it leaves the parent — which, closed on immediately,
       * made a submenu almost impossible to reach: it vanished on the way. A
       * short grace period, cancelled by arriving in either the item or the
       * panel, is what makes the diagonal move work.
       */
      let closeTimer = null;
      const cancelClose = () => { clearTimeout(closeTimer); closeTimer = null; };
      // A panel is placed against its row once; scrolling the list moves the
      // row out from under it, so it goes and the next hover places it again.
      menu.addEventListener('scroll', close, { passive: true });
      const scheduleClose = () => { cancelClose(); closeTimer = setTimeout(close, 320); };

      /*
       * A row that *does* something opens its submenu from the arrow only.
       *
       * The macro list is the case: every row runs a macro and every row also
       * carries variations, so hovering down the list threw a second panel
       * open under the pointer at each step. An arrow you have to reach for is
       * how every other menu handles this. A row that is *only* a submenu
       * parent still opens on hover, since there is nothing else it could do.
       */
      const arrow = btn.querySelector('.sub-arrow');
      const hoverTarget = it.onClick && arrow ? arrow : btn;
      hoverTarget.addEventListener('mouseenter', () => { cancelClose(); open(); });
      hoverTarget.addEventListener('mouseleave', scheduleClose);
      if (hoverTarget !== btn) {
        // Leaving the row entirely still closes the panel; moving along it
        // does not open one.
        btn.addEventListener('mouseleave', scheduleClose);
      }
      btn.addEventListener('click', (e) => {
        // The arrow is a control of its own: it opens, it does not run.
        if (arrow && e.target.closest('.sub-arrow')) {
          e.stopPropagation();
          cancelClose();
          open();
          return;
        }
        if (it.onClick) { closeContextMenu(); it.onClick(); return; }
        e.stopPropagation();
        cancelClose();
        open();
      });
      // Moving to a sibling gives this panel the same grace period rather than
      // shutting it instantly, so passing over one item on the way to another
      // is survivable.
      menu.addEventListener('mouseover', (e) => {
        if (!panel) return;
        if (btn.contains(e.target) || panel.contains(e.target)) { cancelClose(); return; }
        scheduleClose();
      });
    } else if (!it.disabled) {
      btn.addEventListener('click', () => { closeContextMenu(); it.onClick?.(); });
    }
    menu.append(btn);
  }
  return menu;
}

/**
 * The `?` and its card.
 *
 * `help` is either a string or `{ answers, command, notes }`. The card is
 * built once per hover and torn down on leave; it is deliberately not
 * interactive, so nothing can be clicked by accident while reading it.
 */
function helpMark(help) {
  const mark = el('span', { class: 'ctx-help', text: '?' });
  let card = null;

  const hide = () => { card?.remove(); card = null; };

  const show = () => {
    if (card) return;
    const h = typeof help === 'string' ? { answers: help } : (help || {});
    card = el('div', { class: 'ctx-helpcard' },
      h.answers ? el('div', { class: 'answers', text: h.answers }) : null,
      h.command ? el('div', { class: 'cmd-label', text: 'runs' }) : null,
      h.command ? el('pre', { class: 'cmd', text: h.command }) : null,
      ...(h.notes || []).map((n) => el('div', { class: 'note', text: n })));
    document.body.append(card);

    /*
     * Placed beside the *menu*, not beside the mark.
     *
     * Anchored to the mark it landed half under the menu panel and the command
     * was clipped by it — the menu is a solid box, so the card has to clear
     * the whole thing.
     */
    const panel = mark.closest('.ctxmenu')?.getBoundingClientRect()
      || mark.getBoundingClientRect();
    const r = mark.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const right = panel.right + 10 + c.width <= window.innerWidth;
    card.style.left = (right ? panel.right + 10 : Math.max(8, panel.left - c.width - 10)) + 'px';
    card.style.top = Math.max(8, Math.min(r.top - 6, window.innerHeight - c.height - 8)) + 'px';
  };

  mark.addEventListener('mouseenter', show);
  mark.addEventListener('mouseleave', hide);
  /*
   * Clicking the `?` shows the card and nothing else.
   *
   * It sits inside a row that runs something, so the click must not reach it:
   * a question about what a macro does is not a request to run it on a server.
   */
  mark.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
  mark.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    show();
  });
  return mark;
}

function onOutsidePress(e) {
  if (openMenu && openMenu.contains(e.target)) return;
  closeContextMenu();
}

function escClose(e) { if (e.key === 'Escape') closeContextMenu(); }

export function closeContextMenu() {
  for (const c of document.querySelectorAll('.ctx-helpcard')) c.remove();
  if (openMenu) { openMenu.remove(); openMenu = null; }
  document.removeEventListener('mousedown', onOutsidePress, true);
  document.removeEventListener('keydown', escClose, true);
}

/* --------------------------- field helpers --------------------------- */

export function field(label, input, hint) {
  return el('div', { class: 'field' },
    label ? el('label', { class: 'field-label', text: label }) : null,
    input,
    hint ? el('div', { class: 'hint', text: hint }) : null);
}

export function textInput(attrs = {}) { return el('input', { type: 'text', spellcheck: 'false', ...attrs }); }

export function select(options, value, attrs = {}) {
  const s = el('select', attrs);
  const option = (o) => {
    const opt = el('option', { value: o.value, text: o.label });
    if (o.value === value) opt.selected = true;
    return opt;
  };
  // `{ group, options }` is a labelled section of the list.
  for (const o of options) {
    if (o.group) s.append(el('optgroup', { label: o.group }, ...o.options.map(option)));
    else s.append(option(o));
  }
  return s;
}

export function checkbox(label, checked, attrs = {}) {
  const input = el('input', { type: 'checkbox', ...attrs });
  input.checked = !!checked;
  const wrap = el('label', { class: 'check' }, input, el('span', { text: label }));
  wrap.input = input;
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Icons and colours                                                   */
/* ------------------------------------------------------------------ */

/**
 * A grid of suggested icons, a box for anything else, and a way to clear it.
 *
 * The grid is a shortcut, not the vocabulary: the field beside it takes
 * whatever you paste, so a team that labels its machines with 🦖 is not
 * arguing with a list somebody else wrote. Returns an element with a `value`
 * — one string, empty for none — so it drops into a form like an input.
 */
export function iconPicker({ value = '' } = {}) {
  let current = value || '';
  const custom = el('input', {
    type: 'text', class: 'icon-custom', value: current, maxlength: '8',
    placeholder: 'or paste one', spellcheck: 'false',
  });
  const grid = el('div', { class: 'icon-grid' });
  const wrap = el('div', { class: 'icon-picker' }, grid,
    el('div', { class: 'icon-row' },
      custom,
      el('button', {
        class: 'ghost-btn sm', text: 'None', type: 'button',
        onClick: () => { current = ''; custom.value = ''; paint(); },
      })));

  function paint() {
    clear(grid);
    for (const ic of ICON_CHOICES) {
      grid.append(el('button', {
        class: 'icon-cell' + (ic === current ? ' on' : ''),
        type: 'button', text: ic,
        onClick: () => { current = ic; custom.value = ic; paint(); },
      }));
    }
  }
  custom.addEventListener('input', () => { current = custom.value.trim(); paint(); });
  paint();

  Object.defineProperty(wrap, 'value', {
    get: () => current,
    set: (v) => { current = v || ''; custom.value = current; paint(); },
  });
  return wrap;
}

/** The picker as a dialog of its own, for a menu item that has no form. */
export async function pickIcon({ title = 'Icon', subtitle = '', value = '' } = {}) {
  const picker = iconPicker({ value });
  return modal({
    title,
    subtitle,
    width: 'min(460px, 94vw)',
    render: (body) => body.append(picker,
      el('div', { class: 'hint', style: 'margin-top:8px' },
        'It shows beside the name in the host list, and anywhere else that names this host.')),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Save', class: 'primary-btn', onClick: ({ close }) => close(picker.value) },
    ],
  });
}

/** The same shape for a colour: eight named ones and none. */
export function colorPicker({ value = '' } = {}) {
  let current = value || '';
  const grid = el('div', { class: 'icon-grid colors' });
  const wrap = el('div', { class: 'icon-picker' }, grid);
  function paint() {
    clear(grid);
    for (const c of HOST_COLORS) {
      grid.append(el('button', {
        class: 'color-cell' + (c.value === current ? ' on' : '') + (c.css ? '' : ' none'),
        type: 'button', title: c.label,
        style: c.css ? `--swatch:${c.css}` : null,
        text: c.css ? '' : '\u2014',
        onClick: () => { current = c.value; paint(); },
      }));
    }
  }
  paint();
  Object.defineProperty(wrap, 'value', { get: () => current, set: (v) => { current = v || ''; paint(); } });
  return wrap;
}
