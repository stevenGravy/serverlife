import { state } from './state.js';
import { el, $ } from './util.js';
import { modal, toast, status, contextMenu, field, textInput, prompt as askText } from './ui.js';
import { looksLikeQuestion, screenTail } from './aiwaiting.js';

/**
 * AI assistants beside a session: Claude Code, Codex, GitHub Copilot CLI,
 * OpenCode, Pi, Gemini CLI.
 *
 * Each is the vendor's own command-line client in a pane on the right of the
 * window — the way the VS Code and JetBrains integrations run `claude` —
 * given ServerLife's MCP server so it can see the hosts, open sessions and
 * read cluster state. Any of them can be run through a launcher set in
 * Settings. Before one opens, it is checked: installed, signed in, launcher
 * present, ServerLife's tools reachable — and what is missing is said, with
 * the way to fix it.
 */

let cache = null;

/** What is installed, if it has been read yet — for drawing without waiting. */
export function cachedAiClients() { return cache; }

/** Whether an assistant is open in the panel. */
export function aiRunning(id) { return aiSessions.some((r) => r.client.id === id); }

/** What is installed, asked of the login shell; read once, then on request. */
export async function aiClients({ fresh = false } = {}) {
  if (!cache || fresh) cache = await window.api.ai.clients().catch(() => ({ clients: [], automation: false }));
  // Looked up before the person's own PATH was known: look again once it is,
  // in the background, and redraw what shows the list.
  if (cache && !cache.pathSettled && !settling) {
    settling = window.api.ai.clients({ waitForPath: true }).then((c) => {
      cache = c;
      import('./sidebar.js').then((m) => m.renderSidebar()).catch(() => {});
    }).catch(() => {}).finally(() => { settling = null; });
  }
  return cache;
}
let settling = null;

async function saveSettings(patch) {
  state.settings = await window.api.settings.set(patch);
}

/*
 * Pi and Gemini CLI keep MCP servers only in their own config, so ServerLife
 * is added there once — shown first, run only when agreed to.
 */
async function registered(c) {
  if (c.mcp !== 'persist') return true;
  if ((state.settings.aiRegistered || {})[c.id]) return true;
  const cmd = await window.api.ai.registerCommand(c.id);
  const res = await modal({
    title: `Add ServerLife to ${c.name}?`,
    width: 600,
    render: (body) => body.append(
      el('div', { style: 'font-size:13px;margin-bottom:8px',
        text: `${c.name} reads MCP servers only from its own settings, so ServerLife has to be added there once:` }),
      el('pre', { class: 'qc-debug', style: 'white-space:pre-wrap', text: cmd })),
    buttons: [
      { label: 'Open without ServerLife', value: 'without' },
      { label: 'Add it', class: 'primary-btn', value: 'add' },
    ],
  });
  if (res !== 'add') return false;
  const r = await window.api.ai.register(c.id).catch((e) => ({ ok: false, output: e.message }));
  if (!r.ok) { toast(`Could not add ServerLife to ${c.name}: ${r.output || 'it failed'}`, 'error', 9000); return false; }
  await saveSettings({ aiRegistered: { ...(state.settings.aiRegistered || {}), [c.id]: true } });
  return true;
}

/*
 * After an assistant is opened by hand: offer to open it every time. Asked
 * once per assistant — never for the one already opening at startup, and
 * not again after "don't ask".
 */
async function offerAlways(c) {
  if (state.settings.aiStartup === c.id) return;
  if ((state.settings.aiNoAsk || {})[c.id]) return;
  const res = await modal({
    title: `Open ${c.name} whenever ServerLife starts?`,
    width: 480,
    render: (body) => body.append(el('div', { class: 'hint',
      text: 'It opens on the right of the first tab, as now. Settings → AI assistant changes or stops it.' })),
    buttons: [
      { label: `Don’t ask again for ${c.name}`, value: 'never' },
      { label: 'Not now', value: null },
      { label: 'Always open it', class: 'primary-btn', value: 'always' },
    ],
  });
  if (res === 'always') {
    await saveSettings({ aiStartup: c.id });
    status(`${c.name} will open when ServerLife starts`);
  } else if (res === 'never') {
    await saveSettings({ aiNoAsk: { ...(state.settings.aiNoAsk || {}), [c.id]: true } });
  }
}

/*
 * Run a fix the check offered, in a terminal tab the person can watch and
 * answer: an install, a sign-in. Typed into a login shell so it finds what
 * their own terminal would.
 */
async function runInTerminal(command, title) {
  const { openLocalShell } = await import('./sessions.js');
  const pane = await openLocalShell(undefined, { title });
  await new Promise((r) => setTimeout(r, 400));
  if (pane?.termId) window.api.localTerm.write(pane.termId, command + '\r');
  status(`Running: ${command} — come back and press Check again when it is done`, 9000);
}

const MARK = { ok: '✓', error: '✕', warn: '!', info: 'i' };

/**
 * Is this assistant ready? The result as a list, with fixes, and Open when
 * nothing blocks it. Resolves true to open, false to stop.
 */
async function checkDialog(c, first) {
  let chk = first;
  for (;;) {
    const blocking = chk.steps.some((x) => x.level === 'error');
    const warned = chk.steps.some((x) => x.level === 'warn');
    let action = null;
    const res = await modal({
      title: `${c.name} — ${blocking ? 'not ready yet' : 'ready, with notes'}`,
      width: 'min(620px, 94vw)',
      render: (body, { close }) => {
        for (const st of chk.steps) {
          const row = el('div', { class: `ai-check ${st.level}` },
            el('span', { class: 'mark', text: MARK[st.level] || '·' }),
            el('div', { class: 'txt' },
              el('div', { class: 'l', text: st.label }),
              st.detail ? el('div', { class: 'd', text: st.detail }) : null,
              st.fix?.command ? el('code', { text: st.fix.command }) : null));
          for (const fix of [st.fix, st.fix?.alt].filter(Boolean)) {
            row.append(el('button', {
              class: 'ghost-btn sm', text: fix.label || 'Fix',
              onClick: () => { action = fix; close('fix'); },
            }));
          }
          body.append(row);
        }
      },
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Check again', value: 'again' },
        blocking ? null : { label: warned ? 'Open anyway' : 'Open', class: 'primary-btn', value: 'open' },
      ].filter(Boolean),
    });
    if (res === 'open') return true;
    if (!res) return false;
    if (res === 'fix' && action) {
      if (action.kind === 'run') {
        let cmd = action.command;
        if (action.edit) {
          const { prompt } = await import('./ui.js');
          cmd = await prompt({ title: action.label, value: cmd, confirmLabel: 'Run' });
          if (!cmd) continue;
        }
        await runInTerminal(cmd, `${c.name}: ${action.label.toLowerCase()}`);
        return false;
      }
      if (action.kind === 'automation') await window.api.control.setEnabled(true);
      if (action.kind === 'noToolsOk') await saveSettings({ aiNoToolsOk: true });
      if (action.kind === 'register') await registered(c);
      if (action.kind === 'settings') toast('Settings → AI assistant has the launcher', 'info', 6000);
    }
    chk = await window.api.ai.check(c.id);
  }
}

/**
 * Open an assistant in the panel on the right — checked first. All clear,
 * it opens at once; anything missing is shown with how to fix it.
 */
export async function openAi(id, {
  fromStartup = false, skipCheck = false, prompt = '', send = true, resume = '', name = '',
} = {}) {
  const info = await aiClients();
  const c = info.clients.find((x) => x.id === id);
  if (!c) return toast(`Unknown assistant: ${id}`, 'error');

  if (!skipCheck) {
    status(`Checking ${c.name}…`, 0);
    const chk = await window.api.ai.check(id).catch((e) => ({ steps: [{ level: 'error', label: 'Check', detail: e.message }] }));
    status('');
    const clear = chk.steps.every((x) => x.level === 'ok' || x.level === 'info');
    if (!clear && !(await checkDialog(c, chk))) return;
    await aiClients({ fresh: true });
  }

  const ctl = await window.api.control.status().catch(() => ({ enabled: false }));
  const mcpOk = !!ctl.enabled && (c.mcp !== 'persist' || !!(state.settings.aiRegistered || {})[c.id]);

  let l;
  try { l = await window.api.ai.launch(id, { withMcp: mcpOk, resume, name }); } catch (e) { return toast(e.message, 'error'); }
  try {
    await addSession(c, l, { prompt, send, name });
  } catch (e) { return toast(e.message, 'error'); }
  status(`${l.title}${mcpOk ? ' — with ServerLife’s tools' : ''}`, 6000);
  if (!fromStartup) offerAlways(c);
}

/**
 * Another session of an assistant already running: its check has passed
 * once, so it goes straight to a new tab in the panel, and it is not asked
 * about again for startup.
 */
export function openAnother(id) {
  return openAi(id, { skipCheck: true, fromStartup: true });
}

/** Check an assistant without opening it: what is there, what is missing. */
export async function checkAi(id) {
  const info = await aiClients({ fresh: true });
  const c = info.clients.find((x) => x.id === id);
  if (!c) return;
  const chk = await window.api.ai.check(id);
  if (await checkDialog(c, chk)) openAi(id, { skipCheck: true });
}

/** The launcher from Settings, if one is set: { on, template, clients }. */
function launcherSetting() {
  const l = state.settings.aiLauncher || {};
  return l.template ? l : null;
}

/** How one assistant is launched: 'default', 'direct' or 'custom:<template>'. */
function launchModeOf(id) {
  return (state.settings.aiClientLaunch || {})[id] || 'default';
}


/** One item per installed assistant, each opening its "How it runs" dialog. */
export function launcherMenuItems(clients) {
  return clients.filter((c) => c.available).map((c) => {
    const mode = launchModeOf(c.id);
    const custom = mode.startsWith('custom:') ? mode.slice(7) : '';
    return {
      label: `${c.name}…`,
      key: mode === 'direct' ? 'directly' : custom ? custom.split(/\s+/)[0] : 'default',
      onClick: () => howItRuns(c.id),
    };
  });
}

/**
 * How one assistant runs, in one place: directly, through the default
 * launcher, or through its own (typed by the person, never suggested), its
 * model, and extra arguments. The command
 * that will run is shown as it is edited, with anything ServerLife adds for
 * the launcher explained, and it can be checked before it is saved.
 */
export async function howItRuns(id) {
  const info = await aiClients();
  const c = info.clients.find((x) => x.id === id);
  if (!c) return;
  const mode = launchModeOf(c.id);
  const g = launcherSetting();
  const radios = el('div', { class: 'ai-how' });
  const choice = (value, label, sub) => {
    const input = el('input', { type: 'radio', name: 'ai-how', value });
    const row = el('label', { class: 'ai-how-row' }, input,
      el('span', {}, el('b', { text: label }), sub ? el('span', { class: 'hint', text: ' — ' + sub }) : null));
    radios.append(row);
    return input;
  };
  const rDirect = choice('direct', 'Directly', `${c.name} signs in with ${c.vendor === 'open source' ? 'its providers' : c.vendor}`);
  const rDefault = choice('default', 'The default launcher',
    g?.on && g.template ? g.template : 'none is set, so it runs directly — Settings → AI assistant');
  const rCustom = choice('custom', 'Its own launcher', 'a command it is run through');
  const template = textInput({ value: mode.startsWith('custom:') ? mode.slice(7) : '', placeholder: 'mytool {client}' });
  if (mode === 'direct') rDirect.checked = true;
  else if (mode.startsWith('custom:')) rCustom.checked = true;
  else rDefault.checked = true;
  const model = textInput({ value: (state.settings.aiClientModel || {})[c.id] || '',
    placeholder: c.modelFlag ? `passed as ${c.modelFlag} — e.g. anthropic/claude-sonnet-5` : 'this tool has no model flag' });
  if (!c.modelFlag) model.disabled = true;
  const extra = textInput({ value: (state.settings.aiClientArgs || {})[c.id] || '', placeholder: 'added to its command line' });
  const recipe = el('div', { class: 'hint', style: 'margin-top:6px;color:var(--accent)' });
  const preview = el('pre', { class: 'qc-debug', style: 'white-space:pre-wrap;word-break:break-all;max-height:22vh;overflow:auto' });

  const draft = () => ({
    mode: rDirect.checked ? 'direct' : rCustom.checked ? 'custom' : 'default',
    template: template.value.trim(), model: model.value.trim(), extraArgs: extra.value.trim(),
  });
  let timer = null;
  const sync = () => {
    template.closest('.field')?.classList.toggle('hidden', !rCustom.checked);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const pv = await window.api.ai.preview(c.id, draft()).catch((e) => ({ command: e.message }));
      preview.textContent = pv.command;
      recipe.textContent = pv.recipe ? `ServerLife adds: ${pv.recipe}` : '';
    }, 150);
  };
  for (const n of [rDirect, rDefault, rCustom, template, model, extra]) {
    n.addEventListener('input', sync); n.addEventListener('change', sync);
  }

  const save = async () => {
    const d = draft();
    if (d.mode === 'custom' && !d.template) { toast('Give the launcher command, or choose another option', 'error'); return false; }
    await saveSettings({
      aiClientLaunch: { ...(state.settings.aiClientLaunch || {}), [c.id]: d.mode === 'custom' ? `custom:${d.template}` : d.mode },
      aiClientModel: { ...(state.settings.aiClientModel || {}), [c.id]: d.model },
      aiClientArgs: { ...(state.settings.aiClientArgs || {}), [c.id]: d.extraArgs },
    });
    return true;
  };

  const res = await modal({
    title: `How ${c.name} runs`,
    width: 'min(640px, 94vw)',
    render: (body) => {
      body.append(radios, field('Launcher command', template,
        '{client} becomes its name (' + c.id + '); {command} its whole command line; with neither, the command goes after it.'),
      field('Model', model), field('Extra arguments', extra),
      el('label', { style: 'font-size:11px;color:var(--muted);display:block;margin-top:8px', text: 'What will run' }),
      preview, recipe);
      sync();
    },
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Save and check', onClick: async ({ close }) => { if (await save()) close('check'); } },
      { label: 'Save', class: 'primary-btn', onClick: async ({ close }) => { if (await save()) close('saved'); } },
    ],
  });
  if (res === 'saved') status(`${c.name}: saved`);
  if (res === 'check') checkAi(c.id);
}

/** The assistants as menu items, installed ones first. */
export async function aiMenuItems() {
  // What is known now — the lookup is on disk and instant, never a shell.
  const info = await aiClients({ fresh: true });
  const sorted = [...info.clients].sort((a, b) => Number(b.available) - Number(a.available));
  const launcher = launcherSetting();
  return [
    { heading: true, label: 'AI assistant' },
    ...sorted.flatMap((c) => (c.available ? (aiRunning(c.id) ? [
      // A running one is shown, not started again; another is its own item,
      // a second conversation beside the first.
      {
        label: `${c.name} \u2014 show`, key: `${aiRunningCount(c.id)} running`,
        title: c.path, onClick: () => showSession(c.id),
      },
      {
        label: `Another ${c.name}`, icon: '+', title: 'A new session of it, in its own tab in the panel',
        onClick: () => openAnother(c.id),
      },
    ] : [{
      label: c.name,
      key: c.id === state.settings.aiStartup ? 'at start' : '',
      title: c.path,
      onClick: () => openAi(c.id),
    }]) : [{
      // Not installed: checking says so, and offers the install.
      label: `${c.name} — set up…`,
      key: 'not installed',
      title: c.install ? `Install with: ${c.install}` : 'Not installed',
      onClick: () => checkAi(c.id),
    }])),
    ...resumeMenu(sorted),
    { sep: true },
    { label: 'Add a custom AI tool\u2026', title: 'Any command-line assistant, with ServerLife\u2019s tools if it takes an MCP config flag', onClick: () => addCustomTool() },
    (state.settings.aiCustomClients || []).length ? {
      label: 'Remove a custom tool',
      submenu: (state.settings.aiCustomClients || []).map((t) => ({ label: t.name, onClick: () => removeCustomTool(t.id) })),
    } : null,
    { sep: true },
    {
      label: 'How each tool runs',
      title: 'Per tool: directly or through a launcher, its model, extra arguments — with the command shown',
      submenu: launcherMenuItems(info.clients),
    },
    launcher ? {
      label: `Default launcher: ${launcher.template}`,
      key: launcher.on ? '\u2713 on' : 'off',
      title: 'Used by every tool set to "Default launcher" \u2014 set in Settings \u2192 AI assistant',
      onClick: async () => {
        await saveSettings({ aiLauncher: { ...launcher, on: !launcher.on } });
        status(launcher.on ? 'Default launcher off' : `Default launcher: ${launcher.template}`);
      },
    } : null,
  ].filter(Boolean);
}

/**
 * Picking up where a conversation left off: the most recent one, or the
 * assistant's own list of past ones. Assistants start in one folder of their
 * own, so "the most recent" is the last one opened from ServerLife.
 */
function resumeMenu(clients) {
  const can = clients.filter((c) => c.available && c.resume?.last);
  if (!can.length) return [];
  return [{ sep: true }, {
    label: 'Pick up a past conversation', icon: '\u21BA',
    submenu: can.flatMap((c) => [
      { label: `${c.name} \u2014 the last one`, onClick: () => openAi(c.id, { resume: 'last', skipCheck: aiRunning(c.id), fromStartup: true }) },
      c.resume.pick ? {
        label: `${c.name} \u2014 choose\u2026`, title: `${c.name}'s own list of past conversations`,
        onClick: () => openAi(c.id, { resume: 'pick', skipCheck: aiRunning(c.id), fromStartup: true }),
      } : null,
    ].filter(Boolean)),
  }];
}

/** The + button's AI list, at the button. */
export async function openAiPicker() {
  const btn = $('#tab-add');
  const r = btn ? btn.getBoundingClientRect() : { left: 80, bottom: 40 };
  contextMenu(r.left, r.bottom + 4, await aiMenuItems());
}

/** At launch: the assistant chosen to open every time, if any. */
export async function openAiAtStartup() {
  const id = state.settings.aiStartup;
  if (!id) return;
  const info = await aiClients();
  if (!info.clients.find((c) => c.id === id)?.available) return;
  openAi(id, { fromStartup: true });
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

/*
 * The assistants live in a panel on the right of the window — beside every
 * tab, not inside one — so a conversation stays where it is while the tabs
 * change under it, as VS Code's secondary side bar does. Each assistant is a
 * chip in the panel's header, named for its client; the panel hides and
 * shows from its own header and from the ✦ button in the toolbar, and hiding
 * it leaves the assistants running.
 */
const aiSessions = [];      // { id, client, pane, chip, routed }
let activeSession = null;
let panel = null;

function ensurePanel() {
  if (panel) return panel;
  const workspace = $('#workspace');
  const resizer = el('div', { id: 'ai-resizer', class: 'v-resizer hidden' });
  const chips = el('div', { class: 'ai-chips' });
  const body = el('div', { class: 'ai-body' });
  const addBtn = el('button', {
    class: 'icon-btn sm', text: '+', title: 'Another session of this assistant, or a different one',
    onClick: async (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      // Each running assistant has its own "Another …" in the list.
      contextMenu(r.left, r.bottom + 4, await aiMenuItems());
    },
  });
  /*
   * Enter, sent to the assistant on show. Its prompt often waits on a key —
   * a confirmation, a trust question, a pasted command — and this answers it
   * without clicking into the terminal first.
   */
  const enterBtn = el('button', {
    class: 'ghost-btn sm ai-enter', text: '\u23CE Enter', title: 'Send Enter to the assistant',
    onClick: async () => {
      const pane = activeSession?.pane;
      if (!pane?.termId) { status('No assistant running to send Enter to'); return; }
      const { sendToPane } = await import('./sessions.js');
      sendToPane(pane, '\r');
      pane.view.focus?.();
    },
  });
  const promptsBtn = el('button', {
    class: 'ghost-btn sm', text: '\u2630 Prompts', title: 'Saved prompts — send one to this assistant',
    onClick: (e) => { const r = e.currentTarget.getBoundingClientRect(); contextMenu(r.left, r.bottom + 4, promptMenuItems()); },
  });
  const saveBtn = el('button', {
    class: 'ghost-btn sm', text: '\u2193 Save', title: 'Save a response — the selection, the screen or the whole conversation',
    onClick: async (e) => { const r = e.currentTarget.getBoundingClientRect(); contextMenu(r.left, r.bottom + 4, saveMenuItems(activeSession?.pane)); },
  });
  const hideBtn = el('button', {
    class: 'icon-btn sm', text: '⟩', title: 'Hide the assistant (it keeps running) — the ✦ button brings it back',
    onClick: () => showAiPanel(false),
  });
  const node = el('aside', { id: 'ai-panel', class: 'hidden' },
    el('div', { class: 'ai-head' },
      el('span', { class: 'ai-badge', text: '✦ AI' }), chips, el('span', { style: 'flex:1' }), promptsBtn, saveBtn, enterBtn, addBtn, hideBtn),
    body,
    keyBar());
  /*
   * Same opt-in as an ordinary pane's own `mouseenter` (sessions.js) — the
   * setting's own label already promises "into panes and the AI panel",
   * but only the panes themselves ever got this; hovering the assistant's
   * head bar, its buttons, or the padding around its terminal did nothing,
   * which is most of the panel's own area. Wired on the whole `aside`
   * rather than relying on the embedded pane's narrower one: `mouseenter`
   * does not bubble, so entering anywhere else in the panel never reached
   * it.
   */
  node.addEventListener('mouseenter', () => {
    if (!state.settings.focusFollowsMouse) return;
    const pane = activeSession?.pane;
    if (!pane) return;
    state.setActivePane(pane.id);
    pane.view.focus?.();
  });
  const width = Number(state.settings.aiPanelWidth) || 460;
  node.style.width = `${Math.max(280, Math.min(1200, width))}px`;
  workspace.append(resizer, node);

  // Drag the left edge; the width is kept for next time.
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = node.offsetWidth;
    resizer.classList.add('dragging');
    const move = (ev) => { node.style.width = `${Math.max(280, Math.min(window.innerWidth - 300, startW - (ev.clientX - startX)))}px`; };
    const up = () => {
      resizer.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      window.api.settings.set({ aiPanelWidth: node.offsetWidth }).then((st) => { state.settings = st; }).catch(() => {});
      activeSession?.pane.view.fitNow();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  panel = { node, resizer, chips, body };
  return panel;
}

/*
 * Keys along the foot of the panel: Esc, ↑, ↓ and Enter.
 *
 * An assistant's questions are menus — pick an option with the arrows, Enter
 * to take it, Esc to back out — and answering one meant clicking into the
 * terminal first. These send the key straight to the assistant in front.
 * On unless turned off, in Settings or by right-clicking the bar.
 */
const AI_KEYS = [
  { label: 'Esc', seq: '\x1b', title: 'Send Escape — back out, or interrupt' },
  { label: '↑', seq: '\x1b[A', title: 'Send the up arrow' },
  { label: '↓', seq: '\x1b[B', title: 'Send the down arrow' },
  { label: '⏎ Enter', seq: '\r', title: 'Send Enter' },
];

function keyBar() {
  const bar = el('div', { class: 'ai-keys' + (state.settings.aiKeys === false ? ' hidden' : '') },
    ...AI_KEYS.map((k) => el('button', {
      class: 'ghost-btn sm', text: k.label, title: k.title,
      // Not taking focus, so the terminal keeps it between presses.
      onMousedown: (e) => e.preventDefault(),
      onClick: async () => {
        const pane = activeSession?.pane;
        if (!pane?.termId) { status('No assistant running to send keys to'); return; }
        const { sendToPane } = await import('./sessions.js');
        sendToPane(pane, k.seq);
        pane.view.focus?.();
      },
    })));
  bar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [{
      label: 'Hide these keys', title: 'Settings → AI brings them back',
      onClick: async () => {
        state.settings = await window.api.settings.set({ aiKeys: false });
        applyAiKeys();
        status('AI keys hidden — Settings brings them back');
      },
    }]);
  });
  return bar;
}

/** Show or hide the key bar to match the setting, after it changes. */
export function applyAiKeys() {
  panel?.node.querySelector('.ai-keys')?.classList.toggle('hidden', state.settings.aiKeys === false);
  activeSession?.pane.view.fitNow?.();
}

/** Whether the panel is on screen. */
export function aiPanelShown() {
  return !!panel && !panel.node.classList.contains('hidden');
}

export function showAiPanel(on) {
  const p = ensurePanel();
  p.node.classList.toggle('hidden', !on);
  p.resizer.classList.toggle('hidden', !on);
  $('#titlebar-actions [data-action="toggle-ai"]')?.classList.toggle('active', !!on);
  requestAnimationFrame(() => {
    activeSession?.pane.view.fitNow();
    for (const pid of state.panesOf(state.activeTabId)) state.getPane(pid)?.view.fitNow();
    if (on) activeSession?.pane.view.focus?.();
  });
}

/**
 * The toolbar's ✦: show or hide what is there, or — with nothing open yet —
 * offer the assistants, starting with the one chosen in Settings.
 */
export async function toggleAiPanel() {
  if (aiSessions.length) return showAiPanel(!aiPanelShown());
  if (state.settings.aiStartup) return openAi(state.settings.aiStartup);
  const btn = $('#titlebar-actions [data-action="toggle-ai"]');
  const r = btn ? btn.getBoundingClientRect() : { left: window.innerWidth - 260, bottom: 40 };
  contextMenu(Math.min(r.left, window.innerWidth - 280), r.bottom + 4, await aiMenuItems());
}

/** Show the panel on a running assistant of this kind. */
function showSession(id) {
  const rec = aiSessions.find((r) => r.client.id === id);
  if (!rec) return openAi(id);
  showAiPanel(true);
  selectSession(rec);
}

function selectSession(rec) {
  activeSession = rec;
  for (const s of aiSessions) {
    s.pane.element.classList.toggle('hidden', s !== rec);
    s.chip.classList.toggle('active', s === rec);
  }
  requestAnimationFrame(() => { rec.pane.view.fitNow(); rec.pane.view.focus?.(); });
}

function closeSession(rec) {
  const i = aiSessions.indexOf(rec);
  if (i < 0) return;
  aiSessions.splice(i, 1);
  if (rec.pane.termId) window.api.localTerm.close(rec.pane.termId).catch(() => {});
  try { rec.pane.view.dispose(); } catch { /* already gone */ }
  rec.pane.element.remove();
  rec.chip.remove();
  state.removePane(rec.pane.id);
  if (activeSession === rec) activeSession = null;
  if (aiSessions.length) selectSession(aiSessions[Math.max(0, i - 1)]);
  else showAiPanel(false);
  if (rec.waiting) {
    const n = aiWaitingCount();
    $('#titlebar-actions [data-action="toggle-ai"]')?.classList.toggle('ai-waiting', n > 0);
  }
  import('./sidebar.js').then((m) => m.renderSidebar()).catch(() => {});
}

/** A running assistant in the panel: the client's own CLI in a terminal. */
async function addSession(c, l, { prompt = '', send = true, name: given = '' } = {}) {
  const p = ensurePanel();
  const { createPane, startLocalTerm, setPaneExplorerVisible } = await import('./sessions.js');
  const pane = await createPane({ tabId: null, kind: 'local', connId: null });
  // The panel's header names it; the pane's own header and file browser
  // belong to a shell, which this is not.
  pane.head?.classList.add('hidden');
  setPaneExplorerVisible(pane, false);
  pane.title = l.title;
  pane.element.classList.add('ai-pane');
  p.body.append(pane.element);
  if (!pane.view.container) pane.view.attach(pane.element.querySelector('.pane-term'));

  /*
   * Two of the same assistant are told apart by number — "Claude Code 2" —
   * the lowest free one, so closing the second and opening another gives a
   * second again rather than a third.
   */
  const used = new Set(aiSessions.filter((r) => r.client.id === c.id).map((r) => r.n));
  let n = 1;
  while (used.has(n)) n++;
  const name = String(given || '').trim() || (n > 1 ? `${l.title} ${n}` : l.title);
  pane.title = name;
  const rec = {
    id: pane.id, client: c, pane, routed: l.routed, chip: null, n,
    // Typed in once the assistant is ready for it (see watchQuestions); left
    // unsent — for the person to add a question to — when `send` is false.
    pendingPrompt: String(prompt || '').trim() || null, pendingSend: send !== false, startedAt: Date.now(),
  };
  const nameNode = el('span', {
    class: 'n', text: name, title: 'Double-click to rename',
    onClick: () => selectSession(rec),
    onDblclick: () => renameSession(rec),
  });
  rec.nameNode = nameNode;
  rec.chip = el('span', { class: 'ai-chip', title: `${name} — ${c.vendor}` },
    nameNode,
    el('button', {
      class: 'x', text: '×', title: `Close ${c.name} (ends its session)`,
      onClick: (e) => { e.stopPropagation(); closeSession(rec); },
    }));
  rec.chip.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: 'Rename\u2026', onClick: () => renameSession(rec) },
      ...saveMenuItems(pane),
      { sep: true },
      { label: `Close ${name}`, icon: '\u2715', onClick: () => closeSession(rec) },
    ]);
  });
  pane.aiSession = { client: c, close: () => closeSession(rec) };
  p.chips.append(rec.chip);
  aiSessions.push(rec);
  watchQuestions();
  import('./sidebar.js').then((m) => m.renderSidebar()).catch(() => {});
  showAiPanel(true);
  selectSession(rec);
  await startLocalTerm(pane, l.cwd || undefined, { command: l.command, args: l.args, env: l.env });
  pane.view.fitNow();
}

/* ------------------------------------------------------------------ */
/* Tools of the person's own                                           */
/* ------------------------------------------------------------------ */

/**
 * Add any command-line assistant: a name, the command, and — if it reads
 * MCP servers from a flag in the standard `{"mcpServers": …}` JSON, as
 * Claude Code and Copilot do — that flag, so it gets ServerLife's tools too.
 * Checked like the built-in ones as soon as it is added.
 */
export async function addCustomTool(existing = null) {
  const name = textInput({ value: existing?.name || '', placeholder: 'Aider' });
  const command = textInput({ value: existing?.command || '', placeholder: 'aider --no-auto-commits' });
  const mcpFlag = textInput({ value: existing?.mcpFlag || '', placeholder: '--mcp-config (leave empty if it has none)' });
  const install = textInput({ value: existing?.install || '', placeholder: 'pipx install aider-chat (optional)' });
  const res = await modal({
    title: existing ? `Edit ${existing.name}` : 'Add a custom AI tool',
    width: 'min(560px, 94vw)',
    render: (body) => body.append(
      field('Name', name),
      field('Command', command, 'What you would type to start it. The first word is what is looked for on your PATH.'),
      field('MCP config flag', mcpFlag, 'If the tool takes MCP servers as {"mcpServers": {...}} JSON after a flag, name the flag and it gets ServerLife’s tools.'),
      field('Install command', install, 'Offered by the check when the tool is not found.')),
    buttons: [
      { label: 'Cancel', value: null },
      { label: existing ? 'Save' : 'Add', class: 'primary-btn', value: 'save' },
    ],
  });
  if (res !== 'save') return;
  if (!command.value.trim()) return toast('A command is needed', 'error');
  const id = existing?.id || `custom-${Date.now().toString(36)}`;
  const entry = { id, name: name.value.trim() || command.value.trim().split(/\s+/)[0], command: command.value.trim(),
    mcpFlag: mcpFlag.value.trim(), install: install.value.trim() };
  const list = (state.settings.aiCustomClients || []).filter((t) => t.id !== id);
  await saveSettings({ aiCustomClients: [...list, entry] });
  await aiClients({ fresh: true });
  import('./sidebar.js').then((m) => m.renderSidebar()).catch(() => {});
  status(`${entry.name} added — checking it`);
  checkAi(id);
}

export async function removeCustomTool(id) {
  const list = state.settings.aiCustomClients || [];
  const t = list.find((x) => x.id === id);
  await saveSettings({
    aiCustomClients: list.filter((x) => x.id !== id),
    ...(state.settings.aiStartup === id ? { aiStartup: '' } : {}),
  });
  await aiClients({ fresh: true });
  import('./sidebar.js').then((m) => m.renderSidebar()).catch(() => {});
  if (t) status(`${t.name} removed`);
}

/** The name of the assistant that opens at startup, if one is set and present. */
export function startupAiName() {
  const id = state.settings.aiStartup;
  return id ? cache?.clients.find((c) => c.id === id && c.available)?.name || null : null;
}

/** How many assistants are open in the panel — of one kind, given its id. */
export function aiRunningCount(id = null) {
  return id ? aiSessions.filter((r) => r.client.id === id).length : aiSessions.length;
}

/** Type a message into an assistant and send it. */
async function sendPrompt(r, text, { send = true } = {}) {
  const { sendToPane } = await import('./sessions.js');
  // One paste, so a message of several lines arrives as one message.
  sendToPane(r.pane, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
  if (send) {
    setTimeout(() => sendToPane(r.pane, '\r'), 200);
    status(`Asked ${r.pane.title}`);
  } else {
    // Left in its input for a question to be added before it goes.
    status(`Put into ${r.pane.title} — add your question and press Enter`, 6000);
    r.pane.view.focus?.();
  }
}

/**
 * Double-click on the AI assistant row: a new session, with a first message
 * if one is typed. Which assistant is chosen here — the one being looked at,
 * else the one that opens at startup, else the first installed — and the
 * message is sent once it has started (or after it has asked, and been
 * answered, anything of its own first).
 */
export async function openAiPrompt() {
  const info = await aiClients();
  const avail = info.clients.filter((c) => c.available);
  if (!avail.length) return openAiPicker();
  const preferred = activeSession?.client.id || state.settings.aiStartup || avail[0].id;
  const pick = el('select', { class: 'ai-prompt-pick' },
    ...avail.map((c) => {
      const n = aiRunningCount(c.id);
      return el('option', { value: c.id, text: c.name + (n ? ` (${n} running — a new one)` : '') });
    }));
  pick.value = preferred;
  const ask = el('textarea', {
    class: 'ai-prompt-text', rows: '4', spellcheck: 'true',
    placeholder: 'What should it do? Leave empty to just open it.',
  });
  const name = textInput({ placeholder: 'prod upgrade — leave empty for the assistant’s name' });
  const start = el('select', { class: 'ai-prompt-pick' });
  const saved = el('select', { class: 'ai-prompt-pick' },
    el('option', { value: '', text: 'Saved prompts…' }),
    ...savedPrompts().map((x, i) => el('option', { value: String(i), text: x.name })));
  saved.addEventListener('change', () => {
    const x = savedPrompts()[Number(saved.value)];
    if (x) { ask.value = x.text; ask.focus(); }
    saved.value = '';
  });
  // What the chosen assistant can pick up again, and whether it takes a name.
  const fit = () => {
    const c = avail.find((x) => x.id === pick.value);
    const was = start.value;
    start.replaceChildren(el('option', { value: '', text: 'A new conversation' }),
      c?.resume?.last ? el('option', { value: 'last', text: 'The last conversation, where it left off' }) : null,
      c?.resume?.pick ? el('option', { value: 'pick', text: 'A past conversation — choose from its list' }) : null);
    start.value = [...start.options].some((o) => o.value === was) ? was : '';
    start.disabled = start.options.length < 2;
    name.placeholder = c?.nameFlag ? 'prod upgrade — leave empty for the assistant’s name' : 'prod upgrade — the tab’s name';
  };
  pick.addEventListener('change', fit);
  fit();
  const res = await modal({
    title: 'New AI session',
    width: 'min(560px, 94vw)',
    render: (b, { close }) => {
      ask.addEventListener('keydown', (e) => {
        // Enter sends, as it does in the assistants; Shift+Enter is a new line.
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); close('open'); }
      });
      b.append(field('Assistant', pick), field('Start with', start), field('Name', name),
        field('Ask it', ask, 'Sent once it is ready. Enter sends; Shift+Enter for a new line.'),
        savedPrompts().length ? saved : null);
      // After the dialog has put its own focus somewhere: typing goes to the question.
      setTimeout(() => ask.focus(), 150);
    },
    buttons: [
      aiSessions.length ? { label: 'Show the panel', value: 'show' } : null,
      { label: 'Cancel', value: null },
      { label: 'Open', class: 'primary-btn', value: 'open' },
    ].filter(Boolean),
  });
  if (res === 'show') return showAiPanel(true);
  if (res !== 'open') return;
  const id = pick.value;
  return openAi(id, {
    prompt: ask.value, resume: start.value, name: name.value.trim(),
    skipCheck: aiRunningCount(id) > 0, fromStartup: aiRunningCount(id) > 0,
  });
}

/** How many assistants have a question waiting. */
export function aiWaitingCount() { return aiSessions.filter((r) => r.waiting).length; }

/*
 * A question waiting, shown in yellow: on the assistant's tab in the panel,
 * on the ✦ button, and on the AI assistant row in the host list — so one
 * asking for permission behind another tab, or with the panel hidden, is
 * not left waiting unseen. Each assistant's screen is looked at a few times
 * a second; a screen counts as asking once it has held still for a moment
 * and its last lines are a question (see aiwaiting.js). Answering it moves
 * the screen on, and the yellow goes.
 */
let watchTimer = null;
function watchQuestions() {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    if (!aiSessions.length) { clearInterval(watchTimer); watchTimer = null; return; }
    let changed = false;
    const now = Date.now();
    for (const r of aiSessions) {
      const tail = screenTail(r.pane.view?.term, 24);
      if (tail !== r.lastTail) { r.lastTail = tail; r.stillSince = now; }
      const still = now - (r.stillSince || now);
      const asking = looksLikeQuestion(tail);
      const waiting = !!r.pane.termId && still >= 900 && asking;
      /*
       * A first message given when it was opened goes in once the assistant
       * has settled at its prompt — not while it is starting, and not into a
       * question it asks first (a folder to trust, a sign-in), which is left
       * for the person to answer. Given up on after two minutes.
       */
      if (r.pendingPrompt && r.pane.termId) {
        if (still >= 1500 && tail.trim() && !asking) {
          const text = r.pendingPrompt;
          r.pendingPrompt = null;
          sendPrompt(r, text, { send: r.pendingSend });
        } else if (now - r.startedAt > 120000) {
          r.pendingPrompt = null;
          toast(`${r.pane.title} did not become ready — type your question into it`, 'error');
        }
      }
      if (waiting !== !!r.waiting) {
        r.waiting = waiting;
        r.chip.classList.toggle('waiting', waiting);
        r.chip.title = waiting ? `${r.pane.title} — has a question waiting for you` : `${r.pane.title} — ${r.client.vendor}`;
        changed = true;
      }
    }
    if (changed) {
      const n = aiWaitingCount();
      const btn = $('#titlebar-actions [data-action="toggle-ai"]');
      btn?.classList.toggle('ai-waiting', n > 0);
      if (btn) btn.title = n ? `AI assistant — ${n} question${n === 1 ? '' : 's'} waiting` : 'AI assistant — show or hide the panel on the right';
      import('./sidebar.js').then((m) => m.renderSidebar()).catch(() => {});
    }
  }, 700);
}

/* ------------------------------------------------------------------ */
/* Names, saved prompts, saved responses, asking about something       */
/* ------------------------------------------------------------------ */

/** Name an assistant's tab — "prod upgrade" rather than "Claude Code 2". */
async function renameSession(rec) {
  const v = await askText({ title: 'Rename', label: 'Name', value: rec.pane.title, confirmLabel: 'Rename' });
  if (!v) return;
  rec.pane.title = v;
  rec.nameNode.textContent = v;
  rec.chip.title = `${v} — ${rec.client.vendor}`;
  import('./sidebar.js').then((m) => m.renderSidebar()).catch(() => {});
}

/*
 * Saved prompts: questions asked often enough to keep, sent to the assistant
 * being looked at. Until the person saves their own, a few that use what
 * ServerLife gives every assistant are offered.
 */
const STARTER_PROMPTS = [
  { name: 'What am I connected to?', text: 'List my open ServerLife sessions and say in a line each what host, cluster and user each one is.' },
  { name: 'Explain the last output', text: 'Read the output of my active ServerLife session and explain what it shows. Point out anything that looks wrong.' },
  { name: 'Disk and memory on my sessions', text: 'For each of my open ServerLife sessions, tell me how to check disk and memory use, and what you would look at first.' },
];
export function savedPrompts() {
  const list = state.settings.aiPrompts;
  return Array.isArray(list) ? list : STARTER_PROMPTS;
}

/** The menu of saved prompts, each sent to the assistant on show. */
function promptMenuItems() {
  const list = savedPrompts();
  return [
    { heading: true, label: 'Saved prompts' },
    ...(list.length ? list.map((x) => ({
      label: x.name, title: x.text,
      onClick: () => askAi(x.text, { send: true }),
    })) : [{ label: 'None saved yet', disabled: true }]),
    { sep: true },
    { label: 'Save a prompt…', icon: '+', onClick: () => editPrompt() },
    list.length ? { label: 'Edit or remove', submenu: list.map((x, i) => ({ label: x.name, onClick: () => editPrompt(i) })) } : null,
  ].filter(Boolean);
}

/** Add a saved prompt, or change or remove one (by its place in the list). */
export async function editPrompt(index = null, preset = '') {
  const list = [...savedPrompts()];
  const cur = index === null ? { name: '', text: preset } : list[index];
  const name = textInput({ value: cur.name, placeholder: 'Check the logs' });
  const text = el('textarea', { class: 'ai-prompt-text', rows: '5', spellcheck: 'true', placeholder: 'What to ask' });
  text.value = cur.text || '';
  const res = await modal({
    title: index === null ? 'Save a prompt' : 'Edit a prompt',
    width: 'min(560px, 94vw)',
    render: (b) => { b.append(field('Name', name), field('Prompt', text)); setTimeout(() => (cur.name ? text : name).focus(), 150); },
    buttons: [
      index !== null ? { label: 'Remove', value: 'remove' } : null,
      { label: 'Cancel', value: null },
      { label: 'Save', class: 'primary-btn', value: 'save' },
    ].filter(Boolean),
  });
  if (res === 'remove') list.splice(index, 1);
  else if (res === 'save') {
    const t = text.value.trim();
    if (!t) return toast('The prompt is empty', 'error');
    const entry = { name: name.value.trim() || t.split('\n')[0].slice(0, 50), text: t };
    if (index === null) list.push(entry); else list[index] = entry;
  } else return;
  await saveSettings({ aiPrompts: list });
  status(res === 'remove' ? 'Prompt removed' : 'Prompt saved');
}

/**
 * Give an assistant something: the one on show, else a new one (the one
 * that opens at startup, else the first installed). `send` false leaves it
 * in the assistant's input, for a question to be added to it.
 */
export async function askAi(text, { send = false } = {}) {
  const rec = activeSession && aiSessions.includes(activeSession) ? activeSession : aiSessions[aiSessions.length - 1];
  if (rec) {
    showAiPanel(true);
    selectSession(rec);
    return sendPrompt(rec, text, { send });
  }
  const info = await aiClients();
  const id = (state.settings.aiStartup && info.clients.find((c) => c.id === state.settings.aiStartup && c.available)?.id)
    || info.clients.find((c) => c.available)?.id;
  if (!id) return openAiPicker();
  return openAi(id, { prompt: text, send, fromStartup: true });
}

/**
 * Ask about something on screen or in the host list: the text with where it
 * came from, put into the assistant's input — not sent — so the question
 * goes with it.
 */
export function askAiAbout(text, source) {
  const body = String(text || '').replace(/\s+$/, '');
  if (!body.trim()) return status('Nothing to ask about');
  return askAi(`From ${source}:\n\`\`\`\n${body}\n\`\`\`\n`, { send: false });
}

/** A host, described for an assistant. */
export function describeHost(host) {
  const labels = Object.entries(host.labels || {}).map(([k, v]) => `${k}=${v}`).join(', ');
  return [
    ['Name', host.name], ['Hostname', host.hostname], ['Address', host.addr], ['Cluster', host.cluster || host.proxy],
    ['UUID', host.uuid], ['Logins', (host.logins || []).join(', ')], ['Labels', labels],
  ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
}

/** The ways to save from an assistant's pane. */
function saveMenuItems(pane) {
  if (!pane?.view) return [{ label: 'No assistant open', disabled: true }];
  const hasSel = pane.view.hasSelection?.();
  return [
    {
      label: 'Save the selection…', icon: '↓', disabled: !hasSel,
      title: hasSel ? '' : 'Select the response in the assistant first',
      onClick: () => saveResponse(pane, pane.view.selection()),
    },
    { label: 'Save what is on screen…', icon: '↓', onClick: () => saveResponse(pane, screenTail(pane.view.term, pane.view.term?.rows || 40)) },
    { label: 'Save the whole conversation…', icon: '↓', onClick: () => saveResponse(pane, pane.view.allText()) },
    { sep: true },
    { label: 'Saved responses…', icon: '☰', onClick: () => openSavedResponses() },
  ];
}

/** Keep a response: named, and saved as Markdown in the assistants' folder. */
export async function saveResponse(pane, text) {
  const body = String(text || '').trim();
  if (!body) return status('Nothing to save');
  /*
   * A name to start from: the assistant's last answer (the line its marker
   * starts — ⏺ or ●), else the first line that is words rather than a logo
   * or a rule.
   */
  const lines = body.split('\n');
  const answer = [...lines].reverse().find((l) => /^\s*[⏺●•]\s+\S/.test(l));
  const wordy = lines.find((l) => (l.match(/[A-Za-z]/g) || []).length > l.trim().length / 2);
  const first = String(answer || wordy || '').replace(/^[\s●⏺>❯•*-]+/, '').trim();
  const title = await askText({ title: 'Save a response', label: 'Name', value: first.slice(0, 60), confirmLabel: 'Save' });
  if (title === null || title === undefined) return;
  try {
    const r = await window.api.ai.saveResponse({ title, text: body, source: pane?.title || '' });
    toast(`Saved — ${r.file}`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

/** What has been saved: read, copy, give back to an assistant, or remove. */
export async function openSavedResponses() {
  const list = await window.api.ai.savedList().catch(() => []);
  const rows = el('div', { class: 'ai-saved-list' });
  const view = el('pre', { class: 'ai-saved-view', text: list.length ? 'Choose one to read it.' : 'Nothing saved yet. Use ↓ Save in the AI panel, or right-click an assistant.' });
  let current = null;
  const actions = el('div', { class: 'ai-saved-actions hidden' });
  const show = async (it, row) => {
    current = { ...it, text: await window.api.ai.savedRead(it.file).catch((e) => e.message) };
    view.textContent = current.text;
    for (const r of rows.children) r.classList.toggle('active', r === row);
    actions.classList.remove('hidden');
  };
  for (const it of list) {
    const row = el('div', { class: 'ai-saved-row' },
      el('span', { class: 't', text: it.title }),
      el('span', { class: 'hint', text: new Date(it.mtime).toLocaleString() }));
    row.addEventListener('click', () => show(it, row));
    rows.append(row);
  }
  actions.append(
    el('button', { class: 'ghost-btn sm', text: 'Copy', onClick: () => { window.api.clipboard.write(current.text); status('Copied'); } }),
    el('button', { class: 'ghost-btn sm', text: 'Give to the assistant', title: 'Put it into the assistant’s input, to ask about it', onClick: () => askAiAbout(current.text, `my saved response "${current.title}"`) }),
    el('button', { class: 'ghost-btn sm', text: 'Show in Finder', onClick: () => window.api.ai.savedReveal(current.file) }),
    el('button', {
      class: 'ghost-btn sm danger', text: 'Delete',
      onClick: async () => {
        await window.api.ai.savedDelete(current.file).catch((e) => toast(e.message, 'error'));
        [...rows.children].find((r) => r.classList.contains('active'))?.remove();
        view.textContent = 'Deleted.'; actions.classList.add('hidden'); current = null;
      },
    }));
  await modal({
    title: 'Saved responses',
    width: 'min(860px, 94vw)',
    render: (b) => b.append(el('div', { class: 'ai-saved' }, rows, el('div', { class: 'ai-saved-main' }, actions, view))),
    buttons: [
      { label: 'Open the folder', onClick: () => window.api.ai.savedReveal() },
      { label: 'Close', class: 'primary-btn', value: null },
    ],
  });
}
