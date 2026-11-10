import { state } from './state.js';
import { $, el, clear } from './util.js';
import { contextMenu, prompt } from './ui.js';
import {
  requestCloseTab, requestCloseTabs, duplicateActiveTab, splitActivePane, renderPanes, paneTitle, focusActivePane,
  draggingPaneId, movePaneToTab, movePaneToNewTab,
} from './sessions.js';
// The per-host colour lives with the host list, which owns the key it is stored under.
import { hostColorForConn } from './sidebar.js';
import { initActivity, paintTabActivity } from './activity.js';

/** The tab strip in the title bar, one tab per session. */
export function initTabs() {
  state.on('tabs', renderTabs);
  state.on('panes', renderTabs);
  state.on('connections', renderTabs);
  state.on('activePane', renderTabs);
  initActivity();
  renderTabs();
}

/**
 * Name the window after what is open in it. macOS lists windows in the Window
 * menu by title, so several windows called "ServerLife" are impossible to tell
 * apart; the hosts they hold are the only useful label.
 */
let lastTitle = null;
function syncWindowTitle() {
  const names = state.tabs.map((t) => {
    const conn = t.connId ? state.getConnection(t.connId) : null;
    return conn?.label || t.title || 'session';
  });
  const title = !names.length
    ? 'ServerLife'
    : names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
  if (title === lastTitle) return;
  lastTitle = title;
  // Electron mirrors the document title onto the window, and the window title
  // is what the Window menu lists — so this one line is the whole mechanism.
  document.title = title;
}

export function renderTabs() {
  const strip = $('#tabstrip');
  clear(strip);
  syncWindowTitle();

  for (const tab of state.tabs) {
    const paneIds = state.panesOf(tab.id);
    const conn = tab.connId ? state.getConnection(tab.connId) : null;

    let dotClass = 'local';
    if (tab.kind === 'remote') {
      const s = conn?.state;
      dotClass = s === 'connected' ? 'connected'
        : s === 'connecting' || s === 'prompting' ? 'connecting'
        : s === 'error' ? 'error' : '';
    }

    /*
     * The tab says who and where, not just what: a strip of tabs all reading
     * "Local shell" is a strip of tabs you have to click through to tell
     * apart. The pane's own title is the same text, so the two agree.
     */
    const firstPane = paneIds.length ? state.getPane(paneIds[0]) : null;
    const title = (firstPane ? paneTitle(firstPane) : '')
      || (tab.kind === 'local' ? 'Local shell' : (conn?.label || tab.title));
    // A tmux tab whose session has ended or been left says so on the tab
    // itself, not only inside it — otherwise it reads as live from afar.
    const suffix = (paneIds.length > 1 ? ` (${paneIds.length})` : '')
      + (tab.tmuxEnded ? ` \u2014 ${tab.tmuxEnded}` : '');
    // The colour marked on the host behind this tab, if any.
    const hostTint = conn ? hostColorForConn(conn) : '';

    const node = el('div', {
      // The id travels with the element: the activity marks are painted onto
      // the tabs that are already there, a few times a second, and rebuilding
      // the strip for them would be a redraw per chunk of output.
      dataset: { tab: tab.id },
      class: 'tab' + (tab.id === state.activeTabId ? ' active' : '')
        + (hostTint ? ' coloured' : '') + (tab.tmuxEnded ? ' ended' : ''),
      title: firstPane
        ? [paneTitle(firstPane, { long: true }), conn ? `${conn.target} — ${conn.state}` : '']
          .filter(Boolean).join('\n')
        : title,
      // The host's own colour, so a production tab is obvious in a row of
      // eight that otherwise look identical.
      style: hostTint ? `--host-color:${hostTint}` : null,
    },
      el('span', { class: 'dot ' + dotClass }),
      el('span', { class: 'label', text: title + suffix }),
      /*
       * What this session is doing, as opposed to whether it is connected —
       * which is what the dot beside it has always said.
       *
       * Two marks in one slot, because the two states mean opposite things
       * and should not look alike: bars that ripple while output is
       * arriving, and a question mark when the session has stopped and
       * wants an answer. They share a fixed-width slot and are shown one at
       * a time, so nothing in the strip moves as sessions come and go.
       */
      // Decorative: the marks are shape, and the tooltip on the slot says in
      // words what they mean. Without this the ? is in the tab's text
      // whether or not it is visible, and gets read out with the hostname.
      el('span', { class: 'tact', 'aria-hidden': 'true' },
        el('span', { class: 'bars' }, el('i'), el('i'), el('i')),
        el('span', { class: 'ask', text: '?' })),
      el('button', {
        class: 'close', text: '×',
        onClick: (e) => { e.stopPropagation(); requestCloseTab(tab.id); },
      }));

    node.addEventListener('click', () => {
      state.setActiveTab(tab.id);
      renderPanes();
      focusActivePane();
    });

    /*
     * A pane dragged onto a tab moves into it — the session, its scrollback
     * and anything running come along, because only the pane's place in a
     * tree changes. Dropping it on the tab it already lives in does
     * nothing, which is the right answer to a gesture that meant nothing.
     */
    node.addEventListener('dragover', (e) => {
      const id = draggingPaneId();
      if (!id || state.getPane(id)?.tabId === tab.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      node.classList.add('dropinto');
    });
    node.addEventListener('dragleave', (e) => {
      if (node.contains(e.relatedTarget)) return;
      node.classList.remove('dropinto');
    });
    node.addEventListener('drop', (e) => {
      node.classList.remove('dropinto');
      const id = draggingPaneId();
      if (!id || state.getPane(id)?.tabId === tab.id) return;
      e.preventDefault();
      e.stopPropagation();
      movePaneToTab(id, tab.id);
    });
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      state.setActiveTab(tab.id);
      renderPanes();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Duplicate tab', key: '⌘D', onClick: () => duplicateActiveTab() },
        { label: 'Split right', key: '⌘⇧D', onClick: () => splitActivePane('row') },
        { label: 'Split down', key: '⌘⇧E', onClick: () => splitActivePane('col') },
        { sep: true },
        {
          label: 'Rename…',
          onClick: async () => {
            const v = await prompt({ title: 'Rename tab', value: title, confirmLabel: 'Rename' });
            if (v) { tab.title = v; if (conn) conn.label = v; state.emit('tabs'); }
          },
        },
        { sep: true },
        { label: 'Close other tabs', onClick: () => {
          requestCloseTabs(state.tabs.filter((t) => t.id !== tab.id).map((t) => t.id));
        } },
        { label: 'Close tab', key: '⌘W', onClick: () => requestCloseTab(tab.id) },
      ]);
    });

    strip.append(node);
  }

  /*
   * Past the end of the tabs: a tab of its own. The gesture people try when
   * they want a pane out of a crowded tab is to drag it to where a new tab
   * would go, and the alternative — finding it in a menu — is the thing
   * dragging is meant to replace.
   */
  if (!strip.__paneDrop) {
    strip.__paneDrop = true;
    strip.addEventListener('dragover', (e) => {
      const id = draggingPaneId();
      if (!id || e.target.closest('.tab')) return;
      if (state.panesOf(state.getPane(id)?.tabId).length < 2) return;   // already alone
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      strip.classList.add('dropnew');
    });
    strip.addEventListener('dragleave', (e) => {
      if (strip.contains(e.relatedTarget)) return;
      strip.classList.remove('dropnew');
    });
    strip.addEventListener('drop', (e) => {
      strip.classList.remove('dropnew');
      const id = draggingPaneId();
      if (!id || e.target.closest('.tab')) return;
      e.preventDefault();
      movePaneToNewTab(id);
    });
  }

  // A freshly drawn strip starts with whatever is true right now, rather
  // than blank until the next tick.
  paintTabActivity();
}
