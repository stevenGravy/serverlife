import { state } from './state.js';

/*
 * A small server mark on SSH and Teleport host rows, beside the ☸ a
 * Kubernetes cluster has — now the two sit in one list, the kind of each row
 * reads at a glance. Settings → "Server icon on SSH hosts" turns it off.
 */
export const serverIconsShown = () => state.settings?.showServerIcon !== false;

// Two stacked units with a light each: a rack server at text size, tinted by CSS.
const SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">'
  + '<rect x="2" y="2.5" width="12" height="4.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/>'
  + '<rect x="2" y="8.9" width="12" height="4.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/>'
  + '<circle cx="4.9" cy="4.8" r="0.95" fill="currentColor"/><circle cx="4.9" cy="11.2" r="0.95" fill="currentColor"/>'
  + '<path d="M8 4.8h3.8M8 11.2h3.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

/** The mark for a server row, or null when it is turned off. */
export function serverIcon(title = 'SSH server') {
  if (!serverIconsShown()) return null;
  const span = document.createElement('span');
  span.className = 'srv-ico';
  span.title = title;
  span.innerHTML = SVG;
  return span;
}
