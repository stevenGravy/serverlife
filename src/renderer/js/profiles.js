import { state, tpKey } from './state.js';
import { el } from './util.js';
import { modal, field, textInput, select, checkbox, toast, status } from './ui.js';
import { sshOptionPicker, defaultSshOptions } from './sshpresets.js';
import { openHost, openLocalShell } from './sessions.js';
import { beamHost, beamNodeNames, expiresIn } from './beams.js';
import {
  openQuickConnectDialog, connectQuick, parseTarget, quickHost,
  targetLabel as quickTargetLabel,
} from './quickconnect.js';

/**
 * Saved profiles: an editor for one profile, and the "New session" launcher
 * that spans Teleport nodes, SSH hosts, saved profiles and a local shell.
 */

/** The port a protocol uses when nobody has said otherwise. */
export function defaultPortFor(type, initial = {}) {
  if (initial && initial.devicePort && initial.type === type) return initial.devicePort;
  return type === 'telnet' ? 23 : type === 'vnc' ? 5900 : type === 'rdp' ? 3389 : 22;
}

export async function openProfileEditor(initial = {}) {
  const isEdit = !!initial.id;
  const type = initial.type || 'ssh';

  const nameIn = textInput({ value: initial.name || '', placeholder: 'My server' });
  const typeSel = select([
    { value: 'ssh', label: 'SSH (ssh_config host)' },
    { value: 'teleport', label: 'Teleport node' },
    { value: 'sftp', label: 'SFTP (standalone server)' },
    { value: 'serial', label: 'Serial console' },
    { value: 'telnet', label: 'Telnet' },
    { value: 'vnc', label: 'VNC screen' },
    { value: 'rdp', label: 'Remote Desktop (RDP)' },
    { value: 'kube', label: 'Kubernetes cluster (kubeconfig context)' },
  ], type);

  /*
   * A Kubernetes profile: a kubeconfig context, the namespace to start in and
   * the view to open on. Opened through the same check a restored kube tab
   * gets (kubepanel.js reopenKubeBrowser): a context `tsh logout` took away
   * is offered back with `tsh kube login`, one that is gone says so.
   */
  const kubeCtxSel = el('select', { style: 'width:100%' }, el('option', { value: '', text: 'Reading the kubeconfig…' }));
  let kubeContexts = [];
  window.api.kube.contexts({ extraPaths: state.settings.kubeconfigPaths || [] }).then((r) => {
    kubeContexts = r?.contexts || [];
    kubeCtxSel.replaceChildren(
      el('option', { value: '', text: kubeContexts.length ? 'Pick a context…' : 'No contexts in the kubeconfig' }),
      ...kubeContexts.map((c) => el('option', {
        value: c.contextName,
        text: c.source === 'teleport' ? `${c.kubeClusterName || c.name}  —  Teleport ${c.teleportCluster || c.teleportProxy}` : c.contextName,
      })));
    const want = initial.kube?.spec?.contextName;
    if (want) {
      if (!kubeContexts.some((c) => c.contextName === want)) kubeCtxSel.append(el('option', { value: want, text: `${want} (not in the kubeconfig now)` }));
      kubeCtxSel.value = want;
    }
  }).catch(() => {});
  const kubeNsIn = textInput({ value: initial.kube?.namespace || '', placeholder: 'all namespaces' });
  const kubeViewSel = select([
    { value: '', label: 'Overview' },
    { value: 'kind:pods', label: 'Pods' },
    { value: 'kind:deployments', label: 'Deployments' },
    { value: 'helm', label: 'Helm releases' },
    { value: '3d', label: '3D view' },
    { value: 'starred', label: 'Starred' },
  ], typeof initial.kube?.view === 'string' ? initial.kube.view : (initial.kube?.view?.kind ? `kind:${initial.kube.view.kind}` : ''));
  const kubeBlock = el('div', {},
    field('Context', kubeCtxSel, 'From your kubeconfig — Add a kubeconfig… in the sidebar reads more files'),
    el('div', { class: 'field-row' },
      field('Start in namespace', kubeNsIn),
      field('Open on', kubeViewSel)));

  // SSH fields
  const aliasIn = textInput({ value: initial.alias || '', placeholder: 'host alias from ~/.ssh/config' });
  const userIn = textInput({ value: initial.user || '', placeholder: 'optional override' });
  /*
   * ProxyJump, on the profile rather than only in ssh_config.
   *
   * A bastion is usually the one thing that differs between otherwise
   * identical hosts, and `-J` layers on top of an alias — so this works both
   * for a profile that names an ssh_config Host and for one carrying its own
   * connection details. Teleport nodes have no use for it: the proxy *is* the
   * jump, and tsh handles it.
   */
  const jumpIn = textInput({
    value: initial.proxyJump || initial.direct?.proxyJump || '',
    placeholder: 'bastion.example.com, or user@bastion:2222',
  });
  const hostIn = textInput({ value: initial.hostname || initial.direct?.hostname || '', placeholder: 'optional — dial this directly' });
  /*
   * ssh options for this profile — `-o Name=value`, one per line, for SSH
   * and Teleport profiles alike (tsh ssh takes -o too). Added on top of the
   * host's own options when the profile opens; a new profile starts with
   * the defaults set from any picker ("Use for new hosts by default").
   */
  const sshExtraIn = el('textarea', {
    style: 'width:100%;height:64px;font-family:var(--mono);font-size:11.5px',
    placeholder: 'IdentitiesOnly=yes\nServerAliveInterval=30',
    spellcheck: 'false',
  });
  sshExtraIn.value = initial.sshExtraOptions ?? (initial.id ? '' : defaultSshOptions().replace(/^(\S+)\s+(.*)$/gm, '$1=$2'));
  const sshOptsBlock = el('div', {},
    field('SSH options', el('div', {}, sshExtraIn, sshOptionPicker(sshExtraIn)),
      'Passed as ssh -o, one per line — pick a common one (only one key file, no keys, no agent…) or type your own'));
  const portIn = textInput({ type: 'number', value: String(initial.port || initial.direct?.port || 22), min: 1, max: 65535 });

  /* ---------------- sftp ---------------- */
  /*
   * A standalone server, WinSCP-style: host, port, user, maybe a key. Not an
   * ssh_config alias — that is what the `ssh` type is for — so there is no
   * alias field here, only what is needed to dial it directly.
   *
   * No password field, on purpose: ServerLife keeps its settings in a plain
   * file, and a stored password in one is a password in every backup of it.
   * When no key is given below, ssh prompts for one on connect exactly like
   * it does for any other plain password host, and it is never saved.
   */
  const sftpHostIn = textInput({ value: initial.direct?.hostname || '', placeholder: 'sftp.example.com or 10.0.0.5' });
  const sftpUserIn = textInput({ value: initial.direct?.user || '', placeholder: 'ubuntu' });
  const sftpPortIn = textInput({ type: 'number', value: String(initial.direct?.port || 22), min: 1, max: 65535 });
  const sftpJumpIn = textInput({ value: initial.direct?.proxyJump || '', placeholder: 'bastion.example.com (optional)' });
  const sftpKeyIn = textInput({ value: initial.direct?.identityFile || '', placeholder: '~/.ssh/id_ed25519 (optional)' });
  const sftpKeyBtn = el('button', {
    class: 'ghost-btn sm', text: 'Browse…',
    onClick: async () => {
      const p = await window.api.discovery.pickKey();
      if (p) sftpKeyIn.value = p;
    },
  });
  const sftpExtraIn = el('textarea', {
    style: 'width:100%;height:64px;font-family:var(--mono);font-size:11.5px',
    placeholder: 'ServerAliveInterval 30\nForwardAgent yes',
    spellcheck: 'false',
  });
  sftpExtraIn.value = initial.direct?.extraOptions ?? (initial.id ? '' : defaultSshOptions());

  // Teleport fields
  // Keyed per profile, not per cluster: the same cluster can be present in two
  // tsh homes, and a saved profile has to say which one it means.
  const clusterSel = select(
    state.teleportProfiles.map((p) => ({
      value: tpKey(p),
      label: `${p.cluster}${p.homeName ? ' · ' + p.homeName : ''}${p.expired ? ' (expired)' : ''}`,
    })),
    tpKey({ cluster: initial.cluster, home: initial.home }) || tpKey(state.teleportProfiles[0]));
  const clusterProfile = () => state.teleportProfiles.find((p) => tpKey(p) === clusterSel.value) || null;
  const nodeIn = textInput({ value: initial.node || '', placeholder: 'node hostname' });
  const loginIn = textInput({ value: initial.login || '', placeholder: 'ubuntu' });

  /* ---------------- serial ---------------- */
  /*
   * The port is a list *and* a box.
   *
   * A USB adapter's device file is `/dev/tty.usbserial-A50285BI` on one
   * machine and `COM7` on another, and nobody types either from memory — so
   * the ports present right now are offered. But the one you want is often
   * not plugged in while you are filling the form in, and a saved console
   * that can only be created with the cable attached is a poor sort of saved
   * console, so what the list picks lands in a field you can also type into.
   */
  const devIn = textInput({ value: initial.path || '', placeholder: '/dev/tty.usbserial-1410 or COM3' });
  const devSel = select([{ value: '', label: 'Ports found now…' }], '');
  devSel.addEventListener('change', () => { if (devSel.value) devIn.value = devSel.value; });
  window.api.device.ports().then((ports) => {
    for (const port of ports || []) {
      devSel.append(el('option', { value: port.path, text: port.label ? `${port.path} — ${port.label}` : port.path }));
    }
  }).catch(() => {});

  const baudIn = select(
    [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((b) => ({ value: String(b), label: String(b) })),
    String(initial.baudRate || 115200));
  const dataBitsIn = select(['8', '7', '6', '5'].map((v) => ({ value: v, label: v })), String(initial.dataBits || 8));
  const parityIn = select([
    { value: 'none', label: 'None' }, { value: 'even', label: 'Even' }, { value: 'odd', label: 'Odd' },
  ], initial.parity || 'none');
  const stopBitsIn = select([{ value: '1', label: '1' }, { value: '2', label: '2' }], String(initial.stopBits || 1));
  const flowIn = select([
    { value: 'none', label: 'None' },
    { value: 'rtscts', label: 'Hardware (RTS/CTS)' },
    { value: 'xonxoff', label: 'Software (XON/XOFF)' },
  ], initial.rtscts ? 'rtscts' : (initial.xon ? 'xonxoff' : 'none'));

  /* ---------------- telnet / vnc / rdp ---------------- */
  const devHostIn = textInput({ value: initial.host || '', placeholder: '10.0.0.5 or console.example.com' });
  const devPortIn = textInput({ type: 'number', min: 1, max: 65535, value: String(initial.devicePort || defaultPortFor(type, initial)) });

  // Shared by serial and telnet: what Return sends, and whether to show what
  // you typed.
  const newlineIn = select([
    { value: 'cr', label: 'CR — most network gear' },
    { value: 'lf', label: 'LF — most Unix consoles' },
    { value: 'crlf', label: 'CRLF — telnet default, and some appliances' },
  ], initial.newline || (type === 'telnet' ? 'crlf' : 'cr'));
  const echoIn = checkbox('Show what I type (local echo)', !!initial.localEcho);

  const vncViewOnly = checkbox('View only — watch without touching anything', !!initial.viewOnly);
  const vncScaling = select([
    { value: 'scale', label: 'Scale the screen to fit the pane' },
    { value: 'resize', label: 'Ask the server to match the pane' },
    { value: 'none', label: 'Full size, scroll to see the rest' },
  ], initial.scaling || 'scale');
  const vncQuality = select(
    ['9', '8', '6', '4', '2', '0'].map((v) => ({ value: v, label: `${v}${v === '9' ? ' — best picture' : v === '0' ? ' — smallest' : ''}` })),
    String(initial.quality ?? 6));

  const rdpUserIn = textInput({ value: initial.username || '', placeholder: 'Administrator' });
  const rdpDomainIn = textInput({ value: initial.domain || '', placeholder: 'CORP (optional)' });
  const rdpFull = checkbox('Open full screen', !!initial.fullscreen);
  const rdpWidth = textInput({ type: 'number', value: String(initial.width || 1440), min: 640, max: 7680 });
  const rdpHeight = textInput({ type: 'number', value: String(initial.height || 900), min: 480, max: 4320 });
  const rdpClip = checkbox('Share the clipboard', initial.clipboard !== false);
  const rdpDrives = checkbox('Share my home folder as a drive', !!initial.drives);
  const rdpGateway = textInput({ value: initial.gateway || '', placeholder: 'rdgateway.example.com (optional)' });

  const folderSel = select(
    [{ value: '', label: 'Ungrouped' }, ...state.folders.map((f) => ({ value: f.id, label: f.name }))],
    initial.folderId || '');

  const startCmd = el('textarea', { placeholder: 'e.g. sudo -i\ntail -f /var/log/syslog' });
  startCmd.value = initial.startupCommand || '';
  const remotePath = textInput({ value: initial.remoteStartPath || '', placeholder: '/var/log' });
  const localPath = textInput({ value: initial.localStartPath || '', placeholder: '~/Downloads' });
  // Its own block, hidden independently of the start-folder fields below —
  // a files-only sftp profile has nowhere to run a startup command, but a
  // start folder is more relevant for it than for anything else here.
  const startCmdBlock = el('div', {},
    el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
    field('Startup command', startCmd, 'Sent to the session once it is open'));
  /*
   * A start folder is a question for a session that has a filesystem. A
   * console on a cable does not, and offering it a remote path to begin in is
   * offering something that cannot happen.
   */
  const pathsBlock = el('div', { class: 'field-row' },
    field('Remote start folder', remotePath),
    field('Local start folder', localPath));
  const extrasBlock = el('div', {}, startCmdBlock, pathsBlock);

  const sshBlock = el('div', {},
    field('SSH host alias', aliasIn, 'Must match a Host entry in ~/.ssh/config, unless a hostname is given below'),
    el('div', { class: 'field-row' },
      field('Login user (optional)', userIn),
      field('Jump host (ProxyJump, optional)', jumpIn)),
    el('div', { class: 'field-row' },
      field('Hostname (optional)', hostIn),
      field('Port', portIn)));
  const tpBlock = el('div', {},
    field('Cluster', clusterSel),
    field('Node hostname', nodeIn),
    field('Login', loginIn));

  const sftpBlock = el('div', {},
    el('div', { class: 'field-row' },
      field('Hostname or IP', sftpHostIn),
      field('Port', sftpPortIn)),
    el('div', { class: 'field-row' },
      field('User', sftpUserIn),
      field('Jump host (ProxyJump, optional)', sftpJumpIn)),
    field('Private key', el('div', { style: 'display:flex;gap:6px' }, sftpKeyIn, sftpKeyBtn),
      'Optional — leave it blank to connect by password instead'),
    field('Extra ssh options', el('div', {}, sftpExtraIn, sshOptionPicker(sftpExtraIn, { format: 'config' })), 'One per line, as they appear in ssh_config — pick a common one, or type your own'),
    el('div', { class: 'hint', style: 'margin-top:8px' },
      'The password, if this server needs one, is asked for when you connect '
      + 'and is not saved here — ServerLife keeps its settings in a plain '
      + 'file, and a stored password in one is a password in every backup of '
      + 'it. With no private key given, your other ssh keys are skipped too, '
      + 'so a dedicated SFTP account does not refuse the connection before '
      + 'the password prompt is even reached.'));

  const serialBlock = el('div', {},
    field('Serial port', devIn, 'The device file for the adapter — it does not have to be plugged in to save this'),
    field('Ports on this machine now', devSel),
    el('div', { class: 'field-row' },
      field('Speed', baudIn),
      field('Data bits', dataBitsIn),
      field('Parity', parityIn),
      field('Stop bits', stopBitsIn)),
    field('Flow control', flowIn,
      'Hardware flow control on a console cable that has no CTS wire looks exactly '
      + 'like a dead port — leave it off unless the device asks for it'));

  /*
   * One host and port row for telnet, VNC and RDP.
   *
   * They are three protocols and one question — where is it — so they share
   * the field rather than each keeping their own copy of the address and
   * losing it when the type changes.
   */
  const netBlock = el('div', {},
    el('div', { class: 'field-row' },
      field('Host', devHostIn),
      field('Port', devPortIn)));

  const lineBlock = el('div', {},
    field('Enter sends', newlineIn),
    echoIn);

  const vncBlock = el('div', {},
    field('Display', vncScaling),
    field('Picture quality', vncQuality),
    vncViewOnly,
    el('div', { class: 'hint', style: 'margin-top:8px' },
      'The password is asked for when you connect and is not saved here \u2014 '
      + 'ServerLife keeps its settings in a plain file, and a VNC password in one '
      + 'is a VNC password in every backup of it.'));

  const rdpBlock = el('div', {},
    el('div', { class: 'field-row' },
      field('User', rdpUserIn),
      field('Domain', rdpDomainIn)),
    rdpFull,
    el('div', { class: 'field-row' },
      field('Width', rdpWidth),
      field('Height', rdpHeight)),
    rdpClip, rdpDrives,
    field('RD Gateway', rdpGateway),
    el('div', { class: 'hint', style: 'margin-top:8px' },
      'Opens in this machine\u2019s own Remote Desktop client with these settings. '
      + 'RDP is not drawn inside ServerLife: it is a bundle of virtual channels \u2014 '
      + 'drives, printers, smart cards, audio \u2014 and half an implementation of it '
      + 'would be worse than the client the platform already has.'));

  const syncType = () => {
    const t = typeSel.value;
    sshBlock.classList.toggle('hidden', t !== 'ssh');
    tpBlock.classList.toggle('hidden', t !== 'teleport');
    sshOptsBlock.classList.toggle('hidden', t !== 'ssh' && t !== 'teleport');
    kubeBlock.classList.toggle('hidden', t !== 'kube');
    sftpBlock.classList.toggle('hidden', t !== 'sftp');
    serialBlock.classList.toggle('hidden', t !== 'serial');
    netBlock.classList.toggle('hidden', !['telnet', 'vnc', 'rdp'].includes(t));
    vncBlock.classList.toggle('hidden', t !== 'vnc');
    rdpBlock.classList.toggle('hidden', t !== 'rdp');
    lineBlock.classList.toggle('hidden', t !== 'serial' && t !== 'telnet');
    // A port nobody has typed into follows the protocol.
    if (devPortIn.dataset.auto !== '0') {
      devPortIn.value = String(defaultPortFor(t, initial));
      devPortIn.dataset.auto = '1';
    }
    // What Enter sends differs by protocol until someone says otherwise.
    if (newlineIn.dataset.auto !== '0') {
      newlineIn.value = initial.newline || (t === 'telnet' ? 'crlf' : 'cr');
      newlineIn.dataset.auto = '1';
    }
    // A startup command belongs to a shell, not a screen or a files-only
    // sftp profile; a start folder is relevant to anything with a filesystem.
    startCmdBlock.classList.toggle('hidden', t === 'vnc' || t === 'rdp' || t === 'sftp' || t === 'kube');
    pathsBlock.classList.toggle('hidden', !['ssh', 'teleport', 'sftp'].includes(t));
  };
  devPortIn.addEventListener('input', () => { devPortIn.dataset.auto = '0'; });
  newlineIn.addEventListener('change', () => { newlineIn.dataset.auto = '0'; });
  typeSel.addEventListener('change', syncType);

  const result = await modal({
    title: isEdit ? 'Edit profile' : 'New profile',
    render: (body) => {
      body.append(
        field('Name', nameIn),
        field('Type', typeSel),
        sshBlock, tpBlock, sshOptsBlock, kubeBlock, sftpBlock, serialBlock, netBlock, vncBlock, rdpBlock, lineBlock,
        field('Folder', folderSel),
        extrasBlock);
      syncType();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: isEdit ? 'Save' : 'Create', class: 'primary-btn',
        onClick: ({ close }) => {
          const t = typeSel.value;
          if (!nameIn.value.trim()) return toast('Name is required', 'error');
          // An alias or a hostname: one of the two has to say where to connect.
          if (t === 'ssh' && !aliasIn.value.trim() && !hostIn.value.trim()) {
            return toast('Give an ssh_config alias, or a hostname to dial directly', 'error');
          }
          if (t === 'teleport' && !nodeIn.value.trim()) return toast('Node hostname is required', 'error');
          if (t === 'sftp' && !sftpHostIn.value.trim()) return toast('Hostname is required for an SFTP profile', 'error');
          if (t === 'serial' && !devIn.value.trim()) return toast('Name the serial port', 'error');
          if (t === 'kube' && !kubeCtxSel.value) return toast('Pick a kubeconfig context', 'error');
          if (['telnet', 'vnc', 'rdp'].includes(t) && !devHostIn.value.trim()) {
            return toast('Host is required', 'error');
          }
          close({
            id: initial.id,
            name: nameIn.value.trim(),
            type: t,
            folderId: folderSel.value || null,
            alias: aliasIn.value.trim() || null,
            user: t === 'sftp' ? (sftpUserIn.value.trim() || null) : (userIn.value.trim() || null),
            hostname: t === 'ssh' ? (hostIn.value.trim() || null) : t === 'sftp' ? sftpHostIn.value.trim() : null,
            port: t === 'ssh' ? (parseInt(portIn.value, 10) || 22)
              : t === 'sftp' ? (parseInt(sftpPortIn.value, 10) || 22) : null,
            proxyJump: t === 'ssh' ? (jumpIn.value.trim() || null)
              : t === 'sftp' ? (sftpJumpIn.value.trim() || null) : null,
            sshExtraOptions: (t === 'ssh' || t === 'teleport') ? (sshExtraIn.value.trim() || null) : null,
            /*
             * A profile with a hostname of its own needs no ssh_config entry,
             * so it carries what a connection needs. One with only an alias
             * keeps `direct` empty and lets ssh_config answer — except for the
             * jump host, which is passed as `-J` either way. An sftp profile
             * is always a standalone direct host, never an ssh_config alias.
             */
            direct: t === 'ssh' && hostIn.value.trim() ? {
              hostname: hostIn.value.trim(),
              user: userIn.value.trim() || null,
              port: parseInt(portIn.value, 10) || 22,
              identityFile: initial.direct?.identityFile || null,
              proxyJump: jumpIn.value.trim() || null,
              extraOptions: initial.direct?.extraOptions || '',
            } : t === 'sftp' ? {
              hostname: sftpHostIn.value.trim(),
              user: sftpUserIn.value.trim() || null,
              port: parseInt(sftpPortIn.value, 10) || 22,
              identityFile: sftpKeyIn.value.trim() || null,
              proxyJump: sftpJumpIn.value.trim() || null,
              extraOptions: sftpExtraIn.value,
              /*
               * No key given means this is meant to be reached by password —
               * see directArgs() in connections.js. Without this, a loaded
               * ssh-agent's keys get offered first, and a dedicated SFTP
               * account's sshd commonly disconnects with "Too many
               * authentication failures" before ssh ever reaches the
               * password prompt.
               */
              identitiesOnly: !sftpKeyIn.value.trim(),
            } : null,
            cluster: t === 'teleport' ? (clusterProfile()?.cluster || null) : null,
            proxy: t === 'teleport' ? (clusterProfile()?.proxy || null) : null,
            home: t === 'teleport' ? (clusterProfile()?.home || null) : null,
            node: nodeIn.value.trim() || null,
            login: loginIn.value.trim() || null,
            startupCommand: startCmd.value,
            remoteStartPath: remotePath.value.trim(),
            localStartPath: localPath.value.trim(),

            /*
             * The consoles and screens. Saved in the same record as everything
             * else — one list of things you connect to, in one set of folders
             * — with only the fields their own protocol needs filled in.
             */
            path: t === 'serial' ? devIn.value.trim() : null,
            baudRate: t === 'serial' ? parseInt(baudIn.value, 10) : null,
            dataBits: t === 'serial' ? parseInt(dataBitsIn.value, 10) : null,
            parity: t === 'serial' ? parityIn.value : null,
            stopBits: t === 'serial' ? parseInt(stopBitsIn.value, 10) : null,
            rtscts: t === 'serial' ? flowIn.value === 'rtscts' : null,
            xon: t === 'serial' ? flowIn.value === 'xonxoff' : null,
            xoff: t === 'serial' ? flowIn.value === 'xonxoff' : null,

            host: ['telnet', 'vnc', 'rdp'].includes(t) ? devHostIn.value.trim() : null,
            devicePort: ['telnet', 'vnc', 'rdp'].includes(t)
              ? (parseInt(devPortIn.value, 10) || defaultPortFor(t, {})) : null,

            newline: ['serial', 'telnet'].includes(t) ? newlineIn.value : null,
            localEcho: ['serial', 'telnet'].includes(t) ? echoIn.input.checked : null,

            viewOnly: t === 'vnc' ? vncViewOnly.input.checked : null,
            scaling: t === 'vnc' ? vncScaling.value : null,
            quality: t === 'vnc' ? parseInt(vncQuality.value, 10) : null,

            username: t === 'rdp' ? (rdpUserIn.value.trim() || null) : null,
            domain: t === 'rdp' ? (rdpDomainIn.value.trim() || null) : null,
            fullscreen: t === 'rdp' ? rdpFull.input.checked : null,
            width: t === 'rdp' ? parseInt(rdpWidth.value, 10) : null,
            height: t === 'rdp' ? parseInt(rdpHeight.value, 10) : null,
            clipboard: t === 'rdp' ? rdpClip.input.checked : null,
            drives: t === 'rdp' ? rdpDrives.input.checked : null,
            gateway: t === 'rdp' ? (rdpGateway.value.trim() || null) : null,
            kube: t === 'kube' ? (() => {
              const c = kubeContexts.find((x) => x.contextName === kubeCtxSel.value);
              const v = kubeViewSel.value;
              return {
                // Everything needed to find the cluster again, not just the
                // context name — which a tsh logout deletes.
                spec: c ? {
                  kubeconfigPaths: c.kubeconfigPaths || [], contextName: c.contextName,
                  teleportProxy: c.teleportProxy || null, kubeClusterName: c.kubeClusterName || null, teleportCluster: c.teleportCluster || null,
                } : { ...(initial.kube?.spec || {}), contextName: kubeCtxSel.value },
                namespace: kubeNsIn.value.trim() || null,
                view: v.startsWith('kind:') ? { kind: v.slice(5) } : (v || null),
              };
            })() : null,
          });
        },
      },
    ],
  });

  if (!result) return null;
  const saved = await window.api.profiles.save(result);
  const { reloadProfiles } = await import('./sidebar.js');
  await reloadProfiles();
  status(`Saved profile “${saved.name}”`);
  return saved;
}

/* ------------------------------------------------------------------ */
/* New session launcher                                                */
/* ------------------------------------------------------------------ */

export async function openNewSessionDialog() {
  const search = textInput({ placeholder: 'Search hosts, clusters, labels…', autofocus: true });
  const list = el('div', { class: 'picker-list' });
  let items = [];
  let active = 0;
  let rows = [];

  // What you connected to last, newest first. Fetched once as the dialog opens;
  // if it is slow or empty the rest of the picker is unaffected.
  let recent = [];
  const limit = state.settings.recentLimit ?? 20;
  if (limit > 0) {
    window.api.history.recent({ limit })
      .then((r) => { recent = r || []; build(); })
      .catch(() => {});
  }

  /*
   * The shells on this machine, so the + opens one as readily as it opens a
   * host.
   *
   * A local shell was already in this list, but at the bottom of every host
   * the inventory knows — which is not somewhere anybody finds it. It now
   * leads, with the other installed shells behind it, because "a terminal
   * here" is one of the two things this button is for.
   */
  let shells = [];
  window.api.localTerm.shells()
    .then((v) => { shells = v || []; build(); })
    .catch(() => {});

  /*
   * Serial ports that exist right now.
   *
   * Offered beside the shells because that is what they are: something
   * plugged into *this* machine. A console cable is usually wanted five
   * seconds after it is plugged in and for one look at a switch that will not
   * boot, which is not an occasion for filling in a form — so the ports are
   * openable from here at 115200 8N1, the speed almost everything made this
   * century uses, and saving one as a connection is for the consoles you go
   * back to.
   */
  let ports = [];
  window.api.device.ports()
    .then((v) => { ports = v || []; build(); })
    .catch(() => {});

  const build = () => {
    const q = search.value.trim().toLowerCase();
    items = [];

    for (const r of recent) {
      items.push({
        kind: 'recent', label: r.label || r.node || r.target || 'session',
        meta: recentMeta(r),
        badge: r.type === 'local' ? 'local' : 'recent',
        group: 'Recent',
        data: r,
      });
    }

    /*
     * This machine, above the inventory.
     *
     * A local shell was in this list already, but under the last of however
     * many hundred hosts the inventory knows — which is not somewhere anybody
     * finds it. It sits above them now, with the other installed shells behind
     * it for "what does this look like in bash" and for a way in when an rc
     * file is broken. Still below Recent, so ⌘N and Enter reopens what it
     * always did.
     */
    items.push({
      kind: 'local', label: 'Local shell',
      meta: (shells.find((s) => s.isDefault)?.name || 'your shell') + ' on this machine',
      badge: 'local', group: 'This machine',
    });
    for (const sh of shells.filter((s) => !s.isDefault)) {
      items.push({
        kind: 'local', label: sh.name, meta: sh.path,
        badge: 'local', group: 'This machine', data: { shell: sh },
      });
    }
    for (const port of ports) {
      items.push({
        kind: 'serialport', label: port.path,
        meta: [port.label, '115200 8N1'].filter(Boolean).join(' · '),
        badge: 'serial', group: 'This machine', data: port,
      });
    }

    // A host already offered as recent is not offered again below: the two
    // rows would open the same session.
    const recentKeys = new Set(recent.map(hostKeyOfRecent));

    for (const p of state.profiles) {
      items.push({
        kind: 'profile', label: p.name, meta: profileMeta(p),
        badge: 'saved', group: 'All hosts', data: p,
      });
    }
    for (const nodes of state.teleportNodes.values()) {
      for (const n of nodes) {
        if (recentKeys.has(`teleport\u0000${n.cluster || ''}\u0000${n.name}`)) continue;
        items.push({
          kind: 'teleport', label: n.name,
          meta: [n.cluster, n.homeName, n.addr].filter(Boolean).join(' · '),
          badge: 'tsh', group: 'All hosts', data: n,
        });
      }
    }
    for (const h of state.sshHosts) {
      if (recentKeys.has(`ssh\u0000\u0000${h.alias}`)) continue;
      items.push({
        kind: 'ssh', label: h.alias, meta: `${h.user}@${h.hostname}:${h.port}`,
        badge: h.viaTsh ? 'tsh' : 'ssh', group: 'All hosts', data: h,
      });
    }
    // (a local shell leads the list, under "This machine")

    if (q) {
      items = items.filter((it) =>
        (it.label + ' ' + (it.meta || '')).toLowerCase().includes(q));
    }
    items = items.slice(0, 200);

    /*
     * Typing an address that is in no inventory is not a failed search — it is
     * the other thing people come here to do. Offered last, so it never steals
     * the Enter key from a real match, and only when the text reads like an
     * address, so filtering the host list stays quiet. Added after the cap
     * because it is about what was typed, not one more host to scroll past.
     */
    const typed = search.value.trim();
    /*
     * An address looks like an address — but a serial port looks like a path
     * and a protocol looks like a URL, so the test is what the parser makes
     * of it rather than which punctuation it holds.
     */
    const typedTarget = typed && !/\s/.test(typed.replace(/^(?:ssh|telnet|vnc|rdp)\s+/i, ''))
      ? parseTarget(typed) : null;
    if (typedTarget && (typedTarget.kind !== 'ssh' || /[@.:]/.test(typed))) {
      items.push({
        kind: 'quick', label: quickTargetLabel(typedTarget),
        meta: typedTarget.kind === 'ssh' ? 'connect without saving it'
          : `open it over ${typedTarget.kind}, without saving it`,
        badge: typedTarget.kind === 'ssh' ? 'quick' : typedTarget.kind,
        group: 'Quick connect', data: typedTarget,
      });
    }
    active = 0;
    draw();
  };

  const draw = () => {
    list.replaceChildren();
    rows = [];
    let group = null;
    items.forEach((it, i) => {
      if (it.group && it.group !== group) {
        group = it.group;
        list.append(el('div', { class: 'picker-head', text: group }));
      }
      const row = el('div', { class: 'picker-item' + (i === active ? ' active' : '') },
        el('span', { class: 'pname', text: it.label }),
        el('span', { class: 'pmeta', text: it.meta || '' }),
        it.kind === 'recent' && it.data.error
          ? el('span', { class: 'tag warn', title: it.data.error, text: 'failed' })
          : null,
        el('span', { class: 'tag', text: it.badge }));
      row.addEventListener('click', () => choose(it));
      row.addEventListener('mouseenter', () => { active = i; });
      rows.push(row);
      list.append(row);
    });
    if (!items.length) list.append(el('div', { class: 'sb-empty', text: 'No matches.' }));
  };

  let closeModal;
  const choose = async (it) => {
    closeModal?.(null);
    try {
      if (it.kind === 'recent') return openRecent(it.data);
      if (it.kind === 'local') {
        const sh = it.data?.shell;
        // Named shells carry their own title, so the tab says which one it is;
        // the default row opens exactly what ⌘T does.
        return sh ? openLocalShell(undefined, { shell: sh.path, title: sh.name }) : openLocalShell();
      }
      // Enter on the quick row connects; the footer button is the way to the
      // dialog, where the key, jump host, test and single command live.
      if (it.kind === 'quick') return connectQuick(it.data);
      if (it.kind === 'serialport') {
        const { openDeviceSession } = await import('./sessions.js');
        return openDeviceSession({ kind: 'serial', path: it.data.path, name: it.data.path });
      }
      if (it.kind === 'profile') {
        const { launchProfile } = await import('./sidebar.js');
        return launchProfile(it.data);
      }
      const login = it.kind === 'teleport'
        ? (state.teleportProfiles.find((p) => p.cluster === it.data.cluster)?.logins || [])[0]
        : undefined;
      await openHost(it.data, { login });
    } catch (e) { toast(e.message, 'error'); }
  };

  search.addEventListener('input', build);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); draw(); scrollActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); draw(); scrollActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) choose(items[active]); }
  });

  const scrollActive = () => {
    rows[active]?.scrollIntoView({ block: 'nearest' });
  };

  await modal({
    title: 'New session',
    subtitle: 'Enter to connect',
    render: (body, { close }) => {
      closeModal = close;
      body.append(el('div', { class: 'field' }, search), list);
      build();   // recents redraw the list when they land
    },
    buttons: [
      {
        label: 'Quick connect…',
        onClick: ({ close }) => {
          // Whatever is in the search box is usually the address already.
          const typed = search.value.trim();
          close(null);
          openQuickConnectDialog(parseTarget(typed) ? { target: typed } : {});
        },
      },
      /*
       * A shell on this machine, one click from the + button.
       *
       * It is in the list as well, under "This machine" — but that means
       * scrolling past or typing over whatever the search box is showing,
       * and "give me a terminal here" is not a search. It is the other
       * thing people open the + for, so it sits next to the other one.
       */
      { label: 'Local shell', onClick: ({ close }) => { close(null); openLocalShell(); } },
      {
        label: 'AI assistant\u2026',
        title: 'Claude Code, Codex, Copilot, OpenCode, Pi or Gemini \u2014 on the right of the tab in use',
        onClick: async ({ close }) => { close(null); (await import('./ai.js')).openAiPicker(); },
      },
      { label: 'New profile…', onClick: ({ close }) => { close(null); openProfileEditor({}); } },
      { label: 'Close', value: null },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Recent connections                                                  */
/* ------------------------------------------------------------------ */

/**
 * The Teleport profile a node belongs to — matched on its home as well as its
 * cluster, since one cluster can be in two homes.
 */
export function profileForNode(n) {
  if (!n) return null;
  return state.teleportProfiles.find((p) => p.cluster === n.cluster
      && (p.home || null) === (n.home || null))
    || state.teleportProfiles.find((p) => p.cluster === n.cluster)
    || null;
}

/** What a saved connection says about itself in a list. */
export function profileMeta(p) {
  if (!p) return '';
  if (p.type === 'teleport') return `${p.node} @ ${p.cluster}`;
  if (p.type === 'sftp') return `${p.user ? p.user + '@' : ''}${p.hostname || ''}:${p.port || 22}`;
  if (p.type === 'serial') return `${p.path || ''} · ${p.baudRate || 115200}`;
  if (p.type === 'telnet' || p.type === 'vnc' || p.type === 'rdp') {
    return `${p.host || ''}:${p.devicePort || defaultPortFor(p.type, p)}`;
  }
  return p.alias || p.hostname || '';
}

/** The key a recent shares with the inventory row for the same machine. */
function hostKeyOfRecent(r) {
  return `${r.type}\u0000${r.cluster || ''}\u0000${r.node || r.label || ''}`;
}

/**
 * A recent connection, described the way you would say it out loud: the
 * account and the host first, then the cluster, then when.
 *
 * Reopening one dials it again, so which account on which host is the thing
 * worth reading — it used to be tucked behind the hostname as "as ubuntu".
 */
function recentMeta(r) {
  const when = r.at ? fmtAgo(r.at) : '';
  if (r.type === 'local') return [r.target || 'local shell', when].filter(Boolean).join('  \u00b7  ');

  const host = r.type === 'teleport'
    ? (r.node || r.target || '')
    : String(r.target || r.node || '').replace(/^[^@]+@/, '');
  const login = r.login || (String(r.target || '').includes('@') ? r.target.split('@')[0] : '');
  const who = login && host ? `${login}@${host}` : (host || login || '');
  return [who, r.type === 'teleport' ? r.cluster : '', when].filter(Boolean).join('  \u00b7  ');
}

/** Rough, readable ages — "4m ago", "yesterday", "3d ago". */
function fmtAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 172800) return 'yesterday';
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * Reopen something from the recents list.
 *
 * The live inventory is preferred where it still has the host: that carries the
 * node's uuid and labels, which a history record never did. Only when the host
 * has gone from the inventory — a cluster not logged into yet, an ssh_config
 * entry since edited — is the record used on its own.
 */
export async function openRecent(r) {
  if (r.type === 'local') return openLocalShell();

  if (r.type === 'teleport') {
    // The same cluster can be present in two tsh homes; reopen the one this
    // session was actually on.
    const nodes = state.teleportNodes.get(tpKey({ cluster: r.cluster, home: r.home })) || [];
    const live = nodes.find((n) => n.name === r.node) || null;
    const host = live || {
      id: `tsh:${r.cluster}:${r.node}`,
      type: 'teleport',
      name: r.node,
      hostname: r.node,
      cluster: r.cluster,
      proxy: r.proxy,
      home: r.home || null,
    };
    const login = r.login || (profileForNode(host)?.logins || [])[0];
    return openHost(host, { login });
  }

  /*
   * A session dialled by details rather than by an alias — a quick connect, or
   * a server saved in the app. There is no ssh_config entry to look it up in,
   * so the details recorded with the session are what reopens it; without them
   * the port, key and jump host would be dropped and this would dial a
   * different machine on port 22.
   */
  if (r.direct?.hostname) {
    const login = r.login || r.direct.user || '';
    // Built through quickHost so the id matches the one the original session
    // used, and reopening reuses that connection rather than dialling a second.
    const host = quickHost({
      user: login,
      hostname: r.direct.hostname,
      port: r.direct.port || 22,
      identityFile: r.direct.identityFile || '',
      proxyJump: r.direct.proxyJump || '',
    });
    host.name = r.label || host.name;
    // Any extra ssh options the session carried are part of reaching it.
    host.direct.extraOptions = r.direct.extraOptions || '';
    return openHost(host, { login: login || undefined });
  }

  const live = state.sshHosts.find((h) => h.alias === r.node) || null;
  const host = live || {
    id: `ssh:${r.node || r.target}`,
    type: 'ssh',
    alias: r.node || r.target,
    name: r.label || r.node || r.target,
  };
  return openHost(host, { login: r.login || undefined });
}

/* ------------------------------------------------------------------ */
/* Reusable host picker                                                */
/* ------------------------------------------------------------------ */

/**
 * Pick a host without opening it. Used by "split with another host", so the
 * caller decides what to do with the choice.
 *
 * Resolves to {kind:'teleport'|'ssh'|'beam'|'local', host, login} or null.
 */
export async function pickHost({ title = 'Choose a host', includeLocal = true } = {}) {
  const search = textInput({ placeholder: 'Search hosts, clusters, labels…', autofocus: true });
  const list = el('div', { class: 'picker-list' });
  let items = [];
  let active = 0;
  let closeModal;

  const build = () => {
    const q = search.value.trim().toLowerCase();
    items = [];

    // A running beam is also a node called beam-<uuid>; it is listed once,
    // below, under its own name.
    const beamNodes = beamNodeNames();
    for (const nodes of state.teleportNodes.values()) {
      for (const n of nodes) {
        if (beamNodes.has(n.name)) continue;
        items.push({
          kind: 'teleport', label: n.name,
          meta: [n.cluster, n.homeName, n.addr].filter(Boolean).join(' · '),
          badge: 'tsh', host: n,
          login: (profileForNode(n)?.logins || [])[0],
        });
      }
    }
    for (const h of state.sshHosts) {
      items.push({
        kind: 'ssh', label: h.alias, meta: `${h.user}@${h.hostname}:${h.port}`,
        badge: h.viaTsh ? 'tsh' : 'ssh', host: h,
      });
    }
    for (const list of (state.beams || new Map()).values()) {
      for (const b of list) {
        items.push({
          kind: 'beam', label: b.id,
          meta: [b.proxy, expiresIn(b)].filter(Boolean).join(' · '),
          badge: 'beam', host: beamHost(b),
        });
      }
    }
    if (includeLocal) items.push({ kind: 'local', label: 'Local shell', meta: 'this machine', badge: 'local' });

    if (q) items = items.filter((it) => (it.label + ' ' + (it.meta || '')).toLowerCase().includes(q));
    items = items.slice(0, 200);
    active = 0;
    draw();
  };

  const draw = () => {
    list.replaceChildren();
    items.forEach((it, i) => {
      const row = el('div', { class: 'picker-item' + (i === active ? ' active' : '') },
        el('span', { class: 'pname', text: it.label }),
        el('span', { class: 'pmeta', text: it.meta || '' }),
        el('span', { class: 'tag', text: it.badge }));
      row.addEventListener('click', () => closeModal?.(it));
      row.addEventListener('mouseenter', () => { active = i; });
      list.append(row);
    });
    if (!items.length) list.append(el('div', { class: 'sb-empty', text: 'No matches.' }));
  };

  search.addEventListener('input', build);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); draw(); list.children[active]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); draw(); list.children[active]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) closeModal?.(items[active]); }
  });

  const choice = await modal({
    title,
    subtitle: 'Enter to choose',
    render: (body, { close }) => {
      closeModal = close;
      body.append(el('div', { class: 'field' }, search), list);
      build();
    },
    buttons: [{ label: 'Cancel', value: null }],
  });
  return choice || null;
}
