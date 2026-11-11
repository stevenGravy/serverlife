import { el } from './util.js';
import { foldersIn, hostsInFolder, hostsInTree, isFiled } from './folders.js';

/*
 * Choosing a Phase: a search box over your Phases as the Phases tab files
 * them — the same folders, opened and closed here, then the unfiled ones —
 * rather than one long dropdown of names. Typing narrows it across every
 * folder and opens the ones with a match.
 *
 * Two ways to hold a value. By default a Phase is picked from the list (and
 * `standard`, when given, is a first row meaning "no Phase"). With `typed`,
 * the box *is* the value as well — for --from and --fork-from, which take
 * any upstream image (default:v1) or an exact name@sha256:… snapshot too —
 * and the list below narrows to what it matches.
 */

const when = (ms) => (ms ? new Date(ms).toLocaleDateString() : '');
/** The key the Phases tab files a cluster's Phases under (sidebar.js phaseGroupKeyFor). */
export const phaseGroupKey = (profile) => 'phase:' + profile.proxy + (profile.home ? '@' + profile.home : '');

export function phasePicker({ profile, phases, value = '', standard = null, typed = false, placeholder, onChange } = {}) {
  let current = value;
  const groupKey = phaseGroupKey(profile);
  const hosts = (phases || []).map((ph) => ({ kind: 'phase', id: `phase:${profile.proxy}:${ph.name}`, name: ph.name, labels: {}, ph }));
  const open = new Set();
  // The folder holding what is chosen starts open, so the choice is in view.
  const openTo = (name) => {
    const h = hosts.find((x) => x.name === name);
    if (!h) return;
    const walk = (parent) => {
      for (const f of foldersIn(groupKey, parent)) {
        if (hostsInTree(f, [h]).length) { open.add(f.id); walk(f.id); }
      }
    };
    walk(null);
  };
  openTo(current);

  const search = el('input', {
    type: 'text', spellcheck: 'false', value: typed ? current : '',
    placeholder: placeholder || (typed ? 'A Phase, default:v1 or name@sha256:… — or type to search' : 'Search Phases…'),
    style: 'width:100%',
  });
  const list = el('div', {
    class: 'phase-picker-list',
    style: 'max-height:210px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius);margin-top:5px;padding:3px 0;background:var(--panel-2)',
  });
  const box = el('div', { class: 'phase-picker' }, search, list);

  const query = () => search.value.trim().toLowerCase();
  const matches = (h) => {
    const q = query();
    // A typed value that is exactly a Phase still lists everything: it was picked, not searched for.
    if (!q || (typed && hosts.some((x) => x.name.toLowerCase() === q))) return true;
    return [h.name, h.ph.parent, h.ph.strategy, h.ph.state, h.ph.region].some((v) => String(v || '').toLowerCase().includes(q));
  };
  const choose = (name) => {
    current = name;
    if (typed) search.value = name;
    render();
    onChange?.(name);
  };
  const row = (h, depth) => el('div', {
    class: 'sb-item phase-pick' + (h.name === current ? ' active' : ''),
    style: `padding-left:${10 + depth * 14}px;cursor:pointer`,
    title: [h.name, h.ph.parent ? 'from ' + h.ph.parent : '', h.ph.state, h.ph.region].filter(Boolean).join(' · '),
    onClick: () => choose(h.name),
  },
    el('span', { class: 'name', text: h.name }),
    h.ph.strategy ? el('span', { class: 'tag', text: h.ph.strategy }) : null,
    h.ph.state && h.ph.state !== 'ready' ? el('span', { class: 'tag stale', text: h.ph.state }) : null,
    h.ph.publishedAt ? el('span', { class: 'tag', text: when(h.ph.publishedAt) }) : null);
  const folderRow = (f, n, depth, shut) => el('div', {
    class: 'sb-item phase-pick-folder', style: `padding-left:${6 + depth * 14}px;cursor:pointer;color:var(--text-dim)`,
    onClick: () => { if (open.has(f.id)) open.delete(f.id); else open.add(f.id); render(); },
  }, el('span', { class: 'chev', text: shut ? '▸' : '▾' }), el('span', { class: 'name', text: `\u{1F4C1} ${f.name}` }), el('span', { class: 'sb-subhead-n', text: String(n) }));

  function render() {
    const searching = !!query() && !(typed && hosts.some((x) => x.name.toLowerCase() === query()));
    const rows = [];
    if (standard && (!searching || standard.toLowerCase().includes(query()))) {
      rows.push(el('div', { class: 'sb-item phase-pick' + (current === '' ? ' active' : ''), style: 'padding-left:10px;cursor:pointer', onClick: () => choose('') },
        el('span', { class: 'name', text: standard })));
    }
    const shown = hosts.filter(matches);
    const walk = (parent, depth) => {
      for (const f of foldersIn(groupKey, parent)) {
        const inside = hostsInTree(f, shown);
        if (!inside.length) continue;   // nothing of what is shown lives here
        const shut = !searching && !open.has(f.id);
        rows.push(folderRow(f, inside.length, depth, shut));
        if (shut) continue;
        walk(f.id, depth + 1);
        for (const h of hostsInFolder(f, shown)) rows.push(row(h, depth + 1));
      }
    };
    walk(null, 0);
    for (const h of shown.filter((x) => !isFiled(x, groupKey))) rows.push(row(h, 0));
    if (!rows.length) {
      rows.push(el('div', { class: 'sb-empty', style: 'padding:6px 10px', text: typed && query() ? 'No Phase by that name — it is used as typed.' : 'No Phase matches.' }));
    }
    list.replaceChildren(...rows);
  }
  search.addEventListener('input', () => {
    if (typed) { current = search.value.trim(); onChange?.(current); }
    render();
  });
  render();

  return {
    el: box,
    get value() { return current; },
    set value(v) { current = v || ''; if (typed) search.value = current; openTo(current); render(); },
    focus: () => search.focus(),
  };
}
