import { state } from './state.js';
import { $ } from './util.js';

/**
 * A panel that can sit on any side of what it is beside — left, top, right or
 * bottom — at any size there: the sidebar beside the main area, the AI panel
 * beside the terminals.
 *
 * Its size has no ceiling of its own: the only limit is leaving its
 * neighbour enough room to stay usable (`room`). Each side keeps its own
 * size, because a width that suits it on the left means nothing as a height
 * across the top. The handle is always the edge between the two, so on the
 * right and at the bottom a drag toward the neighbour grows it the other way.
 */

export const PLACES = [
  { value: 'left', label: 'Left' },
  { value: 'top', label: 'Top' },
  { value: 'right', label: 'Right' },
  { value: 'bottom', label: 'Bottom' },
];

const across = (place) => place === 'top' || place === 'bottom';
const propFor = (place) => (across(place) ? 'height' : 'width');
const TWIN = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

export function makePlacement({
  container, panel, handle, placeKey, sizesKey, fallback, legacySize = () => 0,
  min = { width: 170, height: 120 }, start = { width: 260, height: 300 }, room = { width: 200, height: 140 },
  title,
}) {
  // Terminals re-measure themselves after the panel moves or changes size.
  let refitFn = () => {};
  const place = () => {
    const p = state.settings?.[placeKey];
    return PLACES.some((x) => x.value === p) ? p : fallback;
  };
  const limit = (prop) => {
    const box = $(container);
    const total = prop === 'width' ? (box?.clientWidth || window.innerWidth) : (box?.clientHeight || window.innerHeight);
    return Math.max(min[prop], total - room[prop]);
  };
  /** The size remembered for a side — or its twin's, or one dragged before sides existed. */
  const saved = (p) => {
    const sizes = state.settings?.[sizesKey] || {};
    if (sizes[p]) return Number(sizes[p]);
    if (sizes[TWIN[p]]) return Number(sizes[TWIN[p]]);
    if (!across(p) && legacySize()) return legacySize();
    return start[propFor(p)];
  };
  const setSize = (p, px) => {
    const node = $(panel);
    if (!node) return 0;
    const prop = propFor(p);
    const next = Math.max(min[prop], Math.min(limit(prop), Math.round(px)));
    node.style.width = prop === 'width' ? next + 'px' : '';
    node.style.height = prop === 'height' ? next + 'px' : '';
    node.style.flex = '0 0 ' + next + 'px';
    return next;
  };
  /** Put the panel on its side, at its size there. */
  const apply = () => {
    const p = place();
    const box = $(container);
    const h = $(handle);
    if (!box || !h) return;
    box.dataset.place = p;
    h.classList.toggle('v-resizer', !across(p));
    h.classList.toggle('h-resizer', across(p));
    setSize(p, saved(p));
    refitFn();
  };
  const set = async (p) => {
    state.settings = await window.api.settings.set({ [placeKey]: p });
    apply();
  };
  /** The four sides as menu items, the current one ticked. */
  const menuItems = () => {
    const now = place();
    return PLACES.map((p) => ({ label: p.label, icon: p.value === now ? '✓' : '', onClick: () => set(p.value) }));
  };
  const wire = ({ refit, contextMenu, menuOn = [] }) => {
    refitFn = refit || (() => {});
    const h = $(handle);
    const node = $(panel);
    if (!h || !node) return;
    h.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const p = place();
      const prop = propFor(p);
      const sign = p === 'right' || p === 'bottom' ? -1 : 1;
      const from = prop === 'width' ? e.clientX : e.clientY;
      const startSize = prop === 'width' ? node.offsetWidth : node.offsetHeight;
      h.classList.add('dragging');
      const move = (ev) => setSize(p, startSize + sign * ((prop === 'width' ? ev.clientX : ev.clientY) - from));
      const up = () => {
        h.classList.remove('dragging');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        refitFn();
        const px = Math.round(prop === 'width' ? node.offsetWidth : node.offsetHeight);
        window.api.settings.set({ [sizesKey]: { ...(state.settings[sizesKey] || {}), [p]: px } })
          .then((next) => { state.settings = next; }).catch(() => {});
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    const offer = (e) => {
      // Something inside (a chip, a tab) answered with its own menu already.
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      contextMenu(e.clientX, e.clientY, [{ label: title, heading: true }, ...menuItems()]);
    };
    for (const sel of [handle, ...menuOn]) $(sel)?.addEventListener('contextmenu', offer);
    // A window made smaller must not leave the panel bigger than what it is beside.
    window.addEventListener('resize', () => {
      const p = place();
      if (node.offsetParent) setSize(p, across(p) ? node.offsetHeight : node.offsetWidth);
    });
    apply();
  };
  return { place, apply, set, menuItems, wire };
}

/* ---------------- The sidebar, beside the main area ---------------- */

const sidebar = makePlacement({
  container: '#body', panel: '#sidebar', handle: '#sidebar-resizer',
  placeKey: 'sidebarPlace', sizesKey: 'sidebarSizes', fallback: 'left', title: 'Sidebar position',
  legacySize: () => Number((state.settings?.panelSizes || {})['#sidebar-resizer']) || 0,
});

export const sidebarPlace = sidebar.place;
export const applySidebarPlace = sidebar.apply;
export const setSidebarPlace = sidebar.set;
export const sidebarPlaceMenuItems = sidebar.menuItems;
export function wireSidebarPlace({ refit, contextMenu }) {
  sidebar.wire({ refit, contextMenu, menuOn: ['#sb-tabs'] });
}

/* ---------------- The AI panel, beside the terminals ---------------- */

export const aiPlacement = makePlacement({
  container: '#workspace', panel: '#ai-panel', handle: '#ai-resizer',
  placeKey: 'aiPanelPlace', sizesKey: 'aiPanelSizes', fallback: 'right', title: 'AI panel position',
  min: { width: 280, height: 160 }, start: { width: 460, height: 320 }, room: { width: 240, height: 140 },
  legacySize: () => Number(state.settings?.aiPanelWidth) || 0,
});
