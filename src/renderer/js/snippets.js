import { state } from './state.js';
import { el, clear } from './util.js';
import { modal, field, textInput, toast, status, confirm } from './ui.js';

/**
 * Saved commands.
 *
 * The thing you actually repeat on servers is a command, not a keystroke —
 * a log tail, a service restart, a diagnostic one-liner. These are stored once
 * and sent into whichever terminal is in front of you, or into every pane at
 * once when you are working across a set of machines.
 */

export async function openSnippetsDialog() {
  let body = null;
  let filter = '';

  const search = textInput({ placeholder: 'Filter snippets…', autofocus: true });
  search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); render(); });

  const render = async () => {
    if (!body) return;
    const listWrap = body.querySelector('.snip-list');
    clear(listWrap);

    let snippets = await window.api.profiles.listSnippets().catch(() => []);
    if (filter) {
      snippets = snippets.filter((s) =>
        (s.name + ' ' + s.command + ' ' + (s.tags || []).join(' ')).toLowerCase().includes(filter));
    }
    // Most-used first: the list should converge on what you actually run.
    snippets.sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || a.name.localeCompare(b.name));

    if (!snippets.length) {
      listWrap.append(el('div', { class: 'sb-empty', text: filter ? 'No matches.' : 'No snippets yet.' }));
      return;
    }

    for (const sn of snippets) {
      const card = el('div', { class: 'req-card' });
      card.append(el('div', { class: 'req-head' },
        el('span', { style: 'font-weight:600;font-size:13px', text: sn.name }),
        sn.useCount ? el('span', { class: 'tag', text: `used ${sn.useCount}×` }) : null,
        ...(sn.tags || []).map((t) => el('span', { class: 'tag', text: t }))));

      card.append(el('pre', {
        style: 'margin:6px 0 0;padding:7px 9px;background:var(--panel-2);border:1px solid var(--border);'
          + 'border-radius:var(--radius);font-family:var(--mono);font-size:11px;white-space:pre-wrap;max-height:110px;overflow:auto',
        text: sn.command,
      }));

      card.append(el('div', { class: 'req-actions' },
        el('button', {
          class: 'primary-btn', text: 'Run here',
          title: 'Send to the focused terminal',
          onClick: () => runSnippet(sn, { all: false }),
        }),
        el('button', {
          class: 'ghost-btn', text: 'Run in all panes',
          title: 'Send to every remote pane in the current tab',
          onClick: () => runSnippet(sn, { all: true }),
        }),
        el('button', {
          class: 'ghost-btn', text: 'Copy',
          onClick: () => { window.api.clipboard.write(sn.command); status('Copied'); },
        }),
        el('button', {
          class: 'ghost-btn', text: 'Edit',
          onClick: () => editSnippet(sn).then(render),
        }),
        el('button', {
          class: 'ghost-btn danger-btn', text: 'Delete',
          onClick: async () => {
            if (!await confirm({ title: 'Delete snippet', message: `Delete “${sn.name}”?`, confirmLabel: 'Delete', danger: true })) return;
            await window.api.profiles.deleteSnippet(sn.id);
            render();
          },
        })));
      listWrap.append(card);
    }
  };

  await modal({
    title: 'Command snippets',
    subtitle: 'Saved commands, sent into a terminal',
    width: 'min(760px, 94vw)',
    render: (b) => {
      body = b;
      b.append(el('div', { class: 'field' }, search), el('div', { class: 'snip-list' }));
      render();
    },
    buttons: [
      { label: 'New snippet…', onClick: () => editSnippet({}).then(render) },
      { label: 'Close', value: null },
    ],
  });
}

export async function editSnippet(initial = {}) {
  const nameIn = textInput({ value: initial.name || '', placeholder: 'Tail syslog' });
  const tagsIn = textInput({ value: (initial.tags || []).join(', '), placeholder: 'logs, diagnostics' });
  const cmdIn = el('textarea', {
    style: 'width:100%;height:150px;font-family:var(--mono);font-size:12px',
    placeholder: 'sudo tail -f /var/log/syslog',
    spellcheck: 'false',
  });
  cmdIn.value = initial.command || '';

  const res = await modal({
    title: initial.id ? 'Edit snippet' : 'New snippet',
    render: (body) => {
      body.append(
        field('Name', nameIn),
        field('Command', cmdIn, 'Sent to the terminal followed by Enter'),
        field('Tags (optional)', tagsIn));
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Save', class: 'primary-btn',
        onClick: ({ close }) => {
          if (!cmdIn.value.trim()) return toast('Enter a command', 'error');
          close({
            id: initial.id,
            name: nameIn.value.trim() || cmdIn.value.split('\n')[0].slice(0, 40),
            command: cmdIn.value.replace(/\n+$/, ''),
            tags: tagsIn.value.split(',').map((t) => t.trim()).filter(Boolean),
          });
        },
      },
    ],
  });
  if (!res) return null;
  const saved = await window.api.profiles.saveSnippet(res);
  status(`Saved snippet “${saved.name}”`);
  return saved;
}

/** Send a snippet to the focused pane, or to every remote pane in the tab. */
export async function runSnippet(sn, { all = false } = {}) {
  const { sendToPane } = await import('./sessions.js');
  const text = sn.command.replace(/\n*$/, '\n');

  const targets = all
    ? state.panesOf(state.activeTabId).map((id) => state.getPane(id)).filter((p) => p && p.termId && p.kind === 'remote')
    : [state.activePane].filter((p) => p && p.termId);

  if (!targets.length) return toast('No terminal to send to', 'error');
  for (const p of targets) sendToPane(p, text);
  window.api.profiles.markSnippetUsed(sn.id).catch(() => {});
  status(`Ran “${sn.name}” in ${targets.length} pane(s)`);
}

/** Save whatever is selected in the terminal as a snippet. */
export async function snippetFromSelection(selection) {
  if (!selection?.trim()) return toast('Nothing selected', 'error');
  return editSnippet({ command: selection.trim() });
}
