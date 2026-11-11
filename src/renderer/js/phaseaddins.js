import { createYamlView } from './yamlview.js';
import { el } from './util.js';
import { modal, toast, status, confirm, textInput } from './ui.js';

/*
 * My add-ins: setups of your own for "Build a Phase from setups", one YAML
 * file each in a folder (main/phasesetup.js reads them; the format is
 * described at the top of every new one). Here they are listed, written in
 * an editor that checks each as it is typed — the same check the builder
 * makes, with the stage it would add shown underneath — saved, deleted, and
 * the folder opened or moved (a shared, checked-out repo, say, so a team has
 * the same ones).
 */

function editor(value, onChange) {
  const v = createYamlView({ value, onChange });
  return { dom: v.dom, get: v.getValue, set: v.setValue };
}

/** Open the manager. Resolves true when something was saved or deleted, so the builder reads the list again. */
export async function openAddinManager() {
  let info = await window.api.beams.addins();
  let changed = false;
  // What is being edited: an existing file, or a new one with a name to give.
  let current = null; // { file, name } — file null for a new one
  const nameIn = textInput({ placeholder: 'file-name (lowercase)', style: 'max-width:220px' });
  const result = el('div', { style: 'font-size:12px;min-height:1.4em' });
  const preview = el('pre', {
    style: 'font-family:var(--mono);font-size:11px;margin:0;white-space:pre;overflow:auto;max-height:22vh;'
      + 'background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:6px 8px;user-select:text',
  });
  let timer = null;
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const r = await window.api.beams.checkAddin({ text: ed.get(), name: current?.name || nameIn.value || 'addin' });
      result.replaceChildren(r.ok
        ? el('span', { style: 'color:var(--green)', text: `✓ "${r.label}" — goes in a ${r.stage === 'any' ? 'stage of either kind' : r.stage === 'files' ? 'copy-files stage' : 'commands stage'}` })
        : el('span', { style: 'color:var(--red)', text: '✕ ' + (r.errors || []).join(' · ') }));
      // The stage it adds, with its defaults filled in — the header line is the builder's, not the add-in's.
      preview.textContent = r.yaml ? r.yaml.replace(/^#.*\n/, '') : '';
    }, 250);
  };
  const ed = editor('', check);
  const list = el('div', { style: 'display:flex;flex-direction:column;gap:3px;overflow:auto' });
  const dirLine = el('div', { class: 'hint', style: 'word-break:break-all' });

  const select = (entry) => {
    current = entry ? { file: entry.file, name: entry.file.split('/').pop().replace(/\.ya?ml$/i, '') } : { file: null, name: '' };
    nameIn.value = current.name;
    nameIn.disabled = !!entry;
    ed.set(entry ? entry.text : info.template);
    renderList();
    check();
  };
  const renderList = () => {
    dirLine.textContent = `Folder: ${info.dir}${info.custom ? '' : ' (the app’s own)'}`;
    const row = (entry, bad) => el('div', {
      class: 'sb-item' + (current?.file === entry.file ? ' active' : ''), style: 'cursor:pointer;display:block;padding:4px 6px',
      title: entry.file, onClick: () => select(entry),
    },
      el('div', { style: 'font-weight:600;font-size:12px', text: bad ? entry.file.split('/').pop() : entry.label }),
      el('div', { style: `font-size:11px;color:${bad ? 'var(--red)' : 'var(--muted)'}`, text: bad ? entry.error : `${entry.group} · ${entry.stage}` }));
    list.replaceChildren(
      ...info.addins.map((a) => row(a, false)),
      ...info.problems.map((p) => row(p, true)),
      !info.addins.length && !info.problems.length ? el('div', { class: 'hint', text: 'None yet — New add-in starts one from an example.' }) : null);
  };
  const reload = async () => { info = await window.api.beams.addins(); renderList(); };

  const save = async () => {
    const text = ed.get();
    const r = await window.api.beams.checkAddin({ text, name: current?.name || nameIn.value });
    if (!r.ok) return toast(r.errors[0], 'error', 8000);
    try {
      const out = await window.api.beams.saveAddin({ file: current?.file || null, name: nameIn.value.trim(), text });
      changed = true;
      await reload();
      const entry = info.addins.find((a) => a.file === out.file);
      if (entry) select(entry);
      status(`Saved ${out.file}`, 6000);
    } catch (e) { toast(e.message, 'error', 8000); }
    return undefined;
  };

  await modal({
    title: 'My Phase add-ins',
    subtitle: 'Setups of your own, one YAML file each',
    width: 'min(1180px, 96vw)',
    resize: 'phase-addins',
    render: (body) => {
      body.append(
        el('div', { style: 'display:grid;grid-template-columns:250px minmax(0,1fr);gap:12px;height:64vh' },
          el('div', { style: 'display:flex;flex-direction:column;gap:6px;min-height:0' },
            el('button', { class: 'ghost-btn sm', type: 'button', text: '+ New add-in', onClick: () => select(null) }),
            list,
            el('div', { style: 'flex:1' }),
            dirLine,
            el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
              el('button', { class: 'ghost-btn sm', type: 'button', text: 'Open folder', onClick: () => window.api.beams.openAddinsDir() }),
              el('button', {
                class: 'ghost-btn sm', type: 'button', text: 'Use another folder…',
                title: 'A shared folder — a checked-out repo, say — so a team has the same add-ins',
                onClick: async () => { if (await window.api.beams.chooseAddinsDir({})) { changed = true; await reload(); select(info.addins[0] || null); } },
              }),
              info.custom ? el('button', {
                class: 'ghost-btn sm', type: 'button', text: 'Back to the app’s folder',
                onClick: async () => { await window.api.beams.chooseAddinsDir({ reset: true }); changed = true; await reload(); select(info.addins[0] || null); },
              }) : null)),
          el('div', { style: 'display:flex;flex-direction:column;gap:6px;min-height:0' },
            el('div', { style: 'display:flex;gap:8px;align-items:center' }, el('span', { text: 'File' }), nameIn, el('span', { class: 'hint', text: '.yaml' })),
            el('div', { style: 'flex:1;min-height:0;border:1px solid var(--border);border-radius:6px;overflow:hidden' }, ed.dom),
            result,
            el('div', { class: 'hint', text: 'What it adds to a stage, with its defaults:' }),
            preview)));
      select(info.addins[0] || info.problems[0] || null);
    },
    buttons: [
      {
        label: 'Delete',
        onClick: async () => {
          if (!current?.file) return;
          if (!await confirm({ title: `Delete ${current.name}.yaml?`, message: 'The add-in file is removed. Phases already built with it are not changed.', confirmLabel: 'Delete', danger: true })) return;
          await window.api.beams.removeAddin(current.file);
          changed = true;
          await reload();
          select(info.addins[0] || info.problems[0] || null);
        },
      },
      { label: 'Close', value: null },
      { label: 'Save', class: 'primary-btn', onClick: () => save() },
    ],
  });
  return changed;
}
