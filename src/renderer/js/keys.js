import { state } from './state.js';
import { el, clear, fmtDate } from './util.js';
import { modal, field, textInput, select, checkbox, toast, status, confirm, prompt } from './ui.js';

/**
 * SSH key management: what keys exist, what the agent holds, generating a new
 * pair, and installing a public key on a host — the `ssh-copy-id` step, done
 * over the connection that is already open.
 */

/**
 * Does an ssh_config `IdentityFile` refer to this key?
 *
 * Compared on the file name alone: the config side is commonly `~/.ssh/id_rsa`
 * or a relative path, and expanding either into a real path here would mean
 * guessing at the home directory ssh will use.
 */
/**
 * Unpack a Teleport agent identity.
 *
 * `tsh login` loads its certificates into ssh-agent with a comment of
 * `teleport:<proxy>:<cluster>:<user>`, which is accurate and unreadable — and
 * on a machine with a few clusters it is most of what the agent holds. Naming
 * the cluster and user instead turns eight identical-looking rows into
 * something you can recognise. Returns null for anything else.
 */
function teleportIdentity(comment) {
  const parts = String(comment || '').split(':');
  if (parts[0] !== 'teleport' || parts.length < 4) return null;
  // The user can itself contain no colons, but the proxy and cluster may be
  // host:port, so take the user as the last field and the cluster before it.
  const user = parts[parts.length - 1];
  const cluster = parts[parts.length - 2];
  const proxy = parts.slice(1, parts.length - 2).join(':');
  return { proxy, cluster, user };
}

function sameKeyPath(identityFile, key) {
  const base = (p) => String(p || '').replace(/\\/g, '/').split('/').pop().replace(/\.pub$/, '');
  return base(identityFile) === base(key.privatePath || key.publicPath);
}

export async function openKeysDialog() {
  let body = null;

  /**
   * Plain `ssh-add` — load the default identities.
   *
   * This is the command people type when a server has started refusing them,
   * and it is useful precisely when our own probe of the agent has failed, so
   * it stays available in that state and reports whatever ssh-add says.
   */
  const addDefaults = async () => {
    try {
      status('Running ssh-add…', 0);
      const r = await window.api.keys.addToAgent(null, {});
      status('');
      if (r.ok) toast(r.output?.trim() || 'Default keys added to ssh-agent', 'success', 6000);
      else toast(r.output || 'ssh-add failed', 'error', 9000);
      load();
    } catch (e) {
      status('');
      toast(e.message, 'error');
    }
  };

  const load = async () => {
    if (!body) return;
    clear(body);
    body.append(el('div', { class: 'sb-empty', text: 'Reading ~/.ssh…' }));

    let keys = [];
    let agent = { running: false, keys: [] };
    try {
      [keys, agent] = await Promise.all([window.api.keys.list(), window.api.keys.agent()]);
    } catch (e) {
      clear(body);
      body.append(el('div', { class: 'sb-empty', style: 'color:var(--red)', text: e.message }));
      return;
    }
    clear(body);

    // Agent summary. Three states, not two: running, not answering, and no
    // ssh-add to ask with — only the middle one is worth retrying.
    const agentFps = new Set(agent.keys.map((k) => k.fingerprint));
    const dot = agent.missing ? 'var(--red)' : agent.running ? 'var(--green)' : 'var(--amber)';
    // How many of the agent's identities are files below, so the count in the
    // banner accounts for itself rather than describing a list that is shorter.
    const fromDisk = keys.filter((k) => k.fingerprint && agentFps.has(k.fingerprint)).length;
    const elsewhere = agent.keys.length - fromDisk;
    const agentRow = el('div', {
      style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px;'
        + 'padding-bottom:12px;border-bottom:1px solid var(--border-soft);font-size:12px',
    },
      el('span', { style: `width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${dot}` }),
      el('span', {
        text: agent.missing
          ? 'ssh-add not found — key management needs an OpenSSH client'
          : agent.running
            ? `ssh-agent running — ${agent.keys.length} key${agent.keys.length === 1 ? '' : 's'} loaded`
              + (elsewhere > 0 ? `, ${fromDisk} from ~/.ssh and ${elsewhere} from elsewhere` : '')
            : 'ssh-agent not reachable',
      }));

    if (agent.missing) {
      agentRow.append(el('div', { class: 'hint', style: 'flex-basis:100%;font-size:11px;color:var(--text-dim)',
        text: window.api && state.appInfo?.platform === 'win32'
          ? 'The OpenSSH client is an optional Windows feature. Install it, or set the ssh path in Settings.'
          : 'Keys are still listed from ~/.ssh, but they cannot be added to the agent from here.' }));
    } else if (!agent.running) {
      // Previously the agent had to answer before ssh-add was offered at all,
      // so a probe that failed left no way to even try. ssh-add gives the real
      // error, which is more use than our guess about why it did not answer.
      agentRow.append(el('button', {
        class: 'ghost-btn sm', text: 'Try ssh-add',
        title: 'Run ssh-add for the default identities and report what it says',
        onClick: () => addDefaults(),
      }));
      if (agent.error) {
        agentRow.append(el('div', {
          style: 'flex-basis:100%;font-size:11px;color:var(--text-dim);font-family:var(--mono)',
          text: agent.error,
        }));
      }
    }
    body.append(agentRow);

    /*
     * Identities the agent holds that have no keypair in ~/.ssh.
     *
     * This list is built from files on disk, and the agent is otherwise only
     * used to tag them — so a key loaded from the macOS keychain, a hardware
     * token, Secretive, 1Password or a Teleport certificate was counted in the
     * banner and then appeared nowhere, which makes the count look wrong. They
     * cannot be managed from here, but they are what will be offered to a
     * server, so they are worth seeing.
     */
    const localFps = new Set(keys.map((k) => k.fingerprint).filter(Boolean));
    const agentExtra = agent.keys.filter((a) => a.fingerprint && !localFps.has(a.fingerprint));

    /*
     * One card per identity, not per agent entry. `tsh login` loads each
     * identity twice — the certificate and the bare key — with the same
     * fingerprint, so a machine logged in to four clusters lists eight
     * identical-looking rows. Grouping on the fingerprint shows four, with both
     * forms named on the card.
     */
    const byFp = new Map();
    for (const a of agentExtra) {
      const rec = byFp.get(a.fingerprint);
      if (!rec) {
        byFp.set(a.fingerprint, { ...a, types: a.type ? [a.type] : [], entries: 1 });
        continue;
      }
      rec.entries++;
      if (a.type && !rec.types.includes(a.type)) rec.types.push(a.type);
    }
    const agentOnly = [...byFp.values()];

    if (!keys.length && !agentOnly.length) {
      body.append(el('div', { class: 'sb-empty', text: 'No keypairs found in ~/.ssh.' }));
      return;
    }
    if (!keys.length) {
      body.append(el('div', { class: 'sb-empty', style: 'padding:10px 0',
        text: 'No keypairs in ~/.ssh — the agent’s own identities are below.' }));
    }

    for (const k of keys) {
      const inAgent = k.fingerprint && agentFps.has(k.fingerprint);
      const card = el('div', { class: 'req-card' });

      // Which ssh_config hosts name this key with IdentityFile — any of a
      // host's identity files, not just the first ssh -G happened to report,
      // so a key offered second (after a certificate, say) still shows up.
      // Answers "is this key actually used for anything?" without leaving
      // the dialog.
      const usedBy = (state.sshHosts || [])
        .filter((h) => (h.identityFiles && h.identityFiles.length ? h.identityFiles : [h.identityFile])
          .some((f) => f && sameKeyPath(f, k)))
        .map((h) => h.alias);

      card.append(el('div', { class: 'req-head' },
        el('span', { style: 'font-weight:600;font-size:13px', text: k.name }),
        k.type ? el('span', { class: 'tag', text: k.type }) : null,
        k.bits ? el('span', { class: 'tag', text: k.bits + ' bit' }) : null,
        k.encrypted === true ? el('span', { class: 'tag', text: 'passphrase' }) : null,
        k.encrypted === false ? el('span', { class: 'tag', text: 'no passphrase' }) : null,
        inAgent ? el('span', { class: 'req-state APPROVED', text: 'IN AGENT' }) : null,
        !k.permissionsOk
          ? el('span', { class: 'req-state DENIED', text: 'PERMISSIONS' })
          : null));

      card.append(el('div', { class: 'req-meta' },
        k.fingerprint ? el('div', { text: k.fingerprint }) : null,
        k.comment ? el('div', { text: k.comment }) : null,
        el('div', { style: 'opacity:.75', text: k.privatePath || k.publicPath }),
        k.mtime ? el('div', { style: 'opacity:.75', text: 'modified ' + fmtDate(k.mtime) }) : null,
        usedBy.length
          ? el('div', { text: `used by ${usedBy.length} ssh_config host${usedBy.length === 1 ? '' : 's'}: ${usedBy.slice(0, 6).join(', ')}${usedBy.length > 6 ? '…' : ''}` })
          : null,
        !k.hasPrivate ? el('div', { style: 'color:var(--amber)', text: 'public key only — no private key alongside it' }) : null,
        !k.permissionsOk && k.privMode !== null
          ? el('div', {
              style: 'color:var(--red)',
              text: `private key is ${k.privMode.toString(8)} — sshd ignores anything looser than 600`,
            })
          : null));

      const actions = el('div', { class: 'req-actions' });

      actions.append(el('button', {
        class: 'ghost-btn', text: 'Copy public key',
        onClick: () => { window.api.clipboard.write(k.publicKey); status('Public key copied'); },
      }));

      // Install on any connected session, which is ssh-copy-id without the
      // extra authentication.
      const connected = [...state.connections.values()].filter((c) => c.state === 'connected');
      if (connected.length) {
        actions.append(el('button', {
          class: 'primary-btn', text: 'Install on server…',
          onClick: () => installFlow(k, connected),
        }));
      }

      // Offered whenever there is a private key and an ssh-add to run. It used
      // to require the agent to have answered first, which meant a failed probe
      // removed the one button that would have said why.
      if (k.hasPrivate && !inAgent && !agent.missing) {
        actions.append(el('button', {
          class: 'ghost-btn', text: 'Add to agent',
          onClick: async () => {
            try {
              /*
               * Ask for the passphrase up front: ssh-add cannot prompt usefully
               * from a GUI app, so it would otherwise stall or fail obscurely.
               * `k.encrypted` is read from the key's own header when the list
               * is built; only fall back to the subprocess when that was
               * inconclusive.
               */
              const encrypted = k.encrypted === null || k.encrypted === undefined
                ? await window.api.keys.isEncrypted(k.privatePath)
                : k.encrypted;
              let passphrase = null;
              if (encrypted) {
                passphrase = await promptPassphrase(k.name);
                if (passphrase === undefined) return;
              }
              status('Adding to agent…', 0);
              const r = await window.api.keys.addToAgent(k.privatePath, { passphrase });
              status('');
              r.ok ? toast('Added to ssh-agent', 'success') : toast(r.output || 'ssh-add failed', 'error');
              load();
            } catch (e) {
              status('');
              toast(e.message, 'error');
            }
          },
        }));
      }

      card.append(actions);
      body.append(card);
    }

    if (!agentOnly.length) return;

    body.append(el('div', {
      style: 'margin:16px 0 9px;padding-top:12px;border-top:1px solid var(--border-soft);'
        + 'font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);'
        + 'font-weight:600',
      // Both numbers when they differ, so neither this list nor the banner's
      // count looks wrong next to the other.
      text: agentExtra.length === agentOnly.length
        ? `In the agent only — ${agentOnly.length}`
        : `In the agent only — ${agentOnly.length} identities, ${agentExtra.length} entries`,
    }));
    body.append(el('div', {
      style: 'font-size:11.5px;color:var(--text-dim);margin-bottom:10px',
      text: 'Loaded in ssh-agent with no keypair in ~/.ssh — from the login keychain, a '
        + 'hardware token, another agent, or a Teleport certificate. They will be offered '
        + 'to servers, but there is no file here to manage.',
    }));

    for (const a of agentOnly) {
      const tp = teleportIdentity(a.comment);
      const card = el('div', { class: 'req-card' });
      card.append(el('div', { class: 'req-head' },
        el('span', { style: 'font-weight:600;font-size:13px',
          text: tp ? `${tp.user} @ ${tp.cluster}` : (a.comment || 'unnamed identity') }),
        tp ? el('span', { class: 'tag', text: 'teleport' }) : null,
        ...(a.types.length ? a.types : [a.type]).filter(Boolean)
          .map((t) => el('span', { class: 'tag', text: t })),
        a.bits ? el('span', { class: 'tag', text: a.bits + ' bit' }) : null,
        el('span', { class: 'req-state APPROVED', text: 'IN AGENT' })));
      card.append(el('div', { class: 'req-meta' },
        tp && tp.proxy !== tp.cluster ? el('div', { text: 'proxy ' + tp.proxy }) : null,
        tp ? el('div', { style: 'opacity:.75', text: 'short-lived certificate from tsh login' }) : null,
        a.entries > 1
          ? el('div', { style: 'opacity:.75', text: `${a.entries} agent entries share this fingerprint — the certificate and the key it signs` })
          : null,
        el('div', { text: a.fingerprint })));
      card.append(el('div', { class: 'req-actions' },
        el('button', {
          class: 'ghost-btn', text: 'Copy fingerprint',
          onClick: () => { window.api.clipboard.write(a.fingerprint); status('Fingerprint copied'); },
        })));
      body.append(card);
    }
  };

  await modal({
    title: 'SSH keys',
    subtitle: '~/.ssh',
    width: 'min(700px, 94vw)',
    render: (b) => { body = b; load(); },
    buttons: [
      { label: 'Run ssh-add', onClick: () => addDefaults() },
      { label: 'Generate new key…', onClick: () => generateFlow().then(load) },
      { label: 'Load PKCS#11 token…', onClick: () => pkcs11Flow().then(load) },
      { label: 'Refresh', onClick: () => load() },
      { label: 'Close', value: null },
    ],
  });
}

async function installFlow(key, connections) {
  const sel = select(connections.map((c) => ({ value: c.id, label: c.label })), connections[0].id);
  const choice = await modal({
    title: 'Install public key',
    subtitle: key.name,
    render: (body) => {
      body.append(
        field('Target session', sel),
        el('div', { class: 'hint' },
          'Appends the key to ~/.ssh/authorized_keys on that server if it is not already there, '
          + 'and fixes the directory permissions sshd requires.'));
    },
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Install', class: 'primary-btn', onClick: ({ close }) => close(sel.value) },
    ],
  });
  if (!choice) return;

  try {
    status('Installing key…', 0);
    const r = await window.api.keys.install(choice, key.publicKey);
    toast(r.alreadyPresent ? 'Key was already installed' : 'Key installed', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally { status(''); }
}

async function generateFlow() {
  const nameIn = textInput({ value: 'id_serverlife', placeholder: 'id_ed25519' });
  const typeSel = select([
    { value: 'ed25519', label: 'Ed25519 (recommended)' },
    { value: 'ecdsa', label: 'ECDSA' },
    { value: 'rsa', label: 'RSA 4096' },
    { value: 'ed25519-sk', label: 'Security key (FIDO2) — Ed25519' },
    { value: 'ecdsa-sk', label: 'Security key (FIDO2) — ECDSA' },
  ], 'ed25519');
  const commentIn = textInput({ placeholder: 'optional comment' });
  const passIn = el('input', { type: 'password', placeholder: 'optional but recommended' });
  const pinIn = el('input', { type: 'password', placeholder: 'only if your security key has one set' });
  const resident = checkbox('Resident — the key also lives on the token, usable from another machine', false);
  const verifyRequired = checkbox('Require touch and PIN for every use, not just once', false);
  const skRow = el('div', {}, field('Security key PIN', pinIn), resident, verifyRequired);
  const skHint = el('div', { class: 'hint', text: 'Needs a touch on the key, and its PIN if one is set — '
    + 'ssh-keygen waits on both.' });

  const sk = () => typeSel.value.endsWith('-sk');
  const syncSkRow = () => { skRow.style.display = sk() ? '' : 'none'; skHint.style.display = sk() ? '' : 'none'; };
  typeSel.addEventListener('change', syncSkRow);

  const res = await modal({
    title: 'Generate SSH key',
    render: (body) => {
      body.append(
        field('File name', nameIn, 'Created in ~/.ssh'),
        field('Type', typeSel),
        field('Comment', commentIn),
        field('Passphrase', passIn,
          'An empty passphrase means anyone with the file can use the key.'),
        skRow, skHint);
      syncSkRow();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Generate', class: 'primary-btn',
        onClick: ({ close }) => {
          if (!nameIn.value.trim()) return toast('Give the key a file name', 'error');
          close({
            name: nameIn.value.trim(),
            type: typeSel.value,
            comment: commentIn.value.trim(),
            passphrase: passIn.value,
            ...(sk() ? {
              pin: pinIn.value || null,
              resident: resident.input.checked,
              verifyRequired: verifyRequired.input.checked,
            } : {}),
          });
        },
      },
    ],
  });
  if (!res) return;

  try {
    status(res.type.endsWith('-sk') ? 'Waiting on the security key…' : 'Generating…', 0);
    const k = await window.api.keys.generate(res);
    toast(`Created ${k.name} (${k.type})`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally { status(''); }
}

/**
 * `ssh-add -s <provider>` — every identity a PKCS#11 token holds (a
 * YubiKey's PIV applet, a smart card), loaded through its provider library
 * rather than from a file in ~/.ssh. There is nothing to list beforehand:
 * the provider itself enumerates what is on the token once ssh-add asks it.
 */
async function pkcs11Flow() {
  const providerIn = textInput({
    placeholder: process.platform === 'darwin'
      ? '/opt/homebrew/lib/opensc-pkcs11.so, or your token\u2019s own library'
      : process.platform === 'win32'
        ? 'C:\\path\\to\\opensc-pkcs11.dll'
        : '/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so',
  });
  const pinIn = el('input', { type: 'password', placeholder: 'only if the token asks' });

  const res = await modal({
    title: 'Load a PKCS#11 token',
    render: (body) => {
      body.append(
        field('Provider library', providerIn,
          'The PKCS#11 .so/.dylib/.dll that speaks to the token — OpenSC\u2019s, or one of your own.'),
        field('PIN', pinIn));
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Load', class: 'primary-btn',
        onClick: ({ close }) => {
          if (!providerIn.value.trim()) return toast('Give the provider library\u2019s path', 'error');
          close({ provider: providerIn.value.trim(), pin: pinIn.value || null });
        },
      },
    ],
  });
  if (!res) return;

  try {
    status('Talking to the token…', 0);
    const r = await window.api.keys.addToAgent(null, { pkcs11Provider: res.provider, passphrase: res.pin });
    if (!r.ok) return toast(r.output || 'ssh-add could not load that token', 'error');
    toast('Loaded', 'success');
  } finally { status(''); }
}

/** Ask for a key passphrase without echoing it. */
function promptPassphrase(name) {
  const input = el('input', { type: 'password', placeholder: 'Passphrase', autofocus: true });
  return modal({
    title: 'Key passphrase',
    subtitle: name,
    render: (body, { close }) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
      });
      body.append(field('Passphrase for ' + name, input,
        'Used once to add the key to your agent; it is not stored.'));
    },
    buttons: [
      { label: 'Cancel', value: undefined },
      { label: 'Add', class: 'primary-btn', onClick: ({ close }) => close(input.value) },
    ],
  });
}

export async function forgetHostKey(hostname, ctx) {
  const name = hostname || await prompt({
    title: 'Forget host key', label: 'Hostname as it appears in known_hosts', confirmLabel: 'Look up',
  });
  if (!name) return;

  let entries = [];
  try { entries = await window.api.keys.knownHosts(name, ctx); } catch (e) { return toast(e.message, 'error'); }

  if (!entries.length) return toast(`No known_hosts entry for ${name}`, 'info');

  // Only name the file per-entry when more than one is in play (the default
  // plus a host-specific UserKnownHostsFile) — otherwise it's just noise.
  const files = [...new Set(entries.map((e) => e.file).filter(Boolean))];
  const ok = await confirm({
    title: 'Forget host key',
    message: `Remove ${entries.length} known_hosts entr${entries.length === 1 ? 'y' : 'ies'} for ${name}?`,
    detail: entries.map((e) => `${e.type} ${e.key}${files.length > 1 ? ` (${e.file})` : ''}`).join('\n')
      + '\n\nThe next connection will ask you to accept the new key. Only do this if you '
      + 'expected the host to change — a rebuild, a re-image, a new IP.',
    confirmLabel: 'Forget', danger: true,
  });
  if (!ok) return;

  try {
    const r = await window.api.keys.forgetHost(name, ctx);
    toast(`Removed ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'}`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}
