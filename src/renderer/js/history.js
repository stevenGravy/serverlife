import { state } from './state.js';
import { el, clear, fmtDate } from './util.js';
import { modal, toast, status, textInput, contextMenu } from './ui.js';

/**
 * What this account has typed on this host before, searchable.
 *
 * The question it answers is "what was that command" — the one with the
 * awkward flags, run three weeks ago on this box and nowhere else. That
 * lives in the host's own history file and nowhere the app could otherwise
 * see, so until now the way to find it was to open a terminal and press Up
 * two hundred times.
 *
 * Deliberately not a terminal feature. Up-arrow already walks the history of
 * the shell you are in; this is the whole file, across sessions, with a
 * search over it and somewhere for the result to go — the clipboard, the
 * prompt, or a macro.
 */

/** Newest first, filtered by every word in the query. */
function matching(entries, query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return entries;
  // Every word, anywhere in the command: `docker prune` finds
  // `docker system prune -af` without anyone having to type it in order.
  return entries.filter((e) => {
    const c = e.command.toLowerCase();
    return terms.every((t) => c.includes(t));
  });
}

export async function openHistoryDialog(pane) {
  const connId = pane?.connId;
  if (!connId) {
    return toast('Command history is read from the host — open it on a server session', 'error');
  }
  const conn = state.getConnection(connId);

  let data = null;
  let error = null;
  let selected = null;
  let list = null;
  let count = null;
  const search = textInput({ placeholder: 'Search the history…', autofocus: true });

  const load = async (refresh) => {
    error = null;
    data = null;
    draw();
    try {
      data = await window.api.conn.shellHistory(connId, { refresh });
    } catch (e) {
      error = e.message;
    }
    draw();
  };

  /** Paste it at the prompt, without pressing Enter. */
  const insert = async (cmd) => {
    const { sendToPane } = await import('./sessions.js');
    sendToPane(pane, cmd);
    status('Put at the prompt — press Enter to run it');
  };

  const run = async (cmd) => {
    const { sendToPane } = await import('./sessions.js');
    sendToPane(pane, cmd.replace(/\n*$/, '\n'));
    status(`Ran on ${conn?.label || 'the host'}`);
  };

  const toMacro = async (cmd) => {
    const { editMacro } = await import('./macros.js');
    const saved = await editMacro({
      command: cmd,
      category: 'Custom',
      // It came off a server, so that is where it belongs until said
      // otherwise.
      where: 'hosts',
      name: cmd.split(/\s+/).slice(0, 3).join(' ').slice(0, 40),
    });
    if (saved) status(`Saved ${saved.name || 'macro'} — it is in the ▶ menu now`);
  };

  const draw = () => {
    if (!list) return;
    clear(list);

    if (error) {
      list.append(el('div', { class: 'sb-empty' },
        el('div', { style: 'color:var(--red)', text: error }),
        el('div', {
          class: 'hint',
          style: 'margin-top:8px',
          text: 'The history is read from the files the shell writes — '
            + '~/.bash_history, ~/.zsh_history and the like. An account with none of '
            + 'them, or a shell configured not to keep one, has nothing to show.',
        })));
      count.textContent = '';
      return;
    }
    if (!data) {
      list.append(el('div', { class: 'sb-empty', text: 'Reading the history…' }));
      count.textContent = '';
      return;
    }

    const found = matching(data.entries, search.value);
    count.textContent = search.value.trim()
      ? `${found.length} of ${data.entries.length}`
      : `${data.entries.length} commands`;

    if (!found.length) {
      list.append(el('div', {
        class: 'sb-empty',
        text: data.entries.length ? 'Nothing matches that.' : 'No history found for this account.',
      }));
      return;
    }

    for (const e of found.slice(0, 500)) {
      const row = el('div', {
        class: 'picker-item' + (e.command === selected ? ' active' : ''),
        title: e.at ? `${e.command}\n\n${fmtDate(e.at)}` : e.command,
      },
        el('span', {
          class: 'pname',
          style: 'font-family:var(--mono);font-size:11.5px;white-space:pre-wrap;word-break:break-word',
          text: e.command,
        }),
        e.at ? el('span', { class: 'pmeta', text: fmtDate(e.at) }) : null);

      // A click selects; the buttons below act. Running something on a server
      // is not what a single click should mean.
      row.addEventListener('click', () => { selected = e.command; draw(); });
      row.addEventListener('dblclick', () => insert(e.command));
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        selected = e.command;
        draw();
        contextMenu(ev.clientX, ev.clientY, [
          { heading: true, label: e.command.slice(0, 80) },
          { label: 'Put it at the prompt', onClick: () => insert(e.command) },
          { label: 'Run it now', onClick: () => run(e.command) },
          { sep: true },
          { label: 'Copy', onClick: () => { window.api.clipboard.write(e.command); status('Copied'); } },
          { label: 'Make a macro from it…', onClick: () => toMacro(e.command) },
        ]);
      });
      list.append(row);
    }

    if (found.length > 500) {
      list.append(el('div', {
        class: 'sb-empty',
        text: `${found.length - 500} more — narrow the search to see them.`,
      }));
    }
  };

  const need = (fn) => () => {
    if (!selected) return toast('Pick a command from the list first', 'error');
    return fn(selected);
  };

  return modal({
    title: 'Command history',
    subtitle: conn?.label || 'this host',
    width: 'min(760px, 94vw)',
    render: (body) => {
      const head = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px' },
        search,
        el('span', { class: 'hint', style: 'white-space:nowrap' }),
        el('button', {
          class: 'ghost-btn sm', text: 'Re-read',
          title: 'Ask the host again — after a shell has written more of it out',
          onClick: () => load(true),
        }));
      count = head.children[1];
      list = el('div', { class: 'picker-list', style: 'max-height:46vh' });

      search.addEventListener('input', draw);
      search.addEventListener('keydown', (e) => {
        // Enter on a search puts the top match at the prompt, which is the
        // thing you came here to do.
        if (e.key !== 'Enter' || !data) return;
        const top = matching(data.entries, search.value)[0];
        if (top) { selected = top.command; draw(); insert(top.command); }
      });

      body.append(head, list, el('div', {
        class: 'hint',
        style: 'margin-top:9px',
        text: 'Read from the host’s history files, newest first and each command once. '
          + 'bash writes its file when the shell exits, so what you are typing in the '
          + 'session next door is usually not in here yet — Re-read picks it up afterwards.',
      }));
      draw();
      load(false);
    },
    buttons: [
      { label: 'Close', value: null },
      { label: 'Copy', onClick: need((c) => { window.api.clipboard.write(c); status('Copied'); }) },
      { label: 'Make a macro…', onClick: need(toMacro) },
      {
        label: 'Run it',
        title: 'Send it to this session and press Enter',
        onClick: need((c) => { run(c); }),
      },
      {
        label: 'Put at the prompt',
        class: 'primary-btn',
        onClick: need((c) => { insert(c); }),
      },
    ],
  });
}
