import { el } from './util.js';

/*
 * Settings, findable: the dialog's groups (split where it already draws a
 * divider) become titled sections, with a dropdown to show one section and
 * a search box that keeps only the settings whose words match — a setting's
 * explanation stays with it. Nothing about the settings themselves changes;
 * this only arranges what the dialog already built.
 */

// Section names, from words in the group's first setting. The first rule that matches wins.
const NAMES = [
  [/Teleport homes/i, 'Teleport homes and tsh'],
  [/^Theme|Accent colour|Skin/i, 'Appearance'],
  [/font size|Scrollback|Font family/i, 'Text and fonts'],
  [/Local automation/i, 'Local automation (MCP)'],
  [/recent connections/i, 'Recent connections'],
  [/While a session connects/i, 'Connecting'],
  [/Refresh the file list|Refresh the Teleport/i, 'Refreshing and lists'],
  [/MFA/i, 'MFA'],
  [/X11/i, 'X11 forwarding'],
  [/Follow the terminal|hidden files|file details|Folders first/i, 'File browser'],
  [/KubeLife|Kubernetes/i, 'KubeLife'],
  [/Cursor style/i, 'Sessions and the interface'],
  [/SSH config files/i, 'SSH config files'],
  [/AI assistant/i, 'Assistants, tmux and watching'],
  [/Highlight/i, 'Highlighting'],
  [/starred/i, 'Starred hosts'],
  [/agent/i, 'SSH agent'],
  [/Editor for remote files/i, 'Editors'],
  [/^tsh:/i, 'About'],
];

const isDivider = (n) => n.tagName === 'DIV' && /border-top/.test(n.getAttribute('style') || '') && !n.textContent.trim();
const firstLabel = (nodes) => {
  for (const n of nodes) {
    const t = (n.querySelector?.('.field-label, label')?.textContent || n.textContent || '').trim();
    if (t) return t;
  }
  return '';
};

export function organizeSettings(body) {
  const nodes = [...body.children];
  // Groups between dividers.
  const groups = [[]];
  for (const n of nodes) {
    if (isDivider(n)) { groups.push([]); n.remove(); } else groups[groups.length - 1].push(n);
  }
  const sections = [];
  for (const items of groups.filter((g) => g.length)) {
    const label = firstLabel(items);
    const title = (NAMES.find(([re]) => re.test(label)) || [null, label.slice(0, 40) || 'More'])[1];
    const prev = sections[sections.length - 1];
    // Two groups with one name read as one section.
    if (prev && prev.title === title) { prev.items.push(...items); prev.box.append(...items); continue; }
    const head = el('div', { class: 'settings-section-title', text: title });
    const box = el('div', { class: 'settings-section', dataset: { title } }, head, ...items);
    sections.push({ title, items, box, head });
  }

  const sel = el('select', { title: 'Show one section of Settings' },
    el('option', { value: '', text: 'All settings' }),
    ...sections.map((s, i) => el('option', { value: String(i), text: s.title })));
  const search = el('input', { type: 'search', placeholder: 'Search settings…', spellcheck: 'false', style: 'flex:1' });
  const none = el('div', { class: 'hint', style: 'display:none;padding:10px 0', text: 'No setting matches.' });
  const bar = el('div', { class: 'settings-nav' }, sel, search);

  const apply = () => {
    const q = search.value.trim().toLowerCase();
    const only = sel.value === '' ? null : Number(sel.value);
    let any = false;
    sections.forEach((s, i) => {
      const inScope = only === null || only === i;
      const titleHit = q && s.title.toLowerCase().includes(q);
      let shown = 0;
      let prevShown = false;
      for (const n of s.items) {
        // An explanation (a hint) goes with the setting just above it.
        const isHint = n.classList?.contains('hint') && !n.querySelector('input, select, textarea, button');
        const hit = !q || titleHit || n.textContent.toLowerCase().includes(q)
          || [...n.querySelectorAll('input, textarea')].some((x) => String(x.value || x.placeholder || '').toLowerCase().includes(q));
        const show = inScope && (isHint ? (q ? prevShown : true) : hit);
        n.style.display = show ? '' : 'none';
        if (!isHint) prevShown = show;
        if (show) shown++;
      }
      s.box.style.display = inScope && shown ? '' : 'none';
      if (inScope && shown) any = true;
    });
    none.style.display = any ? 'none' : '';
  };
  sel.addEventListener('change', () => { apply(); body.scrollTop = 0; });
  search.addEventListener('input', apply);

  body.replaceChildren(bar, ...sections.map((s) => s.box), none);
  // The search is where a long dialog is started from.
  setTimeout(() => search.focus(), 40);
  return { sections: sections.map((s) => s.title) };
}
