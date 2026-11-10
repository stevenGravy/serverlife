import { state } from './state.js';
import { el } from './util.js';
import { modal, toast, status, field, checkbox } from './ui.js';

/**
 * Environment variables for tsh, from Settings: for every cluster (in Locate
 * tsh / ssh…) and for one cluster (from its heading's menu), the cluster's on
 * top. The main process applies them to every tsh it starts (teleport.tshEnv).
 *
 * The case this is for: Teleport's client tools version, as its docs describe
 * it — TELEPORT_TOOLS_VERSION=18.11.9 for one cluster has tsh fetch and run
 * that version for it, and every other cluster keeps its own. Lines are
 * `NAME=value`; `export NAME="value"` from a shell profile is read as it is
 * pasted.
 */

/** `corp.example.com:443`, `https://corp.example.com/web` → `corp.example.com`. */
export const bareProxy = (p) => String(p || '').trim().toLowerCase()
  .replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '').replace(/:443$/, '');

const SECRET = /KEY|TOKEN|SECRET|PASSWORD|PASS\b/i;
const shown = (name, value) => (SECRET.test(name) ? '•••' : value);

export function clusterEnvText(proxy) {
  return (state.settings.clusterTshEnv || {})[bareProxy(proxy)] || '';
}

/**
 * The example to copy, as text that can be selected and an Insert button —
 * a placeholder vanishes the moment anything is typed, which is no help when
 * the thing to type is the line itself. Change the number to the version wanted.
 */
function exampleLine(area, onChange) {
  const code = el('code', { style: 'user-select:text;font-family:var(--mono);font-size:11.5px', text: 'TELEPORT_TOOLS_VERSION=18.11.9' });
  const insert = el('button', {
    class: 'ghost-btn sm', text: 'Insert',
    title: 'Add this line to the box — replacing a TELEPORT_TOOLS_VERSION line already there',
    onClick: (e) => {
      e.preventDefault();
      const line = code.textContent;
      const lines = area.value.split(/\r?\n/).filter((l) => l.trim());
      const at = lines.findIndex((l) => /^(export\s+)?TELEPORT_TOOLS_VERSION=/.test(l.trim()));
      if (at >= 0) lines[at] = line; else lines.push(line);
      area.value = lines.join('\n');
      onChange();
    },
  });
  return el('div', { class: 'hint', style: 'display:flex;align-items:center;gap:8px;margin:2px 0 6px' },
    el('span', { text: 'e.g.' }), code, insert);
}

/** A box for `NAME=value` lines that says, as it is typed, what it will set. */
export function envBox(text, { placeholder = '' } = {}) {
  const area = el('textarea', {
    rows: 4, spellcheck: 'false', placeholder,
    style: 'width:100%;font-family:var(--mono);font-size:12px',
  });
  area.value = text || '';
  const note = el('div', { class: 'hint env-note', style: 'margin-top:4px;white-space:pre-wrap' });
  let errors = [];
  const check = async () => {
    const r = await window.api.teleport.parseEnv(area.value).catch(() => ({ vars: {}, errors: [] }));
    errors = r.errors || [];
    const names = Object.keys(r.vars || {});
    note.style.color = errors.length ? 'var(--red)' : '';
    note.textContent = errors.length
      ? errors.join('\n')
      : names.length ? 'Sets ' + names.map((n) => `${n}=${shown(n, r.vars[n])}`).join(', ') : 'Nothing set.';
  };
  area.addEventListener('input', check);
  check();
  const example = exampleLine(area, check);
  return { node: el('div', {}, example, area, note), value: () => area.value.trim(), valid: () => !errors.length };
}

/** The variables for one cluster, from its heading's menu. */
export async function editClusterEnv(profile) {
  const proxy = profile.proxy;
  /*
   * The example is the docs' one, not the cluster's own version: a cluster on
   * a pre-release reports a version only its own CDN serves, which would be
   * offered to anyone who opened this, and break tsh for them if inserted.
   */
  const box = envBox(clusterEnvText(proxy), { placeholder: 'TELEPORT_TOOLS_VERSION=18.11.9' });
  const res = await modal({
    title: 'tsh environment for this cluster',
    subtitle: profile.cluster || proxy,
    width: 'min(600px, 94vw)',
    render: (body) => body.append(
      field('Variables', box.node,
        'One NAME=value per line, as in Teleport\u2019s docs (a pasted export NAME=value works too). '
        + 'Set for every tsh run against this cluster — its sessions, beams, Phases and logins — on top of those '
        + 'for every cluster in Locate tsh / ssh…. TELEPORT_TOOLS_VERSION runs this cluster on that version '
        + 'of tsh, fetched on first use.')),
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Save', class: 'primary-btn',
        onClick: ({ close }) => {
          if (!box.valid()) return toast('Some lines are not NAME=value', 'error');
          close({ text: box.value() });
          return undefined;
        },
      },
    ],
  });
  if (!res) return;
  const all = { ...(state.settings.clusterTshEnv || {}) };
  if (res.text) all[bareProxy(proxy)] = res.text;
  else delete all[bareProxy(proxy)];
  state.settings = await window.api.settings.set({ clusterTshEnv: all });
  status(res.text ? `tsh variables set for ${profile.cluster || proxy}` : `No tsh variables for ${profile.cluster || proxy}`);
  // What this cluster's tsh can do may have changed with them: read it again.
  const { refreshProfile, renderSidebar } = await import('./sidebar.js');
  const { refreshBeams } = await import('./beams.js');
  await refreshBeams({ refresh: true, proxy }).catch(() => {});
  refreshProfile(profile);
  renderSidebar();
}

/** A heading's `env` tag, while a cluster has variables of its own. */
export function clusterEnvTag(p, onClick) {
  const text = clusterEnvText(p.proxy);
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/^export\s+/, ''))
    .map((l) => { const i = l.indexOf('='); return i > 0 ? `${l.slice(0, i)}=${shown(l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, ''))}` : l; });
  return el('span', {
    class: 'tag', text: 'env',
    title: `tsh runs with, for this cluster:\n${lines.join('\n')}\nClick or right-click the heading to change.`,
    onClick: (e) => { e.stopPropagation(); onClick?.(); },
  });
}

/** The every-cluster box and its shells switch, for Locate tsh / ssh…. */
export function globalEnvFields() {
  const box = envBox(state.settings.tshEnvText || '', { placeholder: 'TELEPORT_TOOLS_VERSION=18.11.9' });
  const shells = checkbox('Also in local shell tabs, so tsh typed there matches', !!state.settings.tshEnvInShells);
  return {
    nodes: [
      field('Environment for tsh', box.node,
        'One NAME=value per line (a pasted export NAME=value works too). Every tsh the app runs gets these — background reads, sessions, Phase builds and logins. A cluster’s '
        + 'own (its heading’s menu → tsh environment for this cluster…) go on top.'),
      shells,
    ],
    valid: box.valid,
    values: () => ({ tshEnvText: box.value(), tshEnvInShells: shells.input.checked }),
  };
}
