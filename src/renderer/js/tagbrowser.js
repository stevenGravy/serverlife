import { state } from './state.js';
import { el, clear } from './util.js';
import { modal, status } from './ui.js';
import { collectTags, hasTerm, termFor, labelEntries, isInternalLabel } from './tags.js';

/**
 * Every label in the inventory, grouped by key, with how many nodes carry each
 * value. Clicking a value toggles it into the sidebar filter — which is the
 * point: you rarely know a cluster's label vocabulary by heart, so the list has
 * to be browsable before it can be searchable.
 */
export async function openTagBrowser({ getFilter, setFilter } = {}) {
  const nodes = [...state.teleportNodes.values()].flat();
  const tags = collectTags(nodes);

  let body = null;
  let search = '';
  const searchIn = el('input', {
    class: 'tagb-search', type: 'text', placeholder: 'Find a label…', spellcheck: 'false',
  });
  searchIn.addEventListener('input', () => { search = searchIn.value.trim().toLowerCase(); render(); });

  const apply = (term) => {
    setFilter?.(term);
    render();
  };

  const render = () => {
    if (!body) return;
    clear(body);

    if (!nodes.length) {
      body.append(el('div', { class: 'sb-empty', text: 'No Teleport nodes loaded. Log in and refresh the inventory.' }));
      return;
    }
    if (!tags.size) {
      body.append(el('div', { class: 'sb-empty', text: 'None of the visible nodes carry labels.' }));
      return;
    }

    const active = getFilter?.() || '';
    let shown = 0;

    for (const [key, values] of tags) {
      const matchingValues = [...values.entries()]
        .filter(([v]) => !search || key.toLowerCase().includes(search) || v.toLowerCase().includes(search))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (!matchingValues.length) continue;
      shown++;

      const chips = matchingValues.map(([v, count]) => {
        const term = termFor(key, v);
        const on = hasTerm(active, term);
        return el('button', {
          class: 'chip' + (on ? ' on' : ''),
          title: on ? `Remove ${term} from the filter` : `Filter by ${term}`,
          onClick: () => apply(term),
        },
          el('span', { class: 'v', text: v || '(empty)' }),
          el('span', { class: 'n', text: String(count) }));
      });

      body.append(el('div', { class: 'tagb-group' },
        el('div', { class: 'tagb-key' },
          el('span', { text: key }),
          el('button', {
            class: 'ghost-btn sm',
            title: `Filter to every node that has a ${key} label`,
            text: 'any',
            onClick: () => apply(termFor(key, '')),
          })),
        el('div', { class: 'tagb-values' }, ...chips)));
    }

    if (!shown) body.append(el('div', { class: 'sb-empty', text: `No label matches “${search}”.` }));
  };

  await modal({
    title: 'Tags',
    subtitle: `${tags.size} label${tags.size === 1 ? '' : 's'} across ${nodes.length} Teleport node${nodes.length === 1 ? '' : 's'}`,
    width: 'min(720px, 94vw)',
    render: (b) => {
      b.append(searchIn, el('div', { class: 'tagb-body' }));
      body = b.querySelector('.tagb-body');
      render();
      setTimeout(() => searchIn.focus(), 0);
    },
    buttons: [
      {
        label: 'Copy filter',
        onClick: () => {
          const f = getFilter?.() || '';
          if (!f) return status('The filter is empty');
          window.api.clipboard.write(f);
          status('Copied: ' + f);
        },
      },
      { label: 'Clear filter', onClick: () => { setFilter?.(null); render(); } },
      { label: 'Done', value: null, class: 'primary-btn' },
    ],
  });
}

/**
 * Every label on one node. Unlike the sidebar strip this shows Teleport's own
 * internal labels too — the node's UUID and resource id live there, and this is
 * where someone comes looking for them.
 */
export async function openHostTagsDialog(host, { getFilter, setFilter } = {}) {
  const all = labelEntries(host, { includeInternal: true });
  let body = null;

  const render = () => {
    if (!body) return;
    clear(body);
    if (!all.length) {
      body.append(el('div', { class: 'sb-empty', text: 'This node has no labels.' }));
      return;
    }
    const active = getFilter?.() || '';
    const table = el('div', { class: 'tagb-table' });
    for (const [k, v] of all) {
      const term = termFor(k, v);
      const on = hasTerm(active, term);
      table.append(
        el('div', { class: 'tagb-k' + (isInternalLabel(k) ? ' internal' : ''), text: k }),
        el('div', { class: 'tagb-v', text: v || '—' }),
        el('button', {
          class: 'chip' + (on ? ' on' : ''),
          title: on ? `Remove ${term} from the filter` : `Filter the list by ${term}`,
          text: on ? 'filtering' : 'filter',
          onClick: () => { setFilter?.(term); render(); },
        }));
    }
    body.append(table);
  };

  await modal({
    title: 'Tags',
    subtitle: `${host.name || host.alias}${host.cluster ? ' · ' + host.cluster : ''}`,
    width: 'min(640px, 94vw)',
    render: (b) => { body = b; render(); },
    buttons: [
      {
        label: 'Copy',
        onClick: () => {
          window.api.clipboard.write(all.map(([k, v]) => `${k}=${v}`).join('\n'));
          status(`Copied ${all.length} tag${all.length === 1 ? '' : 's'}`);
        },
      },
      { label: 'Close', value: null },
    ],
  });
}
