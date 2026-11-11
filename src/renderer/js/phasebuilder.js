import { state } from './state.js';
import { el } from './util.js';
import { modal, toast, status, field, textInput, select, checkbox, confirm } from './ui.js';
import { REGIONS, phaseListFor, refreshPhases, runPhaseBuild } from './beams.js';
import { createYamlView } from './yamlview.js';
import { phasePicker } from './phasepicker.js';

/*
 * A Phase put together from setups — the dialog over main/phasesetup.js.
 *
 * On the left, the stages of a phase.yaml in order: each either runs
 * commands (installing Go, Postgres, the AWS CLI…) or copies files from this
 * computer (a config folder, your dotfiles), and either kind can start
 * services in every Beam made from it. On the right, the phase.yaml those
 * make, checked as it changes with the rules tsh applies, so what is built is
 * exactly what is shown. Building it runs `tsh phase apply` in a tab, where
 * each stage's log streams; it can be saved as a file instead, or kept here
 * as a setup to start from next time (settings.phaseSetups).
 */

let catalogCache = null;
async function catalog() {
  if (!catalogCache) catalogCache = await window.api.beams.setupCatalog();
  return catalogCache;
}

const KIND_LABELS = { commands: 'Install and run commands', files: 'Copy files from this computer' };
const savedSetups = () => (Array.isArray(state.settings.phaseSetups) ? state.settings.phaseSetups : []);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** A name for a new stage that is not taken by this dialog or the cluster. */
function freshName(base, taken) {
  const clean = String(base || 'setup').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 44) || 'setup';
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}-${i}`)) return `${clean}-${i}`;
}

/** One field of a setup, bound to `values[key]`. */
function setupField(f, values, onChange) {
  const cur = values[f.key] ?? f.default ?? '';
  let control;
  if (f.kind === 'select') {
    control = select(f.options.map((o) => ({ value: o, label: o })), String(cur));
    control.addEventListener('change', () => { values[f.key] = control.value; onChange(); });
    return field(f.label, control);
  }
  if (f.kind === 'yaml') {
    // Colour-coded, as the phase.yaml beside it is.
    const ed = createYamlView({ value: cur, height: '170px', onChange: (v) => { values[f.key] = v; onChange(); } });
    return field(f.label, el('div', { style: 'border:1px solid var(--border);border-radius:6px;overflow:hidden;resize:vertical;min-height:90px' }, ed.dom));
  }
  if (f.kind === 'textarea' || f.kind === 'paths') {
    control = el('textarea', { rows: f.kind === 'paths' ? 3 : 4, spellcheck: 'false', placeholder: f.placeholder || '', style: 'width:100%;font-family:var(--mono);font-size:12px' });
    control.value = cur;
  } else {
    control = textInput({ value: cur, placeholder: f.placeholder || '' });
  }
  control.addEventListener('input', () => { values[f.key] = control.value; onChange(); });
  if (f.kind !== 'path' && f.kind !== 'paths') return field(f.label + (f.required ? '' : ' (optional)'), control);
  // Browse for a file or a folder; a list takes another line each time.
  const add = (p) => {
    if (!p) return;
    control.value = f.kind === 'paths' ? [control.value.trim(), p].filter(Boolean).join('\n') : p;
    values[f.key] = control.value; onChange();
  };
  return field(f.label + (f.required ? '' : ' (optional)'), el('div', {}, control, el('div', { style: 'display:flex;gap:6px;margin-top:4px' },
    el('button', { class: 'ghost-btn sm', type: 'button', text: 'File…', onClick: async () => add((await window.api.dialog.openFiles({ single: true, title: f.label }))?.[0]) }),
    el('button', { class: 'ghost-btn sm', type: 'button', text: 'Folder…', onClick: async () => add(await window.api.dialog.chooseDir()) }))));
}

/**
 * Open the builder. `from` starts the first stage on an existing Phase;
 * `setup` is a saved one ({ name, stages }) to start from.
 */
export async function openPhaseBuilder(profile, { from = '', setup = null } = {}) {
  let cat = await catalog().catch((e) => { toast(e.message, 'error'); return null; });
  if (!cat) return false;
  const support = (await window.api.beams.addSupport({ proxy: profile.proxy, home: profile.homeDir }).catch(() => null)) || {};
  if (!support.apply) {
    toast('This tsh has no `tsh phase apply` — update tsh (or let the cluster pick its version) to build Phases from setups', 'error', 9000);
    return false;
  }
  let byId = new Map(cat.setups.map((s) => [s.id, s]));
  // After My add-ins…: the list read again, so new and changed add-ins are offered at once.
  const reloadCatalog = async () => {
    catalogCache = null;
    cat = await catalog();
    byId = new Map(cat.setups.map((s) => [s.id, s]));
    renderStages(); check();
  };
  const phases = (phaseListFor(profile.proxy)?.phases || []);
  const taken = new Set(phases.map((p) => p.name));
  let stages = setup ? clone(setup.stages) : [{ name: freshName(from ? `${from}-setup` : 'my-setup', taken), from, kind: 'commands', setups: [] }];
  let setupName = setup?.name || '';

  const stagesBox = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
  /*
   * The phase.yaml, colour-coded. Normally a view of what the stages on the
   * left make; with *Edit by hand* the text itself is what is built — typed
   * here, checked as it changes, and read back into the stages on the left,
   * which wait (dimmed) until *Back to setups*. Built and saved exactly as
   * typed, comments and all.
   */
  const yamlView = createYamlView({ readOnly: true });
  let handText = null;   // null: the stages are the source; text: the hand-written phase.yaml is
  const handView = createYamlView({ onChange: (v) => { handText = v; check(); } });
  handView.dom.style.display = 'none';
  const yamlBox = el('div', { class: 'phase-yaml-view', style: 'flex:1;min-height:0;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden' }, yamlView.dom, handView.dom);
  const problems = el('div', { class: 'phase-problems', style: 'font-size:12px;max-height:140px;overflow:auto' });
  let last = { errors: [], warnings: [], incomplete: [], yaml: '' };
  // Not-filled-in-yet messages (an empty stage, a blank required field) wait for a build or a save to be asked for.
  let attempted = false;

  const showProblems = () => {
    const pending = new Set(attempted ? [] : last.incomplete || []);
    const errors = last.errors.filter((m) => !pending.has(m));
    problems.replaceChildren(...[
      ...errors.map((m) => el('div', { style: 'color:var(--red);margin-bottom:3px', text: '✕ ' + m })),
      ...last.warnings.map((m) => el('div', { style: 'color:var(--amber);margin-bottom:3px', text: '⚠ ' + m })),
      !last.errors.length ? el('div', { style: 'color:var(--green)', text: '✓ tsh phase apply will accept this' })
        : !errors.length ? el('div', { class: 'hint', text: handText !== null ? 'Keep writing — a stage needs a name, and commands: or files:.' : 'Add a setup to begin.' }) : null,
    ].filter(Boolean));
  };

  let timer = null;
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (handText !== null) {
        const r = await window.api.beams.checkSetupYaml(handText).catch((e) => ({ parsed: false, errors: [e.message], warnings: [], incomplete: [] }));
        last = { errors: r.errors || [], warnings: r.warnings || [], incomplete: r.incomplete || [], yaml: handText, names: r.names || [] };
        // The stages follow the text, so going back to setups carries it on.
        if (r.parsed && r.stages) { stages = r.stages; renderStages(); }
      } else {
        try { last = await window.api.beams.buildSetup(clone(stages)); } catch (e) { last = { errors: [e.message], warnings: [], incomplete: [], yaml: '' }; }
        yamlView.setValue(last.yaml || '');
      }
      // The whole text, for tests and for copying: the editor itself only draws what is on screen.
      yamlBox.dataset.yaml = last.yaml || '';
      showProblems();
    }, 180);
  };

  const stagesPane = el('div', { style: 'overflow:auto;padding-right:4px;display:flex;flex-direction:column;gap:8px' });
  const handNote = el('div', { class: 'hint', style: 'display:none;color:var(--accent)', text: 'Editing phase.yaml by hand — the stages below follow the text. Back to setups to change them here.' });
  const handBtn = el('button', {
    class: 'ghost-btn sm', type: 'button', text: 'Edit by hand',
    title: 'Write the phase.yaml yourself — anything tsh phase apply takes; built and saved as you write it',
    onClick: async () => {
      if (handText === null) {
        handText = last.yaml || '';
        handView.setValue(handText);
        yamlView.dom.style.display = 'none'; handView.dom.style.display = '';
        handBtn.textContent = 'Back to setups';
        handNote.style.display = '';
        stagesBox.style.opacity = '.55'; stagesBox.style.pointerEvents = 'none';
        addStageBtn.disabled = true; if (savedSel) savedSel.disabled = true;
      } else {
        const r = await window.api.beams.checkSetupYaml(handText).catch(() => ({ parsed: false }));
        if (!r.parsed && !await confirm({ title: 'Leave the hand-written text?', message: 'It is not readable as phase.yaml yet, so the stages cannot follow it.', detail: (r.errors || []).join('\n'), confirmLabel: 'Back to setups' })) return;
        if (r.parsed && r.stages) stages = r.stages;
        handText = null;
        yamlView.dom.style.display = ''; handView.dom.style.display = 'none';
        handBtn.textContent = 'Edit by hand';
        handNote.style.display = 'none';
        stagesBox.style.opacity = ''; stagesBox.style.pointerEvents = '';
        addStageBtn.disabled = false; if (savedSel) savedSel.disabled = false;
        renderStages();
      }
      check();
    },
  });

  const renderStages = () => {
    stagesBox.replaceChildren(...stages.map((st, i) => {
      const nameIn = textInput({ value: st.name, placeholder: 'lowercase-with-hyphens' });
      nameIn.addEventListener('input', () => { st.name = nameIn.value.trim(); check(); });
      const kindSel = select(Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })), st.kind);
      kindSel.addEventListener('change', () => { st.kind = kindSel.value; renderStages(); check(); });
      const fits = (s) => s.stage === 'any' || s.stage === st.kind;
      const groups = [...new Set(cat.setups.filter(fits).map((s) => s.group))];
      const addSel = select([{ value: '', label: 'Add a setup…' },
        ...groups.map((g) => ({ group: g, options: cat.setups.filter((s) => s.group === g && fits(s)).map((s) => ({ value: s.id, label: s.label })) }))], '');
      addSel.addEventListener('change', () => {
        if (!addSel.value) return;
        st.setups.push({ id: addSel.value, values: {} });
        renderStages(); check();
      });

      const blocks = st.setups.map((use, j) => {
        const s = byId.get(use.id);
        if (!s) {
          return el('div', { style: 'border:1px dashed var(--border);border-radius:6px;padding:6px 8px;font-size:12px;display:flex;gap:6px;align-items:center' },
            el('span', { style: 'flex:1;color:var(--red)', text: `${use.id.replace(/^addin:/, '')} — this add-in is gone or has a problem (My add-ins…)` }),
            el('button', { class: 'ghost-btn sm', type: 'button', text: '✕', onClick: () => { st.setups.splice(j, 1); renderStages(); check(); } }));
        }
        use.values = use.values || {};
        return el('div', { style: 'border:1px solid var(--border-soft);border-radius:6px;padding:6px 8px' },
          el('div', { style: 'display:flex;align-items:center;gap:6px' },
            el('div', { style: 'font-weight:600;font-size:12px;flex:1', text: s.label }),
            j > 0 ? el('button', { class: 'ghost-btn sm', type: 'button', text: '↑', title: 'Run it earlier', onClick: () => { [st.setups[j - 1], st.setups[j]] = [st.setups[j], st.setups[j - 1]]; renderStages(); check(); } }) : null,
            el('button', { class: 'ghost-btn sm', type: 'button', text: '✕', title: 'Remove', onClick: () => { st.setups.splice(j, 1); renderStages(); check(); } })),
          s.help ? el('div', { style: 'color:var(--muted);font-size:11px;margin:2px 0 4px', text: s.help }) : null,
          ...(s.fields || []).map((f) => setupField(f, use.values, check)));
      });

      let fromField = null;
      if (i === 0) {
        // Your Phase folders and a search (phasepicker.js), the default image first.
        const fromPick = phasePicker({
          profile, standard: 'The default Beam image', value: st.from || '',
          phases: phases.filter((p) => p.state === 'ready' || p.name === from),
          onChange: (v) => { st.from = v; check(); },
        });
        fromField = field('Builds on', fromPick.el, 'Every later stage builds on the one before it.');
      }
      return el('div', { style: 'border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;background:var(--panel)' },
        el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px' },
          el('div', { style: 'font-weight:600', text: `Stage ${i + 1}` }),
          el('div', { style: 'flex:1' }),
          stages.length > 1 ? el('button', { class: 'ghost-btn sm', type: 'button', text: 'Remove stage', onClick: () => { stages.splice(i, 1); renderStages(); check(); } }) : null),
        el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' }, field('Phase name', nameIn), field('This stage', kindSel)),
        fromField,
        el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin:6px 0' }, ...blocks.filter(Boolean)),
        addSel);
    }));
  };

  // Carry on from a phase.yaml already written — a saved one, or one a build left in phase-setups/.
  const openBtn = el('button', {
    class: 'ghost-btn sm', type: 'button', text: 'Open a phase.yaml\u2026',
    title: 'Load an existing phase.yaml as these stages, to change and build again',
    onClick: async () => {
      let r;
      try { r = await window.api.beams.openSetupYaml(); } catch (e) { return toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error', 8000); }
      if (!r) return undefined;
      // Writing by hand: the file's own text, comments and all, into the editor.
      if (handText !== null) {
        handText = r.text;
        handView.setValue(r.text);
        check();
        status(`Opened ${r.file}`, 5000);
        return undefined;
      }
      const hasWork = stages.some((st) => st.setups.length);
      if (hasWork && !await confirm({ title: 'Replace these stages?', message: `Load ${r.file.split('/').pop()} in place of the stages here.`, confirmLabel: 'Load it' })) return undefined;
      stages = r.stages;
      setupName = '';
      renderStages(); check();
      status(`Loaded ${r.stages.length} stage${r.stages.length === 1 ? '' : 's'} from ${r.file}`, 6000);
      if (r.warnings.length) toast(r.warnings.join('\n'), 'info', 12000);
      return undefined;
    },
  });
  const addinsBtn = el('button', {
    class: 'ghost-btn sm', type: 'button', text: 'My add-ins\u2026',
    title: 'Setups of your own — a YAML file each, in a folder you can share',
    onClick: async () => { if (await (await import('./phaseaddins.js')).openAddinManager()) await reloadCatalog(); },
  });
  const addStageBtn = el('button', {
    class: 'ghost-btn sm', type: 'button', text: '+ Add a stage',
    title: 'Another Phase built on the one above — for example files after the tools, or services after both',
    onClick: () => {
      const prev = stages[stages.length - 1];
      const names = new Set([...taken, ...stages.map((s) => s.name)]);
      stages.push({ name: freshName(`${prev?.name || 'stage'}-next`, names), kind: prev?.kind === 'commands' ? 'files' : 'commands', setups: [] });
      renderStages(); check();
    },
  });

  // A saved setup to start from instead of what is on screen.
  const saved = savedSetups();
  const savedSel = saved.length ? select([{ value: '', label: 'Start from a saved setup…' }, ...saved.map((s, i) => ({ value: String(i), label: s.name }))], '') : null;
  savedSel?.addEventListener('change', () => {
    const s = saved[Number(savedSel.value)];
    savedSel.value = '';
    if (!s) return;
    stages = clone(s.stages); setupName = s.name;
    renderStages(); check();
  });

  const regionSel = select(REGIONS, '');
  const streamBox = checkbox('Stream each stage’s log in the tab', true);
  const keep = async () => {
    const name = (setupName || stages[0]?.name || 'setup').trim();
    const others = savedSetups().filter((s) => s.name !== name);
    state.settings = await window.api.settings.set({ phaseSetups: [...others, { name, stages: clone(stages), savedAt: Date.now() }] });
    setupName = name;
    toast(`Kept "${name}" — start from it next time with "Start from a saved setup"`);
  };

  const startBuild = async (close, thenInteractive) => {
    attempted = true;
    // Wait for the latest check rather than one a keystroke behind.
    if (handText !== null) {
      const r = await window.api.beams.checkSetupYaml(handText);
      last = { errors: r.errors || [], warnings: r.warnings || [], incomplete: r.incomplete || [], yaml: handText, names: r.names || [] };
    } else last = await window.api.beams.buildSetup(clone(stages));
    showProblems();
    if (last.errors.length) return toast(last.errors[0], 'error', 7000);
    const existing = (handText !== null ? last.names : stages.map((s) => s.name)).filter((n) => taken.has(n));
    if (existing.length && !await confirm({
      title: `Replace ${existing.join(', ')}?`,
      message: 'Applying a stage whose name is already a Phase replaces its commands or files, and rebuilds it.',
      detail: 'Its parent and kind must stay the same; tsh refuses otherwise.',
      confirmLabel: 'Replace and build',
    })) return undefined;
    close({ region: regionSel.value || undefined, noConsole: support.noConsole ? !streamBox.input.checked : false, thenInteractive });
    return undefined;
  };

  const res = await modal({
    title: 'Build a Phase from setups',
    subtitle: profile.cluster || profile.proxy,
    width: 'min(1220px, 97vw)',
    resize: 'phase-builder',
    render: (body) => {
      body.append(
        el('div', { style: 'display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:12px;height:66vh' },
          (stagesPane.append(...[
            savedSel,
            el('div', { class: 'hint', text: 'Each stage is its own Phase. Commands run as root and run again whenever the stage refreshes (daily, and when the one below it changes); copied files go outside /home; services start in every Beam made from it.' }),
            handNote,
            stagesBox, el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, addStageBtn, openBtn, addinsBtn)].filter(Boolean)), stagesPane),
          el('div', { style: 'display:flex;flex-direction:column;gap:8px;min-height:0' },
            el('div', { style: 'display:flex;align-items:center;gap:8px' }, el('div', { style: 'font-weight:600;flex:1', text: 'phase.yaml' }), handBtn),
            yamlBox, problems)),
        el('div', { style: 'display:flex;gap:14px;align-items:center;margin-top:8px;flex-wrap:wrap' },
          field('Region', regionSel), support.noConsole ? streamBox : null));
      renderStages(); check();
    },
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Keep this setup', onClick: () => keep() },
      {
        label: 'Save phase.yaml…',
        onClick: async () => {
          attempted = true;
          showProblems();
          const text = handText !== null ? handText : last.yaml;
          if (!text) return;
          const r = await window.api.dialog.saveText({ text, title: 'Save phase.yaml', defaultPath: `${stages[0]?.name || 'phase'}.yaml` });
          if (r) status(`Saved ${r.path} — build it with tsh phase apply -f ${r.path}`, 8000);
        },
      },
      {
        /*
         * Command and copy stages are not worked in by hand; an interactive
         * Phase on top of them is — a build console with everything the
         * stages installed, saved with tsh phase snapshot.
         */
        label: 'Build it, then work in it\u2026',
        title: 'tsh phase apply, then New Phase on top of the last stage: an interactive build console you can save',
        onClick: ({ close }) => startBuild(close, true),
      },
      { label: 'Build it', class: 'primary-btn', onClick: ({ close }) => startBuild(close, false) },
    ],
  });
  if (!res) return false;
  const written = await window.api.beams.writeSetup(handText !== null ? { yaml: handText } : { stages: clone(stages) }).catch((e) => ({ ok: false, errors: [e.message] }));
  if (!written.ok) { toast(written.errors?.[0] || 'Could not write the phase.yaml', 'error'); return false; }
  const { thenInteractive, ...applyOpts } = res;
  let run;
  try { run = await window.api.beams.phaseApplyArgs({ proxy: profile.proxy, home: profile.homeDir, file: written.file, ...applyOpts }); } catch (e) { toast(e.message, 'error'); return false; }
  const lastStage = written.stages[written.stages.length - 1];
  const ok = await runPhaseBuild(profile, run, `Phase apply · ${written.stages.join(' → ')}`, {
    kind: 'apply', name: lastStage, mode: 'apply', commandsFile: written.file,
    stages: written.stages, region: res.region || '',
  });
  refreshPhases(profile).catch(() => {});
  // On to the interactive part once the stages are saved: New Phase, built on the last one.
  if (ok && thenInteractive) {
    const { newPhase } = await import('./beams.js');
    return newPhase(profile, { mode: 'from', source: lastStage });
  }
  if (!ok && thenInteractive) toast('The setup did not finish building, so there is nothing to work in yet — the tab has its log', 'error', 9000);
  return ok;
}
