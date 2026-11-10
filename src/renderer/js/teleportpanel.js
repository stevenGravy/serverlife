import { state, tpKey } from './state.js';
import { el, clear, $ } from './util.js';
import { modal, toast, status, prompt, confirm, field, textInput, select, checkbox, contextMenu } from './ui.js';
import { pickRequestResources, pickRequestRoles } from './requestpicker.js';
import { clusterIcon, clusterColor, clusterMarkMenu } from './clustermarks.js';
import { compileQuery } from './tags.js';
import { groupKeyFor } from './folders.js';
import { noteLoggedOut } from './watch.js';

/**
 * Teleport profiles and access requests.
 *
 * Several tsh profiles can be logged in at once. Connections always carry an
 * explicit --proxy/--cluster, so which profile is "active" never changes where
 * a session goes — but switching matters for tsh commands, and assuming an
 * approved request re-issues the certificate with the extra roles.
 */

/**
 * What to say about the client and cluster versions after a login, if
 * anything. tsh prints its warning to a terminal this login does not have,
 * so the main process reads it (and works out the verdict itself) and it is
 * shown here instead of being lost behind "Logged in".
 */
function versionNote(r) {
  const c = r?.compat;
  if (c && (c.level === 'warn' || c.level === 'error')) return { kind: c.level === 'error' ? 'error' : 'info', text: c.message };
  if (r?.versionWarning?.text) return { kind: 'info', text: `tsh: ${r.versionWarning.text}` };
  return null;
}

/** A login's version note as a toast long enough to read, if there is one. */
function toastVersionNote(r, prefix = '') {
  const n = versionNote(r);
  if (n) toast(prefix + n.text, n.kind, 12000);
  return n;
}

/**
 * A proxy address as tsh wants it: host and port, nothing else.
 *
 * The same rule the main process applies when it builds the command (see
 * `teleport.proxyAddress`), repeated here so the field can be tidied in front
 * of the person typing in it and the *saved* record matches what tsh will be
 * given. The port is part of the host and stays.
 */
export function proxyAddress(value) {
  return String(value || '').trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^/@]*@/, '')
    .replace(/\/.*$/, '')
    .trim();
}

/**
 * A cluster just told to log out of, so the one *background* caller of
 * `sessions.js`'s relogin (a still-attached tmux pane quietly healing its
 * file channel on a timer) does not immediately log straight back in and
 * undo it — a failed connection there reads as "needs MFA" when the real
 * cause is just as often this cluster's own session being gone, and
 * nothing short of being told "this one was on purpose" lets it leave a
 * deliberate logout alone. Every other caller — a double-click on a host,
 * "Reconnect", opening a tmux session — is a person asking to connect
 * right now, which is itself a deliberate act that outranks this one.
 *
 * Cleared the moment this exact proxy/home is logged into again, whether
 * that is a login run from here or the login one of those explicit opens
 * just did — at that point there is a certificate again and the question
 * does not apply.
 */
const deliberateLogouts = new Set();
function logoutKey(proxy, home) { return `${proxyAddress(proxy)}|${home || ''}`; }
export function wasLoggedOutDeliberately(proxy, home) { return deliberateLogouts.has(logoutKey(proxy, home)); }

/**
 * The shared filter box, read the same way on every tab: whatever is in
 * `#host-filter` right now, whichever tab happens to be in front of it. The
 * Hosts tab keeps its own compiled copy in `sidebar.js`; this tab has no
 * standing import back to it (that module imports this one), so it reads
 * the one input element both tabs share instead of a second module-local
 * copy of the same string.
 */
function currentFilterText() {
  return ($('#host-filter')?.value || '').trim();
}

/**
 * Whether a cluster — a live profile or a saved login, the two shapes this
 * tab lists — matches the shared filter.
 *
 * Reuses the Hosts tab's own query language (`cluster=`, `proxy=`, `and`/
 * `or`/`not`, plain substrings) rather than a second, cruder one, so typing
 * a proxy address here works the way people expect it to, having seen it
 * work on a host's own row — that was the gap: the box sat above this tab
 * doing nothing to it. A profile names its proxy on `p.proxy` and its
 * cluster on `p.cluster`; a saved login carries the same two fields under
 * `t.proxy`/`t.cluster`, plus the name it was saved under and the user it
 * logs in as.
 *
 * `addr` carries the proxy address a second time, under the one field name
 * `tags.js`'s plain-text search already reads without a `key=` in front of
 * it — on a host, that is literally its address, so this is the one field
 * that comes for free. Without it, a bare `proxy.prod.example.com` would
 * need spelling as `proxy=proxy.prod.example.com` to match anything, which
 * is not how anyone searching for a cluster by its proxy actually types.
 */
export function clusterMatchesFilter(c, filterMatch) {
  return filterMatch.match({
    name: c.name || c.cluster || c.proxy || '',
    cluster: c.cluster || '',
    proxy: c.proxy || '',
    addr: c.proxy || '',
    user: c.user || c.username || '',
  });
}

export function renderTeleportTab(panel) {
  clear(panel);

  const filterText = currentFilterText();
  const filterMatch = compileQuery(filterText);

  if (!state.teleportProfiles.length) {
    panel.append(el('div', { class: 'sb-empty' },
      el('div', { text: state.teleportError || 'Not logged in to Teleport.' }),
      el('button', {
        class: 'ghost-btn', style: 'margin-top:9px', text: 'tsh login…',
        onClick: () => openLoginDialog(),
      })));
    // Saved clusters are the whole point when nothing is logged in: the proxy
    // address is gone from every list, and this is where it was kept.
    renderSavedLogins(panel, filterText, filterMatch);
    return;
  }

  const shown = state.teleportProfiles.filter((p) => clusterMatchesFilter(p, filterMatch));
  if (filterText && !shown.length) {
    panel.append(el('div', { class: 'sb-empty', text: `No cluster matches ${filterText}.` }));
  }

  for (const p of shown) {
    const nodes = state.teleportNodes.get(tpKey(p)) || [];
    /*
     * The mark the cluster carries in the host list, carried here too — the
     * two lists are the same clusters, and a red 🏭 that appears in one and
     * not the other is worse than no mark at all.
     */
    const colour = clusterColor(p);
    const icon = clusterIcon(p);
    // A cluster name is whatever Teleport calls itself, which is only
    // sometimes the proxy address it is reached at ("prod" at
    // proxy.example.com, say) — naming the proxy too is the
    // difference between finding this row again and not, for anyone who
    // only remembers it by address. The standard 443 is dropped from
    // both the comparison and the display: a cluster named after its own
    // proxy host, port aside, is not naming anything new.
    const proxyHost = proxyAddress(p.proxy).replace(/:443$/, '');
    const row = el('div', {
      class: 'sb-item' + (colour ? ' coloured' : ''),
      style: 'flex-direction:column;align-items:stretch;gap:3px;padding:8px 10px'
        + (colour ? `;--host-color:${colour}` : ''),
    });
    // The same two entries the host list's cluster heading offers.
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { heading: true, label: p.cluster || p.proxy },
        ...clusterMarkMenu(p),
      ]);
    });

    const top = el('div', { style: 'display:flex;align-items:center;gap:7px' },
      el('span', { class: 'st ' + (p.expired ? 'error' : 'connected') }),
      icon ? el('span', { style: 'font-size:12px;line-height:1', text: icon }) : null,
      el('span', {
        class: 'name',
        style: 'font-weight:500' + (colour ? `;color:${colour}` : ''),
        text: p.cluster || p.proxy,
      }),
      // A cluster name is whatever Teleport calls itself, which is only
      // sometimes the proxy address it is reached at ("prod" at
      // proxy.example.com, say) — naming the proxy too is the
      // difference between finding this row again and not, for anyone who
      // only remembers it by address. proxyHost already dropped the
      // standard 443: a cluster named after its own proxy host, port
      // aside, is not naming anything new.
      p.cluster && proxyHost && proxyHost !== p.cluster
        ? el('span', { class: 'hint', text: `(${proxyHost})` })
        : null,
      p.homeName ? el('span', { class: 'tag', title: 'TELEPORT_HOME=' + p.homeDir, text: p.homeName }) : null,
      // Leaves are not profiles of their own, so without this the name above
      // is the only cluster this login appears to have.
      leafClusterTag(p),
      p.active
        ? el('span', { class: 'tag live', title: 'Plain tsh commands use this cluster', text: 'active' })
        : null,
      // The same word the Hosts page uses, in the same colour, since this is
      // the list people come to after seeing it there.
      p.expired
        ? el('span', { class: 'tag expired', title: 'The certificate has lapsed', text: 'expired' })
        : null,
      // One command away from being the row above: shown here, on the
      // cluster itself, rather than only in the muted "valid until" line
      // below it, which is easy to not be reading when it matters. Clicking
      // it is the other half of that: the moment someone is looking at a
      // clock running out is the moment to offer resetting it, not a
      // separate button to go find.
      expiringSoon(p)
        ? el('span', {
            class: 'tag soon', style: 'cursor:pointer',
            title: 'Certificate expires soon — click to log out and back in now',
            text: `⏳ ${formatUntil(p.validUntil)} left`,
            onClick: (e) => { e.stopPropagation(); doRelogin(p); },
          })
        : null);

    const meta = el('div', { style: 'font-size:10.5px;color:var(--muted);font-family:var(--mono);padding-left:13px' },
      el('div', { text: p.username || '' }),
      el('div', {
        text: p.expired ? 'certificate expired' : `valid until ${formatUntil(p.validUntil)}`,
        style: p.expired ? 'color:var(--red)' : '',
      }),
      p.activeRequests?.length
        ? el('div', { style: 'color:var(--accent)', text: `${p.activeRequests.length} assumed request(s)` })
        : null,
      !p.expired ? el('div', { text: `${nodes.length} nodes · ${p.logins?.length || 0} logins` }) : null);

    const actions = el('div', { style: 'display:flex;gap:5px;padding-left:13px;margin-top:5px;flex-wrap:wrap' },
      p.expired
        ? el('button', { class: 'ghost-btn sm', text: 'Login', onClick: () => doLogin(p) })
        : el('button', { class: 'ghost-btn sm', text: p.active ? 'Active' : 'Switch to', disabled: p.active, onClick: () => doSwitch(p) }),
      // The same menu the leaf badge opens, spelled out for anyone who never
      // thinks to click a badge.
      leavesFor(p).length
        ? el('button', {
            class: 'ghost-btn sm', text: 'Cluster…',
            title: 'Switch between this root and its leaf clusters',
            onClick: (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openClusterSwitcher(r.left, r.bottom + 3, p);
            },
          })
        : null,
      // A login that will not complete in the app is finished by hand, so the
      // exact command — with TELEPORT_HOME where it matters — is one click away.
      el('button', {
        class: 'ghost-btn sm', text: 'Copy login cmd',
        title: 'Copy the tsh login command for this cluster, to paste into a terminal',
        onClick: async () => {
          const { copyLoginCommand } = await import('./sidebar.js');
          copyLoginCommand(p);
        },
      }),
      el('button', {
        class: 'ghost-btn sm', text: 'Login settings\u2026',
        title: 'How this cluster is logged into \u2014 SSO provider, local, passwordless, MFA \u2014 kept for next time',
        onClick: () => openLoginDialog({
          proxy: p.proxy, user: p.username, cluster: p.cluster,
          home: p.homeDir && p.home ? p.homeDir : '', remember: true,
          // So saving from here does not quietly switch these off.
          autoLogin: savedRecordsFor(p).some((s) => s.autoLogin),
          showInHosts: savedRecordsFor(p).some((s) => s.showInHosts),
        }),
      }),
      el('button', {
        class: 'ghost-btn sm', text: 'Save cluster',
        title: 'Keep this cluster so it can be logged into again after the certificate goes',
        onClick: () => saveClusterLogin({
          name: p.cluster || p.proxy,
          proxy: p.proxy,
          cluster: p.cluster,
          user: p.username,
          home: p.homeDir && p.home ? p.homeDir : '',
        }).then(() => renderTeleportTab($('#sb-panel-teleport'))),
      }),
      pinButton(p),
      // Nodes, leaves and beams for just this cluster, without waiting for
      // the global Refresh — the same call the Hosts tab's ⟳ already makes
      // for it, with the same busy state and toast on failure.
      el('button', {
        class: 'ghost-btn sm', text: 'Refresh',
        title: 'Re-read this cluster: its nodes, its leaves and its beams',
        onClick: async () => {
          const { refreshProfile } = await import('./sidebar.js');
          await refreshProfile(p);
        },
      }),
      el('button', {
        class: 'ghost-btn sm', text: 'Status',
        title: 'tsh status and version — what tsh status says about this cluster, plus the version it is running',
        onClick: () => openClusterStatus(p),
      }),
      p.expired ? null : el('button', {
        class: 'ghost-btn sm', text: 'Add to ssh config…',
        title: 'Put this cluster\u2019s tsh config block into ~/.ssh/config, so plain ssh, scp and rsync reach its nodes',
        onClick: () => openTshConfigDialog(p),
      }),
      p.expired ? null : el('button', {
        class: 'ghost-btn sm', text: 'Logout',
        title: 'Delete this cluster\u2019s certificate (tsh logout --proxy=…)',
        onClick: () => doLogout(p),
      }),
      el('button', { class: 'ghost-btn sm', text: 'Requests', onClick: () => openRequestsDialog(p) }),
      // The half of Teleport this app does not cover — applications, databases,
      // Kubernetes, the audit log — is a browser away, and the cluster is
      // already named right here.
      el('button', {
        class: 'ghost-btn sm', text: 'Web UI',
        title: 'Open this cluster in the Teleport web UI',
        onClick: () => openClusterWeb(p),
      }),
      el('button', {
        class: 'ghost-btn sm', text: 'Cluster info',
        title: 'Version, edition, auth connector and proxy listeners, from /webapi/ping',
        onClick: async () => {
          const { openNetTools } = await import('./nettools.js');
          openNetTools({ host: p.proxy, tool: 'teleport' });
        },
      }));

    row.append(top, meta, actions);
    panel.append(row);
  }

  renderSavedLogins(panel, filterText, filterMatch);

  panel.append(el('div', { style: 'padding:9px 10px;display:flex;gap:6px;flex-wrap:wrap' },
    el('button', { class: 'ghost-btn', text: 'Add cluster…', onClick: () => openLoginDialog() }),
    el('button', { class: 'ghost-btn', text: 'Requests…', onClick: () => openRequestsDialog(activeProfile()) }),
    /*
     * The other half of access requests: not what is outstanding, but
     * whether the thing you expect to be able to ask for is still on offer.
     * It belongs beside Requests — same subject, opposite direction — and
     * says how many are being watched so the pane is not the only way to
     * find out that something has gone.
     */
    monitorButton()));
}

/** "Monitor requestable…", carrying the count and any bad news. */
function monitorButton() {
  const btn = el('button', {
    class: 'ghost-btn', text: 'Monitor requestable…',
    title: 'Confirm on a timer that the resources you expect to be able to request are still offered',
    onClick: () => import('./reqmonitor.js').then((m) => m.openMonitorPane()),
  });
  import('./reqmonitor.js').then((m) => {
    const n = m.monitorCount();
    const gone = m.missingCount();
    if (!n) return;
    btn.textContent = gone
      ? `Monitor requestable — ${gone} missing`
      : `Monitor requestable — ${n}`;
    if (gone) btn.classList.add('danger-btn');
  }).catch(() => {});
  return btn;
}

/* ------------------------------------------------------------------ */
/* Saved clusters                                                      */
/* ------------------------------------------------------------------ */

/**
 * The clusters kept for logging back into.
 *
 * Deliberately listed even while their certificate is live — a saved cluster is
 * a record of how you log in (proxy, user, connector, which tsh home), not a
 * session, and seeing it there is how you know it will still be there after it
 * expires.
 *
 * Filtered by the same shared box the live profiles above are, and
 * separately — a saved-but-never-logged-in cluster has no profile to match
 * against, so it needs its own pass against `filterMatch` rather than
 * inheriting whichever profiles happened to survive it.
 */
function renderSavedLogins(panel, filterText = '', filterMatch = compileQuery('')) {
  const wrap = el('div');
  panel.append(wrap);

  window.api.teleport.savedLogins().then((all) => {
    if (!all.length) return;
    const list = all.filter((t) => clusterMatchesFilter(t, filterMatch));
    if (!list.length) {
      if (filterText) {
        clear(wrap);
        wrap.append(el('div', {
          style: 'padding:9px 10px 3px;font-size:10.5px;font-weight:600;letter-spacing:.06em;'
            + 'text-transform:uppercase;color:var(--muted)',
          text: 'Saved clusters',
        }), el('div', { class: 'sb-empty', text: `No saved cluster matches ${filterText}.` }));
      }
      return;
    }
    clear(wrap);
    wrap.append(el('div', {
      style: 'padding:9px 10px 3px;font-size:10.5px;font-weight:600;letter-spacing:.06em;'
        + 'text-transform:uppercase;color:var(--muted)',
      text: 'Saved clusters',
    }));

    for (const t of list) {
      const live = state.teleportProfiles.find((p) => p.proxy === t.proxy
        && (p.homeDir || '') === (t.home || p.homeDir || ''));
      const row = el('div', { class: 'sb-item', style: 'flex-direction:column;align-items:stretch;gap:3px;padding:8px 10px' });

      row.append(el('div', { style: 'display:flex;align-items:center;gap:7px' },
        el('span', { class: 'st ' + (live && !live.expired ? 'connected' : '') }),
        el('span', { class: 'name', style: 'font-weight:500', text: t.name }),
        t.home ? el('span', { class: 'tag', title: 'TELEPORT_HOME=' + t.home, text: 'home' }) : null,
        live && !live.expired ? el('span', { class: 'tag', text: 'logged in' }) : null,
        t.autoLogin ? el('span', {
          class: 'tag',
          title: 'Logged in automatically when the app starts, if the certificate has gone',
          text: 'auto',
        }) : null,
        t.showInHosts ? el('span', {
          class: 'tag',
          title: 'Kept on the Hosts tab even when tsh status does not list it',
          text: 'pinned',
        }) : null));

      row.append(el('div', {
        style: 'font-size:10.5px;color:var(--muted);font-family:var(--mono);padding-left:13px',
      },
        el('div', { text: t.proxy }),
        el('div', {
          text: [t.user, t.authConnector ? `via ${t.authConnector}` : 'cluster default login',
            t.mfaMode ? `MFA ${t.mfaMode}` : null, t.ttl ? t.ttl + 'm' : null].filter(Boolean).join(' · '),
        })));

      row.append(el('div', { style: 'display:flex;gap:5px;padding-left:13px;margin-top:5px;flex-wrap:wrap' },
        el('button', {
          class: live && !live.expired ? 'ghost-btn sm' : 'primary-btn sm',
          text: live && !live.expired ? 'Log in again' : 'Log in',
          onClick: () => loginFromSaved(t),
        }),
        el('button', {
          class: 'ghost-btn sm', text: t.showInHosts ? 'Unpin' : 'Pin',
          title: t.showInHosts
            ? 'Stop keeping this cluster on the Hosts tab while tsh status does not list it. The saved login is kept.'
            : 'Keep this cluster on the Hosts tab even when tsh status does not list it',
          onClick: async () => {
            await saveClusterLogin({ ...t, showInHosts: !t.showInHosts });
            renderTeleportTab(panel);
          },
        }),
        el('button', {
          class: 'ghost-btn sm', text: 'Copy login cmd',
          onClick: async () => {
            const { copyLoginCommand } = await import('./sidebar.js');
            copyLoginCommand({ proxy: t.proxy, username: t.user, homeDir: t.home }, {
              authConnector: t.authConnector || undefined,
              ttl: t.ttl || undefined,
            });
          },
        }),
        // Works whether or not the certificate is still good: it is the
        // browser's own session, which is often the way back in when this
        // one has expired.
        el('button', {
          class: 'ghost-btn sm', text: 'Web UI',
          title: t.cluster
            ? 'Open this cluster in the Teleport web UI'
            : 'Open this proxy in the Teleport web UI',
          onClick: () => openClusterWeb({ proxy: t.proxy, cluster: t.cluster }),
        }),
        el('button', {
          class: 'ghost-btn sm', text: 'Edit…',
          onClick: () => openLoginDialog({
            id: t.id, proxy: t.proxy, user: t.user, cluster: t.cluster,
            auth: t.authConnector, home: t.home, ttl: t.ttl, mfaMode: t.mfaMode,
            extraArgs: t.extraArgs,
            autoLogin: t.autoLogin,
            showInHosts: t.showInHosts,
            remember: true,
          }),
        }),
        el('button', {
          class: 'ghost-btn sm', text: 'Forget',
          onClick: async () => {
            if (!await confirm({
              title: 'Forget ' + t.name,
              message: `Stop keeping ${t.proxy} for re-login?`,
              detail: 'Nothing is logged out; only the saved details are removed.',
              confirmLabel: 'Forget',
            })) return;
            await window.api.teleport.deleteSavedLogin(t.id);
            renderTeleportTab(panel);
            (await import('./sidebar.js')).loadSavedClusters();
          },
        })));

      wrap.append(row);
    }
  }).catch(() => {});
}

/**
 * Log in the saved clusters that asked for it, on launch.
 *
 * Only those with `autoLogin`, only those whose certificate is actually gone,
 * and **one at a time**: an SSO login opens a browser, and four browser tabs
 * fighting over the foreground is worse than not doing this at all. A failure
 * is reported once and does not stop the others — a cluster whose connector
 * needs a terminal is exactly the case this cannot serve, and it should not
 * take the rest with it.
 */
export async function autoLoginSavedClusters() {
  const saved = await window.api.teleport.savedLogins().catch(() => []);
  const wanted = (saved || []).filter((t) => t.autoLogin);
  if (!wanted.length) return;

  const live = state.teleportProfiles || [];
  const needed = wanted.filter((t) => {
    const p = live.find((x) => x.proxy === t.proxy && (x.home || '') === (t.home || ''));
    return !p || p.expired;
  });
  if (!needed.length) return;

  let done = 0;
  for (const t of needed) {
    status(`Logging in to ${t.name}…`, 0, 'login');
    try {
      // A saved cluster that names a user is going to be asked something, so
      // it opens a tab rather than failing quietly in the background.
      if (t.user) {
        await runLoginInShell(t, { title: `tsh login \u00b7 ${t.name}` });
        continue;
      }
      const r = await window.api.teleport.login({
        proxy: t.proxy,
        user: t.user || undefined,
        authConnector: t.authConnector || undefined,
        cluster: t.cluster || undefined,
        ttl: t.ttl || undefined,
        mfaMode: t.mfaMode || undefined,
        home: t.home || undefined,
      });
      if (r.ok) { done++; window.api.teleport.markSavedLoginUsed(t.id).catch(() => {}); toastVersionNote(r, `${t.name}: `); }
      else if (!toastVersionNote(r, `${t.name}: login failed. `)) {
        toast(`${t.name}: automatic login failed — log in from the Teleport tab`, 'error', 7000);
      }
    } catch (e) {
      toast(`${t.name}: ${e.message}`, 'error', 7000);
    }
  }
  status('', 0, 'login');
  if (done) {
    const { refreshInventory } = await import('./sidebar.js');
    await refreshInventory();
    status(`Logged in to ${done} saved cluster${done === 1 ? '' : 's'}`, 6000);
  }
}

/**
 * The saved cluster record behind a live profile, if there is one.
 *
 * What a profile reports and what was *saved* for it are different things. A
 * profile knows the proxy and the Teleport username the certificate was cut
 * for; the record knows how that certificate is obtained — which connector,
 * what TTL, which tsh home. Only the second is a login command.
 */
export async function savedClusterFor(p) {
  if (p?.saved) return p.saved;   // a group drawn from the record itself
  if (!p?.proxy) return null;
  const all = await window.api.teleport.savedLogins().catch(() => []) || [];
  const sameCluster = all.filter((s) => proxyAddress(s.proxy) === proxyAddress(p.proxy)
    && (s.home || '') === (p.home || ''));
  // Saved logins are kept per proxy *and* user, so where two accounts on one
  // cluster are saved, the one to reuse is the account already logged in.
  return sameCluster.find((s) => (s.user || '') === (p.username || '')) || sameCluster[0] || null;
}

/** Log in with a saved cluster's details, filling the dialog from the record. */
export async function loginFromSaved(t) {
  await window.api.teleport.markSavedLoginUsed(t.id).catch(() => {});
  return openLoginDialog({
    proxy: t.proxy,
    user: t.user,
    cluster: t.cluster,
    auth: t.authConnector,
    ttl: t.ttl,
    mfaMode: t.mfaMode,
    home: t.home,
    autoLogin: t.autoLogin,
    showInHosts: t.showInHosts,
    remember: true,
    id: t.id,
  });
}

/**
 * Run `tsh login` in a local shell tab instead of in the background.
 *
 * A login that names a user is heading for a password, an OTP or a hardware
 * key, and a prompt in a spawned process with nowhere to draw is a login that
 * sits there and then fails. So it gets a real terminal: the tab shows exactly
 * what tsh is asking, and the inventory is re-read when the command finishes.
 *
 * Resolves once that command actually exits, not once the tab merely opens
 * — `true` for a clean exit, `false` otherwise — so a caller with something
 * waiting on the login (a connect that only started this because it needed
 * one first) can pick up exactly where it left off once the person is done,
 * rather than being told to go try again themselves. `autoLoginSavedClusters`
 * already relies on this: its own "one at a time" is only real if each
 * login here is waited out the same way the headless one already is.
 */
export async function runLoginInShell(v, { title } = {}) {
  try {
    const { command, args, teleportHome } = await window.api.teleport.loginArgs({
      proxy: v.proxy,
      user: v.user || undefined,
      authConnector: v.authConnector || undefined,
      cluster: v.cluster || undefined,
      ttl: v.ttl || undefined,
      mfaMode: v.mfaMode || undefined,
      home: v.home || undefined,
      extraArgs: v.extraArgs,
    });
    const { openLocalShell } = await import('./sessions.js');
    const done = new Promise((resolve) => {
      openLocalShell(undefined, {
        command,
        args,
        teleportHome,
        title: title || `tsh login · ${v.cluster || v.proxy}`,
        onExit: async (code) => {
          // Whatever it did, the inventory is the thing that knows: a successful
          // login shows up as a profile, a failed one as nothing changed.
          const { refreshInventory } = await import('./sidebar.js');
          await refreshInventory().catch(() => {});
          status(code === 0
            ? `Logged in to ${v.cluster || v.proxy}`
            : `tsh login exited with ${code} — the tab has what it said`, 8000);
          resolve(code === 0);
        },
      }).catch((e) => { toast(e.message, 'error'); resolve(false); });
    });
    status(`Finish the login in this tab — it is asking as ${v.user}`, 9000);
    return await done;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

/**
 * Pin or unpin a listed cluster on the Hosts tab.
 *
 * The pin lives on the saved record, since that is what outlives the
 * profile, so pinning a cluster that was never saved saves it — with the
 * same fields "Save cluster" would — and unpinning keeps the record.
 */
function savedRecordsFor(p) {
  const home = p.homeDir && p.home ? p.homeDir : '';
  const bare = (v) => proxyAddress(v).toLowerCase().replace(/:443$/, '');
  return (state.savedLogins || []).filter((s) => bare(s.proxy) === bare(p.proxy) && (s.home || '') === home);
}

function pinButton(p) {
  const recs = savedRecordsFor(p);
  const pinned = recs.some((s) => s.showInHosts);
  return el('button', {
    class: 'ghost-btn sm', text: pinned ? 'Unpin' : 'Pin',
    title: pinned
      ? 'Stop keeping this cluster on the Hosts tab after a logout. The saved login is kept.'
      : 'Keep this cluster on the Hosts tab even after a logout, when tsh status no longer lists it',
    onClick: async () => {
      if (pinned) {
        // Every record for the cluster, or another account's would keep it there.
        for (const s of recs.filter((x) => x.showInHosts)) await saveClusterLogin({ ...s, showInHosts: false });
      } else {
        const rec = recs.find((s) => (s.user || '') === (p.username || '')) || recs[0];
        await saveClusterLogin(rec ? { ...rec, showInHosts: true } : {
          name: p.cluster || p.proxy,
          proxy: p.proxy,
          cluster: p.cluster,
          user: p.username,
          home: p.homeDir && p.home ? p.homeDir : '',
          showInHosts: true,
        });
      }
      renderTeleportTab($('#sb-panel-teleport'));
    },
  });
}

/** Keep a cluster — from a live profile, or from the login dialog's fields. */
export async function saveClusterLogin(rec) {
  const saved = await window.api.teleport.saveLogin(rec);
  status(`Saved ${saved.name} for re-login`);
  // Awaited, so a caller redrawing straight after sees the change.
  await import('./sidebar.js').then((m) => m.loadSavedClusters()).catch(() => {});
  return saved;
}

/**
 * What `tsh status` says about this cluster, and the version `/webapi/ping`
 * says the cluster itself is running.
 *
 * The parsed version is already on screen — the profile row is drawn from it —
 * so this is the printed form, which is what people compare against their
 * terminal, paste into a ticket, and read the certificate extensions out of.
 * The summary above it is the app's own view of the same profile, so a
 * disagreement between the two is visible rather than hidden. The cluster's
 * own version comes from the same unauthenticated ping "Cluster info…"
 * already uses — fetched here too, so it is read without a second dialog.
 */
export async function openClusterStatus(p) {
  status('Reading tsh status…', 0);
  let info;
  try {
    info = await window.api.teleport.statusText({ proxy: p.proxy, home: p.homeDir });
  } catch (e) {
    status('');
    return toast(e.message, 'error');
  }
  status('');
  const ping = await window.api.teleport.webapiPing({ proxy: p.proxy }).catch(() => null);
  const version = ping?.ping?.server_version;

  const row = (k, v) => (v ? el('div', { class: 'nt-kv' },
    el('span', { class: 'k', text: k }),
    el('span', { class: 'v', text: String(v) })) : null);

  return modal({
    title: 'tsh status and version',
    subtitle: p.cluster || p.proxy,
    width: 'min(760px, 95vw)',
    resize: 'tshstatus',
    render: (body) => {
      body.append(...[
        row('cluster', p.cluster),
        row('proxy', p.proxy),
        row('cluster version', version ? `v${version}${ping.ping.edition ? ` (${ping.ping.edition})` : ''}` : (ping ? 'unknown' : 'unreachable')),
        row('logged in as', p.username),
        row('roles', (p.roles || []).join(', ')),
        row('logins', (p.logins || []).join(', ')),
        row('valid until', p.validUntil ? new Date(p.validUntil).toLocaleString()
          + (p.expired ? '  (expired)' : '') : ''),
        row('tsh home', info.home),
        row('active', p.active ? 'yes' : 'no'),
        el('div', { class: 'nt-sub', text: `as tsh prints it — ${info.home}` }),
        /*
         * `tsh status` leads with whichever profile is *active* in that home
         * and lists the rest after it, so the block below can open on a
         * different cluster than the one this dialog is about. Said plainly
         * rather than left to be noticed.
         */
        !info.activeMatches ? el('div', { class: 'hint', style: 'margin-bottom:6px' },
          `tsh leads with the active profile${info.activeCluster ? ` (${info.activeCluster})` : ''}`
          + `, and lists the others after it — ${p.cluster || p.proxy} is in there rather than at the top.`) : null,
        el('pre', { class: 'nt-pre', text: info.text }),
      ].filter(Boolean));
    },
    buttons: [
      { label: 'Close', value: null },
      {
        label: 'Copy',
        onClick: () => { window.api.clipboard.write(info.text); status('Copied tsh status'); },
      },
      {
        label: 'Cluster info…',
        title: 'Version, edition, auth connector and listeners, from /webapi/ping',
        onClick: async () => {
          const { openNetTools } = await import('./nettools.js');
          openNetTools({ host: p.proxy, tool: 'teleport' });
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* tsh config into ~/.ssh/config                                       */
/* ------------------------------------------------------------------ */

/**
 * `tsh config >> ~/.ssh/config`, shown before it is written.
 *
 * What this buys is everything that speaks ssh and nothing else: `ssh
 * node.cluster`, scp, rsync, Ansible, git, VS Code Remote. The app itself does
 * not need it — it generates its own config per connection — so this is purely
 * for the tools outside the window.
 */
export async function openTshConfigDialog(p) {
  status('Asking tsh what it would write…', 0);
  let info;
  try {
    info = await window.api.discovery.tshConfigPreview({
      proxy: p.proxy, cluster: p.cluster, home: p.homeDir,
    });
  } catch (e) {
    status('');
    return toast(e.message, 'error');
  }
  status('');

  const already = info.present || (info.foreign || []).length > 0;
  const warn = el('div', {
    class: 'perm-note',
    style: 'margin-bottom:10px;color:var(--amber)',
  });
  if (info.foreign?.length) {
    warn.append(
      el('div', { style: 'font-weight:600', text: 'This cluster is already in that file.' }),
      el('div', {
        style: 'margin-top:4px',
        text: `${info.path} already defines ${info.foreign.slice(0, 4).join(', ')}`
          + `${info.foreign.length > 4 ? ` and ${info.foreign.length - 4} more` : ''}`
          + ' outside anything this app wrote — most likely a tsh config run by hand.',
      }),
      el('div', {
        style: 'margin-top:4px',
        text: 'ssh uses the first value it finds for each option, so adding a second block for the '
          + 'same hosts leaves one of the two doing nothing while both look live. Removing the old '
          + 'block by hand first is the cleaner path.',
      }));
  } else if (info.present) {
    warn.append(el('div', {
      text: `A block for ${p.cluster || p.proxy} written by this app is already in ${info.path}. `
        + 'Writing again replaces it in place.',
    }));
  }

  const body = el('pre', {
    style: 'font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-all;'
      + 'background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);'
      + 'padding:9px 10px;max-height:240px;overflow:auto;margin:0',
    text: info.text,
  });

  const go = await modal({
    title: 'Add this cluster to ~/.ssh/config',
    subtitle: `${p.cluster || p.proxy} → ${info.path}`,
    width: 'min(680px, 94vw)',
    render: (b) => {
      b.append(...[
        already ? warn : null,
        el('div', { class: 'hint', style: 'margin-bottom:8px' },
          'Written between markers naming this cluster, so writing it again replaces it rather than '
          + 'stacking another copy. Everything outside the markers is left alone, and the file is '
          + 'backed up first.'),
        el('label', { style: 'font-size:11px;color:var(--muted);margin-bottom:4px;display:block', text: 'tsh config' }),
        body,
      ].filter(Boolean));
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Copy it instead',
        title: 'Copy the block and edit the file yourself',
        onClick: () => {
          window.api.clipboard.write(info.text);
          status('Copied — paste it into ~/.ssh/config', 8000);
        },
      },
      {
        // Named for what it does in the state you are actually in.
        label: info.foreign?.length ? 'Add it anyway' : (info.present ? 'Replace it' : 'Add it'),
        class: info.foreign?.length ? 'primary-btn danger-btn' : 'primary-btn',
        value: true,
      },
    ],
  });
  if (!go) return;

  // A second question only where it is a real risk: a duplicate the app cannot
  // clean up for you, because it is the user's own text.
  if (info.foreign?.length) {
    const ok = await confirm({
      title: 'Add a second block for this cluster?',
      message: `${info.path} already defines ${info.foreign.slice(0, 3).join(', ')} outside this app\u2019s markers.`,
      detail: 'Both blocks will be in the file. ssh will use whichever comes first for any option they '
        + 'both set, which makes the other one silently inert. Only the new block can be replaced or '
        + 'removed by this app later.',
      confirmLabel: 'Add it anyway',
      danger: true,
    });
    if (!ok) return;
  }

  try {
    const r = await window.api.discovery.tshConfigWrite({
      proxy: p.proxy, cluster: p.cluster, text: info.text,
    });
    toast(`${r.replaced ? 'Replaced' : 'Added'} ${p.cluster || p.proxy} in ${r.path}`
      + (r.backup ? ' (backup taken)' : ''), 'success', 8000);
    const { refreshSshConfigs } = await import('./sidebar.js');
    await refreshSshConfigs().catch(() => {});
  } catch (e) { toast(e.message, 'error'); }
}

/* ------------------------------------------------------------------ */
/* Leaf clusters                                                       */
/* ------------------------------------------------------------------ */

/**
 * A leaf, drawn rather than spelled: a small shape reads at badge size where
 * the word "leaf" would not, and it inherits the text colour around it.
 */
const LEAF_SVG = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">'
  + '<path d="M3 13C3 7.2 7.2 3 13 3 13 8.8 8.8 13 3 13Z"'
  + ' fill="currentColor" fill-opacity=".3" stroke="currentColor" stroke-width="1.3"'
  + ' stroke-linejoin="round"/>'
  + '<path d="M4.6 11.4 11.4 4.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
  + '</svg>';

/**
 * The trusted clusters behind a profile: its root and every leaf.
 *
 * `tsh status` names one cluster — whichever the certificate currently points
 * at — so a root with three leaves looks exactly like a root with none. The set
 * comes from `tsh clusters`, read once per profile by the inventory sweep.
 */
export function clustersFor(p) {
  return (p && state.teleportClusters.get(tpKey(p))) || [];
}

export function leavesFor(p) {
  return clustersFor(p).filter((c) => c.leaf);
}

/**
 * The cluster this profile's certificate points at.
 *
 * `selected` comes straight from tsh; the profile's own cluster name is the
 * fallback, and the two agree — including when what is selected is a leaf,
 * which is when the distinction matters most.
 */
export function selectedCluster(p) {
  const list = clustersFor(p);
  return list.find((c) => c.selected) || list.find((c) => c.name === p?.cluster) || null;
}

/**
 * A cluster's labels as one line, `key=value` and sorted, or '' if it has
 * none. Sorted because tsh hands back a map: unsorted, the same cluster would
 * read differently between two refreshes.
 */
function clusterLabels(c) {
  const labels = c?.labels;
  if (!labels || typeof labels !== 'object') return '';
  return Object.keys(labels).sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(' · ');
}

/**
 * The badge that says a cluster has leaves behind it, and switches between
 * them when clicked.
 *
 * Drawn only when there is somewhere else to go, so it stays news rather than
 * decoration. On a profile already pointed at a leaf it says so: the name in
 * the heading is then the leaf's, not the root's, and nothing else on screen
 * would tell you which of the two you are looking at.
 */
export function leafClusterTag(p) {
  const leaves = leavesFor(p);
  if (!leaves.length) return null;
  const sel = selectedCluster(p);
  const onLeaf = !!sel?.leaf;
  const tag = el('span', {
    class: 'tag leafc' + (onLeaf ? ' on' : ''),
    html: LEAF_SVG,
    title: [
      onLeaf
        ? `On leaf cluster ${sel.name}. Click to switch cluster — the root and `
          + `${leaves.length} leaf${leaves.length === 1 ? '' : 'ves'} are listed.`
        : `${leaves.length} leaf cluster${leaves.length === 1 ? '' : 's'} behind this root. `
          + 'Click to switch to one.',
      onLeaf ? clusterLabels(sel) : leaves.map((c) => [c.name, clusterLabels(c)].filter(Boolean).join('  ')).join('\n'),
    ].filter(Boolean).join('\n'),
  });
  tag.append(el('span', { text: onLeaf ? 'leaf' : String(leaves.length) }));
  tag.addEventListener('click', (e) => {
    // The badge sits on a heading that collapses when clicked, and inside a
    // row that opens things; neither should happen here.
    e.preventDefault();
    e.stopPropagation();
    const r = tag.getBoundingClientRect();
    openClusterSwitcher(r.left, r.bottom + 3, p);
  });
  return tag;
}

/**
 * Past this many leaves, a menu is the wrong shape: a list that long is
 * scrolled and read rather than pointed at, so the switcher becomes a dialog
 * with a search box. Estates that federate in dozens of clusters are exactly
 * the ones where the name is half-remembered.
 */
const LEAF_SEARCH_AT = 10;

/**
 * Whichever way of choosing a cluster suits how many there are: a menu at the
 * click, or a searchable list.
 */
export function openClusterSwitcher(x, y, p) {
  if (leavesFor(p).length > LEAF_SEARCH_AT) return openClusterPicker(p);
  const items = clusterMenuItems(p);
  if (!items.length) return null;
  return contextMenu(x, y, items);
}

/**
 * The menu entry other menus embed — the sidebar's cluster heading uses this,
 * so the choice between a submenu and the searchable dialog is made in one
 * place rather than at every call site.
 */
export function clusterSwitchMenuItem(p) {
  const leaves = leavesFor(p);
  if (!leaves.length) return null;
  if (leaves.length > LEAF_SEARCH_AT) {
    return {
      label: 'Switch cluster…',
      title: `Search this root and its ${leaves.length} leaf clusters`,
      onClick: () => openClusterPicker(p),
    };
  }
  return {
    label: 'Switch cluster',
    title: 'This root and the leaf clusters it trusts',
    submenu: clusterMenuItems(p),
  };
}

/**
 * The searchable form of the same list.
 *
 * The query runs over names *and* labels, because with this many clusters the
 * label is often the only thing anyone remembers — `env=prod`, a region, a
 * customer — and a name search alone would send them scrolling anyway.
 */
export function openClusterPicker(p) {
  const list = clustersFor(p);
  if (list.length < 2) return null;
  const sel = selectedCluster(p);
  const leaves = list.filter((c) => c.leaf);

  return modal({
    title: 'Switch cluster',
    subtitle: `${p.cluster || p.proxy} · ${leaves.length} leaf cluster${leaves.length === 1 ? '' : 's'}`,
    render: (body, { close }) => {
      const search = textInput({ placeholder: 'Search name or label…', autofocus: true });
      const rows = el('div', { class: 'picker-list' });
      const count = el('div', { class: 'hint', style: 'margin-top:8px' });

      const matching = () => {
        const q = search.value.trim().toLowerCase();
        if (!q) return list;
        return list.filter((c) => (c.name + ' ' + clusterLabels(c)).toLowerCase().includes(q));
      };

      const draw = () => {
        const found = matching();
        clear(rows);
        // Root first whatever the query: it is the way back, not one result
        // among many.
        for (const c of [...found].sort((a, b) => (a.leaf ? 1 : 0) - (b.leaf ? 1 : 0)
            || a.name.localeCompare(b.name))) {
          const current = !!sel && c.name === sel.name;
          const offline = !!c.status && c.status !== 'online';
          const labels = clusterLabels(c);
          rows.append(el('div', {
            class: 'picker-item' + (current ? ' active' : ''),
            style: offline && !current ? 'opacity:.5' : '',
            title: offline ? `This cluster is ${c.status}` : (current ? 'Already the cluster in use' : ''),
            onClick: () => {
              if (current || offline) return;
              close(c.name);
            },
          },
            el('span', { class: 'pname' },
              el('div', { text: c.name }),
              labels ? el('div', { class: 'pmeta', text: labels }) : null),
            el('span', { class: 'tag', text: c.leaf ? 'leaf' : 'root' }),
            offline ? el('span', { class: 'tag warn', text: c.status }) : null,
            current ? el('span', { class: 'tag', text: 'current' }) : null));
        }
        if (!found.length) {
          rows.append(el('div', { class: 'sb-empty', text: 'No cluster matches that.' }));
        }
        count.textContent = `${found.length} of ${list.length} shown`;
      };

      search.addEventListener('input', draw);
      search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        // One match left, and it is somewhere to go: Enter takes it.
        const found = matching().filter((c) => c.name !== sel?.name
          && (!c.status || c.status === 'online'));
        if (found.length === 1) close(found[0].name);
      });

      // `field` with no label: the dialog's own title says what is being
      // picked, and it carries the input styling every other dialog uses.
      body.append(field(null, search), rows, count);
      draw();
    },
    buttons: [{ label: 'Cancel', value: null }],
  }).then((name) => (name ? switchToCluster(p, name) : null));
}

/**
 * Menu items for pointing a profile at one of its clusters.
 *
 * The root is always on the list, not just the leaves: it is where you came
 * from and where you go back to. The one in force is ticked and cannot be
 * picked, and an offline leaf is shown but not offered — `tsh login` against
 * one only fails.
 */
function clusterMenuItems(p) {
  const list = clustersFor(p);
  if (list.length < 2) return [];
  const sel = selectedCluster(p);
  const roots = list.filter((c) => !c.leaf);
  const leaves = list.filter((c) => c.leaf);
  const item = (c) => {
    const current = !!sel && c.name === sel.name;
    const offline = !!c.status && c.status !== 'online';
    const labels = clusterLabels(c);
    return {
      label: c.name,
      // Trusted clusters are often named after the estate they came with —
      // an account id, a region, a customer — and the labels are what say
      // which is which, so they belong in the list and not only in a tooltip.
      sub: labels || null,
      key: current ? '✓' : (offline ? c.status : ''),
      disabled: current || offline,
      title: [
        current
          ? 'Already the cluster in use'
          : offline
            ? `This cluster is ${c.status} — nothing can be issued for it right now`
            : `tsh login --proxy=${p.proxy} ${c.name}`,
        labels,
      ].filter(Boolean).join('\n'),
      onClick: () => switchToCluster(p, c.name),
    };
  };
  return [
    { heading: true, label: roots.length === 1 ? 'Root cluster' : 'Root' },
    ...roots.map(item),
    { heading: true, label: `Leaf cluster${leaves.length === 1 ? '' : 's'}` },
    ...leaves.map(item),
  ];
}

/**
 * Point a profile at another cluster in its trust web.
 *
 * `tsh login <cluster>` against a live certificate re-issues it for the named
 * cluster without another round of authentication, which is what makes this a
 * switch and not a login. The inventory is re-read after: nodes belong to the
 * cluster, so it is now a different list — and leaf nodes are reached by
 * `tsh ssh` rather than OpenSSH, which the main process settles per connection.
 */
export async function switchToCluster(p, name) {
  return switchCluster(p, name);
}

async function switchCluster(p, name, done) {
  if (!name) return;
  status(`Switching to ${name}…`, 0);
  try {
    const r = await window.api.teleport.switchProfile({ proxy: p.proxy, cluster: name, home: p.homeDir });
    if (!r.ok) throw new Error(r.output || 'tsh login failed');
    toast(done || `Now on ${name}`, 'success');
    const { refreshInventory } = await import('./sidebar.js');
    await refreshInventory();
  } catch (e) {
    toast(e.message, 'error');
  } finally { status(''); }
}

/**
 * Make a profile the one plain `tsh` commands use.
 *
 * tsh has no "switch profile" verb: the active profile is simply whichever
 * was logged into last, so making one active means running its login again.
 * Against a certificate that is still valid that costs no authentication —
 * tsh re-issues from what it already holds and moves the pointer — which is
 * why this is offered as a switch rather than a login.
 *
 * The *saved* cluster's details are used where there are any. A bare
 * `tsh login --proxy=…` is not the same command: a cluster reached through an
 * SSO connector, or with a TTL or a tsh home of its own, needs those flags or
 * it fails, or succeeds as somebody else. Falling back to what the live
 * profile already reports keeps it working for a cluster that was never saved.
 */
export async function makeProfileActive(p) {
  const saved = await savedClusterFor(p);

  const name = p.cluster || p.proxy;
  status(`Switching to ${name}…`, 0);
  try {
    const r = await window.api.teleport.switchProfile({
      proxy: p.proxy,
      cluster: p.cluster || saved?.cluster || undefined,
      // From the record only — see doLogin. The profile's username is the
      // account on the certificate, not an instruction to authenticate as it.
      user: saved?.user || undefined,
      authConnector: saved?.authConnector || undefined,
      ttl: saved?.ttl || undefined,
      mfaMode: saved?.mfaMode || undefined,
      home: p.homeDir || saved?.home || undefined,
    });
    if (!r.ok) throw new Error(r.output || 'tsh login failed');
    toast(`${name} is now the active profile`, 'success');
    const { refreshInventory } = await import('./sidebar.js');
    await refreshInventory();
  } catch (e) {
    toast(e.message, 'error');
  } finally { status(''); }
}

function activeProfile() {
  return state.teleportProfiles.find((p) => p.active && !p.expired)
      || state.teleportProfiles.find((p) => !p.expired)
      || state.teleportProfiles[0];
}

export function formatUntil(s) {
  if (!s) return 'unknown';
  const d = new Date(s);
  if (isNaN(d)) return s;
  const mins = Math.round((d - Date.now()) / 60000);
  if (mins < 0) return 'expired';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ${mins % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * True once a cluster has under an hour of certificate left but has not
 * lapsed yet — the window where logging in again is still one command
 * instead of a re-auth that interrupts whatever is running on it. `expired`
 * already has its own tag; this is the warning one command earlier.
 */
export function expiringSoon(p) {
  if (p.expired || !p.validUntil) return false;
  const mins = (new Date(p.validUntil) - Date.now()) / 60000;
  return mins >= 0 && mins < 60;
}

/**
 * Open a cluster in the Teleport web UI.
 *
 * The link is built and opened in the main process — the renderer never holds a
 * URL it can hand to the browser — and it needs no certificate, so this works
 * on an expired profile or a saved cluster that has never been logged in from
 * this app. A saved cluster with no cluster name recorded lands on the proxy's
 * own landing page, which resolves the right one.
 */
export async function openClusterWeb({ proxy, cluster } = {}) {
  try {
    const url = await window.api.teleport.openWebCluster({ proxy, cluster });
    status('Opened in browser: ' + url);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function doSwitch(p) {
  return switchCluster(p, p.cluster, `Active profile: ${p.cluster}`);
}

/**
 * Log in the way this cluster is *saved* to be logged in to, exported so a
 * failed connection to an expired or logged-out cluster can run the same
 * ceremony itself rather than making someone go find this button. Returns
 * whether it worked, which a caller with a session to retry needs to know.
 */
export async function doLogin(p) {
  /*
   * An expired profile knows the proxy and the username on the certificate
   * that has just lapsed; it does not know how that certificate was obtained.
   * Without the saved record this ran a bare `tsh login --proxy=…`, which on
   * a cluster with a named connector picks whatever the default is — and on
   * an SSO cluster that is the local one, so a password prompt appears where
   * a browser should have opened.
   */
  const saved = await savedClusterFor(p);
  /*
   * A terminal is needed wherever tsh asks for something that needs a real
   * foreground process to answer — local auth (a password typed back) and
   * passwordless (a Touch ID or security-key challenge) both qualify; only
   * a named external connector opens a browser and waits on an HTTP
   * callback, which a detached, backgrounded process can do just fine.
   * This used to treat passwordless the same as a named SSO connector —
   * same "no TTY needed" assumption `autoLoginSavedClusters` and the "tsh
   * login" button both made — on the reasoning that a platform
   * authenticator prompt is a native OS dialog, not something read from
   * stdin. It is not that simple: the headless child process this spawns
   * is never the foreground app, and on this machine that leaves the
   * passwordless ceremony unable to actually complete — the prompt starts
   * and nothing answers it. A real terminal tab is a real foreground
   * process, which is what resolved it.
   *
   * `runLoginInShell` itself now waits out the login rather than just the
   * tab opening, so there is a real boolean to return the moment it does —
   * a caller with a connect waiting on this (`ensureLoggedIn`) resumes it
   * the instant the person finishes typing a password or tapping a key,
   * instead of failing that attempt and making them start over by hand.
   */
  if (saved?.user
      && (!saved?.authConnector || saved.authConnector === 'local' || saved.authConnector === 'passwordless')) {
    return runLoginInShell({ ...saved, proxy: p.proxy, cluster: p.cluster || saved.cluster, home: p.homeDir },
      { title: `tsh login · ${p.cluster || p.proxy}` });
  }
  status(`Logging in to ${p.proxy}… (a browser window may open)`, 0, 'login');
  try {
    const r = await window.api.teleport.login({
      proxy: p.proxy,
      cluster: p.cluster || saved?.cluster || undefined,
      home: p.homeDir,
      // Only from the record. The profile's own username is the Teleport
      // account the old certificate named, and passing it as --user is what
      // sends tsh down the local-auth path instead of the connector's.
      user: saved?.user || undefined,
      authConnector: saved?.authConnector || undefined,
      ttl: saved?.ttl || undefined,
      mfaMode: saved?.mfaMode || undefined,
    });
    if (!r.ok) throw new Error(versionNote(r)?.text || 'tsh login failed — try running it in a terminal');
    toast('Logged in', 'success');
    toastVersionNote(r);
    deliberateLogouts.delete(logoutKey(p.proxy, p.homeDir));
    const { refreshInventory } = await import('./sidebar.js');
    await refreshInventory();
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  } finally { status('', 0, 'login'); }
}


/**
 * Log out of one cluster. `tsh logout --proxy=` drops that certificate only,
 * leaving every other profile — in this home or another — alone.
 */
export async function doLogout(p) {
  const where = p.cluster || p.proxy;
  const saved = await window.api.teleport.savedLogins().catch(() => []);
  const alreadySaved = saved.some((t) => t.proxy === p.proxy && (t.home || '') === (p.home || ''));
  // Logging out removes the cluster from every list, proxy address included,
  // so this is the moment to keep it — offered, not done silently.
  const remember = checkbox('Keep this cluster so I can log back in', !alreadySaved);

  const ok = await modal({
    title: 'Log out of ' + where,
    render: (body) => {
      body.append(
        el('div', { style: 'font-size:13px;margin-bottom:6px', text: `Delete the certificate for ${where}?` }),
        el('div', { class: 'hint', style: 'white-space:pre-wrap', text: [
          p.homeName ? `Home: ${p.homeDir}` : null,
          p.username ? `Logged in as ${p.username}` : null,
          'Sessions already open may stop working, and listing this cluster needs a fresh tsh login.',
        ].filter(Boolean).join('\n') }),
        el('div', { style: 'margin-top:10px' }, alreadySaved
          ? el('div', { class: 'hint', text: 'This cluster is already saved for re-login.' })
          : remember));
    },
    buttons: [
      { label: 'Cancel', value: false, autofocus: true },
      { label: 'Log out', class: 'ghost-btn danger-btn', value: true },
    ],
  });
  if (ok !== true) return;

  if (!alreadySaved && remember.input.checked) {
    await saveClusterLogin({
      name: where,
      proxy: p.proxy,
      cluster: p.cluster,
      user: p.username,
      home: p.home || '',
    }).catch(() => {});
  }

  status(`Logging out of ${where}…`, 0);
  try {
    const r = await window.api.teleport.logout({ proxy: p.proxy, home: p.homeDir });
    if (!r.ok) throw new Error(firstLine(r.output) || 'tsh logout failed');
    toast(`Logged out of ${where}`, 'success');
    deliberateLogouts.add(logoutKey(p.proxy, p.homeDir));
    // The profile is about to drop out of the list entirely, which is the
    // one case orphanGhosts otherwise waits several minutes to agree with —
    // this is not a read that failed, it is the person saying so directly.
    await noteLoggedOut(groupKeyFor(p)).catch(() => {});
    const { refreshInventory } = await import('./sidebar.js');
    await refreshInventory();
  } catch (e) {
    toast(e.message, 'error');
  } finally { status(''); }
}

/**
 * The ⏳ "expires soon" badge's own click: log out and straight back in,
 * one confirmation instead of Logout's dialog followed by hunting for
 * Login. Saves the cluster first if it is not already — `doLogin` right
 * after reads that record to log back in the way this cluster actually
 * authenticates (SSO, not local), the same thing Logout's own "keep this
 * cluster" checkbox is for.
 */
export async function doRelogin(p) {
  const where = p.cluster || p.proxy;
  const ok = await confirm({
    title: `Log back in to ${where}?`,
    message: `Its certificate expires in ${formatUntil(p.validUntil)}.`,
    detail: 'Logs out now and straight back in, the same way this cluster is logged into today — '
      + 'a fresh certificate before the old one lapses, rather than waiting for it to and having that '
      + 'interrupt whatever is running on it.',
    confirmLabel: 'Log out and back in',
  });
  if (!ok) return;

  const saved = await window.api.teleport.savedLogins().catch(() => []);
  const alreadySaved = saved.some((t) => t.proxy === p.proxy && (t.home || '') === (p.home || ''));
  if (!alreadySaved) {
    await saveClusterLogin({
      name: where, proxy: p.proxy, cluster: p.cluster, user: p.username, home: p.home || '',
    }).catch(() => {});
  }

  status(`Logging out of ${where}…`, 0);
  try {
    const r = await window.api.teleport.logout({ proxy: p.proxy, home: p.homeDir });
    if (!r.ok) throw new Error(firstLine(r.output) || 'tsh logout failed');
  } catch (e) {
    toast(e.message, 'error');
    status('');
    return;
  }
  await doLogin(p);
}

export async function openLoginDialog(prefill = {}) {
  const proxyIn = textInput({ value: prefill.proxy || '', placeholder: 'teleport.example.com:443', autofocus: true });
  const userIn = textInput({ value: prefill.user || '', placeholder: 'optional - defaults to your local user' });
  const clusterIn = textInput({ value: prefill.cluster || '', placeholder: 'optional - root cluster by default' });

  // `tsh login --auth=` takes a connector name, so the list is a starting
  // point rather than a closed set; the field stays free-text.
  const authIn = textInput({ value: prefill.auth || '', placeholder: 'optional - e.g. local, github, okta, saml' });
  const authList = el('datalist', { id: 'auth-connectors' });
  for (const v of ['local', 'passwordless', 'github', 'okta', 'saml', 'oidc', 'headless', 'ad']) {
    authList.append(el('option', { value: v }));
  }
  authIn.setAttribute('list', 'auth-connectors');

  // Prefilled when editing: a saved TTL or flags left out here were lost on Save.
  /*
   * How to log in, as a list the proxy itself provides: its SSO providers by
   * name, local users, passwordless, headless — or another connector typed in.
   * Read when the proxy is known; until then, and if it cannot be reached,
   * the free-text connector box is all there is, as before.
   */
  const methodSel = el('select', {});
  const methodNote = el('div', { class: 'hint' });
  let methods = null;
  const fillMethods = async () => {
    const proxy = proxyAddress(proxyIn.value);
    if (!proxy) return;
    methodNote.textContent = 'Asking the proxy how it can be logged into…';
    methods = await window.api.teleport.loginMethods(proxy).catch(() => null);
    if (!methods?.ok) {
      methodNote.textContent = 'Could not ask the proxy — type the connector name instead.';
      methodSel.replaceChildren(el('option', { value: '__other', text: 'Connector name…' }));
      methodSel.value = '__other';
      syncMethod();
      return;
    }
    const def = methods.defaultConnector || methods.authType || 'local';
    const opts = [['', `The cluster's default (${def})`]];
    for (const p2 of methods.providers) opts.push([p2.name, `${p2.display} — SSO (${p2.type})`]);
    if (methods.local) opts.push(['local', 'Username and password']);
    if (methods.passwordless) opts.push(['passwordless', 'Passwordless (security key or Touch ID)']);
    opts.push(['headless', 'Headless (approve from another device)']);
    opts.push(['__other', 'Other connector…']);
    methodSel.replaceChildren(...opts.map(([v, t]) => el('option', { value: v, text: t })));
    const want = authIn.value.trim();
    methodSel.value = opts.some(([v]) => v === want) ? want : (want ? '__other' : '');
    methodNote.textContent = `Second factors this cluster allows: ${(methods.secondFactors || []).join(', ') || 'none listed'}.`;
    syncMethod();
  };
  const syncMethod = () => {
    const other = methodSel.value === '__other';
    authIn.closest('.field')?.classList.toggle('hidden', !other);
    if (!other) authIn.value = methodSel.value;
    syncPreview?.();
  };
  methodSel.addEventListener('change', syncMethod);

  const ttlIn = textInput({ type: 'number', value: prefill.ttl || '', placeholder: 'optional - minutes' });
  const mfaSel = select([
    { value: '', label: 'Automatic' },
    { value: 'platform', label: 'Platform (Touch ID / Windows Hello)' },
    { value: 'cross-platform', label: 'Cross-platform (security key)' },
    { value: 'otp', label: 'OTP code' },
    { value: 'sso', label: 'SSO' },
  ], prefill.mfaMode || '');
  const extraIn = textInput({ value: (prefill.extraArgs || []).join(' '), placeholder: '--insecure --browser=none' });

  // Keeping the cluster is what makes the next login a click rather than a
  // remembered hostname — on by default when opened from a saved record.
  const rememberIn = checkbox('Keep this cluster for logging in again', prefill.remember !== false);
  /*
   * Log in on launch. Off unless asked for: a login can open a browser and can
   * ask for a hardware key, and a launch that does that unbidden — to several
   * clusters at once — is worse than clicking one button.
   */
  const autoIn = checkbox('Log in automatically when the app starts', !!prefill.autoLogin);
  // Without it a logout takes the cluster off the Hosts tab with its profile.
  const showIn = checkbox('Pin to the Hosts tab — keep it listed even when tsh status does not',
    !!prefill.showInHosts);
  const syncAuto = () => {
    for (const box of [autoIn, showIn]) {
      box.style.opacity = rememberIn.input.checked ? '' : '.5';
      box.input.disabled = !rememberIn.input.checked;
      if (!rememberIn.input.checked) box.input.checked = false;
    }
  };
  rememberIn.input.addEventListener('change', syncAuto);

  /*
   * Which tsh home to log into. With one home there is nothing to ask; with
   * several, logging into the wrong one writes a certificate that the cluster
   * you meant will never be read from.
   */
  const configuredHomes = state.settings.tshHomes || [];
  const homeSel = configuredHomes.length
    ? select([
        { value: '', label: `Default (${state.appInfo.tshHome || '~/.tsh'})` },
        ...configuredHomes.map((h) => ({ value: h, label: h })),
      ], prefill.home || '')
    : null;

  const preview = el('div', {
    style: 'font-family:var(--mono);font-size:11px;color:var(--text-dim);background:var(--panel-2);'
      + 'border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;word-break:break-all',
  });

  /*
   * The address people have to hand is the one in their browser's bar, so it
   * arrives as `https://example.teleport.sh/web`. tsh wants the host and port
   * and nothing else — and a profile saved with a scheme on the front is a
   * profile that nothing else in the app matches — so the field is tidied as
   * soon as it loses focus, where it can be seen, rather than silently at the
   * point of use.
   */
  proxyIn.addEventListener('blur', () => {
    const clean = proxyAddress(proxyIn.value);
    if (clean !== proxyIn.value) { proxyIn.value = clean; syncPreview(); }
    fillMethods();
  });

  const collectLogin = () => ({
    remember: rememberIn.input.checked,
    savedId: prefill.id || undefined,
    proxy: proxyAddress(proxyIn.value),
    user: userIn.value.trim() || undefined,
    authConnector: authIn.value.trim() || undefined,
    cluster: clusterIn.value.trim() || undefined,
    ttl: ttlIn.value.trim() || undefined,
    mfaMode: mfaSel.value || undefined,
    home: homeSel?.value || undefined,
    extraArgs: extraIn.value.trim() ? extraIn.value.trim().split(/\s+/) : undefined,
  });

  // The command is built in the main process, so what is previewed, copied and
  // run are the same string — quoting and TELEPORT_HOME included.
  let command = 'tsh login';
  const syncPreview = async () => {
    command = await window.api.teleport.loginCommand(collectLogin());
    preview.textContent = command;
  };
  for (const f of [proxyIn, userIn, authIn, clusterIn, ttlIn, extraIn]) f.addEventListener('input', syncPreview);
  mfaSel.addEventListener('change', syncPreview);
  homeSel?.addEventListener('change', syncPreview);

  /** The saved-cluster record these fields describe. */
  const collectRecord = () => {
    const v = collectLogin();
    return {
      id: prefill.id,
      name: v.cluster || v.proxy,
      proxy: v.proxy,
      cluster: v.cluster || '',
      user: v.user || '',
      authConnector: v.authConnector || '',
      home: v.home || '',
      ttl: v.ttl || '',
      mfaMode: v.mfaMode || '',
      autoLogin: autoIn.input.checked,
      showInHosts: showIn.input.checked,
    };
  };

  const res = await modal({
    title: 'tsh login',
    subtitle: 'Opens your browser for SSO when the connector requires it',
    width: 'min(620px, 94vw)',
    render: (body) => {
      // Anything conditional is filtered out first: append() stringifies a null
      // into the text "null", where el() would have dropped it.
      body.append(...[
        field('Proxy address', proxyIn, 'Host and port of the Teleport proxy'),
        field('How to log in', methodSel, 'Read from the proxy'),
        methodNote,
        el('div', { class: 'field-row' },
          field('User (optional)', userIn),
          field('Connector name', authIn)),
        authList,
        el('div', { class: 'field-row' },
          field('Cluster (optional)', clusterIn),
          field('TTL minutes (optional)', ttlIn)),
        field('MFA mode', mfaSel),
        homeSel ? field('tsh home', homeSel, 'Where the certificate is written. Every command for this cluster will use it.') : null,
        field('Additional flags (optional)', extraIn, 'Passed to tsh as-is'),
        rememberIn,
        autoIn,
        showIn,
        el('div', { style: 'height:10px' }),
        el('label', { style: 'font-size:11px;color:var(--muted);margin-bottom:4px;display:block', text: 'Command' }),
        preview,
      ].filter(Boolean));
      syncPreview();
      syncAuto();
      // Until the proxy answers, the connector box is the way to say it.
      methodSel.append(el('option', { value: '__other', text: 'Connector name\u2026' }));
      methodSel.value = '__other';
      fillMethods();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Copy login cmd',
        onClick: () => {
          window.api.clipboard.write(command);
          status('Copied — paste it into a terminal', 8000);
        },
      },
      /*
       * Save without logging in.
       *
       * Editing a kept cluster — correcting a proxy address, switching the
       * connector, pinning a tsh home — is not the same act as logging in, and
       * before this the only way to keep the change was to run a login you may
       * not have wanted (or been able) to run right then.
       */
      {
        label: prefill.id ? 'Save' : 'Save without logging in',
        title: 'Keep these details for later. No tsh command is run.',
        onClick: async ({ close }) => {
          if (!proxyAddress(proxyIn.value)) return toast('Proxy address is required', 'error');
          try {
            await saveClusterLogin(collectRecord());
            close(null);
            const panel = document.querySelector('#sb-panel-teleport');
            if (panel) renderTeleportTab(panel);
          } catch (e) { toast(e.message, 'error'); }
        },
      },
      {
        label: 'Login', class: 'primary-btn',
        onClick: ({ close }) => {
          if (!proxyAddress(proxyIn.value)) return toast('Proxy address is required', 'error');
          close(collectLogin());
        },
      },
    ],
  });
  if (!res) return;

  // Keep the cluster either way: a proxy typed once should not have to be
  // typed again, whichever route the login takes.
  if (res.remember) await saveClusterLogin(collectRecord()).catch(() => {});

  /*
   * A named user means a prompt, and a prompt needs a terminal.
   */
  if (res.user) {
    await runLoginInShell(res);
    return;
  }

  status('Running tsh login - check your browser if SSO is configured...', 0);
  try {
    const r = await window.api.teleport.login(res);   // `res` carries its home
    if (!r.ok) {
      throw new Error(versionNote(r)?.text || firstLine(r.output) || 'Login failed. Check the proxy address, or run the command in a terminal.');
    }
    toast('Logged in to ' + res.proxy, 'success');
    toastVersionNote(r);
    const { refreshInventory } = await import('./sidebar.js');
    await refreshInventory();
  } catch (e) { toast(e.message, 'error'); }
  finally { status(''); }
}

/**
 * Resources a request names, by the name a human would use.
 *
 * The request itself only carries ids, and for a server that id is a UUID, so
 * the main process resolves it through `tsh request search` and hands back a
 * `label`. The raw id stays in the tooltip: it is what was actually requested.
 */
function resourceLine(resources) {
  const line = el('div', {}, el('span', { text: 'resources: ' }));
  const shown = resources.slice(0, 6);
  shown.forEach((r, i) => {
    const name = r.label || r.name;
    line.append(el('span', {
      title: r.label ? `${r.kind}/${r.name}` : r.id,
      style: r.label ? 'border-bottom:1px dotted var(--border)' : '',
      text: `${r.kind}/${name}${r.sub ? '/' + r.sub : ''}`,
    }));
    if (i < shown.length - 1) line.append(el('span', { text: ', ' }));
  });
  if (resources.length > shown.length) {
    line.append(el('span', { text: ` +${resources.length - shown.length}` }));
  }
  return line;
}

/** tsh errors are verbose; the first meaningful line is usually the point. */
function firstLine(text) {
  if (!text) return null;
  const line = String(text).split('\n').map((l) => l.trim())
    .find((l) => l && !/^usage/i.test(l));
  // eslint-disable-next-line no-control-regex
  return line ? line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 200) : null;
}

/* ------------------------------------------------------------------ */
/* Access requests                                                     */
/* ------------------------------------------------------------------ */

export async function openRequestsDialog(profile) {
  const p = profile || activeProfile();
  if (!p) return toast('No Teleport profile', 'error');

  let body = null;

  const load = async () => {
    if (!body) return;
    clear(body);
    body.append(el('div', { class: 'sb-empty', text: 'Loading requests…' }));
    let res;
    try {
      res = await window.api.teleport.requests({ proxy: p.proxy, home: p.homeDir });
    } catch (e) {
      clear(body);
      body.append(el('div', { class: 'sb-empty', style: 'color:var(--red)', text: e.message }));
      return;
    }
    clear(body);

    if (!res.ok) {
      body.append(el('div', { class: 'sb-empty', style: 'color:var(--red)', text: res.error || 'Could not list requests' }));
      return;
    }

    const assumed = new Set(p.activeRequests || []);
    if (assumed.size) {
      body.append(el('div', { style: 'margin-bottom:11px;font-size:11.5px;color:var(--accent)' },
        `Currently assumed: ${[...assumed].join(', ')}`,
        el('button', {
          class: 'ghost-btn sm', style: 'margin-left:9px',
          text: 'Drop all',
          onClick: async () => {
            if (!await confirm({
              title: 'Drop assumed roles',
              message: 'Drop all assumed access requests?',
              detail: 'Your certificate is reissued without the extra roles.',
              confirmLabel: 'Drop', danger: true,
            })) return;
            status('Dropping…', 0);
            const r = await window.api.teleport.requestDrop([...assumed], { proxy: p.proxy, home: p.homeDir });
            status('');
            r.ok ? toast('Dropped', 'success') : toast(r.output || 'Drop failed', 'error');
            const { refreshInventory } = await import('./sidebar.js');
            await refreshInventory();
            load();
          },
        })));
    }

    if (!res.requests.length) {
      body.append(el('div', { class: 'sb-empty' },
        el('div', { text: 'No access requests on this cluster.' }),
        el('div', { style: 'margin-top:6px;opacity:.75', text: 'Create one below to request extra roles.' })));
    }

    for (const r of res.requests) {
      const isAssumed = assumed.has(r.id);
      const card = el('div', { class: 'req-card' });
      card.append(el('div', { class: 'req-head' },
        el('span', { class: 'req-state ' + (isAssumed ? 'APPLIED' : r.state), text: isAssumed ? 'ASSUMED' : r.state }),
        el('span', { style: 'font-family:var(--mono);font-size:11px;color:var(--muted)', text: r.id })));

      card.append(el('div', { class: 'req-meta' },
        r.roles.length ? el('div', { text: 'roles: ' + r.roles.join(', ') }) : null,
        r.resources.length ? resourceLine(r.resources) : null,
        r.reason ? el('div', { text: 'reason: ' + r.reason }) : null,
        r.reviewers?.length ? el('div', { text: 'suggested reviewers: ' + r.reviewers.join(', ') }) : null,
        r.assumeStartTime ? el('div', { text: 'takes effect: ' + formatWhen(r.assumeStartTime) }) : null,
        r.expires ? el('div', { text: 'request expires: ' + formatWhen(r.expires) }) : null,
        r.maxDuration ? el('div', { text: 'access until: ' + formatWhen(r.maxDuration) }) : null,
        r.sessionTtl ? el('div', { text: 'session expires: ' + formatWhen(r.sessionTtl) }) : null));

      const actions = el('div', { class: 'req-actions' });
      if (r.state === 'APPROVED' && !isAssumed) {
        actions.append(el('button', {
          class: 'primary-btn', text: 'Assume roles',
          onClick: async () => {
            status('Assuming request…', 0);
            const out = await window.api.teleport.requestAssume(r.id, { proxy: p.proxy, home: p.homeDir });
            status('');
            if (out.ok) {
              toast('Roles assumed', 'success');
              const { refreshInventory } = await import('./sidebar.js');
              await refreshInventory();
              load();
            } else toast(out.output || 'Assume failed', 'error');
          },
        }));
      }
      if (isAssumed) {
        actions.append(el('button', {
          class: 'ghost-btn danger-btn', text: 'Drop',
          onClick: async () => {
            status('Dropping…', 0);
            const out = await window.api.teleport.requestDrop([r.id], { proxy: p.proxy, home: p.homeDir });
            status('');
            out.ok ? toast('Dropped', 'success') : toast(out.output || 'Drop failed', 'error');
            const { refreshInventory } = await import('./sidebar.js');
            await refreshInventory();
            load();
          },
        }));
      }
      actions.append(el('button', {
        class: 'ghost-btn', text: 'Copy to new request',
        title: 'Open a new request with the same resources, roles and reason',
        onClick: () => openCreateRequest(p, asPrefill(r, p)).then(load),
      }));
      actions.append(el('button', {
        class: 'ghost-btn', text: 'Save as reusable…',
        title: 'Keep these resources, roles and reason to raise again later',
        onClick: () => saveExistingRequest(p, r),
      }));
      actions.append(el('button', {
        class: 'ghost-btn', text: 'Details',
        onClick: async () => {
          const d = await window.api.teleport.requestShow(r.id, { proxy: p.proxy, home: p.homeDir });
          modal({
            title: 'Request ' + r.id,
            width: 'min(760px,94vw)',
            render: (b) => b.append(el('pre', {
              style: 'font-family:var(--mono);font-size:11px;white-space:pre-wrap;margin:0',
              text: d.text || '(no details)',
            })),
            buttons: [{ label: 'Close', value: null }],
          });
        },
      }));
      card.append(actions);
      body.append(card);
    }
  };

  await modal({
    title: 'Access requests',
    subtitle: p.cluster || p.proxy,
    width: 'min(740px, 94vw)',
    render: (b) => { body = b; load(); },
    buttons: [
      { label: 'New request…', onClick: () => openCreateRequest(p).then(load) },
      {
        label: 'Saved…',
        onClick: async () => {
          const t = await openSavedRequests(p);
          if (t) await openCreateRequest(p, t).then(load);
        },
      },
      { label: 'Refresh', onClick: () => load() },
      { label: 'Close', value: null },
    ],
  });
}

/**
 * Build and raise an access request.
 *
 * Resources are chosen from `tsh request search`, never typed: their ids are
 * UUIDs for servers, and the whole point of a request is a machine you cannot
 * see yet, so there is nowhere to copy one from. The chosen set, the roles and
 * the reason can be saved against the cluster and raised again later.
 */
/**
 * Start a request with something already chosen.
 *
 * Exported so a host row can offer it: a node that has stopped being
 * reachable and started being requestable is one double-click away from the
 * only thing worth doing about it, rather than a trip through a dialog to
 * re-find the machine already under the pointer.
 */
export function requestAccessTo(profile, resource) {
  return openCreateRequest(profile, {
    resources: [resource].filter(Boolean),
    reason: '',
  });
}

/**
 * The same thing, for several resources in one request — a Hosts-pane
 * multi-select's "Request access to N nodes…", where `requestAccessTo`
 * would otherwise mean opening the dialog once per node.
 */
export function requestAccessToMany(profile, resources) {
  return openCreateRequest(profile, { resources: resources.filter(Boolean), reason: '' });
}

/** Has this cluster already refused a request for want of a reason? */
function reasonNeeded(p) {
  const map = state.settings.reasonRequired || {};
  return !!map[p.proxy || p.cluster || ''];
}

async function rememberReasonRequired(p) {
  const map = { ...(state.settings.reasonRequired || {}) };
  map[p.proxy || p.cluster || ''] = true;
  state.settings = await window.api.settings.set({ reasonRequired: map });
}

async function openCreateRequest(p, prefill = {}) {
  let roles = [...(prefill.roles || [])];
  let resources = [...(prefill.resources || [])];
  let templateId = prefill.id || null;
  const reasonIn = textInput({
    placeholder: reasonNeeded(p) ? 'Required by this cluster' : 'Why you need access',
    value: prefill.reason || '',
  });
  /*
   * The cluster's own prompt, when it has one. A role can set
   * `request_prompt` — "Include a ticket or case reference" — and that
   * sentence is the only part of this dialog written by the people who
   * will review the request.
   */
  const promptBox = el('div', { class: 'req-prompt' });
  if (reasonNeeded(p)) reasonIn.classList.add('needed');
  reasonIn.addEventListener('input', () => {
    if (reasonIn.value.trim()) reasonIn.classList.remove('needed');
    else if (reasonNeeded(p)) reasonIn.classList.add('needed');
  });
  const reviewersIn = textInput({
    placeholder: 'optional — alice,bob',
    value: (prefill.reviewers || []).join(','),
  });

  // Teleport defaults to access taking effect immediately, so the field starts
  // at "now" and the flag is only sent once it has been moved into the future —
  // a start time in the past is either meaningless or rejected.
  const startIn = el('input', { type: 'datetime-local', class: 'rq-when' });
  startIn.value = prefill.assumeStartTime ? toLocalInput(prefill.assumeStartTime) : toLocalInput(Date.now());

  const ttlListId = `rq-ttl-list-${++ttlListSeq}`;
  const requestTtlIn = durationInput(ttlListId, prefill.requestTtl);
  const maxDurationIn = durationInput(ttlListId, prefill.maxDuration);
  const sessionTtlIn = durationInput(ttlListId, prefill.sessionTtl);

  let rolesBox = null;
  let resBox = null;
  let previewEl = null;

  /*
   * Every role this cluster would let you ask for, as something to switch
   * on and off here.
   *
   * It used to show only the ones already chosen, behind a Choose… dialog —
   * so a resource request said "No roles — resources only" and gave no way
   * to see what the alternatives even were, let alone pick among them at
   * the moment of asking. The list is small on most clusters and is the
   * thing a reviewer will ask about, so it belongs in front of you while
   * you are writing the reason.
   */
  let offered = null;          // null until the cluster has answered
  const loadOfferedRoles = async () => {
    try {
      const r = await window.api.teleport.requestRoles({ proxy: p.proxy, home: p.homeDir });
      offered = r?.ok ? (r.roles || []) : [];
    } catch { offered = []; }
    const [history, mine] = [await rolesFromHistory(), rolesRemembered()];
    offered = [...new Set([...(offered || []), ...history, ...mine])];
    // What you used last time for these resources starts ticked: it is the
    // best guess available, and it is yours.
    if (!roles.length) roles = [...new Set([...history, ...mine])];
    renderRoles();
    askTheCluster();
  };

  /**
   * Put the request to the cluster before anybody types anything.
   *
   * A request that cannot succeed — it carries a role no cluster can have —
   * so nothing is created, and the refusal says what a real one would need:
   * which role the resources would be granted through, whether a reason is
   * required, and the cluster's own words for why. Teleport Connect shows
   * all three because it embeds the API; this is the same answer, read out
   * of the only thing that will tell us.
   */
  /**
   * Which roles these resources have been granted through before.
   *
   * Your own request history says so plainly — a past request carries both
   * its resource ids and the roles it was raised with — and reading it
   * costs nothing and risks nothing. It is the only source that can name
   * the full set: the cluster will not enumerate the roles that apply to a
   * resource, and the one way to make it say them is to raise a request,
   * which is not a thing a dialog may do to find out what to put in a
   * dialog.
   */
  const rolesFromHistory = async () => {
    const ids = new Set(resources.map((r) => r.id));
    if (!ids.size) return [];
    try {
      const r = await window.api.teleport.requests({ proxy: p.proxy, home: p.homeDir, resolveNames: false });
      return await window.api.teleport.rolesForResources(r?.requests || [], [...ids]);
    } catch { return []; }
  };

  /** Roles tied to one of these resources by hand, in a previous request. */
  const rolesRemembered = () => {
    const map = state.settings.resourceRoles || {};
    const out = new Set();
    for (const r of resources) for (const role of map[r.id] || []) out.add(role);
    return [...out];
  };

  const rememberRolesForResources = async (list) => {
    const map = { ...(state.settings.resourceRoles || {}) };
    for (const r of resources) {
      if (list.length) map[r.id] = [...list];
      else delete map[r.id];
    }
    state.settings = await window.api.settings.set({ resourceRoles: map });
  };

  /**
   * Every role name worth offering, and where each came from.
   *
   * No single source is complete, so they are pooled: the roles these
   * resources were granted through before, the ones you hold on this
   * cluster today, anything this cluster lists as requestable, and whatever
   * you have tied to a resource yourself. Typing is still possible at the
   * bottom for a name none of them knows, but it is the last resort rather
   * than the only way — a role typed from memory is a request that fails on
   * a typo.
   */
  const roleCandidates = async () => {
    const seen = new Map();   // name -> where it came from
    const add = (name, from) => {
      if (!name) return;
      if (!seen.has(name)) seen.set(name, from);
    };
    for (const r of await rolesFromHistory()) add(r, 'used before');
    for (const r of rolesRemembered()) add(r, 'you chose it');
    for (const r of offered || []) add(r, 'offered');
    const profile = (state.teleportProfiles || []).find((x) => x.proxy === p.proxy
      && (x.homeDir || null) === (p.homeDir || null));
    for (const r of profile?.roles || []) add(r, 'you hold it');
    const described = new Map();
    try {
      const rr = await window.api.teleport.requestRoles({ proxy: p.proxy, home: p.homeDir });
      for (const r of (rr?.details || []) || []) {
        add(r.name, 'requestable');
        if (r.description) described.set(r.name, r.description);
      }
      for (const r of (rr?.ok ? rr.roles : []) || []) add(r, 'requestable');
    } catch { /* no requestable roles: only the ones held are offered */ }
    return [...seen.entries()].map(([name, from]) => ({ name, from, description: described.get(name) || '' }));
  };

  const openRolePicker = async (e) => {
    const x = e.clientX;
    const y = e.clientY;
    const list = await roleCandidates();
    const chosen = new Set(roles);
    contextMenu(x, y, [
      { heading: true, label: 'Roles for this request' },
      ...list.map((r) => ({
        label: r.name,
        key: chosen.has(r.name) ? '\u2713' : r.from,
        // The cluster's own description, which is what makes a role
        // pickable by someone who did not write its RBAC.
        title: r.description || `Add ${r.name} to this request`,
        onClick: () => {
          roles = chosen.has(r.name) ? roles.filter((v) => v !== r.name) : [...roles, r.name];
          offered = [...new Set([...(offered || []), r.name])];
          rememberRolesForResources(roles);
          renderRoles();
        },
      })),
      list.length ? { sep: true } : null,
      {
        label: 'Another name\u2026',
        title: 'For a role none of the lists above knows about',
        onClick: async () => {
          const v = await prompt({
            title: 'Role to request',
            label: 'Its name, exactly as the cluster spells it',
            confirmLabel: 'Add',
          });
          if (!v) return;
          offered = [...new Set([...(offered || []), v.trim()])];
          roles = [...new Set([...roles, v.trim()])];
          rememberRolesForResources(roles);
          renderRoles();
        },
      },
    ].filter(Boolean));
  };

  const askTheCluster = async () => {
    if (!resources.length) return;
    try {
      const r = await window.api.teleport.probeRequest({
        proxy: p.proxy,
        home: p.homeDir,
        resources: resources.map((x) => x.id),
      });
      if (!r?.ok) return;
      if (r.roles?.length) {
        offered = [...new Set([...(offered || []), ...r.roles])];
        // Named by the cluster as the role these resources come through, so
        // it starts included: taking it out is a deliberate act, and
        // leaving the list empty is what most requests want anyway.
        roles = [...new Set([...roles, ...r.roles])];
        renderRoles();
      }
      if (r.reasonRequired) {
        await rememberReasonRequired(p);
        reasonIn.classList.add('needed');
        reasonIn.placeholder = 'Required by this cluster';
      }
      if (r.prompt) {
        clear(promptBox);
        promptBox.append(el('span', { class: 'hint', text: r.prompt }));
      }
    } catch { /* the dialog still works without it */ }
  };

  const roleChip = (role, on) => el('span', {
    class: 'chip role-pick' + (on ? ' on' : ''),
    title: on ? 'Included — click to leave it out' : 'Click to include this role',
    onClick: () => {
      roles = on ? roles.filter((r) => r !== role) : [...roles, role];
      rememberRolesForResources(roles);
      renderRoles();
    },
  }, el('span', { class: 'v', text: role }));

  const renderRoles = () => {
    if (!rolesBox) return;
    clear(rolesBox);
    const chosen = new Set(roles);
    const list = offered === null ? roles : [...new Set([...offered, ...roles])].sort();

    if (!list.length) {
      rolesBox.append(el('span', { class: 'hint', text: offered === null
        ? 'Asking the cluster which roles you may request…'
        : 'No roles to request here — resources only.' }));
      syncPreview();
      return;
    }
    for (const role of list) rolesBox.append(roleChip(role, chosen.has(role)));
    /*
     * And a way to add one that is not up there yet — from a list, because
     * a role name typed from memory is a request that fails on a typo.
     *
     * Needed at all because Teleport has no answer to "which roles would
     * grant me this resource" short of raising the request: there is no dry
     * run, `request search` does not carry roles, and `request search
     * --roles` lists role requests rather than the search_as_roles a
     * resource request uses.
     */
    rolesBox.append(el('button', {
      class: 'ghost-btn sm role-more', text: '+ role',
      title: 'Add a role to this request from the ones this cluster knows about',
      onClick: (e) => openRolePicker(e),
    }));
    rolesBox.append(el('span', {
      class: 'hint', style: 'flex-basis:100%;margin-top:3px',
      text: roles.length
        ? `${roles.length} of ${list.length} included — the rest are left out of this request.`
        : 'None included: this asks for the resources alone, which is what most requests want.',
    }));
    syncPreview();
  };

  const renderResources = () => {
    if (!resBox) return;
    clear(resBox);
    if (!resources.length) {
      resBox.append(el('span', { class: 'hint', text: 'Nothing selected — use Browse…' }));
      return;
    }
    for (const r of resources) {
      resBox.append(el('span', { class: 'chip on', title: r.id },
        el('span', { class: 'k', text: r.kind }),
        el('span', { class: 'v', text: r.name || r.id }),
        el('button', {
          class: 'chip-x', title: 'Remove', text: '×',
          onClick: () => { resources = resources.filter((x) => x.id !== r.id); renderResources(); },
        })));
    }
    syncPreview();
  };

  const collect = () => ({
    roles,
    resources,
    reason: reasonIn.value.trim(),
    // Suggested, not required: Teleport still routes by its own review rules.
    reviewers: reviewersIn.value.split(',').map((s) => s.trim()).filter(Boolean),
    requestTtl: requestTtlIn.value.trim(),
    maxDuration: maxDurationIn.value.trim(),
    sessionTtl: sessionTtlIn.value.trim(),
    // Anything at or before now is the default anyway, so leave the flag off.
    assumeStartTime: futureIso(startIn.value),
  });

  /** The exact command about to run, so it can be read and copied. */
  const previewArgs = async () => {
    const cur = collect();
    return window.api.teleport.requestPreview({
      proxy: p.proxy,
      home: p.homeDir,
      roles: cur.roles,
      resources: cur.resources.map((r) => r.id),
      reason: cur.reason,
      reviewers: cur.reviewers,
      requestTtl: cur.requestTtl,
      sessionTtl: cur.sessionTtl,
      maxDuration: cur.maxDuration,
      assumeStartTime: cur.assumeStartTime,
    });
  };

  // The command is there to be checked, not read constantly, so it is only
  // rendered while the disclosure is actually open. Copy always rebuilds it.
  const syncPreview = async () => {
    if (!previewEl || !previewEl.closest('details')?.open) return;
    const args = await previewArgs();
    previewEl.textContent = args.map(shellQuote).join(' ');
  };

  const res = await modal({
    title: 'New access request',
    subtitle: p.cluster || p.proxy,
    width: 'min(680px, 94vw)',
    render: (body) => {
      // The cluster's answer fills the role chips in when it arrives.
      loadOfferedRoles();
      rolesBox = el('div', { class: 'rq-chosen' });
      resBox = el('div', { class: 'rq-chosen' });

      body.append(
        el('div', { class: 'rq-field' },
          el('div', { class: 'rq-field-head' },
            el('label', { text: 'Roles' }),
            el('button', {
              class: 'ghost-btn sm', text: 'Choose…',
              onClick: async () => {
                const picked = await pickRequestRoles(p, roles);
                if (picked) { roles = picked; renderRoles(); }
              },
            })),
          rolesBox),
        el('div', { class: 'rq-field' },
          el('div', { class: 'rq-field-head' },
            el('label', { text: 'Resources' }),
            el('button', {
              class: 'ghost-btn sm', text: 'Browse…',
              onClick: async () => {
                const picked = await pickRequestResources(p, resources);
                if (picked) { resources = picked; renderResources(); }
              },
            })),
          resBox),
        field('Reason', reasonIn),
        promptBox,
        field('Suggested reviewers', reviewersIn,
          'Optional. Comma separated — the cluster still applies its own review rules.'),

        el('div', { class: 'rq-field' },
          el('div', { class: 'rq-field-head' },
            el('label', { text: 'Timing' }),
            el('button', {
              class: 'ghost-btn sm', text: 'Start now',
              title: 'Reset the start time to immediately',
              onClick: () => { startIn.value = toLocalInput(Date.now()); syncPreview(); },
            })),
          el('div', { class: 'rq-times' },
            timeField('Takes effect', startIn, 'Defaults to now'),
            timeField('Request expires', requestTtlIn, 'Unreviewed after this'),
            timeField('Access lasts', maxDurationIn, 'Once approved'),
            timeField('Session expires', sessionTtlIn, 'Elevated certificate'))),
        ttlDatalist(ttlListId),

        commandDisclosure(
          previewEl = el('div', { class: 'rq-preview' }),
          async () => {
            const args = await previewArgs();
            window.api.clipboard.write(args.map(shellQuote).join(' '));
            status('Command copied');
          },
          syncPreview));

      for (const f of [reasonIn, reviewersIn, startIn, requestTtlIn, maxDurationIn, sessionTtlIn]) {
        f.addEventListener('input', syncPreview);
        f.addEventListener('change', syncPreview);
      }

      renderRoles();
      renderResources();
      syncPreview();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Load saved…',
        onClick: async () => {
          const t = await openSavedRequests(p);
          if (!t) return;
          roles = [...(t.roles || [])];
          resources = [...(t.resources || [])];
          reasonIn.value = t.reason || '';
          reviewersIn.value = (t.reviewers || []).join(',');
          requestTtlIn.value = t.requestTtl || '';
          maxDurationIn.value = t.maxDuration || '';
          sessionTtlIn.value = t.sessionTtl || '';
          // A saved start time is a stored instant that has long since passed;
          // replaying means "now", which the user can then push forward.
          startIn.value = toLocalInput(Date.now());
          templateId = t.id;
          renderRoles();
          renderResources();
          syncPreview();
          status(`Loaded “${t.name}”`);
        },
      },
      {
        label: 'Save…',
        onClick: async () => {
          const cur = collect();
          if (!cur.roles.length && !cur.resources.length) {
            return toast('Choose roles or resources before saving', 'error');
          }
          const name = await prompt({
            title: 'Save this request',
            label: `Listed under ${p.cluster || p.proxy}, ready to raise again.`,
            value: prefill.name || '',
            placeholder: 'e.g. prod database incident access',
            confirmLabel: 'Save',
          });
          if (!name) return;
          await window.api.teleport.saveRequest({
            id: templateId || undefined,
            name, proxy: p.proxy, cluster: p.cluster, ...cur,
          });
          toast('Request saved', 'success');
        },
      },
      {
        label: 'Submit request', class: 'primary-btn',
        /*
         * Sent from inside the dialog rather than after it closes.
         *
         * A cluster can refuse a request for something the dialog could
         * have asked about — most often a reason, which a role on the far
         * side can insist on and nothing here can know in advance. Closing
         * first turned that into a toast over an empty screen, with
         * everything retyped to try again. Now the refusal lands in the
         * dialog that caused it, with the field it is about marked and
         * focused, and the request is one keystroke and one press from
         * being right.
         */
        onClick: async ({ close }) => {
          const cur = collect();
          if (!cur.roles.length && !cur.resources.length) {
            return toast('Give at least one role or resource', 'error');
          }
          if (reasonNeeded(p) && !cur.reason.trim()) {
            reasonIn.classList.add('needed');
            reasonIn.focus();
            return toast(`${p.cluster || p.proxy} requires a reason for access requests`, 'error', 7000);
          }
          status('Creating request…', 0);
          const out = await window.api.teleport.requestCreate({
            proxy: p.proxy,
            home: p.homeDir,
            roles: cur.roles,
            resources: cur.resources.map((r) => r.id),
            reason: cur.reason,
            reviewers: cur.reviewers,
            requestTtl: cur.requestTtl,
            sessionTtl: cur.sessionTtl,
            maxDuration: cur.maxDuration,
            assumeStartTime: cur.assumeStartTime,
          });
          status('');
          if (out.ok) {
            if (templateId) window.api.teleport.markSavedRequestUsed(templateId).catch(() => {});
            toast('Request created', 'success');
            close(cur);
            return;
          }
          const why = firstLine(out.output) || 'Create failed';
          /*
           * The cluster could not decide which roles the request should
           * carry and tsh stopped to ask — a question a spawned process
           * cannot answer, so what comes back is "failed reading prompt
           * response: EOF" and no request. The names it was about to offer
           * are in the output, so they become the chips above and the
           * person answers instead. There is no way to ask for them up
           * front: this tsh has no dry run, and neither the JSON nor the
           * table of `request search` carries the roles that would grant a
           * resource.
           */
          if (out.roleChoices?.length) {
            offered = [...new Set([...(offered || []), ...out.roleChoices])];
            if (roles.length === 0) roles = [];       // nothing assumed on your behalf
            renderRoles();
            toast(`${p.cluster || p.proxy} needs you to say which roles to request — `
              + 'choose them above and submit again', 'error', 12000);
            return;
          }
          // A refusal for want of a reason is remembered, so the next
          // request on this cluster asks for one before it is sent.
          if (out.needsReason || /reason/i.test(why)) {
            await rememberReasonRequired(p);
            reasonIn.classList.add('needed');
            reasonIn.focus();
          }
          toast(why, 'error', 10000);
        },
      },
    ],
  });
  if (!res) return;
}

/* ------------------------------------------------------------------ */
/* Request timing                                                      */
/* ------------------------------------------------------------------ */

/** Durations tsh accepts as Go durations; the list is a starting point. */
const TTL_SUGGESTIONS = ['30m', '1h', '2h', '4h', '8h', '12h', '24h', '48h'];

function durationInput(listId, value) {
  const input = textInput({ value: value || '', placeholder: 'e.g. 4h', class: 'rq-dur' });
  input.setAttribute('list', listId);
  return input;
}

/**
 * A datalist per dialog. Ids are document-global, so a fixed one collides the
 * moment two request dialogs are open and every suggestion appears twice.
 */
let ttlListSeq = 0;
function ttlDatalist(id) {
  const list = el('datalist', { id });
  for (const v of TTL_SUGGESTIONS) list.append(el('option', { value: v }));
  return list;
}

/**
 * The exact command, folded away. Copy sits in the summary so it works without
 * expanding, and has to stop its click from toggling the disclosure.
 */
function commandDisclosure(preview, onCopy, onToggle) {
  const copy = el('button', {
    class: 'ghost-btn sm', text: 'Copy',
    onClick: (e) => { e.preventDefault(); e.stopPropagation(); onCopy(); },
  });
  const details = el('details', { class: 'rq-cmd' },
    el('summary', {},
      el('span', { text: 'tsh command' }),
      copy),
    preview);
  details.addEventListener('toggle', () => { if (details.open) onToggle(); });
  return details;
}

function timeField(label, input, hint) {
  return el('div', { class: 'rq-time' },
    el('label', { text: label }),
    input,
    hint ? el('span', { class: 'rq-time-hint', text: hint }) : null);
}

/** `<input type="datetime-local">` wants local wall-clock, not an ISO string. */
function toLocalInput(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The RFC3339 instant to send, or '' when the chosen time is now or earlier —
 * immediate is Teleport's own default, and a start time in the past is at best
 * redundant. A minute of slack stops the prefilled "now" from drifting into the
 * future while the form is being filled in.
 */
function futureIso(localValue) {
  if (!localValue) return '';
  const d = new Date(localValue);
  if (isNaN(d)) return '';
  return d.getTime() > Date.now() + 60000 ? d.toISOString() : '';
}

/** Quote an argument only when a shell would otherwise mangle it. */
function shellQuote(arg) {
  const s = String(arg);
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  // Split on the flag's own '=' so `--reason=two words` quotes only the value.
  const eq = s.indexOf('=');
  if (s.startsWith('--') && eq > 0) {
    const v = s.slice(eq + 1);
    if (/^[\w@%+=:,./-]*$/.test(v)) return s;
    return s.slice(0, eq + 1) + `'${v.replace(/'/g, `'\\''`)}'`;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** An absolute timestamp, shown with how far off it is. */
function formatWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const mins = Math.round((d - Date.now()) / 60000);
  const rel = mins < 0
    ? `${formatSpan(-mins)} ago`
    : `in ${formatSpan(mins)}`;
  return `${d.toLocaleString()} (${rel})`;
}

/** The durations a saved request carries, or nothing when it takes the defaults. */
function timingSummary(t) {
  const parts = [
    t.requestTtl ? `expires after ${t.requestTtl}` : null,
    t.maxDuration ? `access for ${t.maxDuration}` : null,
    t.sessionTtl ? `session ${t.sessionTtl}` : null,
  ].filter(Boolean);
  return parts.length ? el('div', { text: 'timing: ' + parts.join(' · ') }) : null;
}

function formatSpan(mins) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Copy a request that already exists into a saved one.
 *
 * The access you had to ask for once is usually the access you will have to ask
 * for again, and by the time you need it the original has expired off the list.
 * Resources are stored by the name they resolved to, so the saved entry stays
 * readable even though it is the id that gets raised.
 */
/**
 * An existing request as form input.
 *
 * Its timings come back as the absolute instants Teleport resolved them to,
 * which cannot be replayed — a request raised next week cannot expire last
 * Tuesday. They are turned back into the durations they were presumably asked
 * for, measured from when the original was created, and the start time is left
 * at "now" for the user to push forward.
 */
function asPrefill(r, p) {
  const from = r.created ? new Date(r.created).getTime() : null;
  const span = (iso) => {
    if (!from || !iso) return '';
    const mins = Math.round((new Date(iso).getTime() - from) / 60000);
    if (!isFinite(mins) || mins <= 0) return '';
    // Go durations, and readable ones: "7h56m" rather than "476m".
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    return mins % 60 ? `${h}h${mins % 60}m` : `${h}h`;
  };
  return {
    roles: [...r.roles],
    resources: requestResources(r, p),
    reason: r.reason || '',
    reviewers: [...(r.reviewers || [])],
    requestTtl: span(r.expires),
    maxDuration: span(r.maxDuration),
    sessionTtl: span(r.sessionTtl),
  };
}

function requestResources(r, p) {
  return r.resources.map((x) => ({
    id: x.id,
    kind: x.kind,
    name: x.label || x.name,
    cluster: x.cluster || p.cluster || '',
  }));
}

async function saveExistingRequest(p, r) {
  const resources = requestResources(r, p);

  if (!r.roles.length && !resources.length) {
    return toast('This request names neither roles nor resources', 'error');
  }

  const name = await prompt({
    title: 'Save as a reusable request',
    label: `Listed under ${p.cluster || p.proxy}, ready to raise again.`,
    value: suggestedName(r, resources),
    placeholder: 'e.g. prod database incident access',
    confirmLabel: 'Save',
  });
  if (!name) return;

  try {
    const timing = asPrefill(r, p);
    await window.api.teleport.saveRequest({
      name,
      proxy: p.proxy,
      cluster: p.cluster,
      roles: r.roles,
      resources,
      reason: r.reason || '',
      reviewers: r.reviewers || [],
      requestTtl: timing.requestTtl,
      maxDuration: timing.maxDuration,
      sessionTtl: timing.sessionTtl,
    });
    toast(`Saved “${name}”`, 'success');
  } catch (e) {
    toast(e.message || 'Could not save', 'error');
  }
}

/** A name worth offering: the reason if there was one, else what it asked for. */
function suggestedName(r, resources) {
  const reason = (r.reason || '').trim();
  if (reason) return reason.length > 48 ? reason.slice(0, 47) + '…' : reason;
  if (resources.length === 1) return resources[0].name;
  if (resources.length) return `${resources.length} resources`;
  return r.roles.join(', ');
}

/** Saved requests for this cluster: load one back, or delete it. */
async function openSavedRequests(p) {
  let list = [];
  try { list = await window.api.teleport.savedRequests({ proxy: p.proxy, home: p.homeDir }); }
  catch { list = []; }

  let body = null;
  const render = (close) => {
    if (!body) return;
    clear(body);
    if (!list.length) {
      body.append(el('div', { class: 'sb-empty' },
        el('div', { text: 'Nothing saved for this cluster yet.' }),
        el('div', {
          style: 'margin-top:6px;opacity:.75',
          text: 'Build a request, then use Save… to keep it.',
        })));
      return;
    }
    for (const t of list) {
      const card = el('div', { class: 'req-card' });
      card.append(el('div', { class: 'req-head' },
        el('span', { style: 'font-weight:600', text: t.name }),
        el('span', {
          style: 'font-size:11px;color:var(--muted);margin-left:auto',
          text: t.lastUsed ? `raised ${new Date(t.lastUsed).toLocaleDateString()}` : 'never raised',
        })));
      card.append(el('div', { class: 'req-meta' },
        t.roles?.length ? el('div', { text: 'roles: ' + t.roles.join(', ') }) : null,
        t.resources?.length
          ? el('div', { text: `${t.resources.length} resource(s): ` + t.resources.slice(0, 5).map((r) => r.name || r.id).join(', ') + (t.resources.length > 5 ? ` +${t.resources.length - 5}` : '') })
          : null,
        t.reason ? el('div', { text: 'reason: ' + t.reason }) : null,
        t.reviewers?.length ? el('div', { text: 'reviewers: ' + t.reviewers.join(', ') }) : null,
        timingSummary(t)));
      card.append(el('div', { class: 'req-actions' },
        el('button', { class: 'primary-btn', text: 'Load', onClick: () => close(t) }),
        el('button', {
          class: 'ghost-btn danger-btn', text: 'Delete',
          onClick: async () => {
            if (!await confirm({
              title: 'Delete saved request',
              message: `Delete “${t.name}”?`,
              confirmLabel: 'Delete', danger: true,
            })) return;
            await window.api.teleport.deleteSavedRequest(t.id);
            list = list.filter((x) => x.id !== t.id);
            render(close);
          },
        })));
      body.append(card);
    }
  };

  return modal({
    title: 'Saved requests',
    subtitle: p.cluster || p.proxy,
    width: 'min(680px, 94vw)',
    render: (b, { close }) => {
      body = b; render(close);
    },
    buttons: [{ label: 'Close', value: null }],
  });
}

export function openTeleportPanel() {
  const p = activeProfile();
  if (p) openRequestsDialog(p);
  else openLoginDialog();
}
