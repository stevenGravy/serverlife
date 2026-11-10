import { state } from './state.js';
import { colorCss, HOST_COLORS } from './util.js';
import { status } from './ui.js';
import { groupKeyFor } from './folders.js';

/**
 * Icons and colours for whole clusters.
 *
 * A module of its own because both lists that show clusters need them and
 * neither may import the other: the host list already pulls the Teleport tab
 * in, so anything shared has to sit underneath both.
 */

/** Both lists redraw, so a mark set in one appears in the other. */
async function redraw() {
  const { renderSidebar } = await import('./sidebar.js');
  const { renderTeleportTab } = await import('./teleportpanel.js');
  const { $ } = await import('./util.js');
  renderSidebar();
  const panel = $('#sb-panel-teleport');
  if (panel) renderTeleportTab(panel);
}

/**
 * A cluster's own icon and colour.
 *
 * The same two marks a host can carry, one level up. Six clusters in a
 * sidebar are six lines of near-identical grey text — `staging.example.com`
 * against `prod.example.com` — and the one you must not fat-finger a
 * command into looks exactly like the lab. A red 🏭 on the heading settles
 * that from the corner of the eye, which is the whole job.
 *
 * Filed under the group key rather than the cluster name: the same cluster
 * reached through two tsh homes is two rows, and they are not
 * interchangeable. `clusterKeyOf` takes either a profile or a key already.
 */
export function clusterKeyOf(p) {
  return typeof p === 'string' ? p : groupKeyFor(p);
}

export function clusterIcon(p) {
  return (state.settings.clusterIcons || {})[clusterKeyOf(p)] || '';
}

export function clusterColor(p) {
  return colorCss((state.settings.clusterColors || {})[clusterKeyOf(p)]);
}

export function clusterColorValue(p) {
  return (state.settings.clusterColors || {})[clusterKeyOf(p)] || '';
}

function clusterLabelOf(p) {
  return typeof p === 'string' ? p.replace(/^tp:/, '') : (p.cluster || p.proxy);
}

export async function setClusterIcon(profile) {
  const key = clusterKeyOf(profile);
  const { pickIcon } = await import('./ui.js');
  const icon = await pickIcon({
    title: 'Icon for this cluster',
    subtitle: clusterLabelOf(profile),
    value: clusterIcon(key),
  });
  if (icon === null || icon === undefined) return;
  const map = { ...(state.settings.clusterIcons || {}) };
  if (icon) map[key] = icon; else delete map[key];
  state.settings = await window.api.settings.set({ clusterIcons: map });
  await redraw();
  status(icon ? `${clusterLabelOf(profile)} is ${icon}` : 'Icon cleared');
}

export async function setClusterColor(profile, value) {
  const key = clusterKeyOf(profile);
  const map = { ...(state.settings.clusterColors || {}) };
  if (value) map[key] = value; else delete map[key];
  state.settings = await window.api.settings.set({ clusterColors: map });
  await redraw();
  status(value
    ? `${clusterLabelOf(profile)} is ${value}`
    : `Colour cleared for ${clusterLabelOf(profile)}`);
}

/** The two entries, shared by the host list and the Teleport tab. */
export function clusterMarkMenu(profile) {
  const key = clusterKeyOf(profile);
  return [
    {
      label: clusterIcon(key) ? `Icon: ${clusterIcon(key)}` : 'Give the cluster an icon…',
      icon: clusterIcon(key) || '\u263A',
      title: 'An emoji on the cluster heading, here and in the Teleport tab',
      onClick: () => setClusterIcon(profile),
    },
    {
      label: clusterColor(key) ? 'Cluster colour…' : 'Give the cluster a colour…',
      icon: '\u25C9',
      title: 'Colours the heading, so production does not read like the lab',
      submenu: HOST_COLORS.map((c) => ({
        label: c.label,
        key: clusterColorValue(key) === c.value || (!c.value && !clusterColor(key)) ? '\u2713' : '',
        onClick: () => setClusterColor(profile, c.value),
      })),
    },
  ];
}

