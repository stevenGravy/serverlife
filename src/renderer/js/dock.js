import { state, tpKey } from './state.js';
// The same tag language the host filter uses, so a selector is written exactly
// as a search would be.
import { compileQuery, labelEntries } from './tags.js';
import { $, $$, el, clear, fmtBytes, fmtRate, fmtDuration, fmtDate } from './util.js';
import { toast, status, confirm, prompt, modal, field, textInput, select, checkbox } from './ui.js';
import { macroRunsOn } from './macros.js';
import { nextRunAt, runsBetween, upcoming, describeRepeat, fmtWhen, toLocalInput } from './mxschedule.js';

/**
 * Bottom dock: transfer queue, multi-exec runner, and the raw connection log
 * for the focused session.
 */

let activeDock = 'transfers';

export function initDock() {
  startScheduler();
  /*
   * The dock's dragged height is a ceiling, not a mandate — see PANELS'
   * comment in index.js. A tab with one line of content should not fill
   * whatever height multi-exec was once dragged to just because it is the
   * same `#dock`, so any change under it (a render, a tab switch) re-settles
   * the height to what is actually on screen, up to that remembered ceiling.
   */
  let fitTimer = null;
  new MutationObserver(() => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitDockToContent, 0);
  }).observe($('#dock'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  $$('.dock-tab').forEach((btn) => {
    btn.addEventListener('click', () => openDock(btn.dataset.dock));
  });
  $('#dock-close').addEventListener('click', () => toggleDock(false));
  $('#dock-clear').addEventListener('click', async () => {
    if (activeDock === 'transfers') {
      // The list (renderTransfers(), below) already shows every connection's
      // jobs together, not just the focused one's — clearing only
      // state.activeConnId left every other connection's finished transfers
      // sitting there looking uncleared (or cleared nothing at all, if the
      // focused pane had no connection of its own).
      const ids = [...state.transfers.keys()];
      await Promise.all(ids.map((id) => window.api.xfer.clear(id).catch(() => {})));
      renderTransfers();
    } else if (activeDock === 'multiexec') {
      window.api.multiexec.clear().then(() => { state.multiRuns = []; renderMultiExec(); });
    } else if (activeDock === 'downloads') {
      // The files are the point of the list, so emptying it is worth a
      // question — and worth saying that it only forgets.
      const ok = await confirm({
        title: 'Clear the download list',
        message: 'Forget every entry in this list?',
        detail: 'The downloaded files themselves are left exactly where they are.',
        confirmLabel: 'Clear the list',
      });
      if (ok) { await window.api.downloads.clear().catch(() => {}); renderDownloads(); }
    } else {
      renderLog();
    }
  });

  // A download that finishes while the panel is open should appear in it.
  window.api.downloads.onUpdate(() => { if (activeDock === 'downloads') renderDownloads(); });
  // A watcher that has just uploaded something should say so while you are
  // looking at it.
  window.api.watch.onUpdate((list) => {
    state.watches = list || [];
    if (activeDock === 'watch') renderWatches();
    updateWatchStatus();
  });

  state.on('transfers', () => { renderTransfers(); updateXferStatus(); });
  state.on('forwards', () => { if (activeDock === 'forwards') renderForwards(); updateForwardStatus(); });
  state.on('multiexec', () => renderMultiExec());
  state.on('activePane', () => { if (activeDock === 'transfers') renderTransfers(); if (activeDock === 'log') renderLog(); });

  renderMultiExec();
}

export function toggleDock(force) {
  const dock = $('#dock');
  const show = force === undefined ? dock.classList.contains('hidden') : force;
  dock.classList.toggle('hidden', !show);
  $('#bottom-resizer').classList.toggle('hidden', !show);
  if (show) { refreshActive(); fitDockToContent(); }
  // Terminals need to re-fit when the dock steals or returns vertical space.
  setTimeout(() => {
    for (const p of state.panes.values()) p.view.fitNow();
  }, 30);
}

export function openDock(which) {
  activeDock = which || activeDock;
  $('#dock').classList.remove('hidden');
  $('#bottom-resizer').classList.remove('hidden');
  $$('.dock-tab').forEach((b) => b.classList.toggle('active', b.dataset.dock === activeDock));
  $('#dock-transfers').classList.toggle('hidden', activeDock !== 'transfers');
  $('#dock-multiexec').classList.toggle('hidden', activeDock !== 'multiexec');
  $('#dock-forwards').classList.toggle('hidden', activeDock !== 'forwards');
  $('#dock-log').classList.toggle('hidden', activeDock !== 'log');
  $('#dock-downloads').classList.toggle('hidden', activeDock !== 'downloads');
  $('#dock-watch').classList.toggle('hidden', activeDock !== 'watch');
  refreshActive();
  // Sized now rather than by the observer a tick later, so the terminal above
  // moves once instead of twice.
  fitDockToContent();
  setTimeout(() => { for (const p of state.panes.values()) p.view.fitNow(); }, 30);
}

/**
 * Settle `#dock` to what its active tab actually needs, not the full
 * remembered/dragged height — see the `MutationObserver` set up in
 * `initDock()`. If the dock was never dragged there is no remembered value
 * to treat as a ceiling, and the plain CSS default (`height: 15vh`) is
 * already modest, so this is a no-op until a drag gives it something to cap.
 *
 * Exported for `applyPanelSizes()` (index.js) to call once right after it
 * restores `#dock`'s own remembered height — that write is `style.height`,
 * not a class, so the observer above never sees it, and without this a
 * dock left open on a one-line tab the last time the app ran would come
 * back at whatever it was dragged to for a *different* tab, every launch,
 * until something else happened to touch it.
 */
/*
 * The transfer queue's default height, before it has ever been dragged.
 *
 * Fitted to its content with nothing else to go on, the dock grew a row at a
 * time as a sync queued its files and shrank again as they finished, so the
 * terminal above it jumped on every one — and opening it for a new upload
 * threw it to whatever height the dock had last been dragged to on another
 * tab. A transfer is something to glance at, so it defaults to a fixed
 * strip: about three rows, the rest scrolling — but only a default. Once
 * the user has actually dragged #bottom-resizer while this tab is open,
 * that drag is remembered the same as every other tab's and wins from then
 * on, below — the resize was the point, not something to override every
 * time the queue's own content changes size.
 */
export const TRANSFERS_HEIGHT = 124;

export function fitDockToContent() {
  const dock = $('#dock');
  if (!dock || dock.classList.contains('hidden')) return;
  const remembered = Number((state.settings.panelSizes || {})['#bottom-resizer']) || 0;
  if (activeDock === 'transfers' && !remembered) {
    if (Math.abs(TRANSFERS_HEIGHT - dock.getBoundingClientRect().height) >= 1) {
      dock.style.height = TRANSFERS_HEIGHT + 'px';
      dock.style.flex = '0 0 ' + TRANSFERS_HEIGHT + 'px';
    }
    return;
  }
  if (!remembered) return;
  const panel = $('#dock-' + activeDock);
  const head = dock.querySelector('.dock-head');
  if (!panel || !head) return;
  const natural = Math.ceil(head.offsetHeight + panel.scrollHeight) + 2;
  const next = Math.max(108, Math.min(remembered, natural));
  if (Math.abs(next - dock.getBoundingClientRect().height) < 1) return;
  dock.style.height = next + 'px';
  dock.style.flex = '0 0 ' + next + 'px';
}

function refreshActive() {
  if (activeDock === 'transfers') renderTransfers();
  else if (activeDock === 'multiexec') renderMultiExec();
  else if (activeDock === 'forwards') renderForwards();
  else if (activeDock === 'downloads') renderDownloads();
  else if (activeDock === 'watch') renderWatches();
  else renderLog();
}

/* ------------------------------------------------------------------ */
/* Port forwards                                                       */
/* ------------------------------------------------------------------ */

export function setForwards(connId, forwards) {
  state.forwards.set(connId, forwards);
  state.emit('forwards');
}

function describeForward(f) {
  if (f.kind === 'D') return `SOCKS5 proxy on ${f.bindAddr || 'localhost'}:${f.bindPort}`;
  if (f.kind === 'L') return `${f.bindAddr || 'localhost'}:${f.bindPort}  →  ${f.destHost}:${f.destPort}`;
  return `server:${f.bindPort}  →  ${f.destHost}:${f.destPort}`;
}

/**
 * Favourites: the tunnels that are the same three or four every day.
 *
 * A forward dies with its session, and re-typing `5432 → 10.0.4.12:5432` from
 * memory is how you end up pointing a client at the wrong replica. A favourite
 * keeps the whole shape, including which host to dial it on, and opens it in
 * one click — dialling the host first if it is not already up.
 */
async function loadForwardFavorites() {
  try { state.forwardFavorites = await window.api.forward.favorites(); }
  catch { state.forwardFavorites = state.forwardFavorites || []; }
  return state.forwardFavorites;
}

function describeFav(f) {
  if (f.kind === 'D') return `SOCKS5 on ${f.bindAddr || 'localhost'}:${f.bindPort}`;
  if (f.kind === 'L') return `${f.bindAddr || 'localhost'}:${f.bindPort}  →  ${f.destHost}:${f.destPort}`;
  return `server:${f.bindPort}  →  ${f.destHost}:${f.destPort}`;
}

/** Create or edit a favourite without opening anything. */
export async function openFavoriteEditor(existing = null) {
  const { favoriteHostRef } = await import('./hostactions.js');
  let host = existing?.host || null;

  const name = textInput({ value: existing?.name || '', placeholder: 'Database on the replica' });
  const kindSel = select([
    { value: 'L', label: 'Local  (-L)  — a port here reaches a remote service' },
    { value: 'R', label: 'Remote (-R)  — a port on the server reaches a local service' },
    { value: 'D', label: 'Dynamic (-D) — SOCKS5 proxy through the server' },
  ], existing?.kind || 'L');
  const bindPort = textInput({ type: 'number', value: String(existing?.bindPort || 8080), min: 1, max: 65535 });
  const bindAddr = textInput({ value: existing?.bindAddr || '', placeholder: 'localhost (default)' });
  const destHost = textInput({ value: existing?.destHost || 'localhost', placeholder: 'localhost' });
  const destPort = textInput({ type: 'number', value: String(existing?.destPort || 80), min: 1, max: 65535 });
  const login = textInput({ value: existing?.login || '', placeholder: 'whatever the host normally uses' });

  const hostLine = el('div', { class: 'hint' });
  const destBlock = el('div', { class: 'field-row' },
    field('Destination host', destHost),
    field('Destination port', destPort));
  const drawHost = () => {
    hostLine.textContent = host
      ? `${host.name}${host.cluster ? '  ·  ' + host.cluster : ''}`
      : 'No host chosen yet.';
  };
  const sync = () => destBlock.classList.toggle('hidden', kindSel.value === 'D');
  kindSel.addEventListener('change', sync);

  const pickBtn = el('button', {
    class: 'ghost-btn sm', text: 'Choose a host…',
    onClick: async () => {
      const { pickHost } = await import('./hostactions.js');
      const picked = await pickHost();
      if (picked) { host = favoriteHostRef(picked); drawHost(); }
    },
  });

  const res = await modal({
    title: existing ? 'Edit favourite' : 'New favourite tunnel',
    subtitle: 'Kept until you remove it; opens on the host below',
    render: (body) => {
      body.append(
        field('Name (optional)', name),
        el('div', { class: 'field' },
          el('label', { text: 'Host' }),
          el('div', { style: 'display:flex;gap:8px;align-items:center' }, pickBtn, hostLine)),
        field('Type', kindSel),
        el('div', { class: 'field-row' },
          field('Listen port', bindPort),
          field('Listen address (optional)', bindAddr)),
        destBlock,
        field('Connect as (optional)', login));
      drawHost();
      sync();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Save', class: 'primary-btn',
        onClick: ({ close }) => {
          if (!host) return toast('Choose a host for this tunnel', 'error');
          const port = parseInt(bindPort.value, 10);
          if (!port || port < 1 || port > 65535) return toast('Enter a valid listen port', 'error');
          if (kindSel.value !== 'D' && (!destHost.value.trim() || !parseInt(destPort.value, 10))) {
            return toast('A destination host and port are needed', 'error');
          }
          close({
            name: name.value.trim(),
            kind: kindSel.value,
            bindPort: port,
            bindAddr: bindAddr.value.trim(),
            destHost: destHost.value.trim(),
            destPort: parseInt(destPort.value, 10) || 0,
            host,
            login: login.value.trim() || null,
          });
        },
      },
    ],
  });
  if (!res) return;

  try {
    // Editing keeps the row it was; a new one upserts on host, port and type,
    // so saying the same thing twice does not leave two rows.
    if (existing) state.forwardFavorites = await window.api.forward.favoriteUpdate(existing.id, res);
    else state.forwardFavorites = await window.api.forward.favoriteAdd(res);
    renderForwards();
    status(res.name ? `Saved “${res.name}”` : 'Favourite saved');
  } catch (e) { toast(e.message, 'error'); }
}

async function renderForwards() {
  const panel = $('#dock-forwards');
  clear(panel);

  const all = [];
  for (const [connId, list] of state.forwards) {
    for (const f of list) all.push({ ...f, connId });
  }

  const favs = await loadForwardFavorites();

  const favHead = el('div', { class: 'sb-subhead' },
    el('span', { text: 'favourites' }),
    el('span', { class: 'sb-subhead-n', text: favs.length ? ` ${favs.length}` : '' }),
    el('span', { style: 'flex:1' }),
    el('button', {
      class: 'ghost-btn sm', text: '+ New…',
      title: 'Keep a tunnel shape without opening it now',
      onClick: () => openFavoriteEditor(),
    }));
  panel.append(favHead);

  if (!favs.length) {
    panel.append(el('div', { class: 'sb-empty', style: 'text-align:left' },
      el('div', { text: 'No favourites yet.' }),
      el('div', { style: 'margin-top:6px;opacity:.75',
        text: 'Star an open tunnel below, tick “Keep this as a favourite” when you create one, or add one here.' })));
  }

  for (const f of favs) {
    const openHere = [...state.forwards.entries()].some(([connId, list]) => list.some((x) => x.kind === f.kind
      && x.bindPort === f.bindPort && state.getConnection(connId)?.hostId === f.host?.id));
    panel.append(el('div', { class: 'xfer-row' },
      el('span', { class: 'tag', style: 'flex-shrink:0', text: { L: 'Local', R: 'Remote', D: 'Dynamic' }[f.kind] || f.kind }),
      el('div', { class: 'xlabel' },
        el('div', { class: 'main', text: f.name || describeFav(f) }),
        el('div', { class: 'sub', style: 'font-family:var(--mono);font-size:11px',
          text: (f.name ? describeFav(f) + '  ·  ' : '') + (f.host?.name || '')
            + (f.login ? '  as ' + f.login : '') })),
      openHere
        ? el('span', { class: 'tag', title: 'This tunnel is already up', text: 'open' })
        : el('button', {
            class: 'primary-btn sm', text: 'Open',
            onClick: async () => {
              const { openForwardFavorite } = await import('./hostactions.js');
              await openForwardFavorite(f);
            },
          }),
      el('button', {
        class: 'ghost-btn sm', text: 'Edit',
        onClick: () => openFavoriteEditor(f),
      }),
      el('button', {
        class: 'icon-btn sm', text: '×', title: 'Remove this favourite',
        onClick: async () => {
          state.forwardFavorites = await window.api.forward.favoriteRemove(f.id);
          renderForwards();
        },
      })));
  }

  panel.append(el('div', { class: 'sb-subhead', style: 'margin-top:10px' },
    el('span', { text: 'open now' }),
    el('span', { class: 'sb-subhead-n', text: all.length ? ` ${all.length}` : '' })));

  if (!all.length) {
    panel.append(el('div', { class: 'sb-empty', style: 'text-align:left' },
      el('div', { text: 'No tunnels open.' }),
      el('div', { style: 'margin-top:6px;opacity:.75', text: 'Right-click a host in the sidebar and choose “Port forward…”.' })));
    return;
  }

  for (const f of all) {
    const conn = state.getConnection(f.connId);
    const kindLabel = { L: 'Local', R: 'Remote', D: 'Dynamic' }[f.kind] || f.kind;
    panel.append(el('div', { class: 'xfer-row' },
      el('span', { class: 'tag', style: 'flex-shrink:0', text: kindLabel }),
      el('div', { class: 'xlabel' },
        el('div', { class: 'main', style: 'font-family:var(--mono);font-size:11.5px', text: describeForward(f) }),
        el('div', { class: 'sub', text: conn?.label || f.connLabel || '' })),
      /*
       * Star it from here: the moment you know a tunnel is worth keeping is
       * usually after it is up and something has actually connected through
       * it, not while typing the ports in.
       */
      el('button', {
        class: 'ghost-btn sm',
        text: favs.some((x) => x.kind === f.kind && x.bindPort === f.bindPort
          && x.host?.id === conn?.hostId) ? '\u2605' : '\u2606',
        title: 'Keep this as a favourite',
        onClick: async () => {
          const { saveForwardFavorite } = await import('./hostactions.js');
          const { hostById } = await import('./sidebar.js');
          const host = conn?.hostId ? hostById(conn.hostId) : null;
          if (!host) return toast('That host is no longer in the list, so there is nothing to reopen it on', 'error');
          try {
            await saveForwardFavorite(host, f, { login: conn?.login || null });
            status('Kept as a favourite');
            renderForwards();
          } catch (e) { toast(e.message, 'error'); }
        },
      }),
      f.kind !== 'R'
        ? el('button', {
            class: 'ghost-btn sm',
            text: 'Copy',
            title: 'Copy the local address',
            onClick: () => {
              const addr = `${f.bindAddr || 'localhost'}:${f.bindPort}`;
              window.api.clipboard.write(addr);
              status('Copied ' + addr);
            },
          })
        : null,
      el('button', {
        class: 'ghost-btn sm danger-btn',
        text: 'Close',
        onClick: async () => {
          try {
            await window.api.forward.remove(f.connId, f.id);
            status('Tunnel closed');
          } catch (e) { toast(e.message, 'error'); }
        },
      })));
  }
}

/* ------------------------------------------------------------------ */
/* Transfers                                                           */
/* ------------------------------------------------------------------ */

export function setTransfers(connId, jobs) {
  state.transfers.set(connId, jobs);
  state.emit('transfers', { connId, jobs });
}

function renderTransfers() {
  const panel = $('#dock-transfers');
  clear(panel);

  const rows = [];
  for (const [connId, jobs] of state.transfers) {
    const conn = state.getConnection(connId);
    for (const j of jobs) rows.push({ connId, conn, job: j });
  }
  rows.sort((a, b) => (b.job.startedAt || 0) - (a.job.startedAt || 0));

  if (!rows.length) {
    panel.append(el('div', { class: 'sb-empty', text: 'No transfers yet. Drag files onto the remote pane, or use the file browser context menu.' }));
    return;
  }

  /*
   * Queue-wide control, above the rows.
   *
   * Hold everything while a call is on, put it back afterwards, and cap the
   * speed so a big upload does not take the link with it. The limit is a
   * preference and applies to every connection, because what is being
   * protected is this machine's uplink rather than any one transfer.
   */
  const active = rows.filter(({ job }) => ['running', 'queued', 'paused'].includes(job.status));
  const paused = active.filter(({ job }) => job.status === 'paused');
  const limitKb = Number(state.settings.transferLimitKb) || 0;
  if (active.length) {
    const limitIn = el('input', {
      type: 'number', min: '0', step: '128', value: String(limitKb),
      class: 'xfer-limit', title: 'KB/s across every transfer; 0 for no limit',
    });
    const applyLimit = async () => {
      const kb = Math.max(0, parseInt(limitIn.value, 10) || 0);
      state.settings = { ...state.settings, transferLimitKb: await window.api.xfer.limit(kb) };
      status(kb ? `Transfers limited to ${kb} KB/s` : 'Transfer speed limit off');
    };
    limitIn.addEventListener('change', applyLimit);

    panel.append(el('div', { class: 'xfer-bar' },
      el('button', {
        class: 'ghost-btn sm',
        text: paused.length && paused.length === active.length ? 'Resume all' : 'Pause all',
        title: 'Hold every transfer between chunks; nothing is torn down, so resuming is instant',
        onClick: () => {
          const all = new Set(active.map((r) => r.connId));
          for (const connId of all) {
            (paused.length === active.length
              ? window.api.xfer.resumeAll(connId)
              : window.api.xfer.pauseAll(connId)).catch((e) => toast(e.message, 'error'));
          }
        },
      }),
      el('span', { style: 'flex:1' }),
      el('span', { class: 'sub', style: 'font-size:11px', text: 'Limit' }),
      limitIn,
      el('span', { class: 'sub', style: 'font-size:11px', text: 'KB/s' })));
  }

  for (const { connId, conn, job } of rows) {
    const pct = job.totalBytes ? Math.min(100, (job.doneBytes / job.totalBytes) * 100) : (job.status === 'done' ? 100 : 0);
    const meta = [];
    if (job.status === 'running') {
      meta.push(`${fmtBytes(job.doneBytes)} / ${fmtBytes(job.totalBytes)}`);
      if (job.rate) meta.push(fmtRate(job.rate));
      if (job.fileCount > 1) meta.push(`file ${job.fileIndex}/${job.fileCount}`);
      /*
       * The bytes are all accounted for but the transfer is not over: the
       * file is being flushed and closed, which on a large one takes long
       * enough that a bar frozen at 100% reads as a hang. Say what it is
       * waiting for instead.
       */
      if (job.phase) meta.push(job.phase);
    } else if (job.status === 'done') {
      meta.push(fmtBytes(job.totalBytes));
      if (job.endedAt && job.startedAt) meta.push(fmtDuration(job.endedAt - job.startedAt));
      // When, not just how long — a row that's finished and dropped off the
      // top of a busy list still answers "did that go through yet?" without
      // having to have been watching it happen.
      if (job.endedAt) meta.push(fmtDate(job.endedAt));
    } else if (job.status === 'planning') {
      meta.push('reading the file list…');
    } else if (job.error) {
      meta.push(job.error);
    }
    if (job.status === 'paused') meta.push('paused');
    if (job.resumed && job.status === 'running') meta.push('resumed');

    const row = el('div', { class: 'xfer-row ' + job.status },
      el('span', { text: job.kind === 'upload' ? '↑' : '↓', style: 'opacity:.7;width:12px' }),
      el('div', { class: 'xlabel' },
        el('div', { class: 'main', text: job.label }),
        el('div', { class: 'sub', text: [conn?.label, ...meta].filter(Boolean).join('  ·  ') })),
      el('div', { class: 'xbar' }, el('i', {
        class: job.status === 'running' && job.phase ? 'full' : '',
        style: `width:${pct}%`,
      })),
      el('div', {
        class: 'xpct' + (job.status === 'running' && job.phase ? ' waiting' : ''),
        text: job.status !== 'running' ? job.status
          : job.phase ? 'finishing' : pct.toFixed(0) + '%',
      }),
      // Pause and resume for anything still in flight; retry for anything
      // that stopped early, which picks up the partial file rather than
      // starting the whole thing again.
      // None of these awaited/caught their own promise before — a job
      // whose connection has since gone away (a long transfer can easily
      // outlive a reconnect, an idle timeout, anything that replaces or
      // drops the connection id it started on) made requireConn() throw in
      // the main process, and with nothing here to catch it, the click did
      // *nothing visible at all* rather than failing loudly. Every xfer
      // action below now surfaces that instead of swallowing it.
      ['running', 'queued', 'paused'].includes(job.status)
        ? el('button', {
            class: 'icon-btn sm', text: job.status === 'paused' ? '▶' : '❙❙',
            title: job.status === 'paused' ? 'Resume' : 'Pause',
            onClick: () => (job.status === 'paused'
              ? window.api.xfer.resumeJob(connId, job.id)
              : window.api.xfer.pause(connId, job.id)).catch((e) => toast(e.message, 'error')),
          })
        : null,
      job.status === 'queued'
        ? el('button', {
            class: 'icon-btn sm', text: '↑', title: 'Move earlier in the queue',
            onClick: () => window.api.xfer.move(connId, job.id, -1).catch((e) => toast(e.message, 'error')),
          })
        : null,
      job.status === 'queued'
        ? el('button', {
            class: 'icon-btn sm', text: '↓', title: 'Move later in the queue',
            onClick: () => window.api.xfer.move(connId, job.id, 1).catch((e) => toast(e.message, 'error')),
          })
        : null,
      // fileCount > 0 excludes a job cancelled (or failed) before planning
      // ever finished — retry() just re-queues whatever items a job
      // already has, and one that never got any would silently "run" as a
      // no-op zero-file transfer. Re-starting the upload/download itself
      // from the file browser is the correct way to retry that case.
      ['error', 'cancelled'].includes(job.status) && job.fileCount > 0
        ? el('button', {
            class: 'ghost-btn sm', text: 'Retry',
            title: 'Run it again, continuing any file that was part-way through',
            onClick: () => window.api.xfer.retry(connId, job.id).catch((e) => toast(e.message, 'error')),
          })
        : null,
      ['running', 'queued', 'paused', 'planning'].includes(job.status)
        ? el('button', {
            class: 'icon-btn sm', text: '×', title: 'Cancel',
            onClick: () => window.api.xfer.cancel(connId, job.id).catch((e) => toast(e.message, 'error')),
          })
        : el('span', { style: 'width:22px' }));
    panel.append(row);
  }
}

function updateForwardStatus() {
  let n = 0;
  for (const [, list] of state.forwards) n += list.length;
  const node = $('#status-forwards');
  if (node) node.textContent = n ? `${n} tunnel${n > 1 ? 's' : ''}` : '';
}

function updateXferStatus() {
  let running = 0, done = 0, bytes = 0, total = 0;
  for (const [, jobs] of state.transfers) {
    for (const j of jobs) {
      if (j.status === 'running') { running++; bytes += j.doneBytes; total += j.totalBytes; }
      else if (j.status === 'done') done++;
    }
  }
  const node = $('#status-xfer');
  if (running) {
    const pct = total ? Math.round((bytes / total) * 100) : 0;
    node.textContent = `${running} transfer${running > 1 ? 's' : ''} · ${pct}%`;
  } else {
    node.textContent = '';
  }
}

/* ------------------------------------------------------------------ */
/* Multi-exec                                                          */
/* ------------------------------------------------------------------ */

let lastCommand = '';
let lastRunAs = '';
/**
 * The hosts the last fan-out could not dial, and what it tried them as.
 *
 * Kept until the next run replaces it. A connection failure is the most
 * re-triable thing in a fan-out — an expired certificate, an MFA prompt that
 * timed out, a proxy that blinked — and before this it was a toast that took
 * the host out of the results with it.
 */
let lastFailed = null;
/** Which multi-exec input is showing: a typed command, or the macro list. */
let mxView = 'command';
let mxMacroFilter = '';

/**
 * Macros as multi-exec targets: the same commands the Saved tab runs on one
 * host, run across the whole selection. Grouped by category and filterable,
 * because the list is long enough that a flat dropdown would not do.
 */
/**
 * The runs made before, with the hosts each was made on.
 *
 * "The same thing again" is the most common multi-exec — after a fix, after a
 * deploy, an hour later — and the tedious part is never the command, it is
 * re-ticking eleven hosts. Each row can run itself again on the hosts it
 * named, or just put the command back in the box for editing.
 */
function renderExecHistory() {
  const wrap = el('div', { class: 'mx-history' });
  const rows = el('div', {});

  const draw = async () => {
    const list = await window.api.multiexec.history().catch(() => []);
    clear(rows);
    if (!list.length) {
      rows.append(el('div', { class: 'sb-empty', style: 'text-align:left' },
        el('div', { text: 'No runs yet.' }),
        el('div', { style: 'margin-top:6px;opacity:.75',
          text: 'Every multi-exec is remembered here with the hosts it ran on, so it can be run again.' })));
      return;
    }
    for (const run of list) {
      const hosts = run.hosts || [];
      rows.append(el('div', { class: 'xfer-row' },
        el('span', {
          class: 'tag',
          style: `flex-shrink:0;${run.failed ? 'color:var(--red)' : 'color:var(--green)'}`,
          text: run.failed ? `${run.ok}/${run.ok + run.failed}` : String(run.ok),
        }),
        el('div', { class: 'xlabel' },
          el('div', { class: 'main', style: 'font-family:var(--mono);font-size:11.5px', text: run.command }),
          el('div', { class: 'sub', text: [
            run.label || '',
            run.selector?.query ? `by tag: ${run.selector.query}` : `${hosts.length} host${hosts.length === 1 ? '' : 's'}`,
            run.runAs ? 'as ' + run.runAs : '',
            fmtDate(run.at),
          ].filter(Boolean).join('  ·  ') }),
          // The hosts it ran on, by name — the part of a run worth seeing at a
          // glance — as chips, every one of them in the tooltip.
          hosts.length && !run.selector?.query
            ? el('div', { class: 'mx-run-hosts', title: hosts.join('\n') },
              ...hosts.slice(0, 12).map((h) => el('span', { class: 'tag', text: h })),
              hosts.length > 12 ? el('span', { class: 'more', text: `+${hosts.length - 12} more` }) : null)
            : null),
        el('button', {
          class: 'primary-btn sm', text: 'Run again',
          title: 'Re-select those hosts and run the same command',
          onClick: () => rerunExec(run),
        }),
        el('button', {
          class: 'ghost-btn sm', text: 'Edit',
          title: 'Put the command and its hosts back, without running it',
          onClick: () => editExecRun(run),
        }),
        el('button', {
          class: 'icon-btn sm', text: '×', title: 'Forget this run',
          onClick: async () => { await window.api.multiexec.historyDelete(run.id); draw(); },
        })));
    }
  };

  wrap.append(
    el('div', { class: 'mx-macro-head' },
      el('span', { style: 'flex:1;font-size:11.5px;color:var(--muted)',
        text: 'A run is remembered by its command and the hosts it ran on, not its output.' }),
      el('button', {
        class: 'ghost-btn sm', text: 'Clear',
        onClick: async () => { await window.api.multiexec.historyClear(); draw(); },
      })),
    rows);
  draw();
  return wrap;
}

function renderMacroPicker(runAs) {
  const wrap = el('div', { class: 'mx-macros' });
  // A macro that follows a log never ends, and one meant to be edited first
  // cannot be edited on fifty hosts at once. Neither belongs in a fan-out —
  // and neither does one set to run only in the local shell, since every
  // target here is a server.
  const all = (state.macros || [])
    .filter((m) => !m.interactive && !m.noEnter)
    .filter((m) => macroRunsOn(m, 'remote'));

  const search = el('input', {
    class: 'mx-macro-search', placeholder: 'Filter macros…',
    value: mxMacroFilter, spellcheck: 'false',
  });
  search.addEventListener('input', () => {
    mxMacroFilter = search.value;
    renderList();
    // Re-rendering the whole dock would steal focus mid-keystroke.
  });

  const list = el('div', { class: 'mx-macro-list' });

  const renderList = () => {
    clear(list);
    const q = mxMacroFilter.trim().toLowerCase();
    const shown = q
      ? all.filter((m) => `${m.name} ${m.description || ''} ${m.command} ${m.category}`.toLowerCase().includes(q))
      : all;

    if (!shown.length) {
      list.append(el('div', { class: 'mx-macro-empty', text: q ? 'No macro matches.' : 'No macros defined.' }));
      return;
    }
    for (const m of shown) {
      const item = el('button', {
        class: 'mx-macro' + (m.confirm ? ' careful' : ''),
        title: `${m.description ? m.description + '\n\n' : ''}${m.command}`,
        onClick: () => runMacroMulti(m, runAs.value.trim() || null),
      },
        el('span', { class: 'mx-macro-cat', text: m.category }),
        el('span', { class: 'mx-macro-name', text: m.name }),
        m.confirm ? el('span', { class: 'tag mfa', text: 'careful' }) : null);
      list.append(item);
    }
  };

  renderList();
  wrap.append(
    el('div', { class: 'mx-macro-head' }, search, runAs),
    list,
    el('div', { class: 'mx-macro-hint', text: 'Runs on every selected host. Macros that follow a log, or that are meant to be edited first, are not listed.' }));
  return wrap;
}

async function runMacroMulti(macro, login) {
  // A macro with blanks is filled in once, here, and the same values go to
  // every host — which is the only reading of "this command, everywhere" that
  // makes sense.
  const { resolveMacro } = await import('./macros.js');
  const filled = await resolveMacro(macro);
  if (!filled) return;
  macro = filled;
  if (macro.confirm) {
    const { confirm } = await import('./ui.js');
    const targets = resolveTargets();
    if (!await confirm({
      title: macro.name,
      message: `Run on ${targets.length} host${targets.length === 1 ? '' : 's'}?`,
      detail: macro.command,
      confirmLabel: 'Run', danger: true,
    })) return;
  }
  lastCommand = macro.command;
  if (!macro.builtin) window.api.macros.markUsed(macro.id).catch(() => {});
  await runMulti(macro.command, login, { label: macro.name });
}

let redrawTargets = null;
let followingTicks = false;

/*
 * Staged multi-exec: a few hosts first, a look at what happened, then the
 * rest in batches — so a command that breaks things breaks one box, not
 * forty. Off for small runs, on by itself above STAGE_ABOVE hosts ("auto"),
 * and settable to always or never under Advanced. A loaded YAML that carries
 * stages uses them for this window without changing the saved preference.
 */
const STAGE_ABOVE = 10;
const STAGING_DEFAULT = { mode: 'auto', first: 1, batch: 5, pause: true, stopOnFail: true };
let stagingOverride = null;
let advOpen = false;

/*
 * Retrying a host that fails: how many more tries, and how far apart. Kept in
 * settings like the staging, and taken from a loaded file until changed.
 */
const RETRY_DEFAULT = { count: 0, delay: 10 };
let retryOverride = null;
function retrySetting() {
  return retryOverride || { ...RETRY_DEFAULT, ...(state.settings.mxRetry || {}) };
}
async function saveRetry(patch) {
  retryOverride = null;
  state.settings = await window.api.settings.set({ mxRetry: { ...retrySetting(), ...patch } });
}

function staging() {
  return { ...STAGING_DEFAULT, ...(state.settings.mxStaging || {}), ...(stagingOverride || {}) };
}

/** The stages option for a run on `n` hosts, or null when it runs all at once. */
export function stagesFor(n, st = staging()) {
  const on = st.mode === 'on' ? n > 1 : st.mode === 'auto' ? n > STAGE_ABOVE : false;
  return on ? { first: st.first, batch: st.batch, pause: st.pause, stopOnFail: st.stopOnFail } : null;
}

/** Stage sizes for `n` hosts — the same split the runner makes. */
export function stageSizes(n, { first = 1, batch = 5 } = {}) {
  const out = [];
  if (n <= 0) return out;
  const f = Math.max(1, Math.min(n, Math.floor(Number(first)) || 1));
  const b = Math.max(1, Math.floor(Number(batch)) || 5);
  out.push(f);
  for (let left = n - f; left > 0; left -= b) out.push(Math.min(b, left));
  return out;
}

/** "in 4 stages: 1, then 5 at a time — pausing after each" */
function stagePlanText(n) {
  const st = stagesFor(n);
  if (!st) return '';
  const sizes = stageSizes(n, st);
  return `Staged: ${sizes.length} stages — ${sizes[0]} first, then ${st.batch} at a time`
    + (st.pause ? ', pausing after each to look' : st.stopOnFail ? ', stopping at a stage with a failure' : '');
}

async function saveStaging(patch) {
  stagingOverride = null;
  const next = { ...staging(), ...patch };
  state.settings = await window.api.settings.set({ mxStaging: next });
}

/** The Advanced part of the form: how a run is staged. */
function renderAdvanced() {
  const st = staging();
  const mode = select([
    { value: 'auto', label: `Automatically above ${STAGE_ABOVE} hosts` },
    { value: 'on', label: 'Always' },
    { value: 'off', label: 'Never — every host at once' },
  ], st.mode);
  const num = (v, title) => el('input', { type: 'number', min: '1', value: String(v), title, class: 'mx-num' });
  const first = num(st.first, 'Hosts in the first stage');
  const batch = num(st.batch, 'Hosts in each stage after the first');
  const pause = checkbox('Pause after each stage, to look before going on', st.pause);
  const stop = checkbox('Stop at a stage that has a failure', st.stopOnFail);
  const save = () => saveStaging({
    mode: mode.value,
    first: Math.max(1, Number(first.value) || 1),
    batch: Math.max(1, Number(batch.value) || 5),
    pause: pause.input.checked, stopOnFail: stop.input.checked,
  }).then(() => redrawTargets?.());
  for (const n of [mode, first, batch, pause.input, stop.input]) n.addEventListener('change', save);
  const rt = retrySetting();
  const tries = el('input', { type: 'number', min: '0', max: '10', value: String(rt.count), title: 'More tries after a failure (0 for none)', class: 'mx-num' });
  const gap = el('input', { type: 'number', min: '0', max: '3600', value: String(rt.delay), title: 'Seconds between tries', class: 'mx-num' });
  const saveTries = () => saveRetry({
    count: Math.max(0, Math.min(10, Math.floor(Number(tries.value)) || 0)),
    delay: Math.max(0, Math.min(3600, Number(gap.value) || 0)),
  });
  tries.addEventListener('change', saveTries);
  gap.addEventListener('change', saveTries);
  const summary = ['staged rollout', 'retries'].join(', ')
    + (rt.count ? ` — ${rt.count} retr${rt.count === 1 ? 'y' : 'ies'} on` : '')
    + (stagingOverride || retryOverride ? ' (from the loaded file)' : '');
  const box = el('details', { class: 'mx-adv' },
    el('summary', { text: 'Advanced — ' + summary }),
    el('div', { class: 'mx-adv-row' },
      el('span', { text: 'Retry a host that fails' }), tries, el('span', { text: 'more time(s),' }), gap, el('span', { text: 'seconds apart' })),
    el('div', { class: 'mx-adv-row hint', text: 'A host that could not connect is dialled again too. Only how its last try ended counts — for a stage, and in the totals.' }),
    el('div', { class: 'mx-adv-row' }, el('span', { text: 'Run in stages' }), mode),
    el('div', { class: 'mx-adv-row' },
      el('span', { text: 'First stage' }), first, el('span', { text: 'host(s), then' }), batch, el('span', { text: 'at a time' })),
    el('div', { class: 'mx-adv-row' }, pause),
    el('div', { class: 'mx-adv-row' }, stop));
  box.open = advOpen;
  box.addEventListener('toggle', () => { advOpen = box.open; });
  return box;
}

function renderMultiExec() {
  const panel = $('#dock-multiexec');
  clear(panel);

  /*
   * The command: one line to start with, growing as lines are added — a
   * short script is as common a fan-out as a single command. Enter runs it,
   * as before; Shift+Enter adds a line. The lines go to each host's shell
   * together, as one script.
   */
  const input = el('textarea', {
    class: 'mx-command', rows: '1',
    placeholder: 'Command to run on all selected hosts…   Shift+Enter for another line',
    spellcheck: 'false',
  });
  input.value = lastCommand;
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight + 2, 240)}px`;
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); runMulti(input.value, runAs.value.trim() || null); }
  });
  input.addEventListener('input', () => { lastCommand = input.value; grow(); });
  requestAnimationFrame(grow);

  const runBtn = el('button', { class: 'primary-btn', text: 'Run', onClick: () => runMulti(input.value, runAs.value.trim() || null) });
  // Which account to run as. Teleport's ssh_config User is a cluster
  // principal, not necessarily a valid account on each node, so naming one
  // here is often the difference between working and "access denied".
  const runAs = el('input', {
    class: 'mx-runas', placeholder: 'run as…', title: 'Login to use on every selected host',
    value: lastRunAs, spellcheck: 'false', list: 'mx-logins',
  });
  runAs.addEventListener('input', () => { lastRunAs = runAs.value; });
  const loginList = el('datalist', { id: 'mx-logins' });
  for (const l of knownLogins()) loginList.append(el('option', { value: l }));

  const saveBtn = el('button', {
    class: 'ghost-btn', text: 'Save YAML…',
    title: 'Save this command and host selection as a reusable run',
    onClick: () => saveRunYaml(input.value),
  });
  const loadBtn = el('button', {
    class: 'ghost-btn', text: 'Load YAML…',
    title: 'Open a saved run',
    onClick: () => loadRunYaml(input),
  });
  const scheduleBtn = el('button', {
    class: 'ghost-btn', text: 'Schedule…',
    title: 'Run this at a date and time, once or repeating',
    onClick: () => openScheduleDialog(null, { command: input.value, runAs: runAs.value.trim() }),
  });
  const ansibleBtn = el('button', {
    class: 'ghost-btn', text: 'Ansible…',
    title: 'Turn this command and host selection into a playbook',
    onClick: () => exportAnsible(input.value),
  });
  /*
   * Two ways to say what to run: type it, or pick a macro. They share the
   * "run as" login and the host selection, so the tabs swap only the part
   * that differs rather than duplicating the whole form.
   */
  /*
   * The one *run as* field goes in whichever form is showing. Building the
   * macro list every time took it into the macros' header even with the
   * Command tab open — an element is in one place at a time — so the
   * Command tab had no run-as field at all.
   */
  const macroForm = mxView === 'macros' ? renderMacroPicker(runAs) : null;
  const commandForm = mxView === 'macros' ? null
    : el('div', { class: 'mx-form' }, input, runAs, runBtn, scheduleBtn, saveBtn, loadBtn, ansibleBtn);

  const tabs = el('div', { class: 'mx-tabs' },
    ...[['command', 'Command'], ['macros', 'Macros'], ['history', 'Recent runs'],
      ['scheduled', `Scheduled${schedules().length ? ` (${schedules().length})` : ''}`]].map(([id, label]) => el('button', {
      class: 'mx-tab' + (mxView === id ? ' active' : ''),
      text: label,
      onClick: () => { mxView = id; renderMultiExec(); },
    })));

  // The logins offered as you type in *run as*, for both forms that have it.
  panel.append(loginList, tabs,
    mxView === 'macros' ? macroForm : mxView === 'history' ? renderExecHistory()
      : mxView === 'scheduled' ? renderSchedules() : commandForm);

  /*
   * How the targets are chosen: the ticks in the sidebar, or a cluster and a
   * tag query resolved at run time. The second is what "every prod web node"
   * means, and it does not go stale when a node is added.
   */
  const selOn = checkbox('Choose by tag instead of ticking hosts', tagSelector.on);
  const clusterSel = select([
    { value: '', label: 'Every logged-in cluster' },
    ...(state.teleportProfiles || []).filter((p) => !p.expired)
      .map((p) => ({ value: p.proxy, label: p.cluster || p.proxy })),
  ], tagSelector.proxy);
  const queryIn = el('input', {
    class: 'mx-query', placeholder: 'env=prod role:web  —  the same syntax as the host filter',
    value: tagSelector.query, spellcheck: 'false',
  });
  const selRow = el('div', { class: 'mx-selector' + (tagSelector.on ? '' : ' off') },
    clusterSel, queryIn,
    el('button', {
      class: 'ghost-btn sm', text: 'Tags…',
      title: 'Browse the labels in the inventory',
      onClick: async () => {
        const { openTagBrowser } = await import('./tagbrowser.js');
        openTagBrowser({
          getFilter: () => queryIn.value,
          setFilter: (term) => {
            queryIn.value = term === null ? '' : `${queryIn.value} ${term}`.trim();
            tagSelector.query = queryIn.value;
            renderMultiExec();
          },
        });
      },
    }));
  const applySel = () => {
    mxExcluded.clear();
    tagSelector = {
      on: selOn.input.checked,
      proxy: clusterSel.value,
      query: queryIn.value,
    };
    renderMultiExec();
  };
  selOn.input.addEventListener('change', applySel);
  clusterSel.addEventListener('change', applySel);
  queryIn.addEventListener('change', applySel);
  queryIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applySel(); } });

  panel.append(el('div', { class: 'mx-selector-wrap' }, selOn, selRow));

  /*
   * Each target with the account it will be reached as.
   *
   * A fan-out that runs as the wrong user fails on every host at once, and
   * until now the only way to find out was to read twenty "permission denied"
   * lines. The name in brackets is the same one the runner will use.
   */
  const targetsEl = el('div', { class: 'mx-targets' });
  const planEl = el('div', { class: 'mx-plan hidden' });
  /*
   * Redrawn as the *run as* field is typed in, rather than on a full render,
   * which would take the focus out of the field mid-word.
   */
  const drawTargets = () => {
    // Read afresh each time: the ticks change while this form is open.
    const targets = resolveTargets();
    const who = runAs.value.trim() || null;
    clear(targetsEl);
    const removed = excludedCount();
    const head = el('div', { class: 'mx-targets-head' },
      el('span', {
        text: tagSelector.on
          ? (targets.length ? `Matches now: ${targets.length} host${targets.length === 1 ? '' : 's'}`
            : 'Nothing matches that query yet. It is resolved again every time you run, so this can be written before the hosts exist.')
          : (targets.length
            // With nothing ticked the run goes to the open sessions, which is
            // easy to forget once the ticks are gone — so it says so.
            ? `${targets.length} target${targets.length === 1 ? '' : 's'}${state.checkedHosts.size ? '' : ' — the open sessions, as nothing is ticked'}`
            : 'No hosts selected. Tick hosts in the sidebar, or open sessions — open sessions are used when nothing is ticked.'),
      }),
      removed ? el('button', {
        class: 'linkish', text: `${removed} left out — put back`,
        onClick: () => { mxExcluded.clear(); drawTargets(); },
      }) : null);
    targetsEl.append(head);
    if (!targets.length) return finishTargets(targets);
    /*
     * One row a host: its name, who it runs as, its cluster and its tags —
     * the things that tell two web-03s apart — and a way to leave it out of
     * this run. A ticked host is unticked; one matched by a tag query or an
     * open session is set aside until put back.
     */
    const list = el('div', { class: 'mx-target-list' + (targets.length > 8 ? ' many' : '') });
    for (const t of targets) {
      const host = t.host || findHostById(t.hostId);
      const as = loginForTarget(t, who);
      const tags = host ? labelEntries(host).slice(0, 6) : [];
      const extra = host ? labelEntries(host).length - tags.length : 0;
      list.append(el('div', { class: 'mx-target' },
        el('button', {
          class: 'x', text: '\u00d7', title: `Leave ${t.label} out of this run`,
          onClick: () => {
            if (!tagSelector.on && t.hostId && state.checkedHosts.has(t.hostId)) {
              state.checkedHosts.delete(t.hostId);
              state.emit('checked');
              import('./sidebar.js').then((m) => m.renderSidebar()).catch(() => {});
            } else {
              mxExcluded.add(targetKey(t));
            }
            drawTargets();
          },
        }),
        el('span', { class: 'n', text: t.label }),
        as && !String(t.label).endsWith(`(${as})`) ? el('span', { class: 'as', text: as }) : null,
        host?.cluster ? el('span', { class: 'cl', text: host.cluster }) : null,
        el('span', { class: 'tags' },
          ...tags.map(([k, v]) => el('span', { class: 'tag', text: v ? `${k}=${v}` : k })),
          extra > 0 ? el('span', { class: 'tag more', text: `+${extra}`, title: labelEntries(host).slice(6).map(([k, v]) => `${k}=${v}`).join('\n') }) : null)));
    }
    targetsEl.append(list);
    finishTargets(targets);
  };
  const finishTargets = (targets) => {
    const plan = stagePlanText(targets.length);
    planEl.textContent = plan;
    planEl.classList.toggle('hidden', !plan);
  };
  drawTargets();
  runAs.addEventListener('input', drawTargets);
  panel.append(targetsEl, planEl, renderAdvanced());
  /*
   * Ticking a host in the sidebar while the command is being written — the
   * usual order — used to leave this line saying "No hosts selected", because
   * nothing here heard the tick. The line alone is redrawn, so the command
   * field keeps its focus and its cursor.
   */
  redrawTargets = drawTargets;
  if (!followingTicks) {
    followingTicks = true;
    state.on('checked', () => redrawTargets?.());
  }

  /*
   * The hosts that never answered, with the way back.
   *
   * Above the results rather than below, because a run that reached eighteen
   * of twenty is read as a success otherwise — the two that failed are not in
   * the list at all, so nothing on screen contradicts it.
   */
  if (lastFailed?.hosts?.length) {
    const f = lastFailed;
    const box = el('div', { class: 'mx-failed' },
      el('div', { class: 'mx-failed-head' },
        el('span', { class: 'n', text: String(f.hosts.length) }),
        el('span', {
          text: `host${f.hosts.length === 1 ? '' : 's'} could not be connected`
            + (f.runAs ? ` as ${f.runAs}` : ''),
        }),
        el('span', { style: 'flex:1' }),
        el('button', {
          class: 'primary-btn sm', text: 'Retry these',
          title: 'Dial them again and run the same command — only on these hosts',
          onClick: () => retryFailedExec(),
        }),
        el('button', {
          class: 'ghost-btn sm', text: 'Dismiss',
          onClick: () => { lastFailed = null; renderMultiExec(); },
        })));
    for (const h of f.hosts) {
      box.append(el('div', { class: 'mx-failed-row' },
        el('span', { class: 'h', text: h.target.label + (h.login ? ` (${h.login})` : '') }),
        el('span', { class: 'e', text: h.error })));
    }
    panel.append(box);
  }

  for (const run of state.multiRuns) {
    panel.append(renderRun(run));
  }
}

function renderRun(run) {
  const wrap = el('div', { style: 'margin-bottom:14px' });
  const okCount = run.results.filter((r) => r.status === 'done').length;
  const failCount = run.results.filter((r) => ['error', 'timeout'].includes(r.status)).length;

  wrap.append(el('div', {
    style: 'display:flex;align-items:center;gap:9px;margin-bottom:7px;font-size:11.5px;color:var(--muted)',
  },
    el('code', { style: 'color:var(--text);font-size:11.5px', text: run.command }),
    el('span', { class: 'spacer', style: 'flex:1' }),
    run.staged ? el('span', {
      class: 'mx-stage',
      text: run.running ? `stage ${run.staged.index + 1} of ${run.staged.sizes.length}` : `${run.staged.sizes.length} stages`,
    }) : null,
    el('span', { text: `${okCount} ok · ${failCount} failed · ${run.results.length} total` }),
    run.running
      ? el('button', { class: 'ghost-btn sm', text: 'Cancel', onClick: () => window.api.multiexec.cancel(run.id) })
      : el('button', {
          class: 'ghost-btn sm', text: 'Save results…',
          title: 'Write these results to a YAML file',
          onClick: async () => {
            try {
              const r = await window.api.mxfile.saveResults(run, { includeOutput: true });
              if (r) { status('Results saved: ' + r.path); toast('Results saved', 'success'); }
            } catch (e) { toast(e.message, 'error'); }
          },
        })));

  /*
   * A staged run waiting between stages: what the stage did, and the three
   * ways on. Above the results, since it is the thing to answer.
   */
  const pz = run.staged?.paused;
  if (run.running && pz) {
    const nextN = run.staged.sizes[run.staged.index + 1] || 0;
    const left = run.staged.sizes.slice(run.staged.index + 1).reduce((a, b) => a + b, 0);
    const decide = (c) => window.api.multiexec.decide(run.id, c);
    wrap.append(el('div', { class: 'mx-paused' + (pz.reason === 'failed' ? ' failed' : '') },
      el('span', {
        class: 'mx-paused-text',
        text: (pz.reason === 'failed'
          ? `Stage ${run.staged.index + 1} had ${pz.failed} failure${pz.failed === 1 ? '' : 's'} — stopped before going wider.`
          : `Stage ${run.staged.index + 1} of ${run.staged.sizes.length} done: ${pz.ok} ok.`)
          + ` ${left} host${left === 1 ? '' : 's'} still to go.`,
      }),
      el('button', { class: 'primary-btn sm', text: `Next stage (${nextN})`, onClick: () => decide('next') }),
      el('button', { class: 'ghost-btn sm', text: `All the rest (${left})`, title: 'No more pauses', onClick: () => decide('all') }),
      el('button', { class: 'ghost-btn sm', text: 'Stop here', onClick: () => decide('stop') })));
  }

  for (const r of run.results) {
    const card = el('div', { class: 'mx-result' + (r.status === 'done' && !r.stderr ? ' collapsed' : '') });
    const head = el('div', { class: 'mx-rhead' },
      el('span', { class: 'st ' + r.status }),
      el('span', { class: 'mxname', text: r.label }),
      el('span', { class: 'mxmeta', text: [
        // Who it ran as, first — a wall of "permission denied" is read very
        // differently once you can see which account produced it.
        state.getConnection(r.connId)?.login || '',
        r.stage ? `stage ${r.stage}` : '',
        r.status === 'retrying'
          ? `failed — try ${r.attempt + 1} of ${r.attempts}${r.retryAt ? ' at ' + new Date(r.retryAt).toLocaleTimeString() : ''}`
          : r.status,
        r.attempt > 1 ? `on try ${r.attempt} of ${r.attempts}` : '',
        r.exitCode !== null && r.exitCode !== undefined ? 'exit ' + r.exitCode : '',
        r.durationMs !== null ? fmtDuration(r.durationMs) : '',
      ].filter(Boolean).join('  ·  ') }));
    head.addEventListener('click', () => card.classList.toggle('collapsed'));

    const body = el('div', { class: 'mx-rbody' });
    // Waiting on this one host — per-session MFA, which has no pty on a
    // plain spawn to prompt on. Answering it does not block the others:
    // each host in a run is its own worker (see _spawnInteractive).
    if (r.status === 'prompting') {
      const input = el('input', {
        type: 'password', placeholder: 'MFA code, or press Enter after tapping your key',
      });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        window.api.multiexec.answer(run.id, r.connId, input.value + '\n');
        input.value = '';
      });
      body.append(el('div', { class: 'mx-prompt' },
        el('span', { class: 'hint', text: r.promptText || 'Waiting for a response…' }), input));
    }
    // What the earlier tries said, before this one's output.
    for (const [i, t] of (r.tries || []).entries()) {
      body.append(el('span', { class: 'mx-try', text: `try ${i + 1}: ${t.status}${t.exitCode !== null && t.exitCode !== undefined ? ' · exit ' + t.exitCode : ''}${t.error ? ' — ' + t.error : ''}\n` }));
    }
    if (r.stdout) body.append(el('span', { text: r.stdout }));
    if (r.stderr) body.append(el('span', { class: 'stderr', text: r.stderr }));
    if (!r.stdout && !r.stderr) body.append(el('span', { style: 'opacity:.5', text: '(no output)' }));

    card.append(head, body);
    wrap.append(card);
  }
  return wrap;
}

/** Selected sidebar hosts take priority; otherwise every open session. */
/**
 * A target set expressed as a question rather than a list: a cluster and a tag
 * query, resolved when the command runs.
 *
 * "Every prod web node" is the instruction people actually have, and a ticked
 * list of eleven hosts goes stale the moment one is added. Kept in the dock's
 * own state and saved with a run, so a YAML saved today runs against whatever
 * matches next month.
 */
let tagSelector = { on: false, proxy: '', query: '' };

export function multiExecSelector() {
  return { ...tagSelector };
}

/** The hosts a tag selector matches right now. */
function hostsForSelector(sel = tagSelector) {
  if (!sel.on) return [];
  const q = compileQuery(sel.query || '');
  const out = [];
  for (const p of state.teleportProfiles || []) {
    if (sel.proxy && p.proxy !== sel.proxy) continue;
    const nodes = state.teleportNodes.get(tpKey(p)) || [];
    for (const n of nodes) {
      if (!q.match(n)) continue;
      if (state.hiddenHosts?.has(n.id) && !state.settings.showHiddenHosts) continue;
      out.push(n);
    }
  }
  // An ssh_config host has no labels, so a tag query cannot name one; when the
  // query is empty and no cluster is chosen this would otherwise be "every
  // host in the window", which is not something to run a command on by
  // accident.
  return sel.query.trim() || sel.proxy ? out : [];
}

/**
 * The account a target will be reached as.
 *
 * One function, because this used to be worked out inline at the moment a
 * connection was created and was therefore impossible to show anywhere — a
 * fan-out to twenty hosts gave no indication of who it was about to be until
 * the output came back saying "permission denied" as somebody. The same
 * order the connection code used: an explicit *run as* wins, then whatever
 * last worked for this host, then the cluster's first login or the config's
 * user.
 */
export function loginForTarget(t, runAsLogin = null) {
  if (runAsLogin) return runAsLogin;
  const host = t.host || findHostById(t.hostId);
  if (!host) {
    // Nothing but a live session to go on: it already knows who it is.
    return t.connId ? (state.getConnection(t.connId)?.login || null) : null;
  }
  return (state.settings.hostLogins || {})[host.id]
    || (host.type === 'teleport'
      ? (state.teleportProfiles.find((p) => p.cluster === host.cluster)?.logins || [])[0]
      : host.user)
    || null;
}

/*
 * Targets left out of the next run by hand, from the list under the
 * command: a host matched by a tag query, or an open session, that should
 * sit this one out. (A ticked host is simply unticked instead.) Cleared by
 * "put back", and when the way targets are chosen changes.
 */
const mxExcluded = new Set();
function targetKey(t) { return t.hostId ? `h:${t.hostId}` : `c:${t.connId}`; }
function excludedCount() { return mxExcluded.size; }

function resolveTargets() {
  return resolveAllTargets().filter((t) => !mxExcluded.has(targetKey(t)));
}

function resolveAllTargets() {
  const out = [];
  /*
   * A tag selector, when it is on, replaces the ticked list: the two would
   * otherwise silently add up, and the point of the selector is that it — not
   * a stale set of ticks — decides.
   */
  if (tagSelector.on) {
    for (const host of hostsForSelector()) {
      const conn = [...state.connections.values()].find((c) => c.hostId === host.id);
      out.push({ hostId: host.id, host, connId: conn?.id || null, label: host.name || host.alias });
    }
    return out;
  }
  if (state.checkedHosts.size) {
    for (const hostId of state.checkedHosts) {
      const conn = [...state.connections.values()].find((c) => c.hostId === hostId);
      const host = findHostById(hostId);
      if (!host) continue;
      out.push({ hostId, host, connId: conn?.id || null, label: host.name || host.alias });
    }
    return out;
  }
  for (const c of state.connections.values()) {
    if (c.state === 'connected') out.push({ connId: c.id, label: c.label, hostId: c.hostId });
  }
  return out;
}

function findHostById(id) {
  for (const nodes of state.teleportNodes.values()) {
    const n = nodes.find((x) => x.id === id);
    if (n) return n;
  }
  return state.sshHosts.find((h) => h.id === id) || null;
}

/** Every login the logged-in clusters grant, for the run-as suggestions. */
function knownLogins() {
  const out = new Set();
  for (const p of state.teleportProfiles || []) for (const l of p.logins || []) out.add(l);
  for (const h of state.sshHosts || []) if (h.user) out.add(h.user);
  return [...out].sort();
}

export async function runMulti(command, runAsLogin = null, {
  label, only = null, scheduled = false, staging: fixedStaging = null, retry: fixedRetry = null, selector: fixedSelector,
} = {}) {
  const cmd = (command || '').trim();
  if (!cmd) return toast('Enter a command', 'error');

  // `only` is a retry over the hosts that failed last time, which must not be
  // re-derived from the selection: ticks and tag queries move on.
  const targets = only && only.length ? only : resolveTargets();
  if (!targets.length) return toast('Select hosts in the sidebar first', 'error');

  /** Hosts that could not be dialled, held for the retry offer below. */
  const failed = [];

  /*
   * A host marked careful gets a second look before a command fans out to it.
   * Marked by hand, on the host's own menu, for the boxes where "run this
   * everywhere" is how an outage starts.
   */
  const { isCareful } = await import('./sidebar.js');
  const careful = targets
    .map((t) => t.host || findHostById(t.hostId))
    .filter((h) => h && isCareful(h));
  // A scheduled run was confirmed when it was scheduled; nobody is here now.
  if (careful.length && !scheduled) {
    const { confirm } = await import('./ui.js');
    if (!await confirm({
      title: 'Run on a host marked careful?',
      message: `${careful.map((h) => h.name || h.alias).join(', ')} ${careful.length === 1 ? 'is' : 'are'} marked careful.`,
      detail: `The command is:\n\n${cmd}\n\nIt would run on ${targets.length} host${targets.length === 1 ? '' : 's'}.`,
      confirmLabel: 'Run it',
      danger: true,
    })) return;
  }

  // A scheduled run leaves the form, and whatever is on screen, alone.
  if (!scheduled) {
    lastCommand = cmd;
    lastRunAs = runAsLogin || '';
    openDock('multiexec');
  }
  status(`${label ? label + ' — running' : 'Running'} on ${targets.length} host(s)${runAsLogin ? ' as ' + runAsLogin : ''}…`, scheduled ? 6000 : 0);

  // Hosts without a live connection need one created first.
  const connIds = [];
  for (const t of targets) {
    if (t.connId) {
      const existing = state.getConnection(t.connId);
      // Reusing a session opened as someone else would silently ignore "run as".
      if (!runAsLogin || existing?.login === runAsLogin) { connIds.push(t.connId); continue; }
      t.host = t.host || findHostById(t.hostId);
      if (!t.host) { connIds.push(t.connId); continue; }
    }
    try {
      const payload = t.host.type === 'teleport'
        ? {
            type: 'teleport', name: t.host.name, hostname: t.host.hostname, uuid: t.host.uuid,
            cluster: t.host.cluster, proxy: t.host.proxy, home: t.host.home || null,
            ambiguous: !!t.host.ambiguous,
          }
        : { type: 'ssh', alias: t.host.alias, configFile: t.host.configFile || null, id: t.host.id };
      // Explicit "run as" wins; otherwise reuse whatever worked for this host.
      const login = loginForTarget(t, runAsLogin);
      const created = await window.api.conn.create(payload, { login });
      state.setConnection(created.id, {
        id: created.id, label: created.label, target: created.target,
        type: created.type, state: 'idle', hostId: t.host.id, login,
      });
      connIds.push(created.id);
    } catch (e) {
      /*
       * A host that could not be dialled is kept, not just announced.
       *
       * This was a toast and nothing else, so the host simply did not appear
       * in the results — a fan-out to twenty boxes reported eighteen and said
       * nothing about the other two once the toast had gone. A connection
       * failure is also the most re-triable thing here: an expired
       * certificate, an MFA prompt that timed out, a proxy that blinked. So
       * the failures are held with what they were tried as, and offered back
       * as a retry over just those hosts.
       */
      failed.push({ target: t, login: loginForTarget(t, runAsLogin), error: e.message });
    }
  }

  /*
   * What is offered as a retry, and what it would be retried as. Set before
   * the run so the panel can show it even if the run itself throws.
   */
  lastFailed = failed.length
    ? { command: cmd, runAs: runAsLogin || null, label: label || '', hosts: failed }
    : null;

  if (!connIds.length) {
    renderMultiExec();
    status('');
    if (scheduled) return { runId: null, unreachable: failed.length, error: failed[0]?.error || 'Nothing to run on' };
    return toast(failed.length
      ? `None of the ${failed.length} host(s) could be connected`
      : 'Nothing to run on', 'error');
  }

  try {
    // A scheduled run has its own staging, which never pauses: nobody is there to go on.
    const stages = fixedStaging ? stagesFor(connIds.length, { ...fixedStaging, pause: false }) : stagesFor(connIds.length);
    const rt = fixedRetry || retrySetting();
    const view = await window.api.multiexec.run(connIds, cmd, {
      concurrency: 10, timeout: 120000, stages, retries: rt.count, retryDelay: rt.delay,
    });
    upsertRun(view);
    /*
     * Keep the question, not the answers.
     *
     * "Run that again" is the common follow-up — after a fix, after a deploy,
     * an hour later — and rebuilding the host selection by hand is the tedious
     * part. The results are not stored: they are long, and they are stale
     * almost immediately.
     */
    rememberRun(view, {
      command: cmd,
      label: label || '',
      runAs: runAsLogin || null,
      hosts: targets.map((t) => t.label),
      hostIds: targets.map((t) => t.hostId).filter(Boolean),
      // A tag run is remembered as its query: running it again should ask the
      // same question, not repeat the answer it got last time.
      selector: fixedSelector !== undefined ? fixedSelector
        : tagSelector.on ? { proxy: tagSelector.proxy, query: tagSelector.query } : null,
      // Hosts that never connected are not in the run's results, but count.
      unreachable: failed.length,
      retries: rt.count || 0,
      scheduled: scheduled || undefined,
    });
    return { runId: view.id, unreachable: failed.length };
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    renderMultiExec();
    if (!scheduled) status('');
  }
  return null;
}

/** Dial the hosts that failed last time, and run the same command on them. */
export async function retryFailedExec() {
  if (!lastFailed?.hosts?.length) return;
  const { command, runAs, label, hosts } = lastFailed;
  return runMulti(command, runAs, { label, only: hosts.map((f) => f.target) });
}

/**
 * Run a remembered run again, on the hosts it named.
 *
 * The selection is rebuilt from host ids rather than names, so a renamed
 * Teleport node still matches. A host that has genuinely gone — logged out of,
 * deleted from the config — is reported rather than silently skipped, because
 * "it ran on four of six" is a different result from "it ran".
 */
/** A remembered run's hosts, split into the ones still listed and the rest. */
function runHosts(run) {
  const missing = [];
  const found = [];
  for (const id of run.hostIds || []) {
    const h = findHostById(id);
    h ? found.push(h) : missing.push(id);
  }
  return { found, missing };
}

/** Tick exactly these hosts, as the sidebar would. */
async function tickHosts(hosts) {
  tagSelector = { on: false, proxy: '', query: '' };
  state.checkedHosts.clear();
  for (const h of hosts) state.checkedHosts.add(h.id);
  state.emit('checked');
  const { renderSidebar } = await import('./sidebar.js');
  renderSidebar();
}

/**
 * Put a remembered run back in the form — command, login and its hosts —
 * without running it. The hosts are the half people forgot: Edit used to
 * restore only the command, so the run went wherever the ticks happened to be.
 */
export async function editExecRun(run) {
  lastCommand = run.command;
  lastRunAs = run.runAs || '';
  mxView = 'command';
  if (run.selector?.query !== undefined && run.selector?.query !== null) {
    tagSelector = { on: true, proxy: run.selector.proxy || '', query: run.selector.query || '' };
    state.checkedHosts.clear();
    state.emit('checked');
    renderMultiExec();
    return status(`Editing — hosts chosen by tag: ${run.selector.query}`);
  }
  const { found, missing } = runHosts(run);
  await tickHosts(found);
  renderMultiExec();
  if (missing.length) {
    toast(`${found.length} of ${(run.hostIds || []).length} hosts re-selected — `
      + `${missing.length} are no longer in the list`, 'error', 7000);
  } else {
    status(`Editing — ${found.length} host${found.length === 1 ? '' : 's'} re-selected`);
  }
}

/*
 * A run is written to Recent runs when it has finished, not when it starts.
 *
 * `multiexec.run` answers as soon as the run is under way, with every host
 * still pending — and the history used to be written from that answer, so a
 * run that succeeded everywhere was remembered as 0 of N. The record waits
 * here for the run's `done`; whichever of the two arrives second writes it,
 * since a run whose hosts all failed to connect can be done before its start
 * has been answered.
 */
const waitingRuns = new Map();     // runId -> history record without counts
const finishedRuns = new Map();    // runId -> final view, if done came first

function rememberRun(view, rec) {
  const done = finishedRuns.get(view.id) || (view.endedAt ? view : null);
  finishedRuns.delete(view.id);
  if (done) writeRunHistory(done, rec);
  else waitingRuns.set(view.id, rec);
}

/** Called with the final view when a run finishes (index.js). */
export function finishRunHistory(view) {
  scheduledRunDone(view);
  const rec = waitingRuns.get(view.id);
  if (!rec) { finishedRuns.set(view.id, view); return; }
  waitingRuns.delete(view.id);
  writeRunHistory(view, rec);
}

function writeRunHistory(view, rec) {
  const results = view.results || [];
  const ok = results.filter((r) => r.status === 'done').length;
  const { unreachable = 0, ...row } = rec;
  window.api.multiexec.historyAdd({
    ...row,
    ok,
    // The ones that never connected count as failures too — "it ran on four
    // of six" is the honest number, not "four of four".
    failed: (results.length - ok) + unreachable,
  }).then(() => renderMultiExec()).catch(() => {});
}

export async function rerunExec(run) {
  // A remembered tag run re-asks its question rather than repeating its answer.
  if (run.selector?.query !== undefined && run.selector?.query !== null) {
    tagSelector = { on: true, proxy: run.selector.proxy || '', query: run.selector.query || '' };
    state.checkedHosts.clear();
    state.emit('checked');
    mxView = 'command';
    renderMultiExec();
    const n = resolveTargets().length;
    if (!n) return toast('Nothing matches that query now', 'error');
    return runMulti(run.command, run.runAs || null, { label: run.label || undefined });
  }

  const { found, missing } = runHosts(run);
  if (!found.length) {
    return toast('None of those hosts are in the list any more', 'error');
  }
  if (missing.length) {
    const { confirm } = await import('./ui.js');
    if (!await confirm({
      title: 'Some hosts are missing',
      message: `${found.length} of ${(run.hostIds || []).length} hosts are still in the list.`,
      detail: 'The missing ones may have been logged out of, hidden or removed from the config. '
        + 'Running now would run on the ones that are left.',
      confirmLabel: `Run on ${found.length}`,
    })) return;
  }
  // The selection is what runMulti reads, so it is set rather than passed.
  await tickHosts(found);
  await runMulti(run.command, run.runAs || null, { label: run.label || undefined });
}

/** Turn the current command + host selection into an Ansible bundle on disk. */
async function exportAnsible(command) {
  const cmd = (command || '').trim();
  if (!cmd) return toast('Enter a command to export', 'error');

  const targets = resolveTargets();
  if (!targets.length) return toast('Select hosts in the sidebar first', 'error');

  const payload = targets.map((t) => {
    const host = t.host || findHostById(t.hostId);
    const conn = t.connId ? state.getConnection(t.connId) : null;
    if (host?.type === 'teleport') {
      return {
        type: 'teleport', name: host.name, cluster: host.cluster, proxy: host.proxy,
        home: host.home || null,
        login: conn?.login || (state.teleportProfiles.find((p) => p.cluster === host.cluster)?.logins || [])[0],
      };
    }
    return {
      type: 'ssh',
      name: host?.alias || t.label,
      alias: host?.alias || t.label,
      user: conn?.login || host?.user,
      port: host?.port,
    };
  });

  /*
   * The folder's name first, before the folder picker: every export used to
   * be called serverlife-ansible, so the second one quietly replaced the
   * first. The suggestion is the command's first word — ansible-df — which
   * is usually what someone would have typed anyway.
   */
  const suggested = await window.api.ansible.suggestName(cmd).catch(() => 'serverlife-ansible');
  const folderName = await prompt({
    title: 'Name the export',
    label: 'Folder name \u2014 you choose where it goes next',
    value: suggested,
    confirmLabel: 'Choose where\u2026',
    validate: (v) => (v ? null : 'Give the folder a name'),
  });
  if (!folderName) return;

  /*
   * A tag run exports the hosts it matches *now* — an inventory is a list of
   * machines, so the question has to be answered before it is written. The
   * play's name says which query produced it.
   */
  const playName = tagSelector.on && tagSelector.query
    ? `Run on ${tagSelector.query}: ${cmd.split('\n')[0].slice(0, 40)}`
    : `Run: ${cmd.split('\n')[0].slice(0, 60)}`;

  try {
    status('Exporting Ansible bundle…', 0);
    let res = await window.api.ansible.save(payload, cmd, { playName, folderName });
    if (res?.exists) {
      status('');
      const replace = await confirm({
        title: 'That folder is already there',
        message: res.dir,
        detail: 'It has files in it \u2014 perhaps an earlier export, perhaps edited since. '
          + 'Replacing writes the new inventory, playbook and scripts over the old ones.',
        confirmLabel: 'Replace them', danger: true,
      });
      if (!replace) return;
      status('Exporting Ansible bundle…', 0);
      res = await window.api.ansible.save(payload, cmd, { playName, dir: res.dir, overwrite: true });
    }
    if (!res) return;
    status('');
    await offerShellIn(res);
  } catch (e) {
    toast(e.message, 'error');
  } finally { status(''); }
}

/**
 * After an export: offer a local shell already in the bundle's folder.
 *
 * The next thing anyone does with an export is run it, and that starts with
 * `cd` into a folder whose path they have just been shown once in a toast.
 * The shell opens there, with the command to type said in the question.
 * Windows has no native Ansible, so there the same shell is offered with
 * the honest note that the playbook runs under WSL.
 */
async function offerShellIn(res) {
  const win = state.appInfo?.platform === 'win32';
  const ok = await confirm({
    title: 'Ansible bundle exported',
    message: `${res.files.length} files in ${res.dir}`,
    detail: win
      ? 'Open a local shell in that folder? Ansible runs under WSL on Windows: '
        + 'from there, `wsl ./run.sh` runs the playbook.'
      : 'Open a local shell in that folder? `./run.sh` runs the playbook; '
        + '`./run.sh --list-hosts` shows which hosts it would run on, without running anything.',
    confirmLabel: 'Open a local shell there',
  });
  if (!ok) return;
  const { openLocalShell } = await import('./sessions.js');
  const name = String(res.dir).split(/[\\/]/).filter(Boolean).pop() || 'ansible';
  await openLocalShell(res.dir, { title: `ansible \u00b7 ${name}` });
}

/** Describe the current selection in the shape the YAML file stores. */
function currentRunDefinition() {
  return resolveTargets().map((t) => {
    const host = t.host || findHostById(t.hostId);
    const conn = t.connId ? state.getConnection(t.connId) : null;
    if (host?.type === 'teleport') {
      return {
        type: 'teleport', name: host.name, cluster: host.cluster, proxy: host.proxy,
        home: host.home || null,
        login: conn?.login || (state.teleportProfiles.find((p) => p.cluster === host.cluster)?.logins || [])[0],
      };
    }
    return {
      type: 'ssh',
      alias: host?.alias || t.label,
      user: conn?.login || host?.user,
      port: host?.port,
    };
  });
}

async function saveRunYaml(command) {
  const cmd = (command || '').trim();
  if (!cmd) return toast('Enter a command to save', 'error');
  const targets = currentRunDefinition();
  const sel = tagSelector.on ? { ...tagSelector } : null;
  if (!targets.length && !sel) return toast('Select hosts in the sidebar first', 'error');

  const name = cmd.split('\n')[0].slice(0, 50);
  try {
    const r = await window.api.mxfile.save({
      name,
      command: cmd,
      /*
       * A tag run saves the *question*. The hosts it matches today go in as
       * well, commented as a snapshot, so the file still says what it meant
       * when someone reads it in six months — but the query is what runs.
       */
      selector: sel ? { cluster: sel.proxy || null, query: sel.query } : null,
      targets,
      // Staged in the file when this run would be staged now.
      options: {
        concurrency: 10, timeout: 120000, stages: stagesFor(sel ? resolveTargets().length : targets.length),
        retries: retrySetting().count, retryDelay: retrySetting().delay,
      },
    });
    if (r) { status('Saved ' + r.path); toast('Run saved as YAML', 'success'); }
  } catch (e) { toast(e.message, 'error'); }
}

/**
 * Load a saved run: restore the command, and re-select the hosts it names by
 * matching them against the current inventory.
 */
async function loadRunYaml(input) {
  let def;
  try {
    def = await window.api.mxfile.load();
  } catch (e) { return toast(e.message, 'error'); }
  if (!def) return;

  input.value = def.command;
  lastCommand = def.command;
  // A file that says how to stage itself is run that way, here, until the
  // stages are changed by hand.
  stagingOverride = def.options?.stages ? { mode: 'on', ...def.options.stages } : null;
  retryOverride = def.options?.retries ? { count: def.options.retries, delay: def.options.retryDelay ?? 10 } : null;

  /*
   * A saved tag run restores the query rather than the host list: what it
   * meant was "whatever matches", and resolving it now is the point.
   */
  if (def.selector?.query !== undefined && def.selector?.query !== null) {
    tagSelector = { on: true, proxy: def.selector.cluster || '', query: def.selector.query || '' };
    state.checkedHosts.clear();
    state.emit('checked');
    renderMultiExec();
    const n = resolveTargets().length;
    status(`Loaded "${def.name}" — ${n} host${n === 1 ? '' : 's'} match that query now`);
    return;
  }
  tagSelector = { on: false, proxy: '', query: '' };

  const matched = [];
  const missing = [];
  state.checkedHosts.clear();

  for (const t of def.targets) {
    let host = null;
    if (t.type === 'teleport') {
      for (const [cluster, nodes] of state.teleportNodes) {
        if (t.cluster && cluster !== t.cluster) continue;
        const n = nodes.find((x) => x.name === t.name);
        if (n) { host = n; break; }
      }
    } else {
      host = state.sshHosts.find((h) => h.alias === t.alias) || null;
    }
    if (host) { state.checkedHosts.add(host.id); matched.push(host.name || host.alias); }
    else missing.push(t.name || t.alias);
  }

  state.emit('checked');
  renderMultiExec();

  if (missing.length) {
    toast(`Loaded "${def.name}" — ${matched.length} hosts matched, ${missing.length} not found: ${missing.join(', ')}`, 'error', 8000);
  } else {
    toast(`Loaded "${def.name}" — ${matched.length} hosts selected`, 'success');
  }
  status(`Loaded run from ${def.path}`);
}

export function upsertRun(view) {
  const i = state.multiRuns.findIndex((r) => r.id === view.id);
  if (i >= 0) state.multiRuns[i] = view;
  else state.multiRuns.unshift(view);
  state.emit('multiexec');
}

/* ------------------------------------------------------------------ */
/* Connection log                                                      */
/* ------------------------------------------------------------------ */

async function renderLog() {
  const panel = $('#dock-log');
  clear(panel);
  const connId = state.activeConnId;
  if (!connId) {
    panel.append(el('div', { class: 'sb-empty', text: 'No active session.' }));
    return;
  }
  try {
    const entries = await window.api.conn.log(connId);
    if (!entries.length) {
      panel.append(el('div', { class: 'sb-empty', text: 'No log output.' }));
      return;
    }
    for (const e of entries) {
      panel.append(el('div', { class: 'log-line ' + (e.stream === 'sys' ? 'sys' : ''), text: e.text.replace(/\r/g, '') }));
    }
    panel.scrollTop = panel.scrollHeight;
  } catch (e) {
    panel.append(el('div', { class: 'sb-empty', text: e.message }));
  }
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

/**
 * Everything pulled down to this machine, newest first.
 *
 * A transfer row answers "is it done"; this answers "where did it go", which
 * is asked later — often after the transfer panel has been cleared, or the app
 * restarted. So it is a list of files rather than of transfers, and each row
 * can open the file, show it in the Finder, or hand over its name or path.
 *
 * A file that has since been moved or deleted is kept and marked, not hidden:
 * "it was downloaded and it is not there now" is the useful answer, and
 * guessing which is which would be worse than saying so.
 */
async function renderDownloads() {
  const panel = $('#dock-downloads');
  clear(panel);

  let rows = [];
  try { rows = await window.api.downloads.list(); } catch { /* no download history */ }

  if (!rows.length) {
    panel.append(el('div', { class: 'sb-empty' },
      el('div', { text: 'Nothing downloaded yet.' }),
      el('div', { style: 'margin-top:6px;opacity:.75',
        text: 'Files you pull from a server or a bucket are listed here, with where they landed.' })));
    return;
  }

  let present = {};
  try { present = await window.api.downloads.check(rows.map((r) => r.localPath)); } catch { /* treat every file as present */ }

  for (const r of rows) {
    const gone = present[r.localPath] === false;
    const meta = [
      r.from,
      r.kind === 'folder' ? `${r.files} file${r.files === 1 ? '' : 's'}` : fmtBytes(r.bytes),
      fmtDate(r.at),
      r.source,
    ].filter(Boolean).join('  ·  ');

    panel.append(el('div', { class: 'dl-row' + (gone ? ' gone' : '') },
      el('span', { style: 'opacity:.7;width:12px', text: r.kind === 'folder' ? '\u{1F4C1}' : '↓' }),
      el('div', { class: 'xlabel' },
        el('div', { class: 'main', text: r.name + (gone ? '  — moved or deleted' : '') }),
        el('div', { class: 'sub', text: meta }),
        el('div', { class: 'sub path', text: r.localPath })),
      el('button', {
        class: 'ghost-btn sm', text: r.kind === 'folder' ? 'Open folder' : 'Open',
        disabled: gone,
        title: gone ? 'The file is no longer at that path' : 'Open ' + r.localPath,
        onClick: () => window.api.local.open(r.localPath).catch((e) => toast(e.message, 'error')),
      }),
      // Distinct from Open for a file, and the only way to get at a download
      // whose own application would not be the useful thing to launch.
      el('button', {
        class: 'ghost-btn sm', text: 'Show in Finder',
        disabled: gone,
        onClick: () => window.api.local.reveal(r.localPath).catch(() => {}),
      }),
      el('button', {
        class: 'ghost-btn sm', text: 'Copy name',
        title: 'Copy “' + r.name + '”',
        onClick: () => { window.api.clipboard.write(r.name); status('Copied ' + r.name); },
      }),
      el('button', {
        class: 'ghost-btn sm', text: 'Copy path',
        onClick: () => { window.api.clipboard.write(r.localPath); status('Copied ' + r.localPath); },
      }),
      el('button', {
        class: 'icon-btn sm', text: '×', title: 'Forget this entry (the file is not touched)',
        onClick: async () => {
          try { await window.api.downloads.forget(r.id); renderDownloads(); } catch { /* it stays listed; the next refresh decides */ }
        },
      })));
  }
}

/* ------------------------------------------------------------------ */
/* Watch: mirrored folders and remote files open in an editor          */
/* ------------------------------------------------------------------ */

/**
 * Everything currently being watched and pushed to a server.
 *
 * Two kinds in one list because they are the same bargain: something on this
 * machine is being uploaded on every save, and that continues until stopped.
 * A background job that uploads to a server must be visible and must have a
 * stop button, or it is a surprise waiting to happen.
 */
async function renderWatches() {
  const panel = $('#dock-watch');
  clear(panel);

  let list = state.watches || [];
  try { list = await window.api.watch.list(); state.watches = list; } catch { /* no watches */ }

  if (!list.length) {
    panel.append(el('div', { class: 'sb-empty' },
      el('div', { text: 'Nothing is being watched.' }),
      el('div', { style: 'margin-top:6px;opacity:.75' },
        'Right-click a remote file → ', el('b', { text: 'Edit in my editor' }),
        ' to open it here and have every save go back.'),
      el('div', { style: 'margin-top:4px;opacity:.75' },
        'Right-click a remote folder → ', el('b', { text: 'Keep this folder up to date' }),
        ' to upload a local folder as it changes.')));
    return;
  }

  for (const w of list) {
    const isEdit = w.kind === 'edit';
    const meta = [
      w.label,
      w.uploads ? `${w.uploads} upload${w.uploads === 1 ? '' : 's'}` : 'nothing yet',
      w.lastAt ? 'last ' + fmtDate(w.lastAt) : '',
      w.errors ? `${w.errors} error${w.errors === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join('  ·  ');

    panel.append(el('div', { class: 'dl-row' + (w.lastError ? ' gone' : '') },
      el('span', { style: 'opacity:.75;width:14px', text: isEdit ? '✎' : '\u{1F441}' }),
      el('div', { class: 'xlabel' },
        el('div', { class: 'main', text: isEdit
          ? `${w.remotePath}`
          : `${w.localDir}  →  ${w.remoteDir}` }),
        el('div', { class: 'sub', text: meta }),
        el('div', { class: 'sub path', text: w.lastError
          ? w.lastError
          : (isEdit ? `local copy: ${w.localPath}` : (w.lastFile ? `last file: ${w.lastFile}` : '')) }),
        w.flatOnly
          ? el('div', { class: 'sub', style: 'color:var(--amber)',
              text: 'Subfolders are not watched on this platform — only files directly in the folder.' })
          : null),
      isEdit
        ? el('button', {
            class: 'ghost-btn sm', text: 'Reveal',
            title: 'Show the local copy in the Finder',
            onClick: () => window.api.local.reveal(w.localPath).catch(() => {}),
          })
        : el('button', {
            class: 'ghost-btn sm', text: 'Open folder',
            onClick: () => window.api.local.open(w.localDir).catch(() => {}),
          }),
      el('button', {
        class: 'ghost-btn sm danger-btn', text: 'Stop',
        title: isEdit
          ? 'Stop watching and delete the local copy'
          : 'Stop uploading changes from this folder',
        onClick: async () => {
          try {
            state.watches = await window.api.watch.stop(w.id);
            renderWatches();
            updateWatchStatus();
            status(isEdit ? 'Stopped editing ' + w.remotePath : 'Stopped watching ' + w.localDir);
          } catch (e) { toast(e.message, 'error'); }
        },
      })));
  }
}

/** Something uploading in the background belongs in the status bar too. */
function updateWatchStatus() {
  const node = $('#status-watches');
  if (!node) return;
  const n = (state.watches || []).length;
  node.textContent = n ? `${n} watching` : '';
  node.classList.toggle('hidden', !n);
}

export { renderTransfers, renderMultiExec, renderLog, renderDownloads, renderWatches };

/* ------------------------------------------------------------------ */
/* Scheduled runs                                                      */
/* ------------------------------------------------------------------ */

/*
 * A run at a date and time, once or repeating: the command, who it runs as,
 * and its hosts — the ticked ones by id, or a tag query asked again each time
 * — with the retries and staging it had when it was made. Kept in settings,
 * and run by the first window while ServerLife is open. A run that fell due
 * while it was closed is not run late, which for a change on servers could be
 * the wrong time; it is counted as missed, and the next one is waited for.
 */
export function schedules() { return Array.isArray(state.settings.mxSchedules) ? state.settings.mxSchedules : []; }

async function saveSchedules(list) {
  state.settings = await window.api.settings.set({ mxSchedules: list });
}
async function patchSchedule(id, patch) {
  await saveSchedules(schedules().map((x) => (x.id === id ? { ...x, ...patch } : x)));
}

/** The hosts a schedule runs on now, as run targets. */
function scheduleTargets(sc) {
  const hosts = sc.selector
    ? hostsForSelector({ on: true, proxy: sc.selector.proxy || '', query: sc.selector.query || '' })
    : (sc.hostIds || []).map(findHostById).filter(Boolean);
  return hosts.map((host) => {
    const conn = [...state.connections.values()].find((c) => c.hostId === host.id && (!sc.runAs || c.login === sc.runAs));
    return { hostId: host.id, host, connId: conn?.id || null, label: host.name || host.alias };
  });
}

/** What a schedule runs on, in words. */
function scheduleTargetText(sc) {
  if (sc.selector) return `hosts matching ${sc.selector.query || '(everything)'}${sc.selector.proxy ? ' on ' + sc.selector.proxy : ''}`;
  const names = sc.hosts || [];
  return `${names.length} host${names.length === 1 ? '' : 's'}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4}` : ''}`;
}

/** Make a schedule, or change one. */
export async function openScheduleDialog(existing = null, { command = '', runAs = '' } = {}) {
  const now = Date.now();
  // The current selection is offered for a new schedule, or to replace an old one's.
  const sel = tagSelector.on ? { proxy: tagSelector.proxy, query: tagSelector.query } : null;
  const picked = sel ? [] : resolveTargets().filter((t) => t.hostId);
  const fromForm = { selector: sel, hostIds: picked.map((t) => t.hostId), hosts: picked.map((t) => t.label) };
  if (!existing && !sel && !picked.length) {
    return toast(resolveTargets().length
      ? 'A schedule needs hosts it can find again — tick them in the sidebar or choose by tag, not just open sessions'
      : 'Select hosts in the sidebar first, or choose by tag', 'error');
  }
  let targets = existing ? { selector: existing.selector || null, hostIds: existing.hostIds || [], hosts: existing.hosts || [] } : fromForm;

  const nameIn = textInput({ value: existing?.name || String(command || '').trim().split('\n')[0].slice(0, 50), placeholder: 'Nightly disk check' });
  const cmdIn = el('textarea', { class: 'mx-command', rows: '3', spellcheck: 'false' });
  cmdIn.value = existing?.command || command;
  const asIn = textInput({ value: existing?.runAs ?? runAs, placeholder: 'as each host’s usual login' });
  asIn.setAttribute('list', 'mx-logins');
  const start = new Date(existing?.startAt || (Math.ceil((now + 5 * 60000) / 300000) * 300000));
  const startIn = el('input', { type: 'datetime-local', value: toLocalInput(start.getTime()) });
  const repeatSel = select([
    { value: '', label: 'Once' }, { value: 'minutes', label: 'Every … minutes' }, { value: 'hours', label: 'Every … hours' },
    { value: 'days', label: 'Every … days' }, { value: 'weeks', label: 'Every … weeks' },
  ], existing?.repeat?.unit || '');
  const everyIn = el('input', { type: 'number', min: '1', value: String(existing?.repeat?.every || 1), class: 'mx-num' });
  const endSel = select([
    { value: '', label: 'Never' }, { value: 'after', label: 'After a number of runs' }, { value: 'at', label: 'On a date' },
  ], existing?.endAfter ? 'after' : existing?.endAt ? 'at' : '');
  const endAfterIn = el('input', { type: 'number', min: '1', value: String(existing?.endAfter || 10), class: 'mx-num' });
  const endAtIn = el('input', { type: 'datetime-local', value: toLocalInput(existing?.endAt || start.getTime() + 7 * 86400000) });
  const rt = existing?.retry || retrySetting();
  const triesIn = el('input', { type: 'number', min: '0', max: '10', value: String(rt.count), class: 'mx-num' });
  const gapIn = el('input', { type: 'number', min: '0', max: '3600', value: String(rt.delay), class: 'mx-num' });
  const st = existing?.staging !== undefined ? existing.staging : staging();
  const stagedIn = checkbox('Run in stages as set under Advanced — without pausing, stopping at a stage that fails',
    !!st && st.mode !== 'off');
  const targetLine = el('div', { class: 'hint' });
  const preview = el('div', { class: 'mx-sched-preview' });

  const draft = () => {
    const startAt = new Date(startIn.value).getTime();
    const unit = repeatSel.value;
    return {
      startAt,
      repeat: unit ? { unit, every: Math.max(1, Math.floor(Number(everyIn.value)) || 1) } : null,
      endAfter: unit && endSel.value === 'after' ? Math.max(1, Math.floor(Number(endAfterIn.value)) || 1) : null,
      endAt: unit && endSel.value === 'at' ? new Date(endAtIn.value).getTime() : null,
    };
  };
  const sync = () => {
    everyIn.style.display = repeatSel.value ? '' : 'none';
    endSel.closest('.field').style.display = repeatSel.value ? '' : 'none';
    endAfterIn.style.display = endSel.value === 'after' ? '' : 'none';
    endAtIn.style.display = endSel.value === 'at' ? '' : 'none';
    targetLine.textContent = scheduleTargetText(targets);
    const d = draft();
    if (!Number.isFinite(d.startAt)) { preview.textContent = 'Choose when it starts.'; return; }
    const next = upcoming({ ...d, runs: 0 }, 4, Date.now());
    preview.textContent = next.length
      ? `Runs ${describeRepeat(d)}. Next: ${next.map(fmtWhen).join(' · ')}`
      : 'That time has passed — choose a later one, or a repeat.';
  };
  for (const n of [startIn, repeatSel, everyIn, endSel, endAfterIn, endAtIn]) { n.addEventListener('input', sync); n.addEventListener('change', sync); }

  const res = await modal({
    title: existing ? 'Change a scheduled run' : 'Schedule a run',
    width: 'min(620px, 94vw)',
    render: (b) => {
      b.append(
        field('Name', nameIn),
        field('Command', cmdIn),
        field('Run as', asIn),
        field('Hosts', el('div', {},
          targetLine,
          existing && (fromForm.selector || fromForm.hostIds.length) ? el('button', {
            class: 'ghost-btn sm', text: 'Use the current selection instead', style: 'margin-top:4px',
            onClick: (e) => { e.preventDefault(); targets = fromForm; sync(); },
          }) : null)),
        field('Starts', startIn),
        field('Repeat', el('div', { class: 'mx-adv-row' }, repeatSel, everyIn)),
        field('Ends', el('div', { class: 'mx-adv-row' }, endSel, endAfterIn, endAtIn)),
        field('Retries', el('div', { class: 'mx-adv-row' },
          el('span', { text: 'Retry a failed host' }), triesIn, el('span', { text: 'more time(s),' }), gapIn, el('span', { text: 'seconds apart' }))),
        stagedIn,
        preview,
        el('div', { class: 'hint', style: 'margin-top:6px', text: 'Runs while ServerLife is open, in your local time. A run due while it is closed is skipped and counted as missed, not run late.' }));
      sync();
    },
    buttons: [
      { label: 'Cancel', value: null },
      { label: existing ? 'Save' : 'Schedule', class: 'primary-btn', value: 'save' },
    ],
  });
  if (res !== 'save') return;

  const d = draft();
  const cmd = cmdIn.value.trim();
  if (!cmd) return toast('Give a command', 'error');
  if (!Number.isFinite(d.startAt)) return toast('Choose when it starts', 'error');
  const rec = {
    id: existing?.id || `sch-${Date.now().toString(36)}`,
    name: nameIn.value.trim() || cmd.split('\n')[0].slice(0, 50),
    command: cmd,
    runAs: asIn.value.trim() || null,
    ...targets,
    ...d,
    retry: {
      count: Math.max(0, Math.min(10, Math.floor(Number(triesIn.value)) || 0)),
      delay: Math.max(0, Math.min(3600, Number(gapIn.value) || 0)),
    },
    staging: stagedIn.input.checked ? { ...staging(), mode: 'on' } : null,
    enabled: existing ? existing.enabled !== false : true,
    runs: existing && existing.startAt === d.startAt ? existing.runs || 0 : 0,
    lastRunAt: existing && existing.startAt === d.startAt ? existing.lastRunAt || null : null,
    lastResult: existing?.lastResult || null,
    missed: 0,
    createdAt: existing?.createdAt || Date.now(),
  };
  rec.nextAt = nextRunAt(rec, Date.now());
  if (!rec.nextAt) return toast('That schedule has no runs left — choose a later start or a repeat', 'error');

  // A host marked careful is confirmed now, while someone is here to answer.
  const { isCareful } = await import('./sidebar.js');
  const careful = scheduleTargets(rec).map((t) => t.host).filter((h) => h && isCareful(h));
  if (careful.length && !await confirm({
    title: 'Schedule a run on a host marked careful?',
    message: `${careful.map((h) => h.name || h.alias).join(', ')} ${careful.length === 1 ? 'is' : 'are'} marked careful.`,
    detail: `It will run without asking at ${fmtWhen(rec.nextAt)}${rec.repeat ? ', and ' + describeRepeat(rec) : ''}.`,
    confirmLabel: 'Schedule it', danger: true,
  })) return;

  const list = schedules().filter((x) => x.id !== rec.id);
  await saveSchedules([...list, rec]);
  mxView = 'scheduled';
  renderMultiExec();
  toast(`Scheduled “${rec.name}” — first run ${fmtWhen(rec.nextAt)}`, 'success');
}

/** The Scheduled tab. */
function renderSchedules() {
  const wrap = el('div', { class: 'mx-history' });
  const list = [...schedules()].sort((a, b) => (a.enabled === false) - (b.enabled === false) || (a.nextAt || Infinity) - (b.nextAt || Infinity));
  if (!list.length) {
    wrap.append(el('div', { class: 'sb-empty', style: 'text-align:left' },
      el('div', { text: 'Nothing scheduled.' }),
      el('div', { style: 'margin-top:6px;opacity:.75', text: 'Write a command on the Command tab, choose its hosts, and press Schedule… to run it at a time — once, or every so often.' })));
    return wrap;
  }
  for (const sc of list) {
    const on = sc.enabled !== false;
    const last = sc.lastResult;
    const when = !on ? 'paused' : sc.nextAt ? `next ${fmtWhen(sc.nextAt)}` : 'finished';
    wrap.append(el('div', { class: 'xfer-row mx-sched' + (on ? '' : ' off') },
      el('span', { class: 'tag', style: `flex-shrink:0;${last?.failed ? 'color:var(--red)' : last ? 'color:var(--green)' : ''}`,
        text: last ? (last.error ? '!' : last.failed ? `${last.ok}/${last.ok + last.failed}` : String(last.ok)) : '—',
        title: last ? (last.error || `Last run ${fmtWhen(last.at)}: ${last.ok} ok, ${last.failed} failed`) : 'Not run yet' }),
      el('div', { class: 'xlabel' },
        el('div', { class: 'main', text: sc.name }),
        el('div', { class: 'sub', style: 'font-family:var(--mono)', text: sc.command.split('\n')[0] + (sc.command.includes('\n') ? ' …' : '') }),
        el('div', { class: 'sub', text: [
          when, describeRepeat(sc), scheduleTargetText(sc), sc.runAs ? 'as ' + sc.runAs : '',
          sc.retry?.count ? `${sc.retry.count} retr${sc.retry.count === 1 ? 'y' : 'ies'}` : '',
          sc.runs ? `${sc.runs} run${sc.runs === 1 ? '' : 's'}` : '',
          sc.missed ? `${sc.missed} missed while closed` : '',
        ].filter(Boolean).join('  ·  ') })),
      el('button', { class: 'ghost-btn sm', text: 'Run now', title: 'Run it once now; the schedule carries on as it was', onClick: () => fireSchedule(sc, { manual: true }) }),
      el('button', {
        class: 'ghost-btn sm', text: on ? 'Pause' : 'Resume',
        onClick: async () => {
          await patchSchedule(sc.id, on ? { enabled: false } : { enabled: true, nextAt: nextRunAt(sc, Date.now()), missed: 0 });
          renderMultiExec();
        },
      }),
      el('button', { class: 'ghost-btn sm', text: 'Edit', onClick: () => openScheduleDialog(sc) }),
      el('button', {
        class: 'ghost-btn sm', text: '×', title: 'Delete this schedule',
        onClick: async () => {
          if (!await confirm({ title: 'Delete this schedule?', message: sc.name, confirmLabel: 'Delete' })) return;
          await saveSchedules(schedules().filter((x) => x.id !== sc.id));
          renderMultiExec();
        },
      })));
  }
  return wrap;
}

const scheduledRuns = new Map();     // runId -> schedule id
const firing = new Set();            // schedule ids being started

/** Run a schedule now: on its due time, or by hand. */
async function fireSchedule(sc, { manual = false } = {}) {
  if (firing.has(sc.id)) return;
  firing.add(sc.id);
  try {
    // Moved on before the run starts, so a slow start cannot fire it twice.
    if (!manual) {
      const ran = { ...sc, runs: (sc.runs || 0) + 1, lastRunAt: Date.now() };
      await patchSchedule(sc.id, { runs: ran.runs, lastRunAt: ran.lastRunAt, nextAt: nextRunAt(ran, Date.now() + 1000) });
    }
    const targets = scheduleTargets(sc);
    if (!targets.length) {
      await patchSchedule(sc.id, { lastResult: { at: Date.now(), ok: 0, failed: 0, error: 'No hosts — none of its hosts are listed now' } });
      notifySchedule(sc, 'did not run: none of its hosts are listed now', true);
      return;
    }
    const r = await runMulti(sc.command, sc.runAs || null, {
      label: `Scheduled: ${sc.name}`, only: targets, scheduled: true,
      staging: sc.staging, retry: sc.retry || { count: 0, delay: 10 },
      selector: sc.selector || null,
    });
    if (r?.runId) scheduledRuns.set(r.runId, { id: sc.id, unreachable: r.unreachable || 0 });
    else {
      await patchSchedule(sc.id, { lastResult: { at: Date.now(), ok: 0, failed: targets.length, error: r?.error || 'Could not start' } });
      notifySchedule(sc, `could not start: ${r?.error || 'no host could be connected'}`, true);
    }
  } finally {
    firing.delete(sc.id);
    if (mxView === 'scheduled') renderMultiExec();
  }
}

/** A scheduled run has finished: keep how it went, and say so. */
function scheduledRunDone(view) {
  const link = scheduledRuns.get(view.id);
  if (!link) return;
  scheduledRuns.delete(view.id);
  const sc = schedules().find((x) => x.id === link.id);
  if (!sc) return;
  const ok = (view.results || []).filter((r) => r.status === 'done').length;
  const failed = (view.results || []).length - ok + link.unreachable;
  patchSchedule(sc.id, { lastResult: { at: Date.now(), ok, failed } }).then(() => {
    if (mxView === 'scheduled') renderMultiExec();
  }).catch(() => {});
  notifySchedule(sc, failed ? `${failed} of ${ok + failed} failed` : `ok on ${ok} host${ok === 1 ? '' : 's'}`, failed > 0);
}

function notifySchedule(sc, what, bad) {
  toast(`Scheduled “${sc.name}” — ${what}`, bad ? 'error' : 'success', 8000);
  // Said outside the window too, as nobody may be looking at it.
  if (!document.hasFocus() && typeof Notification !== 'undefined') {
    try { new Notification(`ServerLife — ${sc.name}`, { body: what, silent: !bad }); } catch { /* notifications off */ }
  }
}

/*
 * The clock: every fifteen seconds, in the first window only, so two windows
 * do not run the same schedule. Hosts are waited for after launch — a run
 * due while the inventory is still loading goes once it has loaded.
 */
let schedTimer = null;
export function startScheduler() {
  if (schedTimer) return;
  if (state.windowInfo?.slot && state.windowInfo.slot !== 'w1') return;
  // Runs that fell due while ServerLife was closed are counted, not run late.
  const now = Date.now();
  const missedAny = schedules().some((sc) => sc.enabled !== false && sc.nextAt && sc.nextAt < now - 120000);
  if (missedAny) {
    saveSchedules(schedules().map((sc) => {
      if (sc.enabled === false || !sc.nextAt || sc.nextAt >= now - 120000) return sc;
      const missed = runsBetween(sc, sc.nextAt, now);
      const ran = { ...sc, lastRunAt: now - 1 };
      return { ...sc, missed: (sc.missed || 0) + missed, nextAt: nextRunAt(ran, now) };
    })).catch(() => {});
  }
  const tick = () => {
    const t = Date.now();
    for (const sc of schedules()) {
      if (sc.enabled === false || !sc.nextAt || sc.nextAt > t || firing.has(sc.id)) continue;
      // Waits for the inventory, up to five minutes past due, before running on what there is.
      if (state.loadingInventory && t - sc.nextAt < 300000) continue;
      if (!scheduleTargets(sc).length && t - sc.nextAt < 300000) continue;
      fireSchedule(sc);
    }
  };
  schedTimer = setInterval(tick, 15000);
  setTimeout(tick, 5000);
}
