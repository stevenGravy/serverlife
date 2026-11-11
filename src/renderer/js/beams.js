import { state } from './state.js';
import { el } from './util.js';
import { modal, toast, status, confirm, field, textInput, select, checkbox, contextMenu } from './ui.js';
import { openHost, splitActivePane } from './sessions.js';
import { phasePicker } from './phasepicker.js';

/**
 * Beams: ephemeral sandbox VMs, listed and driven from the host list.
 *
 * They are kept apart from the cluster's nodes on purpose. A node is
 * inventory — it was there yesterday and will be there tomorrow. A beam is
 * something you started, that expires by itself, and that you are expected to
 * throw away; a list that mixed the two would make both harder to read, and
 * would put "Delete" next to a production host.
 *
 * Everything else about a beam is deliberately ordinary. Opening one creates a
 * connection like any other, which is what gives it a terminal with a file
 * browser, the transfer queue, synchronise, compare and drag-and-drop without
 * a line of beam-specific code in any of them.
 */

/** Regions offered when starting one. Blank lets the service choose. */
export const REGIONS = [
  { value: '', label: 'Wherever the cluster puts it' },
  { value: 'us-east-1', label: 'us-east-1' },
  { value: 'us-east-2', label: 'us-east-2' },
  { value: 'us-west-1', label: 'us-west-1' },
  { value: 'us-west-2', label: 'us-west-2' },
  { value: 'eu-west-1', label: 'eu-west-1' },
  { value: 'eu-central-1', label: 'eu-central-1' },
  { value: 'ap-southeast-1', label: 'ap-southeast-1' },
  { value: 'ap-northeast-1', label: 'ap-northeast-1' },
];

/** The profiles worth asking about beams: logged in, and not hidden. */
export function beamProfiles() {
  const hidden = new Set(state.settings.hiddenBeamProxies || []);
  return (state.teleportProfiles || []).filter((p) => !p.expired && !hidden.has(p.proxy));
}

/** Has this proxy been marked by hand, whatever the probe thinks? */
/*
 * Teleport's own beams clusters live under beams.sh and beams.run, so those
 * are beams clusters from the start, without waiting on the probe — which a
 * lapsed login or a slow proxy can fail, hiding the beams of a cluster that
 * has nothing else. Unmarking one is remembered separately (notBeamProxies),
 * so the default is the default and a choice to turn it off still holds.
 */
const BEAMS_DOMAINS = /(^|\.)beams\.(sh|run)$/i;
export function beamsByName(proxy) {
  const host = String(proxy || '').replace(/^[a-z]+:\/\//i, '').split('/')[0].replace(/:\d+$/, '');
  return BEAMS_DOMAINS.test(host);
}

export function markedAsBeams(proxy) {
  if ((state.settings.beamProxies || []).includes(proxy)) return true;
  return beamsByName(proxy) && !(state.settings.notBeamProxies || []).includes(proxy);
}

export function beamsSupported(proxy) {
  const probe = state.beamSupport?.get(proxy);
  return markedAsBeams(proxy) || !!probe?.ok;
}

export function beamsFor(proxy) {
  return state.beams?.get(proxy) || [];
}

/**
 * Read the beams for every cluster that has them.
 *
 * The capability probe is cached in the main process, so this is one cheap
 * call per cluster and one list call for the clusters that answered. A
 * cluster without the service is asked once and then left alone.
 */
export async function refreshBeams({ refresh = false, proxy = null } = {}) {
  state.beams = state.beams || new Map();
  state.beamSupport = state.beamSupport || new Map();

  // One cluster's heading asked: leave the others alone rather than making a
  // per-cluster refresh quietly cost every cluster a round trip.
  const wanted = proxy ? beamProfiles().filter((p) => p.proxy === proxy) : beamProfiles();
  await Promise.all(wanted.map(async (p) => {
    try {
      const probe = await window.api.beams.supported({ proxy: p.proxy, home: p.homeDir, refresh });
      state.beamSupport.set(p.proxy, probe);
      if (!probe.ok && !markedAsBeams(p.proxy)) {
        state.beams.delete(p.proxy);
        return;
      }
      const r = await window.api.beams.list({ proxy: p.proxy, home: p.homeDir });
      state.beams.set(p.proxy, r.ok ? r.beams : []);
      // Whether this tsh can do Phases, for the tab beside the beams. Asked of
      // the binary, and cached by it, so this is free after the first time.
      const can = await window.api.beams.addSupport({ proxy: p.proxy, home: p.homeDir }).catch(() => null);
      phaseSupport.set(p.proxy, !!can?.phases);
      // A list already read stays current with the beams around it.
      if (can?.phases && phaseLists.has(p.proxy)) refreshPhases(p);
    } catch {
      state.beams.delete(p.proxy);
    }
  }));
  state.emit('beams');
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

/*
 * A Phase is a saved, reusable beam image. Listed beside a cluster's beams
 * only where this tsh has `tsh phase` (see addSupport in main/beams.js):
 * v18's does not, and a tab offering what it cannot run would only fail.
 */
const phaseSupport = new Map();   // proxy -> whether this tsh can do Phases
const phaseLists = new Map();     // proxy -> { ok, phases, error, loading, at }
const beamTabs = new Map();       // proxy -> 'beams' | 'phases' | 'failed', for this run
const failedLists = new Map();    // proxy -> { ok, failed, error, loading, at }

export function failedListFor(proxy) { return failedLists.get(proxy) || null; }

/** `tsh phase ls-failed`, for one cluster. */
export async function refreshFailedPhases(profile) {
  const proxy = profile.proxy;
  if (!phasesSupported(proxy)) return;
  failedLists.set(proxy, { ...(failedLists.get(proxy) || { failed: [] }), loading: true });
  state.emit('beams');
  const r = await window.api.beams.failedPhases({ proxy, home: profile.homeDir })
    .catch((e) => ({ ok: false, error: e.message, failed: [] }));
  failedLists.set(proxy, { ...r, loading: false, at: Date.now() });
  state.emit('beams');
}

/** One failed build's snapshot: copy it, or look at the Phase it was for. */
export function failedMenu(x, y, profile, f) {
  const ref = f.digest ? `${f.phase}@${f.digest}` : f.phase;
  contextMenu(x, y, [
    { label: `${f.phase} \u00B7 failed`, heading: true },
    { label: 'History and beams of the Phase\u2026', icon: '\u2630', onClick: () => showPhaseDetails(profile, f.phase) },
    f.digest ? {
      label: 'Copy the failed snapshot (name@digest)', icon: '\u29C9',
      onClick: () => { window.api.clipboard.write(ref); status('Copied ' + ref); },
    } : null,
    {
      label: 'Edit the Phase in a build console\u2026', icon: '\u270E',
      onClick: () => editPhase(profile, { name: f.phase }),
    },
  ].filter(Boolean));
}

export function phasesSupported(proxy) { return !!phaseSupport.get(proxy); }
export function phaseListFor(proxy) { return phaseLists.get(proxy) || null; }
export function beamTabFor(proxy) { return phasesSupported(proxy) ? (beamTabs.get(proxy) || 'beams') : 'beams'; }

export function setBeamTab(profile, tab) {
  beamTabs.set(profile.proxy, tab);
  // Read the first time it is looked at, not for every cluster at launch.
  if (tab === 'phases' && !phaseLists.has(profile.proxy)) refreshPhases(profile);
  if (tab === 'failed') refreshFailedPhases(profile);
  state.emit('beams');
}

/** `tsh phase ls`, for one cluster. */
export async function refreshPhases(profile) {
  const proxy = profile.proxy;
  if (!phasesSupported(proxy)) return;
  phaseLists.set(proxy, { ...(phaseLists.get(proxy) || { phases: [] }), loading: true });
  state.emit('beams');
  const r = await window.api.beams.phases({ proxy, home: profile.homeDir })
    .catch((e) => ({ ok: false, error: e.message, phases: [] }));
  phaseLists.set(proxy, { ...r, loading: false, at: Date.now() });
  // A refreshed Phase list may have new failures behind it — the Failed tab
  // only shows when there are some, so its list has to keep up too.
  refreshFailedPhases(profile);
  if (r.ok) await settleBuilds(proxy, r.phases).catch(() => {});
  state.emit('beams');
}

/** How a recorded build ended, judged from its Phase: saved, failed, or not yet known. */
function judge(entry, ph) {
  if (ph?.state === 'ready' && (ph.publishedAt || 0) >= entry.startedAt - 60000) return 'saved';
  if (/fail|error/i.test(ph?.state || '')) return 'failed';
  return null;
}

/*
 * A build whose ending was not known when its tab closed — the cluster can
 * take a moment to list a snapshot it has just saved — is settled the next
 * time the list is read, so its record, and the history built from it, says
 * what really happened.
 */
async function settleBuilds(proxy, phases) {
  const byName = new Map(phases.map((p) => [p.name, p]));
  let changed = false;
  const next = journal().map((e) => {
    if (e.proxy !== proxy || !e.name || !['running', 'unknown'].includes(e.result)) return e;
    const ph = byName.get(e.name);
    const result = judge(e, ph);
    if (!result) return e;
    changed = true;
    return { ...e, result, digest: ph.digest || e.digest || '', error: result === 'failed' ? (ph.lastError || '') : '' };
  });
  if (changed) await saveJournal(next);
}

/** Delete a Phase, after saying what that does and does not take with it. */
export async function removePhase(profile, phase) {
  if (!await confirm({
    title: `Delete Phase ${phase.name}?`,
    message: 'The saved image goes, and nothing new can start from it.',
    detail: 'Beams already started from it keep running. Phases forked from it may stop rebuilding.',
    confirmLabel: 'Delete it',
    danger: true,
  })) return false;
  status(`Deleting Phase ${phase.name}…`, 0);
  const r = await window.api.beams.removePhase({ proxy: profile.proxy, home: profile.homeDir, name: phase.name })
    .catch((e) => ({ ok: false, output: e.message }));
  status('');
  if (!r.ok) {
    toast(r.output || `Could not delete ${phase.name}`, 'error', 9000);
  } else {
    toast(`Deleted Phase ${phase.name}`, 'success');
  }
  await refreshPhases(profile);
  return r.ok;
}

/* ---- The builds this app started, and how each ended ---- */

/*
 * A record of every Phase build started from here: how it was made (from the
 * base image, on top of a Phase, forked from one, from a command file), when,
 * and how it ended. tsh's own list cannot say the first part — a fork comes
 * back with its *base image* as its parent, not the Phase it was forked from —
 * so without this a Phase's history would leave out the step that made it.
 * Kept in settings, newest first, capped.
 */
const JOURNAL_MAX = 200;
const journal = () => state.settings.phaseJournal || [];
async function saveJournal(next) {
  state.settings = await window.api.settings.set({ phaseJournal: next.slice(0, JOURNAL_MAX) });
}

/** The builds recorded for one Phase on one cluster, newest first. */
export function buildsOf(proxy, name) {
  return journal().filter((e) => e.proxy === proxy && e.name === phaseName(name));
}

/** How a Phase was first made, if it was made from here: the build that saved it. */
function originOf(proxy, name) {
  return buildsOf(proxy, name).filter((e) => e.kind === 'add' && e.result === 'saved').pop() || null;
}

/**
 * Run a Phase build in a terminal tab.
 *
 * `tsh phase add` and `tsh phase edit` open a build console — a shell on a
 * build beam — and only end when the build does (`tsh phase snapshot --final`
 * inside it, or leaving it), so they need a real terminal, as a login does.
 *
 * How it ended is read from the Phase, not from tsh's exit code: the console
 * closing ends tsh with 255 even when the snapshot was saved, which read as a
 * failure. A Phase saved since the build started is a success; one marked
 * failed brings its own error and the way to look inside it.
 */
export async function runPhaseBuild(profile, run, title, meta) {
  const { openLocalShell } = await import('./sessions.js');
  const before = new Set((phaseListFor(profile.proxy)?.phases || []).map((p) => p.name));
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    proxy: profile.proxy, startedAt: Date.now(), result: 'running', ...meta,
  };
  await saveJournal([entry, ...journal()]);
  status(meta.commandsFile
    ? `Building from ${meta.commandsFile} — the log is in the new tab`
    : 'In the build console: install what the image needs, then run tsh phase snapshot --final', 15000);
  return new Promise((resolve) => {
    openLocalShell(undefined, {
      command: run.command, args: run.args, teleportHome: run.teleportHome, title,
      onExit: async (code) => {
        // The cluster can take a moment to list what was just saved: look a
        // few times before calling it unknown (settleBuilds catches it later).
        let all = [];
        let name = entry.name;
        let ph = null;
        let result = null;
        for (let i = 0; i < 6 && !result; i++) {
          if (i) await new Promise((r) => setTimeout(r, 5000));
          await refreshPhases(profile).catch(() => {});
          all = phaseListFor(profile.proxy)?.phases || [];
          // A name left to tsh is the one that was not there before.
          name = entry.name || all.find((p) => !before.has(p.name))?.name || '';
          ph = name ? all.find((p) => p.name === name) : null;
          result = ph ? judge(entry, ph) : null;
        }
        if (!result) result = code === 0 ? 'saved' : 'unknown';
        await saveJournal(journal().map((e) => (e.id === entry.id ? {
          ...e, name, result, endedAt: Date.now(), exitCode: code,
          digest: ph?.digest || '', error: result === 'failed' ? (ph?.lastError || '') : '',
        } : e)));
        if (result === 'saved') toast(`Saved Phase ${name}${ph?.digest ? ' — ' + ph.digest.slice(0, 19) : ''}`, 'success', 9000);
        else if (result === 'failed') toast(`Phase ${name} failed to build.\n${ph?.lastError || 'tsh phase ls-failed has the snapshot it left.'}`, 'error', 20000);
        else status(`${title}: tsh exited with ${code} — the tab has what it said`, 9000);
        state.emit('beams');
        resolve(result === 'saved');
      },
    }).catch((e) => { toast(e.message, 'error'); resolve(false); });
  });
}

/**
 * A new Phase: from the default base image, built on top of another Phase
 * (`--from`), or forked from one's last saved files (`--fork-from`).
 */
export async function newPhase(profile, { mode = 'base', source = '' } = {}) {
  const opts = { proxy: profile.proxy, home: profile.homeDir };
  const nameIn = textInput({ placeholder: 'Leave empty and tsh picks a name' });
  const modeSel = select([
    { value: 'base', label: 'The default base image' },
    { value: 'from', label: 'Build on top of a Phase (--from)' },
    { value: 'fork', label: 'Fork a Phase\u2019s saved files (--fork-from)' },
  ], mode);
  /*
   * How it is built: by hand in a console, or from a command file — a YAML
   * recipe tsh runs and streams the log of. A fork starts from saved files,
   * so it is always a console.
   */
  const can = (await window.api.beams.addSupport(opts).catch(() => null)) || {};
  const buildSel = select([
    { value: 'console', label: 'In an interactive build console' },
    { value: 'file', label: 'From a command file (--commands-file)' },
    can.copy ? { value: 'copy', label: 'Copy files from this computer (--copy)' } : null,
  ].filter(Boolean), 'console');
  // Copied files: local source and where it goes, one row each.
  const copyRows = [];
  const copyList = el('div', { style: 'display:flex;flex-direction:column;gap:6px' });
  const addCopyRow = (from = '', to = '') => {
    const fromIn = textInput({ value: from, placeholder: '/local/path/config' });
    const toIn = textInput({ value: to, placeholder: '/opt/app/config' });
    const row = { fromIn, toIn };
    copyRows.push(row);
    const line = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr auto auto;gap:6px' }, fromIn, toIn,
      el('button', { class: 'ghost-btn sm', type: 'button', text: 'Browse…', onClick: async () => {
        const f = await window.api.dialog.openFiles({ single: true, title: 'A file to copy into the Phase' });
        if (f && f[0]) { fromIn.value = f[0]; sync(); }
      } }),
      el('button', { class: 'ghost-btn sm', type: 'button', text: '✕', onClick: () => { copyRows.splice(copyRows.indexOf(row), 1); line.remove(); sync(); } }));
    for (const n of [fromIn, toIn]) n.addEventListener('input', () => sync());
    copyList.append(line);
  };
  const copyField = field('Files to copy', el('div', {}, copyList,
    el('button', { class: 'ghost-btn sm', type: 'button', text: '+ Another file', style: 'margin-top:6px', onClick: () => { addCopyRow(); sync(); } })),
  'From this computer (left) to an absolute path in the image outside /home (right). A folder merges into its destination.');
  addCopyRow();
  const noConsoleBox = can.noConsole ? checkbox("Don't open a console — start the build and come back to it", false) : null;
  const fileIn = textInput({ placeholder: '/path/to/build.yaml' });
  const fileField = field('Command file', el('div', {},
    fileIn,
    el('div', { style: 'display:flex;gap:6px;margin-top:6px' }, el('button', {
      class: 'ghost-btn sm', text: 'Browse\u2026',
      onClick: async () => {
        const f = await window.api.dialog.openFiles({ single: true, title: 'Choose the command file (YAML)' });
        if (f && f[0]) { fileIn.value = f[0]; sync(); }
      },
    }))),
  'Commands run in order as root, outside /home. Each takes command and args (and optionally env, '
    + 'workdir, comment) — e.g. command: /bin/sh, args: [-c, "apt-get install -y git"]. '
    + 'shell: is only for tsh phase apply files.');
  // Typed as well as picked: --from takes an upstream image such as
  // default:v1, and either takes name@sha256:digest for one exact snapshot.
  const sourceIn = phasePicker({
    profile, typed: true, value: source,
    phases: (phaseListFor(profile.proxy)?.phases || []).filter((p) => p.state === 'ready'),
    onChange: () => sync(),
  });
  const sourceField = field('Phase', sourceIn.el,
    'Pick one of yours — your folders, or search — or type any Phase, upstream image (default:v1) or exact snapshot.');
  const myRoles = (await window.api.beams.addSupport(opts).catch(() => null))?.roles
    ? [...(profile.roles || [])].sort() : [];
  const roleBoxes = myRoles.map((r) => checkbox(r, false));
  const regionSel = select(REGIONS, '');
  const preview = el('div', {
    style: 'font-family:var(--mono);font-size:11px;color:var(--text-dim);background:var(--panel-2);'
      + 'border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;word-break:break-all',
  });
  const collect = () => {
    const m = modeSel.value;
    return {
      ...opts,
      name: nameIn.value.trim() || undefined,
      from: m === 'from' ? sourceIn.value.trim() || undefined : undefined,
      forkFrom: m === 'fork' ? sourceIn.value.trim() || undefined : undefined,
      commandsFile: m !== 'fork' && buildSel.value === 'file' ? fileIn.value.trim() || undefined : undefined,
      copies: m !== 'fork' && buildSel.value === 'copy'
        ? copyRows.map((r) => ({ from: r.fromIn.value.trim(), to: r.toIn.value.trim() })).filter((c) => c.from || c.to) : undefined,
      noConsole: noConsoleBox?.input.checked || undefined,
      roles: myRoles.filter((r, i) => roleBoxes[i].input.checked),
      region: regionSel.value || undefined,
    };
  };
  const sync = async () => {
    sourceField.classList.toggle('hidden', modeSel.value === 'base');
    // A fork is always a console; a command file only applies to the others.
    buildSel.disabled = modeSel.value === 'fork';
    if (modeSel.value === 'fork') buildSel.value = 'console';
    fileField.classList.toggle('hidden', buildSel.value !== 'file');
    copyField.classList.toggle('hidden', buildSel.value !== 'copy');
    try {
      const r = await window.api.beams.phaseAddArgs(collect());
      preview.textContent = ['tsh', ...r.args].join(' ');
    } catch (e) { preview.textContent = e.message; }
  };
  for (const n of [nameIn, fileIn]) n.addEventListener('input', sync);
  for (const n of [modeSel, regionSel, buildSel]) n.addEventListener('change', sync);
  for (const b of roleBoxes) b.input.addEventListener('change', sync);
  noConsoleBox?.input.addEventListener('change', sync);

  const res = await modal({
    title: 'New Phase',
    subtitle: profile.cluster || profile.proxy,
    width: 'min(560px, 94vw)',
    render: (body, { close }) => {
      /*
       * The other way to make one: tools, services and files picked as
       * setups and built with tsh phase apply — said here, where someone
       * about to install things by hand in a console would want to know.
       */
      const builderNote = can.apply ? el('div', {
        class: 'hint', style: 'margin:0 0 10px;padding:7px 9px;border:1px solid var(--border);border-radius:var(--radius);background:var(--panel-2)',
      },
        'Installing tools or services? Pick them as setups — Go, Postgres, cloud CLIs, your dotfiles — and they are rebuilt for you. ',
        el('button', {
          class: 'ghost-btn sm', type: 'button', text: 'Build it from setups instead\u2026',
          title: 'Build a Phase from setups (tsh phase apply)',
          onClick: () => close({ switchToBuilder: true, from: modeSel.value === 'from' ? sourceIn.value.trim() : '' }),
        })) : null;
      body.append(...[
        builderNote,
        field('Name', nameIn),
        field('Start from', modeSel),
        sourceField,
        field('Build it', buildSel),
        fileField,
        copyField,
        noConsoleBox,
        myRoles.length
          ? field('Delegate roles', el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 14px' }, ...roleBoxes),
            'The roles its builds may act as. None ticked: your own delegation permissions.')
          : null,
        field('Region', regionSel, 'Where the build runs, and where the Phase is kept.'),
        el('div', { class: 'hint', style: 'margin:4px 0 6px' },
          'Runs in a new tab. In a console: install what the image needs, then run '
          + 'tsh phase snapshot --final to save it and end the build. From a file: the log streams there.'),
        preview,
      ].filter(Boolean));
      sync();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Start the build', class: 'primary-btn',
        onClick: ({ close }) => {
          const v = collect();
          if (modeSel.value !== 'base' && !v.from && !v.forkFrom) return toast('Which Phase?', 'error');
          if (buildSel.value === 'file' && modeSel.value !== 'fork' && !v.commandsFile) return toast('Which command file?', 'error');
          if (buildSel.value === 'copy' && modeSel.value !== 'fork' && !v.copies?.length) return toast('Which files?', 'error');
          close(v);
          return undefined;
        },
      },
    ],
  });
  if (!res) return false;
  if (res.switchToBuilder) return (await import('./phasebuilder.js')).openPhaseBuilder(profile, { from: res.from || '' });
  let run;
  try { run = await window.api.beams.phaseAddArgs(res); } catch (e) { toast(e.message, 'error'); return false; }
  const what = res.forkFrom ? `fork of ${res.forkFrom}` : res.from ? `on ${res.from}` : 'new';
  return runPhaseBuild(profile, run, `Phase build · ${res.name || what}`, {
    kind: 'add', name: res.name || '',
    mode: res.forkFrom ? 'fork' : res.from ? 'from' : 'base',
    source: res.forkFrom || res.from || '', commandsFile: res.commandsFile || '',
    copies: res.copies || [], roles: res.roles || [], region: res.region || '',
  });
}

/**
 * Replace what a command or copy Phase is built from: a new command file
 * (`tsh phase edit --commands-file`), or its files copied again
 * (`--copy`). Either rebuilds it; its children follow.
 */
export async function replacePhaseInputs(profile, phase) {
  const copy = phase.strategy === 'copy';
  let opts = {};
  if (copy) {
    const rows = await new Promise((resolve) => {
      const list = el('div', { style: 'display:flex;flex-direction:column;gap:6px' });
      const rowsAt = [];
      const add = () => {
        const fromIn = textInput({ placeholder: '/local/path' });
        const toIn = textInput({ placeholder: '/opt/app/config' });
        rowsAt.push({ fromIn, toIn });
        list.append(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:6px' }, fromIn, toIn));
      };
      add();
      modal({
        title: `Copy files into ${phase.name} again`,
        width: 'min(620px, 94vw)',
        render: (body) => body.append(
          el('div', { class: 'hint', style: 'margin-bottom:8px', text: 'The new copy starts from its parent, not from the files it has now: list every file it should keep.' }),
          list, el('button', { class: 'ghost-btn sm', type: 'button', text: '+ Another file', style: 'margin-top:6px', onClick: add })),
        buttons: [
          { label: 'Cancel', value: null },
          { label: 'Copy and rebuild', class: 'primary-btn', onClick: ({ close }) => close(rowsAt.map((r) => ({ from: r.fromIn.value.trim(), to: r.toIn.value.trim() })).filter((c) => c.from || c.to)) },
        ],
      }).then(resolve);
    });
    if (!rows || !rows.length) return false;
    opts = { copies: rows };
  } else {
    const f = await window.api.dialog.openFiles({ single: true, title: `A new command file for ${phase.name} (YAML)` });
    if (!f || !f[0]) return false;
    opts = { commandsFile: f[0] };
  }
  let run;
  try { run = await window.api.beams.phaseEditArgs({ proxy: profile.proxy, home: profile.homeDir, name: phase.name, ...opts }); }
  catch (e) { toast(e.message, 'error'); return false; }
  return runPhaseBuild(profile, run, `Phase edit · ${phase.name}`, { kind: 'edit', name: phase.name, mode: 'edit', commandsFile: opts.commandsFile || '', copies: opts.copies || [] });
}

/**
 * Save, or save and finish, a Phase's running build — `tsh phase snapshot`
 * inside its build Beam. Whether it was saved is read back from the Phase,
 * since --final ends the Beam the command ran in.
 */
export async function snapshotBuild(profile, phase, { final = false, force = false } = {}) {
  if (!phase.buildBeam) return toast(`${phase.name} has no build running`, 'error');
  if (final && !await confirm({
    title: `Save ${phase.name} and end its build?`,
    message: 'Saves a snapshot, then ends the build Beam. Anything changed after the snapshot is lost.',
    detail: force ? 'Changes outside /home are left out of the snapshot.' : 'If it changed files outside /home, it refuses and nothing is saved.',
    confirmLabel: 'Save and finish',
  })) return false;
  status(`${final ? 'Saving and finishing' : 'Saving'} ${phase.name}…`, 60000);
  const before = phase.publishedAt || 0;
  const r = await window.api.beams.phaseSnapshot({ proxy: profile.proxy, home: profile.homeDir, beam: phase.buildBeam, final, force });
  await refreshPhases(profile).catch(() => {});
  const now = (phaseListFor(profile.proxy)?.phases || []).find((p) => p.name === phase.name);
  if ((now?.publishedAt || 0) > before || (r.ok && !final)) {
    toast(`Saved ${phase.name}${final ? ' and ended its build' : ''}`, 'success', 8000);
    return true;
  }
  // The usual refusal: files changed outside /home. Offer the way past it.
  if (/outside \/home|--force/i.test(r.output || '') && !force) {
    if (await confirm({ title: 'Changes outside /home', message: 'The snapshot was refused because files outside /home changed.', detail: (r.output || '').slice(-1200), confirmLabel: 'Save without them (--force)' })) {
      return snapshotBuild(profile, phase, { final, force: true });
    }
    return false;
  }
  toast(`Not saved: ${(r.output || 'tsh phase snapshot said nothing').slice(-600)}`, 'error', 15000);
  return false;
}

/** The services running in a Beam — from its Phase's services: — and each one's log. */
export async function showBeamServices(beam) {
  const opts = { proxy: beam.proxy, home: beam.home || undefined, name: beam.id };
  const r = await window.api.beams.services(opts);
  if (!r.ok) return toast(r.error || 'Could not read its services', 'error', 9000);
  const logBox = el('pre', {
    style: 'font-family:var(--mono);font-size:11px;white-space:pre-wrap;max-height:42vh;overflow:auto;margin:8px 0 0;'
      + 'background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;user-select:text',
    text: 'Pick a service to read its log.',
  });
  const show = async (svc) => {
    logBox.textContent = `Reading ${svc}…`;
    const l = await window.api.beams.serviceLogs({ ...opts, service: svc });
    logBox.textContent = l.output || '(no output yet)';
  };
  await modal({
    title: `Services in ${beam.id}`,
    subtitle: 'beam-init, from the Phase\u2019s services',
    width: 'min(760px, 94vw)',
    render: (body) => body.append(
      r.services.length
        ? el('div', { style: 'display:flex;flex-direction:column;gap:4px' }, ...r.services.map((s) => el('div', {
          class: 'sb-item', style: 'display:flex;gap:8px;cursor:pointer',
          onClick: () => show(s.name),
        }, el('span', { class: 'name', style: 'flex:1', text: s.name }), el('span', { class: 'tag', text: String(s.status || '') }))))
        : el('div', { class: 'hint', text: 'No services — its Phase declares none.' }),
      logBox),
    buttons: [{ label: 'Close', value: null }],
  });
  return true;
}

/** `tsh phase edit`: change a Phase in place, in a build console. */
export async function editPhase(profile, phase) {
  if (!await confirm({
    title: `Edit ${phase.name} in place?`,
    message: 'Opens a build console on its saved files; saving replaces the Phase.',
    detail: 'tsh refuses if other Phases are built from it — fork it instead.',
    confirmLabel: 'Open the build console',
  })) return false;
  let run;
  try { run = await window.api.beams.phaseEditArgs({ proxy: profile.proxy, home: profile.homeDir, name: phase.name }); }
  catch (e) { toast(e.message, 'error'); return false; }
  return runPhaseBuild(profile, run, `Phase edit · ${phase.name}`, { kind: 'edit', name: phase.name, mode: 'edit' });
}

/* ---- Where a Phase came from, and what uses it ---- */

/** `name@sha256:…` and `name` both name the Phase `name`. */
const phaseName = (ref) => String(ref || '').split('@')[0];

/**
 * A Phase's history and what depends on it.
 *
 * From the cluster's list, the chain of parents back to the base image; from
 * this app's own record of the builds it ran, the fork that made it, which the
 * list does not keep (see the journal above). `how` on each step says how it
 * came from the one before: built on it, forked from it, or the base image.
 */
export function phaseRelations(proxy, name) {
  const all = phaseListFor(proxy)?.phases || [];
  const byName = new Map(all.map((p) => [p.name, p]));
  const chain = [];
  const seen = new Set();
  let at = byName.get(phaseName(name));
  while (at && !seen.has(at.name)) {
    seen.add(at.name);
    const origin = originOf(proxy, at.name);
    const forked = origin?.mode === 'fork' && origin.source;
    chain.unshift({ ...at, how: forked ? 'fork' : 'from', origin });
    const up = forked ? phaseName(origin.source) : phaseName(at.parent);
    const next = byName.get(up);
    if (!next && up) {
      // The root: a base image, or a Phase no longer listed.
      chain.unshift({ name: forked ? origin.source : String(at.parent), base: !forked, gone: !!forked });
      break;
    }
    at = next;
  }
  const mine = phaseName(name);
  const forksOf = new Set(journal()
    .filter((e) => e.proxy === proxy && e.kind === 'add' && e.result === 'saved' && e.mode === 'fork' && phaseName(e.source) === mine)
    .map((e) => e.name));
  return {
    chain,
    children: all
      .filter((p) => p.name !== mine && (forksOf.has(p.name) || (!originOf(proxy, p.name) && phaseName(p.parent) === mine)
        || originOf(proxy, p.name)?.mode === 'from' && phaseName(originOf(proxy, p.name).source) === mine))
      .map((p) => ({ ...p, how: forksOf.has(p.name) ? 'fork' : 'from' })),
    beams: beamsFor(proxy).filter((b) => b.phase && phaseName(b.phase) === mine),
    builds: buildsOf(proxy, mine),
  };
}

/** `default:v1 → sage-garden ⑂ my-fork`, for a menu line: ⑂ marks a fork. */
function lineageText(rel, fallback) {
  if (!rel.chain.length) return fallback;
  return rel.chain.map((p, i) => (i ? (p.how === 'fork' ? ' ⑂ ' : ' → ') : '') + p.name).join('');
}

/** The whole story of one Phase: where it came from, what is built on it, what runs it. */
export async function showPhaseDetails(profile, name) {
  if (!phaseListFor(profile.proxy)) await refreshPhases(profile);
  const rel = phaseRelations(profile.proxy, name);
  const when = (ms) => (ms ? new Date(ms).toLocaleString() : '');
  const section = (title, ...rows) => el('div', { style: 'margin-bottom:14px' },
    el('div', { class: 'field-label', style: 'font-weight:600;margin-bottom:6px', text: title }), ...rows);
  const line = (text, dim, extra = '') => el('div', {
    style: 'font-size:12px;padding:2px 0;white-space:pre-wrap;' + (dim ? 'color:var(--muted);' : '') + extra, text,
  });
  const me = rel.chain[rel.chain.length - 1];
  const howText = (p) => (p.how === 'fork' ? 'forked from the one above' : 'built on the one above');
  const buildLine = (e) => line([
    when(e.startedAt),
    e.kind === 'edit' ? 'edited in place'
      : e.mode === 'fork' ? `forked from ${e.source}` : e.mode === 'from' ? `built on ${e.source}` : 'from the base image',
    e.commandsFile ? `command file ${e.commandsFile}` : (e.kind === 'add' ? 'build console' : ''),
    e.result,
  ].filter(Boolean).join(' · ') + (e.error ? '\n' + e.error : ''), e.result !== 'saved', e.result === 'failed' ? 'color:var(--red)' : '');
  await modal({
    title: `Phase ${phaseName(name)}`,
    subtitle: profile.cluster || profile.proxy,
    width: 'min(660px, 94vw)',
    render: (body) => {
      if (!me || me.base || me.gone) {
        body.append(line(`${name} is not in this cluster’s Phase list (tsh phase ls) — deleted, or someone else’s.`, true));
        if (rel.builds.length) body.append(section('Builds started from ServerLife', ...rel.builds.map(buildLine)));
        return;
      }
      body.append(
        section('History',
          ...rel.chain.map((p, i) => el('div', { style: 'display:flex;gap:8px;align-items:baseline;padding:3px 0' },
            el('span', { style: 'color:var(--muted);width:14px', text: !i ? '●' : p.how === 'fork' ? '⑂' : '↳' }),
            el('span', { style: 'font-weight:' + (p === me ? 600 : 400), text: p.name }),
            el('span', {
              style: 'font-size:11px;color:var(--muted)',
              text: p.base ? 'base image' : p.gone ? 'no longer listed'
                : [i ? howText(p) : '', p.strategy, p.state, p.publishedAt ? 'saved ' + when(p.publishedAt) : '']
                  .filter(Boolean).join(' · '),
            })))),
        section('This snapshot',
          line(me.digest ? `${me.name}@${me.digest}` : 'no snapshot saved yet'),
          me.lastError ? line(me.lastError, false, 'color:var(--red)') : null,
          me.nextBuild ? line(`next rebuild ${when(me.nextBuild)}`, true) : null,
          line([me.region, me.owner].filter(Boolean).join(' · '), true),
          me.roles?.length ? line('roles delegated to its builds: ' + me.roles.join(', '), true) : null),
        section(`Built or forked from it (${rel.children.length})`,
          ...(rel.children.length
            ? rel.children.map((c) => line(`${c.how === 'fork' ? '⑂ forked' : '↳ built on it'}: ${c.name} · ${c.state}`
              + (c.publishedAt ? ' · saved ' + when(c.publishedAt) : '')))
            : [line('none', true)])),
        section(`Beams running it (${rel.beams.length})`,
          ...(rel.beams.length
            ? rel.beams.map((b) => line(`${b.id} · ${b.region || ''}${expiresIn(b) ? ' · ' + expiresIn(b) : ''}`
              + (b.phase.includes('@') ? ` · snapshot ${b.phase.split('@')[1].slice(0, 19)}` : '')))
            : [line('none', true)])),
        section(`Builds started from ServerLife (${rel.builds.length})`,
          ...(rel.builds.length ? rel.builds.map(buildLine) : [line('none recorded here', true)])));
    },
    buttons: [{ label: 'Close', value: null }],
  });
}

/** What to do with one Phase. */
export async function phaseMenu(x, y, profile, phase, groupKey) {
  const rel = phaseRelations(profile.proxy, phase.name);
  // Dynamic, not static: sidebar.js already imports phaseMenu from here,
  // and a static import back would close the cycle — same workaround
  // kubepanel.js's own openKubeContextMenu already uses for the same
  // reason, for the same folderMenuFor.
  const { folderMenuFor } = await import('./sidebar.js');
  const folderItem = groupKey
    ? folderMenuFor({ id: `phase:${profile.proxy}:${phase.name}`, name: phase.name, labels: {} }, { groupKey })
    : null;
  contextMenu(x, y, [
    // Its history and its users, at the top: what the menu is about.
    {
      label: 'History and beams\u2026', icon: '\u2630',
      sub: [
        // The step before it: forked from a Phase, built on one, or on a base image.
        (() => {
          const prev = rel.chain[rel.chain.length - 2];
          const me = rel.chain[rel.chain.length - 1];
          if (!prev) return phase.parent ? 'from ' + phase.parent : '';
          return (me?.how === 'fork' ? 'forked from ' : 'from ') + prev.name;
        })(),
        `${rel.beams.length} beam${rel.beams.length === 1 ? '' : 's'} running it`,
        `${rel.children.length} built on it`,
      ].filter(Boolean).join(' \u00B7 '),
      onClick: () => showPhaseDetails(profile, phase.name),
    },
    { sep: true },
    {
      label: 'Start a beam from it\u2026', icon: '+',
      disabled: phase.state !== 'ready',
      title: phase.state === 'ready' ? '' : `It is ${phase.state || 'not ready'}; a beam can start from it once it is ready`,
      onClick: () => addBeam(profile, { phase: phase.name }),
    },
    { sep: true },
    {
      label: 'Fork into a new Phase\u2026', icon: '\u2442',
      title: 'tsh phase add --fork-from: a new Phase that starts from its saved files',
      onClick: () => newPhase(profile, { mode: 'fork', source: phase.name }),
    },
    {
      label: 'Build a new Phase on top of it\u2026', icon: '\u2191',
      title: 'tsh phase add --from: a new Phase with this one as its base image',
      onClick: () => newPhase(profile, { mode: 'from', source: phase.name }),
    },
    // Copy and rebuild Phases are not edited in a console: their commands
    // or files are replaced, and they rebuild.
    phase.strategy === 'rebuild' || phase.strategy === 'copy' ? {
      label: phase.strategy === 'copy' ? 'Copy its files again\u2026' : 'Replace its command file\u2026', icon: '\u270E',
      title: phase.strategy === 'copy' ? 'tsh phase edit --copy: the files copied in again, from its parent' : 'tsh phase edit --commands-file: new commands, rebuilt',
      onClick: () => replacePhaseInputs(profile, phase),
    } : {
      label: 'Edit in a build console\u2026', icon: '\u270E',
      title: 'tsh phase edit: change it in place (only while nothing is built from it)',
      onClick: () => editPhase(profile, phase),
    },
    {
      label: 'Add setups on top of it\u2026', icon: '\u2795',
      disabled: phase.state !== 'ready',
      title: 'Tools, services and files as new stages built on this Phase (tsh phase apply)',
      onClick: async () => (await import('./phasebuilder.js')).openPhaseBuilder(profile, { from: phase.name }),
    },
    // A build still running: its Beam, and saving it from here.
    ...(phase.buildBeam ? [
      { sep: true },
      { label: 'Its build is running', heading: true },
      { label: 'Open its build Beam', icon: '\u25B6', onClick: () => openBeam({ id: phase.buildBeam, proxy: profile.proxy, home: profile.homeDir || null }) },
      { label: 'Save a snapshot now', icon: '\u2193', title: 'tsh phase snapshot in its build Beam — the build keeps going', onClick: () => snapshotBuild(profile, phase) },
      { label: 'Save and finish the build\u2026', icon: '\u2713', title: 'tsh phase snapshot --final', onClick: () => snapshotBuild(profile, phase, { final: true }) },
    ] : []),
    { sep: true },
    { label: 'Copy name', icon: '\u29C9', onClick: () => { window.api.clipboard.write(phase.name); status(`Copied ${phase.name}`); } },
    phase.digest ? {
      label: 'Copy snapshot (name@digest)', icon: '\u29C9',
      title: 'Starts a beam from exactly this snapshot, even after the Phase is saved again',
      onClick: () => { window.api.clipboard.write(`${phase.name}@${phase.digest}`); status('Copied the snapshot reference'); },
    } : null,
    folderItem ? { sep: true } : null,
    folderItem,
    { sep: true },
    { label: 'Delete Phase\u2026', icon: '\u2715', onClick: () => removePhase(profile, phase) },
  ].filter(Boolean));
}

/**
 * How long a beam has left.
 *
 * Its own formatter rather than the app's duration one: that is built for
 * command timings, where minutes and seconds are the interesting part, and a
 * beam that lives for a day reads as "1431m 29s". Here the useful precision
 * falls off with distance — hours tomorrow, minutes within the hour.
 */
export function expiresIn(beam) {
  if (!beam?.expires) return '';
  const ms = beam.expires - Date.now();
  if (ms <= 0) return 'expired';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m left`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m left`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
}

/**
 * The UUIDs of beams this app knows about, for filtering them out of the
 * cluster's node list.
 *
 * A running beam also registers as a Teleport node called `beam-<uuid>`, so
 * without this every beam appears twice: once under its own name where it can
 * be managed, and once as a UUID among the servers where it cannot.
 */
export function beamNodeNames() {
  const names = new Set();
  for (const list of (state.beams || new Map()).values()) {
    for (const b of list) {
      if (b.uuid) names.add('beam-' + b.uuid);
      if (b.id) names.add('beam-' + b.id);
    }
  }
  return names;
}

/** A beam as a host descriptor the session machinery understands. */
export function beamHost(beam) {
  return {
    id: `beam:${beam.proxy}:${beam.id}`,
    type: 'beam',
    name: beam.id,
    proxy: beam.proxy,
    home: beam.home || null,
  };
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export async function openBeam(beam, opts = {}) {
  const host = beamHost(beam);
  try {
    /*
     * "Open every new session in tmux" means beams too. A beam is a VM that
     * is deleted when it expires, but until then it is exactly the machine
     * where an agent's long run should survive a closed lid.
     */
    if (!opts.filesOnly) {
      const { opensInTmux, tmuxNameFor } = await import('./sidebar.js');
      if (opensInTmux(host)) {
        const { openTmux } = await import('./tmux.js');
        return await openTmux(host, { session: tmuxNameFor(host) });
      }
    }
    return await openHost(host, opts);
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

/**
 * Start a beam, and offer to open it.
 *
 * Creating one takes a while — it is a VM — so the dialog says so and the
 * button stays disabled rather than looking ignored.
 */
export async function addBeam(profile, { phase: preselect = '' } = {}) {
  const regionSel = select(REGIONS, '');
  let busy = false;
  const note = el('div', { class: 'hint', style: 'margin-top:10px' },
    'A beam is a sandbox VM. It is created on demand, expires on its own, and '
    + 'is meant to be thrown away — nothing on it survives the expiry.');

  /*
   * Start from a Phase — a saved image with your tools already on it — and
   * delegate chosen roles, when this tsh can. Asked of the tsh binary itself
   * (see addSupport in main/beams.js): a tsh without them gets the dialog
   * exactly as it was, rather than a choice that fails.
   */
  const opts = { proxy: profile.proxy, home: profile.homeDir };
  const can = (await window.api.beams.addSupport(opts).catch(() => null)) || {};
  const canPhase = !!can.phases;

  /*
   * Roles to hand the beam, from the ones this login holds. None ticked
   * leaves --roles off, so the cluster's own default for beams applies —
   * the same beam you got before this was asked.
   */
  const myRoles = can.roles ? [...(profile.roles || [])].sort() : [];
  const roleBoxes = myRoles.map((r) => checkbox(r, false));
  const rolesField = myRoles.length
    ? field('Delegate roles', el('div', { class: 'role-picks', style: 'display:flex;flex-wrap:wrap;gap:4px 14px' }, ...roleBoxes),
      'Tick the roles the beam should act with. None ticked: the cluster\u2019s default for beams.')
    : null;
  const phaseWrap = el('div');
  let phaseSel = null;
  if (canPhase) {
    const phaseNote = el('div', { class: 'hint', text: 'Reading Phases (tsh phase ls)…' });
    phaseWrap.append(phaseNote);
    window.api.beams.phases(opts).then((r) => {
      if (!r?.ok) { phaseNote.textContent = r?.error || 'Could not read the Phases'; return; }
      const ready = r.phases.filter((p) => p.state === 'ready');
      const waiting = r.phases.length - ready.length;
      if (!ready.length) {
        phaseNote.textContent = r.phases.length
          ? `No Phase is ready yet (${waiting} building or failed) — the beam starts from the standard image.`
          : 'No Phases yet — the beam starts from the standard image. `tsh phase add` makes one.';
        return;
      }
      // A Phase lives in a region; starting there avoids asking for one it is not in.
      const matchRegion = () => {
        const p = ready.find((x) => x.name === phaseSel?.value);
        if (p?.region && REGIONS.some((o) => o.value === p.region)) regionSel.value = p.region;
      };
      // Your Phase folders and a search, not one long list (phasepicker.js).
      phaseSel = phasePicker({
        profile, phases: ready, standard: 'The standard image',
        value: ready.some((p) => p.name === preselect) ? preselect : '',
        onChange: matchRegion,
      });
      matchRegion();
      phaseWrap.replaceChildren(field('Start from', phaseSel.el,
        'A Phase is a saved image: the beam starts with what was installed in it. '
          + (waiting ? `${waiting} more not ready yet. ` : '') + 'Latest snapshot of the one you pick.'));
    }).catch((e) => { phaseNote.textContent = e.message; });
  }

  const res = await modal({
    title: 'Start a beam',
    subtitle: profile.cluster || profile.proxy,
    width: 'min(520px, 94vw)',
    render: (body, { close }) => {
      /*
       * A beam started here runs an image; it is not a build. `tsh phase
       * snapshot` only saves from a Phase's own build Beam (phase add or
       * phase edit), so work done in this one cannot be kept as a Phase —
       * said before it is started, with the way that can.
       */
      const saveNote = canPhase ? el('div', { class: 'hint beam-save-note', style: 'margin-top:8px;color:var(--amber)' },
        el('span', { style: 'margin-right:5px', text: '\u26A0' }),
        'Work in this beam can\u2019t be saved as a Phase. To keep it, ',
        el('button', {
          class: 'linklike', type: 'button', text: 'start a Phase build instead',
          style: 'background:none;border:0;padding:0;color:var(--accent);cursor:pointer;font:inherit;text-decoration:underline',
          title: 'tsh phase add: a build beam you can save with tsh phase snapshot',
          onClick: () => close({ switchToPhase: true, from: phaseSel?.value || '' }),
        }),
        can.apply ? ', or ' : '',
        can.apply ? el('button', {
          class: 'linklike', type: 'button', text: 'build one from setups',
          style: 'background:none;border:0;padding:0;color:var(--accent);cursor:pointer;font:inherit;text-decoration:underline',
          title: 'Tools, services and files picked as setups, built with tsh phase apply',
          onClick: () => close({ switchToBuilder: true, from: phaseSel?.value || '' }),
        }) : null,
        '.') : null;
      body.append(
        ...(canPhase ? [phaseWrap] : []),
        ...(rolesField ? [rolesField] : []),
        field('Region', regionSel,
          'The cluster may put it somewhere else if the region you ask for is unavailable.'),
        saveNote,
        note);
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Start it',
        class: 'primary-btn',
        onClick: async ({ close }) => {
          if (busy) return;
          busy = true;
          note.textContent = phaseSel?.value
            ? `Starting a sandbox VM from ${phaseSel.value} — this takes a moment…`
            : 'Starting a sandbox VM — this takes a moment…';
          const r = await window.api.beams.add({
            proxy: profile.proxy, home: profile.homeDir, region: regionSel.value || undefined,
            phase: phaseSel?.value || undefined,
            roles: myRoles.filter((r, i) => roleBoxes[i].input.checked),
          }).catch((e) => ({ ok: false, error: e.message }));
          busy = false;
          if (!r.ok) { note.textContent = ''; return toast(r.error || 'Could not start a beam', 'error', 9000); }
          close(r.beam);
        },
      },
    ],
  });
  if (!res) return null;
  if (res.switchToBuilder) {
    await (await import('./phasebuilder.js')).openPhaseBuilder(profile, { from: res.from || '' });
    return null;
  }
  if (res.switchToPhase) {
    await newPhase(profile, res.from ? { mode: 'from', source: res.from } : {});
    return null;
  }

  status(`Beam ${res.id} started in ${res.region}`, 8000);
  await refreshBeams();
  // Offering rather than opening: starting one and looking at the list is a
  // perfectly ordinary thing to want.
  if (await confirm({
    title: `Beam ${res.id} is up`,
    message: 'Open a session on it now?',
    detail: [
      `Region: ${res.region}`,
      res.requestedRegion ? `(you asked for ${res.requestedRegion})` : '',
      expiresIn(res) ? `Expires: ${expiresIn(res)}` : '',
    ].filter(Boolean).join('\n'),
    confirmLabel: 'Open a session',
  })) {
    await openBeam(res);
  }
  return res;
}

/** Delete one. Always asked, because nothing on it comes back. */
export async function removeBeam(beam) {
  if (!await confirm({
    title: `Delete beam ${beam.id}?`,
    message: 'The VM and everything on it goes.',
    detail: 'Anything you have not copied off is lost. Open sessions on it will die.',
    confirmLabel: 'Delete it',
    danger: true,
  })) return false;

  status(`Deleting ${beam.id}…`, 0);

  // Off the list at once. The row is the thing being acted on, and leaving it
  // sitting there while the cluster catches up reads as the delete having
  // done nothing. If it turns out to have failed, it comes back.
  const before = beamsFor(beam.proxy);
  state.beams.set(beam.proxy, before.filter((b) => b.id !== beam.id));
  state.emit('beams');

  try {
    const r = await window.api.beams.remove({ name: beam.id, proxy: beam.proxy, home: beam.home });
    if (!r.ok) throw new Error(r.output || 'tsh beams rm failed');

    /*
     * `rm` returning is not the beam being gone: the service is eventually
     * consistent, and a list taken immediately afterwards still reports it.
     * So confirm rather than refreshing once into a stale answer — and say so
     * if it is still there after a few seconds, instead of letting the row
     * silently reappear.
     */
    let gone = false;
    for (const wait of [800, 1600, 2500, 4000]) {
      await new Promise((r2) => setTimeout(r2, wait));
      const still = await window.api.beams.stillListed({
        name: beam.id, proxy: beam.proxy, home: beam.home,
      }).catch(() => null);
      if (still === false) { gone = true; break; }
      if (still === null) break;               // could not tell; leave it
    }
    await refreshBeams();
    if (gone || r.gone) toast(`Deleted ${beam.id}`, 'success');
    else {
      toast(`${beam.id} was deleted, but the cluster is still listing it — `
        + 'it should drop off the next refresh.', 'info', 9000);
    }
    return true;
  } catch (e) {
    // Put it back: it is still there, and a list that hides it is a lie.
    state.beams.set(beam.proxy, before);
    state.emit('beams');
    toast(e.message, 'error', 12000);
    return false;
  } finally { status(''); }
}

/* ------------------------------------------------------------------ */
/* Keeping the list current                                            */
/* ------------------------------------------------------------------ */

/**
 * How often the beam list is re-read.
 *
 * Beams change without this app doing anything: they expire on their own, and
 * anyone else with the cluster can start or delete one. The countdown on each
 * row is also only as honest as its last read. A minute is frequent enough
 * that neither goes visibly stale, and cheap enough at one `tsh beams ls` per
 * beams-capable cluster — which is why it stops while the window is hidden
 * and while nothing has beams at all.
 */
const REFRESH_MS = 60000;
let loopTimer = null;

export function startBeamsLoop() {
  clearInterval(loopTimer);
  loopTimer = setInterval(() => {
    if (document.hidden) return;
    if (!beamProfiles().some((p) => beamsSupported(p.proxy))) return;
    refreshBeams().catch(() => {});
  }, REFRESH_MS);
}

export function stopBeamsLoop() {
  clearInterval(loopTimer);
  loopTimer = null;
}

/** One command in a beam, answered in a dialog — no session needed. */
export async function execInBeam(beam) {
  const cmdIn = textInput({ value: 'uname -a; id -un; df -h /', autofocus: true });
  const out = el('pre', { class: 'qc-debug', text: 'Output appears here.' });
  let busy = false;

  const run = async () => {
    const command = cmdIn.value.trim();
    if (!command || busy) return;
    busy = true;
    out.textContent = 'Running…';
    try {
      const r = await window.api.beams.exec({
        name: beam.id, proxy: beam.proxy, home: beam.home, command,
      });
      out.textContent = [r.output, r.error].filter(Boolean).join('\n') || '(no output)';
    } catch (e) {
      out.textContent = e.message;
    } finally { busy = false; }
  };

  await modal({
    title: 'Run in a beam',
    subtitle: beam.id,
    width: 'min(760px, 94vw)',
    render: (body) => {
      cmdIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
      body.append(field('Command', cmdIn, 'Runs through `tsh beams exec`, with no session open.'), out);
    },
    buttons: [
      { label: 'Close', value: null },
      { label: 'Run', class: 'primary-btn', onClick: () => run() },
    ],
  });
}

/**
 * Publish a service running inside a beam.
 *
 * The beams answer to a port forward: rather than tunnelling a port to this
 * machine, the cluster puts the service behind its own address, so anyone who
 * can reach the cluster can reach it.
 */
export async function publishBeam(beam) {
  const kindSel = select([
    { value: 'http', label: 'HTTP service' },
    { value: 'tcp', label: 'TCP service' },
  ], 'http');
  const out = el('pre', { class: 'qc-debug hidden' });

  await modal({
    title: 'Publish a service',
    subtitle: beam.id,
    width: 'min(620px, 94vw)',
    render: (body) => {
      body.append(
        field('Kind', kindSel,
          'HTTP is published as an application; TCP as a TCP app you reach with a local proxy.'),
        el('div', { class: 'hint' },
          'The service has to already be listening inside the beam. Publishing exposes it '
          + 'through the cluster, so it is reachable by anyone the cluster lets in.'),
        out);
    },
    buttons: [
      { label: 'Close', value: null },
      {
        label: 'Unpublish',
        onClick: async () => {
          out.classList.remove('hidden');
          out.textContent = 'Unpublishing…';
          try {
            const r = await window.api.beams.unpublish({ name: beam.id, proxy: beam.proxy, home: beam.home });
            out.textContent = r.output || (r.ok ? 'Unpublished.' : 'Nothing was published.');
          } catch (e) { out.textContent = e.message; }
        },
      },
      {
        label: 'Publish', class: 'primary-btn',
        onClick: async () => {
          out.classList.remove('hidden');
          out.textContent = 'Publishing…';
          try {
            const r = await window.api.beams.publish({
              name: beam.id, proxy: beam.proxy, home: beam.home, tcp: kindSel.value === 'tcp',
            });
            out.textContent = r.output || (r.ok ? 'Published.' : 'Could not publish.');
            if (r.url) {
              window.api.clipboard.write(r.url);
              status('Published — address copied: ' + r.url, 9000);
            }
          } catch (e) { out.textContent = e.message; }
        },
      },
    ],
  });
}

/**
 * Copy files with `tsh beams scp`.
 *
 * The file browser is the better tool for anything interactive, and it works
 * on a beam like on a server. This is here because a whole directory is one
 * call rather than a walk, and because it is part of the command set.
 */
export async function scpBeam(beam, { toBeam = true } = {}) {
  const localIn = textInput({ value: '', placeholder: '/path/on/this/machine', autofocus: true });
  const remoteIn = textInput({ value: '', placeholder: '/home/beams/somewhere' });
  const dirSel = select([
    { value: 'up', label: 'This machine → beam' },
    { value: 'down', label: 'Beam → this machine' },
  ], toBeam ? 'up' : 'down');
  const recurse = el('input', { type: 'checkbox' });
  const out = el('pre', { class: 'qc-debug hidden' });

  /*
   * `tsh beams scp -r` copies a file at a time through the proxy, and a tree
   * of many small files spends its time on round trips rather than bytes. For
   * anything big, one tar.gz moved and expanded on the far side is the fast
   * way — said under the checkbox, in terms of the paths typed above it.
   */
  const tarNote = el('div', { class: 'hint hidden', style: 'margin-top:8px' });
  const drawTarNote = () => {
    tarNote.classList.toggle('hidden', !recurse.checked);
    if (!recurse.checked) return;
    const up = dirSel.value === 'up';
    const src = (up ? localIn.value : remoteIn.value).trim().replace(/\/+$/, '') || (up ? '/path/to/folder' : '/home/beams/folder');
    const dest = (up ? remoteIn.value : localIn.value).trim() || (up ? '/home/beams/somewhere' : '/path/on/this/machine');
    const name = src.split('/').pop() || 'folder';
    const parent = src.split('/').slice(0, -1).join('/') || '/';
    const pack = `tar czf ${name}.tar.gz -C '${parent}' '${name}'`;
    const unpack = `tar xzf ${name}.tar.gz -C '${dest}'`;
    tarNote.textContent = 'A large folder is much faster as one archive. '
      + (up
        ? `Here: ${pack} — copy the .tar.gz (Recursive off) — then in the beam: ${unpack}`
        : `In the beam: ${pack} (Run a command… does it) — copy the .tar.gz (Recursive off) — then here: ${unpack}`);
  };
  for (const n of [recurse, dirSel, localIn, remoteIn]) {
    n.addEventListener('input', drawTarNote);
    n.addEventListener('change', drawTarNote);
  }

  await modal({
    title: 'Copy files',
    subtitle: `${beam.id} · tsh beams scp`,
    width: 'min(680px, 94vw)',
    render: (body) => {
      body.append(
        field('Direction', dirSel),
        field('On this machine', el('div', { style: 'display:flex;gap:6px' }, localIn,
          el('button', {
            class: 'ghost-btn sm', text: 'Browse…',
            onClick: async () => {
              const dir = await window.api.dialog.chooseDir();
              if (dir) localIn.value = dir;
            },
          }))),
        field('In the beam', remoteIn),
        el('label', { style: 'display:flex;gap:7px;align-items:center;font-size:12.5px' },
          recurse, 'Recursive (a whole directory)'),
        tarNote,
        out);
    },
    buttons: [
      { label: 'Close', value: null },
      {
        label: 'Copy', class: 'primary-btn',
        onClick: async () => {
          const local = localIn.value.trim();
          const remote = remoteIn.value.trim();
          if (!local || !remote) return toast('Both paths are needed', 'error');
          const up = dirSel.value === 'up';
          out.classList.remove('hidden');
          out.textContent = 'Copying…';
          try {
            const r = await window.api.beams.scp({
              proxy: beam.proxy, home: beam.home,
              // tsh spells the beam side `beam:path`.
              src: up ? local : `${beam.id}:${remote}`,
              dest: up ? `${beam.id}:${remote}` : local,
              recursive: recurse.checked,
            });
            out.textContent = r.output || (r.ok ? 'Copied.' : 'Copy failed.');
            if (r.ok) status('Copied');
          } catch (e) { out.textContent = e.message; }
        },
      },
    ],
  });
}

/** Put a beam beside ('row') or below ('col') the focused pane. */
export async function splitBeam(beam, dir) {
  try {
    status(`Opening ${beam.id}…`, 0);
    await splitActivePane(dir, { host: beamHost(beam) });
    status('');
  } catch (e) {
    toast(e.message, 'error');
    status('');
  }
}

/** The right-click menu for one beam. */
export function beamMenu(x, y, beam) {
  // The cluster as a profile, for the Phase list it is read from.
  const profile = { proxy: beam.proxy, homeDir: beam.home || undefined };
  if (beam.phase && phasesSupported(beam.proxy) && !phaseListFor(beam.proxy)) refreshPhases(profile);
  const rel = beam.phase ? phaseRelations(beam.proxy, beam.phase) : null;
  contextMenu(x, y, [
    { label: beam.id, heading: true },
    // Which image it is: a Phase, with its history, or the standard one.
    beam.phase ? {
      label: `From Phase ${phaseName(beam.phase)}\u2026`, icon: '\u2630',
      sub: [
        lineageText(rel, phaseName(beam.phase)),
        beam.phase.includes('@') ? 'snapshot ' + beam.phase.split('@')[1].slice(0, 19) : 'latest snapshot when started',
      ].join(' \u00B7 '),
      onClick: () => showPhaseDetails(profile, beam.phase),
    } : null,
    // Said only where tsh reports a beam's Phase; an older one cannot tell.
    !beam.phase && phasesSupported(beam.proxy)
      ? { label: 'Standard image (no Phase)', disabled: true, title: 'Started without --phase' } : null,
    { sep: true },
    { label: 'Open a session', onClick: () => openBeam(beam) },
    // As on any host's menu: beside or below the focused pane, and only when
    // there is one to put it beside.
    ...(state.activePane ? [
      { label: 'Open beside current (split right)', icon: 'Ⅾ', onClick: () => splitBeam(beam, 'row') },
      { label: 'Open below current (split down)', icon: '‗', onClick: () => splitBeam(beam, 'col') },
    ] : []),
    {
      label: 'Open in tmux…',
      title: 'Keeps running on the beam when this window goes away',
      onClick: async () => (await import('./tmux.js')).openTmuxDialog(beamHost(beam)),
    },
    {
      label: 'Open the file browser',
      title: 'A session with the files and no terminal',
      onClick: () => openBeam(beam, { filesOnly: true }),
    },
    { label: 'Run a command…', onClick: () => execInBeam(beam) },
    {
      label: 'Services…',
      title: 'What its Phase starts in it (beamctl list), and each one\u2019s log',
      onClick: () => showBeamServices(beam),
    },
    {
      label: 'Active sessions in this beam…',
      title: 'Watch, join or moderate a session that is going on in it now — an agent at work, say',
      // The tracker names a beam by the node it registers as, beam-<uuid>.
      onClick: async () => (await import('./livesessions.js')).openActiveSessions({
        proxy: beam.proxy, home: beam.home || null,
        match: [beam.uuid && 'beam-' + beam.uuid, beam.uuid, 'beam-' + beam.id, beam.id],
        title: `Active sessions in ${beam.id}`,
      }),
    },
    { sep: true },
    { label: 'Publish a service…', onClick: () => publishBeam(beam) },
    { label: 'Copy files (scp)…', onClick: () => scpBeam(beam) },
    { sep: true },
    {
      label: 'Copy its name',
      onClick: () => { window.api.clipboard.write(beam.id); status('Copied ' + beam.id); },
    },
    beam.uuid ? {
      label: 'Copy its UUID',
      onClick: () => { window.api.clipboard.write(beam.uuid); status('Copied ' + beam.uuid); },
    } : null,
    { sep: true },
    { label: 'Delete this beam…', onClick: () => removeBeam(beam) },
  ].filter(Boolean));
}

/** Stop listing beams for a cluster, until it is asked for again. */
export async function hideBeamsFor(proxy) {
  const next = [...new Set([...(state.settings.hiddenBeamProxies || []), proxy])];
  state.settings = await window.api.settings.set({ hiddenBeamProxies: next });
  state.beams?.delete(proxy);
  state.emit('beams');
}

export async function showBeamsFor(proxy) {
  const next = (state.settings.hiddenBeamProxies || []).filter((p) => p !== proxy);
  state.settings = await window.api.settings.set({ hiddenBeamProxies: next });
  await refreshBeams({ refresh: true });
}

/**
 * Mark a cluster as having beams, or stop marking it.
 *
 * The probe is right nearly always; this is for when it cannot run — and for
 * saying "yes, I know" to a cluster the app has not been able to ask yet.
 */
export async function setMarkedAsBeams(proxy, marked) {
  const set = new Set(state.settings.beamProxies || []);
  const off = new Set(state.settings.notBeamProxies || []);
  marked ? set.add(proxy) : set.delete(proxy);
  // A beams.sh / beams.run cluster is marked by its name: turning it off is
  // an opt-out of that, and turning it back on removes the opt-out.
  if (beamsByName(proxy)) marked ? off.delete(proxy) : off.add(proxy);
  state.settings = await window.api.settings.set({ beamProxies: [...set], notBeamProxies: [...off] });
  await refreshBeams({ refresh: true });
  status(marked ? 'Listing beams for this cluster' : 'No longer treating this cluster as beams');
}
