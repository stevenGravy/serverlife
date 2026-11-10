import { state } from './state.js';
import { el } from './util.js';
import { modal, toast, status, prompt, select, textInput, field, checkbox } from './ui.js';
import { sshOptionPicker } from './sshpresets.js';
import { openHost } from './sessions.js';

/**
 * SSH options for a host: X11, forwards both ways, a SOCKS proxy, a jump
 * host, and Teleport's reason, invitations and automatic access requests.
 *
 * Not everything wanted once is wanted every time, so there are three ways to
 * use a set: open once with it, keep it as a named preset to open with when
 * wanted, or make it the host's default, used every time it is opened. The
 * flags themselves are built and checked in the main process (sshoptions.js),
 * which is also where the default is applied.
 */

/** The host's saved record, read from settings so a menu can be built at once. */
function savedFor(host, hostPrefKey) {
  const rec = (state.settings.sshOptionsHosts || {})[hostPrefKey(host)] || {};
  return { default: rec.default || null, presets: Array.isArray(rec.presets) ? rec.presets : [] };
}

/** A few words for a set of options, for a menu line. */
function briefly(o) {
  if (!o) return '';
  const bits = [];
  if (o.x11 && o.x11 !== 'off') bits.push(`X11 ${o.x11}`);
  if (o.localForwards?.length) bits.push(`-L ${o.localForwards.join(' ')}`);
  if (o.remoteForwards?.length) bits.push(`-R ${o.remoteForwards.join(' ')}`);
  if (o.dynamicForwards?.length) bits.push(`SOCKS ${o.dynamicForwards.join(' ')}`);
  if (o.jumpHost) bits.push(`via ${o.jumpHost}`);
  if (o.reason) bits.push(`reason "${o.reason}"`);
  if (o.invite?.length) bits.push(`invites ${o.invite.join(', ')}`);
  if (o.requestMode) bits.push(`auto request ${o.requestMode}`);
  if (o.noResume) bits.push('no resume');
  if (o.noShell) bits.push('no shell (-N)');
  if (o.extraOptions?.length) bits.push(`-o ${o.extraOptions.join(' ')}`);
  return bits.join(' · ');
}

async function refreshSettings() {
  state.settings = await window.api.settings.get();
}

async function openWith(host, login, options, label) {
  try {
    status(`Opening ${host.name || host.alias}${label ? ` (${label})` : ''}…`, 0);
    // A forwarding-only (-N) opening is set up as a tunnel by openHost itself,
    // so a host's default -N is handled the same way as this menu's.
    await openHost(host, { login, sshOptions: options, reuse: false });
    status('');
  } catch (e) {
    status('');
    toast(e.message, 'error');
  }
}

/**
 * The host menu's "SSH options" entry, replacing the X11 one it grew from.
 * `openX11` is the existing path, which checks for an X server first.
 */
export function sshOptionsMenu(host, { login, hostPrefKey, openX11 }) {
  const saved = savedFor(host, hostPrefKey);
  const teleport = host.type === 'teleport';
  const items = [];

  if (saved.default) {
    items.push({ heading: true, label: 'Default for this host' });
    items.push({ label: briefly(saved.default) || '(nothing)', disabled: true });
    items.push({
      label: 'Open plain, without the default',
      title: 'Just this once: no saved options',
      onClick: () => openWith(host, login, null, 'plain'),
    });
  }
  if (saved.presets.length) {
    items.push({ heading: true, label: 'Open as' });
    for (const p of saved.presets) {
      items.push({
        label: p.name, sub: briefly(p.options), title: briefly(p.options),
        onClick: () => openWith(host, login, p.options, p.name),
      });
    }
  }
  if (items.length) items.push({ sep: true });

  items.push(
    { label: 'Open with X11 forwarding', icon: '⌗', onClick: () => openX11(host, login) },
    {
      label: 'Remote forward (-R)…', icon: '↩',
      title: 'Make a port on this machine reachable from the host',
      onClick: () => openSshOptionsDialog(host, { login, hostPrefKey, focus: 'remoteForwards' }),
    },
    {
      label: 'SOCKS proxy (-D)…', icon: '⦿',
      title: 'Browse through the host, as if from where it is',
      onClick: () => openSshOptionsDialog(host, { login, hostPrefKey, focus: 'dynamicForwards' }),
    },
    teleport ? {
      label: 'Reason and invitations…', icon: '✉',
      title: 'Say why, and invite people to watch or moderate the session',
      onClick: () => openSshOptionsDialog(host, { login, hostPrefKey, focus: 'reason' }),
    } : null,
    { sep: true },
    {
      label: 'All SSH options…', icon: '⚙',
      title: 'Every option in one place — open once, save as a preset, or make it the default',
      onClick: () => openSshOptionsDialog(host, { login, hostPrefKey }),
    },
    saved.default ? {
      label: 'Clear the default', icon: '✕',
      onClick: async () => {
        await window.api.sshopts.save(host, { clearDefault: true });
        await refreshSettings();
        status('Default SSH options cleared for this host');
      },
    } : null,
    saved.presets.length ? {
      label: 'Delete a preset', icon: '✕',
      submenu: saved.presets.map((p) => ({
        label: p.name,
        onClick: async () => {
          await window.api.sshopts.save(host, { deletePreset: p.name });
          await refreshSettings();
          status(`Preset "${p.name}" deleted`);
        },
      })),
    } : null,
  );

  const n = (saved.default ? 1 : 0) + saved.presets.length;
  return {
    label: 'SSH options' + (n ? ` (${saved.default ? 'default set' : ''}${saved.default && saved.presets.length ? ', ' : ''}${saved.presets.length ? `${saved.presets.length} preset${saved.presets.length === 1 ? '' : 's'}` : ''})` : ''),
    icon: '⌗',
    submenu: items.filter(Boolean),
  };
}

/**
 * Every option in one dialog.
 *
 * Opens on the host's default, or on a preset when one is passed, so editing
 * is a matter of opening, changing and saving. Errors are checked as you
 * type, by the same code that will build the flags.
 */
export async function openSshOptionsDialog(host, { login, hostPrefKey, focus = null, start = null } = {}) {
  const saved = savedFor(host, hostPrefKey);
  const o = start || saved.default || {};
  const teleport = host.type === 'teleport';
  const area = (value, placeholder) => {
    const t = el('textarea', { rows: '2', spellcheck: 'false', placeholder });
    t.value = (value || []).join('\n');
    t.style.cssText = 'width:100%;font-family:var(--mono);font-size:12px;resize:vertical';
    return t;
  };

  const x11 = select([
    { value: 'off', label: 'Off' },
    { value: 'untrusted', label: 'Untrusted (-X) — the safer one' },
    { value: 'trusted', label: 'Trusted (-Y) — for programs that need full access' },
  ], o.x11 || 'off');
  const local = area(o.localForwards, '5432:db.internal:5432 — one per line');
  const remote = area(o.remoteForwards, '9000:localhost:3000 — port on the host : where it goes here');
  const dynamic = textInput({ value: (o.dynamicForwards || []).join(', '), placeholder: '1080' });
  const jump = textInput({ value: o.jumpHost || '', placeholder: 'user@bastion, or a chain: bastion1,user@bastion2:22' });
  const noShell = checkbox('Forwarding only \u2014 no shell (-N)', !!o.noShell);
  const extra = area(o.extraOptions, 'ServerAliveInterval=30 — any ssh -o option, one per line');
  const reason = textInput({ value: o.reason || '', placeholder: 'INC-1234: disk full on /var' });
  const invite = textInput({ value: (o.invite || []).join(', '), placeholder: 'alice@example.com, bob' });
  const reqMode = select([
    { value: '', label: 'Cluster default' },
    { value: 'resource', label: 'Request this node' },
    { value: 'role', label: 'Request a role' },
    { value: 'off', label: 'Never' },
  ], o.requestMode || '');
  const reqReason = textInput({ value: o.requestReason || '', placeholder: 'Why access is needed' });
  const noResume = checkbox('Do not resume the session after a network drop (--no-resume)', !!o.noResume);
  const problems = el('div', { class: 'hint', style: 'color:var(--red);white-space:pre-wrap;min-height:1em' });
  const warnEl = el('div', { class: 'hint', style: 'color:var(--muted);white-space:pre-wrap' });
  const note = el('div', { class: 'hint' });

  const collect = () => ({
    x11: x11.value,
    localForwards: local.value, remoteForwards: remote.value,
    dynamicForwards: dynamic.value, jumpHost: jump.value, extraOptions: extra.value,
    noShell: noShell.input.checked,
    ...(teleport ? {
      reason: reason.value, invite: invite.value, requestMode: reqMode.value,
      requestReason: reqReason.value, noResume: noResume.input.checked,
    } : {}),
  });
  let last = { errors: [], warnings: [] };
  const check = async () => {
    last = await window.api.sshopts.check(collect()).catch(() => ({ errors: [], warnings: [] }));
    problems.textContent = last.errors.join('\n');
    warnEl.textContent = (last.warnings || []).join('\n');
    note.textContent = teleport && last.needsTsh
      ? 'A reason, invitations or automatic requests open this host over tsh ssh — OpenSSH has no flag for them.'
      : '';
  };
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(check, 250); };

  const name = host.name || host.alias;
  const res = await modal({
    title: `SSH options — ${name}`,
    subtitle: start ? 'Editing a preset' : (saved.default ? 'Showing the default for this host' : 'Nothing saved for this host yet'),
    width: 'min(640px, 94vw)',
    render: (body) => {
      const sec = (t) => el('div', {
        style: 'font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:12px 0 4px',
        text: t,
      });
      body.append(
        sec('Forwarding'),
        field('X11', x11),
        field('Local forwards (-L)', local),
        field('Remote forwards (-R)', remote, 'A port on the host that reaches back to this machine'),
        el('div', { class: 'field-row' },
          field('SOCKS proxy port (-D)', dynamic),
          field('Jump host (-J)', jump)),
        noShell,
        el('div', { class: 'hint', style: 'margin:2px 0 8px 22px',
          text: 'The pane holds the forwards open and runs nothing on the host \u2014 a tunnel, not a shell.' }),
        field('Other ssh options (-o)', el('div', {}, extra, sshOptionPicker(extra))),
        teleport ? sec('Teleport') : null,
        teleport ? field('Reason for the session (--reason)', reason) : null,
        teleport ? field('Invite (--invite)', invite, 'People to mark as invited to the session, to watch or moderate') : null,
        teleport ? el('div', { class: 'field-row' },
          field('If access is missing (--request-mode)', reqMode),
          field('Request reason', reqReason)) : null,
        teleport ? noResume : null,
        note, problems, warnEl);
      for (const n of [x11, local, remote, dynamic, jump, extra, reason, invite, reqMode, reqReason, noResume.input, noShell.input]) {
        n.addEventListener('input', later);
        n.addEventListener('change', later);
      }
      check();
      const target = { remoteForwards: remote, dynamicForwards: dynamic, reason }[focus];
      if (target) setTimeout(() => target.focus(), 60);
    },
    buttons: [
      { label: 'Cancel', value: null },
      /*
       * The same session as a command to paste into a terminal — the options
       * as they stand in the form, saved or not. Built by the code that
       * builds the real flags, so the two cannot drift apart.
       */
      {
        label: 'Copy command',
        onClick: async () => {
          await check();
          if (last.errors.length) return toast(last.errors[0], 'error');
          const cmd = await window.api.sshopts.command(host, last.options || collect(), login);
          window.api.clipboard.write(cmd);
          status('Copied: ' + cmd, 8000);
        },
      },
      { label: 'Save as a preset…', onClick: ({ close }) => close('preset') },
      { label: 'Save as default', onClick: ({ close }) => close('default') },
      { label: 'Open once', class: 'primary-btn', onClick: ({ close }) => close('once') },
    ],
  });
  if (!res) return;

  await check();
  if (last.errors.length) {
    toast(last.errors[0], 'error', 8000);
    return openSshOptionsDialog(host, { login, hostPrefKey, focus, start: collect() });
  }
  const options = last.options || collect();

  if (res === 'once') return openWith(host, login, options, 'these options');

  if (res === 'preset') {
    const presetName = await prompt({
      title: 'Name the preset',
      label: `Opened from ${name}'s SSH options menu — never applied unless picked`,
      value: briefly(options).slice(0, 40) || 'My options',
      confirmLabel: 'Save preset',
      validate: (v) => (v ? null : 'Give it a name'),
    });
    if (!presetName) return;
    const r = await window.api.sshopts.save(host, { presetName, options });
    if (!r.ok) return toast(r.errors[0], 'error');
    await refreshSettings();
    return status(`Preset "${presetName}" saved for ${name}`);
  }

  const r = await window.api.sshopts.save(host, { asDefault: true, options });
  if (!r.ok) return toast(r.errors[0], 'error');
  await refreshSettings();
  status(briefly(options) ? `Default SSH options saved for ${name}: ${briefly(options)}` : `${name} has no default SSH options now`);
}
