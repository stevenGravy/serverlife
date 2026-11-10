import { el } from './util.js';
import { modal, toast, status, confirm } from './ui.js';

/**
 * Moving a setup between machines, and sharing macros.
 *
 * Import is deliberately two steps: read the file, show what is in it, then
 * ask whether to merge or replace. Replacing is how you lose an afternoon's
 * work, so it never happens as a side effect of picking a file.
 */

const LABELS = {
  profiles: 'saved profiles',
  folders: 'folders',
  snippets: 'snippets',
  macros: 'macros',
  requestTemplates: 'saved access requests',
  layouts: 'layouts',
  hiddenMacros: 'hidden built-in macros',
};

function summarise(counts) {
  return Object.entries(counts || {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${LABELS[k] || k}`);
}

/** Write everything, or just macros, to a file the user picks. */
export async function exportSettings(what = 'all', ids) {
  try {
    const res = await window.api.backup.export(what, ids);
    if (!res) return null;
    const parts = summarise(res.counts);
    toast(parts.length ? `Exported ${parts.join(', ')}` : 'Exported', 'success');
    status('Written to ' + res.path);
    return res;
  } catch (e) {
    toast(e.message || 'Export failed', 'error');
    return null;
  }
}

/**
 * Read a file, show what it holds, and apply it the way the user chooses.
 * Returns true when something was actually imported.
 */
export async function importSettings() {
  let read;
  try {
    read = await window.api.backup.read();
  } catch (e) {
    toast(e.message || 'Could not read that file', 'error');
    return false;
  }
  if (!read) return false;

  const { doc, summary, path } = read;
  const parts = summarise(summary.counts);
  const macrosOnly = summary.kind === 'macros';

  const mode = await modal({
    title: macrosOnly ? 'Import macros' : 'Import settings',
    subtitle: path,
    width: 'min(560px, 94vw)',
    render: (body) => {
      body.append(el('div', { class: 'nt-kv' },
        el('div', { class: 'nt-k', text: 'Contains' }),
        el('div', { class: 'nt-v', text: parts.length ? parts.join('\n') : 'nothing recognisable' }),
        ...(summary.hasSettings
          ? [el('div', { class: 'nt-k', text: 'Preferences' }), el('div', { class: 'nt-v', text: 'yes — theme, fonts, defaults' })]
          : []),
        ...(summary.exportedAt
          ? [el('div', { class: 'nt-k', text: 'Exported' }), el('div', { class: 'nt-v', text: new Date(summary.exportedAt).toLocaleString() })]
          : [])));
      body.append(el('div', { class: 'hint', style: 'margin-top:12px' },
        'Merge keeps what you have and adds anything new — entries already here, matched by id, are left alone. '
        + 'Replace makes this machine match the file.'));
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Replace',
        class: 'ghost-btn danger-btn',
        onClick: async ({ close }) => {
          const ok = await confirm({
            title: 'Replace everything?',
            message: 'Your current profiles, macros, snippets and saved requests are discarded.',
            detail: 'Export them first if you might want them back — this cannot be undone.',
            confirmLabel: 'Replace', danger: true,
          });
          if (ok) close('replace');
        },
      },
      { label: 'Merge', class: 'primary-btn', value: 'merge' },
    ],
  });
  if (!mode) return false;

  try {
    const res = await window.api.backup.apply(doc, { mode });
    const added = summarise(res.added);
    toast(mode === 'replace'
      ? 'Settings replaced'
      : (added.length ? `Added ${added.join(', ')}` : 'Nothing new to add'), 'success');
    return true;
  } catch (e) {
    toast(e.message || 'Import failed', 'error');
    return false;
  }
}

/** Reload everything an import may have touched, without restarting. */
export async function reloadAfterImport() {
  try { window.api.settings.get().then((s) => { if (s) applySettings(s); }); } catch { /* settings load later through the usual path */ }
  const { refreshInventory } = await import('./sidebar.js');
  await refreshInventory();
}

async function applySettings(s) {
  const { state } = await import('./state.js');
  state.settings = s;
  const { applyTheme } = await import('./index.js');
  applyTheme?.();
}
