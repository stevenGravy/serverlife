import { el } from './util.js';
import { modal, toast, confirm } from './ui.js';
import { state } from './state.js';

/*
 * Common ssh options, in one list used two ways: as `Name=value` lines for
 * a host's or profile's "extra ssh options" (passed as `-o`), and as the
 * indented `Name value` lines an ssh_config Host block holds. `file: true`
 * asks for a key file first; `warn` is said before it is added.
 */
export const SSH_OPTION_PRESETS = [
  {
    group: 'Keys', label: 'Use only this key file…', file: true,
    help: 'Offers just the one key (a .pem or id_* file) — not every key in the agent and ~/.ssh.',
    lines: (f) => [['IdentityFile', f], ['IdentitiesOnly', 'yes']],
  },
  {
    group: 'Keys', label: 'Offer only the keys named here (IdentitiesOnly)',
    help: 'Stops ssh trying every agent key first — the usual cure for "Too many authentication failures".',
    lines: () => [['IdentitiesOnly', 'yes']],
  },
  {
    group: 'Keys', label: 'Offer no SSH keys at all',
    help: 'Password or keyboard-interactive only; no public key is tried.',
    lines: () => [['PubkeyAuthentication', 'no']],
  },
  {
    group: 'Keys', label: "Don't use the SSH agent",
    help: 'Ignores ssh-agent (and 1Password, Secretive…) for this host.',
    lines: () => [['IdentityAgent', 'none']],
  },
  {
    group: 'Keys', label: 'Password login only',
    help: 'Goes straight to a password prompt.',
    lines: () => [['PreferredAuthentications', 'password,keyboard-interactive'], ['PubkeyAuthentication', 'no']],
  },
  {
    group: 'Keys', label: 'Forward my SSH agent',
    help: 'Lets the server use your local keys to hop on. Only for hosts you trust.',
    warn: 'Anyone with root on that host can use your agent while you are connected.',
    lines: () => [['ForwardAgent', 'yes']],
  },
  {
    group: 'Connection', label: 'Keep the connection alive',
    help: 'A keep-alive every 30 s; gives up after 3 missed — for idle links and NAT that drop quiet sessions.',
    lines: () => [['ServerAliveInterval', '30'], ['ServerAliveCountMax', '3']],
  },
  {
    group: 'Connection', label: 'Give up connecting after 10 seconds',
    lines: () => [['ConnectTimeout', '10']],
  },
  {
    group: 'Connection', label: 'Compress traffic',
    help: 'Helps on slow links; costs CPU on fast ones.',
    lines: () => [['Compression', 'yes']],
  },
  {
    group: 'Host keys', label: 'Accept a new host key, refuse a changed one',
    help: 'First connection needs no "yes"; a key that changes later is still refused.',
    lines: () => [['StrictHostKeyChecking', 'accept-new']],
  },
  {
    group: 'Host keys', label: "Don't check host keys (throwaway lab hosts)",
    help: 'For containers and VMs rebuilt with a new key every time.',
    warn: 'Turns off protection against a man-in-the-middle for this host.',
    lines: () => [['StrictHostKeyChecking', 'no'], ['UserKnownHostsFile', '/dev/null']],
  },
  {
    group: 'Compatibility', label: 'Allow old ssh-rsa keys (legacy servers)',
    help: 'For servers that only offer RSA/SHA-1, which modern OpenSSH refuses by default.',
    lines: () => [['HostKeyAlgorithms', '+ssh-rsa'], ['PubkeyAcceptedAlgorithms', '+ssh-rsa']],
  },
];

const presetsIn = (group) => SSH_OPTION_PRESETS.filter((p) => p.group === group);
const GROUPS = [...new Set(SSH_OPTION_PRESETS.map((p) => p.group))];

/** A preset's lines, resolving a file pick first. null if cancelled. */
async function resolvePreset(preset) {
  let file = null;
  if (preset.file) {
    file = await window.api.discovery.pickKey().catch(() => null);
    if (!file) return null;
  }
  if (preset.warn) {
    const ok = await confirm({ title: preset.label, message: preset.warn, confirmLabel: 'Add it' });
    if (!ok) return null;
  }
  return preset.lines(file);
}

/** Add option lines to a textarea, replacing a line for the same option — `Name=value`, or ssh_config's `Name value`. */
function addOptionLines(textarea, pairs, format = 'option') {
  const lines = textarea.value.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const [name, value] of pairs) {
    const i = lines.findIndex((l) => l.split(/[= ]/)[0].toLowerCase() === name.toLowerCase());
    const line = format === 'config' ? `${name} ${value}` : `${name}=${value}`;
    if (i >= 0) lines[i] = line; else lines.push(line);
  }
  textarea.value = lines.join('\n');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * The picker beside an "extra ssh options" box: a list of common options
 * that adds them as `Name=value` lines (typing your own still works), and
 * a way to make what is in the box the default for every new host and
 * profile (settings.defaultSshOptions).
 */
export function sshOptionPicker(textarea, { format = 'option' } = {}) {
  const sel = el('select', { title: 'Add a common ssh option — or type your own in the box' },
    el('option', { value: '', text: 'Add a common option…' }),
    ...GROUPS.map((g) => el('optgroup', { label: g },
      ...presetsIn(g).map((p) => el('option', { value: String(SSH_OPTION_PRESETS.indexOf(p)), text: p.label, title: p.help || '' })))));
  sel.addEventListener('change', async () => {
    const preset = SSH_OPTION_PRESETS[Number(sel.value)];
    sel.value = '';
    if (!preset) return;
    const pairs = await resolvePreset(preset);
    if (pairs) addOptionLines(textarea, pairs, format);
  });
  const defaultBtn = el('button', {
    class: 'ghost-btn sm', type: 'button', text: 'Use for new hosts by default',
    title: 'Every new host and saved profile starts with these options',
    onClick: async () => {
      const value = textarea.value.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
      state.settings = await window.api.settings.set({ defaultSshOptions: value });
      toast(value ? 'New hosts and profiles will start with these ssh options' : 'No default ssh options any more');
    },
  });
  return el('div', { style: 'display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap' }, sel, defaultBtn);
}

/** What a new host or profile's extra options start as. */
export function defaultSshOptions() {
  return String(state.settings.defaultSshOptions || '');
}

/* ------------------------------------------------------------------ */
/* Editing an ssh config file in the app                               */
/* ------------------------------------------------------------------ */

const HOST_TEMPLATE = (alias = 'my-server') => [
  `Host ${alias}`,
  '  HostName 203.0.113.10',
  '  User ubuntu',
  '  Port 22',
  '  IdentityFile ~/.ssh/my-key.pem',
  '  IdentitiesOnly yes',
].join('\n');

const SNIPPETS = [
  { label: 'A new host', help: 'A Host block to fill in — the alias is what you type after ssh.', text: HOST_TEMPLATE() },
  { label: 'Through a jump host', help: 'Reach a private host via a bastion.', text: 'Host private-db\n  HostName 10.0.1.20\n  User admin\n  ProxyJump bastion' },
  { label: 'Defaults for every host', help: 'Put it last: ssh uses the first value it finds for each option.', text: 'Host *\n  ServerAliveInterval 30\n  ServerAliveCountMax 3\n  AddKeysToAgent yes' },
  { label: 'A local port forward', help: 'localhost:5432 reaches the database behind the host.', text: '  LocalForward 5432 localhost:5432' },
  { label: 'Pull in other files', help: 'At the top of the file — keep per-project hosts separate.', text: 'Include ~/.ssh/config.d/*' },
];

/** Insert text at the editor's cursor, on its own line(s) (see sshconfigeditor.js). */
function insertAtCursor(editor, text) {
  editor.insert(text);
}

const suggestionCard = (title, help, text, area) => el('div', { style: 'border:1px solid var(--border-soft);border-radius:6px;padding:6px 8px;margin-bottom:8px' },
  el('div', { style: 'font-weight:600;font-size:12px', text: title }),
  help ? el('div', { style: 'color:var(--muted);font-size:11px;margin:2px 0 4px', text: help }) : null,
  el('pre', { style: 'font-family:var(--mono);font-size:11px;margin:0 0 6px;white-space:pre-wrap;user-select:text', text }),
  el('div', { style: 'display:flex;gap:6px' },
    el('button', { class: 'ghost-btn sm', type: 'button', text: 'Copy', onClick: async () => { await window.api.clipboard.write(text); toast('Copied'); } }),
    el('button', { class: 'ghost-btn sm', type: 'button', text: 'Insert at cursor', onClick: () => insertAtCursor(area, text) })));

/**
 * The ssh config, edited here: the file on the left, suggestions on the
 * right — a Host block to fill in, common setups, and every option from the
 * picker in ssh_config's own `Name value` form — each one to copy or drop
 * in at the cursor. Saving has ssh parse it first (see main.js); a bad line
 * is shown with its line number and nothing is written.
 */
export async function editSshConfig(file = null) {
  let loaded;
  try { loaded = await window.api.discovery.readSshConfig(file); } catch (e) { return toast(e.message, 'error'); }
  // Coloured as ssh_config: Host/Match lines, option names, values, comments,
  // and an option ssh would not know underlined as it is typed. Tab indents.
  const { createSshConfigEditor } = await import('./sshconfigeditor.js');
  const area = createSshConfigEditor({ value: loaded.text });
  const areaBox = el('div', { style: 'min-height:52vh;height:60vh;border:1px solid var(--border);border-radius:6px;overflow:hidden' }, area.dom);
  const note = el('div', { class: 'hint', style: 'min-height:1.3em' });
  const say = (text, bad = false) => { note.textContent = text; note.style.color = bad ? 'var(--red)' : ''; };

  const optionCards = SSH_OPTION_PRESETS.filter((p) => !p.file).map((p) => suggestionCard(
    p.label, [p.help, p.warn ? `⚠ ${p.warn}` : ''].filter(Boolean).join(' '),
    p.lines().map(([n, v]) => `  ${n} ${v}`).join('\n'), area));
  const keyCard = el('div', { style: 'border:1px solid var(--border-soft);border-radius:6px;padding:6px 8px;margin-bottom:8px' },
    el('div', { style: 'font-weight:600;font-size:12px', text: 'Use only this key file…' }),
    el('div', { style: 'color:var(--muted);font-size:11px;margin:2px 0 4px', text: 'Pick a .pem or id_* file; adds IdentityFile and IdentitiesOnly at the cursor.' }),
    el('button', {
      class: 'ghost-btn sm', type: 'button', text: 'Choose a key and insert…',
      onClick: async () => {
        const f = await window.api.discovery.pickKey().catch(() => null);
        if (f) insertAtCursor(area, `  IdentityFile ${f}\n  IdentitiesOnly yes`);
      },
    }));
  const side = el('div', { style: 'overflow:auto;max-height:60vh;padding-right:4px' },
    el('div', { style: 'font-weight:600;margin-bottom:6px', text: 'Suggestions' }),
    el('div', { class: 'hint', style: 'margin-bottom:8px', text: 'Copy one, or put the cursor where it belongs and insert it. Options go indented under a Host line.' }),
    ...SNIPPETS.map((x) => suggestionCard(x.label, x.help, x.text, area)),
    el('div', { style: 'font-weight:600;margin:10px 0 6px', text: 'Options for a Host block' }),
    keyCard, ...optionCards);

  const save = async () => {
    say('Checking with ssh…');
    const r = await window.api.discovery.writeSshConfig({ file: loaded.path, text: area.getValue() }).catch((e) => ({ ok: false, errors: [e.message] }));
    if (!r.ok) { say(`Not saved — ssh can't read it:\n${(r.errors || []).join('\n')}`, true); return false; }
    toast(`Saved ${r.path} — the previous version is in ${r.backup.split('/').pop()}`);
    const { refreshInventory } = await import('./sidebar.js');
    refreshInventory(true);
    return true;
  };
  await modal({
    title: 'Edit ssh config', subtitle: loaded.path, width: 'min(1200px, 96vw)', resize: 'sshconfig-editor',
    render: (body) => body.append(
      el('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px;align-items:stretch' }, areaBox, side),
      note),
    buttons: [
      { label: 'Open in external editor', onClick: () => window.api.discovery.openSshConfigInEditor(loaded.path) },
      {
        label: 'Check', onClick: async () => {
          const r = await window.api.discovery.checkSshConfig({ file: loaded.path, text: area.getValue() });
          say(r.ok ? 'ssh reads it fine.' : `ssh can't read it:\n${(r.errors || []).join('\n')}`, !r.ok);
        },
      },
      { label: 'Cancel', value: false },
      { label: 'Save', class: 'primary-btn', onClick: async ({ close }) => { if (await save()) close(true); } },
    ],
  });
}
