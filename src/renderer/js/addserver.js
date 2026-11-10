import { state } from './state.js';
import { el } from './util.js';
import { modal, field, textInput, select, checkbox, toast, status, confirm } from './ui.js';
import { sshOptionPicker, defaultSshOptions, editSshConfig } from './sshpresets.js';

/**
 * Defining a new server.
 *
 * Two destinations, because they mean different things: writing to
 * `~/.ssh/config` makes the host available to `ssh`, `scp`, Ansible and
 * everything else on the machine; saving it here keeps it to this app. The
 * dialog says which is which rather than picking for you.
 */
export async function openAddServerDialog(initial = {}) {
  const nameIn = textInput({ value: initial.name || '', placeholder: 'web-1', autofocus: true });
  const hostIn = textInput({ value: initial.hostname || '', placeholder: 'web-1.example.com or 10.0.0.5' });
  const userIn = textInput({ value: initial.user || '', placeholder: state.appInfo?.user || 'ubuntu' });
  const portIn = textInput({ type: 'number', value: initial.port || 22, min: 1, max: 65535 });
  const jumpIn = textInput({ value: initial.proxyJump || '', placeholder: 'bastion.example.com (optional)' });

  const keyIn = textInput({ value: initial.identityFile || '', placeholder: '~/.ssh/id_ed25519 (optional)' });
  const keyBtn = el('button', {
    class: 'ghost-btn sm', text: 'Browse…',
    onClick: async () => {
      const p = await window.api.discovery.pickKey();
      if (p) keyIn.value = p;
    },
  });

  const extraIn = el('textarea', {
    style: 'width:100%;height:64px;font-family:var(--mono);font-size:11.5px',
    placeholder: 'ServerAliveInterval 30\nForwardAgent yes',
    spellcheck: 'false',
  });
  // A new host starts with the default options, if any were set (see sshpresets.js).
  extraIn.value = initial.extraOptions ?? (initial.alias ? '' : defaultSshOptions());

  // Opened from a config file's menu: that file is where "config" writes.
  const cfgFile = initial.configFile || null;
  const cfgLabel = cfgFile ? cfgFile.replace(/^\/(Users|home)\/[^/]+/, '~') : '~/.ssh/config';
  const destSel = select([
    { value: 'config', label: `Write to ${cfgLabel} — usable by ssh, scp and everything else` },
    { value: 'app', label: 'Save in ServerLife only — leaves ~/.ssh/config untouched' },
  ], initial.destination || 'config');

  const saveProfile = checkbox('Also save as a profile in the Saved tab', true);

  const note = el('div', { class: 'hint' });
  const syncNote = () => {
    note.textContent = destSel.value === 'config'
      ? 'Added inside a marked ServerLife block. Your own entries are never reformatted, and a backup is taken first.'
      : 'Connection details are passed to ssh directly. Nothing else on this machine will know about this host.';
  };
  destSel.addEventListener('change', syncNote);
  syncNote();

  const res = await modal({
    title: cfgFile ? `New host in ${cfgLabel}` : 'Add a server',
    width: 'min(660px, 94vw)',
    render: (body) => {
      body.append(
        el('div', { class: 'field-row' },
          field('Name / alias', nameIn, 'How you will refer to it'),
          field('Hostname or IP', hostIn)),
        el('div', { class: 'field-row' },
          field('User', userIn),
          field('Port', portIn)),
        field('Private key', el('div', { style: 'display:flex;gap:6px' }, keyIn, keyBtn), 'Optional — otherwise your agent and defaults are used'),
        field('Jump host (ProxyJump)', jumpIn, 'Optional — reach this host through a bastion'),
        field('Extra ssh options', el('div', {}, extraIn, sshOptionPicker(extraIn, { format: 'config' })), 'One per line, as they appear in ssh_config — pick a common one, or type your own'),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('Where to save it', destSel),
        note,
        el('div', { style: 'margin-top:10px' }, saveProfile));
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Test connection',
        onClick: async () => {
          const h = collect();
          if (!h) return;
          await testConnection(h);
        },
      },
      {
        label: 'Add server', class: 'primary-btn',
        onClick: ({ close }) => {
          const h = collect();
          if (h) close(h);
        },
      },
    ],
  });

  function collect() {
    const alias = nameIn.value.trim();
    const hostname = hostIn.value.trim();
    if (!alias) { toast('Give the server a name', 'error'); return null; }
    if (/\s/.test(alias)) { toast('The name cannot contain spaces', 'error'); return null; }
    if (!hostname) { toast('Hostname or IP is required', 'error'); return null; }
    return {
      alias,
      hostname,
      user: userIn.value.trim(),
      port: parseInt(portIn.value, 10) || 22,
      identityFile: keyIn.value.trim(),
      proxyJump: jumpIn.value.trim(),
      extraOptions: extraIn.value,
      destination: destSel.value,
      saveProfile: saveProfile.input.checked,
    };
  }

  if (!res) return null;

  try {
    if (res.destination === 'config') {
      try {
        await window.api.discovery.addSshHost({ ...res, file: cfgFile });
      } catch (e) {
        // The one refusal worth offering to override.
        if (/already defines/.test(e.message)) {
          const ok = await confirm({
            title: 'Alias already in use',
            message: e.message,
            detail: 'Adding it anyway means two Host blocks with the same name; ssh uses the first it finds, which may not be this one.',
            confirmLabel: 'Add anyway', danger: true,
          });
          if (!ok) return null;
          await window.api.discovery.addSshHost({ ...res, file: cfgFile, force: true });
        } else {
          throw e;
        }
      }
      status(`Added ${res.alias} to ${cfgLabel}`);
      toast(`${res.alias} added to ${cfgLabel}`, 'success');
    } else {
      status(`Saved ${res.alias}`);
    }

    if (res.saveProfile || res.destination === 'app') {
      await window.api.profiles.save({
        name: res.alias,
        type: 'ssh',
        alias: res.destination === 'config' ? res.alias : null,
        hostname: res.hostname,
        user: res.user || null,
        port: res.port,
        identityFile: res.identityFile || null,
        // App-only hosts carry everything needed to dial them.
        direct: res.destination === 'app' ? {
          hostname: res.hostname,
          user: res.user || null,
          port: res.port,
          identityFile: res.identityFile || null,
          proxyJump: res.proxyJump || null,
          extraOptions: res.extraOptions || '',
        } : null,
      });
    }

    const { refreshInventory, reloadProfiles } = await import('./sidebar.js');
    await refreshInventory();
    await reloadProfiles();
    return res;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

/** Dial the host once and report what happened, before committing to it. */
async function testConnection(h) {
  status(`Testing ${h.alias}…`, 0);
  let connId = null;
  try {
    const created = await window.api.conn.create({
      type: 'ssh',
      alias: h.alias,
      name: h.alias,
      direct: {
        hostname: h.hostname,
        user: h.user || null,
        port: h.port,
        identityFile: h.identityFile || null,
        proxyJump: h.proxyJump || null,
        extraOptions: h.extraOptions || '',
      },
    }, { login: h.user || undefined });
    connId = created.id;
    await window.api.conn.connect(connId);
    const who = await window.api.conn.exec(connId, 'id -un; hostname; uname -sr');
    const [user, host, kernel] = who.trim().split('\n');
    toast(`Connected — ${user}@${host} (${kernel})`, 'success', 7000);
    status('');
  } catch (e) {
    toast('Could not connect: ' + e.message, 'error', 9000);
    status('');
  } finally {
    if (connId) window.api.conn.disconnect(connId).catch(() => {});
  }
}

/** Remove a host this app added to ~/.ssh/config. */
export async function removeManagedHost(alias) {
  const ok = await confirm({
    title: 'Remove from ~/.ssh/config',
    message: `Delete the “${alias}” entry?`,
    detail: 'Only entries inside the ServerLife block are touched.',
    confirmLabel: 'Remove', danger: true,
  });
  if (!ok) return;
  try {
    const r = await window.api.discovery.removeSshHost(alias);
    if (!r.removed) return toast('That host was not added by ServerLife', 'info');
    status(`Removed ${alias} from ~/.ssh/config`);
    const { refreshInventory } = await import('./sidebar.js');
    await refreshInventory();
  } catch (e) { toast(e.message, 'error'); }
}

/**
 * Take any ssh config host out of the file it was written in — deleted, or
 * commented out so it can be put back by hand. The block is shown first, as
 * it is in the file, because the file may be one the user wrote themselves.
 */
export async function removeSshConfigHost(host) {
  const file = host.source || host.configFile;
  if (!file) return toast('Not sure which file defines this host', 'error');
  let block;
  try {
    block = await window.api.discovery.sshHostBlock({ file, alias: host.alias });
  } catch (e) { return toast(e.message, 'error'); }

  const shared = block.shared.length
    ? `This Host line also names ${block.shared.join(', ')}. Only “${host.alias}” is taken off it; `
      + 'the block stays for the others.'
    : '';
  const mode = await modal({
    title: `Remove “${host.alias}” from ssh config`,
    subtitle: `${file}, line ${block.line}`,
    render: (body) => {
      body.append(
        el('pre', { class: 'hint', style: 'white-space:pre-wrap;max-height:240px;overflow:auto;margin:0 0 10px', text: block.text }),
        shared ? el('div', { class: 'hint', style: 'margin-bottom:6px', text: shared }) : null,
        el('div', { class: 'hint', text: 'Comment out keeps the lines, prefixed with #, so they can be restored by hand. '
          + `The file as it is now is copied to ${file.split('/').pop()}.serverlife-backup first.` }));
    },
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Comment out', class: 'ghost-btn', value: 'comment' },
      { label: 'Delete', class: 'ghost-btn danger-btn', value: 'delete' },
    ],
  });
  if (!mode) return;
  try {
    await window.api.discovery.removeSshHostFromFile({ file, alias: host.alias, mode });
    status(`${mode === 'comment' ? 'Commented out' : 'Deleted'} ${host.alias} in ${file}`);
    const { refreshInventory } = await import('./sidebar.js');
    await refreshInventory();
  } catch (e) { toast(e.message, 'error'); }
}

/** An ssh config file in the system's text editor. */
/** Edit an ssh config in the app (sshpresets.js): suggestions beside it, checked by ssh before it is saved. */
export async function openSshConfigInEditor(file) {
  await editSshConfig(file || null);
}
