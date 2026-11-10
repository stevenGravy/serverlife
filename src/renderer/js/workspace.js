import { state } from './state.js';
import { el, fmtDate } from './util.js';
import { modal, toast, status, checkbox, prompt, confirm } from './ui.js';
import { openHost, openLocalShell, splitActivePane, shortCwd } from './sessions.js';

/**
 * Saving and restoring the window layout.
 *
 * Reopening sessions dials real servers, so restore is always offered rather
 * than performed automatically — unless the user has explicitly said to.
 */

/** Capture the current tabs and their pane trees. */
export function captureWorkspace() {
  const tabs = state.tabs.map((tab) => {
    const conn = tab.connId ? state.getConnection(tab.connId) : null;

    const describePane = (paneId) => {
      const p = state.getPane(paneId);
      if (!p) return null;
      /*
       * Where the pane was, so reopening it lands in the same place.
       *
       * A shell that was three levels into a deploy directory is not the same
       * thing as a shell in your home directory, and "reopen my session" means
       * the former.
       */
      /*
       * A hosts pane is a view, not a session: nothing is running in it and
       * nothing has to be dialled to bring it back, so it is saved as what
       * it is and restored without touching a cluster.
       */
      if (p.isHosts) return { kind: 'hosts', group: p.hostsGroup || null, title: p.title || 'Hosts' };
      /*
       * KubeLife panes are local panes underneath, and were being saved as
       * plain shells: a cluster browser came back as an empty terminal, and
       * a pod's exec or logs as a shell in the home directory. Saved as what
       * they are instead, and checked against the cluster before reopening
       * (kubepanel.js's resolveKubeTarget).
       */
      if (p.isKubeBrowser && p.kubeSpec) {
        return { kind: 'kubeBrowser', spec: p.kubeSpec, title: p.kubeTitle || p.title || null, view: p.kubeView || null };
      }
      // The Log Viewer is a view too, not a session — same reasoning as the
      // cluster browser above, just its own tab kind (kubelogviewer.js).
      if (p.isKubeLogViewer && p.kubeSpec) {
        return { kind: 'kubeLogViewer', spec: p.kubeSpec, target: p.kubeLogTarget || null, title: p.kubeTitle || p.title || null };
      }
      if (p.kubeRestore) return { kind: 'kubePod', ...p.kubeRestore, title: p.title || null };
      if (p.kind === 'local') {
        return { kind: 'local', cwd: p.cwd || null, shell: p.shellName || null, blank: !!p.blankShell };
      }
      /*
       * A console or a screen carries everything needed to open it again in
       * the pane itself — there is no connection to look up, because there is
       * no connection. Saved as the spec it was opened with.
       */
      if (p.kind === 'device') return { kind: 'device', spec: p.deviceSpec || null, title: p.title || null };
      if (p.kind === 'vnc') return { kind: 'vnc', spec: p.vncSpec || null, title: p.title || null };
      const c = state.getConnection(p.connId);
      if (!c) return null;
      return {
        kind: 'remote',
        hostId: c.hostId,
        label: c.label,
        target: c.target,
        type: c.type,
        login: c.login || null,
        cwd: p.cwd || null,
      };
    };

    const walk = (node) => {
      if (!node) return null;
      if (node.type === 'pane') {
        const d = describePane(node.paneId);
        return d ? { type: 'pane', pane: d } : null;
      }
      const children = node.children.map(walk).filter(Boolean);
      if (!children.length) return null;
      if (children.length === 1) return children[0];
      return { type: 'split', dir: node.dir, children };
    };

    const root = walk(tab.root);
    if (!root) return null;
    return {
      title: conn?.label || tab.title,
      kind: tab.kind,
      root,
    };
  }).filter(Boolean);

  return {
    tabs,
    activeIndex: Math.max(0, state.tabs.findIndex((t) => t.id === state.activeTabId)),
  };
}

/** Find a live host descriptor for a saved pane. */
function resolveHost(pane) {
  if (!pane.hostId) return null;
  for (const nodes of state.teleportNodes.values()) {
    const n = nodes.find((x) => x.id === pane.hostId);
    if (n) return n;
  }
  return state.sshHosts.find((h) => h.id === pane.hostId) || null;
}

function countPanes(node) {
  if (!node) return 0;
  return node.type === 'pane' ? 1 : node.children.reduce((a, c) => a + countPanes(c), 0);
}

/** Reopen a saved workspace. */
export async function restoreWorkspace(ws) {
  if (!ws?.tabs?.length) return;
  let opened = 0;
  let skipped = 0;

  for (const tab of ws.tabs) {
    // Open the first pane as the tab, then split for the rest in order.
    const panes = [];
    const flatten = (node, dir) => {
      if (!node) return;
      if (node.type === 'pane') { panes.push({ pane: node.pane, dir }); return; }
      node.children.forEach((c, i) => flatten(c, i === 0 ? dir : (node.dir === 'col' ? 'col' : 'row')));
    };
    flatten(tab.root, 'row');
    if (!panes.length) continue;

    let first = true;
    for (const { pane, dir } of panes) {
      try {
        if (pane.kind === 'hosts') {
          const { openHostsPane } = await import('./hostspane.js');
          await openHostsPane({ groupKey: pane.group || null, dir: first ? null : dir });
        } else if (pane.kind === 'kubeBrowser' || pane.kind === 'kubePod') {
          // The browser is always a tab of its own; a pod pane splits like a
          // shell — except a node shell, which has no pod identity to
          // re-check and gets its own, simpler resolve path.
          const kp = await import('./kubepanel.js');
          const ok = pane.kind === 'kubeBrowser' ? await kp.reopenKubeBrowser(pane)
            : pane.mode === 'nodeShell' ? await kp.reopenKubeNode(pane, { first, dir })
            : await kp.reopenKubePod(pane, { first, dir });
          if (!ok) { skipped++; continue; }
        } else if (pane.kind === 'kubeLogViewer') {
          // Always a tab of its own, same as the cluster browser.
          const klv = await import('./kubelogviewer.js');
          const ok = await klv.reopenKubeLogViewer(pane);
          if (!ok) { skipped++; continue; }
        } else if (pane.kind === 'device' || pane.kind === 'vnc') {
          /*
           * Restored as a tab of its own. A console cannot be opened into one
           * half of a split the way a host can — `splitActivePane` dials a
           * connection, and these have none — so one that was sharing a tab
           * comes back beside the others rather than inside the same frame,
           * which is closer to right than losing it.
           */
          if (!pane.spec) { skipped++; continue; }
          const m = await import('./sessions.js');
          if (pane.kind === 'device') await m.openDeviceSession(pane.spec);
          else await m.openVncSession(pane.spec);
        } else if (pane.kind === 'local') {
          // The shell it was running comes back too, when one was chosen.
          const opts = { shell: pane.shell || undefined, blank: !!pane.blank };
          if (first) await openLocalShell(pane.cwd || undefined, opts);
          else await splitActivePane(dir, { local: true, cwd: pane.cwd || undefined, ...opts });
        } else {
          const host = resolveHost(pane);
          if (!host) { skipped++; continue; }
          /*
           * The remote directory is sent as a `cd` once the shell is up —
           * there is no way to ask sshd to start somewhere — so it appears in
           * the session, which is the honest way to do it.
           */
          if (first) {
            await openHost(host, {
              login: pane.login || undefined,
              remoteStartPath: pane.cwd || undefined,
            });
          } else {
            await splitActivePane(dir, {
              host,
              login: pane.login || undefined,
              remoteStartPath: pane.cwd || undefined,
            });
          }
        }
        opened++;
        first = false;
      } catch {
        skipped++;
      }
    }
  }

  status(skipped
    ? `Restored ${opened} pane(s); ${skipped} could not be reopened`
    : `Restored ${opened} pane(s)`);
}

/**
 * On startup, offer the saved layout back. Declining leaves it saved, so the
 * offer returns next time rather than being silently discarded.
 */
/**
 * Every pane in a saved tab, as `login@host`.
 *
 * The snapshot records the login and the ssh target it was dialled with, so
 * this needs no inventory — it describes what *was* open even for a host that
 * has since gone. A local pane says so rather than being left out, because a
 * tab of two remote panes and one local one is not the same as a tab of two.
 */
function describeTabTargets(tab) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'pane') {
      const p = node.pane;
      if (!p) return;
      if (p.kind === 'local') {
        const where = p.cwd ? shortCwd(p.cwd) : '';
        out.push(where ? `local shell: ${where}` : 'local shell');
        return;
      }
      // `target` is already user@host for both kinds; the login is there
      // separately for a snapshot written before that was true.
      const target = String(p.target || '');
      const host = target.includes('@') ? target.split('@').slice(1).join('@') : (target || p.label || '');
      const login = p.login || (target.includes('@') ? target.split('@')[0] : '');
      const who = login ? `${login}@${host}` : (host || p.label || 'unknown host');
      out.push(p.cwd ? `${who}: ${shortCwd(p.cwd)}` : who);
      return;
    }
    for (const c of node.children || []) walk(c);
  };
  walk(tab.root);
  // The same host twice in one tab is a split, not two things to say.
  return [...new Set(out)];
}

export async function offerRestore() {
  const me = state.windowInfo || { slot: 'w1', count: 1, autoRestore: false };

  /*
   * Only the window that started the app asks anything. A second window opened
   * by hand starts empty, and one opened to restore a saved layout just does
   * it — the user already answered that question for the whole set.
   */
  if (me.autoRestore) {
    let mine = null;
    try { mine = await window.api.workspace.get(); } catch { /* nothing saved for this window */ }
    if (mine?.tabs?.length) await restoreWorkspace(mine);
    return;
  }
  if (me.count > 1) return;

  // A layout the user marked as default wins over "whatever was open last".
  let def = null;
  try { def = await window.api.workspace.getDefaultLayout(); } catch { /* no default layout */ }
  if (def?.workspace?.tabs?.length) {
    if (state.settings.autoRestoreWorkspace) {
      await restoreWorkspace(def.workspace);
      return;
    }
    const open = await confirm({
      title: `Open your default layout?`,
      message: `“${def.name}” — ${def.workspace.tabs.length} tab(s).`,
      detail: 'Each session is dialled again. Set or clear the default in Session → Layouts → Manage Layouts.',
      confirmLabel: 'Open',
    });
    if (open) { await restoreWorkspace(def.workspace); return; }
  }

  let ws = null;
  try { ws = await window.api.workspace.get(); } catch { return; }

  // Layouts belonging to windows that are not open yet. Only the first window
  // to start sees any, so the question is asked once for the whole set.
  let others = [];
  try { others = await window.api.workspace.others(); } catch { /* no other windows to compare against */ }
  others = others.filter((o) => o.tabs > 0);

  if (!ws?.tabs?.length && !others.length) return;

  const paneCount = (ws?.tabs || []).reduce((a, t) => a + countPanes(t.root), 0);

  if (state.settings.autoRestoreWorkspace) {
    if (ws?.tabs?.length) await restoreWorkspace(ws);
    await reopenOtherWindows(others);
    return;
  }

  // Nothing for this window, but other windows to put back: a shorter question.
  if (!ws?.tabs?.length) {
    const open = await confirm({
      title: `Reopen ${others.length} more window${others.length === 1 ? '' : 's'}?`,
      message: describeWindows(others),
      detail: 'Reopening dials each server again, which creates new sessions in the audit log.',
      confirmLabel: 'Reopen',
    });
    if (open) await reopenOtherWindows(others);
    return;
  }

  const always = checkbox('Always restore without asking', false);

  const answer = await modal({
    title: 'Reopen your last session?',
    subtitle: ws.savedAt ? `Saved ${fmtDate(ws.savedAt)}` : '',
    render: (body, { close }) => {
      body.append(el('div', { style: 'font-size:13px;margin-bottom:10px' },
        `${ws.tabs.length} tab${ws.tabs.length === 1 ? '' : 's'}, ${paneCount} pane${paneCount === 1 ? '' : 's'}:`));
      const list = el('div', { class: 'picker-list', style: 'margin-bottom:12px' });
      for (const t of ws.tabs) {
        const who = describeTabTargets(t);
        /*
         * A row reopens itself.
         *
         * All or nothing is the wrong question after a crash or a long
         * weekend: usually one of the six sessions is the one you want back.
         * Opening one leaves the dialog up, so a second and a third can follow
         * — and the rest are still offered next launch if you never take them.
         */
        const row = el('div', {
          class: 'picker-item restorable',
          style: 'align-items:flex-start',
          title: [...who, '', 'Click to reopen just this one'].join('\n'),
        },
          el('div', { style: 'flex:1;min-width:0' },
            el('div', { class: 'pname', text: t.title }),
            /*
             * Who, and where. A saved tab's title is whatever it was called at
             * the time, which after a rename or a `cd` may say very little —
             * and "reopen this?" is a question about *which account on which
             * host*, since reopening dials them again.
             */
            // Nothing is gained by "Local shell / local shell": the sub-line
            // is there to say what the title does not.
            who.length && who.join(', ').toLowerCase() !== String(t.title || '').toLowerCase()
              ? el('div', {
              class: 'sub',
              style: 'font-family:var(--mono);font-size:10.5px;color:var(--muted)',
              text: who.join(', '),
            }) : null),
          el('span', { class: 'pmeta', text: `${countPanes(t.root)} pane${countPanes(t.root) === 1 ? '' : 's'}` }));

        let opened = false;
        row.addEventListener('click', async () => {
          if (opened) return;
          opened = true;
          row.classList.add('done');
          const meta = row.querySelector('.pmeta');
          if (meta) meta.textContent = 'reopening…';
          /*
           * Close on the way in, not on the way out: the session being dialled
           * is what should be on screen, and a dialog sitting over it while it
           * connects is in the way. The rest stay saved and are offered again
           * next launch.
           */
          close('one');
          try {
            await restoreWorkspace({ tabs: [t] });
          } catch (e) {
            toast(e.message, 'error');
          }
        });
        list.append(row);
      }
      body.append(list, always);
      if (others.length) {
        body.append(el('div', {
          style: 'margin-top:10px;font-size:12px;color:var(--accent)',
          text: `Plus ${others.length} more window${others.length === 1 ? '' : 's'}: ${describeWindows(others)}`,
        }));
      }
      body.append(el('div', { class: 'hint' },
        'Reopening dials each server again, which creates new sessions in the audit log.'));
    },
    buttons: [
      { label: 'Start fresh', value: 'no' },
      { label: 'Reopen', class: 'primary-btn', value: 'yes' },
    ],
  });

  if (answer === 'yes') {
    if (always.input.checked) {
      state.settings = await window.api.settings.set({ autoRestoreWorkspace: true });
    }
    await restoreWorkspace(ws);
    await reopenOtherWindows(others);
  } else if (answer === 'no') {
    // Keep the snapshot; the user may want it next launch.
    status('Started fresh — your last layout is still saved');
  } else if (answer === 'one') {
    // One row was clicked and is being dialled; the others stay saved.
    status('Reopening that one — the rest of the layout is still saved', 7000);
  }
}

function describeWindows(others) {
  return others
    .map((o) => `${o.tabs} tab${o.tabs === 1 ? '' : 's'}`)
    .join(', ');
}

/**
 * Open the windows that were saved alongside this one. Each comes up on its
 * own slot and runs the same restore for itself, so the layouts land where
 * they were rather than being merged into one window.
 */
async function reopenOtherWindows(others) {
  for (const o of others) {
    try { await window.api.window.create({ restoreSlot: o.slot, autoRestore: true }); }
    catch (e) { toast(`Could not reopen a window: ${e.message}`, 'error'); }
  }
  if (others.length) status(`Reopened ${others.length} more window${others.length === 1 ? '' : 's'}`);
}

/** Persist the layout. Called on quit and whenever the shape changes. */
export async function saveWorkspaceNow() {
  try {
    const ws = captureWorkspace();
    await window.api.workspace.save(ws.tabs.length ? ws : null);
  } catch { /* a layout that cannot be saved must not block quitting */ }
}

let saveTimer = null;
export function scheduleWorkspaceSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWorkspaceNow, 1200);
}


/* ------------------------------------------------------------------ */
/* Named layouts                                                       */
/* ------------------------------------------------------------------ */

/**
 * Save the current arrangement under a name. Named layouts are separate from
 * the automatic snapshot: the snapshot is "what I had open last time", a saved
 * layout is "the arrangement I work in".
 */
export async function saveLayoutAs() {
  const ws = captureWorkspace();
  if (!ws.tabs.length) return toast('Nothing open to save', 'error');

  const existing = await window.api.workspace.listLayouts().catch(() => []);
  const name = await prompt({
    title: 'Save layout as',
    label: `${ws.tabs.length} tab(s), ${ws.tabs.reduce((a, t) => a + countPanes(t.root), 0)} pane(s)`,
    value: suggestName(ws, existing),
    confirmLabel: 'Save',
    validate: (v) => (v.trim() ? null : 'Give the layout a name'),
  });
  if (!name) return;

  const clash = existing.find((l) => l.name.toLowerCase() === name.trim().toLowerCase());
  if (clash) {
    const ok = await confirm({
      title: 'Replace layout',
      message: `A layout called “${clash.name}” already exists.`,
      detail: 'Saving will overwrite it.',
      confirmLabel: 'Replace',
    });
    if (!ok) return;
  }

  const saved = await window.api.workspace.saveLayout({ name: name.trim(), workspace: ws });
  status(`Saved layout “${saved.name}”`);
  toast(`Layout “${saved.name}” saved`, 'success');
}

function suggestName(ws, existing) {
  const base = ws.tabs.length === 1 ? ws.tabs[0].title : `${ws.tabs.length} sessions`;
  if (!existing.some((l) => l.name === base)) return base;
  let n = 2;
  while (existing.some((l) => l.name === `${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Pick a saved layout and open it. */
export async function loadLayoutDialog() {
  const layouts = await window.api.workspace.listLayouts().catch(() => []);
  if (!layouts.length) {
    return toast('No saved layouts yet — use Save Layout As…', 'info');
  }

  const chosen = await modal({
    title: 'Load layout',
    subtitle: `${layouts.length} saved`,
    render: (body, { close }) => {
      const list = el('div', { class: 'picker-list' });
      for (const l of layouts) {
        const panes = l.workspace.tabs.reduce((a, t) => a + countPanes(t.root), 0);
        list.append(el('div', {
          class: 'picker-item',
          onClick: () => close(l),
        },
          el('span', { class: 'pname' }, l.name,
            l.isDefault ? el('span', { class: 'tag', style: 'margin-left:7px', text: 'default' }) : null),
          el('span', { class: 'pmeta', text: `${l.workspace.tabs.length} tabs · ${panes} panes · ${fmtDate(l.updatedAt)}` })));
      }
      body.append(list);
      body.append(el('div', { class: 'hint', style: 'margin-top:10px' },
        'Loading replaces what is open now. Each session is dialled again.'));
    },
    buttons: [{ label: 'Cancel', value: null }],
  });
  if (!chosen) return;

  if (state.tabs.length) {
    const ok = await confirm({
      title: 'Replace current sessions?',
      message: `Close ${state.tabs.length} open tab(s) and open “${chosen.name}”?`,
      detail: 'Current sessions are disconnected.',
      confirmLabel: 'Replace',
    });
    if (!ok) return;
    const { closeTab } = await import('./sessions.js');
    for (const t of [...state.tabs]) closeTab(t.id);
  }

  status(`Opening layout “${chosen.name}”…`, 0);
  await restoreWorkspace(chosen.workspace);
}

/** List, rename, delete and set a default. */
export async function manageLayouts() {
  let body = null;

  const render = async () => {
    if (!body) return;
    body.replaceChildren();
    const layouts = await window.api.workspace.listLayouts().catch(() => []);
    if (!layouts.length) {
      body.append(el('div', { class: 'sb-empty', text: 'No saved layouts yet.' }));
      return;
    }

    for (const l of layouts) {
      const panes = l.workspace.tabs.reduce((a, t) => a + countPanes(t.root), 0);
      const card = el('div', { class: 'prof-row' + (l.isDefault ? ' active' : '') },
        el('div', { class: 'prof-info' },
          el('div', { class: 'pname' }, l.name,
            l.isDefault ? el('span', { class: 'tag', style: 'margin-left:7px', text: 'opens by default' }) : null),
          el('div', { class: 'pmeta', text: `${l.workspace.tabs.length} tabs · ${panes} panes · saved ${fmtDate(l.updatedAt)}` })),
        el('button', {
          class: 'ghost-btn sm', text: 'Load',
          onClick: async () => { await loadLayoutDialogFor(l); },
        }),
        el('button', {
          class: 'ghost-btn sm', text: l.isDefault ? 'Unset default' : 'Set default',
          onClick: async () => {
            await window.api.workspace.setDefaultLayout(l.isDefault ? null : l.id);
            status(l.isDefault ? 'Default layout cleared' : `“${l.name}” opens by default`);
            render();
          },
        }),
        el('button', {
          class: 'ghost-btn sm', text: 'Rename',
          onClick: async () => {
            const name = await prompt({ title: 'Rename layout', value: l.name, confirmLabel: 'Rename' });
            if (!name) return;
            await window.api.workspace.saveLayout({ id: l.id, name: name.trim(), workspace: l.workspace });
            render();
          },
        }),
        el('button', {
          class: 'ghost-btn sm danger-btn', text: 'Delete',
          onClick: async () => {
            const ok = await confirm({
              title: 'Delete layout', message: `Delete “${l.name}”?`,
              confirmLabel: 'Delete', danger: true,
            });
            if (!ok) return;
            await window.api.workspace.deleteLayout(l.id);
            render();
          },
        }));
      body.append(card);
    }
  };

  await modal({
    title: 'Layouts',
    subtitle: 'Saved arrangements of sessions',
    width: 'min(720px, 94vw)',
    render: (b) => { body = b; render(); },
    buttons: [
      { label: 'Save current as…', onClick: ({ close }) => { close(null); saveLayoutAs(); } },
      { label: 'Close', value: null },
    ],
  });
}

export async function loadLayoutDialogFor(layout) {
  if (state.tabs.length) {
    const ok = await confirm({
      title: 'Replace current sessions?',
      message: `Close ${state.tabs.length} open tab(s) and open “${layout.name}”?`,
      confirmLabel: 'Replace',
    });
    if (!ok) return;
    const { closeTab } = await import('./sessions.js');
    for (const t of [...state.tabs]) closeTab(t.id);
  }
  await restoreWorkspace(layout.workspace);
}
