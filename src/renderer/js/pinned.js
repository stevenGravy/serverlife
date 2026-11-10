import { state } from './state.js';
import { groupKeyFor } from './folders.js';
import { watchedIn } from './watch.js';

/**
 * Saved clusters pinned to the Hosts tab that `tsh status` does not list.
 *
 * A logout deletes the profile, and with it the only thing the list was
 * drawn from: the cluster's heading went, and its watched hosts were pushed
 * down into the catch-all "Watched" group as if the cluster had been
 * removed rather than merely logged out of. A pinned saved cluster stands in
 * for the missing profile — shaped like an expired one, so it is drawn the
 * same way, with its watches and its login buttons — under the group key the
 * real profile used, so folders, order and watches all still belong to it.
 */
const bareProxy = (s) => String(s || '').trim().toLowerCase().replace(/:443$/, '');

export function savedOnlyProfiles() {
  const listed = new Set((state.teleportProfiles || []).map((p) => `${bareProxy(p.proxy)}|${p.home || ''}`));
  const out = new Map();
  for (const t of state.savedLogins || []) {
    if (!t.showInHosts || !t.proxy) continue;
    const id = `${bareProxy(t.proxy)}|${t.home || ''}`;
    if (listed.has(id) || out.has(id)) continue;
    // Profiles always carry the port; a saved address may not.
    const p = {
      proxy: /:\d+$/.test(t.proxy) ? t.proxy : t.proxy + ':443',
      cluster: t.cluster || '',
      home: t.home || null,
      homeDir: t.home || undefined,
      username: t.user || '',
      expired: true,
      savedOnly: true,
      saved: t,
    };
    // Unnamed when saved: the watches remember what the cluster called itself,
    // which is also what its last read is filed under.
    if (!p.cluster) p.cluster = watchedIn(groupKeyFor(p)).find((w) => w.cluster)?.cluster || '';
    out.set(id, p);
  }
  return [...out.values()];
}
