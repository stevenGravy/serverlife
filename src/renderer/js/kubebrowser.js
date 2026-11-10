import { el, clear, fmtDate, clickOrDblClick } from './util.js';
import { modal, toast, confirm, select, contextMenu, textInput, field, checkbox } from './ui.js';
import { openKubeBrowserTab } from './sessions.js';
import { Kube3D } from './kube3d.js';
import { state } from './state.js';
import { sparkline } from './monitor.js';
import { createYamlEditor } from './yamleditor.js';
import { diffLines } from './textdiff.js';
import { buildValuesYaml } from './yamlform.js';
import { detectStalledRollouts } from './alerts.js';
import { toCsv } from './csv.js';
import { askNamespace, extraNamespaces } from './kubenamespaces.js';

// The Namespace dropdown's "type one in" entry — not a name Kubernetes allows.
const TYPE_NAMESPACE = '\u0001type';

/**
 * The full cluster browser — KubeLife's own general-purpose, every-kind view.
 *
 * The one design decision worth stating: resource kinds are never
 * hardcoded. `kubectl api-resources` is asked what exists, CRDs included
 * automatically (see kuberesources.js), and the curated categories below
 * are a classification laid over that discovered list rather than a fixed
 * menu — a cluster with a CRD installed yesterday needs no release of this
 * app to browse it today. Opened from the chevron/"Open full view" on a
 * context row in the Resources tab; the sidebar's own tree stays for quick
 * navigation and exec, this is for everything else.
 *
 * Shaped after the dashboard every Kubernetes web UI already uses, on
 * purpose, rather than inventing a new layout to learn: a namespace
 * selector that scopes everything below it, a cluster-health strip with
 * the numbers you'd otherwise have to go find, and an Overview landing
 * page instead of a blank "pick something on the left."
 */

const CATEGORY_ORDER = ['Workloads', 'Config', 'Network', 'Storage', 'Access Control', 'Cluster'];

/** The kinds `kubectl port-forward` itself accepts a bare name for. */
const PORT_FORWARD_KINDS = ['Pod', 'Service', 'Deployment', 'StatefulSet', 'DaemonSet'];
/** Kinds whose name clicks through to their pods — each carries the label selector that finds them. */
const POD_PARENT_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Service'];

/** The kinds the 3D view actually renders (kube3d.js's own kind filter, minus its 'all' option) — clicking one of these in the nav tree while 3D is up filters it in place instead of leaving. */
const KIND_3D_FILTERS = ['Pod', 'Deployment', 'Service'];

/* Workload actions (see kubeops.js) — which kinds each one makes sense on. */
const SCALE_KINDS = ['Deployment', 'StatefulSet', 'ReplicaSet'];
const ROLLOUT_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet'];
// Only a Deployment's rollout can be paused/resumed — kubectl itself refuses it on the others.
const ROLLOUT_PAUSABLE_KINDS = ['Deployment'];
const CONTAINER_EDIT_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'];

// A Node's own condition types that read backwards from Ready — True means trouble, not health.
const PRESSURE_CONDITION_TYPES = new Set(['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable']);

function sortCategories(cats) {
  return cats.sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a); const ib = CATEGORY_ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
}

const PHASE_DOT = { Running: '#3fb950', Pending: '#d29922', Succeeded: '#6e8bd6', Normal: '#3fb950', Warning: '#d29922' };
function phaseDot(phase) {
  if (PHASE_DOT[phase]) return PHASE_DOT[phase];
  return /error|crash|evict|fail/i.test(phase || '') ? '#f85149' : '#6b7689';
}

/** `helm list`'s chart is `<name>-<version>` — split back apart (the same rule kubehelm.js's splitChart uses). */
function splitChart(chart) {
  const m = /^(.*)-(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)$/.exec(String(chart || ''));
  return m ? { name: m[1], version: m[2] } : { name: String(chart || ''), version: '' };
}

export async function openKubeBrowser(kubeSpec, title, opts = {}) {
  let types = [];
  let typesError = '';
  let loadingTypes = true;
  // null = Overview, 'helm' = the Helm releases list, '3d' = the 3D view, else a discovered resource type.
  let selected = ['helm', '3d', 'starred'].includes(opts.initialView) ? opts.initialView : null;
  let rows = [];
  let rowsError = '';
  let loadingRows = false;
  let collapsed = new Set();

  let namespaces = [];     // '' means "every namespace has been asked for and there are none, or it hasn't loaded yet"
  let selectedNs = opts.initialNamespace || '';     // '' = all namespaces — stays the single source of truth for every existing "give me one default namespace" use (forms, overview, 3D); chosenNs below only adds the "more than one at once" case on top
  let overview = null;     // { nodes, podsByPhase, namespaceCount } — fetched once, refreshed on demand
  // A cluster easily discovers 100+ resource kinds (CRDs included) and any
  // one kind can hold hundreds of rows — a fuzzy kind/row filter closes
  // that gap, rather than leaving it to a long scroll.
  let kindFilter = '';
  let rowFilter = '';
  const selectedKeys = new Set(); // rowKey(r) of rows checked for a bulk action, within the kind on screen

  // The browser's own namespace picker, beyond the single `selectedNs`
  // above — empty unless the user has explicitly checked more than one
  // in the checklist (`topBar()`'s nsBtn/nsMenu). `selectedNs` is kept in
  // sync (derived back to '' the moment this holds anything but exactly
  // one), so the fetch in selectType() needs no extra branch: "all
  // namespaces" already means "fetch -A," and a 2+ selection just adds a
  // client-side filter of the -A result down to this set.
  let chosenNs = new Set();
  let nsMenuOpen = false;
  // A manual label selector, free-text — merged with (and overriding) a
  // workload's own programmatic one from the "Pods" button (podScope),
  // the same `selector` param kuberesources.js's getResources() already
  // accepts and applies as kubectl's `-l`.
  let labelSelector = '';
  let labelSelectorInputEl = null;
  let labelSelectorDebounce = null;
  // Keyboard navigation for the command bar's own hotkeys below — the
  // index into whatever shownRows the resource-list panel last computed
  // (lastShownRows), since the hotkey handler lives outside that panel's
  // own render scope.
  let focusedRowIndex = -1;
  let lastShownRows = [];
  let commandBarInputEl = null;

  // Helm releases — a fixed nav entry beside the discovered kinds (Helm is
  // not a kube API resource, so it never shows up in api-resources).
  let helmReleases = [];
  let helmError = '';
  let helmLoading = false;
  let helmRowFilter = '';

  // The 3D view — created once and kept alive for the pane's lifetime
  // (see show3d()/threeDPanel() below), not rebuilt on every render() the
  // way the rest of this panel is: tearing down and recreating a WebGL
  // context on every keystroke elsewhere in the pane would lose camera
  // position and flicker for no reason. usageTimer polls `kubectl top`
  // only while this view is the one on screen.
  let kube3dView = null;
  let usageTimer = null;

  // Active port-forwards on this cluster, for the topBar's own badge — kept
  // current by push (kube:forwardUpdate) rather than polling, same as
  // kubepanel.js's sidebar copy of this state.
  let forwardCount = 0;
  const countForwards = (forwards) => (forwards || []).filter((f) => f.contextName === kubeSpec.contextName).length;
  window.api.kube.forwardList().then((r) => { forwardCount = countForwards(r?.forwards); render(); }).catch(() => {});
  window.api.kube.onForwardUpdate((r) => { forwardCount = countForwards(r?.forwards); render(); });

  /*
   * Live rows for whatever kind is currently open — kubectl get -w,
   * pushed per object (see kubewatch.js), merged into the current `rows`
   * on a short debounce so a noisy namespace doesn't thrash the table on
   * every single line. Paired in selectType() with a slower periodic
   * re-fetch: kubectl's own watch output never says a resource was
   * deleted, only that it stopped changing, so the fast path here is
   * speed on top of that reconcile, not a replacement for it.
   */
  let currentWatchId = null;
  let pendingWatchRows = null; // Map(namespace\u0001name -> row) | null
  let watchFlushTimer = null;
  const watchRowKey = (namespace, name) => `${namespace || ''}\u0001${name}`;
  /*
   * The list is redrawn only when what it holds actually changed. A watch
   * re-sends objects whose status ticked over to the same text, and the
   * periodic reconcile returns the same rows most of the time — redrawing
   * the whole table for each of those was the flicker.
   */
  const rowsSignature = (list) => JSON.stringify(list.map((r) => [
    r.namespace || '', r.name, r.status || '', r.detail || '', r.age || '', r.suspended ?? null, r.crdColumns || null,
  ]));
  const flushWatchRows = () => {
    watchFlushTimer = null;
    if (!pendingWatchRows || !pendingWatchRows.size) return;
    const byKey = new Map(rows.map((r) => [watchRowKey(r.namespace, r.name), r]));
    // A shallow merge, not a replace: a watch-pushed row never carries
    // crdColumns (that needs the CRD's own schema, fetched only by the
    // list call) or the metrics-server detail suffix — both survive here
    // from whatever the row already had until the next reconcile refreshes them.
    for (const [key, row] of pendingWatchRows) byKey.set(key, { ...byKey.get(key), ...row });
    pendingWatchRows = null;
    const merged = [...byKey.values()];
    if (rowsSignature(merged) === rowsSignature(rows)) return;
    rows = merged;
    render();
  };
  window.api.kube.onWatchData((evt) => {
    if (evt.id !== currentWatchId || !evt.row) return;
    if (!pendingWatchRows) pendingWatchRows = new Map();
    pendingWatchRows.set(watchRowKey(evt.row.namespace, evt.row.name), evt.row);
    if (!watchFlushTimer) watchFlushTimer = setTimeout(flushWatchRows, 250);
  });

  /*
   * CPU/memory history for the overview's own charts — a plain poll
   * (kubectl top has no watch mode, see kubemetrics.js), started once for
   * this tab's whole lifetime rather than per-view, and stopped the same
   * way the Log Viewer's own spawned process is (pane.klvStop, see
   * sessions.js's closePane()). History lives here, not in main.js — the
   * same split monitor.js's SSH sparklines already use.
   */
  const METRICS_HISTORY = 40;
  let metricsId = null;
  const nodeHistory = new Map(); // name -> { cpuPercent:[], memPercent:[] }
  const podHistory = new Map(); // namespace\u0001name -> { cpuM:[], memBytes:[] }
  const pushHistory = (map, key, sample, fields) => {
    if (!map.has(key)) map.set(key, Object.fromEntries(fields.map((f) => [f, []])));
    const entry = map.get(key);
    for (const f of fields) {
      entry[f].push(sample[f] ?? 0);
      if (entry[f].length > METRICS_HISTORY) entry[f].shift();
    }
  };
  window.api.kube.onMetricsData((snap) => {
    if (snap.id !== metricsId) return;
    for (const n of snap.nodes || []) pushHistory(nodeHistory, n.name, n, ['cpuPercent', 'memPercent']);
    for (const p of snap.pods || []) pushHistory(podHistory, `${p.namespace}\u0001${p.name}`, p, ['cpuM', 'memBytes']);
    if (!selected) render(); // only the Overview draws these today — no point re-rendering a kind list over it
  });

  /*
   * Stalled-rollout alerts — cluster-wide, independent of whatever kind is
   * currently selected, for as long as this pane stays open
   * (self-cancelling the same way the per-kind liveTimer above is: a
   * closed pane's own next tick just stops rather than needing an explicit
   * destroy hook). Not an always-on background monitor for a cluster
   * nobody has open — see the Section 8 plan for why that would be a
   * bigger thing than this roadmap item asked for.
   *
   * Crash-loop popups used to live here too, but a pod cycling through
   * CrashLoopBackOff repeats every poll — it briefly leaves the state on
   * each restart, which cleared the dedup key, so a flapping pod (or, on a
   * shared cluster, several at once) kept re-popping every ~30s. A stalled
   * rollout doesn't flap the same way (5+ minutes not-ready, checked
   * against when it was first seen that way), so it keeps its popup;
   * CrashLoopBackOff is still visible wherever a pod's own status already
   * shows it — just not as an interruption.
   */
  const rolloutSeenSince = new Map();
  const alertedKeys = new Set();
  let alertTimer = null;
  const checkAlerts = async () => {
    if (!body?.isConnected) { if (alertTimer) { clearInterval(alertTimer); alertTimer = null; } return; }
    const [deploys, statefulSets] = await Promise.all([
      window.api.kube.resources({ spec: kubeSpec, type: { name: 'deployments', namespaced: true } }).catch(() => null),
      window.api.kube.resources({ spec: kubeSpec, type: { name: 'statefulsets', namespaced: true } }).catch(() => null),
    ]);
    const now = Date.now();
    const workloads = [
      ...(deploys?.ok ? deploys.items.map((r) => ({ ...r, kind: 'Deployment' })) : []),
      ...(statefulSets?.ok ? statefulSets.items.map((r) => ({ ...r, kind: 'StatefulSet' })) : []),
    ];
    const stalled = detectStalledRollouts(workloads, now, rolloutSeenSince, 300000);
    for (const w of stalled) {
      const key = `stalled/${w.kind}/${w.namespace}/${w.name}`;
      if (alertedKeys.has(key)) continue;
      alertedKeys.add(key);
      notifyAlert(`${w.name} rollout looks stalled`, `${w.namespace} — not ready for over 5 minutes`, true);
    }
    const stillStalled = new Set(stalled.map((w) => `stalled/${w.kind}/${w.namespace}/${w.name}`));
    for (const key of [...alertedKeys]) if (!stillStalled.has(key)) alertedKeys.delete(key);
  };
  const notifyAlert = (title, body2, bad) => {
    toast(`${title} — ${body2}`, bad ? 'error' : 'info', 6000);
    if (!document.hasFocus() && typeof Notification !== 'undefined') {
      try { new Notification(`ServerLife — ${title}`, { body: body2, silent: !bad }); } catch { /* notifications not available/allowed — the toast above already said it */ }
    }
  };
  const startAlerts = () => { if (alertTimer) return; checkAlerts(); alertTimer = setInterval(checkAlerts, 30000); };

  let body = null;
  // The pane this browser draws into, which also carries what it is showing
  // — the cluster and the view — so a saved layout can reopen it as itself
  // (see workspace.js) rather than as a plain local shell.
  let browserPane = null;
  /**
   * A keyboard command bar: `:name` jumps to a resource kind, `/text`
   * (or bare text) filters the current rows — the exact same
   * `rowFilter` state the sidebar's own row-filter input already
   * drives, just a second way in.
   */
  const runCommand = (text) => {
    const v = text.trim();
    if (!v) return;
    if (v.startsWith(':')) {
      const q = v.slice(1).trim().toLowerCase();
      if (!q) return;
      const match = types.find((t) => t.kind.toLowerCase() === q) || types.find((t) => t.kind.toLowerCase().includes(q));
      if (!match) { toast(`No resource kind matches "${q}"`, 'error'); return; }
      selectType(match);
      return;
    }
    rowFilter = v.startsWith('/') ? v.slice(1) : v;
    render();
  };

  const commandBar = () => {
    if (!commandBarInputEl) {
      commandBarInputEl = textInput({ placeholder: ':kind to jump · /text to filter · Enter to run' });
      commandBarInputEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        runCommand(commandBarInputEl.value);
        commandBarInputEl.value = '';
      });
    }
    return el('div', {
      style: 'display:flex;align-items:center;gap:6px;padding:4px 8px;border-top:1px solid var(--border-soft);'
        + 'background:var(--panel-2);font-family:var(--mono);font-size:12px',
    }, el('span', { style: 'color:var(--muted)' }, ':', '/'), commandBarInputEl);
  };

  /**
   * Hotkeys, scoped to this pane having focus and no text field being
   * typed into — ↑/↓ moves `focusedRowIndex` through whatever the
   * resource-list panel last computed (lastShownRows, since that panel's
   * own render scope is a different function from this one); the rest
   * are the same actions the row's own buttons already run, just bound
   * to a key.
   */
  const isTypingTarget = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  const onPaneKeydown = (e) => {
    if (isTypingTarget() || !selected || typeof selected === 'string') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); focusedRowIndex = Math.min(lastShownRows.length - 1, focusedRowIndex + 1); render(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); focusedRowIndex = Math.max(0, focusedRowIndex - 1); render(); return; }
    const r = lastShownRows[focusedRowIndex];
    if (!r) return;
    if (e.key === 'Enter' || e.key === 'd') { e.preventDefault(); viewDetails(r); }
    else if (e.key === 'l' && selected.kind === 'Pod') {
      e.preventDefault();
      if ((r.containers?.length || 1) > 1) { toast('Use the Logs button for a multi-container pod', 'error'); return; }
      logsRow(null, r, { dir: 'col' });
    } else if (e.key === 'x') { e.preventDefault(); deleteRow(r); }
  };

  const render = () => {
    if (!body) return;
    if (browserPane) browserPane.kubeView = typeof selected === 'string' ? selected : (selected?.name ? { kind: selected.name } : null);
    clear(body);
    const wrapper = el('div', { tabindex: '-1', style: 'display:flex;flex-direction:column;height:100%;gap:8px;outline:none' },
      topBar(),
      el('div', { class: 'kube-browser' },
        el('div', { class: 'kube-browser-nav' }, navTree()),
        el('div', { class: 'kube-browser-main' }, mainPanel())),
      commandBar());
    wrapper.addEventListener('keydown', onPaneKeydown);
    body.append(wrapper);
  };

  /*
   * Sortable, resizable columns — shared by the resource browser's rows and
   * the Helm releases list, since both want the exact same thing. State
   * lives per table id in this closure, not inside renderTable() itself:
   * render() clears and rebuilds the whole panel on almost every
   * interaction (same reasoning as kindFilterInputEl/rowFilterInputEl
   * below), so anything renderTable() needs to survive that has to live
   * one level up.
   */
  const tableState = new Map(); // id -> { sortKey, sortDir, widths }
  // A width per column is null until someone drags it: null means "fit
  // the content", worked out again on every render from the rows shown.
  const tableStateFor = (id, columns) => {
    const key = `${id}:${columns.map((c) => c.key).join(',')}`;
    if (!tableState.has(key)) {
      let widths = null;
      try { widths = JSON.parse(localStorage.getItem(`sl.kubetable.${key}`) || 'null'); } catch { /* fresh defaults */ }
      if (!Array.isArray(widths) || widths.length !== columns.length) widths = columns.map(() => null);
      tableState.set(key, { key, sortKey: null, sortDir: 1, widths });
    }
    return tableState.get(key);
  };

  /*
   * Column widths that match what is in them: the header and the widest
   * cell, measured in the table's own font, within a floor and a ceiling —
   * fixed defaults had a three-letter status sitting in 110px and a short
   * name in 220. The Name column may grow further than the rest; anything
   * longer than its ceiling truncates with an ellipsis as before.
   */
  let measureCtx = null;
  const textWidth = (text, bold = false) => {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
    measureCtx.font = `${bold ? '600 ' : ''}12px ${font}`;
    return measureCtx.measureText(String(text ?? '')).width;
  };
  const fitWidths = (columns, rows) => columns.map((c) => {
    const cellText = c.text || ((r) => r[c.key]);
    let w = textWidth(c.label, true) + 18; // room for the sort arrow
    for (const r of rows.slice(0, 500)) w = Math.max(w, textWidth(cellText(r)) + (c.extra || 0));
    const cap = c.key === 'name' ? 360 : 280;
    return Math.round(Math.min(cap, Math.max(48, w + 14)));
  });
  const saveWidths = (id, widths) => {
    try { localStorage.setItem(`sl.kubetable.${id}`, JSON.stringify(widths)); } catch { /* not persisted this time */ }
  };

  /**
   * `columns`: `[{key, label, width}]` for the data columns — the actions
   * column is always last, always `max-content`, never sorted or resized
   * (shrinking it below its buttons would just make them wrap/clip again,
   * the exact bug this exists to fix). `renderRow(row)` builds one full
   * `<div class="kube-row">` with `columns.length + 1` cells — the data
   * cells in the given order, then one actions cell — exactly like every
   * row already did; this only adds the shared grid template, click-to-sort
   * headers and drag-to-resize handles around that.
   */
  const renderTable = ({ id, columns, rows: tableRows, renderRow }) => {
    const st = tableStateFor(id, columns);
    const fitted = fitWidths(columns, tableRows);
    const widthAt = (i) => (st.widths[i] == null ? fitted[i] : st.widths[i]);
    // A dragged column keeps its width; the rest fit what they hold now.
    const template = () => columns.map((_, i) => `${Math.max(40, Math.round(widthAt(i)))}px`).join(' ') + ' max-content';

    const sorted = tableRows.slice();
    if (st.sortKey) {
      sorted.sort((a, b) => {
        const av = a[st.sortKey] ?? '';
        const bv = b[st.sortKey] ?? '';
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return cmp * st.sortDir;
      });
    }

    const head = el('div', { class: 'kube-row kube-head', style: `grid-template-columns:${template()}` },
      ...columns.map((c, i) => {
        const active = st.sortKey === c.key;
        const resizer = el('div', { class: 'kube-th-resizer' });
        const cell = el('span', { style: 'position:relative' },
          el('div', {
            class: 'kube-th',
            onClick: () => {
              if (st.sortKey === c.key) st.sortDir *= -1; else { st.sortKey = c.key; st.sortDir = 1; }
              render();
            },
          },
            el('span', { text: c.label }),
            active ? el('span', { class: 'arrow', text: st.sortDir > 0 ? '▲' : '▼' }) : null),
          resizer);
        resizer.addEventListener('pointerdown', (e) => {
          e.preventDefault(); e.stopPropagation();
          resizer.classList.add('active');
          const startX = e.clientX; const startW = widthAt(i);
          const onMove = (ev) => {
            st.widths[i] = Math.max(40, startW + (ev.clientX - startX));
            const t = template();
            head.style.gridTemplateColumns = t;
            for (const r of body.querySelectorAll(`[data-kubetable="${id}"]`)) r.style.gridTemplateColumns = t;
          };
          const onUp = () => {
            resizer.classList.remove('active');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            saveWidths(st.key, st.widths);
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        });
        // Double-click the handle: back to fitting the content.
        resizer.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          st.widths[i] = null;
          saveWidths(st.key, st.widths);
          render();
        });
        resizer.title = 'Drag to resize · double-click to fit the content';
        return cell;
      }),
      el('span', {}));

    const bodyRows = sorted.map((r) => {
      const row = renderRow(r);
      row.dataset.kubetable = id;
      row.style.gridTemplateColumns = template();
      return row;
    });
    return [head, ...bodyRows];
  };

  /** Namespace selector + the cluster-health strip every k8s dashboard leads with. */
  const topBar = () => {
    // A namespace change is a refresh, not leaving the scope a "Pods"
    // button (or the label-selector input below) set — losing it on
    // every namespace click would make the scope feel accidental rather
    // than something that stays until cleared on purpose.
    const refreshForNamespace = () => {
      if (selected === 'helm') loadHelm();
      else if (selected === '3d') load3dScene();
      else if (selected) selectType(selected, podScope ? { selector: podScope.selector, scopeLabel: podScope.label } : {});
    };
    // Typed-in namespaces (and the context's own default) sit beside the
    // listed ones — a role scoped to one namespace lists none at all, and
    // a selected name missing from the options would show as "All".
    const extra = extraNamespaces(kubeSpec.contextName, namespaces, opts.contextNamespace);
    if (selectedNs && !namespaces.includes(selectedNs) && !extra.includes(selectedNs)) extra.push(selectedNs);
    const nsSel = select(
      [{ value: '', label: 'All namespaces' }, ...[...namespaces, ...extra].map((n) => ({ value: n, label: n })),
        { value: TYPE_NAMESPACE, label: 'Type a namespace…' }],
      selectedNs,
    );
    nsSel.addEventListener('change', async () => {
      if (nsSel.value === TYPE_NAMESPACE) {
        nsSel.value = selectedNs;
        const ns = await askNamespace(kubeSpec.contextName);
        if (!ns) return;
        chosenNs.clear(); chosenNs.add(ns);
        selectedNs = ns;
        // A cluster-wide pod count the role could not read is worth asking
        // again now there is a namespace to ask it in.
        if (overview && overview.podsError) loadOverview();
        refreshForNamespace();
        render();
        return;
      }
      chosenNs.clear();
      selectedNs = nsSel.value;
      if (selectedNs) chosenNs.add(selectedNs);
      refreshForNamespace();
    });
    // Picking several at once — kubectl has no multi -n, so 2+ chosen
    // still fetches -A (selectedNs derives back to '' the moment this
    // holds anything but exactly one) and selectType()'s own shownRows
    // computation narrows the result to this set client-side.
    const nsBtn = el('button', {
      class: 'ghost-btn sm' + (chosenNs.size > 1 ? ' active' : ''),
      text: chosenNs.size > 1 ? `${chosenNs.size} namespaces…` : 'Pick several…',
      title: 'Choose more than one namespace at once',
      onClick: () => { nsMenuOpen = !nsMenuOpen; render(); },
    });
    const nsMenu = nsMenuOpen ? el('div', {
      style: 'position:absolute;top:30px;left:0;z-index:50;background:var(--panel);border:1px solid var(--border-soft);'
        + 'border-radius:6px;padding:8px;min-width:180px;max-height:260px;overflow:auto;box-shadow:0 4px 16px rgba(0,0,0,.35)',
    },
      el('button', {
        class: 'ghost-btn sm', text: 'All namespaces', style: 'margin-bottom:6px;width:100%',
        onClick: () => { chosenNs.clear(); selectedNs = ''; nsMenuOpen = false; refreshForNamespace(); render(); },
      }),
      ...[...namespaces, ...extra].map((n) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = chosenNs.has(n);
        cb.addEventListener('change', () => {
          if (cb.checked) chosenNs.add(n); else chosenNs.delete(n);
          selectedNs = chosenNs.size === 1 ? [...chosenNs][0] : '';
          refreshForNamespace();
          render();
        });
        return el('label', { style: 'display:flex;gap:6px;align-items:center;padding:2px 0;cursor:pointer;white-space:nowrap' }, cb, el('span', { text: n }));
      })) : null;

    // A manual -l selector, merged with (and overriding) a workload's own
    // programmatic one from the "Pods" button — the same `selector` param
    // selectType()/getResources() already accept and apply.
    if (!labelSelectorInputEl) {
      labelSelectorInputEl = textInput({ style: 'width:220px', placeholder: 'Label selector — app=foo,env=prod' });
      labelSelectorInputEl.addEventListener('input', () => {
        labelSelector = labelSelectorInputEl.value;
        if (labelSelectorDebounce) clearTimeout(labelSelectorDebounce);
        labelSelectorDebounce = setTimeout(() => {
          if (!selected || typeof selected === 'string') return;
          const sel = labelSelector.trim() || null;
          selectType(selected, sel ? { selector: sel, scopeLabel: sel } : {});
        }, 500);
      });
    }
    if (labelSelectorInputEl.value !== labelSelector) labelSelectorInputEl.value = labelSelector;

    const statUnreadable = (label, err) => {
      const n = stat(label, '—', null);
      n.title = `${unreadable(err)}: ${err}`;
      n.append(el('span', { style: 'color:var(--muted);margin-left:4px;font-style:italic', text: `(${unreadable(err)})` }));
      return n;
    };
    const stat = (label, value, color, onClick = null) => el('div', {
      class: 'kube-stat', style: onClick ? 'cursor:pointer' : null,
      title: onClick ? `Show which ${label}` : null, onClick,
    },
      color ? el('span', { style: `width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;margin-right:5px` }) : null,
      el('span', { style: 'font-weight:600', text: String(value) }),
      el('span', { style: 'color:var(--muted);margin-left:4px', text: label }));

    const stats = overview ? el('div', { style: 'display:flex;gap:14px;align-items:center;flex-wrap:wrap' },
      overview.nodes.error ? statUnreadable('nodes', overview.nodes.error) : stat('nodes', overview.nodes.total, null),
      overview.nodes.notReady ? stat('not ready', overview.nodes.notReady, '#f85149',
        () => listOverviewItems('Nodes not ready', 'nodes', overview.nodeItems.filter((n) => !/\bReady\b/.test(n.status || '')))) : null,
      overview.namespacesError ? statUnreadable('namespaces', overview.namespacesError) : stat('namespaces', namespaces.length, null),
      ...Object.entries(overview.podsByPhase).map(([phase, n]) => stat(phase.toLowerCase(), n, phaseDot(phase),
        () => listOverviewItems(`${phase} pods`, 'pods', overview.podItems.filter((p) => (p.status || 'Unknown') === phase)))),
    ) : el('div', { style: 'color:var(--muted);font-size:12px', text: overviewError || 'Loading cluster overview…' });

    return el('div', { style: 'display:flex;align-items:center;gap:16px;padding:2px 2px 8px;border-bottom:1px solid var(--border-soft)' },
      el('div', { style: 'display:flex;align-items:center;gap:6px;position:relative' },
        el('span', { style: 'color:var(--muted);font-size:12px', text: 'Namespace' }), nsSel, nsBtn, nsMenu),
      el('div', { style: 'display:flex;align-items:center;gap:6px' },
        el('span', { style: 'color:var(--muted);font-size:12px', text: 'Labels' }), labelSelectorInputEl),
      stats,
      el('div', { style: 'margin-left:auto;display:flex;gap:6px' },
        el('button', {
          class: 'ghost-btn sm', text: '+ New',
          title: 'Apply a YAML manifest, or a quick namespace/pod without writing one by hand',
          onClick: (e) => contextMenu(e.clientX, e.clientY, [
            { label: 'Apply YAML…', onClick: () => applyYamlFlow('Apply YAML') },
            { label: 'Build from Kustomization…', onClick: () => openKustomizeBuildFlow() },
            { label: 'New Namespace…', onClick: () => openNewNamespaceDialog() },
            { label: 'New Pod…', onClick: () => openNewPodDialog() },
            { label: 'New Deployment…', onClick: () => openCreateResourceDialog('Deployment') },
            { label: 'New Service…', onClick: () => openCreateResourceDialog('Service') },
            { label: 'New ConfigMap…', onClick: () => openCreateResourceDialog('ConfigMap') },
            { label: 'New Secret…', onClick: () => openCreateResourceDialog('Secret') },
            { label: 'Map a Teleport group to a ClusterRole…', onClick: () => openGroupMappingWizard() },
            { label: 'New Role…', onClick: () => openCreateResourceDialog('Role') },
            { label: 'New ClusterRole…', onClick: () => openCreateResourceDialog('ClusterRole') },
            { label: 'New RoleBinding…', onClick: () => openCreateResourceDialog('RoleBinding') },
            { label: 'New ClusterRoleBinding…', onClick: () => openCreateResourceDialog('ClusterRoleBinding') },
            { sep: true },
            // The same wizard a local context's own menu opens — here too, so
            // enrolling the cluster you are looking at is not a trip back to
            // the sidebar. Allowed on a Teleport-reached one as well: the
            // point may be adding app/discovery to it.
            {
              label: 'Install Teleport agent…',
              title: kubeSpec.teleportProxy
                ? `Already reached through ${kubeSpec.teleportProxy} — this installs another agent (e.g. for app or discovery)`
                : 'teleport-kube-agent via Helm: puts this cluster behind Teleport, with app and discovery if wanted',
              onClick: async () => (await import('./kubepanel.js')).openInstallTeleportWizard({
                kubeconfigPaths: kubeSpec.kubeconfigPaths, contextName: kubeSpec.contextName,
                name: title || kubeSpec.contextName, kubeClusterName: null,
              }),
            },
          ]),
        }),
        forwardCount ? el('button', {
          class: 'ghost-btn sm', text: `⇄ ${forwardCount} active`, title: 'Active port-forwards on this cluster — click to manage',
          onClick: async () => (await import('./kubepanel.js')).showActivePortForwards({ contextName: kubeSpec.contextName }),
        }) : null,
        el('button', {
          class: 'ghost-btn sm', text: 'My access', title: 'Who this cluster sees you as, your groups, and what you can do — kubectl auth can-i',
          onClick: () => openAccessModal(),
        }),
        el('button', {
          class: 'ghost-btn sm', text: 'Request namespace/pod access…',
          title: kubeSpec.teleportProxy
            ? 'Ask for a namespace or pod you cannot see yet here — already scoped to this cluster'
            : 'Not reached through Teleport — nothing to request here',
          disabled: !kubeSpec.teleportProxy,
          onClick: () => requestKubeResourceAccess(),
        }),
        el('button', {
          class: 'ghost-btn sm', text: 'Scan cluster…', title: 'A Popeye lint — misconfigurations and common risks, not a deep vulnerability scan',
          onClick: () => openScanModal(),
        }),
        el('button', {
          class: 'ghost-btn sm', text: 'Search open clusters…', title: 'Look for a resource across every cluster tab already open',
          onClick: () => openCrossClusterSearch(),
        }),
        el('button', {
          class: 'ghost-btn sm', text: 'Compare…', title: 'Diff one resource between two open cluster tabs',
          onClick: () => openCompareClusters(),
        }),
        // The overview and, when a kind is open, its list too — refreshing only
        // the strip left the rows you were looking at as stale as before.
        el('button', {
          class: 'ghost-btn sm', text: '⟳ Refresh', title: 'Re-read the overview and the list on screen',
          onClick: () => {
            loadOverview();
            if (selected === 'helm') loadHelm();
            else if (selected === '3d') load3dScene();
            else if (selected) refreshScoped();
          },
        })));
  };

  let overviewError = '';
  // `kubectl top`, fetched beside the overview rather than inside it: it is
  // metrics-server's to answer, slower, and allowed to fail on its own.
  let usage = null; // { loading } | { nodes, pods } — see kuberesources.top()
  const loadUsage = () => {
    usage = { loading: true };
    window.api.kube.top({ spec: kubeSpec, target: { namespace: selectedNs || undefined } })
      .then((r) => { usage = r; })
      .catch((e) => { usage = { error: e.message }; })
      .finally(() => render());
  };
  /** Why a count is missing, in two words — the full error is on hover. */
  const unreadable = (err) => (/none your role can see/.test(err || '') ? 'none your role can see'
    : /forbidden|cannot (list|get|watch)|can't list|not allowed|unauthori[sz]ed|isn't letting you in/i.test(err || '') ? 'no permission to list' : "couldn't read");

  const loadOverview = async () => {
    overview = null; overviewError = '';
    loadUsage();
    render();
    try {
      // What the lists themselves return — never can-i's opinion of them,
      // which through Teleport says "no" to lists that work (see selectType).
      // A list that fails shows "—" and why, never a 0.
      const [nsRes, nodeRes, podResAll] = await Promise.all([
        window.api.kube.namespaces(kubeSpec),
        window.api.kube.resources({ spec: kubeSpec, type: { name: 'nodes', namespaced: false } }),
        window.api.kube.resources({ spec: kubeSpec, type: { name: 'pods', namespaced: true } }),
      ]);
      namespaces = nsRes.ok ? (nsRes.namespaces || []).slice().sort() : namespaces;
      // Nothing listed and nothing chosen: a namespace-scoped role sees an
      // empty cluster under "All namespaces". Start it in the namespace it
      // was last typed into, or its kubeconfig context's own default.
      if (!selectedNs && !namespaces.length) {
        const fallback = extraNamespaces(kubeSpec.contextName, [], opts.contextNamespace)[0];
        if (fallback) {
          selectedNs = fallback; chosenNs.clear(); chosenNs.add(fallback);
          if (selected === 'helm') loadHelm();
          else if (selected === '3d') load3dScene();
          else if (selected && typeof selected === 'object') selectType(selected);
        }
      }
      // A role that may not list pods cluster-wide may still list them in
      // the namespace on screen — the count from there beats a "—".
      const podRes = !podResAll.ok && selectedNs
        ? await window.api.kube.resources({ spec: kubeSpec, type: { name: 'pods', namespaced: true, namespace: selectedNs } })
        : podResAll;
      /*
       * Teleport does not refuse a list a role cannot see — it returns it
       * empty, filtered to what the role covers. So only an *empty* answer
       * is worth a second question: can-i, asked then, tells "none your role
       * can see" from "none there". It never overrules a list that has rows.
       */
      const hiddenFromRole = async (res, resource) => {
        if (!res.ok || (res.items || res.namespaces || []).length) return false;
        const can = await window.api.kube.canI({ spec: kubeSpec, target: { verb: 'list', resource } }).catch(() => null);
        return !!(can && can.allowed === false && !can.unknown);
      };
      const [nodesHidden, nsHidden] = await Promise.all([hiddenFromRole(nodeRes, 'nodes'), hiddenFromRole(nsRes, 'namespaces')]);
      const nodeItems = nodeRes.ok ? nodeRes.items : [];
      const podItems = podRes.ok ? podRes.items : [];
      const podsByPhase = {};
      for (const p of podItems) podsByPhase[p.status || 'Unknown'] = (podsByPhase[p.status || 'Unknown'] || 0) + 1;
      overview = {
        nodes: {
          total: nodeItems.length, notReady: nodeItems.filter((n) => !/\bReady\b/.test(n.status || '')).length,
          // A list that could not be read is not an empty one: "0 nodes" on a
          // role that may not list nodes read as a cluster with no nodes.
          error: nodesHidden ? 'none your role can see' : (nodeRes.ok ? null : (nodeRes.error || 'could not list nodes')),
        },
        namespacesError: nsHidden ? 'none your role can see' : (nsRes.ok ? null : (nsRes.error || 'could not list namespaces')),
        podsError: podRes.ok ? null : (podRes.error || 'could not list pods'),
        podsByPhase,
        // Kept so a card can answer "which ones?" without another fetch.
        podItems, nodeItems,
      };
      if (!nsRes.ok) overviewError = nsRes.error || '';
    } catch (e) { overviewError = e.message; }
    render();
  };

  // A persistent input, not a fresh one built by render() every keystroke —
  // render() clears and rebuilds the whole panel on every state change, and
  // a brand new <input> each time would drop focus and the cursor after
  // every single character typed into it.
  let kindFilterInputEl = null;
  const kindSearch = () => {
    if (!kindFilterInputEl) {
      kindFilterInputEl = textInput({ value: kindFilter, placeholder: 'Filter kinds — pod, config, cert…' });
      // render() clears and rebuilds the whole panel, which blurs whatever
      // was focused the instant its container is torn down — reusing the
      // same <input> object survives the rebuild, but still needs refocusing
      // (and its caret restoring) once the rebuild has put it back.
      kindFilterInputEl.addEventListener('input', () => {
        kindFilter = kindFilterInputEl.value;
        const pos = kindFilterInputEl.selectionStart;
        render();
        kindFilterInputEl.focus();
        kindFilterInputEl.setSelectionRange(pos, pos);
      });
    }
    if (kindFilterInputEl.value !== kindFilter) kindFilterInputEl.value = kindFilter;
    return el('div', { style: 'padding:4px 2px 8px' }, kindFilterInputEl);
  };

  /*
   * A kind can be starred too — "Pods" itself, not one pod — and a starred
   * kind is pinned under ★ Starred at the top of this list, so the few kinds
   * someone actually lives in are one click away on a cluster with 100+.
   */
  const kindStarsAll = () => state.settings.kubeStarKinds || {};
  const kindStars = () => kindStarsAll()[starKey] || [];
  const toggleKindStar = async (t) => {
    const on = kindStars().includes(t.name);
    const list = on ? kindStars().filter((n) => n !== t.name) : [...kindStars(), t.name];
    state.settings = await window.api.settings.set({ kubeStarKinds: { ...kindStarsAll(), [starKey]: list } });
    render();
  };
  const kindStarToggle = (t) => {
    const on = kindStars().includes(t.name);
    return el('span', {
      class: 'kind-star' + (on ? ' on' : ''), text: on ? '★' : '☆',
      title: on ? `Unpin ${t.kind} from Starred` : `Pin ${t.kind} under Starred`,
      onClick: (e) => { e.stopPropagation(); toggleKindStar(t); },
    });
  };
  const kindItem = (t) => el('div', {
          class: 'sb-item' + ((selected === t || (selected === '3d' && kube3dView?.kindFilter === t.kind)) ? ' current' : ''),
          title: `${t.kind} (${t.apiVersion})`,
          // While the 3D view is up, a kind it actually renders (Pod,
          // Deployment, Service) filters it in place — same effect as its
          // own kind dropdown — rather than silently abandoning 3D for the
          // flat table the moment anything in this list gets clicked.
          // Anything 3D has no shape for still leaves it; there's nothing
          // else a click on ConfigMap/Node/etc. could sensibly do there.
          onClick: async () => {
            if (selected === '3d' && kube3dView) {
              if (KIND_3D_FILTERS.includes(t.kind)) {
                kube3dView.kindFilter = t.kind;
                kube3dView.kindSel.value = t.kind;
                localStorage.setItem('sl.kube3d.kind', t.kind);
                kube3dView.rebuild(kube3dView._lastScene);
                render();
                return;
              }
              // Not one of the kinds 3D renders — leaving is the only
              // option, but not a silent one: say so and let it be
              // cancelled, the same courtesy navigating away from any
              // other unsaved state in this app already gets.
              const sure = await confirm({
                title: 'Leave the 3D view?',
                message: `${t.kind} isn't shown in the 3D view — viewing it switches to the regular list.`,
                confirmLabel: 'Switch',
              });
              if (!sure) return;
            }
            selectType(t);
          },
        }, el('span', { class: 'st', style: 'background:var(--accent)' }), el('span', { class: 'name', text: t.kind }), kindStarToggle(t));

  const navTree = () => {
    if (loadingTypes) return el('div', {}, kindSearch(), el('div', { class: 'sb-empty', text: 'Discovering resource types…' }));
    if (typesError) return el('div', {}, kindSearch(), NO_ACCESS_RE.test(typesError) ? noAccessPanel(typesError) : el('div', { class: 'sb-empty', text: typesError }));
    const q = kindFilter.trim().toLowerCase();
    const matching = q ? types.filter((t) => t.kind.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)) : types;
    const byCat = new Map();
    for (const t of matching) {
      if (!byCat.has(t.category)) byCat.set(t.category, []);
      byCat.get(t.category).push(t);
    }
    const cats = sortCategories([...byCat.keys()]);
    return el('div', {},
      kindSearch(),
      q ? null : el('div', {
        class: 'sb-item' + (!selected ? ' current' : ''),
        onClick: () => { stopLive(); selected = null; podScope = null; render(); },
      }, el('span', { class: 'st', style: 'background:var(--accent)' }), el('span', { class: 'name', text: '⌂ Overview' })),
      q ? null : el('div', {
        class: 'sb-item' + (selected === 'starred' ? ' current' : ''),
        onClick: selectStarred,
      }, el('span', { class: 'st', style: 'background:var(--amber)' }), el('span', { class: 'name', text: '★ Starred' }),
        stars().length ? el('span', { class: 'sb-subhead-n', text: String(stars().length) }) : null),
      // Starred kinds, pinned right here — the same entry each has in its
      // category below, so a click does exactly what it does there.
      ...(q ? [] : kindStars().map((n) => types.find((t) => t.name === n)).filter(Boolean)
        .sort((a, b) => a.kind.localeCompare(b.kind)).map((t) => {
          const item = kindItem(t);
          item.style.paddingLeft = '22px';
          return item;
        })),
      // Not a discovered kind — Helm releases never show up in
      // api-resources, so this is a fixed entry rather than something that
      // could be found by the kind filter above.
      q ? null : el('div', {
        class: 'sb-item' + (selected === 'helm' ? ' current' : ''),
        onClick: selectHelm,
      }, el('span', { class: 'st', style: 'background:var(--accent)' }), el('span', { class: 'name', text: '⎈ Helm releases' })),
      // Also fixed, same reasoning — and never inside a modal (see
      // kube3d.js's own doc comment for why that mattered).
      q ? null : el('div', {
        class: 'sb-item' + (selected === '3d' ? ' current' : ''),
        onClick: select3d,
      }, el('span', { class: 'st', style: 'background:var(--accent)' }), el('span', { class: 'name', text: '🧊 3D view' })),
      q && !cats.length ? el('div', { class: 'sb-empty', text: 'No resource kind matches that.' }) : null,
      ...cats.map((cat) => {
        const list = byCat.get(cat).sort((a, b) => a.kind.localeCompare(b.kind));
        // A search result stays open regardless of the category's own
        // remembered state — collapsing the one place the match lives
        // would make the search box look like it found nothing.
        const isOpen = q ? true : !collapsed.has(cat);
        const head = el('div', {
          class: 'sb-subhead', style: 'cursor:pointer',
          onClick: () => { isOpen ? collapsed.add(cat) : collapsed.delete(cat); render(); },
        }, el('span', { class: 'chev', text: isOpen ? '▼' : '▶' }), el('span', { text: cat }),
          el('span', { class: 'sb-subhead-n', text: String(list.length) }));
        if (!isOpen) return head;
        return el('div', {}, head, ...list.map((t) => kindItem(t)));
      }));
  };

  // Every kind's list view is live now: a watch for the fast path (set up
  // in selectType(), merged by onWatchData() above), and this periodic
  // reconcile — the exact same fetch, repeated — for the one thing a
  // watch's own text output can never say, that something is gone.
  // Self-cancelling: a pane that has since closed just stops on its own
  // next tick rather than needing an explicit destroy hook wired all the
  // way through openKubeBrowserTab.
  let liveTimer = null;
  const stopLive = () => {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    if (currentWatchId) { const id = currentWatchId; currentWatchId = null; window.api.kube.watchStop({ id }).catch(() => {}); }
    if (watchFlushTimer) { clearTimeout(watchFlushTimer); watchFlushTimer = null; }
    pendingWatchRows = null;
  };

  // Set only by "Pods" on a Deployment/ReplicaSet/StatefulSet/DaemonSet row
  // — the other direction from "jump to owner": not tracing one pod back
  // to what made it, but asking a workload which pods are its own.
  let podScope = null; // { label, selector } | null

  /*
   * The periodic re-read behind the live rows. Not selectType(): that is
   * "open this kind" — it empties the list to Loading…, clears the filter,
   * the ticked rows and the keyboard focus — and calling it on a timer made
   * the table blink every 30 seconds and quietly threw away whatever had
   * been typed or ticked. This fetches in the background and swaps the rows
   * in only when they differ; a failed re-read keeps the list it has.
   */
  const fetchRows = (t, selector) => {
    const isCrd = !!t.category?.startsWith?.('Custom Resources');
    return window.api.kube.resources({
      spec: kubeSpec,
      type: {
        name: t.name, namespaced: t.namespaced, namespace: t.namespaced ? (selectedNs || undefined) : undefined, selector,
        apiVersion: isCrd ? t.apiVersion : undefined,
      },
    });
  };
  let reconciling = false;
  const reconcileRows = async (t, selector) => {
    if (reconciling || selected !== t) return;
    reconciling = true;
    try {
      const r = await fetchRows(t, selector).catch(() => null);
      // Moved on while it was in flight, or the read failed: leave things be.
      if (selected !== t || !r?.ok) return;
      if (rowsSignature(r.items) === rowsSignature(rows) && !rowsError) return;
      rows = r.items;
      rowsError = '';
      render();
    } finally { reconciling = false; }
  };

  const selectType = async (t, { selector = null, scopeLabel = null } = {}) => {
    stopLive();
    selected = t;
    loadingRows = true;
    rows = [];
    rowsError = '';
    // A filter from the last kind viewed means nothing on this one.
    rowFilter = '';
    selectedKeys.clear();
    focusedRowIndex = -1;
    podScope = selector ? { label: scopeLabel, selector } : null;
    render();
    /*
     * No `kubectl auth can-i` before the list. Through Teleport it answers
     * "no" for things the list itself returns — namespaces, and any kind
     * across every namespace — because it asks for a cluster-wide grant the
     * role does not have while Teleport filters the real list to what the
     * role covers. The list is the answer: if it fails, its own error (put
     * in a sentence, with the request buttons when access is the problem)
     * says why.
     */
    try {
      const r = await fetchRows(t, selector);
      if (!r.ok) rowsError = r.error || 'Could not list that resource';
      else rows = r.items;
    } catch (e) { rowsError = e.message; }
    loadingRows = false;
    render();
    // Events were already worth a 10s poll on their own; everything else
    // gets the slower reconcile now that a watch covers the fast path.
    liveTimer = setInterval(() => {
      if (!body?.isConnected) { stopLive(); return; }
      reconcileRows(t, selector);
    }, t.kind === 'Event' ? 10000 : 30000);
    try {
      const wr = await window.api.kube.watchStart({
        spec: kubeSpec, kind: t.name, namespaced: t.namespaced,
        namespace: t.namespaced ? (selectedNs || undefined) : undefined, selector: selector || undefined,
      });
      // Live rows are an addition on top of the reconcile above, not a
      // requirement — a cluster or role that refuses `-w` still works,
      // just on a 30s cadence instead of instantly.
      if (wr?.ok) currentWatchId = wr.id;
    } catch { /* same: the periodic reconcile already has this covered */ }
  };

  /*
   * An empty list through Teleport is often "nothing your role can see",
   * not "nothing there" — asked once per kind and namespace, only when the
   * list came back empty, and only ever to word the note (see loadOverview).
   */
  const emptyWhy = new Map(); // `${kind}\u0001${ns}` -> 'role' | 'none' | 'asking'
  const emptyNote = (t) => {
    const key = `${t.name}\u0001${t.namespaced ? selectedNs : ''}`;
    const why = emptyWhy.get(key);
    if (why === undefined) {
      emptyWhy.set(key, 'asking');
      window.api.kube.canI({ spec: kubeSpec, target: { verb: 'list', resource: t.name, namespace: t.namespaced ? (selectedNs || undefined) : undefined, allNamespaces: !!t.namespaced && !selectedNs } })
        .then((c) => { emptyWhy.set(key, c && c.allowed === false && !c.unknown ? 'role' : 'none'); render(); })
        .catch(() => emptyWhy.set(key, 'none'));
    }
    return why === 'role' ? `No ${t.kind} your role can see${t.namespaced && selectedNs ? ` in ${selectedNs}` : ''}.` : 'Nothing here.';
  };

  /** "Pods" on a workload row — finds the Pod type already discovered and re-fetches it scoped to this one's own selector. */
  const selectPodsFor = (r) => {
    const podType = types.find((t) => t.kind === 'Pod');
    if (!podType) return toast('Pod was not discovered on this cluster', 'error');
    if (!r.selector) return toast(`${selected.kind} has no selector to scope by`, 'error');
    selectType(podType, { selector: r.selector, scopeLabel: `${selected.kind}/${r.name}` });
  };

  /** Clicking a Namespace row — "switch into it": the namespace selector everything else already scopes by, then straight to its Pods. */
  const switchIntoNamespace = (namespace) => {
    selectedNs = namespace;
    const podType = types.find((t) => t.kind === 'Pod');
    if (podType) selectType(podType);
    else render();
    toast(`Switched to namespace ${namespace}`);
  };

  /*
   * Starred resources — the handful of pods and deployments someone keeps
   * coming back to, in one place instead of a kind and a filter away each
   * time. Kept in settings per kube context (its name), so a star on
   * minikube's web pod is not a star on dev's.
   */
  const starKey = kubeSpec.contextName || '';
  const starsAll = () => state.settings.kubeStars || {};
  const stars = () => starsAll()[starKey] || [];
  const starId = (x) => `${x.resource}\u0001${x.namespace || ''}\u0001${x.name}`;
  const isStarred = (t, r) => stars().some((x) => starId(x) === starId({ resource: t.name, namespace: t.namespaced ? r.namespace : '', name: r.name }));
  const toggleStar = async (t, r) => {
    const me = { resource: t.name, kind: t.kind, namespaced: !!t.namespaced, namespace: t.namespaced ? r.namespace : '', name: r.name };
    const list = isStarred(t, r) ? stars().filter((x) => starId(x) !== starId(me)) : [...stars(), me];
    state.settings = await window.api.settings.set({ kubeStars: { ...starsAll(), [starKey]: list } });
    if (selected === 'starred') loadStarred(); else render();
  };
  const starBtn = (t, r) => {
    const on = isStarred(t, r);
    return el('button', {
      class: 'ghost-btn sm', text: on ? '★' : '☆', style: on ? 'color:var(--amber)' : null,
      title: on ? 'Unstar — take it out of Starred' : 'Star — keep it in Starred, at the top of the kinds list',
      onClick: (e) => { e.stopPropagation(); toggleStar(t, r); },
    });
  };

  // The live rows behind each star: one `get` per kind starred, not one per star.
  let starredRows = null; // null = loading; [{ star, row|null }]
  let starredError = '';
  const loadStarred = async () => {
    starredRows = null; starredError = ''; render();
    const list = stars();
    const byType = new Map();
    for (const x of list) if (!byType.has(x.resource)) byType.set(x.resource, x);
    const fetched = new Map();
    await Promise.all([...byType.values()].map(async (x) => {
      const r = await window.api.kube.resources({ spec: kubeSpec, type: { name: x.resource, namespaced: x.namespaced } }).catch((e) => ({ ok: false, error: e.message }));
      fetched.set(x.resource, r);
      if (!r.ok && !starredError) starredError = r.error || '';
    }));
    starredRows = list.map((x) => ({
      star: x,
      row: (fetched.get(x.resource)?.items || []).find((it) => it.name === x.name && (!x.namespaced || it.namespace === x.namespace)) || null,
    }));
    render();
  };
  const selectStarred = () => { stopLive(); selected = 'starred'; podScope = null; render(); loadStarred(); };

  const starredPanel = () => {
    const head = el('div', { style: 'font-weight:600;margin:2px 0 8px', text: '★ Starred' });
    if (!stars().length) {
      return el('div', {}, head, el('div', { class: 'sb-empty', text: 'Nothing starred on this cluster yet. Use ☆ on any row — a pod, a deployment, anything — and it lands here.' }));
    }
    if (!starredRows) return el('div', {}, head, el('div', { class: 'sb-empty', text: 'Loading…' }));
    const open = async (x) => {
      const t = types.find((ty) => ty.name === x.resource);
      if (!t) return toast(`${x.kind} is not a kind this cluster lists`, 'error');
      if (x.namespaced && x.namespace && selectedNs && selectedNs !== x.namespace) selectedNs = '';
      await selectType(t);
      rowFilter = x.name;
      render();
    };
    const rows = starredRows.map(({ star: x, row }) => {
      const t = { name: x.resource, kind: x.kind, namespaced: x.namespaced };
      const pod = x.kind === 'Pod' && row;
      return el('div', { class: 'kube-row', style: 'grid-template-columns:minmax(120px,1fr) 110px minmax(0,130px) minmax(0,110px) minmax(0,200px) max-content' },
        el('span', { text: x.name, style: 'cursor:pointer;color:var(--accent)', title: 'Open it in its own kind, filtered to it', onClick: () => open(x) }),
        el('span', { style: 'color:var(--muted)', text: x.kind }),
        el('span', { text: x.namespace || '—' }),
        row
          ? el('span', {},
            el('span', { style: `width:7px;height:7px;border-radius:50%;background:${phaseDot(row.status)};display:inline-block;margin-right:5px` }),
            row.status || '')
          : el('span', { style: 'color:var(--red)', text: 'gone' }),
        el('span', { style: 'color:var(--muted)', text: row?.detail || (row ? '' : 'not in the cluster any more') }),
        el('span', { class: 'kube-row-actions' },
          el('button', { class: 'ghost-btn sm', text: 'Open', onClick: () => open(x) }),
          pod ? el('button', { class: 'ghost-btn sm', text: 'Exec', title: 'Click: split · double-click: new tab',
            ...clickOrDblClick(async () => (await import('./kubepanel.js')).openPodExec(kubeSpec, row, row.containers?.[0], { dir: 'col' }),
              async () => (await import('./kubepanel.js')).openPodExec(kubeSpec, row, row.containers?.[0], { newTab: true })) }) : null,
          pod ? el('button', { class: 'ghost-btn sm', text: 'Logs', title: 'Click: split · double-click: new tab',
            ...clickOrDblClick(async () => (await import('./kubepanel.js')).openPodLogs(kubeSpec, row, row.containers?.[0], { dir: 'col' }),
              async () => (await import('./kubepanel.js')).openPodLogs(kubeSpec, row, row.containers?.[0], { newTab: true })) }) : null,
          row ? el('button', { class: 'ghost-btn sm', text: 'Describe', onClick: async () => {
            const res = await window.api.kube.describeResource({ spec: kubeSpec, target: { name: x.name, resource: x.resource, namespace: x.namespace || undefined } });
            await textModal(`${x.kind}/${x.name}`, res.ok ? res.text : (res.error || 'Could not describe it'), { lang: 'text' });
          } }) : null,
          starBtn(t, { name: x.name, namespace: x.namespace })));
    });
    return el('div', {}, head, ...rows, starredError ? el('div', { class: 'hint', text: starredError }) : null);
  };

  const selectHelm = () => {
    stopLive();
    selected = 'helm';
    podScope = null;
    helmRowFilter = '';
    render();
    loadHelm();
  };

  const loadHelm = async () => {
    // Deliberately not clearing helmReleases here — a namespace switch or
    // the Refresh button used to blank the whole table for the length of
    // the round trip, same rows every time but a flash of "Loading…" in
    // between. What's already on screen stays up (helmPanel() keeps
    // showing it while helmLoading is true) until the new list is ready
    // to replace it outright.
    helmLoading = true;
    render();
    try {
      const r = await window.api.kube.helmReleases({ spec: kubeSpec, target: { namespace: selectedNs || undefined } });
      if (!r.ok) {
        helmError = r.error || 'Could not list Helm releases';
        // Releases already on screen are not thrown away for a refresh
        // that failed — the toast says so instead of the panel going blank.
        if (helmReleases.length) toast(helmError, 'error');
      } else { helmReleases = r.releases || []; helmError = ''; }
    } catch (e) {
      helmError = e.message;
      if (helmReleases.length) toast(helmError, 'error');
    }
    helmLoading = false;
    render();
  };

  const stopUsagePolling = () => { if (usageTimer) { clearTimeout(usageTimer); usageTimer = null; } };

  /** `kubectl top`, polled only while the 3D view is the one on screen — the same "poll, feed rows into what's already built" shape city3d.js's own ProcTraffic uses. */
  const pollUsage = async () => {
    try {
      const r = await window.api.kube.top({ spec: kubeSpec, target: { namespace: selectedNs || undefined } });
      kube3dView?.updateUsage(r);
    } catch { /* metrics-server absent or slow: the view just stays phase-coloured */ }
    if (selected === '3d' && body?.isConnected) usageTimer = setTimeout(pollUsage, 8000);
  };

  const load3dScene = async () => {
    try {
      const r = await window.api.kube.scene({ spec: kubeSpec, namespace: selectedNs || undefined });
      if (!r.ok) { toast(r.error || 'Could not read the cluster for the 3D view', 'error'); return; }
      kube3dView.rebuild(r);
    } catch (e) { toast(e.message, 'error'); }
  };

  const select3d = () => {
    stopLive();
    selected = '3d';
    podScope = null;
    // Built before render(), not after — threeDPanel() (called by the
    // render() just below) needs kube3dView to already exist the first
    // time this runs.
    if (!kube3dView) {
      kube3dView = new Kube3D({
        onExec: async (pod) => (await import('./kubepanel.js')).openPodExec(kubeSpec, pod, pod.containers?.[0]),
        onPortForward: async (svc) => (await import('./kubepanel.js')).startPortForward(kubeSpec, { resource: 'service', name: svc.name, namespace: svc.namespace }),
      });
      // Pane-owned, so sessions.js's closePane()/closePaneByHand() dispose
      // the WebGL context when the pane itself closes — not on switching
      // away from this nav entry, which would lose the camera for nothing.
      pane.kube3d = kube3dView;
    }
    render();
    load3dScene();
    stopUsagePolling();
    pollUsage();
  };

  /**
   * Lazily-built host for the persistent Kube3D instance — render()
   * re-appending an already-attached node just moves it, the WebGL context
   * survives. `opts.initialView === '3d'` means `selected` is already '3d'
   * before select3d() has had a chance to construct kube3dView (the very
   * first render() of this panel runs before that call) — the one case
   * this still needs to handle without it.
   */
  const threeDPanel = () => {
    if (!kube3dView) return el('div', { class: 'sb-empty', text: 'Loading 3D view…' });
    const host = el('div', { style: 'height:100%;min-height:400px' }, kube3dView.element);
    requestAnimationFrame(() => kube3dView._resize());
    return host;
  };

  // Same reasoning as kindFilterInputEl above: one persistent input, reused
  // (and re-synced only when it genuinely falls out of step, such as
  // selectType() resetting the filter on a fresh kind).
  let rowFilterInputEl = null;
  const rowSearch = () => {
    if (!rowFilterInputEl) {
      rowFilterInputEl = textInput({ value: rowFilter });
      rowFilterInputEl.addEventListener('input', () => {
        rowFilter = rowFilterInputEl.value;
        const pos = rowFilterInputEl.selectionStart;
        render();
        rowFilterInputEl.focus();
        rowFilterInputEl.setSelectionRange(pos, pos);
      });
    }
    rowFilterInputEl.placeholder = `Filter ${selected.kind} by name…`;
    if (rowFilterInputEl.value !== rowFilter) rowFilterInputEl.value = rowFilter;
    return el('div', { style: 'padding:0 2px 8px' }, rowFilterInputEl);
  };

  const mainPanel = () => {
    if (!selected) return overviewPanel();
    if (selected === 'helm') return helmPanel();
    if (selected === '3d') return threeDPanel();
    if (selected === 'starred') return starredPanel();
    // Actionable information — ready/desired for a Deployment,
    // ready/restarts for a Pod — not just a bare status. Blank for a kind this has no special-cased
    // knowledge of — unless the CRD says what else is worth a column of
    // its own (additionalPrinterColumns, resolved per row in kuberesources.js).
    const crdCols = rows[0]?.crdColumns || [];
    const fmtCrdValue = (c) => {
      if (c?.value === undefined || c?.value === null) return '';
      if (c.type === 'date') { const t = Date.parse(c.value); return Number.isNaN(t) ? String(c.value) : fmtDate(t); }
      return String(c.value);
    };
    const columns = [
      { key: 'name', label: 'Name', width: 220 },
      selected.namespaced ? { key: 'namespace', label: 'Namespace', width: 140 } : null,
      { key: 'status', label: 'Status', width: 110, extra: 12 },
      { key: 'detail', label: 'Detail', width: 200 },
      { key: 'age', label: 'Age', width: 90, text: (r) => (r.age ? fmtDate(Date.parse(r.age)) : '') },
      ...crdCols.map((c, idx) => ({ key: `crd${idx}`, label: c.label, width: 120, text: (r) => fmtCrdValue(r.crdColumns?.[idx]) })),
    ].filter(Boolean);
    const headOnly = () => renderTable({ id: 'resources', columns, rows: [], renderRow: () => el('div') })[0];
    const search = rowSearch();
    const scopeBanner = podScope ? el('div', {
      style: 'display:flex;align-items:center;gap:8px;padding:4px 8px;margin-bottom:6px;'
        + 'background:var(--panel-2);border:1px solid var(--border-soft);border-radius:6px;font-size:12px',
    },
      el('span', { style: 'color:var(--muted)', text: 'Scoped to the pods of' }),
      el('span', { style: 'font-weight:600', text: podScope.label }),
      el('button', {
        class: 'ghost-btn sm', text: 'Show all Pods', style: 'margin-left:auto',
        onClick: () => selectType(selected),
      })) : null;
    if (loadingRows) return el('div', {}, search, scopeBanner, headOnly(), el('div', { class: 'sb-empty', text: 'Loading…' }));
    if (rowsError) return el('div', {}, search, scopeBanner, headOnly(), NO_ACCESS_RE.test(rowsError) ? noAccessPanel(rowsError) : el('div', { class: 'sb-empty', text: rowsError }));
    const q = rowFilter.trim().toLowerCase();
    // 2+ namespaces picked: the fetch already came back as -A (see the
    // derivation in topBar()'s nsBtn/nsMenu), so narrowing to the chosen
    // set happens here, client-side, the same place the text filter does.
    const shownRows = rows.filter((r) => {
      if (chosenNs.size > 1 && selected.namespaced && !chosenNs.has(r.namespace)) return false;
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || (r.namespace || '').toLowerCase().includes(q);
    });
    lastShownRows = shownRows;
    if (!rows.length) return el('div', {}, search, scopeBanner, headOnly(), el('div', { class: 'sb-empty', text: emptyNote(selected) }));
    if (!shownRows.length) return el('div', {}, search, scopeBanner, headOnly(), el('div', { class: 'sb-empty', text: `No ${selected.kind} matches "${rowFilter}".` }));
    const table = renderTable({
      id: 'resources', columns, rows: shownRows,
      renderRow: (r) => {
      const selectBox = el('input', { type: 'checkbox', style: 'margin-right:6px', title: 'Select for a bulk action' });
      selectBox.checked = selectedKeys.has(rowKey(r));
      selectBox.addEventListener('click', (e) => e.stopPropagation());
      selectBox.addEventListener('change', () => {
        if (selectBox.checked) selectedKeys.add(rowKey(r)); else selectedKeys.delete(rowKey(r));
        render();
      });
      const nameCell = el('span', { style: 'display:flex;align-items:center' },
        selectBox,
        selected.kind === 'Namespace' ? el('span', {
          text: r.name, style: 'cursor:pointer;color:var(--accent)', title: 'Switch the namespace selector to this one and browse its Pods',
          onClick: () => switchIntoNamespace(r.name),
        })
          // A workload (or a Service) is clicked into the same way: its name
          // opens the pods it owns or routes to — its own label selector,
          // the Pods list scoped to it, "Show all Pods" to go back.
          : (POD_PARENT_KINDS.includes(selected.kind) && r.selector) ? el('span', {
            text: r.name, style: 'cursor:pointer;color:var(--accent)',
            title: `Show the pods ${selected.kind === 'Service' ? 'this Service routes to' : `this ${selected.kind} owns`}`,
            onClick: (e) => { e.stopPropagation(); selectPodsFor(r); },
          })
            : el('span', { text: r.name }));
      const row = el('div', { class: 'kube-row', style: r === lastShownRows[focusedRowIndex] ? 'outline:1px solid var(--accent);outline-offset:-1px' : null },
        nameCell,
        selected.namespaced ? el('span', { text: r.namespace }) : null,
        el('span', {},
          el('span', { style: `width:7px;height:7px;border-radius:50%;background:${phaseDot(r.status)};display:inline-block;margin-right:5px` }),
          r.status || ''),
        el('span', { style: 'color:var(--muted)', text: r.detail || '' }),
        el('span', { text: r.age ? fmtDate(Date.parse(r.age)) : '' }),
        ...crdCols.map((c, idx) => el('span', { text: fmtCrdValue(r.crdColumns?.[idx]) })),
        el('span', { class: 'kube-row-actions' },
          starBtn(selected, r),
          selected.kind === 'Pod' ? el('button', {
            class: 'ghost-btn sm', text: 'Exec',
            title: 'Click: split the active pane · double-click: open in a new tab',
            // Split down by default here, where the main panel reads better
            // split downward — the sidebar tree's own pod rows split right
            // instead, for the same reason in the other direction.
            ...clickOrDblClick((e) => execRow(e, r, { dir: 'col' }), (e) => execRow(e, r, { newTab: true })),
          }) : null,
          selected.kind === 'Pod' ? el('button', {
            class: 'ghost-btn sm', text: 'Logs',
            title: 'Click: split the active pane · double-click: open in a new tab',
            ...clickOrDblClick((e) => logsRow(e, r, { dir: 'col' }), (e) => logsRow(e, r, { newTab: true })),
          }) : null,
          r.selector ? el('button', {
            class: 'ghost-btn sm', text: 'Pods', title: `This ${selected.kind.toLowerCase()}'s own pods — including deleting one of them`,
            onClick: () => selectPodsFor(r),
          }) : null,
          selected.kind === 'Namespace' ? el('button', {
            class: 'ghost-btn sm', text: 'Switch into it', title: 'Scope the namespace selector to this one and browse its Pods',
            onClick: () => switchIntoNamespace(r.name),
          }) : null,
          selected.kind === 'Node' ? el('button', {
            class: 'ghost-btn sm', text: 'Cordon', title: 'Mark unschedulable — nothing new lands here, nothing running is touched',
            onClick: () => cordonRow(r),
          }) : null,
          selected.kind === 'Node' ? el('button', {
            class: 'ghost-btn sm', text: 'Drain', title: 'Cordon, then evict every pod on it',
            onClick: () => drainRow(r),
          }) : null,
          selected.kind === 'Node' ? el('button', {
            class: 'ghost-btn sm', text: 'Node shell…', title: 'A privileged debug pod on this node, its filesystem mounted at /host',
            onClick: () => nodeShellRow(r),
          }) : null,
          r.selector ? el('button', {
            class: 'ghost-btn sm', text: 'Logs (all pods)', title: 'kubectl logs across every pod this selects, interleaved and prefixed',
            onClick: () => selectorLogsRow(r),
          }) : null,
          PORT_FORWARD_KINDS.includes(selected.kind) ? el('button', {
            class: 'ghost-btn sm', text: 'Port-forward', title: 'kubectl port-forward — a local port straight to this one',
            onClick: () => portForward(r),
          }) : null,
          SCALE_KINDS.includes(selected.kind) ? el('button', {
            class: 'ghost-btn sm', text: 'Scale', title: 'kubectl scale --replicas', onClick: () => scaleRow(r),
          }) : null,
          selected.kind === 'CronJob' ? el('button', {
            class: 'ghost-btn sm', text: 'Trigger', title: 'Run it now, outside its schedule', onClick: () => cronTriggerRow(r),
          }) : null,
          (ROLLOUT_KINDS.includes(selected.kind) || CONTAINER_EDIT_KINDS.includes(selected.kind) || selected.kind === 'CronJob' || selected.kind === 'Pod') ? el('button', {
            class: 'ghost-btn sm', text: '⋯', title: 'More actions',
            onClick: (e) => contextMenu(e.clientX, e.clientY, extraRowMenu(r)),
          }) : null,
          el('button', { class: 'ghost-btn sm', text: 'Details', title: 'Conditions, owners, container status and this resource\'s own events', onClick: () => viewDetails(r) }),
          el('button', { class: 'ghost-btn sm', text: 'YAML', onClick: () => viewYaml(r) }),
          el('button', { class: 'ghost-btn sm', text: 'Describe', onClick: () => viewDescribe(r) }),
          el('button', { class: 'ghost-btn sm', text: 'Delete', onClick: () => deleteRow(r) })));
      // The same actions the row's own buttons already run, reachable by
      // right-click too — a narrow pane crowds several buttons into one
      // cell, and Delete is the one most likely to be the one that scrolls
      // out of reach.
      row.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        const containers = r.containers?.length ? r.containers : [null];
        const pfItem = PORT_FORWARD_KINDS.includes(selected.kind) ? await portForwardMenuItemFor(r) : null;
        // Where it opens, the same three choices the sidebar's pod menu has —
        // a tab of its own included. One container: the choices directly;
        // several: one row per container, the choices under each.
        const placed = (open) => [
          { label: 'Split right', onClick: () => open({ dir: 'row' }) },
          { label: 'Split down', onClick: () => open({ dir: 'col' }) },
          { label: 'Open in a new tab', onClick: () => open({ newTab: true }) },
        ];
        const perContainer = (verb, fnName) => (containers.length === 1
          ? placed(async (opts) => (await import('./kubepanel.js'))[fnName](kubeSpec, r, containers[0], opts))
          : containers.map((name) => ({
            label: `${verb} ${name}`,
            onClick: async () => (await import('./kubepanel.js'))[fnName](kubeSpec, r, name, { dir: 'col' }),
            submenu: placed(async (opts) => (await import('./kubepanel.js'))[fnName](kubeSpec, r, name, opts)),
          })));
        contextMenu(e.clientX, e.clientY, [
          { label: r.name, heading: true },
          { label: isStarred(selected, r) ? 'Unstar' : 'Star', icon: '★', onClick: () => toggleStar(selected, r) },
          selected.kind === 'Pod' ? { label: 'Exec', submenu: perContainer('Exec into', 'openPodExec') } : null,
          selected.kind === 'Pod' ? { label: 'Logs', submenu: perContainer('Logs for', 'openPodLogs') } : null,
          selected.kind === 'Pod' ? { label: 'Attach', submenu: perContainer('Attach to', 'openPodAttach') } : null,
          selected.kind === 'Pod' ? { label: 'Debug container…', submenu: perContainer('Debug', 'openPodDebug') } : null,
          selected.kind === 'Pod' ? { label: 'Open log viewer…', onClick: async () => (await import('./kubepanel.js')).openPodLogViewer(kubeSpec, r, containers[0]) } : null,
          r.selector ? { label: 'Pods…', onClick: () => selectPodsFor(r) } : null,
          r.selector ? { label: 'Logs (all pods)…', onClick: () => selectorLogsRow(r) } : null,
          r.selector ? { label: 'Open log viewer (all pods)…', onClick: () => selectorLogViewerRow(r) } : null,
          selected.kind === 'Namespace' ? { label: 'Switch into it', onClick: () => switchIntoNamespace(r.name) } : null,
          selected.kind === 'Node' ? { label: 'Cordon', onClick: () => cordonRow(r) } : null,
          selected.kind === 'Node' ? { label: 'Drain…', onClick: () => drainRow(r) } : null,
          selected.kind === 'Node' ? { label: 'Node shell…', onClick: () => nodeShellRow(r) } : null,
          pfItem,
          { label: 'Details', onClick: () => viewDetails(r) },
          { label: 'View YAML', onClick: () => viewYaml(r) },
          { label: 'Export YAML…', onClick: () => exportYaml(r) },
          { label: 'Describe', onClick: () => viewDescribe(r) },
          { sep: true },
          ...extraRowMenu(r),
          { sep: true },
          { label: 'Delete…', onClick: () => deleteRow(r) },
        ].filter(Boolean));
      });
      return row;
      },
    });
    const selectedShown = shownRows.filter((r) => selectedKeys.has(rowKey(r)));
    const bulkBar = selectedShown.length ? el('div', {
      style: 'display:flex;align-items:center;gap:8px;padding:4px 8px;margin-bottom:6px;'
        + 'background:var(--panel-2);border:1px solid var(--border-soft);border-radius:6px;font-size:12px',
    },
      el('span', { text: `${selectedShown.length} selected` }),
      el('button', { class: 'ghost-btn sm', text: 'Delete selected…', style: 'margin-left:auto', onClick: () => bulkDeleteSelected(shownRows) }),
      el('button', { class: 'ghost-btn sm', text: 'Clear', onClick: () => { selectedKeys.clear(); render(); } })) : null;
    const exportCsv = async (list) => {
      const csvColumns = [
        { key: 'name', label: 'Name' },
        selected.namespaced ? { key: 'namespace', label: 'Namespace' } : null,
        { key: 'status', label: 'Status' },
        { key: 'detail', label: 'Detail' },
        { key: 'age', label: 'Age' },
        ...crdCols.map((c, idx) => ({ key: `crd${idx}`, label: c.label })),
      ].filter(Boolean);
      const csvRows = list.map((r) => ({
        name: r.name, namespace: r.namespace || '', status: r.status || '', detail: r.detail || '',
        age: r.age ? fmtDate(Date.parse(r.age)) : '',
        ...Object.fromEntries(crdCols.map((c, idx) => [`crd${idx}`, fmtCrdValue(r.crdColumns?.[idx])])),
      }));
      return toCsv(csvRows, csvColumns);
    };
    /*
     * One Export, three formats. CSV is the table as shown; JSON and YAML are
     * Kubernetes' own documents — a `kind: List` of the full objects, what
     * `kubectl get -o json|yaml` writes, so the file goes straight back into
     * kubectl, Helm, Kustomize or a Git repo. "Ready to apply" takes out what
     * the API server sets on its own (see kubeexport.js).
     */
    const openExport = async () => {
      const ticked = shownRows.filter((r) => selectedKeys.has(rowKey(r)));
      const formatSel = select([
        { value: 'yaml', label: 'YAML — Kubernetes List (kubectl get -o yaml)' },
        { value: 'json', label: 'JSON — Kubernetes List (kubectl get -o json)' },
        { value: 'csv', label: 'CSV — the table as shown' },
      ], 'yaml');
      const whichSel = select([
        { value: 'shown', label: `The ${shownRows.length} row${shownRows.length === 1 ? '' : 's'} shown` },
        ...(ticked.length ? [{ value: 'ticked', label: `The ${ticked.length} ticked` }] : []),
      ], ticked.length ? 'ticked' : 'shown');
      const cleanIn = checkbox('Ready to apply elsewhere — leave out status, uid, resourceVersion, managedFields and other server-set fields', false);
      const syncClean = () => { cleanIn.style.display = formatSel.value === 'csv' ? 'none' : ''; };
      formatSel.addEventListener('change', syncClean);
      syncClean();
      const go = await modal({
        title: `Export ${selected.kind}`,
        render: (b) => b.append(field('Format', formatSel), field('Which', whichSel), cleanIn),
        buttons: [{ label: 'Cancel', value: false }, { label: 'Export…', value: true, class: 'primary-btn' }],
      });
      if (!go) return;
      const list = whichSel.value === 'ticked' ? ticked : shownRows;
      const format = formatSel.value;
      let text;
      if (format === 'csv') {
        text = await exportCsv(list);
      } else {
        const r = await window.api.kube.exportResources({
          spec: kubeSpec,
          target: {
            kind: selected.name, namespaced: selected.namespaced,
            namespace: selected.namespaced ? (selectedNs || undefined) : undefined,
            selector: podScope?.selector || undefined, apiVersion: selected.apiVersion,
            rows: list.map((x) => ({ namespace: x.namespace || '', name: x.name })),
            format, clean: cleanIn.input.checked,
          },
        });
        if (!r.ok) return toast(r.error || 'Could not export', 'error');
        if (r.missing?.length) toast(`Not there any more, left out: ${r.missing.join(', ')}`, 'error', 8000);
        // Owned objects exported on their own are standalone copies that
        // nothing will manage or restart — said before the file is written.
        if (r.owned?.length) {
          const owners = [...new Set(r.owned.map((x) => x.owner))];
          const sure = await confirm({
            title: 'These are managed by something else',
            message: `${r.owned.length} of the ${r.count} exported ${selected.kind.toLowerCase()}${r.count === 1 ? ' is' : 's are'} owned by ${owners.length === 1 ? owners[0] : `${owners.length} other resources`}. Applied somewhere else, ${r.owned.length === 1 ? 'it becomes a standalone copy' : 'they become standalone copies'} that nothing manages or restarts.`,
            detail: `To move ${r.owned.length === 1 ? 'it' : 'them'} properly, export the owner instead:\n${owners.slice(0, 12).join('\n')}${owners.length > 12 ? `\n…and ${owners.length - 12} more` : ''}`,
            confirmLabel: 'Save anyway',
          });
          if (!sure) return;
        }
        text = r.text;
      }
      const saved = await window.api.dialog.saveText({ text, defaultPath: `${selected.kind}.${format}`, title: `Export ${selected.kind} as ${format.toUpperCase()}` });
      if (saved) toast(`Saved ${saved.path}`);
    };
    const exportBtn = el('button', {
      class: 'ghost-btn sm', text: 'Export…', title: 'The rows shown (or ticked) — as CSV, or as Kubernetes JSON / YAML',
      onClick: () => openExport(),
    });
    return el('div', {}, search, el('div', { style: 'padding:0 2px 8px' }, exportBtn), scopeBanner, bulkBar, ...table);
  };

  /** The landing page — what every k8s dashboard shows before you've picked anything: health, not a blank list. */
  const overviewPanel = () => {
    if (!overview) return el('div', { class: 'sb-empty', text: overviewError || 'Loading…' });
    return el('div', { style: 'padding:4px' },
      el('div', { style: 'font-weight:600;margin-bottom:8px', text: 'Cluster overview' }),
      el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px' },
        overview.nodes.error
          ? unreadableCard('Nodes', overview.nodes.error)
          : overviewCard('Nodes', overview.nodes.total, overview.nodes.notReady ? `${overview.nodes.notReady} not ready` : 'all ready',
            overview.nodes.notReady ? '#f85149' : '#3fb950',
            overview.nodes.notReady ? () => listOverviewItems('Nodes not ready', 'nodes',
              overview.nodeItems.filter((n) => !/\bReady\b/.test(n.status || ''))) : null),
        overview.namespacesError
          ? unreadableCard('Namespaces', overview.namespacesError)
          : overviewCard('Namespaces', namespaces.length, selectedNs || 'all shown', '#6e8bd6'),
        ...Object.entries(overview.podsByPhase).map(([phase, n]) => overviewCard(phase, n, 'pods', phaseDot(phase),
          () => listOverviewItems(`${phase} pods`, 'pods', overview.podItems.filter((p) => (p.status || 'Unknown') === phase)))),
      ),
      usagePanel(),
      el('div', { style: 'color:var(--muted);font-size:12px', text: 'Pick a resource kind on the left for the full, filterable list — Workloads, Config, Network, Storage, Access Control, Cluster, and everything else this cluster defines on its own (Custom Resources).' }),
    );
  };

  /** `kubectl top`: nodes, then the busiest pods, each with a trend beside it — the one thing a single kubectl call could never show. */
  const usagePanel = () => {
    const head = el('div', { style: 'font-weight:600;margin:4px 0 6px', text: 'Resource usage (kubectl top)' });
    if (!usage || usage.loading) return el('div', { style: 'margin-bottom:16px' }, head, el('div', { class: 'sb-empty', text: 'Reading metrics…' }));
    if (usage.error || !usage.ok) {
      const why = usage.error || usage.pods?.error || usage.nodes?.error || 'metrics-server did not answer';
      return el('div', { style: 'margin-bottom:16px' }, head, el('div', { class: 'sb-empty', text: why }));
    }
    const line = (cells, headRow = false) => el('div', {
      class: 'kube-row' + (headRow ? ' kube-head' : ''), style: 'grid-template-columns:minmax(0,1fr) 90px 90px 70px 70px',
    }, ...cells.map((t) => (typeof t === 'string' ? el('span', { text: t }) : t)));
    const spark = (text) => el('span', { class: 'ps-spark', title: 'The last few minutes, polled here — not from a metrics backend of its own', text });
    // A node's own percent-of-capacity is already 0-100 and means something
    // on its own; a pod has no such baseline (percent of what?), so its
    // trend is scaled against its own recent high — the shape, not the size.
    const relativeSpark = (arr) => {
      if (!arr?.length) return spark('');
      const max = Math.max(...arr, 1);
      return spark(sparkline(arr.map((v) => (v / max) * 100)));
    };
    const nodes = usage.nodes?.ok ? usage.nodes.items : [];
    const pods = usage.pods?.ok ? usage.pods.items.slice(0, 15) : [];
    return el('div', { style: 'margin-bottom:16px' }, head,
      nodes.length ? line(['Node', 'CPU', 'Memory', 'CPU trend', 'Mem trend'], true) : null,
      ...nodes.map((n) => {
        const h = nodeHistory.get(n.name);
        return line([n.name, `${n.cpu} (${n.cpuPercent})`, `${n.memory} (${n.memoryPercent})`,
          spark(sparkline(h?.cpuPercent || [])), spark(sparkline(h?.memPercent || []))]);
      }),
      !usage.nodes?.ok ? el('div', { class: 'hint', style: 'margin:2px 0 8px', text: `Nodes: ${usage.nodes?.error || 'not available'}` }) : null,
      pods.length ? line([`Busiest pods${selectedNs ? ' in ' + selectedNs : ''}`, 'CPU', 'Memory', 'CPU trend', 'Mem trend'], true) : null,
      ...pods.map((p) => {
        const h = podHistory.get(`${p.namespace}\u0001${p.name}`);
        return line([(p.namespace ? p.namespace + '/' : '') + p.name, p.cpu, p.memory,
          relativeSpark(h?.cpuM), relativeSpark(h?.memBytes)]);
      }),
      !usage.pods?.ok ? el('div', { class: 'hint', text: `Pods: ${usage.pods?.error || 'not available'}` }) : null);
  };

  /**
   * "Request namespace/pod access…" — the only way in otherwise is the
   * Teleport tab's own New request → Browse…, picking the kind and then
   * this cluster again from a dropdown it already knows from here. Jumps
   * straight to the namespace/pod picker, already scoped to this cluster.
   */
  /*
   * Map a Teleport group to a ClusterRole — Teleport's two halves, in one
   * place (kubeops.js has the reasoning): the binding that gives the group
   * permissions in this cluster, and the Teleport role that lets a user
   * assume the group. The binding can be applied here; the role is written
   * out to copy or save for whoever administers the Teleport cluster.
   */
  const BUILTIN_CLUSTER_ROLES = [
    { name: 'view', help: 'Read most things in a namespace — not Secrets, not Roles or RoleBindings.' },
    { name: 'edit', help: 'Read and change most things in a namespace, Secrets included — but not Roles or RoleBindings.' },
    { name: 'admin', help: 'Everything in a namespace, including its Roles and RoleBindings — not quotas or the namespace itself.' },
    { name: 'cluster-admin', help: 'Everything, everywhere. Bound cluster-wide this is full control of the cluster.' },
  ];
  const openGroupMappingWizard = async () => {
    const pre = (h = '160px') => el('pre', {
      style: `font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-all;user-select:text;max-height:${h};overflow:auto;`
        + 'margin:4px 0 0;background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px',
    });
    const groupIn = textInput({ placeholder: 'developers', value: '' });
    const roleSel = el('select', { style: 'width:100%' }, el('option', { value: '', text: 'Reading the cluster’s ClusterRoles…' }));
    const roleHelp = el('div', { class: 'hint' });
    const scopeSel = select([{ value: 'cluster', label: 'The whole cluster (a ClusterRoleBinding)' }, { value: 'ns', label: 'Only some namespaces (a RoleBinding in each)' }], 'cluster');
    const nsBoxes = namespaces.map((n) => checkbox(n, n === selectedNs));
    const nsWrap = el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 14px;max-height:120px;overflow:auto' }, ...(nsBoxes.length ? nsBoxes : [el('span', { class: 'hint', text: 'No namespaces could be listed here — your role may not list them.' })]));
    const nsField = field('Namespaces', nsWrap);
    const bindingBox = pre('190px');
    const cmdBox = pre('60px');
    const roleBox = pre('230px');
    const roleNote = el('div', { class: 'hint' });
    const note = el('div', { class: 'hint', style: 'min-height:1.2em' });
    const ns = () => (scopeSel.value === 'ns' ? nsBoxes.filter((b) => b.input.checked).map((b) => b.querySelector('span')?.textContent || b.textContent.trim()) : []);
    let clusterLabels = {};
    let bindingYaml = '';
    let roleYaml = '';
    let roleFile = 'kube-role.yaml';

    // Built-ins first, explained; then the cluster's own (aggregated system:* roles left out).
    window.api.kube.resources({ spec: kubeSpec, type: { name: 'clusterroles', namespaced: false } }).then((r) => {
      const own = (r?.items || []).map((x) => x.name).filter((n) => !n.startsWith('system:') && !BUILTIN_CLUSTER_ROLES.some((b) => b.name === n)).sort();
      roleSel.replaceChildren(
        el('optgroup', { label: 'Built in' }, ...BUILTIN_CLUSTER_ROLES.map((b) => el('option', { value: b.name, text: b.name }))),
        ...(own.length ? [el('optgroup', { label: 'This cluster’s own' }, ...own.map((n) => el('option', { value: n, text: n })))] : []));
      roleSel.value = 'view';
      paint();
    }).catch(() => {
      roleSel.replaceChildren(...BUILTIN_CLUSTER_ROLES.map((b) => el('option', { value: b.name, text: b.name })));
      roleSel.value = 'view';
      paint();
    });
    // The cluster's own Teleport labels, so the role matches this cluster rather than all of them.
    if (kubeSpec.teleportProxy && kubeSpec.kubeClusterName) {
      window.api.kube.clusters({ proxy: kubeSpec.teleportProxy }).then((r) => {
        clusterLabels = (r?.clusters || []).find((c) => c.name === kubeSpec.kubeClusterName)?.labels || {};
        paint();
      }).catch(() => {});
    }

    const paint = async () => {
      nsField.style.display = scopeSel.value === 'ns' ? '' : 'none';
      const builtin = BUILTIN_CLUSTER_ROLES.find((b) => b.name === roleSel.value);
      roleHelp.textContent = builtin ? builtin.help : (roleSel.value ? 'A ClusterRole defined in this cluster.' : '');
      roleHelp.style.color = roleSel.value === 'cluster-admin' && scopeSel.value === 'cluster' ? 'var(--red)' : '';
      const group = groupIn.value.trim() || '<group>';
      const b = await window.api.kube.groupBinding({ group, clusterRole: roleSel.value || 'view', namespaces: ns() });
      bindingYaml = b.ok ? b.yaml : '';
      bindingBox.textContent = b.ok ? b.yaml : b.error;
      cmdBox.textContent = `kubectl --context=${kubeSpec.contextName} apply -f - <<'YAML'\n${bindingYaml}YAML`;
      const r = await window.api.kube.teleportRoleFor({ group, clusterLabels, kubeClusterName: kubeSpec.kubeClusterName || title, namespaces: ns() });
      roleYaml = r.ok ? r.yaml : '';
      roleFile = r.ok ? `${r.name}.yaml` : 'kube-role.yaml';
      roleBox.textContent = r.ok ? r.yaml : r.error;
      roleNote.textContent = [
        `Save it, then: tctl create -f ${roleFile}`,
        'Then give the role to the people who should have it — on their user, through your SSO connector’s mapping, or as a role in an access request.',
        r.broadLabels ? 'kubernetes_labels is \'*\': \'*\' — every Kubernetes cluster. Narrow it to this cluster’s own labels before using it widely.' : `kubernetes_labels matches this cluster’s own labels (${Object.entries(clusterLabels).filter(([k]) => !k.startsWith('teleport.')).map(([k, v]) => `${k}=${v}`).join(', ')}).`,
      ].join('\n');
    };
    for (const n of [groupIn]) n.addEventListener('input', paint);
    for (const n of [roleSel, scopeSel, ...nsBoxes.map((b) => b.input)]) n.addEventListener('change', paint);

    await modal({
      title: 'Map a Teleport group to a ClusterRole', subtitle: title || kubeSpec.contextName, width: 'min(900px, 96vw)', resize: 'kube-group-map',
      render: (body) => body.append(
        el('div', { class: 'hint', style: 'margin-bottom:10px', text:
          'Teleport reaches the cluster as the Kubernetes groups a user’s role allows. A group has no permissions of its own until a binding gives it a role — this makes that binding, and the Teleport role that hands out the group.' }),
        el('div', { style: 'font-weight:600;margin-bottom:4px', text: '1 · In this cluster' }),
        el('div', { class: 'field-row' }, field('Group', groupIn, 'Any name — it is created by being bound'), field('ClusterRole', el('div', {}, roleSel, roleHelp))),
        field('Where', scopeSel), nsField,
        el('div', { style: 'font-size:12px;font-weight:600;margin-top:6px', text: 'The binding' }), bindingBox,
        el('div', { style: 'font-size:12px;font-weight:600;margin-top:6px', text: 'What Apply runs' }), cmdBox,
        note,
        el('div', { style: 'font-weight:600;margin:14px 0 4px', text: '2 · In Teleport — where the group goes in a role' }),
        el('div', { class: 'hint', text: 'spec.allow.kubernetes_groups lists the groups a user with this role may act as here. kubernetes_labels picks which clusters it applies to; kubernetes_resources (role v8) narrows what inside them.' }),
        roleBox, roleNote,
        el('div', { style: 'display:flex;gap:6px;margin-top:6px' },
          el('button', { class: 'ghost-btn sm', text: 'Copy role YAML', onClick: async () => { await window.api.clipboard.write(roleYaml); toast('Role copied'); } }),
          el('button', {
            class: 'ghost-btn sm', text: 'Export role.yaml…',
            onClick: async () => {
              const saved = await window.api.dialog.saveText({ text: roleYaml, defaultPath: roleFile, title: 'Save the Teleport role' });
              if (saved) toast(`Saved ${saved.path} — tctl create -f ${saved.path}`);
            },
          }))),
      buttons: [
        { label: 'Close', value: null },
        { label: 'Copy binding YAML', onClick: async () => { await window.api.clipboard.write(bindingYaml); toast('Binding copied'); } },
        {
          label: 'Apply the binding', class: 'primary-btn',
          onClick: async () => {
            if (!groupIn.value.trim()) return toast('Name the group first', 'error');
            if (!bindingYaml) return;
            const kind = scopeSel.value === 'ns' ? 'rolebindings' : 'clusterrolebindings';
            const can = await window.api.kube.canI({ spec: kubeSpec, target: { verb: 'create', resource: kind, namespace: ns()[0] } }).catch(() => null);
            if (can && can.allowed === false && !can.unknown) { note.textContent = `Your role can't create ${kind} here — copy the binding for someone who can.`; note.style.color = 'var(--red)'; return; }
            const sure = await confirm({
              title: 'Apply the binding?',
              message: `Group "${groupIn.value.trim()}" gets ClusterRole "${roleSel.value}" ${scopeSel.value === 'ns' ? `in ${ns().join(', ') || 'no namespace'}` : 'across the whole cluster'}.`,
              detail: bindingYaml, confirmLabel: 'Apply', danger: roleSel.value === 'cluster-admin',
            });
            if (!sure) return;
            const r = await window.api.kube.applyYaml({ spec: kubeSpec, yaml: bindingYaml });
            note.textContent = r.ok ? `Applied — ${r.output || 'done'}. Now give the Teleport role below to the people who should have it.` : `Not applied: ${r.error}`;
            note.style.color = r.ok ? 'var(--green)' : 'var(--red)';
          },
        },
      ],
    });
  };

  /** The whole cluster, through the same request flow a requestable kube cluster's row uses. */
  const requestClusterAccess = async () => {
    const profile = (state.teleportProfiles || []).find((p) => (p.proxy || '') === kubeSpec.teleportProxy)
      || (state.teleportProfiles || []).find((p) => p.cluster === kubeSpec.teleportCluster);
    if (!profile) return toast('Log in to that cluster first', 'error');
    const name = kubeSpec.kubeClusterName || title || kubeSpec.contextName;
    const { requestAccessTo } = await import('./teleportpanel.js');
    await requestAccessTo(profile, {
      id: `/${profile.cluster}/kube_cluster/${name}`, kind: 'kube_cluster', name, uuid: name, cluster: profile.cluster, labels: {},
    });
  };
  /*
   * "You may not look at this" said once, with the way forward beside it —
   * in place of kubectl's own error (a Go panic, or "Forbidden: unknown",
   * from a cluster that is visible but not yet granted).
   */
  const NO_ACCESS_RE = /isn't letting you in|^Not allowed: |your role can't list/i;
  /*
   * Two different situations, said differently. The cluster not letting you
   * in at all is a request for the cluster. One kind being off limits — a
   * role that may not list nodes — is normal on a restricted role and
   * nothing to request the whole cluster over: it says so, and leads with
   * what you can do (My access, back to the overview) rather than a request
   * button on its own.
   */
  const noAccessPanel = (message) => {
    const wholeCluster = /isn't letting you in/i.test(message);
    const btn = (text, onClick) => el('button', { class: 'ghost-btn sm', text, onClick });
    return el('div', { class: 'sb-empty', style: 'text-align:left;padding:10px' },
      el('div', { style: 'margin-bottom:8px', text: message }),
      !wholeCluster ? el('div', { class: 'hint', style: 'margin-bottom:8px', text: 'Your role covers other parts of this cluster — this kind is just outside it.' }) : null,
      el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
        btn('My access', () => openAccessModal()),
        !wholeCluster ? btn('Back to the overview', () => { stopLive(); selected = null; podScope = null; render(); }) : null,
        kubeSpec.teleportProxy && wholeCluster ? btn('Request access to this cluster…', () => requestClusterAccess()) : null,
        kubeSpec.teleportProxy ? btn('Request namespace/pod access…', () => requestKubeResourceAccess()) : null));
  };

  const requestKubeResourceAccess = async () => {
    const profile = (state.teleportProfiles || []).find((p) => (p.proxy || '') === kubeSpec.teleportProxy)
      || (state.teleportProfiles || []).find((p) => p.cluster === kubeSpec.teleportCluster);
    if (!profile) return toast('Log in to that cluster first', 'error');
    const { pickRequestResources } = await import('./requestpicker.js');
    const picked = await pickRequestResources(profile, [], {
      title: `Request a namespace or pod in ${kubeSpec.kubeClusterName || title}…`,
      subtitle: kubeSpec.kubeClusterName || title || kubeSpec.contextName,
      initialKind: 'kube_resource',
      initialKubeCluster: kubeSpec.kubeClusterName || undefined,
    });
    if (!picked || !picked.length) return;
    const { requestAccessToMany } = await import('./teleportpanel.js');
    await requestAccessToMany(profile, picked);
  };

  /**
   * "My access": who the cluster sees you as, and what you may do. Through
   * Teleport `auth whoami` and `can-i --list` are usually refused, so the
   * identity can come from the Teleport profile and the rights from a grid
   * of single can-i questions — plus a box to ask any one of your own.
   */
  const openAccessModal = () => {
    const nsSel = select([{ value: '', label: 'default' }, ...namespaces.filter((n) => n !== 'default').map((n) => ({ value: n, label: n }))], selectedNs === 'default' ? '' : selectedNs);
    const verbSel = select(['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection', 'impersonate', '*']
      .map((v) => ({ value: v, label: v })), 'delete');
    const resIn = textInput({ value: 'pods', placeholder: 'pods, deployments, pods/exec, secrets…' });
    // Suggestions, not a guess you have to type from memory — every resource
    // kind this cluster actually discovered (CRDs included, same `types`
    // the nav tree is built from) plus the two subresources can-i cares
    // about that api-resources never lists. A <datalist> rather than a
    // <select>: still free text for anything not in the list.
    const datalistId = `kube-access-resources-${Math.random().toString(36).slice(2)}`;
    const resourceOptions = [...new Set([...(types || []).map((t) => t.name), 'pods/exec', 'pods/log'])].filter(Boolean).sort();
    const resourceList = el('datalist', { id: datalistId }, ...resourceOptions.map((name) => el('option', { value: name })));
    resIn.setAttribute('list', datalistId);
    const answer = el('span', { style: 'font-weight:600' });
    const idBox = el('div', {}, el('div', { class: 'sb-empty', text: 'Asking…' }));
    const grid = el('div', {}, el('div', { class: 'sb-empty', text: 'Checking what you can do — one can-i per box, this takes a few seconds…' }));
    const nsOf = () => nsSel.value || 'default';

    // Ask as someone else — --as/--as-group, the same flags `kubectl`
    // itself uses. Blank (the default) means "as me," exactly as before;
    // this never creates or touches anything, it only changes who the
    // question below is asked about.
    const asUserIn = textInput({ value: '', placeholder: 'e.g. system:serviceaccount:ns:name (optional)' });
    const asGroupsIn = textInput({ value: '', placeholder: 'comma-separated (optional)' });
    const asOf = () => ({
      asUser: asUserIn.value.trim() || undefined,
      asGroups: asGroupsIn.value.trim() ? asGroupsIn.value.split(',').map((g) => g.trim()).filter(Boolean) : undefined,
    });

    const ask = async () => {
      const resource = resIn.value.trim();
      if (!resource) return;
      answer.textContent = '…'; answer.style.color = 'var(--muted)';
      let r;
      try { r = await window.api.kube.canI({ spec: kubeSpec, target: { verb: verbSel.value, resource, namespace: nsOf(), ...asOf() } }); }
      catch (e) { r = { unknown: true, error: e.message }; }
      answer.textContent = r?.unknown ? `could not ask — ${r.error || 'the cluster did not say why'}` : r?.allowed ? 'yes' : 'no';
      answer.style.color = r?.unknown ? 'var(--amber)' : r?.allowed ? 'var(--green)' : 'var(--red)';
    };
    resIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ask(); } });

    const loadGrid = async () => {
      clear(grid);
      grid.append(el('div', { class: 'sb-empty', text: 'Checking what you can do — one can-i per box, this takes a few seconds…' }));
      // Through Teleport, a refused call can come back as a thrown IPC
      // error rather than an {ok:false} answer — treated the same as "the
      // cluster would not say" rather than left to crash the modal on a
      // null identity/rights/verbs.
      let r;
      try { r = await window.api.kube.access({ spec: kubeSpec, target: { namespace: nsOf(), teleportProxy: kubeSpec.teleportProxy || null, ...asOf() } }); }
      catch { r = null; }
      const rights = r?.rights || [];
      const verbs = r?.verbs?.length ? r.verbs : ['get', 'list', 'create', 'update', 'delete'];
      clear(idBox);
      const id = r?.identity;
      if (id?.source === 'impersonated') {
        idBox.append(el('div', { class: 'hint', text: 'Showing what the identity below can do, not you — clear both fields and Apply to go back to yourself.' }));
      }
      if (!id) {
        idBox.append(el('div', { class: 'sb-empty', text: r
          ? 'The cluster would not say (kubectl auth whoami is refused), and there is no Teleport profile to ask instead.'
          : 'Could not check your access right now.' }));
      } else {
        const row = (k, v) => el('div', { style: 'display:flex;gap:8px;font-size:12px;margin:2px 0' },
          el('span', { style: 'color:var(--muted);width:120px;flex:none', text: k }), el('span', { text: v }));
        const users = id.users || [];
        const groups = id.groups || [];
        idBox.append(
          id.teleportUser ? row('Teleport user', id.teleportUser) : null,
          row('Kubernetes user', users.length ? users.join(', ') : (id.source === 'teleport' ? `(none set — Teleport uses ${id.teleportUser || 'your Teleport user'})` : '—')),
          row('Kubernetes groups', groups.length ? groups.join(', ') : '—'),
          id.roles?.length ? row('Teleport roles', id.roles.join(', ')) : null,
          el('div', { class: 'hint', text: id.source === 'cluster'
            ? 'From the cluster itself (kubectl auth whoami).'
            : 'From your Teleport login: the cluster does not let this role ask it directly. Teleport can narrow this further per resource (kubernetes_resources).' }));
      }
      clear(grid);
      if (!rights.length) { grid.append(el('div', { class: 'sb-empty', text: 'Could not check what you can do right now.' })); return; }
      const mark = (x) => el('span', {
        style: `text-align:center;font-weight:600;color:${!x ? 'var(--muted)' : x.unknown ? 'var(--amber)' : x.allowed ? 'var(--green)' : 'var(--red)'}`,
        title: !x ? 'not asked' : x.unknown ? 'could not ask' : x.allowed ? 'yes' : 'no',
        text: !x ? '' : x.unknown ? '?' : x.allowed ? '✓' : '✗',
      });
      const cols = `minmax(0,1fr) repeat(${verbs.length}, 64px)`;
      grid.append(el('div', { class: 'kube-row kube-head', style: `grid-template-columns:${cols}` },
        el('span', { text: `Resource (in ${nsOf()})` }), ...verbs.map((v) => el('span', { style: 'text-align:center', text: v }))));
      const byRes = new Map();
      for (const x of rights) { if (!byRes.has(x.resource)) byRes.set(x.resource, []); byRes.get(x.resource).push(x); }
      for (const [res, xs] of byRes) {
        // A subresource (pods/exec, pods/log) is asked only its one verb; the
        // rest of its row stays blank rather than reading as a "no".
        grid.append(el('div', { class: 'kube-row', style: `grid-template-columns:${cols}` },
          el('span', { text: res + (xs[0].cluster ? '  (cluster-wide)' : '') }),
          ...verbs.map((v) => mark(xs.find((x) => x.verb === v)))));
      }
    };
    nsSel.addEventListener('change', loadGrid);

    // The reverse of can-i: not "can I do this," but "who already can" —
    // every Role/ClusterRole a RoleBinding/ClusterRoleBinding actually
    // grants this to, across every subject at once (kuberbac.js).
    const whoVerbSel = select(['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', '*'].map((v) => ({ value: v, label: v })), 'get');
    const whoResIn = textInput({ value: 'pods', placeholder: 'pods, deployments, secrets…' });
    whoResIn.setAttribute('list', datalistId);
    const whoNsSel = select([{ value: '', label: 'every namespace' }, ...namespaces.map((n) => ({ value: n, label: n }))], '');
    const whoResults = el('div', {}, el('div', { class: 'sb-empty', text: 'Pick a verb and resource, then Find.' }));
    const findWhoCan = async () => {
      const resource = whoResIn.value.trim();
      if (!resource) return;
      clear(whoResults);
      whoResults.append(el('div', { class: 'sb-empty', text: 'Checking every Role/ClusterRole binding — a moment on a big cluster…' }));
      // The same discovered-type list resIn's own datalist is built from —
      // its apiVersion says which apiGroup a rule actually has to name.
      const typeInfo = (types || []).find((t) => t.name === resource.split('/')[0]);
      const apiGroup = typeInfo?.apiVersion?.includes('/') ? typeInfo.apiVersion.split('/')[0] : '';
      let r;
      try { r = await window.api.kube.whoCan({ spec: kubeSpec, target: { verb: whoVerbSel.value, resource, apiGroup, namespace: whoNsSel.value || undefined } }); }
      catch (e) { r = { ok: false, error: e.message }; }
      clear(whoResults);
      if (!r?.ok) { whoResults.append(el('div', { class: 'sb-empty', text: r?.error || 'Could not check.' })); return; }
      if (!r.matches.length) { whoResults.append(el('div', { class: 'sb-empty', text: 'No one — no Role or ClusterRole binding grants this.' })); return; }
      whoResults.append(el('div', { class: 'kube-row kube-head', style: 'grid-template-columns:1fr 1fr 1fr' },
        el('span', { text: 'Subject' }), el('span', { text: 'Via' }), el('span', { text: 'Role' })));
      for (const m of r.matches) {
        whoResults.append(el('div', { class: 'kube-row', style: 'grid-template-columns:1fr 1fr 1fr' },
          el('span', { text: `${m.subject.kind}: ${m.subject.name}${m.subject.namespace ? ' (' + m.subject.namespace + ')' : ''}` }),
          el('span', { text: `${m.binding.kind}/${m.binding.name}${m.binding.namespace ? ' in ' + m.binding.namespace : ''}` }),
          el('span', { text: `${m.role.kind}/${m.role.name}` })));
      }
    };

    modal({
      title: 'My access', subtitle: title || '', width: 'min(820px, 94vw)', resize: 'kube-access',
      render: (body) => {
        body.append(
          idBox,
          el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px' },
            el('span', { style: 'color:var(--muted)', text: 'Ask/check as' }), asUserIn,
            el('span', { style: 'color:var(--muted)', text: 'groups' }), asGroupsIn,
            el('button', {
              class: 'ghost-btn sm', text: 'Apply', onClick: loadGrid,
              title: 'Re-check "What you can do" (and Ask, below) as this identity instead of yours — leave both blank for yourself',
            })),
          el('div', { style: 'font-weight:600;margin:14px 0 6px', text: 'Can I…?' }),
          el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' },
            verbSel, resIn, resourceList, el('span', { style: 'color:var(--muted)', text: 'in' }), nsSel,
            el('button', { class: 'ghost-btn sm', text: 'Ask', onClick: ask }), answer),
          el('div', { class: 'hint', text: 'kubectl auth can-i — the same question the cluster answers before anything you do. A "no" can be asked for: request a role with more access from Teleport.' }),
          el('div', { style: 'font-weight:600;margin:14px 0 6px', text: 'What you can do' }),
          grid,
          el('div', { style: 'font-weight:600;margin:14px 0 6px', text: 'Who can do this?' }),
          el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' },
            whoVerbSel, whoResIn, el('span', { style: 'color:var(--muted)', text: 'in' }), whoNsSel,
            el('button', { class: 'ghost-btn sm', text: 'Find', onClick: findWhoCan })),
          el('div', { class: 'hint', text: 'Every RoleBinding/ClusterRoleBinding whose Role/ClusterRole already grants this — the reverse of Can I…? above.' }),
          whoResults);
        loadGrid();
      },
      buttons: [{ label: 'Close', value: true, class: 'primary-btn' }],
    });
  };

  /**
   * A Popeye scan — misconfigurations and common risks (untagged images,
   * no resource limits, no probes, running as root, no NetworkPolicy…),
   * not a deep CVE scanner. kube-bench (runs as a Job against node-local
   * files) and image vulnerability scanning (a registry-aware scanner)
   * are a different shape of integration than "shell out and parse" —
   * deliberately out of scope here; see GUIDE.md.
   */
  const openScanModal = () => {
    let scanState = { status: 'idle' };
    const scopeSel = select([{ value: '', label: 'every namespace' }, ...namespaces.map((n) => ({ value: n, label: n }))], selectedNs || '');
    let body = null;

    const levelColor = (lvl) => (lvl >= 3 ? 'var(--red)' : lvl === 2 ? 'var(--amber)' : 'var(--muted)');
    const levelLabel = (lvl) => (lvl >= 3 ? 'error' : lvl === 2 ? 'warning' : lvl === 1 ? 'info' : 'ok');

    const renderResult = () => {
      if (scanState.status === 'idle') {
        return el('div', { class: 'sb-empty', text: 'Popeye (derailed/popeye) — pick a scope and Run scan.' });
      }
      if (scanState.status === 'running') return el('div', { class: 'sb-empty', text: 'Scanning — this can take a while on a big cluster…' });
      if (scanState.status === 'error') return el('div', { class: 'sb-empty', text: scanState.error });
      const report = scanState.report || {};
      const sections = (report.sections || []).filter((s) => Object.keys(s.issues || {}).length);
      return el('div', {},
        el('div', { style: 'display:flex;gap:16px;align-items:baseline;margin-bottom:10px' },
          el('span', { style: 'font-size:28px;font-weight:700', text: report.grade || '—' }),
          el('span', { style: 'color:var(--muted)', text: `score ${report.score ?? '—'}/100` })),
        ...(!sections.length ? [el('div', { class: 'sb-empty', text: 'Nothing to report — clean.' })] : sections.flatMap((s) => [
          el('div', { style: 'font-weight:600;margin:10px 0 4px', text: `${s.linter} (${s.gvr})` }),
          ...Object.entries(s.issues || {}).flatMap(([resKey, issues]) => (issues || []).map((iss) =>
            el('div', { class: 'kube-row', style: 'grid-template-columns:70px minmax(0,1fr)' },
              el('span', { style: `color:${levelColor(iss.level)}`, text: levelLabel(iss.level) }),
              el('span', { text: `${resKey} — ${iss.message}` })))),
        ])));
    };

    const render = () => {
      if (!body) return;
      clear(body);
      body.append(
        el('div', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:10px' },
          el('span', { style: 'color:var(--muted)', text: 'Scope' }), scopeSel,
          el('button', {
            class: 'ghost-btn sm', text: scanState.status === 'running' ? 'Scanning…' : 'Run scan',
            disabled: scanState.status === 'running', onClick: runScan,
          })),
        renderResult());
    };

    const runScan = async () => {
      scanState = { status: 'running' };
      render();
      let r;
      try { r = await window.api.kube.lintScan({ spec: kubeSpec, target: { namespace: scopeSel.value || undefined } }); }
      catch (e) { r = { ok: false, error: e.message }; }
      scanState = r?.ok ? { status: 'done', report: r.report } : { status: 'error', error: r?.error || 'Could not run the scan.' };
      render();
    };

    modal({
      title: 'Scan cluster', subtitle: title || '', width: 'min(820px, 94vw)', resize: 'kube-scan',
      render: (b) => { body = b; render(); },
      buttons: [{ label: 'Close', value: true, class: 'primary-btn' }],
    });
  };

  /**
   * Cross-cluster search — scoped to clusters that already have an open
   * browser tab (`state.panes`, each carrying its own `.kubeSpec`), not
   * every cluster reachable: querying every one would mean silently
   * opening new, unattended connections in the background, where
   * searching what's already open does not. Bounded to one chosen kind
   * at a time rather than every discovered kind (100+ on a real
   * cluster) — a name match across every kind in every open cluster
   * would be a lot of kubectl calls for one search box.
   */
  const COMMON_SEARCH_KINDS = ['Pod', 'Deployment', 'Service', 'ConfigMap', 'Secret', 'StatefulSet', 'DaemonSet', 'Ingress', 'Job', 'CronJob'];
  const openCrossClusterSearch = () => {
    const panes = [...state.panes.values()].filter((p) => p.isKubeBrowser && p.kubeSpec);
    if (panes.length < 2) return toast('Open at least one more cluster tab to search across clusters', 'error');
    const kindSel = select(COMMON_SEARCH_KINDS.map((k) => ({ value: k, label: k })), 'Pod');
    const queryIn = textInput({ placeholder: 'Name (substring, optional) — Enter to search' });
    const resultsBox = el('div', { style: 'margin-top:10px;max-height:320px;overflow:auto' });
    const runSearch = async () => {
      clear(resultsBox);
      resultsBox.append(el('div', { class: 'sb-empty', text: 'Searching the open clusters…' }));
      const kind = kindSel.value;
      const q = queryIn.value.trim().toLowerCase();
      const perCluster = await Promise.all(panes.map(async (p) => {
        try {
          const typesR = await window.api.kube.resourceTypes({ spec: p.kubeSpec });
          const ty = typesR.ok ? typesR.types.find((t) => t.kind === kind) : null;
          if (!ty) return { pane: p, ty: null, items: [] };
          const r = await window.api.kube.resources({ spec: p.kubeSpec, type: { name: ty.name, namespaced: ty.namespaced } });
          return { pane: p, ty, items: (r.ok ? r.items : []).filter((it) => !q || it.name.toLowerCase().includes(q)) };
        } catch { return { pane: p, ty: null, items: [] }; }
      }));
      clear(resultsBox);
      if (!perCluster.some((pc) => pc.items.length)) { resultsBox.append(el('div', { class: 'sb-empty', text: 'No matches in any open cluster.' })); return; }
      for (const pc of perCluster) {
        if (!pc.items.length) continue;
        resultsBox.append(el('div', { style: 'font-weight:600;margin:8px 0 4px', text: pc.pane.kubeTitle || pc.pane.kubeSpec.contextName || 'cluster' }));
        for (const it of pc.items) {
          resultsBox.append(el('div', { class: 'kube-row', style: 'grid-template-columns:1fr auto' },
            el('span', { text: (it.namespace ? it.namespace + '/' : '') + it.name }),
            el('button', {
              class: 'ghost-btn sm', text: 'View YAML',
              onClick: async () => {
                const yamlR = await window.api.kube.resourceYaml({ spec: pc.pane.kubeSpec, target: { name: it.name, resource: pc.ty.name, namespace: pc.ty.namespaced ? it.namespace : undefined } });
                await textModal(`${pc.pane.kubeTitle || pc.pane.kubeSpec.contextName} — ${kind}/${it.name}`, yamlR.ok ? yamlR.yaml : (yamlR.error || 'Could not read it'), { spec: pc.pane.kubeSpec });
              },
            })));
        }
      }
    };
    queryIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
    kindSel.addEventListener('change', runSearch);
    modal({
      title: 'Search open clusters', width: 'min(620px, 94vw)',
      render: (body) => { body.append(el('div', { style: 'display:flex;gap:8px;align-items:center' }, field('Kind', kindSel), field('Name', queryIn), el('button', { class: 'ghost-btn sm primary-btn', text: 'Search', onClick: runSearch })), resultsBox); runSearch(); },
      buttons: [{ label: 'Close', value: true, class: 'primary-btn' }],
    });
  };

  /** One resource, by kind and name, between two open clusters — a line diff of its YAML (see textdiff.js), the same rendering showValuesDiff() already uses for Helm. */
  const openCompareClusters = () => {
    const panes = [...state.panes.values()].filter((p) => p.isKubeBrowser && p.kubeSpec);
    if (panes.length < 2) return toast('Open at least one more cluster tab to compare', 'error');
    const paneLabel = (p, idx) => p.kubeTitle || p.kubeSpec.contextName || `Cluster ${idx + 1}`;
    const aSel = select(panes.map((p, idx) => ({ value: String(idx), label: paneLabel(p, idx) })), '0');
    const bSel = select(panes.map((p, idx) => ({ value: String(idx), label: paneLabel(p, idx) })), '1');
    const kindIn = textInput({ value: 'Pod', placeholder: 'Pod, Deployment…' });
    const nameIn = textInput({ placeholder: 'resource name' });
    const nsIn = textInput({ placeholder: 'namespace (if namespaced)' });
    const resultBox = el('div', { style: 'margin-top:10px' });
    const run = async () => {
      const kind = kindIn.value.trim();
      const name = nameIn.value.trim();
      if (!kind || !name) return toast('Give it a kind and a name', 'error');
      const pa = panes[Number(aSel.value)];
      const pb = panes[Number(bSel.value)];
      clear(resultBox);
      resultBox.append(el('div', { class: 'sb-empty', text: 'Comparing…' }));
      const [tysA, tysB] = await Promise.all([window.api.kube.resourceTypes({ spec: pa.kubeSpec }), window.api.kube.resourceTypes({ spec: pb.kubeSpec })]);
      const tyA = tysA.ok ? tysA.types.find((t) => t.kind.toLowerCase() === kind.toLowerCase()) : null;
      const tyB = tysB.ok ? tysB.types.find((t) => t.kind.toLowerCase() === kind.toLowerCase()) : null;
      if (!tyA || !tyB) { clear(resultBox); resultBox.append(el('div', { class: 'sb-empty', text: `"${kind}" is not a kind both clusters list.` })); return; }
      const ns = nsIn.value.trim() || undefined;
      const [yamlA, yamlB] = await Promise.all([
        window.api.kube.resourceYaml({ spec: pa.kubeSpec, target: { name, resource: tyA.name, namespace: tyA.namespaced ? ns : undefined } }),
        window.api.kube.resourceYaml({ spec: pb.kubeSpec, target: { name, resource: tyB.name, namespace: tyB.namespaced ? ns : undefined } }),
      ]);
      clear(resultBox);
      if (!yamlA.ok || !yamlB.ok) { resultBox.append(el('div', { class: 'sb-empty', text: yamlA.error || yamlB.error || 'Could not read it from one or both clusters.' })); return; }
      const rows = diffLines(yamlA.yaml, yamlB.yaml).filter((d) => d.type !== 'same');
      resultBox.append(!rows.length
        ? el('div', { class: 'sb-empty', text: 'No difference.' })
        : el('pre', { style: 'font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word;margin:0' },
          ...rows.map((d) => el('div', { style: `color:${d.type === 'add' ? 'var(--green)' : 'var(--red)'}`, text: `${d.type === 'add' ? '+' : '-'} ${d.line}` }))));
    };
    modal({
      title: 'Compare across clusters', width: 'min(680px, 94vw)',
      render: (body) => body.append(
        el('div', { style: 'display:flex;gap:8px' }, field('Cluster A', aSel), field('Cluster B', bSel)),
        el('div', { style: 'display:flex;gap:8px' }, field('Kind', kindIn), field('Name', nameIn), field('Namespace', nsIn)),
        el('button', { class: 'ghost-btn sm primary-btn', text: 'Compare', onClick: run }),
        resultBox),
      buttons: [{ label: 'Close', value: true, class: 'primary-btn' }],
    });
  };

  /** A card's "which ones?": the items behind its count, each one a Describe away from why. */
  const listOverviewItems = (title, resource, items) => modal({
    title, subtitle: `${items.length}`, width: 'min(760px, 94vw)',
    render: (body) => body.append(...(items.length ? items : [null]).map((it) => (!it
      ? el('div', { class: 'sb-empty', text: 'None any more — refresh the overview.' })
      : el('div', { class: 'kube-row', style: 'grid-template-columns:1fr auto' },
        el('span', { title: it.detail || '', text: (it.namespace ? it.namespace + '/' : '') + it.name + (it.detail ? '  ·  ' + it.detail : '') }),
        el('button', {
          class: 'ghost-btn sm', text: 'Describe',
          onClick: async () => {
            const res = await window.api.kube.describeResource({ spec: kubeSpec, target: { name: it.name, resource, namespace: it.namespace || undefined } });
            await textModal(`${resource}/${it.name}`, res.ok ? res.text : (res.error || 'Could not describe it'), { lang: 'text' });
          },
        }))))),
    buttons: [{ label: 'Close', value: true, class: 'primary-btn' }],
  });

  /** A card whose number could not be read: a dash and why, never a 0 that looks like an answer. */
  const unreadableCard = (label, err) => {
    const n = overviewCard(label, '—', unreadable(err), 'var(--muted)');
    n.title = err;
    return n;
  };

  const overviewCard = (label, value, sub, color, onClick = null) => el('div', {
    style: `background:var(--panel-2);border:1px solid var(--border-soft);border-radius:8px;padding:10px 12px;border-left:3px solid ${color}`
      + (onClick ? ';cursor:pointer' : ''),
    title: onClick ? `Show which ${label.toLowerCase()}` : null,
    onClick,
  },
    el('div', { style: 'font-size:22px;font-weight:700', text: String(value) }),
    el('div', { style: 'font-size:12px;color:var(--text)', text: label }),
    el('div', { style: 'font-size:11px;color:var(--muted)', text: sub }));

  // A persistent input, same reasoning as kindFilterInputEl/rowFilterInputEl above.
  let helmFilterInputEl = null;
  const helmSearch = () => {
    if (!helmFilterInputEl) {
      helmFilterInputEl = textInput({ value: helmRowFilter, placeholder: 'Filter releases by name…' });
      helmFilterInputEl.addEventListener('input', () => {
        helmRowFilter = helmFilterInputEl.value;
        const pos = helmFilterInputEl.selectionStart;
        render();
        helmFilterInputEl.focus();
        helmFilterInputEl.setSelectionRange(pos, pos);
      });
    }
    if (helmFilterInputEl.value !== helmRowFilter) helmFilterInputEl.value = helmRowFilter;
    return el('div', { style: 'padding:0 2px 8px' }, helmFilterInputEl);
  };

  const viewHelmValues = async (rel) => {
    const res = await window.api.kube.helmValues({ spec: kubeSpec, target: { release: rel.name, namespace: rel.namespace } });
    await textModal(`${rel.name} — values`, res.ok ? res.yaml : (res.error || 'Could not read values'));
  };
  const exportHelmValues = async (rel) => {
    const res = await window.api.kube.helmValues({ spec: kubeSpec, target: { release: rel.name, namespace: rel.namespace } });
    if (!res.ok) return toast(res.error || 'Could not read values', 'error');
    const saved = await window.api.dialog.saveText({ text: res.yaml, defaultPath: `${rel.name}-values.yaml`, title: `Export ${rel.name} values` });
    if (saved) toast(`Saved ${saved.path}`);
  };
  const exportHelmManifest = async (rel) => {
    const res = await window.api.kube.helmManifest({ spec: kubeSpec, target: { release: rel.name, namespace: rel.namespace } });
    if (!res.ok) return toast(res.error || 'Could not read manifest', 'error');
    const saved = await window.api.dialog.saveText({ text: res.yaml, defaultPath: `${rel.name}-manifest.yaml`, title: `Export ${rel.name} manifest` });
    if (saved) toast(`Saved ${saved.path}`);
  };
  const uninstallHelm = async (rel) => {
    const ok = await confirm({
      title: 'Uninstall release', message: `Uninstall "${rel.name}" from ${rel.namespace}?`,
      detail: 'This removes the release and everything it owns.', confirmLabel: 'Uninstall', danger: true,
    });
    if (!ok) return;
    const r = await window.api.kube.helmUninstall({ spec: kubeSpec, target: { release: rel.name, namespace: rel.namespace } });
    if (!r.ok) return toast(r.error || 'Uninstall failed', 'error');
    toast(`Uninstalled ${rel.name}`);
    loadHelm();
  };
  /** `helm test` — the chart's own tests, run against this already-deployed release. */
  const testHelmRelease = async (rel) => {
    const r = await window.api.kube.helmTest({ spec: kubeSpec, target: { release: rel.name, namespace: rel.namespace } });
    await textModal(`${rel.name} — test`, r.output || (r.ok ? 'No output.' : 'helm test failed'), { lang: 'text' });
  };
  /**
   * A release as a diagram: what `helm get manifest` installs, in columns
   * that read left to right (Ingress → Service → workload → config → RBAC),
   * with an arrow for every reference one resource makes to another — the
   * same graph, and the same arrows, the Mermaid export writes out.
   */
  const viewHelmDiagram = async (rel) => {
    const g = await window.api.kube.helmGraph({ spec: kubeSpec, target: { release: rel.name, namespace: rel.namespace } });
    if (!g.ok) return toast(g.error || 'Could not read the release manifest', 'error');
    const SVG = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs = {}) => {
      const n = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };
    const WORKLOAD = /^(Deployment|StatefulSet|DaemonSet|ReplicaSet|Job|CronJob|Pod)$/;
    const GROUPS = [
      { id: 'edge', label: 'Traffic in', color: '#a371f7', test: (k) => /^(Ingress|Gateway)$|Route$/.test(k) },
      { id: 'svc', label: 'Service', color: '#4fd1ff', test: (k) => k === 'Service' },
      { id: 'work', label: 'Workload', color: '#3fb950', test: (k) => WORKLOAD.test(k) },
      { id: 'cfg', label: 'Config & storage', color: '#d29922', test: (k) => /^(ConfigMap|Secret|PersistentVolumeClaim|ServiceAccount|Certificate|StorageClass)$/.test(k) },
      { id: 'rbac', label: 'RBAC', color: '#f85149', test: (k) => /Role/.test(k) },
      { id: 'other', label: 'Other', color: '#8b949e', test: () => true },
    ];
    const groupOf = (kind) => GROUPS.find((x) => x.test(kind));
    // Basic: the path a request takes and what it needs to run — not who
    // may do what, nor what watches it. All: every resource the release has.
    const BASIC = (k) => /^(Ingress|Gateway)$|Route$/.test(k) || k === 'Service' || WORKLOAD.test(k)
      || /^(ConfigMap|Secret|PersistentVolumeClaim|HorizontalPodAutoscaler|ScaledObject)$/.test(k);
    let mode = 'basic';
    const shown = () => {
      const nodes = mode === 'all' ? g.nodes : g.nodes.filter((n) => BASIC(n.kind));
      const ids = new Set(nodes.map((n) => n.id));
      return { nodes, edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
    };

    const holder = el('div', { style: 'overflow:auto;max-height:64vh;border:1px solid var(--border-soft);border-radius:8px;background:var(--panel)' });
    const counts = el('span', { style: 'color:var(--muted);font-size:12px' });
    const draw = () => {
      const { nodes, edges } = shown();
      counts.textContent = `${nodes.length} of ${g.nodes.length} resources · ${edges.length} links`;
      clear(holder);
      if (!nodes.length) { holder.append(el('div', { class: 'sb-empty', text: 'Nothing to draw in this view.' })); return; }
      const W = 210, H = 56, COL_GAP = 96, ROW_GAP = 14, PAD = 16;
      const ranks = [...new Set(nodes.map((n) => n.rank))].sort((a, b) => a - b);
      const cols = ranks.map((r) => nodes.filter((n) => n.rank === r).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)));
      const pos = new Map();
      cols.forEach((col, ci) => col.forEach((n, ri) => pos.set(n.id, { x: PAD + ci * (W + COL_GAP), y: PAD + ri * (H + ROW_GAP) })));
      const width = PAD * 2 + cols.length * W + Math.max(0, cols.length - 1) * COL_GAP;
      const height = PAD * 2 + Math.max(1, ...cols.map((c) => c.length)) * (H + ROW_GAP);
      const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, style: 'display:block;font-family:var(--sans)' });
      const defs = svgEl('defs');
      const marker = svgEl('marker', { id: 'kg-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      marker.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#c9d1d9' }));
      defs.append(marker);
      svg.append(defs);
      const edgeEls = [];
      for (const e of edges) {
        const a = pos.get(e.from), b = pos.get(e.to);
        const forward = b.x > a.x;
        const x1 = a.x + W, y1 = a.y + H / 2;
        const x2 = forward ? b.x : b.x + W, y2 = b.y + H / 2;
        const bend = forward ? Math.max(30, (x2 - x1) / 2) : 60;
        // Forward edges cross the gap between columns; one within or back
        // across a column loops round the outside rather than through boxes.
        const d = forward
          ? `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
          : `M${x1},${y1} C${x1 + bend},${y1} ${x2 + bend},${y2} ${x2},${y2}`;
        const path = svgEl('path', { d, fill: 'none', stroke: '#c9d1d9', 'stroke-width': 1.4, opacity: 0.6, 'marker-end': 'url(#kg-arrow)' });
        const label = svgEl('text', { x: (x1 + x2) / 2 + (forward ? 0 : bend * 0.75), y: (y1 + y2) / 2 - 4, 'font-size': 10, fill: '#9aa5b8', 'text-anchor': 'middle' });
        label.textContent = e.label;
        svg.append(path, label);
        edgeEls.push({ e, path, label });
      }
      const nodeEls = [];
      const focus = (id) => {
        for (const x of edgeEls) {
          const lit = !id || x.e.from === id || x.e.to === id;
          x.path.setAttribute('opacity', lit ? (id ? 1 : 0.6) : 0.08);
          x.label.setAttribute('opacity', lit ? 1 : 0.1);
        }
        const near = new Set(id ? [id, ...edges.filter((e) => e.from === id || e.to === id).flatMap((e) => [e.from, e.to])] : []);
        for (const x of nodeEls) x.g.setAttribute('opacity', !id || near.has(x.n.id) ? 1 : 0.3);
      };
      const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
      for (const n of nodes) {
        const p = pos.get(n.id);
        const c = groupOf(n.kind).color;
        const grp = svgEl('g', { transform: `translate(${p.x},${p.y})`, style: 'cursor:pointer' });
        grp.append(
          svgEl('rect', { width: W, height: H, rx: 7, fill: 'var(--panel-2)', stroke: c, 'stroke-width': 1.5 }),
          svgEl('rect', { width: 4, height: H, rx: 2, fill: c }));
        const k = svgEl('text', { x: 12, y: 15, 'font-size': 10, fill: c }); k.textContent = n.kind;
        const nm = svgEl('text', { x: 12, y: 31, 'font-size': 12, 'font-weight': 600, fill: 'var(--text)' }); nm.textContent = clip(n.name, 28);
        const dt = svgEl('text', { x: 12, y: 46, 'font-size': 10, fill: 'var(--muted)' }); dt.textContent = clip(n.detail || '', 34);
        const tip = svgEl('title'); tip.textContent = `${n.kind}/${n.name}${n.detail ? '\n' + n.detail : ''}`;
        grp.append(k, nm, dt, tip);
        grp.addEventListener('click', (ev) => { ev.stopPropagation(); focus(n.id); });
        svg.append(grp);
        nodeEls.push({ n, g: grp });
      }
      svg.addEventListener('click', () => focus(null));
      holder.append(svg);
    };

    const modeBtn = (id, label) => el('button', {
      class: 'ghost-btn sm' + (mode === id ? ' active' : ''), text: label, dataset: { mode: id },
      onClick: () => { mode = id; for (const b of modeBar.querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === mode); draw(); },
    });
    const modeBar = el('div', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:8px' },
      modeBtn('basic', 'Basic'), modeBtn('all', 'All'), el('span', { style: 'flex:1' }), counts);
    const legend = el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:var(--text-dim)' },
      ...GROUPS.map((x) => el('span', { style: 'display:flex;align-items:center;gap:4px' },
        el('span', { style: `width:10px;height:10px;border-radius:2px;background:${x.color};display:inline-block` }), el('span', { text: x.label }))));

    // The Mermaid of what is on screen — Basic or All — not always the full graph.
    const mermaidNow = async () => {
      if (mode === 'all') return g.mermaid;
      const r = await window.api.kube.mermaid({ ...shown(), title: `Helm release ${rel.name} (${rel.namespace}) — basic` });
      return r.mermaid;
    };
    const copyMermaid = async () => { await window.api.clipboard.write(await mermaidNow()); toast('Mermaid copied'); };
    const exportMermaid = async () => {
      const saved = await window.api.dialog.saveText({ text: await mermaidNow(), defaultPath: `${rel.name}${mode === 'basic' ? '-basic' : ''}.mmd`, title: `Export ${rel.name} as Mermaid` });
      if (saved) toast(`Saved ${saved.path}`);
    };
    draw();
    await modal({
      title: `${rel.name} — diagram`, subtitle: rel.chart || '',
      width: 'min(1280px, 96vw)', resize: 'helm-diagram',
      render: (body) => {
        body.append(
          modeBar,
          g.nodes.length ? holder : el('div', { class: 'sb-empty', text: 'The release manifest has no resources in it.' }),
          legend,
          el('div', { class: 'hint', style: 'margin-top:6px', text: 'Basic: the path traffic takes and what it needs to run. All: everything — RBAC, accounts, monitors, webhooks, certificates. Click a resource to light up just its links.' }),
          g.external?.length
            ? el('div', { class: 'hint', text: `Referenced but not part of this release: ${g.external.join(', ')}` })
            : null);
      },
      buttons: [
        { label: 'Copy Mermaid', onClick: () => copyMermaid() },
        { label: 'Export .mmd…', onClick: () => exportMermaid() },
        { label: 'Close', value: true, class: 'primary-btn' },
      ],
    });
  };

  /**
   * `helm upgrade`, as a wizard: the chart found again in the local repos
   * (helm list records only `name-version`, not where it came from), a
   * version from that repo — newest first, the current one marked — and
   * the release's own current values to start from. Values go in as YAML
   * on stdin, the same as install; the exact command is shown live and can
   * be copied instead of run.
   */
  const viewHelmUpgrade = async (rel) => {
    const { name: chartName, version: currentVersion } = splitChart(rel.chart);
    const chartSel = el('select', { style: 'flex:1' });
    const chartIn = textInput({ placeholder: 'repo/chart, or a local path', style: 'flex:1' });
    const versionSel = el('select', { style: 'flex:1' });
    const valuesIn = el('textarea', {
      style: 'width:100%;height:160px;font-family:var(--mono);font-size:12px', spellcheck: 'false',
      placeholder: '# values for the upgrade — starts as the release’s current values',
    });
    const dryRunIn = checkbox('Dry run (render the upgrade, change nothing)', true);
    const cmdBox = el('pre', {
      style: 'font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-all;user-select:text;'
        + 'max-height:160px;overflow:auto;margin:4px 0 0;background:var(--panel-2);border:1px solid var(--border);'
        + 'border-radius:var(--radius);padding:8px 10px;color:var(--text)',
    });
    const out = el('pre', {
      style: 'font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-word;'
        + 'max-height:200px;overflow:auto;margin-top:10px;background:var(--panel-2);border:1px solid var(--border);'
        + 'border-radius:var(--radius);padding:8px 10px;color:var(--text-dim)',
    });
    const note = el('div', { class: 'hint' });
    const chartRef = () => (chartSel.value && chartSel.value !== '__other' ? chartSel.value : chartIn.value.trim());
    // The same repo-ref-vs-local-path heuristic loadVersions() below
    // already uses: a chart's own group from `helm list` only ever
    // records `name-version`, never where it came from or whether that
    // was a repo at all.
    const isLocalRef = (ref) => !ref.includes('/') || ref.startsWith('/') || ref.startsWith('.');
    const readmeBtn = el('button', {
      class: 'ghost-btn sm', text: 'README', title: 'helm show readme',
      onClick: async () => {
        const ref = chartRef();
        if (!ref) return toast('Name a chart first', 'error');
        const r = await window.api.kube.helmReadme({ spec: kubeSpec, target: { chartRef: ref } });
        await textModal(`${ref} — README`, r.ok ? r.text : (r.error || 'Could not read the README'), { lang: 'text' });
      },
    });
    const renderBtn = el('button', {
      class: 'ghost-btn sm', text: 'Render templates…', title: 'helm template — renders locally, touches nothing',
      onClick: async () => {
        const ref = chartRef();
        if (!ref) return toast('Name a chart first', 'error');
        const r = await window.api.kube.helmRenderTemplate({ spec: kubeSpec, target: { name: rel.name, chartRef: ref, valuesYaml: valuesIn.value } });
        await textModal(`${ref} — rendered templates`, r.ok ? r.yaml : (r.error || 'Could not render this chart'));
      },
    });
    const schemaForm = el('div', { class: 'hidden' });
    const loadSchemaForm = () => buildSchemaForm(schemaForm, { chartRef: chartRef(), local: isLocalRef(chartRef()), valuesIn, afterUse: paint });
    const target = (extra = {}) => ({
      release: rel.name, namespace: rel.namespace, chartRef: chartRef() || '<repo/chart>',
      version: versionSel.value || '', valuesYaml: valuesIn.value, dryRun: dryRunIn.input.checked, ...extra,
    });
    const paint = async () => {
      chartIn.style.display = chartSel.value === '__other' || !chartSel.options.length ? '' : 'none';
      const r = await window.api.kube.helmUpgrade({ spec: kubeSpec, target: target({ preview: true }) });
      cmdBox.textContent = r.ok ? r.command : (r.error || '');
    };
    const loadVersions = async () => {
      clear(versionSel);
      versionSel.append(el('option', { value: '', text: 'Newest in the repo' }));
      const ref = chartRef();
      if (ref && ref.includes('/') && !ref.startsWith('/') && !ref.startsWith('.')) {
        const v = await window.api.kube.helmSearch({ spec: kubeSpec, target: { versionsOf: ref } });
        for (const c of (v.charts || []).slice(0, 60)) {
          versionSel.append(el('option', { value: c.version, text: c.version + (c.version === currentVersion ? '  (current)' : '') + (c.appVersion ? `  · app ${c.appVersion}` : '') }));
        }
      }
      paint();
    };
    const loadCharts = async (refresh = false) => {
      note.textContent = refresh ? 'Updating the local repos…' : 'Looking for the chart in the local repos…';
      const r = await window.api.kube.helmSearch({ spec: kubeSpec, target: { name: chartName, refresh } });
      clear(chartSel);
      for (const c of r.charts || []) chartSel.append(el('option', { value: c.ref, text: `${c.ref}  (newest ${c.version})` }));
      chartSel.append(el('option', { value: '__other', text: 'Other — type it…' }));
      note.textContent = (r.charts || []).length
        ? `Installed from ${chartName} ${currentVersion}. Pick where to upgrade it from.`
        : `No repo here has a chart called "${chartName}". Add its repo (Install release… does), update repos, or type the chart.`;
      if (!(r.charts || []).length) chartSel.value = '__other';
      await loadVersions();
    };
    chartSel.addEventListener('change', () => { loadVersions(); loadSchemaForm(); });
    chartIn.addEventListener('input', paint);
    chartIn.addEventListener('change', () => { loadVersions(); loadSchemaForm(); });
    for (const n of [versionSel, dryRunIn.input]) n.addEventListener('change', paint);
    valuesIn.addEventListener('input', paint);

    const vals = await window.api.kube.helmValues({ spec: kubeSpec, target: { release: rel.name, namespace: rel.namespace } });
    valuesIn.value = vals.ok && vals.yaml.trim() !== 'null' ? vals.yaml : '';
    loadCharts();
    loadSchemaForm();

    let running = false;
    await modal({
      title: `Upgrade ${rel.name}`, subtitle: `${rel.namespace} · ${rel.chart} · revision ${rel.revision}`, width: 'min(680px, 94vw)',
      render: (body) => body.append(
        field('Chart', el('div', { style: 'display:flex;gap:6px' }, chartSel, chartIn,
          el('button', { class: 'ghost-btn sm', text: '⟳ Update repos', title: 'helm repo update, then look again', onClick: () => loadCharts(true) }))),
        note,
        field('Version', versionSel),
        el('div', { style: 'display:flex;gap:6px;margin-bottom:8px' }, readmeBtn, renderBtn),
        field('Values', valuesIn, 'These replace the release’s values (--reset-values): what is here is what it gets. Rollback in History undoes an upgrade.'),
        schemaForm,
        dryRunIn,
        el('div', { style: 'font-size:12px;font-weight:600;margin-top:10px', text: 'What will run' }),
        cmdBox, out),
      buttons: [
        { label: 'Close', value: null },
        {
          label: 'Copy command',
          onClick: async () => { await paint(); await window.api.clipboard.write(cmdBox.textContent); toast('Command copied'); },
        },
        {
          label: 'Upgrade', class: 'primary-btn',
          onClick: async () => {
            if (running) return;
            if (!chartRef()) return toast('Pick or type the chart to upgrade from', 'error');
            if (!dryRunIn.input.checked) {
              const ok = await confirm({ title: 'Upgrade release', message: `Upgrade "${rel.name}" in ${rel.namespace}?`, detail: cmdBox.textContent, confirmLabel: 'Upgrade', danger: true });
              if (!ok) return;
            }
            running = true;
            out.textContent = `Running helm upgrade${dryRunIn.input.checked ? ' --dry-run' : ''}…`;
            try {
              const r = await window.api.kube.helmUpgrade({ spec: kubeSpec, target: target() });
              out.textContent = r.ok ? (r.output || 'Done.') : 'helm upgrade failed: ' + r.error;
              if (r.ok && !dryRunIn.input.checked) { toast(`Upgraded ${rel.name}`); loadHelm(); }
            } finally { running = false; }
          },
        },
      ],
    });
  };

  /** A revision's own values against the release's current ones — line by line, since there's no live cluster object to run `diffYaml` against here, and no `helm diff` plugin can be assumed installed. */
  const showValuesDiff = async (rel, revision) => {
    const [then, now] = await Promise.all([
      window.api.kube.helmValues({ spec: kubeSpec, target: { release: rel.name, namespace: rel.namespace, revision } }),
      window.api.kube.helmValues({ spec: kubeSpec, target: { release: rel.name, namespace: rel.namespace } }),
    ]);
    if (!then.ok || !now.ok) return toast(then.error || now.error || 'Could not read values', 'error');
    const rows = diffLines(then.yaml, now.yaml).filter((d) => d.type !== 'same');
    await modal({
      title: `${rel.name} — revision ${revision} vs current`, width: 'min(720px, 94vw)',
      render: (body) => body.append(!rows.length
        ? el('div', { class: 'sb-empty', text: 'No difference in values.' })
        : el('pre', {
          style: 'font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word;margin:0',
        }, ...rows.map((d) => el('div', {
          style: `color:${d.type === 'add' ? 'var(--green)' : 'var(--red)'}`,
          text: `${d.type === 'add' ? '+' : '-'} ${d.line}`,
        })))),
      buttons: [{ label: 'Close', value: true, class: 'primary-btn' }],
    });
  };

  /** Every revision from `helm history`, each one a Rollback away from being current again. */
  const viewHelmHistory = async (rel) => {
    const res = await window.api.kube.helmHistory({ spec: kubeSpec, target: { release: rel.name, namespace: rel.namespace } });
    await modal({
      title: `${rel.name} — history`, width: 'min(760px, 94vw)',
      render: (body) => {
        if (!res.ok) { body.append(el('div', { class: 'sb-empty', text: res.error || 'Could not read history' })); return; }
        if (!res.revisions.length) { body.append(el('div', { class: 'sb-empty', text: 'No history.' })); return; }
        body.append(...res.revisions.slice().reverse().map((rv) => el('div', {
          class: 'kube-row', style: 'grid-template-columns:60px 1fr 120px auto auto',
        },
          el('span', { text: `#${rv.revision}` }),
          el('span', { text: `${rv.chart || ''} — ${rv.description || rv.status || ''}` }),
          el('span', { text: rv.updated ? fmtDate(Date.parse(rv.updated)) : '' }),
          el('button', { class: 'ghost-btn sm', text: 'Diff from current…', onClick: () => showValuesDiff(rel, rv.revision) }),
          el('button', {
            class: 'ghost-btn sm', text: 'Rollback to this…',
            onClick: async () => {
              const ok = await confirm({ title: 'Rollback', message: `Roll "${rel.name}" back to revision ${rv.revision}?`, confirmLabel: 'Rollback', danger: true });
              if (!ok) return;
              const r = await window.api.kube.helmRollback({ spec: kubeSpec, target: { release: rel.name, namespace: rel.namespace, revision: rv.revision } });
              if (!r.ok) return toast(r.error || 'Rollback failed', 'error');
              toast(`${rel.name} rolled back to revision ${rv.revision}`);
              loadHelm();
            },
          }))));
      },
      buttons: [{ label: 'Close', value: true, class: 'primary-btn' }],
    });
  };

  /** The Helm releases list, scoped by the same namespace selector the discovered kinds already use. */
  const HELM_COLUMNS = [
    { key: 'name', label: 'Name', width: 180 },
    { key: 'namespace', label: 'Namespace', width: 130 },
    { key: 'chart', label: 'Chart', width: 170 },
    { key: 'appVersion', label: 'App version', width: 90 },
    { key: 'revision', label: 'Rev', width: 50 },
    { key: 'status', label: 'Status', width: 110, extra: 12 },
    { key: 'updated', label: 'Updated', width: 120, text: (r) => (r.updated ? fmtDate(Date.parse(r.updated)) : '') },
  ];

  const helmPanel = () => {
    const search = helmSearch();
    const installBtn = el('button', {
      class: 'ghost-btn sm', text: '+ Install release…', style: 'margin-left:8px',
      onClick: () => openHelmInstallWizard(),
    });
    // Only while there is nothing on screen yet — a refresh with releases
    // already shown stays quiet rather than fighting for attention next to
    // rows the eye was already on.
    const refreshing = helmLoading && helmReleases.length
      ? el('span', { class: 'hint', style: 'margin-left:10px', text: 'Refreshing…' })
      : null;
    const toolbar = el('div', { style: 'display:flex;align-items:center' }, search, installBtn, refreshing);
    const headOnly = () => renderTable({ id: 'helm', columns: HELM_COLUMNS, rows: [], renderRow: () => el('div') })[0];
    // A first load (nothing to show yet) is the one time this blanks the
    // panel — every later load, from a namespace switch or Refresh, keeps
    // whatever is already on screen up through the round trip instead of
    // clearing it first. See loadHelm()'s own comment for why.
    if (helmLoading && !helmReleases.length) return el('div', {}, toolbar, headOnly(), el('div', { class: 'sb-empty', text: 'Loading…' }));
    if (helmError && !helmReleases.length) return el('div', {}, toolbar, headOnly(), el('div', { class: 'sb-empty', text: helmError }));
    if (!helmReleases.length) return el('div', {}, toolbar, headOnly(), el('div', { class: 'sb-empty', text: 'No Helm releases found.' }));
    const q = helmRowFilter.trim().toLowerCase();
    const shown = q ? helmReleases.filter((rel) => rel.name.toLowerCase().includes(q) || (rel.namespace || '').toLowerCase().includes(q)) : helmReleases;
    if (!shown.length) return el('div', {}, toolbar, headOnly(), el('div', { class: 'sb-empty', text: `No release matches "${helmRowFilter}".` }));
    const table = renderTable({
      id: 'helm', columns: HELM_COLUMNS, rows: shown,
      renderRow: (rel) => {
        const row = el('div', { class: 'kube-row' },
          el('span', { text: rel.name }),
          el('span', { text: rel.namespace }),
          el('span', { text: rel.chart }),
          el('span', { text: rel.appVersion || '' }),
          el('span', { text: String(rel.revision) }),
          el('span', {},
            el('span', { style: `width:7px;height:7px;border-radius:50%;background:${phaseDot(rel.status)};display:inline-block;margin-right:5px` }),
            rel.status || ''),
          el('span', { text: rel.updated ? fmtDate(Date.parse(rel.updated)) : '' }),
          el('span', { class: 'kube-row-actions' },
            el('button', { class: 'ghost-btn sm', text: 'Diagram', title: 'What this release installs and how it connects — exportable as Mermaid', onClick: () => viewHelmDiagram(rel) }),
            el('button', { class: 'ghost-btn sm', text: 'Upgrade', title: 'helm upgrade — a newer chart version, or changed values', onClick: () => viewHelmUpgrade(rel) }),
            el('button', { class: 'ghost-btn sm', text: 'Values', onClick: () => viewHelmValues(rel) }),
            el('button', { class: 'ghost-btn sm', text: 'History', onClick: () => viewHelmHistory(rel) }),
            el('button', { class: 'ghost-btn sm', text: 'Test', title: 'helm test — runs the chart\'s own tests against this release', onClick: () => testHelmRelease(rel) }),
            el('button', { class: 'ghost-btn sm', text: 'Uninstall', onClick: () => uninstallHelm(rel) })));
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: rel.name, heading: true },
            { label: 'Diagram…', onClick: () => viewHelmDiagram(rel) },
            { label: 'Upgrade…', onClick: () => viewHelmUpgrade(rel) },
            { label: 'Values', onClick: () => viewHelmValues(rel) },
            { label: 'History…', onClick: () => viewHelmHistory(rel) },
            { label: 'Test', onClick: () => testHelmRelease(rel) },
            { label: 'Export values…', onClick: () => exportHelmValues(rel) },
            { label: 'Export manifest…', onClick: () => exportHelmManifest(rel) },
            { sep: true },
            { label: 'Uninstall…', onClick: () => uninstallHelm(rel) },
          ]);
        });
        return row;
      },
    });
    return el('div', {}, toolbar, ...table);
  };

  /**
   * "Install release…" — repo chart (helm repo add + <repo>/<chart>) or a
   * local chart path, picked via the file dialog this app already has.
   * Dry-run defaults checked, the same "really do it" convention
   * kubepanel.js's own openInstallTeleportWizard already uses for a Helm
   * install that touches real cluster state.
   */
  /** A schema field's raw input value (always a string, or a checkbox's boolean) back into the type the schema itself declared. */
  const coerceFieldValue = (f, raw) => {
    if (f.type === 'boolean') return !!raw;
    if (f.type === 'integer' || f.type === 'number') return raw === '' ? undefined : Number(raw);
    return raw;
  };
  const scalarInput = (f) => {
    if (f.enum) return select(f.enum.map((v) => ({ value: String(v), label: String(v) })), f.default !== undefined ? String(f.default) : String(f.enum[0]));
    if (f.type === 'boolean') return checkbox(f.title || f.path, f.default === true).input;
    return textInput({ value: f.default !== undefined ? String(f.default) : '', placeholder: f.title || f.path });
  };
  /**
   * The values-schema form shared by the Install and Upgrade wizards:
   * `helmValuesSchema` for the current chart ref, one input per scalar
   * field, and a button that turns the current form state into a fresh
   * values YAML block written into `valuesIn` — see `yamlform.js`'s own
   * reasoning for why this generates rather than live-binds.
   */
  const buildSchemaForm = (schemaForm, { chartRef, local, valuesIn, afterUse }) => {
    const fieldInputs = new Map();
    return (async () => {
      clear(schemaForm);
      schemaForm.classList.add('hidden');
      fieldInputs.clear();
      if (!chartRef) return;
      let r;
      try { r = await window.api.kube.helmValuesSchema({ spec: kubeSpec, target: { chartRef, local } }); }
      catch { return; }
      const scalarFields = (r.ok ? r.fields : []).filter((f) => f.type !== 'object' && f.type !== 'array');
      if (!scalarFields.length) return;
      schemaForm.classList.remove('hidden');
      schemaForm.append(
        el('div', { class: 'hint', text: `This chart has a values schema — ${scalarFields.length} field(s) below, or just edit the YAML above directly.` }),
        ...scalarFields.map((f) => {
          const input = scalarInput(f);
          fieldInputs.set(f.path, () => (input.type === 'checkbox' ? input.checked : input.value));
          return field(f.title || f.path, input, f.description || f.path);
        }),
        el('button', {
          class: 'ghost-btn sm', text: 'Use these values',
          onClick: () => {
            const values = scalarFields
              .map((f) => ({ path: f.path, value: coerceFieldValue(f, fieldInputs.get(f.path)()) }))
              .filter((v) => v.value !== '' && v.value !== undefined);
            valuesIn.value = buildValuesYaml(values);
            afterUse?.();
          },
        }));
    })();
  };
  const openHelmInstallWizard = async () => {
    const nameIn = textInput({ placeholder: 'my-release' });
    const nsIn = textInput({ value: selectedNs || '', placeholder: 'default' });
    const createNsIn = checkbox('Create the namespace if it does not exist', true);
    const sourceSel = select([{ value: 'repo', label: 'From a repo' }, { value: 'local', label: 'Local chart path' }], 'repo');
    const repoNameIn = textInput({ placeholder: 'bitnami' });
    const repoUrlIn = textInput({ placeholder: 'https://charts.bitnami.com/bitnami' });
    const chartNameIn = textInput({ placeholder: 'nginx' });
    const localPathIn = textInput({ placeholder: '/path/to/chart or chart.tgz' });
    const browseBtn = el('button', {
      class: 'ghost-btn sm', text: 'Browse…',
      onClick: async () => {
        const dirs = await window.api.dialog.openDirs();
        if (dirs?.[0]) localPathIn.value = dirs[0];
      },
    });
    const valuesIn = el('textarea', {
      style: 'width:100%;height:120px;font-family:var(--mono);font-size:12px', spellcheck: 'false',
      placeholder: '# optional values.yaml — leave blank for the chart defaults',
    });
    const dryRunIn = checkbox('Dry run (render the install, change nothing)', true);
    const out = el('pre', {
      style: 'font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-word;'
        + 'max-height:200px;overflow:auto;margin-top:10px;background:var(--panel-2);border:1px solid var(--border);'
        + 'border-radius:var(--radius);padding:8px 10px;color:var(--text-dim)',
    });
    const repoFields = el('div', {}, field('Repo name', repoNameIn), field('Repo URL', repoUrlIn), field('Chart name', chartNameIn));
    const localFields = el('div', { class: 'hidden' }, field('Chart path', el('div', { style: 'display:flex;gap:6px' }, localPathIn, browseBtn)));
    const fromRepo = () => sourceSel.value === 'repo';
    const currentChartRef = () => (fromRepo() ? `${repoNameIn.value.trim()}/${chartNameIn.value.trim()}` : localPathIn.value.trim());
    sourceSel.addEventListener('change', () => {
      repoFields.classList.toggle('hidden', sourceSel.value !== 'repo');
      localFields.classList.toggle('hidden', sourceSel.value !== 'local');
    });

    // README and rendered templates are both local-only reads (no
    // install, no cluster contact for the render) — useful the moment a
    // chart is named, not gated behind actually installing it.
    const readmeBtn = el('button', {
      class: 'ghost-btn sm', text: 'README', title: 'helm show readme',
      onClick: async () => {
        const chartRef = currentChartRef();
        if (!chartRef) return toast('Name a chart first', 'error');
        const r = await window.api.kube.helmReadme({ spec: kubeSpec, target: { chartRef } });
        await textModal(`${chartRef} — README`, r.ok ? r.text : (r.error || 'Could not read the README'), { lang: 'text' });
      },
    });
    const renderBtn = el('button', {
      class: 'ghost-btn sm', text: 'Render templates…', title: 'helm template — renders locally, touches nothing',
      onClick: async () => {
        const chartRef = currentChartRef();
        if (!chartRef) return toast('Name a chart first', 'error');
        const r = await window.api.kube.helmRenderTemplate({ spec: kubeSpec, target: { name: nameIn.value.trim() || 'release', chartRef, valuesYaml: valuesIn.value } });
        await textModal(`${chartRef} — rendered templates`, r.ok ? r.yaml : (r.error || 'Could not render this chart'));
      },
    });

    // The chart's own values.schema.json, as a form — most charts don't
    // have one (confirmed against several real public charts while
    // planning this), so the form section only ever appears when one is
    // actually found. Pre-filled from the schema's own defaults; "Use
    // these values" turns the current form state into a fresh values
    // YAML block in the textarea above, rather than trying to keep the
    // form and arbitrary hand-edited YAML in sync live.
    const schemaForm = el('div', { class: 'hidden' });
    const loadSchemaForm = () => buildSchemaForm(schemaForm, { chartRef: currentChartRef(), local: !fromRepo(), valuesIn, afterUse: paintCommand });

    // The exact commands, from the same code that runs them, kept current as
    // the form changes — read before Install, or copied to run by hand.
    const cmdBox = el('pre', {
      style: 'font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-all;user-select:text;'
        + 'max-height:180px;overflow:auto;margin:4px 0 0;background:var(--panel-2);border:1px solid var(--border);'
        + 'border-radius:var(--radius);padding:8px 10px;color:var(--text)',
    });
    const previewCommand = async () => {
      const r = await window.api.kube.helmInstall({
        spec: kubeSpec,
        target: {
          release: nameIn.value.trim() || '<release>', namespace: nsIn.value.trim() || '<namespace>',
          chartRef: fromRepo() ? `${repoNameIn.value.trim() || '<repo>'}/${chartNameIn.value.trim() || '<chart>'}` : (localPathIn.value.trim() || '<chart-path>'),
          valuesYaml: valuesIn.value, createNamespace: createNsIn.input.checked, dryRun: dryRunIn.input.checked,
          repo: fromRepo() ? { name: repoNameIn.value.trim() || '<repo>', url: repoUrlIn.value.trim() || '<repo-url>' } : null,
          preview: true,
        },
      });
      return r.ok ? r.command : (r.error || '');
    };
    const paintCommand = async () => { cmdBox.textContent = await previewCommand(); };
    for (const n of [nameIn, nsIn, repoNameIn, repoUrlIn, chartNameIn, localPathIn, valuesIn]) n.addEventListener('input', paintCommand);
    for (const n of [sourceSel, createNsIn.input, dryRunIn.input]) n.addEventListener('change', paintCommand);
    browseBtn.addEventListener('click', () => setTimeout(paintCommand, 300));
    paintCommand();
    for (const n of [repoNameIn, chartNameIn, localPathIn]) n.addEventListener('change', loadSchemaForm);
    sourceSel.addEventListener('change', loadSchemaForm);
    browseBtn.addEventListener('click', () => setTimeout(loadSchemaForm, 300));

    loadSchemaForm();
    let running = false;
    await modal({
      title: 'Install a Helm release', width: 'min(640px, 94vw)',
      render: (body) => {
        body.append(
          field('Release name', nameIn),
          field('Namespace', nsIn),
          createNsIn,
          field('Chart source', sourceSel),
          repoFields, localFields,
          el('div', { style: 'display:flex;gap:6px;margin-bottom:8px' }, readmeBtn, renderBtn),
          field('Values (optional)', valuesIn),
          schemaForm,
          dryRunIn,
          el('div', { style: 'font-size:12px;font-weight:600;margin-top:10px', text: 'What will run' }),
          cmdBox,
          out,
        );
      },
      buttons: [
        { label: 'Close', value: null },
        {
          label: 'Copy command',
          onClick: async () => {
            const cmd = await previewCommand();
            cmdBox.textContent = cmd;
            await window.api.clipboard.write(cmd);
            toast('Command copied');
          },
        },
        {
          label: 'Install', class: 'primary-btn',
          onClick: async () => {
            if (running) return;
            const release = nameIn.value.trim();
            const namespace = nsIn.value.trim();
            if (!release) return toast('Give it a release name', 'error');
            if (!namespace) return toast('Give it a namespace', 'error');
            let chartRef;
            if (sourceSel.value === 'repo') {
              const repoName = repoNameIn.value.trim();
              const repoUrl = repoUrlIn.value.trim();
              const chartName = chartNameIn.value.trim();
              if (!repoName || !repoUrl || !chartName) return toast('Fill in the repo name, URL and chart name', 'error');
              running = true;
              out.textContent = `Adding repo ${repoName}…`;
              const addRepo = await window.api.kube.helmAddRepo({ spec: kubeSpec, target: { name: repoName, url: repoUrl } });
              if (!addRepo.ok) { out.textContent = 'helm repo add failed: ' + addRepo.error; running = false; return; }
              chartRef = `${repoName}/${chartName}`;
            } else {
              chartRef = localPathIn.value.trim();
              if (!chartRef) return toast('Give it a chart path', 'error');
              running = true;
            }
            out.textContent = `Running helm install${dryRunIn.input.checked ? ' --dry-run' : ''}…`;
            try {
              const r = await window.api.kube.helmInstall({
                spec: kubeSpec,
                target: {
                  release, namespace, chartRef, valuesYaml: valuesIn.value,
                  createNamespace: createNsIn.input.checked, dryRun: dryRunIn.input.checked,
                },
              });
              out.textContent = r.ok ? (r.output || 'Done.') : 'helm install failed: ' + r.error;
              if (r.ok && !dryRunIn.input.checked) { toast(`Installed ${release}`); loadHelm(); }
            } finally { running = false; }
          },
        },
      ],
    });
  };

  const target = (r) => ({ name: r.name, resource: selected.name, namespace: selected.namespaced ? r.namespace : undefined });

  // Dynamic, not static: kubepanel.js already imports openKubeBrowser from
  // this module, and a static import back would close the cycle.
  const execRow = async (e, r, opts) => {
    const { openPodExec } = await import('./kubepanel.js');
    const containers = r.containers?.length ? r.containers : [null];
    if (containers.length === 1) { openPodExec(kubeSpec, r, containers[0], opts); return; }
    contextMenu(e.clientX, e.clientY, containers.map((name) => ({
      label: `Exec into ${name}`, onClick: () => openPodExec(kubeSpec, r, name, opts),
    })));
  };

  const logsRow = async (e, r, opts) => {
    const { openPodLogs } = await import('./kubepanel.js');
    const containers = r.containers?.length ? r.containers : [null];
    if (containers.length === 1) { openPodLogs(kubeSpec, r, containers[0], opts); return; }
    contextMenu(e.clientX, e.clientY, containers.map((name) => ({
      label: `Logs for ${name}`, onClick: () => openPodLogs(kubeSpec, r, name, opts),
    })));
  };

  /**
   * One apply flow, shared by "Apply YAML…", "New Namespace…" and "New
   * Pod…" below — none of this is new backend capability,
   * `kube:diffYaml`/`kube:applyYaml` already take arbitrary YAML with no
   * resource pre-selected (viewYaml()'s own onApply just happens to start
   * from an existing resource's text). The diff is opt-in (textModal's own
   * "Preview the diff" checkbox) rather than forced every time — a brand
   * new manifest diffs as all-additions when it is asked for, which is
   * still the honest "here's what this would create" view, just not a
   * mandatory extra click in front of every apply.
   */
  const applyYamlFlow = async (title, initialYaml = '') => {
    await textModal(title, initialYaml, {
      editable: true, spec: kubeSpec,
      onApply: async (yaml, { preview } = {}) => {
        if (preview) {
          const d = await window.api.kube.diffYaml({ spec: kubeSpec, yaml });
          if (!d.ok) { toast(d.error || 'Could not compute the diff', 'error'); return false; }
          if (d.diff === '(no changes)') { toast('Nothing to apply — this matches what is already there'); return false; }
          const sure = await confirm({
            title: 'Apply this YAML?', message: 'This is what applying it would change:',
            detail: d.diff, confirmLabel: 'Apply', danger: true,
          });
          if (!sure) return false;
        }
        const a = await window.api.kube.applyYaml({ spec: kubeSpec, yaml });
        if (!a.ok) { toast(a.error || 'kubectl apply failed', 'error'); return false; }
        toast('Applied');
        loadOverview();
        // An arbitrary manifest can be any kind — only refresh the list on
        // screen if one is actually showing (Overview/Helm/3D have nothing
        // of their own to re-fetch here).
        if (selected && selected !== 'helm' && selected !== '3d') refreshScoped();
        return true;
      },
    });
  };

  /**
   * `kubectl kustomize <dir>` (built into kubectl itself, nothing extra
   * installed) rendered and handed straight to `applyYamlFlow` — reviewed
   * in the same editor, diffed and applied the same way as everything
   * else, rather than a blind `apply -k`.
   */
  const openKustomizeBuildFlow = async () => {
    const dirs = await window.api.dialog.openDirs();
    const dir = dirs?.[0];
    if (!dir) return;
    const built = await window.api.kube.kustomizeBuild({ spec: kubeSpec, target: { dir } });
    if (!built.ok) return toast(built.error || 'Could not build this kustomization', 'error');
    await applyYamlFlow(`Kustomize build: ${dir}`, built.yaml);
  };

  /** A namespace's whole manifest is its name — a bare-name form rather than the YAML editor everything else goes through. */
  const openNewNamespaceDialog = async () => {
    const nameIn = textInput({ placeholder: 'my-namespace', autofocus: true });
    const ok = await modal({
      title: 'New namespace',
      render: (body) => body.append(field('Name', nameIn)),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Next…', value: true, class: 'primary-btn' }],
    });
    if (!ok) return;
    const name = nameIn.value.trim();
    if (!name) return toast('Give it a name', 'error');
    await applyYamlFlow(`New namespace: ${name}`, `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${name}\n`);
  };

  /**
   * A bare Pod, not a Deployment — a form that generated a Deployment
   * instead would give restart/reschedule guarantees a bare pod doesn't
   * have, but that's not what was asked for here: a disposable test
   * pod, the same shape every manual test this session has used. Namespace
   * gets the same datalist-of-suggestions treatment the "My access" box's
   * resource field already has, plus an optional "create it" step —
   * applied directly, not folded into the same diffed YAML as the pod:
   * `kubectl diff` on a Pod inside a Namespace that doesn't exist *yet*
   * (even one in the very same multi-document input) fails outright with
   * "namespaces ... not found" rather than reading as a clean addition —
   * found live, against a real cluster, the hard way. The namespace step
   * skips its own diff (creating an empty namespace has nothing worth
   * previewing); the pod still goes through the full diff-confirm-apply
   * flow once that namespace actually exists.
   */
  const openNewPodDialog = async () => {
    const nameIn = textInput({ placeholder: 'nginx', autofocus: true });
    const nsDatalistId = `kube-new-pod-ns-${Math.random().toString(36).slice(2)}`;
    const nsIn = textInput({ value: selectedNs || '', placeholder: 'default' });
    nsIn.setAttribute('list', nsDatalistId);
    const nsList = el('datalist', { id: nsDatalistId }, ...namespaces.map((n) => el('option', { value: n })));
    const createNsIn = checkbox('Create this namespace if it does not exist', true);
    const imageIn = textInput({ value: 'nginx:latest' });
    const portIn = textInput({ placeholder: 'e.g. 80 (optional)' });
    const ok = await modal({
      title: 'New pod',
      render: (body) => body.append(
        field('Name', nameIn),
        field('Namespace', el('div', { style: 'display:flex;gap:6px' }, nsIn, nsList)),
        createNsIn,
        field('Image', imageIn),
        field('Container port (optional)', portIn),
      ),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Next…', value: true, class: 'primary-btn' }],
    });
    if (!ok) return;
    const name = nameIn.value.trim();
    const namespace = nsIn.value.trim() || 'default';
    const image = imageIn.value.trim() || 'nginx:latest';
    const port = portIn.value.trim();
    if (!name) return toast('Give it a name', 'error');
    if (createNsIn.input.checked) {
      const nsApply = await window.api.kube.applyYaml({ spec: kubeSpec, yaml: `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${namespace}\n` });
      if (!nsApply.ok) return toast(nsApply.error || 'Could not create the namespace', 'error');
    }
    const portsBlock = port ? `\n      ports:\n        - containerPort: ${Number(port) || port}` : '';
    const podYaml = `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${name}\n  namespace: ${namespace}\nspec:\n  containers:\n    - name: ${name}\n      image: ${image}${portsBlock}\n`;
    await applyYamlFlow(`New pod: ${namespace}/${name}`, podYaml);
  };

  /**
   * "Create" forms for Deployment/Service/ConfigMap/Secret — a few fields
   * in, a complete manifest out via kubeops.js's manifestFor() (the same
   * generator a scripted `kubectl apply` of the form's output would be),
   * then the ordinary diff-before-apply flow, same as every other change
   * here. Not a second, hidden way of changing the cluster — a quicker way
   * to the same YAML.
   */
  const CREATE_FIELDS = {
    Deployment: [['name', 'Name', ''], ['namespace', 'Namespace', 'default'], ['image', 'Image', ''], ['replicas', 'Replicas', '1'], ['port', 'Container port (optional)', ''], ['env', 'Env (one NAME=value per line, optional)', '']],
    Service: [['name', 'Name', ''], ['namespace', 'Namespace', 'default'], ['type', 'Type (ClusterIP/NodePort/LoadBalancer)', 'ClusterIP'], ['selector', 'Selector (one k=v per line — defaults to app=<name>)', ''], ['port', 'Port', '80'], ['targetPort', 'Target port (optional, defaults to Port)', '']],
    ConfigMap: [['name', 'Name', ''], ['namespace', 'Namespace', 'default'], ['data', 'Data (one KEY=value per line)', '']],
    Secret: [['name', 'Name', ''], ['namespace', 'Namespace', 'default'], ['type', 'Type (optional)', 'Opaque'], ['data', 'Data (one KEY=value per line — not base64, the API server does that)', '']],
    Role: [['name', 'Name', ''], ['namespace', 'Namespace', 'default'], ['preset', 'Common need'], ['rules', 'Rules — one per line: VERBS | APIGROUPS | RESOURCES (blank APIGROUPS = core; "*" = any)', '']],
    ClusterRole: [['name', 'Name', ''], ['preset', 'Common need'], ['rules', 'Rules — one per line: VERBS | APIGROUPS | RESOURCES (blank APIGROUPS = core; "*" = any)', '']],
    RoleBinding: [['name', 'Name', ''], ['namespace', 'Namespace', 'default'], ['roleRefKind', 'Bind to (Role or ClusterRole)', 'Role'], ['roleRefName', 'Role/ClusterRole name', ''], ['subjects', 'Subjects — one per line: KIND:name (ServiceAccount also needs :namespace)', '']],
    ClusterRoleBinding: [['name', 'Name', ''], ['roleRefKind', 'Bind to (must be ClusterRole)', 'ClusterRole'], ['roleRefName', 'ClusterRole name', ''], ['subjects', 'Subjects — one per line: KIND:name (ServiceAccount also needs :namespace)', '']],
  };
  const RBAC_KINDS = new Set(['Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding']);
  // Starters, not the only way to write a rule — "Custom" leaves the
  // rules box exactly as typed, and any preset can still be edited
  // afterward before Next….
  const ROLE_PRESETS = {
    'Custom (write rules below)': '',
    'Read-only (get/list/watch) on everything': 'get,list,watch | * | *',
    'Read-only on pods and their logs': 'get,list,watch | | pods,pods/log',
    'Exec into pods': 'create,get | | pods/exec',
    'Manage Deployments and Pods': 'get,list,watch,create,update,patch,delete | apps, | deployments,replicasets,pods',
    'Manage ConfigMaps and Secrets': 'get,list,watch,create,update,patch,delete | | configmaps,secrets',
    'Full access (admin)': '* | * | *',
  };
  const openCreateResourceDialog = async (kind) => {
    const specFields = CREATE_FIELDS[kind];
    const inputs = {};
    let presetSelect = null;
    for (const [key, , def] of specFields) {
      if (key === 'preset') continue; // a <select> feeding the rules textarea below, not a field of its own
      inputs[key] = key === 'env' || key === 'data' || key === 'selector' || key === 'rules' || key === 'subjects'
        ? el('textarea', { style: 'width:100%;height:70px;font-family:var(--mono);font-size:12px', value: def, spellcheck: 'false' })
        : textInput({ value: def, autofocus: key === 'name' });
    }
    if (specFields.some(([key]) => key === 'preset')) {
      const names = Object.keys(ROLE_PRESETS);
      presetSelect = select(names.map((label) => ({ value: label, label })), names[0]);
      presetSelect.addEventListener('change', () => { inputs.rules.value = ROLE_PRESETS[presetSelect.value]; });
    }
    const isRbac = RBAC_KINDS.has(kind);
    const ok = await modal({
      title: `New ${kind}`,
      render: (body) => body.append(
        isRbac ? el('div', {
          class: 'hint', style: 'color:var(--amber);margin-bottom:8px',
          text: 'Review the generated rules carefully before relying on this anywhere production — a role broader than intended is a real security risk, and a typo in an apiGroup or resource name fails silently rather than with an error.',
        }) : null,
        ...specFields.map(([key, label]) => (key === 'preset' ? field(label, presetSelect) : field(label, inputs[key]))),
      ),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Next…', value: true, class: 'primary-btn' }],
    });
    if (!ok) return;
    const fields = Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value.trim()]));
    const hasNamespaceField = specFields.some(([key]) => key === 'namespace');
    if (hasNamespaceField) fields.namespace = fields.namespace || selectedNs || 'default';
    const built = await window.api.kube.manifestFor({ kind, fields });
    if (!built.ok) return toast(built.error || 'Could not build the manifest', 'error');
    const title = hasNamespaceField ? `New ${kind}: ${fields.namespace}/${fields.name}` : `New ${kind}: ${fields.name}`;
    await applyYamlFlow(title, built.yaml);
  };

  const viewYaml = async (r) => {
    const res = await window.api.kube.resourceYaml({ spec: kubeSpec, target: target(r) });
    if (!res.ok) { await textModal(`${selected.kind}/${r.name}`, res.error || 'Could not read YAML'); return; }
    await textModal(`${selected.kind}/${r.name}`, res.yaml, {
      editable: true, spec: kubeSpec,
      // The diff is only shown when textModal's own "Preview the diff"
      // checkbox was on — opt-in, not a forced extra step before Apply.
      onApply: async (yaml, { preview } = {}) => {
        if (preview) {
          const d = await window.api.kube.diffYaml({ spec: kubeSpec, yaml });
          if (!d.ok) { toast(d.error || 'Could not compute the diff', 'error'); return false; }
          if (d.diff === '(no changes)') { toast('Nothing to apply — the edit matches what is already there'); return false; }
          const sure = await confirm({
            title: `Apply changes to ${selected.kind}/${r.name}?`,
            message: 'This is what applying the edit below would change:',
            detail: d.diff, confirmLabel: 'Apply', danger: true,
          });
          if (!sure) return false;
        }
        const a = await window.api.kube.applyYaml({ spec: kubeSpec, yaml });
        if (!a.ok) { toast(a.error || 'kubectl apply failed', 'error'); return false; }
        toast(`Applied changes to ${r.name}`);
        selectType(selected);
        return true;
      },
    });
  };
  const viewDescribe = async (r) => {
    const res = await window.api.kube.describeResource({ spec: kubeSpec, target: target(r) });
    await textModal(`${selected.kind}/${r.name}`, res.ok ? res.text : (res.error || 'Could not describe it'), { lang: 'text' });
  };

  /**
   * A Secret's own data, decoded — "View YAML" shows the same keys as raw
   * base64, which is correct but not readable. Decoded here in the
   * renderer only, for display and editing; saving never base64-encodes
   * anything itself — a merge patch's `stringData` does that server-side,
   * the exact reasoning the create form's own Secret branch already uses.
   */
  const viewSecretDecoded = async (r) => {
    const res = await window.api.kube.getObject({ spec: kubeSpec, target: target(r) });
    if (!res.ok) return toast(res.error || 'Could not read the secret', 'error');
    const obj = res.object;
    const decode = (b64) => {
      try { return new TextDecoder().decode(Uint8Array.from(atob(b64 || ''), (c) => c.charCodeAt(0))); }
      catch { return '(binary data — not valid UTF-8, left as base64)\n' + (b64 || ''); }
    };
    const keys = Object.keys(obj.data || {});
    const inputs = new Map();
    const rows = keys.length ? keys.map((key) => {
      const area = el('textarea', { style: 'width:100%;height:60px;font-family:var(--mono);font-size:12px', spellcheck: 'false' });
      area.value = decode(obj.data[key]);
      area.dataset.original = area.value;
      inputs.set(key, area);
      return field(key, area);
    }) : [el('div', { class: 'sb-empty', text: 'No data keys.' })];
    const ok = await modal({
      title: `${r.name} — decoded`, width: 'min(720px, 94vw)', resize: 'kube-secret',
      render: (body) => body.append(
        el('div', { class: 'hint', style: 'margin-bottom:8px', text: 'Decoded here for editing only — Save re-encodes through the API server, never by hand.' }),
        ...rows),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, class: 'primary-btn' }],
    });
    if (!ok) return;
    const changed = {};
    for (const [key, area] of inputs) if (area.value !== area.dataset.original) changed[key] = area.value;
    if (!Object.keys(changed).length) return toast('Nothing changed');
    const p = await window.api.kube.patchSecretData({ spec: kubeSpec, target: { name: r.name, namespace: r.namespace, stringData: changed } });
    if (!p.ok) return toast(p.error || 'Could not save', 'error');
    toast(`Updated ${Object.keys(changed).length} key${Object.keys(changed).length === 1 ? '' : 's'}`);
    selectType(selected);
  };

  /** One row of a detail section — the same grid-of-spans shape the usage panel's own line() already uses. */
  const detailRow = (cells, headRow) => el('div', {
    class: 'kube-row' + (headRow ? ' kube-head' : ''), style: `grid-template-columns:repeat(${cells.length},minmax(0,1fr))`,
  }, ...cells.map((t) => el('span', { text: t })));

  const describeEnvFrom = (vf) => {
    if (vf.fieldRef) return `(from ${vf.fieldRef.fieldPath})`;
    if (vf.resourceFieldRef) return `(from ${vf.resourceFieldRef.resource})`;
    if (vf.configMapKeyRef) return `(from ConfigMap ${vf.configMapKeyRef.name}/${vf.configMapKeyRef.key})`;
    if (vf.secretKeyRef) return `(from Secret ${vf.secretKeyRef.name}/${vf.secretKeyRef.key})`;
    return '(from a reference)';
  };
  const describeEnvFromSource = (e) => {
    if (e.configMapRef) return `ConfigMap ${e.configMapRef.name}`;
    if (e.secretRef) return `Secret ${e.secretRef.name}`;
    return '';
  };

  /**
   * Conditions, owners (each one clickable, straight to its own Details),
   * container status, env and volume mounts (Pod only), and the
   * resource's own events — everything View YAML already shows as one
   * undifferentiated document, pulled apart into what each part means.
   */
  const detailSections = (obj, related, events, extras = {}) => {
    const sections = [];
    const heading = (text) => sections.push(el('div', { style: 'font-weight:600;margin:12px 0 4px', text }));
    const empty = (text) => sections.push(el('div', { class: 'sb-empty', text }));

    if (related.length) {
      heading('Owners & related');
      for (const x of related) {
        sections.push(el('div', { class: 'kube-row', style: 'grid-template-columns:120px minmax(0,1fr)' },
          el('span', { style: 'color:var(--muted)', text: x.kind }),
          el('span', {
            style: 'cursor:pointer;color:var(--accent)',
            text: (x.namespace ? x.namespace + '/' : '') + x.name,
            onClick: () => openDetailFor(x),
          })));
      }
    }

    heading('Conditions');
    const conditions = obj.status?.conditions || [];
    if (!conditions.length) empty('No conditions reported.');
    else {
      sections.push(detailRow(['Type', 'Status', 'Reason', 'Message'], true));
      for (const c of conditions) {
        // A pressure condition reads backwards from Ready: True is the bad
        // state, and it's exactly the one every other condition's own row
        // would otherwise bury in a list that looks identical either way.
        const bad = obj.kind === 'Node' && PRESSURE_CONDITION_TYPES.has(c.type) && c.status === 'True';
        const row = detailRow([(bad ? '⚠ ' : '') + (c.type || ''), c.status || '', c.reason || '', c.message || '']);
        if (bad) row.style.color = 'var(--red)';
        sections.push(row);
      }
    }

    if (obj.kind === 'Node') {
      heading('Capacity / allocatable');
      const cap = obj.status?.capacity || {};
      const alloc = obj.status?.allocatable || {};
      const keys = ['cpu', 'memory', 'pods', 'ephemeral-storage'].filter((k) => cap[k] !== undefined || alloc[k] !== undefined);
      if (!keys.length) empty('No capacity reported.');
      else {
        sections.push(detailRow(['Resource', 'Capacity', 'Allocatable'], true));
        for (const k of keys) sections.push(detailRow([k, cap[k] ?? '—', alloc[k] ?? '—']));
      }
    }

    if (obj.kind === 'Namespace') {
      heading('Resource quotas');
      const quotas = extras.quotaObjs || [];
      if (!quotas.length) empty('No ResourceQuota in this namespace.');
      for (const q of quotas) {
        sections.push(el('div', { style: 'font-weight:500;margin:6px 0 2px', text: q.metadata?.name || '' }));
        const hard = q.status?.hard || {};
        const used = q.status?.used || {};
        const keys = Object.keys(hard);
        if (!keys.length) empty('No limits set.');
        else {
          sections.push(detailRow(['Resource', 'Used', 'Hard limit'], true));
          for (const k of keys) sections.push(detailRow([k, used[k] ?? '0', hard[k]]));
        }
      }
      heading('Limit ranges');
      const limitRanges = extras.limitObjs || [];
      if (!limitRanges.length) empty('No LimitRange in this namespace.');
      const fmtLimitSet = (o) => Object.entries(o || {}).map(([k, v]) => `${k}=${v}`).join(', ') || '—';
      for (const lrange of limitRanges) {
        sections.push(el('div', { style: 'font-weight:500;margin:6px 0 2px', text: lrange.metadata?.name || '' }));
        sections.push(detailRow(['Type', 'Default', 'Default request', 'Min', 'Max'], true));
        for (const l of lrange.spec?.limits || []) {
          sections.push(detailRow([l.type || '', fmtLimitSet(l.default), fmtLimitSet(l.defaultRequest), fmtLimitSet(l.min), fmtLimitSet(l.max)]));
        }
      }
    }

    if (obj.kind === 'Role' || obj.kind === 'ClusterRole') {
      heading('Rules');
      const rules = obj.rules || [];
      if (!rules.length) empty('No rules — this grants nothing.');
      else {
        sections.push(detailRow(['API groups', 'Resources', 'Resource names', 'Verbs'], true));
        for (const rule of rules) {
          sections.push(detailRow([
            (rule.apiGroups || []).map((g) => g || '(core)').join(', ') || '—',
            (rule.resources || []).join(', ') || '—',
            (rule.resourceNames || []).join(', ') || '(any)',
            (rule.verbs || []).join(', ') || '—',
          ]));
        }
      }
    }

    if (obj.kind === 'RoleBinding' || obj.kind === 'ClusterRoleBinding') {
      heading('Role ref');
      const ref = obj.roleRef || {};
      sections.push(el('div', { class: 'kube-row', style: 'grid-template-columns:120px minmax(0,1fr)' },
        el('span', { style: 'color:var(--muted)', text: ref.kind || '' }),
        el('span', {
          style: 'cursor:pointer;color:var(--accent)', text: ref.name || '',
          onClick: () => openDetailFor({ kind: ref.kind, name: ref.name, namespace: obj.metadata?.namespace || null }),
        })));
      heading('Subjects');
      const subjects = obj.subjects || [];
      if (!subjects.length) empty('No subjects — this binds nothing.');
      else {
        const subjectCols = 'grid-template-columns:repeat(3,minmax(0,1fr)) auto';
        sections.push(el('div', { class: 'kube-row kube-head', style: subjectCols },
          el('span', { text: 'Kind' }), el('span', { text: 'Name' }), el('span', { text: 'Namespace' }), el('span', {})));
        for (const s of subjects) {
          sections.push(el('div', { class: 'kube-row', style: subjectCols },
            el('span', { text: s.kind || '' }), el('span', { text: s.name || '' }),
            el('span', { text: s.namespace || (s.kind === 'ServiceAccount' ? '' : '—') }),
            s.kind === 'ServiceAccount'
              ? el('button', {
                class: 'ghost-btn sm', text: 'Test',
                title: 'Run a short-lived pod as this ServiceAccount and check its real permissions',
                onClick: () => testRoleBindingSubject(obj, s),
              })
              : el('span', {})));
        }
      }
    }

    if (obj.kind === 'Pod') {
      heading('Containers');
      const statuses = obj.status?.containerStatuses || [];
      if (!statuses.length) empty('No container status reported yet.');
      else {
        sections.push(detailRow(['Name', 'Ready', 'Restarts', 'State', 'Image'], true));
        for (const cs of statuses) {
          const state = cs.state?.running ? 'running' : cs.state?.waiting ? `waiting (${cs.state.waiting.reason || '—'})`
            : cs.state?.terminated ? `terminated (${cs.state.terminated.reason || '—'})` : '—';
          sections.push(detailRow([cs.name || '', cs.ready ? 'yes' : 'no', String(cs.restartCount ?? ''), state, cs.image || '']));
        }
      }
      heading('Resources (requests / limits / actual)');
      const usageByContainer = new Map((extras.podUsage || []).map((u) => [u.container, u]));
      const containers = obj.spec?.containers || [];
      if (!containers.length) empty('No containers.');
      else {
        sections.push(detailRow(['Container', 'CPU req/limit', 'CPU actual', 'Mem req/limit', 'Mem actual'], true));
        for (const c of containers) {
          const res = c.resources || {};
          const u = usageByContainer.get(c.name);
          sections.push(detailRow([
            c.name, `${res.requests?.cpu || '—'} / ${res.limits?.cpu || '—'}`, u?.cpu || '—',
            `${res.requests?.memory || '—'} / ${res.limits?.memory || '—'}`, u?.memory || '—',
          ]));
        }
        if (!extras.podUsage?.length) sections.push(el('div', { class: 'hint', text: 'Actual usage needs metrics-server.' }));
      }
      heading('Environment');
      const envVars = (obj.spec?.containers || []).flatMap((c) => [
        ...(c.env || []).map((e) => [c.name, e.name, e.value ?? (e.valueFrom ? describeEnvFrom(e.valueFrom) : '')]),
        ...(c.envFrom || []).map((e) => [c.name, '(all keys)', describeEnvFromSource(e)]),
      ]);
      if (!envVars.length) empty('No environment variables set directly (a container\'s own image may still set its own).');
      else {
        sections.push(detailRow(['Container', 'Name', 'Value'], true));
        for (const [containerName, name, value] of envVars) sections.push(detailRow([containerName, name, value]));
      }
      heading('Volume mounts');
      const mounts = (obj.spec?.containers || []).flatMap((c) => (c.volumeMounts || []).map((m) => [c.name, m]));
      if (!mounts.length) empty('No volume mounts.');
      else {
        sections.push(detailRow(['Container', 'Volume', 'Mount path', 'Read only'], true));
        for (const [containerName, m] of mounts) sections.push(detailRow([containerName, m.name || '', m.mountPath || '', m.readOnly ? 'yes' : 'no']));
      }
    }

    heading('Events');
    if (!events.length) empty('No recent events for this resource.');
    else {
      sections.push(detailRow(['Type', 'Detail', 'Age'], true));
      for (const e of events.slice(0, 20)) sections.push(detailRow([e.status || '', e.detail || '', e.age ? fmtDate(Date.parse(e.age)) : '']));
    }

    return el('div', { style: 'max-height:65vh;overflow:auto' }, ...sections);
  };

  /**
   * "Does this actually work?" for one ServiceAccount subject of a
   * RoleBinding/ClusterRoleBinding — runs a real, short-lived pod as it
   * and asks it to check its own permissions, rather than only reasoning
   * about the rule text. See kubetest.js for why this needs no `--as` and
   * no bot: the pod's own mounted token already is that identity.
   */
  const testRoleBindingSubject = async (obj, s) => {
    const ref = obj.roleRef || {};
    const ty = types.find((t) => t.kind === ref.kind);
    if (!ty) return toast(`${ref.kind} is not a kind this cluster lists`, 'error');
    const roleRes = await window.api.kube.getObject({
      spec: kubeSpec, target: { name: ref.name, resource: ty.name, namespace: ty.namespaced ? obj.metadata?.namespace : undefined },
    });
    if (!roleRes.ok) return toast(roleRes.error || `Could not read ${ref.kind}/${ref.name}`, 'error');
    const rules = roleRes.object?.rules || [];
    if (!rules.length) return toast('This Role has no rules to test.', 'error');
    const ok = await confirm({
      title: 'Test this role',
      message: `Run a short-lived pod in "${s.namespace}" as ServiceAccount "${s.name}"?`,
      detail: 'Asks it to check its own real permissions for a sample of this role\'s rules, then deletes the pod.',
      confirmLabel: 'Run test',
    });
    if (!ok) return;
    let r;
    try { r = await window.api.kube.testServiceAccountAccess({ spec: kubeSpec, target: { namespace: s.namespace, serviceAccountName: s.name, rules } }); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) return toast(r.error || 'Could not run the test', 'error');
    const checks = r.checks || [];
    const cols = 'grid-template-columns:1fr 1fr auto';
    await modal({
      title: `Test — ${s.name}`, subtitle: s.namespace, width: 'min(560px, 94vw)',
      render: (body) => body.append(!checks.length
        ? el('div', { class: 'sb-empty', text: 'No results.' })
        : el('div', {},
          el('div', { class: 'kube-row kube-head', style: cols }, el('span', { text: 'Verb' }), el('span', { text: 'Resource' }), el('span', { text: 'Allowed' })),
          ...checks.map((c) => el('div', { class: 'kube-row', style: cols },
            el('span', { text: c.verb }), el('span', { text: c.resource }),
            el('span', {
              style: `color:${c.allowed ? 'var(--green)' : c.allowed === false ? 'var(--red)' : 'var(--amber)'}`,
              text: c.allowed ? 'yes' : c.allowed === false ? 'no' : (c.error || 'unknown'),
            }))))),
      buttons: [{ label: 'Close', value: true, class: 'primary-btn' }],
    });
  };

  /** The resource's own recent events — the same lookup `kubectl describe` makes internally, scoped with --field-selector rather than reading everything and filtering client-side. */
  const eventsFor = async (name, namespace) => {
    if (!namespace) return [];
    try {
      const r = await window.api.kube.resources({
        spec: kubeSpec, type: { name: 'events', namespaced: true, namespace, fieldSelector: `involvedObject.name=${name}` },
      });
      return r.ok ? r.items : [];
    } catch { return []; } // a bonus section, not required for the rest of the panel to show
  };

  const showDetailModal = async (kind, r, obj, related) => {
    const events = await eventsFor(r.name, r.namespace);
    const extras = {};
    // Actual usage per container — a bonus beside the requests/limits
    // already in `obj`, not required for the rest of the panel to show.
    if (kind === 'Pod' && r.namespace) {
      try {
        const pr = await window.api.kube.topPodContainers({ spec: kubeSpec, target: { name: r.name, namespace: r.namespace } });
        extras.podUsage = pr.ok ? pr.items : [];
      } catch { /* same: metrics-server missing or slow */ }
    }
    // A namespace's own quotas/limits — fetched as full objects (status.hard/used,
    // spec.limits), not the trimmed list rows kube:resources hands back by default.
    if (kind === 'Namespace') {
      try {
        const fetchFull = async (resource) => {
          const list = await window.api.kube.resources({ spec: kubeSpec, type: { name: resource, namespaced: true, namespace: r.name } });
          const objs = await Promise.all((list.ok ? list.items : []).map((it) =>
            window.api.kube.getObject({ spec: kubeSpec, target: { name: it.name, resource, namespace: r.name } })));
          return objs.filter((x) => x.ok).map((x) => x.object);
        };
        [extras.quotaObjs, extras.limitObjs] = await Promise.all([fetchFull('resourcequotas'), fetchFull('limitranges')]);
      } catch { /* same: a bonus section, not required for the rest of the panel */ }
    }
    await modal({
      title: `${kind}/${r.name}`, width: 'min(820px, 94vw)', resize: 'kube-detail',
      render: (body) => body.append(detailSections(obj, related, events, extras)),
      buttons: [{ label: 'Close', value: true, class: 'primary-btn' }],
    });
  };

  /** Details on the currently selected kind's own row. */
  const viewDetails = async (r) => {
    const res = await window.api.kube.getObject({ spec: kubeSpec, target: target(r) });
    if (!res.ok) return toast(res.error || 'Could not read that resource', 'error');
    await showDetailModal(selected.kind, r, res.object, res.related || []);
  };

  /** Jumping to a related resource by kind — resolves which discovered type that kind is, then opens its own details the same way. */
  const openDetailFor = async ({ kind, name, namespace }) => {
    const ty = types.find((t) => t.kind === kind);
    if (!ty) return toast(`${kind} is not a kind this cluster lists`, 'error');
    const res = await window.api.kube.getObject({ spec: kubeSpec, target: { name, resource: ty.name, namespace: ty.namespaced ? namespace : undefined } });
    if (!res.ok) return toast(res.error || `Could not read ${kind}/${name}`, 'error');
    await showDetailModal(kind, { name, namespace }, res.object, res.related || []);
  };
  const exportYaml = async (r) => {
    const res = await window.api.kube.resourceYaml({ spec: kubeSpec, target: target(r) });
    if (!res.ok) return toast(res.error || 'Could not read YAML', 'error');
    const saved = await window.api.dialog.saveText({ text: res.yaml, defaultPath: `${selected.kind}-${r.name}.yaml`, title: `Export ${selected.kind}/${r.name}` });
    if (saved) toast(`Saved ${saved.path}`);
  };
  const portForward = async (r) => {
    const { startPortForward } = await import('./kubepanel.js');
    startPortForward(kubeSpec, { resource: selected.kind.toLowerCase(), name: r.name, namespace: selected.namespaced ? r.namespace : undefined });
  };
  const portForwardMenuItemFor = async (r) => {
    const { portForwardMenuItem } = await import('./kubepanel.js');
    return portForwardMenuItem(kubeSpec, { resource: selected.kind.toLowerCase(), name: r.name, namespace: selected.namespaced ? r.namespace : undefined });
  };
  // Re-fetching the same kind after an action keeps whatever "Pods" scope
  // was in effect — losing it on every delete/cordon would make deleting
  // one pod of a deployment, to see it replaced, show every other
  // deployment's pods too the moment it refreshed.
  // After an action: the same background re-read as the live rows, so a
  // delete or a scale does not wipe the filter or flash the list empty.
  const refreshScoped = () => reconcileRows(selected, podScope ? podScope.selector : null);

  /** `force: true` is the stuck-pod case — removed from the API without waiting for the kubelet, via kubeops.deleteMany (deleteResource has no such option). */
  const deleteRow = async (r, { force = false } = {}) => {
    const can = await window.api.kube.canI({ spec: kubeSpec, target: { verb: 'delete', resource: selected.name, namespace: selected.namespaced ? r.namespace : undefined } }).catch(() => ({ allowed: true }));
    if (can && can.allowed === false) return toast(`Your role can't delete ${selected.kind.toLowerCase()}s here`, 'error');
    const ok = await confirm({
      title: force ? `Force delete ${selected.kind}` : `Delete ${selected.kind}`,
      message: `${force ? 'Force delete' : 'Delete'} "${r.name}"?`,
      detail: force ? 'Removes it from the API immediately, without waiting for the kubelet to confirm it is gone — only for one stuck terminating.' : undefined,
      confirmLabel: force ? 'Force delete' : 'Delete', danger: true,
    });
    if (!ok) return;
    const res = force
      ? await window.api.kube.deleteMany({ spec: kubeSpec, target: { resource: selected.name, namespace: selected.namespaced ? r.namespace : undefined, names: [r.name], force: true } })
      : await window.api.kube.deleteResource({ spec: kubeSpec, target: target(r) });
    if (!res.ok) return toast(res.error || 'Delete failed', 'error');
    toast(`Deleted ${r.name}`);
    refreshScoped();
  };

  const evictRow = async (r) => {
    const ok = await confirm({
      title: 'Evict pod', message: `Evict "${r.name}"?`,
      detail: 'Goes through the Eviction API, so a PodDisruptionBudget on it is respected — unlike an ordinary delete.',
      confirmLabel: 'Evict', danger: true,
    });
    if (!ok) return;
    const res = await window.api.kube.evict({ spec: kubeSpec, target: { name: r.name, namespace: r.namespace } });
    if (!res.ok) return toast(res.error || 'Evict failed', 'error');
    toast(`Evicted ${r.name}`);
    refreshScoped();
  };

  /** A bulk-select checkbox's key — namespace-qualified, since two kinds' lists can show the same name in different namespaces. */
  const rowKey = (r) => `${r.namespace || ''}\u0001${r.name}`;

  const bulkDeleteSelected = async (shownRows) => {
    const sel = shownRows.filter((r) => selectedKeys.has(rowKey(r)));
    if (!sel.length) return;
    const ok = await confirm({
      title: `Delete ${sel.length} ${selected.kind}${sel.length === 1 ? '' : 's'}`,
      message: `Delete ${sel.length} selected ${selected.kind.toLowerCase()}${sel.length === 1 ? '' : 's'}?`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    // kubectl delete takes one namespace at a time — grouped so a selection
    // spanning several namespaces still goes out as one call per namespace,
    // not one per row.
    const byNs = new Map();
    for (const r of sel) {
      const k = selected.namespaced ? (r.namespace || '') : '';
      if (!byNs.has(k)) byNs.set(k, []);
      byNs.get(k).push(r.name);
    }
    let okCount = 0;
    let lastError = '';
    for (const [ns, names] of byNs) {
      const res = await window.api.kube.deleteMany({ spec: kubeSpec, target: { resource: selected.name, namespace: ns || undefined, names } });
      if (res.ok) okCount += names.length; else lastError = res.error || 'Delete failed';
    }
    selectedKeys.clear();
    if (okCount) toast(`Deleted ${okCount} ${selected.kind.toLowerCase()}${okCount === 1 ? '' : 's'}`);
    if (lastError) toast(lastError, 'error');
    refreshScoped();
  };

  /** Replicas for a Deployment/StatefulSet/ReplicaSet — prefilled with what it is now. */
  const scaleRow = async (r) => {
    const current = await window.api.kube.containersOf({ spec: kubeSpec, target: { resource: selected.name, name: r.name, namespace: r.namespace } }).catch(() => null);
    const replicasIn = textInput({ value: String(current?.ok ? (current.replicas ?? 0) : ''), placeholder: 'e.g. 3' });
    const ok = await modal({
      title: `Scale ${r.name}`,
      render: (body) => body.append(field('Replicas', replicasIn)),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Scale', value: true, class: 'primary-btn' }],
    });
    if (!ok) return;
    const res = await window.api.kube.scale({ spec: kubeSpec, target: { resource: selected.name, name: r.name, namespace: r.namespace, replicas: replicasIn.value.trim() } });
    if (!res.ok) return toast(res.error || 'Scale failed', 'error');
    toast(`Scaled ${r.name} to ${replicasIn.value.trim()}`);
    refreshScoped();
  };

  /** restart/status/pause/resume — history+undo is its own picker, rolloutUndoRow below. */
  const rolloutAction = async (r, action) => {
    const res = await window.api.kube.rollout({ spec: kubeSpec, target: { action, resource: selected.name, name: r.name, namespace: r.namespace } });
    if (!res.ok) return toast(res.error || `Rollout ${action} failed`, 'error');
    toast(action === 'status' ? (res.output || `${r.name}: rollout status`) : `${r.name}: rollout ${action}`);
    if (action !== 'status') refreshScoped();
  };

  const rolloutSubmenu = (r) => [
    { label: 'Restart', onClick: () => rolloutAction(r, 'restart') },
    { label: 'Status', onClick: () => rolloutAction(r, 'status') },
    { label: 'History / Undo…', onClick: () => rolloutUndoRow(r) },
    ROLLOUT_PAUSABLE_KINDS.includes(selected.kind) ? { label: 'Pause', onClick: () => rolloutAction(r, 'pause') } : null,
    ROLLOUT_PAUSABLE_KINDS.includes(selected.kind) ? { label: 'Resume', onClick: () => rolloutAction(r, 'resume') } : null,
  ].filter(Boolean);

  /** History/Undo as one picker — simpler and more reliable than the sl-pick custom-event dance a generic modal() can't really support. */
  const rolloutUndoRow = async (r) => {
    const res = await window.api.kube.rolloutHistory({ spec: kubeSpec, target: { resource: selected.name, name: r.name, namespace: r.namespace } });
    if (!res.ok) return toast(res.error || 'Could not read rollout history', 'error');
    if (!res.revisions?.length) return toast(`${r.name} has no rollout history`);
    const options = res.revisions.slice().reverse().map((rev) => ({ value: String(rev.revision), label: `#${rev.revision}${rev.cause ? ' — ' + rev.cause : ''}` }));
    const revisionSel = select(options, options[1]?.value || options[0]?.value);
    const ok = await modal({
      title: `Rollout history: ${r.name}`,
      render: (body) => body.append(field('Undo to revision', revisionSel), el('div', { class: 'hint', text: 'Picks the revision to go back to — the newest is what is running now.' })),
      buttons: [{ label: 'Close', value: false }, { label: 'Undo', value: true, class: 'primary-btn' }],
    });
    if (!ok) return;
    const res2 = await window.api.kube.rollout({ spec: kubeSpec, target: { action: 'undo', resource: selected.name, name: r.name, namespace: r.namespace, revision: revisionSel.value } });
    if (!res2.ok) return toast(res2.error || 'Rollout undo failed', 'error');
    toast(`${r.name}: rolled back to revision ${revisionSel.value}`);
    refreshScoped();
  };

  const cronTriggerRow = async (r) => {
    const ok = await confirm({ title: 'Trigger CronJob now', message: `Run "${r.name}" now, outside its schedule?`, confirmLabel: 'Trigger' });
    if (!ok) return;
    const res = await window.api.kube.cronTrigger({ spec: kubeSpec, target: { name: r.name, namespace: r.namespace } });
    if (!res.ok) return toast(res.error || 'Could not trigger it', 'error');
    toast(`Triggered ${r.name}`);
    refreshScoped();
  };

  const cronSuspendRow = async (r) => {
    const suspend = !r.suspended;
    const res = await window.api.kube.cronSuspend({ spec: kubeSpec, target: { name: r.name, namespace: r.namespace, suspend } });
    if (!res.ok) return toast(res.error || 'Could not change its schedule', 'error');
    toast(suspend ? `Suspended ${r.name}` : `Resumed ${r.name}`);
    refreshScoped();
  };

  /**
   * One container's image, env vars and requests/limits, in one form —
   * `containersOf()` (kubeops.js) reads the current values; only the
   * actions whose fields actually changed are sent, so leaving env alone
   * does not also touch resources or vice versa.
   */
  const editContainersRow = async (r) => {
    const cur = await window.api.kube.containersOf({ spec: kubeSpec, target: { resource: selected.name, name: r.name, namespace: r.namespace } });
    if (!cur.ok) return toast(cur.error || 'Could not read its containers', 'error');
    if (!cur.containers?.length) return toast(`${r.name} has no containers`, 'error');
    const containerSel = select(cur.containers.map((c) => ({ value: c.name, label: c.name })), cur.containers[0].name);
    let active = cur.containers[0];
    const imageIn = textInput({ value: active.image || '' });
    const envIn = el('textarea', { style: 'width:100%;height:90px;font-family:var(--mono);font-size:12px', spellcheck: 'false' });
    const requestsIn = textInput({ placeholder: 'cpu=100m,memory=128Mi' });
    const limitsIn = textInput({ placeholder: 'cpu=500m,memory=512Mi' });
    const fillFrom = (c) => {
      imageIn.value = c.image || '';
      envIn.value = (c.env || []).map((e) => `${e.name}=${e.value}`).join('\n');
      requestsIn.value = Object.entries(c.requests || {}).map(([k, v]) => `${k}=${v}`).join(',');
      limitsIn.value = Object.entries(c.limits || {}).map(([k, v]) => `${k}=${v}`).join(',');
    };
    fillFrom(active);
    containerSel.addEventListener('change', () => {
      active = cur.containers.find((c) => c.name === containerSel.value) || active;
      fillFrom(active);
    });
    const ok = await modal({
      title: `Edit containers: ${r.name}`,
      render: (body) => body.append(
        field('Container', containerSel),
        field('Image', imageIn),
        field('Env (one NAME=value per line)', envIn),
        field('Requests', requestsIn),
        field('Limits', limitsIn),
      ),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, class: 'primary-btn' }],
    });
    if (!ok) return;
    const container = containerSel.value;
    const image = imageIn.value.trim();
    const kv = (text) => Object.fromEntries(String(text || '').split(/[\n,]/).map((l) => l.trim()).filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
    const newEnv = kv(envIn.value);
    const oldEnv = Object.fromEntries((active.env || []).map((e) => [e.name, e.value]));
    const unset = Object.keys(oldEnv).filter((k) => !(k in newEnv));
    const requests = requestsIn.value.trim();
    const limits = limitsIn.value.trim();
    const base = { resource: selected.name, name: r.name, namespace: r.namespace, container };
    const actions = [];
    if (image && image !== active.image) actions.push(window.api.kube.setImage({ spec: kubeSpec, target: { ...base, image } }));
    if (Object.keys(newEnv).length || unset.length) actions.push(window.api.kube.setEnv({ spec: kubeSpec, target: { ...base, set: newEnv, unset } }));
    if (requests || limits) actions.push(window.api.kube.setResources({ spec: kubeSpec, target: { ...base, requests, limits } }));
    if (!actions.length) return toast('Nothing changed');
    const results = await Promise.all(actions);
    const failed = results.find((res) => !res.ok);
    if (failed) return toast(failed.error || 'Some changes failed to apply', 'error');
    toast(`Updated ${r.name}`);
    refreshScoped();
  };

  /** The workload-action items — shared by the row's "⋯" button and the right-click menu, so neither drifts from the other. */
  const extraRowMenu = (r) => [
    SCALE_KINDS.includes(selected.kind) ? { label: 'Scale…', onClick: () => scaleRow(r) } : null,
    ROLLOUT_KINDS.includes(selected.kind) ? { label: 'Rollout', submenu: rolloutSubmenu(r) } : null,
    CONTAINER_EDIT_KINDS.includes(selected.kind) ? { label: 'Edit containers…', onClick: () => editContainersRow(r) } : null,
    selected.kind === 'CronJob' ? { label: 'Trigger now', onClick: () => cronTriggerRow(r) } : null,
    selected.kind === 'CronJob' ? { label: r.suspended ? 'Resume' : 'Suspend', onClick: () => cronSuspendRow(r) } : null,
    selected.kind === 'Pod' ? {
      label: 'Debug container…',
      onClick: async () => (await import('./kubepanel.js')).openPodDebug(kubeSpec, r, r.containers?.[0] || null, { dir: 'col' }),
    } : null,
    selected.kind === 'Pod' ? { label: 'Evict…', onClick: () => evictRow(r) } : null,
    selected.kind === 'Pod' ? { label: 'Force delete…', onClick: () => deleteRow(r, { force: true }) } : null,
    selected.kind === 'Secret' ? { label: 'View decoded…', onClick: () => viewSecretDecoded(r) } : null,
  ].filter(Boolean);

  const cordonRow = async (r) => {
    const res = await window.api.kube.cordonNode({ spec: kubeSpec, target: { name: r.name } });
    if (!res.ok) return toast(res.error || 'Cordon failed', 'error');
    toast(`${r.name} is now unschedulable`);
    refreshScoped();
  };

  const drainRow = async (r) => {
    const ok = await confirm({
      title: 'Drain node', message: `Cordon "${r.name}" and evict every pod on it?`,
      detail: 'DaemonSet pods are skipped (they belong on every node) and emptyDir volumes are discarded — kubectl drain’s own defaults.',
      confirmLabel: 'Drain', danger: true,
    });
    if (!ok) return;
    toast(`Draining ${r.name}…`);
    const res = await window.api.kube.drainNode({ spec: kubeSpec, target: { name: r.name } });
    if (!res.ok) return toast(res.error || 'Drain failed', 'error');
    toast(`${r.name} drained`);
    refreshScoped();
  };

  const nodeShellRow = async (r) => {
    const { openNodeShell } = await import('./kubepanel.js');
    openNodeShell(kubeSpec, r.name, { dir: 'col' });
  };

  const selectorLogsRow = async (r) => {
    const { openSelectorLogs } = await import('./kubepanel.js');
    openSelectorLogs(kubeSpec, { namespace: selected.namespaced ? r.namespace : undefined, selector: r.selector, title: `${r.name} logs` }, { dir: 'col' });
  };

  const selectorLogViewerRow = async (r) => {
    const { openKubeLogViewer } = await import('./kubelogviewer.js');
    openKubeLogViewer(kubeSpec, { namespace: selected.namespaced ? r.namespace : undefined, selector: r.selector }, `${r.name} logs`);
  };

  // A dockable tab, not a popup: the same trick sessions.js's hosts pane
  // uses — an ordinary pane with its terminal and file explorer hidden,
  // its own root div standing in for a session. Splitting, closing, the
  // tab strip and the layout tree all keep working for free; nothing
  // here has to re-implement any of them.
  const pane = await openKubeBrowserTab(title || 'Kubernetes cluster');
  pane.kubeSpec = kubeSpec;
  pane.kubeTitle = title || '';
  browserPane = pane;
  body = pane.kbpRoot;
  window.api.kube.metricsStart({ spec: kubeSpec }).then((r) => { if (r?.ok) metricsId = r.id; }).catch(() => {});
  pane.kubeMetricsStop = () => { if (metricsId) { window.api.kube.metricsStop({ id: metricsId }).catch(() => {}); metricsId = null; } };
  render();
  loadOverview();
  startAlerts();
  if (selected === 'helm') loadHelm();
  else if (selected === '3d') select3d();
  else if (selected === 'starred') loadStarred();
  window.api.kube.resourceTypes({ spec: kubeSpec })
    .then((r) => {
      loadingTypes = false;
      if (!r.ok) typesError = r.error || 'Could not discover resource types'; else types = r.types;
      // Reopened on a kind (a restored layout): only once the kinds are known.
      const want = opts.initialKind && !selected ? types.find((t) => t.name === opts.initialKind) : null;
      if (want) selectType(want); else render();
    })
    .catch((e) => { loadingTypes = false; typesError = e.message; render(); });
}

/**
 * A text viewer (YAML / `kubectl describe` output) — syntax highlighting
 * for YAML (`lang: 'text'`, for describe output, turns that off, since
 * it isn't YAML at all), and, when also `editable`, live validation and
 * autocomplete asked straight from the cluster (see `yamleditor.js`).
 * `onApply(text, {preview})` does the actual apply and returns whether it
 * went through; the modal only closes once it has. The diff-before-
 * applying step every onApply used to force on every call is opt-in
 * (unchecked by default) — it read as one more thing in the way of a
 * simple apply, not a safety net, for anyone who just wants to hit Apply.
 */
export async function textModal(title, text, { editable = false, onApply = null, spec = null, lang = 'yaml' } = {}) {
  const previewIn = editable ? checkbox('Preview the diff before applying', false) : null;
  let editor = null;
  await modal({
    title, width: 'min(920px, 94vw)', resize: 'kube-text',
    render: (body) => {
      editor = createYamlEditor({ value: text || '', readOnly: !editable, spec, lang });
      editor.dom.style.height = editable ? '54vh' : '60vh';
      editor.dom.style.overflow = 'auto';
      body.append(editor.dom);
      if (previewIn) body.append(el('div', { style: 'margin-top:8px' }, previewIn));
      editor.focus();
      return () => editor.destroy();
    },
    buttons: [
      editable ? {
        label: 'Apply', class: 'primary-btn',
        onClick: async ({ close }) => {
          const ok = await onApply(editor.getValue(), { preview: previewIn.input.checked });
          if (ok) close(true);
        },
      } : null,
      { label: editable ? 'Cancel' : 'Close', value: true, class: editable ? 'ghost-btn' : 'primary-btn' },
    ].filter(Boolean),
  });
}
