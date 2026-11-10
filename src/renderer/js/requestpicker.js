import { el, clear, debounce } from './util.js';
import { modal, toast } from './ui.js';
import { labelEntries } from './tags.js';
import { state } from './state.js';

/**
 * Browse what this user can actually request.
 *
 * Typing `/cluster/node/<uuid>` by hand was the only way to name a resource,
 * which meant knowing a UUID for a machine you cannot see. `tsh request search`
 * answers the real question — what is there to ask for — and reports a friendly
 * name and labels alongside the id, so the id never has to be typed or read.
 */

const KIND_LABELS = {
  node: 'Servers',
  app: 'Applications',
  db: 'Databases',
  kube_cluster: 'Kubernetes clusters',
  kube_resource: 'Kubernetes namespaces/pods',
  windows_desktop: 'Windows desktops',
  linux_desktop: 'Linux desktops',
  user_group: 'User groups',
  saml_idp_service_provider: 'SAML applications',
  git_server: 'Git servers',
  aws_ic_account: 'AWS accounts',
  aws_ic_account_assignment: 'AWS account assignments',
};

function kindLabel(kind) {
  return KIND_LABELS[kind] || kind.replace(/_/g, ' ');
}

/**
 * Pick resources for an access request. Resolves to an array of
 * `{id, name, kind, labels}`, or null if cancelled. `preselected` keeps
 * choices when the picker is reopened.
 */
export async function pickRequestResources(profile, preselected = [], opts = {}) {
  const chosen = new Map(preselected.map((r) => [r.id, r]));
  let kind = 'node';
  let kinds = ['node'];
  let searchText = '';
  let loading = false;
  let result = null;      // { ok, resources, error }
  let body = null;
  let countEl = null;

  // Loaded once up front so each row's MFA toggle can read/write it
  // synchronously inside render() instead of round-tripping on every click.
  const { isMfaHost, setMfaHost } = await import('./sidebar.js');

  try { kinds = await window.api.teleport.requestKinds(); } catch { /* no request kinds just means the defaults */ }
  // A pure-SSH setup with KubeLife off should never see "Kubernetes
  // clusters" as a choice here, even on a cluster that itself offers one —
  // see GUIDE.md § KubeLife, "Turning it off".
  if (state.settings.kubeEnabled === false) kinds = kinds.filter((k) => k !== 'kube_cluster' && k !== 'kube_resource');
  // A caller that already knows which kind and cluster it means — the kube
  // browser's own "Request namespace/pod access…", a requestable kube
  // cluster's "Request a namespace or pod…" — skips straight past both
  // dropdowns instead of landing on Servers and making the person redo by
  // hand what the caller already knew.
  if (opts.initialKind && kinds.includes(opts.initialKind)) kind = opts.initialKind;
  if ((kind === 'kube_cluster' || kind === 'kube_resource') && !kinds.includes(kind)) kind = kinds[0] || 'node';

  // kind: 'kube_resource' scoping — meaningless without a kube cluster to
  // search inside, unlike every other kind here.
  let kubeCluster = '';
  let kubeClusterOptions = [];
  let kubeClustersLoaded = false;
  let subKind = 'namespaces';   // --kube-kind: 'namespaces' | 'pods'
  let namespace = 'default';
  let allNamespaces = false;

  const kindSel = el('select');
  for (const k of kinds) kindSel.append(el('option', { value: k, text: kindLabel(k) }));
  kindSel.value = kind;
  kindSel.addEventListener('change', () => { kind = kindSel.value; onKindChanged(); });

  const kubeClusterSel = el('select');
  const subKindSel = el('select',
    {}, el('option', { value: 'namespaces', text: 'Namespaces' }), el('option', { value: 'pods', text: 'Pods' }));
  const namespaceIn = el('input', {
    class: 'ns-field', type: 'text', spellcheck: 'false', placeholder: 'default', value: namespace, style: 'width:120px',
  });
  const allNsCk = el('input', { type: 'checkbox' });
  const kubeRow = el('div', {
    class: 'rq-head', style: 'display:none;margin-top:6px',
  },
    el('span', { style: 'font-size:11.5px;color:var(--muted)', text: 'Cluster' }), kubeClusterSel,
    el('span', { style: 'font-size:11.5px;color:var(--muted)', text: 'Kind' }), subKindSel,
    el('span', { class: 'ns-field', style: 'font-size:11.5px;color:var(--muted)', text: 'Namespace' }),
    namespaceIn,
    el('label', { class: 'ns-field', style: 'font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:4px' },
      allNsCk, 'every namespace'));

  const updateNsFieldVisibility = () => {
    const showNsFields = subKind === 'pods';
    for (const f of kubeRow.querySelectorAll('.ns-field')) f.style.display = showNsFields ? '' : 'none';
    namespaceIn.disabled = allNamespaces;
    namespaceIn.style.opacity = allNamespaces ? '.5' : '1';
  };
  updateNsFieldVisibility();

  kubeClusterSel.addEventListener('change', () => { kubeCluster = kubeClusterSel.value; load(); });
  subKindSel.addEventListener('change', () => { subKind = subKindSel.value; updateNsFieldVisibility(); load(); });
  namespaceIn.addEventListener('change', () => { namespace = namespaceIn.value.trim() || 'default'; load(); });
  allNsCk.addEventListener('change', () => { allNamespaces = allNsCk.checked; updateNsFieldVisibility(); load(); });

  const ensureKubeClusters = async () => {
    if (kubeClustersLoaded) return;
    kubeClustersLoaded = true;
    clear(kubeClusterSel);
    kubeClusterSel.append(el('option', { value: '', text: 'Loading…' }));
    try {
      const r = await window.api.teleport.requestSearch({ proxy: profile.proxy, home: profile.homeDir, kind: 'kube_cluster' });
      kubeClusterOptions = r.ok ? (r.resources || []) : [];
    } catch { kubeClusterOptions = []; }
    // A caller's own cluster — the kube browser's own toolbar button,
    // already fully open — is routinely *not* among the "could additionally
    // request whole-cluster access to" results at all (it is not
    // requestable itself, standing access already covers it); it still
    // needs to be searchable for namespaces/pods here, so it is added
    // rather than silently swapped for whichever cluster the search did
    // return.
    if (opts.initialKubeCluster && !kubeClusterOptions.some((c) => c.name === opts.initialKubeCluster)) {
      kubeClusterOptions = [{ name: opts.initialKubeCluster }, ...kubeClusterOptions];
    }
    clear(kubeClusterSel);
    if (!kubeClusterOptions.length) {
      kubeClusterSel.append(el('option', { value: '', text: 'No Kubernetes clusters found' }));
      kubeCluster = '';
      return;
    }
    for (const c of kubeClusterOptions) kubeClusterSel.append(el('option', { value: c.name, text: c.name }));
    kubeCluster = (opts.initialKubeCluster && kubeClusterOptions.some((c) => c.name === opts.initialKubeCluster))
      ? opts.initialKubeCluster
      : kubeClusterOptions[0].name;
    kubeClusterSel.value = kubeCluster;
  };

  const onKindChanged = () => {
    kubeRow.style.display = kind === 'kube_resource' ? '' : 'none';
    if (kind !== 'kube_resource') { load(); return; }
    ensureKubeClusters().then(load);
  };

  const searchIn = el('input', {
    class: 'tagb-search', type: 'text', spellcheck: 'false',
    placeholder: 'Filter by name or label…',
  });
  // The server-side --search is only consulted when the local list is large
  // enough that it was probably truncated; otherwise filtering is instant.
  searchIn.addEventListener('input', debounce(() => {
    searchText = searchIn.value.trim();
    render();
  }, 120));

  const load = async () => {
    if (kind === 'kube_resource' && !kubeCluster) {
      result = { ok: false, error: 'No Kubernetes cluster to search within.', resources: [] };
      render();
      return;
    }
    loading = true;
    render();
    try {
      const params = { proxy: profile.proxy, home: profile.homeDir, kind };
      if (kind === 'kube_resource') {
        params.kubeCluster = kubeCluster;
        params.kubeKind = subKind;
        if (subKind === 'pods') {
          if (allNamespaces) params.allNamespaces = true;
          else params.namespace = namespace;
        }
      }
      result = await window.api.teleport.requestSearch(params);
    } catch (e) {
      result = { ok: false, error: e.message, resources: [] };
    }
    /*
     * Servers and kube clusters only: the MFA list is a thing per-session
     * SSH and per-session kube both ask for (the same `tsh kube login`
     * ceremony as `tsh ssh`) — apps and dbs have no equivalent concept of it
     * today. Worked out here, once per search, so each row's toggle can
     * read it without an IPC trip. Nodes are keyed by uuid (inventoryNodeIds);
     * kube clusters have none, so they're keyed by name (inventoryKubeIds) —
     * see GUIDE.md § KubeLife and teleport.js for the id formats.
     */
    if (result.ok && kind === 'node' && result.resources.length) {
      try {
        const ids = await window.api.teleport.inventoryNodeIds({
          items: result.resources.map((r) => ({ id: r.id, cluster: r.cluster, uuid: r.uuid })),
          home: profile.homeDir,
        });
        for (const r of result.resources) r.hostId = ids[r.id] || '';
      } catch { /* the row just won't offer the MFA toggle this time */ }
    } else if (result.ok && kind === 'kube_cluster' && result.resources.length) {
      try {
        const ids = await window.api.teleport.inventoryKubeIds({
          items: result.resources.map((r) => ({ id: r.id, cluster: r.cluster, name: r.name })),
          home: profile.homeDir,
        });
        for (const r of result.resources) r.hostId = ids[r.id] || '';
      } catch { /* the row just won't offer the MFA toggle this time */ }
    }
    loading = false;
    render();
  };

  const visible = () => {
    const all = result?.resources || [];
    const q = searchText.toLowerCase();
    if (!q) return all;
    return all.filter((r) => {
      const hay = [r.name, r.uuid, r.cluster,
        ...Object.entries(r.labels || {}).map(([k, v]) => `${k}=${v}`)].join(' ').toLowerCase();
      return hay.includes(q);
    });
  };

  /**
   * A server not yet granted can still be told it needs MFA — the flag just
   * waits in the same `mfaHosts` list a known host uses, keyed by the id the
   * node will carry once the grant lands (see `inventoryNodeIds`). From then
   * on every MFA-skip in the app (tmux, the shared connection, …) already
   * knows about it, with nothing more to wire up once access shows up.
   */
  const mfaToggle = (r) => {
    if (!r.hostId) return null;
    const on = isMfaHost(r.hostId);
    return el('span', {
      class: 'chip mfa-pick' + (on ? ' on' : ''),
      title: on
        ? 'Marked to need MFA once granted — click to forget'
        : 'Mark as needing MFA once granted, so it connects straight away',
      onClick: (e) => {
        e.stopPropagation();
        setMfaHost({ id: r.hostId, name: r.name || r.uuid }, !on).then(render);
      },
    }, el('span', { class: 'v', text: 'mfa' }));
  };

  const render = () => {
    if (!body) return;
    clear(body);

    if (countEl) {
      countEl.textContent = chosen.size
        ? `${chosen.size} selected`
        : '';
    }

    if (loading) {
      body.append(el('div', { class: 'sb-empty', text: `Searching ${kindLabel(kind).toLowerCase()}…` }));
      return;
    }
    if (result && !result.ok) {
      body.append(el('div', { class: 'sb-empty', style: 'color:var(--red)' },
        el('div', { text: result.error || 'Search failed' }),
        el('div', { style: 'margin-top:6px;opacity:.8', text: 'Your roles may not allow requesting this kind of resource.' })));
      return;
    }

    const rows = visible();
    if (!rows.length) {
      body.append(el('div', { class: 'sb-empty' },
        el('div', {
          text: searchText
            ? `No ${kindLabel(kind).toLowerCase()} matches “${searchText}”.`
            : `Nothing of this kind is requestable on ${profile.cluster || profile.proxy}.`,
        })));
      return;
    }

    const list = el('div', { class: 'rq-list' });
    for (const r of rows) {
      const on = chosen.has(r.id);
      const ck = el('input', { type: 'checkbox', class: 'ck' });
      ck.checked = on;

      const row = el('div', { class: 'rq-row' + (on ? ' on' : '') },
        ck,
        el('div', { class: 'rq-main' },
          el('div', { class: 'rq-name', text: r.name || r.uuid }),
          // The id is what actually goes into the request; showing it small and
          // last means it can be checked without having to be read first.
          el('div', { class: 'rq-id', title: r.id, text: r.id }),
          tagRow(r)),
        mfaToggle(r));

      const toggle = () => {
        chosen.has(r.id) ? chosen.delete(r.id) : chosen.set(r.id, r);
        render();
      };
      row.addEventListener('click', (e) => {
        if (e.target !== ck) toggle();
        else setTimeout(render, 0);
      });
      ck.addEventListener('change', () => { toggle(); });
      list.append(row);
    }
    body.append(list);
  };

  const res = await modal({
    // The same list answers two questions — "what shall I ask for?" and
    // "what do I want to be told about if it stops being offered?" — so the
    // caller names which one it is asking.
    title: opts.title || 'Request access to…',
    subtitle: opts.subtitle || profile.cluster || profile.proxy,
    width: 'min(820px, 95vw)',
    render: (b) => {
      countEl = el('span', { class: 'badge', style: 'margin-left:auto' });
      b.append(
        el('div', { class: 'rq-head' },
          el('span', { style: 'font-size:11.5px;color:var(--muted)', text: 'Kind' }),
          kindSel, countEl),
        kubeRow,
        searchIn,
        el('div', { class: 'rq-body' }));
      body = b.querySelector('.rq-body');
      onKindChanged();
      setTimeout(() => searchIn.focus(), 0);
      return () => {};
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Clear selection',
        onClick: () => { chosen.clear(); render(); },
      },
      {
        label: opts.confirmLabel || 'Use selected', class: 'primary-btn',
        onClick: ({ close }) => {
          if (!chosen.size) return toast('Select at least one resource', 'error');
          close([...chosen.values()]);
        },
      },
    ],
  });
  return res || null;
}

function tagRow(r) {
  const tags = labelEntries(r);
  if (!tags.length) return null;
  const strip = el('div', { class: 'rq-tags' });
  for (const [k, v] of tags.slice(0, 6)) {
    strip.append(el('span', { class: 'chip', style: 'cursor:default', title: `${k} = ${v}` },
      el('span', { class: 'k', text: k }),
      el('span', { class: 'v', text: v })));
  }
  if (tags.length > 6) strip.append(el('span', { class: 'chip more', text: `+${tags.length - 6}` }));
  return strip;
}

/** Roles this user may request, offered as a checklist instead of free text. */
export async function pickRequestRoles(profile, preselected = []) {
  const chosen = new Set(preselected);
  let body = null;
  let state = { loading: true, roles: [], error: null };

  const render = () => {
    if (!body) return;
    clear(body);
    if (state.loading) {
      body.append(el('div', { class: 'sb-empty', text: 'Listing requestable roles…' }));
      return;
    }
    if (state.error) {
      body.append(el('div', { class: 'sb-empty', style: 'color:var(--red)', text: state.error }));
      return;
    }
    if (!state.roles.length) {
      body.append(el('div', { class: 'sb-empty' },
        el('div', { text: 'No requestable roles on this cluster.' }),
        el('div', {
          style: 'margin-top:6px;opacity:.75',
          text: 'Your roles may grant access by resource instead — use Browse… on the resources field.',
        })));
      return;
    }
    const list = el('div', { class: 'rq-list' });
    for (const role of state.roles) {
      const on = chosen.has(role);
      const ck = el('input', { type: 'checkbox', class: 'ck' });
      ck.checked = on;
      const row = el('div', { class: 'rq-row' + (on ? ' on' : '') },
        ck, el('div', { class: 'rq-main' }, el('div', { class: 'rq-name', text: role })));
      const toggle = () => { chosen.has(role) ? chosen.delete(role) : chosen.add(role); render(); };
      row.addEventListener('click', (e) => { if (e.target !== ck) toggle(); else setTimeout(render, 0); });
      ck.addEventListener('change', toggle);
      list.append(row);
    }
    body.append(list);
  };

  const res = await modal({
    title: 'Requestable roles',
    subtitle: profile.cluster || profile.proxy,
    width: 'min(560px, 94vw)',
    render: (b) => {
      body = b;
      render();
      window.api.teleport.requestRoles({ proxy: profile.proxy, home: profile.homeDir })
        .then((r) => { state = { loading: false, roles: r.roles || [], error: r.ok ? null : r.error }; render(); })
        .catch((e) => { state = { loading: false, roles: [], error: e.message }; render(); });
    },
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Use selected', class: 'primary-btn', onClick: ({ close }) => close([...chosen]) },
    ],
  });
  return res || null;
}
