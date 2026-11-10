/**
 * Namespaces typed in by hand, per kube context.
 *
 * A role scoped to one namespace can list its pods but not the namespaces
 * themselves, so every picker built from `kubectl get namespaces` came up
 * with nothing to pick. Typing the name is the way in there; remembering it
 * (settings.kubeNamespaces, context name → names) saves typing it again on
 * every open. Shared by the sidebar tree and the cluster browser, which is
 * why it is its own module rather than living in either one.
 */
import { state } from './state.js';
import { prompt } from './ui.js';

// What Kubernetes accepts as a namespace name (DNS-1123 label).
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export function typedNamespaces(contextName) {
  return (state.settings.kubeNamespaces || {})[contextName] || [];
}

/** The namespaces worth offering on a context beyond what the list returned: typed ones, then the context's own default. */
export function extraNamespaces(contextName, listed = [], contextNamespace = '') {
  const have = new Set(listed);
  const out = [];
  for (const n of [...typedNamespaces(contextName), contextNamespace]) {
    if (n && !have.has(n)) { have.add(n); out.push(n); }
  }
  return out;
}

async function rememberNamespace(contextName, ns) {
  const all = state.settings.kubeNamespaces || {};
  const list = all[contextName] || [];
  if (list.includes(ns)) return;
  state.settings = await window.api.settings.set({ kubeNamespaces: { ...all, [contextName]: [...list, ns].sort() } });
}

/** Ask for a namespace by name and remember it for this context — the name, or null if cancelled. */
export async function askNamespace(contextName, { value = '' } = {}) {
  const ns = await prompt({
    title: 'Type a namespace',
    label: 'For a role that can use a namespace but not list them all',
    value, placeholder: 'e.g. team-payments', confirmLabel: 'Open',
    validate: (v) => (!v ? 'Enter a namespace name.'
      : DNS_LABEL.test(v) ? null : `"${v}" is not a valid namespace — lowercase letters, digits and "-", up to 63.`),
  });
  if (!ns) return null;
  await rememberNamespace(contextName, ns).catch(() => {});
  return ns;
}
