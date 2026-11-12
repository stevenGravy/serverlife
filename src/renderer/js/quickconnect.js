import { state } from './state.js';
import { el, clear, fmtDuration } from './util.js';
import { modal, field, textInput, toast, status } from './ui.js';
/*
 * Sessions are reached by dynamic import, as the other protocols here are.
 * Parsing an address is this module's real work and has no business pulling
 * in a terminal emulator — which is what a static import of sessions.js
 * does, and what kept the parser from being testable on its own.
 */

/**
 * Quick connect — one OpenSSH server, typed in, nothing saved.
 *
 * The rest of the app is built around an inventory: ssh_config hosts, saved
 * profiles, Teleport nodes. That is the right shape for a fleet you return to,
 * and the wrong shape for a box someone just gave you the address of. Adding it
 * as a server first means naming it, choosing where to store it, and cleaning
 * it up afterwards — for a machine that may not exist in an hour.
 *
 * So this takes a target the way ssh does, and offers the three things actually
 * wanted at that moment: check that it answers, run one command, or open a
 * session. Nothing is written to ~/.ssh/config or the profile store unless
 * "Save as server…" is used, which hands over to the Add-server dialog.
 */

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/** Split on whitespace, respecting quotes, so a pasted command line survives. */
function tokenize(s) {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) || [])
    .map((t) => t.replace(/^["']|["']$/g, ''));
}

/**
 * Parse what someone typed or pasted into connection details.
 *
 * Accepts `host`, `user@host`, `host:2222`, `user@host:2222`, bracketed and
 * bare IPv6, an `ssh://` URL, and a whole `ssh` command line — because the
 * address usually arrives as one, in a ticket or a chat message, and retyping
 * it into five fields is the thing this dialog exists to avoid.
 *
 * Returns `{ user, hostname, port, identityFile, proxyJump, command }` or null
 * when there is no hostname in it. `command` is set only by a pasted command
 * line that had one.
 */
/* The protocols quick connect can speak, and the port each assumes. */
const SCHEMES = { ssh: 22, telnet: 23, vnc: 5900, rdp: 3389 };

/**
 * A serial port, which is a path rather than an address.
 *
 * `/dev/tty.usbserial-1410`, `/dev/ttyUSB0`, `/dev/cu.*` and `COM3` — with an
 * optional speed after an `@`, because the one thing anybody changes about a
 * console is its baud rate and `\/dev/ttyUSB0@9600` is how people write it.
 */
function parseSerial(s) {
  const m = String(s).match(/^(?:serial:)?((?:\/dev\/[\w.\-/]+)|(?:COM\d+))(?:[@,](\d{3,7}))?$/i);
  if (!m) return null;
  return {
    kind: 'serial', user: '', hostname: '', port: 0,
    path: m[1], baudRate: m[2] ? parseInt(m[2], 10) : 115200,
    identityFile: '', proxyJump: '', command: '',
  };
}

export function parseTarget(raw) {
  const out = { kind: 'ssh', user: '', hostname: '', port: 22, identityFile: '', proxyJump: '', command: '' };
  let s = String(raw || '').trim();
  if (!s) return null;

  const serial = parseSerial(s);
  if (serial) return serial;

  /*
   * A protocol, given as a scheme or as a first word.
   *
   * `telnet://switch-1`, `telnet switch-1`, `vnc://10.0.0.5:5901`,
   * `rdp win-1` — all of them are how the address arrives in a ticket, and
   * the point of this dialog is not retyping what someone sent you. The port
   * that follows the protocol is that protocol's own default, not ssh's.
   */
  const scheme = s.match(/^(ssh|telnet|vnc|rdp):\/\//i) || s.match(/^(ssh|telnet|vnc|rdp)\s+/i);
  if (scheme) {
    out.kind = scheme[1].toLowerCase();
    out.port = SCHEMES[out.kind];
    if (out.kind !== 'ssh') s = s.slice(scheme[0].length).trim();
  }

  if (/^ssh\s/i.test(s)) {
    const toks = tokenize(s).slice(1);
    s = '';
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === '-p') out.port = parseInt(toks[++i], 10) || 22;
      else if (t === '-i') out.identityFile = toks[++i] || '';
      else if (t === '-J') out.proxyJump = toks[++i] || '';
      else if (t === '-l') out.user = toks[++i] || '';
      // Flags that take a value we have no field for; skip both tokens so the
      // value is not mistaken for the hostname.
      else if (/^-[oFEbcDLRWQmS]$/.test(t)) i++;
      else if (t.startsWith('-')) continue;      // bare flags: -A, -v, -4…
      else {
        /*
         * The first bare word is the target, and everything after it is the
         * remote command — verbatim, flags included. `ssh host uptime -p` runs
         * `uptime -p`; parsing that `-p` as ssh's own port flag would both lose
         * it and mangle the address.
         */
        s = t;
        if (i + 1 < toks.length) out.command = toks.slice(i + 1).join(' ');
        break;
      }
    }
  }

  s = s.replace(/^ssh:\/\//i, '');
  // A trailing path from an scp-style or URL paste. Removed before the address
  // is split, or `host:/var/log` leaves a colon stuck to the hostname — and the
  // separator itself goes with it, since scp's is a colon and no port follows.
  s = s.replace(/\/.*$/, '').replace(/:$/, '');
  if (!s) return null;

  // A password in a URL is not something to carry around silently.
  const at = s.lastIndexOf('@');
  if (at !== -1) {
    out.user = s.slice(0, at).split(':')[0] || out.user;
    s = s.slice(at + 1);
  }

  const bracketed = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    out.hostname = bracketed[1];
    if (bracketed[2]) out.port = parseInt(bracketed[2], 10);
  } else {
    const parts = s.split(':');
    // Two parts with digits last is host:port. More colons than that is a bare
    // IPv6 address, where a trailing `:22` would be ambiguous anyway.
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      out.hostname = parts[0];
      out.port = parseInt(parts[1], 10);
    } else {
      out.hostname = s;
    }
  }

  if (!out.hostname || /\s/.test(out.hostname)) return null;
  if (!(out.port >= 1 && out.port <= 65535)) return null;
  return out;
}

/** How the target reads back — the label on the tab and in the history list. */
export function targetLabel(t) {
  if (t.kind === 'serial') {
    return `${t.path}${t.baudRate && t.baudRate !== 115200 ? '@' + t.baudRate : ''}`;
  }
  const host = t.hostname.includes(':') ? `[${t.hostname}]` : t.hostname;
  const addr = (t.user ? `${t.user}@` : '') + host
    + (t.port !== (SCHEMES[t.kind || 'ssh'] || 22) ? `:${t.port}` : '');
  // The protocol is part of the name for everything that is not ssh: `win-1`
  // and `win-1` are the same words for a desktop and a shell.
  return t.kind && t.kind !== 'ssh' ? `${t.kind}://${addr}` : addr;
}

/**
 * The host descriptor `openHost` and `ensureConnection` both understand, built
 * from a parsed target.
 *
 * The id is the whole address rather than just the hostname, for two reasons:
 * two quick connects to different boxes must not be taken for the same host and
 * handed each other's connection, and one reopened from the recent list has to
 * land on the same id as the original so it reuses the connection instead of
 * dialling a second one alongside it.
 */
export function quickHost(t) {
  return {
    id: `direct:${t.user || ''}@${t.hostname}:${t.port}`,
    type: 'ssh',
    alias: null,
    name: targetLabel(t),
    direct: {
      hostname: t.hostname,
      user: t.user || null,
      port: t.port,
      identityFile: t.identityFile || null,
      proxyJump: t.proxyJump || null,
      extraOptions: '',
    },
  };
}

/**
 * Open a session on a parsed target, remembering the address. The single
 * command, if there is one, runs at the prompt of the session rather than
 * instead of it — the terminal is the point of this path.
 */
export async function connectQuick(t) {
  await rememberTarget(targetLabel(t));

  /*
   * One typed address, four protocols. They are remembered in the same recent
   * list, because "that box, but telnet this time" is the same gesture as
   * "that box, but a different port" — and the list is of addresses, which is
   * what the user is actually reaching for.
   */
  if (t.kind === 'serial') {
    const { openDeviceSession } = await import('./sessions.js');
    return openDeviceSession({ kind: 'serial', path: t.path, baudRate: t.baudRate, name: t.path });
  }
  if (t.kind === 'telnet') {
    const { openDeviceSession } = await import('./sessions.js');
    return openDeviceSession({
      kind: 'telnet', host: t.hostname, port: t.port,
      name: targetLabel(t), newline: 'crlf',
    });
  }
  if (t.kind === 'vnc') {
    const { openVncSession } = await import('./sessions.js');
    return openVncSession({ name: targetLabel(t), host: t.hostname, port: t.port, scaling: 'scale' });
  }
  if (t.kind === 'rdp') {
    try {
      const r = await window.api.rdp.launch({
        name: t.hostname, hostname: t.hostname, port: t.port, username: t.user || null,
      });
      status(`${t.hostname} opened in ${r.client === 'mstsc' ? 'Remote Desktop Connection' : 'your Remote Desktop client'}`);
    } catch (e) { toast(e.message, 'error'); }
    return null;
  }

  const { openHost } = await import('./sessions.js');
  return openHost(quickHost(t), {
    login: t.user || undefined,
    startupCommand: t.command || undefined,
  });
}

/* ------------------------------------------------------------------ */
/* Recent targets                                                      */
/* ------------------------------------------------------------------ */

const RECENT_MAX = 12;

function recentTargets() {
  const list = state.settings?.quickConnects;
  return Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
}

/**
 * Remember a target string, newest first. Only the address is kept: an identity
 * path is remembered with it, but nothing that could be a secret ever is, and
 * the list is short enough to stay recognisable.
 */
async function rememberTarget(str) {
  const next = [str, ...recentTargets().filter((s) => s !== str)].slice(0, RECENT_MAX);
  try {
    state.settings = await window.api.settings.set({ quickConnects: next });
  } catch { /* a settings write failing must not cost the connection */ }
}

/** Drop the remembered list. Called when the session history is cleared. */
export async function clearQuickConnectHistory() {
  try {
    state.settings = await window.api.settings.set({ quickConnects: [] });
  } catch { /* nothing to report: the caller is already clearing history */ }
}

/* ------------------------------------------------------------------ */
/* The dialog                                                          */
/* ------------------------------------------------------------------ */

// Kept for the life of the window, so reopening the dialog does not forget what
// was just typed. Not persisted: a command is more likely to be specific to the
// moment than the address is.
let lastCommand = '';

/**
 * Quick connect. `initial.target` prefills the address — used when promoting a
 * host from somewhere else in the UI.
 */
export async function openQuickConnectDialog(initial = {}) {
  const recent = recentTargets();

  /*
   * The field opens on ssh, whatever was used last.
   *
   * It prefills from the recent list, and once another protocol is in that
   * list the dialog can open as telnet — greying out the key, the jump host
   * and the single command, for someone who came here to reach a server. The
   * other protocols are still one click away in Recent; they just do not get
   * to decide what the box means when it opens.
   */
  const lastSsh = recent.find((r) => (parseTarget(r)?.kind || 'ssh') === 'ssh');

  const targetIn = textInput({
    value: initial.target || lastSsh || '',
    placeholder: 'ubuntu@10.0.0.5   ·   web-1.example.com:2222',
    autofocus: true,
    list: 'quick-connect-recent',
  });
  const recentList = el('datalist', { id: 'quick-connect-recent' },
    ...recent.map((r) => el('option', { value: r })));

  /*
   * The same list, on screen.
   *
   * A datalist is only found by clicking the little arrow inside the field,
   * which nobody does — so the thing you are most likely to want, the server
   * you quick-connected to an hour ago, was hidden behind a control that
   * looks like decoration. These are the same entries as buttons: one click
   * fills the field, and what is in the field is still editable, because
   * half of quick connect is "that box, but a different port".
   */
  const recentRow = recent.length
    ? el('div', { class: 'qc-recent' },
        el('span', { class: 'k', text: 'Recent' }),
        ...recent.slice(0, 8).map((r) => el('button', {
          class: 'chip', type: 'button', title: r, text: r,
          onClick: () => {
            targetIn.value = r;
            targetIn.focus();
            targetIn.setSelectionRange(r.length, r.length);
          },
        })),
        el('button', {
          class: 'ghost-btn sm', type: 'button', text: 'Forget',
          title: 'Drop the remembered list',
          onClick: async (e) => {
            await clearQuickConnectHistory();
            e.target.closest('.qc-recent')?.remove();
          },
        }))
    : null;

  const keyIn = textInput({ value: initial.identityFile || '', placeholder: '~/.ssh/id_ed25519 (optional)' });
  const keyBtn = el('button', {
    class: 'ghost-btn sm', text: 'Browse…',
    onClick: async () => {
      const p = await window.api.discovery.pickKey();
      if (p) keyIn.value = p;
    },
  });
  const jumpIn = textInput({ value: initial.proxyJump || '', placeholder: 'bastion.example.com (optional)' });

  const cmdIn = el('input', {
    type: 'text', spellcheck: 'false',
    style: 'font-family:var(--mono);font-size:12px',
    value: initial.command || lastCommand,
    placeholder: 'uptime — leave empty to open a shell',
  });

  const output = el('pre', {
    style: 'margin:0;padding:9px 11px;background:var(--panel-2);border:1px solid var(--border);'
      + 'border-radius:var(--radius);font-family:var(--mono);font-size:11.5px;white-space:pre-wrap;'
      + 'word-break:break-word;max-height:240px;overflow:auto;min-height:52px',
    text: 'Test connect and command output appear here.',
  });
  // Styled here rather than left to `.hint`: that class is only given a size
  // and colour inside a `.field`, and this sits directly in the modal body.
  const meta = el('div', {
    style: 'margin-top:6px;font-size:11px;color:var(--text-dim)',
  });

  let busy = false;
  let lastOutput = '';

  /*
   * What the typed address will actually open, and what stops applying when
   * it is not ssh.
   *
   * A private key, a jump host, a test connect and a single command are all
   * ssh's. Leaving them live for a telnet address would offer four things
   * that silently do nothing; greying them out with a line that says why is
   * the difference between a dialog that looks broken and one that is
   * telling you something.
   */
  const kindNote = el('div', { class: 'hint', style: 'margin:-2px 0 8px' });
  const SAYS = {
    ssh: '',
    telnet: 'Opens a telnet session. The key, jump host, test and single command are ssh\u2019s and do not apply.',
    vnc: 'Opens a VNC screen in a pane. The password is asked for when it connects and is not saved.',
    rdp: 'Opens this machine\u2019s own Remote Desktop client with this address.',
    serial: 'Opens the serial console at 115200 8N1 unless a speed is given \u2014 /dev/ttyUSB0@9600.',
  };
  const syncKind = () => {
    const t = parseTarget(targetIn.value);
    const kind = t?.kind || 'ssh';
    const sshOnly = kind === 'ssh';
    kindNote.textContent = SAYS[kind] || '';
    kindNote.classList.toggle('hidden', !kindNote.textContent);
    for (const node of [keyIn, keyBtn, jumpIn, cmdIn]) node.disabled = !sshOnly;
    for (const b of modalButtons) {
      if (/Test connect|Run command|Save as server/.test(b.textContent)) b.disabled = !sshOnly;
    }
  };
  let modalButtons = [];

  /** Read the form, or complain and return null. */
  const collect = () => {
    const t = parseTarget(targetIn.value);
    if (!t) { toast('Enter a hostname, or user@host:port', 'error'); return null; }
    // A pasted command line can carry these; typed fields win where both exist.
    const identityFile = keyIn.value.trim() || t.identityFile;
    const proxyJump = jumpIn.value.trim() || t.proxyJump;
    // Reflect back what was parsed out of a paste, so the dialog is not
    // secretly using details that are nowhere on screen.
    if (t.identityFile && !keyIn.value.trim()) keyIn.value = t.identityFile;
    if (t.proxyJump && !jumpIn.value.trim()) jumpIn.value = t.proxyJump;
    if (t.command && !cmdIn.value.trim()) cmdIn.value = t.command;
    if (t.command || t.identityFile || t.proxyJump || /^ssh\s/i.test(targetIn.value.trim())) {
      targetIn.value = targetLabel(t);
    }
    return { ...t, identityFile, proxyJump, command: cmdIn.value.trim() };
  };

  /*
   * Advice under the output, for the failures where the server's own message
   * is not the problem.
   *
   * "Too many authentication failures" is the worst of them: it reports a
   * count, not a cause, and the usual reading — "my key is wrong" — is
   * precisely wrong. The key may be perfect and never have been offered.
   */
  const advice = el('div', { class: 'qc-advice hidden' });

  const report = (text, ok) => {
    output.textContent = text;
    output.style.color = ok ? '' : 'var(--red)';
    if (ok) hideAdvice();
  };

  const hideAdvice = () => {
    advice.classList.add('hidden');
    clear(advice);
  };

  /**
   * What went wrong, in terms of what to do about it.
   *
   * Only for signatures where there is a real recommendation to make; a
   * refused password or an unresolvable name is already clear from the output
   * and does not need a paragraph under it.
   */
  const explain = (text, t) => {
    const msg = String(text || '');
    const tooMany = /too many authentication failures/i.test(msg);
    const denied = /permission denied/i.test(msg);
    if (!tooMany && !denied) return hideAdvice();

    clear(advice);
    advice.classList.remove('hidden');

    if (tooMany) {
      advice.append(
        el('div', { class: 'qc-advice-head', text: 'The server hung up on the number of attempts, not on a bad key' }),
        el('div', { class: 'perm-note' },
          'Your agent offers every identity it holds, one at a time, and sshd stops accepting '
          + 'attempts after MaxAuthTries — six by default. With more keys than that in the agent, '
          + 'the right one can be refused for being seventh in the queue, or never reached at all. '
          + 'Nothing here says the key is wrong.'),
        el('div', { class: 'perm-note', style: 'margin-top:8px' },
          'The fix is to name one key and offer only that. Filling in ', el('b', { text: 'Private key' }),
          ' above does exactly that — it adds ', el('code', { text: '-i <key> -o IdentitiesOnly=yes' }),
          ', so the agent’s other identities are never sent.'));
    } else {
      advice.append(
        el('div', { class: 'qc-advice-head', text: 'The server refused the credentials it was offered' }),
        el('div', { class: 'perm-note' },
          'Either the login name is not the right one for this host, or none of the keys offered '
          + 'is installed for it. The debug button below lists exactly what was offered, which is '
          + 'usually enough to tell which of the two it is.'));
    }

    const row = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px' });
    row.append(el('button', {
      class: 'primary-btn sm', text: 'Pick one key and retry…',
      onClick: () => pickKeyAndRetry(t),
    }));
    row.append(el('button', {
      class: 'ghost-btn sm', text: 'Debug info',
      title: 'Runs one verbose attempt and lists what was offered and what the server said',
      onClick: (e) => { e.currentTarget.disabled = true; showDebug(t); },
    }));
    advice.append(row);
  };

  /**
   * Offer the keys this machine actually has, then retry with one of them.
   *
   * The agent's own identities are listed too but cannot be isolated with
   * `-i`, so they are shown for what they explain — how the six attempts got
   * used up — rather than as something to pick.
   */
  const pickKeyAndRetry = async (t) => {
    let keys = [];
    let agent = null;
    try { keys = await window.api.keys.list(); } catch { /* no key list leaves the picker empty */ }
    try { agent = await window.api.keys.agent(); } catch { /* no agent leaves the picker empty */ }
    const files = (keys || []).filter((k) => k.privatePath);
    // Being in the agent is why a key was already offered — and possibly why
    // it was offered too late to count.
    const inAgent = new Set((agent?.keys || []).map((k) => k.fingerprint).filter(Boolean));

    const chosen = await modal({
      title: 'Offer one key only',
      subtitle: t ? targetLabel(t) : undefined,
      width: 'min(620px, 94vw)',
      render: (body, { close }) => {
        const held = agent?.keys?.length || 0;
        if (held) {
          body.append(el('div', { class: 'perm-note', style: 'margin-bottom:10px' },
            `Your agent is holding ${held} identit${held === 1 ? 'y' : 'ies'}, and every one of them `
            + 'is offered before anything else. That is what uses up the server’s attempt limit.'));
        }
        if (!files.length) {
          body.append(el('div', { class: 'sb-empty', text: 'No private keys found in ~/.ssh.' }));
          return;
        }
        const list = el('div', { class: 'picker-list' });
        for (const k of files) {
          list.append(el('div', { class: 'picker-item', onClick: () => close(k.privatePath) },
            el('span', { class: 'pname' },
              el('div', { text: k.name || k.privatePath }),
              el('div', { class: 'pmeta', text: [k.type, k.bits ? k.bits + ' bits' : '', k.fingerprint].filter(Boolean).join('  ·  ') })),
            k.encrypted ? el('span', { class: 'tag warn', text: 'passphrase' }) : null,
            inAgent.has(k.fingerprint) ? el('span', { class: 'tag', text: 'in agent' }) : null));
        }
        body.append(list);
        body.append(el('div', { class: 'hint', style: 'margin-top:9px' },
          'The chosen key goes in the Private key field, and only it is offered.'));
      },
      buttons: [
        { label: 'Cancel', value: null },
        {
          label: 'Browse…',
          onClick: async ({ close }) => {
            const p = await window.api.discovery.pickKey();
            if (p) close(p);
          },
        },
      ],
    });
    if (!chosen) return;
    keyIn.value = chosen;
    status('Retrying with ' + chosen);
    testConnect();
  };

  /** The verbose attempt, laid out: what was offered, and what came back. */
  const showDebug = async (t) => {
    const target = t?.user ? `${t.user}@${t.hostname}` : (t?.hostname || '');
    if (!target) return;
    const box = el('pre', { class: 'qc-debug', text: 'Running ssh -vv …' });
    advice.append(box);
    try {
      const r = await window.api.ssh.authProbe(target, {
        port: t.port,
        identityFile: keyIn.value.trim() || undefined,
        proxyJump: jumpIn.value.trim() || undefined,
      });
      const lines = [
        r.command,
        '',
        r.methods ? `Server accepts:      ${r.methods}` : '',
        r.offered.length
          ? `Keys offered (${r.offered.length}):\n` + r.offered.map((o, i) => `  ${i + 1}. ${o}`).join('\n')
          : 'No keys were offered at all — nothing in the agent and no identity file matched.',
        r.accepted ? `\nAccepted:            ${r.accepted}` : '',
        r.tooMany
          ? `\nThe server stopped after ${r.offered.length} attempt(s): MaxAuthTries reached.`
          : '',
        r.pastLimit
          ? `\nsshd allows 6 attempts by default and counts every offer above, so `
            + `anything after the sixth was never assessed. Offer one key instead.`
          : '',
        r.missingIdentity ? `\nThis identity file could not be read: ${r.missingIdentity}` : '',
        r.finalError ? `\n${r.finalError}` : '',
      ].filter(Boolean);
      box.textContent = lines.join('\n');
      lastOutput = box.textContent;
    } catch (e) {
      box.textContent = e.message;
    }
  };

  /**
   * Dial, run one command, hang up — reporting into this window.
   *
   * Deliberately a throwaway connection rather than one of the app's managed
   * sessions: both callers are answering a question about the server, and
   * neither should leave a ControlMaster and a half-open session behind for a
   * box that may not be wanted at all.
   */
  const dialOnce = async ({ command, running, done }) => {
    const t = collect();
    if (!t || busy) return null;
    busy = true;
    let connId = null;
    const t0 = Date.now();
    report(running, true);
    meta.textContent = '';
    try {
      const created = await window.api.conn.create(
        { type: 'ssh', alias: null, name: targetLabel(t), direct: quickHost(t).direct },
        { login: t.user || undefined });
      connId = created.id;
      await window.api.conn.connect(connId);
      const out = await window.api.conn.exec(connId, command(t));
      lastOutput = out;
      done(out, t);
      meta.textContent = `${fmtDuration(Date.now() - t0)} · ${out.length} bytes`;
      rememberTarget(targetLabel(t));
      return out;
    } catch (e) {
      // A non-zero exit lands here too, carrying the server's stderr.
      lastOutput = e.message || '';
      report(e.message || 'Could not connect', false);
      meta.textContent = `Failed after ${fmtDuration(Date.now() - t0)}`;
      // The server's sentence is not always the useful one; say what to do.
      explain(e.message || '', t);
      return null;
    } finally {
      if (connId) window.api.conn.disconnect(connId).catch(() => {});
      busy = false;
    }
  };

  /** Prove the address and the credentials work before anything is built on them. */
  const testConnect = () => dialOnce({
    running: 'Connecting…',
    command: () => 'id -un; hostname; uname -sr; uptime',
    done: (out) => {
      const [who, host, kernel, up] = out.trim().split('\n');
      report([
        `Connected as  ${who}`,
        `Host          ${host}`,
        `Kernel        ${kernel}`,
        up ? `Uptime        ${up.trim()}` : '',
      ].filter(Boolean).join('\n'), true);
    },
  });

  /** One command, output here, no terminal. */
  const runCommand = () => {
    if (!cmdIn.value.trim()) {
      toast('Enter a command to run', 'error');
      cmdIn.focus();
      return Promise.resolve(null);
    }
    lastCommand = cmdIn.value.trim();
    return dialOnce({
      running: 'Running…',
      command: (t) => t.command,
      done: (out) => report(out.trim() || '(no output)', true),
    });
  };

  let closeModal;

  /** Open a real session tab. With a command in the box, run it at the prompt. */
  const connect = async () => {
    const t = collect();
    if (!t) return;
    lastCommand = t.command;
    closeModal?.(null);
    try {
      await connectQuick(t);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  await modal({
    title: 'Quick connect',
    subtitle: 'A server, a console or a screen — nothing saved',
    width: 'min(700px, 94vw)',
    render: (body, { close }) => {
      closeModal = close;
      body.append(...[
        recentList,
        field('Server', targetIn,
          'user@host, host:port, a whole ssh command line pasted in — or another '
          + 'protocol: telnet://switch-1, vnc://10.0.0.5:5901, rdp://win-1, /dev/ttyUSB0'),
        kindNote,
        recentRow,
        el('div', { class: 'field-row' },
          field('Private key', el('div', { style: 'display:flex;gap:6px' }, keyIn, keyBtn),
            'Optional — otherwise your agent and defaults are used'),
          field('Jump host (ProxyJump)', jumpIn, 'Optional — reach it through a bastion')),
        field('Single command', cmdIn,
          'With a command here, Run command answers in this window and Connect '
          + 'opens a session that starts by running it'),
        el('label', { style: 'font-size:11px;color:var(--muted);margin-bottom:5px;display:block', text: 'Result' }),
        // Nothing recent is no row at all, not a "null".
        output, meta, advice].filter(Boolean));

      const onEnter = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        // Enter on the command box runs the command; elsewhere it connects,
        // which is what Enter means everywhere else in this app.
        if (e.target === cmdIn && cmdIn.value.trim()) runCommand();
        else connect();
      };
      targetIn.addEventListener('input', syncKind);
      syncKind();
      targetIn.addEventListener('keydown', onEnter);
      cmdIn.addEventListener('keydown', onEnter);
      keyIn.addEventListener('keydown', onEnter);
      jumpIn.addEventListener('keydown', onEnter);
      setTimeout(() => targetIn.select(), 40);
    },
    onOpen: ({ box }) => {
      modalButtons = [...box.querySelectorAll('.modal-foot button, .modal-footer button, button')];
      syncKind();
    },
    buttons: [
      {
        label: 'Save as server…',
        onClick: async ({ close }) => {
          const t = collect();
          if (!t) return;
          close(null);
          const { openAddServerDialog } = await import('./addserver.js');
          openAddServerDialog({
            name: t.hostname.split('.')[0],
            hostname: t.hostname,
            user: t.user,
            port: t.port,
            identityFile: t.identityFile,
            proxyJump: t.proxyJump,
          });
        },
      },
      {
        label: 'Copy output',
        onClick: () => {
          if (!lastOutput) return toast('Nothing to copy yet', 'info');
          window.api.clipboard.write(lastOutput);
          status('Output copied');
        },
      },
      { label: 'Test connect', onClick: () => testConnect() },
      { label: 'Run command', onClick: () => runCommand() },
      { label: 'Connect', class: 'primary-btn', onClick: () => connect() },
    ],
  });
}
