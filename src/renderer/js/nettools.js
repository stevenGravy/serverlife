import { state } from './state.js';
import { el, clear, fmtBytes } from './util.js';
import { modal, toast, status, textInput, select, checkbox, contextMenu, prompt, confirm } from './ui.js';
import { fmtDuration } from './util.js';

/**
 * Network tools — the "why can't I reach this" panel.
 *
 * One target at the top, a tool below it, and the target survives switching
 * tools, because the whole point is running several against the same host.
 */

/*
 * `remote` says whether a tool can run *on* a chosen host as well as from
 * here. Three need nothing installed on the far side: a port check has the
 * server open the connection (`ssh -W`), an HTTP request goes through a SOCKS
 * proxy over the session so the name is resolved there, and the facts come
 * from `ip` and `/etc/resolv.conf`, which every host has.
 *
 * Ping and traceroute do need a tool, and get one anyway — they are the first
 * two things anyone reaches for, and `ping` is on almost every box. `needs`
 * names what a host must have, so the list can grey the tool with the install
 * command rather than failing when it is pressed; a traceroute takes any of
 * three, since the one everybody names is the one least often installed.
 *
 * The rest would need their output parsed per distribution, so they say so
 * rather than half-working.
 *
 * Telnet and serial are the two that end in a session rather than a report,
 * and they borrow the console machinery rather than growing their own. Telnet
 * runs from a host too — the switch that only the bastion can see is the
 * usual reason for reaching for it — but there it is the host's own `telnet`
 * in a terminal on that host, because the bytes have to start there. Serial is
 * this machine's only: a cable plugged into a server in a rack is not
 * something an SSH session can hand back, and pretending otherwise would list
 * the ports on the wrong computer.
 */
const TOOLS = [
  { id: 'ping', label: 'Ping', remote: true, needs: ['ping'] },
  { id: 'curl', label: 'HTTP request (curl)', remote: true },
  { id: 'traceroute', label: 'Traceroute', remote: true, needs: ['traceroute', 'tracepath', 'mtr'] },
  { id: 'dns', label: 'DNS' },
  { id: 'ports', label: 'Port check', remote: true },
  { id: 'sockets', label: 'Listening & connections', remote: true, needs: ['ss', 'netstat'] },
  { id: 'telnet', label: 'Telnet', remote: true },
  { id: 'tls', label: 'TLS certificate' },
  { id: 'http', label: 'HTTP' },
  { id: 'whois', label: 'Whois' },
  { id: 'serial', label: 'Serial console' },
  { id: 'teleport', label: 'Teleport cluster' },
  { id: 'local', label: 'This machine', remote: true },
  { id: 'cidr', label: 'Subnet calculator (CIDR)' },
  { id: 'url', label: 'URL encode / decode', paste: true },
  /*
   * The three credentials a Teleport user meets, taken apart. They are not
   * network checks, but they are what gets pasted in while working out why a
   * connection is refused, so they live where that work happens. Pasted, not
   * typed into the target: a certificate is several lines, and none of these
   * is kept in the recent list — they are credentials.
   */
  { id: 'sshcert', label: 'Decode: SSH certificate', paste: true },
  { id: 'jwt', label: 'Decode: JWT', paste: true },
  { id: 'svid', label: 'Decode: SPIFFE SVID', paste: true },
];

/** The decoders, by id, for the right-click menus that open them. */
export const DECODE_TOOLS = [
  { id: 'sshcert', label: 'SSH certificate' },
  { id: 'jwt', label: 'JWT' },
  { id: 'svid', label: 'SPIFFE SVID (X.509)' },
];

const isPaste = (id) => !!TOOLS.find((t) => t.id === id)?.paste;

function toolCanRunRemotely(id) {
  return !!TOOLS.find((t) => t.id === id)?.remote;
}

/**
 * What a tool needs on the chosen host and has not got, or null.
 *
 * Any one of `needs` is enough — a traceroute is a traceroute whether it came
 * from `traceroute`, `tracepath` or `mtr` — so the name reported is the first,
 * which is the one people will recognise. Until the probe has answered,
 * nothing is declared missing: greying a tool out on no evidence is worse than
 * letting it be pressed.
 */
function missingFor(tool, caps) {
  if (!tool?.needs?.length || !caps?.tools) return null;
  return tool.needs.some((n) => caps.tools[n]) ? null : tool.needs[0];
}

export async function openNetTools({ host, tool = 'ping', preset = null, runOn: runOnWanted = '', input = '', file = '' } = {}) {
  let current = tool;
  let running = false;
  let body = null;
  // The last result, kept so it can be saved or copied after the fact.
  let lastText = '';
  // A decoder or "This machine" has no live, before-you-run preview — the
  // command only exists once a result has come back — so the footer's
  // "Copy command" needs its own record of it, separate from the two
  // preview nodes below. Tagged with the tool it was for: switching away
  // without running again must not let a *different* tool's last command
  // answer for this one. No note alongside it — that already shows inline
  // in the result itself; the clipboard only ever wants the command.
  let lastRunCommand = '';
  let lastRunCommandTool = '';

  const targetIn = textInput({
    placeholder: 'host, host:port or URL — anything you want to test',
    value: host || suggestTarget(),
  });
  const toolSel = select(TOOLS.map((t) => ({ value: t.id, label: t.label })), current);

  const portsIn = textInput({ placeholder: '22,443,3022-3025', value: '' });
  const countIn = textInput({ type: 'number', value: '5', min: '1', max: '20' });
  const methodSel = select([{ value: 'GET', label: 'GET' }, { value: 'HEAD', label: 'HEAD' }], 'GET');
  // The plain HTTP check's own headers/-k — narrower than curl's (still no
  // auth, no body, no method beyond GET/HEAD), but enough that "I just need
  // one header" no longer means switching tools for it.
  const httpHeadersIn = el('textarea', {
    class: 'nt-ta', rows: '3', spellcheck: 'false',
    placeholder: 'Accept: application/json\nX-Request-Id: abc123',
  });
  const httpInsecureIn = checkbox('Skip certificate verification (-k)', false);
  // Shared by ping, traceroute and the port check — a dual-stack host being
  // flaky over one family but not the other is exactly the kind of question
  // these three exist to answer, and none of them could force the choice.
  const ipVersionSel = select([
    { value: '', label: 'Either' }, { value: '4', label: 'IPv4' }, { value: '6', label: 'IPv6' },
  ], '');
  const dnsServerIn = textInput({ placeholder: 'this machine’s own (default)' });
  const starttlsSel = select([
    { value: '', label: 'Direct TLS (default)' },
    { value: 'smtp', label: 'STARTTLS — SMTP' },
    { value: 'imap', label: 'STARTTLS — IMAP' },
    { value: 'pop3', label: 'STARTTLS — POP3' },
  ], '');

  /* ---- pasted input: URL text and the decoders ---- */
  const pasteIn = el('textarea', {
    class: 'nt-paste',
    style: 'width:100%;min-height:84px;font-family:var(--mono);font-size:11.5px',
    spellcheck: 'false',
  });
  pasteIn.value = input || '';
  /*
   * Each pasted-input tool keeps its own text. A certificate left in the box
   * is not a JWT, and switching to the JWT decoder with it still there reads
   * as "decode this" — so the box follows the tool, and comes back as it was
   * when you switch back.
   */
  const pasteFor = { [tool]: pasteIn.value };
  /*
   * The file the box's text came from, when it came from one — tsh's list, a
   * cluster's Decode, or Browse — so the result can say where it lives. Typing
   * in the box makes it text of your own again.
   */
  let pasteFile = input ? file : '';
  const fileFor = { [tool]: pasteFile };
  /* The picked file, just under Browse; clicking it opens the folder it is in. */
  const fileLine = el('div', { class: 'nt-picked' });
  const setPasteFile = (f) => {
    pasteFile = f || '';
    clear(fileLine);
    fileLine.hidden = !pasteFile;
    if (!pasteFile) return;
    fileLine.append(
      el('span', { class: 'nt-picked-label', text: 'File' }),
      el('button', {
        class: 'nt-picked-path', text: pasteFile, title: `${REVEAL_LABEL}: ${pasteFile}`,
        onClick: () => window.api.local.reveal(pasteFile).catch((e) => toast(e.message, 'error')),
      }));
  };
  setPasteFile(pasteFile);
  pasteIn.addEventListener('input', () => { if (pasteFile) setPasteFile(''); });
  const swapPaste = (next) => {
    if (isPaste(current)) { pasteFor[current] = pasteIn.value; fileFor[current] = pasteFile; }
    if (isPaste(next)) { pasteIn.value = pasteFor[next] || ''; setPasteFile(fileFor[next]); }
  };
  const browseBtn = el('button', {
    class: 'ghost-btn sm', text: 'Browse…',
    title: 'Decode a file from disk instead of pasting it',
    onClick: async () => {
      try {
        const r = await window.api.decode.pickFile(current);
        if (!r) return;
        pasteIn.value = r.text.trim();
        setPasteFile(r.file);
        runTool();
      } catch (e) { toast(e.message, 'error'); }
    },
  });
  pasteIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runTool(); }
  });
  const cidrCheckIn = textInput({ placeholder: '10.0.4.20 (optional)', value: '' });
  // tsh's own certificates, so "what does my cert say" needs no paste.
  const certPick = select([{ value: '', label: 'Use a certificate tsh issued…' }], '');
  let tshCerts = [];
  certPick.addEventListener('change', () => {
    const c = tshCerts[Number(certPick.value)];
    if (c) { pasteIn.value = c.text.trim(); setPasteFile(c.file); runTool(); }
  });
  const loadTshCerts = async () => {
    tshCerts = await window.api.decode.tshCerts().catch(() => []);
    clear(certPick);
    certPick.append(el('option', { value: '', text: tshCerts.length ? 'Use a certificate tsh issued…' : 'No tsh certificates found' }));
    tshCerts.forEach((c, i) => certPick.append(el('option', { value: String(i), text: `${c.user} @ ${c.cluster} (${c.proxy})` })));
    certPick.disabled = !tshCerts.length;
  };

  /* ---- telnet ---- */
  /*
   * The port has a field of its own rather than living only in the target,
   * because the target is shared with every other tool and "example.com:23"
   * would turn the next TLS check into a TLS check of the telnet port.
   */
  const telnetPortIn = textInput({ type: 'number', value: '23', min: '1', max: '65535' });
  const telnetNewline = newlineSelect('crlf');
  const telnetEcho = checkbox('Show what I type (local echo)', false);
  const telnetOpenBtn = el('button', {
    class: 'ghost-btn sm', text: 'Open session',
    title: 'Open a telnet session to the target in a tab of its own',
    onClick: () => openTelnet(),
  });

  /* ---- serial ---- */
  /*
   * The same choices as a saved serial console, with the same defaults —
   * 115200 8N1 and no flow control, which is what almost everything made
   * this century wants. The port is a box as well as a list, for the adapter
   * that enumerates under a name the list did not think to offer.
   */
  const serialPathIn = textInput({ placeholder: '/dev/tty.usbserial-1410 or COM3', value: '' });
  serialPathIn.style.minWidth = '240px';
  const serialBaud = select(
    [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((b) => ({ value: String(b), label: String(b) })),
    '115200');
  const serialDataBits = select(['8', '7', '6', '5'].map((v) => ({ value: v, label: v })), '8');
  const serialParity = select([
    { value: 'none', label: 'None' }, { value: 'even', label: 'Even' }, { value: 'odd', label: 'Odd' },
  ], 'none');
  const serialStopBits = select([{ value: '1', label: '1' }, { value: '2', label: '2' }], '1');
  const serialFlow = select([
    { value: 'none', label: 'None' },
    { value: 'rtscts', label: 'Hardware (RTS/CTS)' },
    { value: 'xonxoff', label: 'Software (XON/XOFF)' },
  ], 'none');
  const serialNewline = newlineSelect('cr');
  const serialEcho = checkbox('Show what I type (local echo)', false);
  const serialOpenBtn = el('button', {
    class: 'ghost-btn sm', text: 'Open console',
    title: 'Open a serial console on this port, at these settings',
    onClick: () => openSerial(serialPathIn.value.trim()),
  });

  /** The serial settings, in the shape `openDeviceSession` and a saved console both take. */
  const serialSpec = (devPath) => ({
    kind: 'serial',
    path: devPath,
    name: devPath,
    baudRate: parseInt(serialBaud.value, 10) || 115200,
    dataBits: parseInt(serialDataBits.value, 10) || 8,
    parity: serialParity.value,
    stopBits: parseInt(serialStopBits.value, 10) || 1,
    rtscts: serialFlow.value === 'rtscts',
    xon: serialFlow.value === 'xonxoff',
    xoff: serialFlow.value === 'xonxoff',
    newline: serialNewline.value,
    localEcho: serialEcho.input.checked,
  });

  // Set once the window is drawn; opening a session is the end of the errand.
  let closeWindow = null;

  const openSerial = async (devPath) => {
    if (!devPath) return toast('Choose a serial port first', 'error');
    serialPathIn.value = devPath;
    const { openDeviceSession } = await import('./sessions.js');
    closeWindow?.();
    // Errors land in the pane itself, with Enter to try again — the same as
    // a saved console — so there is nothing to catch here.
    await openDeviceSession(serialSpec(devPath));
  };

  const saveSerial = async (devPath) => {
    if (!devPath) return toast('Choose a serial port first', 'error');
    const s = serialSpec(devPath);
    const { openProfileEditor } = await import('./profiles.js');
    await openProfileEditor({ ...s, type: 'serial', kind: undefined });
  };

  /**
   * Telnet to the target: from here with the app's own client, or from the
   * chosen host with that host's `telnet` in a terminal there.
   */
  const openTelnet = async () => {
    let t;
    try { t = telnetTarget(targetIn.value, telnetPortIn.value); }
    catch (e) { return toast(e.message, 'error'); }
    if (runOn) {
      if (caps && !caps.tools?.telnet) {
        return toast(`No telnet on ${state.getConnection(runOn)?.label || 'that host'} — `
          + 'install the telnet package there, or open it from this machine', 'error');
      }
      const { openOnConnection } = await import('./sessions.js');
      const label = state.getConnection(runOn)?.label || 'host';
      closeWindow?.();
      try {
        await openOnConnection(runOn, {
          startupCommand: `telnet ${t.host} ${t.port}`,
          title: `${t.host}:${t.port} via ${label}`,
        });
      } catch (e) { toast(e.message, 'error'); }
      return;
    }
    const { openDeviceSession } = await import('./sessions.js');
    closeWindow?.();
    await openDeviceSession({
      kind: 'telnet', host: t.host, port: t.port, name: `${t.host}:${t.port}`,
      newline: telnetNewline.value, localEcho: telnetEcho.input.checked,
    });
  };

  /* ---- curl ---- */
  const curlMethod = select(
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => ({ value: m, label: m })),
    preset?.opts?.method || 'GET');
  const curlHeaders = el('textarea', {
    class: 'nt-ta', rows: '3', spellcheck: 'false',
    placeholder: 'Accept: application/json\nX-Request-Id: abc123',
  });
  curlHeaders.value = preset?.opts?.headers || '';
  const curlBody = el('textarea', {
    class: 'nt-ta', rows: '5', spellcheck: 'false',
    placeholder: '{ "name": "value" }',
  });
  curlBody.value = preset?.opts?.body || '';
  const curlType = select([
    { value: 'application/json', label: 'application/json' },
    { value: 'application/x-www-form-urlencoded', label: 'form-urlencoded' },
    { value: 'text/plain', label: 'text/plain' },
    { value: '', label: 'none (let curl decide)' },
  ], preset?.opts?.contentType ?? 'application/json');
  const curlBearer = textInput({ value: preset?.opts?.bearer || '', placeholder: 'a token, if the API wants one' });
  const curlUser = textInput({ value: preset?.opts?.basicUser || '', placeholder: 'user (basic auth)' });
  const curlPass = textInput({ type: 'password', value: preset?.opts?.basicPass || '', placeholder: 'password' });
  const curlInsecure = checkbox('Skip certificate verification (-k)', !!preset?.opts?.insecure);
  const curlFollow = checkbox('Follow redirects (-L)', preset?.opts?.followRedirects !== false);
  const curlTimeout = textInput({ type: 'number', value: String(preset?.opts?.timeout || 20), min: '1', max: '300' });
  /*
   * `--resolve`, a private CA and a client cert/key — curl's own way to
   * answer "what would this look like after the DNS cutover" and to reach
   * something behind mutual TLS, both common enough against an internal
   * service that "just use -k" is the wrong answer to either.
   */
  const curlResolve = el('textarea', {
    class: 'nt-ta', rows: '2', spellcheck: 'false',
    placeholder: 'internal.example.com:443:10.0.0.5 — one per line, for --resolve',
  });
  curlResolve.value = preset?.opts?.resolve || '';
  const filePickRow = (input, title) => el('div', { class: 'field-row' }, el('div', { style: 'flex:1' }, input), bare(el('button', {
    class: 'ghost-btn sm', text: 'Browse…',
    onClick: async () => {
      try {
        const p = await window.api.net.pickFile(title);
        if (p) { input.value = p; syncCurlPreview(); }
      } catch (e) { toast(e.message, 'error'); }
    },
  })));
  const curlCaCert = textInput({ value: preset?.opts?.caCert || '', placeholder: 'A CA bundle this proxy or service signs against' });
  const curlClientCert = textInput({ value: preset?.opts?.clientCert || '', placeholder: 'For mutual TLS' });
  const curlClientKey = textInput({ value: preset?.opts?.clientKey || '', placeholder: 'Its private key' });
  const curlPreview = el('div', { class: 'nt-cmd', style: 'margin-top:6px;white-space:pre-wrap;word-break:break-all' });

  /*
   * The same idea as the curl preview above, generalised: every tool that
   * ends up running a real command gets to show it before it is run, not
   * only after — so it can be copied and run by hand without ServerLife
   * touching the target at all. `previewCommand` does no I/O; it mirrors
   * each tool's own host/port parsing with no risk of actually dialling
   * anything while someone is mid-keystroke.
   */
  const PREVIEWABLE_TOOLS = ['ping', 'traceroute', 'dns', 'ports', 'telnet', 'tls', 'http', 'whois', 'teleport'];
  const cmdPreview = el('div', { class: 'nt-cmd', style: 'white-space:pre-wrap;word-break:break-all' });
  const cmdPreviewNote = el('div', { class: 'nt-cmd-note' });
  const syncGenericPreview = async () => {
    if (!PREVIEWABLE_TOOLS.includes(current)) return;
    // The tool (or target) this call was for — not necessarily what `current`
    // still is by the time it resolves. Switching tools quickly fires this,
    // then clears the preview for whatever is now selected, then — without
    // this guard — the *earlier* call would land late and write the old
    // tool's command straight back in, overwriting that clear.
    const askedFor = current;
    try {
      const r = await window.api.net.previewCommand({
        tool: current,
        host: targetIn.value.trim(),
        ports: portsIn.value.trim(),
        count: countIn.value,
        method: methodSel.value,
        telnetPort: telnetPortIn.value,
        ipVersion: ipVersionSel.value,
        server: dnsServerIn.value.trim(),
        starttls: starttlsSel.value,
        insecure: httpInsecureIn.input.checked,
        headers: httpHeadersIn.value,
      });
      if (current !== askedFor) return;
      cmdPreview.textContent = r.command || '';
      cmdPreviewNote.textContent = r.commandNote || '';
      cmdPreviewNote.hidden = !r.commandNote;
    } catch {
      if (current !== askedFor) return;
      cmdPreview.textContent = '';
    }
  };
  const cmdPreviewBlock = el('div', { class: 'nt-cmdblock' }, cmdPreview, cmdPreviewNote);

  const curlOpts = () => ({
    method: curlMethod.value,
    url: targetIn.value.trim(),
    headers: curlHeaders.value,
    body: curlBody.value,
    contentType: curlType.value,
    bearer: curlBearer.value.trim(),
    basicUser: curlUser.value.trim(),
    basicPass: curlPass.value,
    insecure: curlInsecure.input.checked,
    followRedirects: curlFollow.input.checked,
    timeout: parseInt(curlTimeout.value, 10) || 20,
    resolve: curlResolve.value,
    caCert: curlCaCert.value.trim(),
    clientCert: curlClientCert.value.trim(),
    clientKey: curlClientKey.value.trim(),
  });

  /*
   * The command, shown as it will be run.
   *
   * Built in the main process from the same argv the request uses, so what is
   * previewed, copied and sent cannot drift apart — and a token in it is
   * visible, which is the honest state of affairs for anything on an argv.
   */
  const syncCurlPreview = async () => {
    if (current !== 'curl') return;
    // Same guard as the generic preview: a switch away from curl clears
    // `curlPreview` synchronously, and without this an in-flight call from
    // just before that switch would land late and write the old command
    // straight back in.
    try {
      const text = await window.api.net.curlCommand(curlOpts());
      if (current !== 'curl') return;
      curlPreview.textContent = text;
    } catch (e) {
      if (current !== 'curl') return;
      curlPreview.textContent = e.message;
    }
  };

  const curlBlock = el('div', { class: 'nt-curl' },
    el('div', { class: 'nt-options' },
      smallField('Method', curlMethod),
      smallField('Timeout (s)', curlTimeout)),
    el('div', { class: 'field' }, el('label', { text: 'Headers (one per line)' }), curlHeaders),
    el('div', { class: 'field' }, el('label', { text: 'Body' }), curlBody),
    el('div', { class: 'nt-options' },
      smallField('Content type', curlType),
      smallField('Bearer token', curlBearer)),
    el('div', { class: 'nt-options' },
      smallField('Basic auth', curlUser),
      smallField('Password', curlPass)),
    el('div', { class: 'field' }, el('label', { text: '--resolve (host:port:address, one per line)' }), curlResolve),
    el('div', { class: 'field' }, el('label', { text: 'CA bundle' }), filePickRow(curlCaCert, 'Choose a CA bundle')),
    el('div', { class: 'nt-options' },
      el('div', { class: 'field', style: 'flex:1' }, el('label', { text: 'Client certificate' }), filePickRow(curlClientCert, 'Choose a client certificate')),
      el('div', { class: 'field', style: 'flex:1' }, el('label', { text: 'Client key' }), filePickRow(curlClientKey, 'Choose the certificate’s private key'))),
    curlFollow, curlInsecure,
    curlPreview);

  /*
   * Worked examples.
   *
   * curl's own flags are not the hard part — remembering the shape of the call
   * is. These are the shapes: read an API, send JSON, send a form, push a
   * webhook, check a health endpoint. Picking one fills the form in, ready to
   * be edited rather than explained.
   */
  const CURL_EXAMPLES = [
    {
      name: 'GET a JSON API',
      why: 'Read an endpoint and pretty-print what comes back',
      method: 'GET', url: 'https://api.github.com/repos/gravitational/teleport',
      headers: 'Accept: application/json', body: '', contentType: 'application/json',
    },
    {
      name: 'GET with a bearer token',
      why: 'The usual shape for an API behind OAuth or a service token',
      method: 'GET', url: 'https://api.example.com/v1/me',
      headers: 'Accept: application/json', body: '', contentType: 'application/json',
      bearer: 'PASTE_TOKEN_HERE',
    },
    {
      name: 'POST JSON',
      why: 'Create something. The body is sent exactly as typed.',
      method: 'POST', url: 'https://api.example.com/v1/things',
      headers: 'Accept: application/json',
      body: '{\n  "name": "example",\n  "enabled": true\n}',
      contentType: 'application/json',
    },
    {
      name: 'POST a form',
      why: 'An old-fashioned form post — key=value&key=value',
      method: 'POST', url: 'https://example.com/login',
      headers: '', body: 'username=admin&password=hunter2',
      contentType: 'application/x-www-form-urlencoded',
    },
    {
      name: 'PATCH one field',
      why: 'Change part of a resource without sending the whole thing',
      method: 'PATCH', url: 'https://api.example.com/v1/things/42',
      headers: 'Accept: application/json',
      body: '{ "enabled": false }', contentType: 'application/json',
    },
    {
      name: 'DELETE a resource',
      why: 'And see whether it answers 204 or an error worth reading',
      method: 'DELETE', url: 'https://api.example.com/v1/things/42',
      headers: 'Accept: application/json', body: '', contentType: '',
    },
    {
      name: 'Post to a webhook',
      why: 'Slack, Teams, an alertmanager receiver — a JSON body to a URL',
      method: 'POST', url: 'https://hooks.example.com/services/T000/B000/XXXX',
      headers: '', body: '{ "text": "ServerLife was here" }',
      contentType: 'application/json',
    },
    {
      name: 'Health check',
      why: 'Is it up, what does it say, and how long did it take',
      method: 'GET', url: 'https://example.com/healthz',
      headers: '', body: '', contentType: '', timeout: 5,
    },
    {
      name: 'HEAD — headers only',
      why: 'Content type, length, caching and redirects, without the body',
      method: 'HEAD', url: 'https://example.com/large-file.iso',
      headers: '', body: '', contentType: '',
    },
    {
      name: 'A Teleport proxy',
      why: 'The unauthenticated ping every cluster answers',
      method: 'GET', url: (state.teleportProfiles?.[0]?.proxy
        ? 'https://' + state.teleportProfiles[0].proxy + '/webapi/ping'
        : 'https://teleport.example.com/webapi/ping'),
      headers: 'Accept: application/json', body: '', contentType: '',
    },
  ];

  /**
   * The same idea for every other tool: the two or three things people
   * actually run, with the target already shaped correctly.
   *
   * A proxy from a logged-in cluster is used where one is available, because
   * "the thing I am debugging" is almost always that.
   */
  const proxyNow = () => (state.teleportProfiles?.find((x) => !x.expired) || state.teleportProfiles?.[0])?.proxy || '';
  const TOOL_EXAMPLES = {
    ping: [
      { name: 'Is this host answering?', why: 'Five packets, then loss and round-trip times', target: proxyNow() || 'example.com', opts: { count: '5' } },
      { name: 'Watch for flapping', why: 'Twenty packets — enough to see loss that comes and goes', target: proxyNow() || 'example.com', opts: { count: '20' } },
      { name: 'A gateway on the LAN', why: 'Rules out the local network before blaming anything else', target: '192.168.1.1', opts: { count: '5' } },
    ],
    traceroute: [
      { name: 'Where does it stop?', why: 'The hop where a route dies is usually the answer', target: proxyNow() || 'example.com', opts: {} },
      { name: 'Path to a public resolver', why: 'A known-good target, to tell "my link" from "their host"', target: '1.1.1.1', opts: {} },
    ],
    dns: [
      { name: 'What does this name resolve to?', why: 'A, AAAA, CNAME, MX, TXT, NS and SRV in one go', target: proxyNow() || 'example.com', opts: {} },
      { name: 'Reverse lookup an address', why: 'PTR — which name claims this IP', target: '8.8.8.8', opts: {} },
      { name: 'A Teleport SRV record', why: 'How clients discover a proxy when SRV is used', target: '_teleport._tcp.example.com', opts: {} },
    ],
    ports: [
      { name: 'The usual Teleport ports', why: 'Proxy web, SSH proxy, tunnel and node ports', target: proxyNow() || 'example.com', opts: { ports: '443,3023,3024,3025,3080' } },
      { name: 'Just SSH', why: 'Is 22 open at all, and how quickly does it answer', target: 'example.com', opts: { ports: '22' } },
      { name: 'A database behind a tunnel', why: 'Check the local end of a port forward', target: 'localhost', opts: { ports: '5432,3306,6379' } },
    ],
    telnet: [
      { name: 'A switch or terminal server', why: 'Port 23, and whatever login prompt it gives', target: 'switch-1', opts: { port: '23' } },
      { name: 'What is on this SSH port?', why: 'An SSH server names its version before anything else', target: proxyNow() || 'example.com', opts: { port: '22' } },
      { name: 'A mail server’s greeting', why: 'SMTP says who it is the moment you connect', target: 'smtp.example.com', opts: { port: '25' } },
      { name: 'A console server line', why: 'Terminal servers put each serial line on its own port', target: 'console-1', opts: { port: '2001' } },
    ],
    serial: [
      { name: 'Most things made this century', why: '115200 8N1, no flow control', target: '', opts: { baud: '115200' } },
      { name: 'Older network gear', why: 'Cisco and friends at 9600 8N1 — the console default for decades', target: '', opts: { baud: '9600' } },
    ],
    tls: [
      { name: 'When does this certificate expire?', why: 'Chain, SANs, cipher and days left', target: proxyNow() || 'example.com:443', opts: {} },
      { name: 'A certificate on a non-standard port', why: 'Written host:port, that port is the one inspected', target: 'example.com:8443', opts: {} },
    ],
    http: [
      { name: 'Does it answer, and how fast?', why: 'Status, timing, size and the redirect chain', target: proxyNow() ? 'https://' + proxyNow() : 'https://example.com', opts: { method: 'GET' } },
      { name: 'Headers only', why: 'A HEAD request — caching, content type, redirects', target: 'https://example.com', opts: { method: 'HEAD' } },
    ],
    whois: [
      { name: 'Who owns this domain?', why: 'Registrar, dates and name servers', target: 'example.com', opts: {} },
      { name: 'Who owns this address?', why: 'The network it belongs to, and to whom', target: '8.8.8.8', opts: {} },
    ],
    teleport: [
      { name: 'What is this cluster running?', why: 'Version, edition, auth connector and every listener, without logging in', target: proxyNow() || 'teleport.example.com', opts: {} },
    ],
    local: [
      { name: 'This machine', why: 'Interfaces and resolvers, when the problem might be here', target: '', opts: {} },
    ],
  };

  TOOL_EXAMPLES.cidr = [
    { name: 'A /16 VPC', why: 'The usual AWS VPC size: 65,534 usable addresses', target: '10.0.0.0/16' },
    { name: 'A netmask, as ifconfig prints it', why: 'Dotted mask turned into a prefix', target: '192.168.1.0 255.255.255.0' },
    { name: 'Is this address allowed?', why: 'An allow-list entry and an address to test against it', target: '172.16.0.0/12', opts: { check: '172.31.4.20' } },
    { name: 'An IPv6 /64', why: 'One LAN\u2019s worth of IPv6', target: '2001:db8:1234::/64' },
  ];

  const examplesFor = (tool) => (tool === 'curl'
    ? CURL_EXAMPLES.map((x) => ({ name: x.name, why: x.why, curl: x }))
    : (TOOL_EXAMPLES[tool] || []));

  const loadExample = (x) => {
    if (x.curl) {
      const c = x.curl;
      swapPaste('curl');
      current = 'curl';
      toolSel.value = 'curl';
      targetIn.value = c.url;
      curlMethod.value = c.method;
      curlHeaders.value = c.headers || '';
      curlBody.value = c.body || '';
      curlType.value = c.contentType ?? '';
      curlBearer.value = c.bearer || '';
      if (c.timeout) curlTimeout.value = String(c.timeout);
      curlResolve.value = c.resolve || '';
      curlCaCert.value = c.caCert || '';
      curlClientCert.value = c.clientCert || '';
      curlClientKey.value = c.clientKey || '';
    } else {
      // A serial example is about the speed, not a host — leave the target
      // alone for the next tool rather than blanking it.
      if (current !== 'serial') targetIn.value = x.target || '';
      if (x.opts?.count) countIn.value = String(x.opts.count);
      if (x.opts?.ports !== undefined) portsIn.value = x.opts.ports;
      if (x.opts?.method) methodSel.value = x.opts.method;
      if (x.opts?.port) telnetPortIn.value = String(x.opts.port);
      if (x.opts?.baud) serialBaud.value = String(x.opts.baud);
      cidrCheckIn.value = x.opts?.check || '';
    }
    syncOptions();
    targetIn.disabled = !needsTarget();
    clear(body);
    body.append(el('div', { class: 'sb-empty' },
      el('div', { style: 'font-weight:600', text: x.name }),
      el('div', { style: 'margin-top:6px;opacity:.8', text: x.why }),
      el('div', { style: 'margin-top:6px;opacity:.7', text: 'Edit anything and press Run.' })));
    status(`Loaded: ${x.name}`);
  };

  const examplesBtn = el('button', {
    class: 'ghost-btn sm', text: 'Examples…',
    title: 'Typical things to run with this tool, filled in and ready to edit',
    onClick: (e) => {
      const list = examplesFor(current);
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 3, [
        { heading: true, label: `Typical ${labelFor(current)} calls` },
        ...(list.length
          ? list.map((x) => ({ label: x.name, title: x.why, onClick: () => loadExample(x) }))
          : [{ label: 'Nothing to suggest for this tool', disabled: true }]),
      ]);
    },
  });

  /* ---- saved requests ---- */
  const savedRow = el('div', { class: 'nt-saved-row' });
  const savedWrap = el('div', { class: 'nt-saved' },
    el('div', { class: 'nt-saved-head' },
      el('span', { text: 'Saved' }),
      el('span', { style: 'flex:1' }),
      el('button', {
        class: 'ghost-btn sm', text: 'Save this…',
        title: 'Keep this request, headers and body, to run again',
        onClick: () => saveCurrentRequest(),
      })),
    savedRow);

  const drawSaved = async () => {
    const list = await window.api.net.requests().catch(() => []);
    clear(savedRow);
    if (!list.length) {
      savedRow.append(el('span', { class: 'nt-opt-hint', text: 'Nothing saved yet — Examples… is a good place to start.' }));
      return;
    }
    for (const r of list) {
      const chip = el('span', {
        class: 'nt-chip',
        title: [`${r.opts?.method || 'GET'} ${r.target}`,
          r.on?.label ? `from ${r.on.label}` : 'from this machine'].join('\n'),
      },
        el('span', { class: 'm', text: (r.opts?.method || 'GET') }),
        el('span', { text: r.name }),
        r.on?.label ? el('span', { class: 'm', text: '@' + r.on.label.split(' ')[0] }) : null);
      chip.addEventListener('click', () => {
        targetIn.value = r.target;
        curlMethod.value = r.opts?.method || 'GET';
        curlHeaders.value = r.opts?.headers || '';
        curlBody.value = r.opts?.body || '';
        curlType.value = r.opts?.contentType ?? '';
        curlBearer.value = r.opts?.bearer || '';
        curlUser.value = r.opts?.basicUser || '';
        curlPass.value = r.opts?.basicPass || '';
        curlInsecure.input.checked = !!r.opts?.insecure;
        curlFollow.input.checked = r.opts?.followRedirects !== false;
        curlTimeout.value = String(r.opts?.timeout || 20);
        curlResolve.value = r.opts?.resolve || '';
        curlCaCert.value = r.opts?.caCert || '';
        curlClientCert.value = r.opts?.clientCert || '';
        curlClientKey.value = r.opts?.clientKey || '';
        savedId = r.id;
        /*
         * Put it back where it ran. If that host has no session open the
         * request still runs — from here — and says so, rather than refusing
         * over something the user can see for themselves.
         */
        applyHostRef(r.on);
        syncCurlPreview();
        runTool();
      });
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { heading: true, label: r.name },
          { label: 'Run it', onClick: () => chip.click() },
          {
            label: 'Rename…',
            onClick: async () => {
              const name = await prompt({ title: 'Rename request', label: 'Name', value: r.name, confirmLabel: 'Save' });
              if (!name) return;
              await window.api.net.requestSave({ ...r, name });
              drawSaved();
            },
          },
          {
            label: 'Copy as curl',
            onClick: async () => {
              const cmd = await window.api.net.curlCommand({ ...r.opts, url: r.target }).catch(() => null);
              if (!cmd) return;
              window.api.clipboard.write(cmd);
              status('Copied the curl command');
            },
          },
          { sep: true },
          {
            label: 'Delete',
            onClick: async () => {
              if (!await confirm({
                title: 'Delete request', message: `Delete \u201C${r.name}\u201D?`,
                confirmLabel: 'Delete', danger: true,
              })) return;
              await window.api.net.requestDelete(r.id);
              if (savedId === r.id) savedId = null;
              drawSaved();
            },
          },
        ]);
      });
      savedRow.append(chip);
    }
  };

  let savedId = preset?.id || null;

  const saveCurrentRequest = async () => {
    const target = targetIn.value.trim();
    if (!target) return toast('Give a URL first', 'error');
    const existing = savedId;
    const name = await prompt({
      title: existing ? 'Update saved request' : 'Save this request',
      label: 'Name',
      value: `${curlMethod.value} ${shortUrl(target)}`,
      confirmLabel: 'Save',
    });
    if (!name) return;
    const saved = await window.api.net.requestSave({
      id: existing || undefined,
      name,
      tool: 'curl',
      target,
      opts: curlOpts(),
      // Kept by host rather than by connection: an id does not survive the
      // day, and "that request, from that server" is the thing being saved.
      on: runOn ? hostRefFor(runOn) : null,
    });
    savedId = Array.isArray(saved) ? savedId : savedId;
    await drawSaved();
    status(`Saved \u201C${name}\u201D`);
  };

  /* ---- recent runs, for every tool ---- */
  const recentRow = el('div', { class: 'nt-saved-row' });
  const recentWrap = el('div', { class: 'nt-saved' },
    el('div', { class: 'nt-saved-head' },
      el('span', { text: 'Recent' }),
      el('span', { style: 'flex:1' }),
      el('button', {
        class: 'ghost-btn sm', text: 'Clear',
        onClick: async () => { await window.api.net.recentsClear(); drawRecents(); },
      })),
    recentRow);

  const drawRecents = async () => {
    const list = await window.api.net.recents().catch(() => []);
    clear(recentRow);
    recentWrap.classList.toggle('hidden', !list.length);
    for (const r of list) {
      const chip = el('span', {
        class: 'nt-chip' + (r.ok ? '' : ' bad'),
        title: [`${labelFor(r.tool)} ${r.target}`,
          r.on?.label ? `from ${r.on.label}` : 'from this machine',
          r.summary || '',
          new Date(r.at).toLocaleString()].filter(Boolean).join('\n'),
      },
        el('span', { class: 'm', text: labelFor(r.tool).split(' ')[0] }),
        el('span', { text: r.target || labelFor(r.tool) }),
        r.on?.label ? el('span', { class: 'm', text: '@' + r.on.label.split(' ')[0] }) : null);
      chip.addEventListener('click', () => {
        swapPaste(r.tool);
        current = r.tool;
        toolSel.value = r.tool;
        targetIn.value = r.target || '';
        applyHostRef(r.on);
        // A run's own options come back with it, so "again" means the same
        // call and not just the same URL.
        if (r.tool === 'curl' && r.opts) {
          curlMethod.value = r.opts.method || 'GET';
          curlHeaders.value = r.opts.headers || '';
          curlBody.value = r.opts.body || '';
          curlType.value = r.opts.contentType ?? '';
          curlBearer.value = r.opts.bearer || '';
          curlInsecure.input.checked = !!r.opts.insecure;
          curlFollow.input.checked = r.opts.followRedirects !== false;
          curlTimeout.value = String(r.opts.timeout || 20);
          curlResolve.value = r.opts.resolve || '';
          curlCaCert.value = r.opts.caCert || '';
          curlClientCert.value = r.opts.clientCert || '';
          curlClientKey.value = r.opts.clientKey || '';
        } else if (r.opts) {
          if (r.opts.count) countIn.value = String(r.opts.count);
          if (r.opts.ports) portsIn.value = r.opts.ports;
          if (r.opts.method) methodSel.value = r.opts.method;
          if (r.opts.port) telnetPortIn.value = String(r.opts.port);
        }
        syncOptions();
        targetIn.disabled = !needsTarget();
        runTool();
      });
      recentRow.append(chip);
    }
  };

  /*
   * Where the tool runs. "This machine" is the default and the old behaviour;
   * choosing a session runs the check from that host instead, which is the
   * question people actually have — *can that server reach this* — and cannot
   * be answered from a laptop.
   */
  let runOn = '';
  let caps = null;
  const runOnSel = select([{ value: '', label: 'This machine' }], '');
  const capsLine = el('div', { class: 'nt-caps' });

  const connectedSessions = () => [...state.connections.values()]
    .filter((c) => c.state === 'connected')
    .map((c) => ({ value: c.id, label: c.label }));

  const syncRunOnOptions = () => {
    const sessions = connectedSessions();
    const keep = runOn;
    clear(runOnSel);
    for (const o of [{ value: '', label: 'This machine' }, ...sessions]) {
      runOnSel.append(el('option', { value: o.value, text: o.label }));
    }
    runOnSel.value = sessions.some((x) => x.value === keep) ? keep : '';
    runOn = runOnSel.value;
    runOnSel.disabled = !sessions.length;
    runOnSel.title = sessions.length
      ? 'Run the check from here, or from one of the sessions that is open'
      : 'Open a session to run these from a host';
  };

  /** What the chosen host has, and what it would need. */
  const drawCaps = () => {
    clear(capsLine);
    capsLine.classList.toggle('hidden', !runOn);
    if (!runOn) return;
    if (!caps) { capsLine.append(el('span', { class: 'sub', text: 'Checking what that host has…' })); return; }

    const has = ['curl', 'dig', 'nc', 'openssl', 'python3', 'ping', 'mtr', 'traceroute', 'telnet']
      .filter((t) => caps.tools?.[t]);
    const missing = Object.keys(caps.hints || {});
    capsLine.append(
      el('span', { class: 'nt-badge', text: caps.os || caps.transport || 'host' }),
      el('span', { class: 'sub', text: caps.canProbeDirect
        ? 'reachability asked of the host itself (ssh -W), HTTP through a proxy over the session'
        : (caps.canForward
          // A tsh session: no ControlMaster for `ssh -W`, but a forward of
          // its own, so the HTTP request still goes out from the host.
          ? 'no shared connection for ssh -W, so the port check uses the host’s own '
            + 'tools; HTTP still goes through a proxy over the session'
          : 'this session cannot forward, so checks use what is installed there') }),
      // Ping and traceroute are the two that do need something installed, so
      // whether they are available is worth saying before a tool is picked.
      el('span', { class: 'sub', text: '· ' + ['ping', 'traceroute'].map((id) => {
        const missing = missingFor(TOOLS.find((t) => t.id === id), caps);
        return missing ? `no ${id}` : id;
      }).join(', ') }),
      has.length ? el('span', { class: 'sub', text: '· has ' + has.join(', ') }) : null,
      missing.length
        ? el('span', {
            class: 'sub',
            style: 'color:var(--amber)',
            title: missing.map((t) => `${t}: ${caps.hints[t]}`).join('\n'),
            text: '· missing ' + missing.join(', '),
          })
        : null,
      el('button', {
        class: 'ghost-btn sm', text: 'Re-check',
        title: 'Ask the host again — after installing something, say',
        onClick: async () => {
          caps = await window.api.net.hostTools(runOn, { refresh: true }).catch(() => null);
          drawCaps();
          syncOptions();
        },
      }));
  };

  /**
   * Point "Run on" back at a saved host.
   *
   * Only at a session that is actually open: dialling a server because a chip
   * was clicked would be a surprise, so a host that is not connected falls
   * back to this machine and says so.
   */
  const applyHostRef = (ref) => {
    if (!ref) { runOnSel.value = ''; runOn = ''; loadCaps(); return; }
    syncRunOnOptions();
    const conn = connForHostRef(ref);
    if (conn) {
      runOnSel.value = conn.id;
      runOn = conn.id;
      loadCaps();
      return;
    }
    runOnSel.value = '';
    runOn = '';
    loadCaps();
    status(`${ref.label} is not open — running from this machine instead`, 7000);
  };

  const loadCaps = async () => {
    caps = null;
    drawCaps();
    if (!runOn) { syncOptions(); return; }
    caps = await window.api.net.hostTools(runOn).catch((e) => ({ error: e.message, tools: {} }));
    drawCaps();
    syncOptions();
  };

  runOnSel.addEventListener('change', async () => {
    runOn = runOnSel.value;
    await loadCaps();
    clear(body);
    body.append(helpFor(current));
  });

  const optionsRow = el('div', { class: 'nt-options' });

  const syncOptions = () => {
    /*
     * A tool that cannot run on the chosen host is disabled with the reason on
     * it, rather than left selectable and then refused. Two different reasons:
     * the tool only works from here at all, or the host has not got what it
     * needs — the second is fixable, so it names the tool that is missing.
     */
    for (const opt of [...toolSel.options]) {
      const t = TOOLS.find((x) => x.id === opt.value);
      const missing = runOn ? missingFor(t, caps) : null;
      const blocked = !!runOn && (!t?.remote || !!missing);
      opt.disabled = blocked;
      opt.textContent = (t?.id === 'local' && runOn ? 'That host' : (t?.label || opt.value))
        + (!t?.remote && runOn ? '  — from this machine only' : '')
        + (missing ? `  — no ${missing} on that host` : '');
    }
    if (runOn && (!toolCanRunRemotely(current) || missingFor(TOOLS.find((x) => x.id === current), caps))) {
      swapPaste('ports');
      current = 'ports';
      toolSel.value = current;
    }

    clear(optionsRow);
    if (isPaste(current)) {
      pasteIn.placeholder = ({
        url: 'Text or a URL — it is shown both encoded and decoded',
        sshcert: 'ssh-ed25519-cert-v01@openssh.com AAAA… (a -cert.pub line)',
        jwt: 'eyJhbGciOi… (a "Bearer " in front is fine)',
        svid: '-----BEGIN CERTIFICATE-----\n… (a chain may follow the leaf)',
      })[current] || '';
      optionsRow.append(el('div', { class: 'nt-opt', style: 'flex:1 1 100%' },
        el('label', { text: current === 'url' ? 'Text' : 'Paste it here' }), pasteIn));
      optionsRow.append(bare(browseBtn));
      if (current === 'sshcert') { optionsRow.append(bare(certPick)); loadTshCerts(); }
      optionsRow.append(fileLine);
    } else if (current === 'cidr') optionsRow.append(smallField('Is this address in it?', cidrCheckIn));
    else if (current === 'ping') {
      optionsRow.append(smallField('Packets', countIn));
      // The host-side version of this check is a different implementation
      // entirely (see hostPing), which does not take this yet — so it is
      // only offered for a run from this machine, rather than shown and
      // silently ignored.
      if (!runOn) optionsRow.append(smallField('IP version', ipVersionSel));
    } else if (current === 'traceroute') {
      if (!runOn) optionsRow.append(smallField('IP version', ipVersionSel));
    } else if (current === 'ports') {
      optionsRow.append(smallField('Ports', portsIn, 'Blank uses the port in the target, else the usual SSH and Teleport ports'));
      if (!runOn) optionsRow.append(smallField('IP version', ipVersionSel));
    } else if (current === 'dns') {
      optionsRow.append(smallField('Via nameserver', dnsServerIn, 'Blank asks this machine’s own resolver'));
    } else if (current === 'tls') {
      optionsRow.append(smallField('Protocol', starttlsSel, 'For a plaintext port that upgrades itself — SMTP, IMAP or POP3'));
    } else if (current === 'http') {
      optionsRow.append(smallField('Method', methodSel));
      optionsRow.append(el('div', { class: 'field', style: 'flex:1 1 100%' },
        el('label', { text: 'Headers (one per line)' }), httpHeadersIn));
      optionsRow.append(httpInsecureIn);
    }
    else if (current === 'telnet') {
      optionsRow.append(smallField('Port', telnetPortIn, 'A port in the target wins over this one'));
      /*
       * What Return sends and local echo belong to the app's own telnet
       * client. From a host it is that host's `telnet` doing the talking, and
       * offering settings it will not read would be decoration.
       */
      if (!runOn) {
        optionsRow.append(smallField('Enter sends', telnetNewline), bare(telnetEcho));
      }
      const noTelnet = !!runOn && !!caps && !caps.tools?.telnet;
      telnetOpenBtn.disabled = noTelnet;
      telnetOpenBtn.textContent = runOn ? 'Open session there' : 'Open session';
      telnetOpenBtn.title = noTelnet
        ? 'That host has no telnet client — install the telnet package there, or run this from this machine'
        : (runOn
          ? 'Open a terminal on that host running telnet to the target'
          : 'Open a telnet session to the target in a tab of its own');
      optionsRow.append(bare(telnetOpenBtn));
    } else if (current === 'serial') {
      optionsRow.append(
        smallField('Port', serialPathIn),
        smallField('Speed', serialBaud),
        smallField('Data bits', serialDataBits),
        smallField('Parity', serialParity),
        smallField('Stop bits', serialStopBits),
        smallField('Flow control', serialFlow),
        smallField('Enter sends', serialNewline),
        bare(serialEcho),
        bare(serialOpenBtn));
    }
    curlBlock.classList.toggle('hidden', current !== 'curl');
    savedWrap.classList.toggle('hidden', current !== 'curl');
    /*
     * Both preview nodes are persistent — reused across every tool switch
     * rather than rebuilt — so whichever one last had a command keeps its
     * `.textContent` even once hidden, and "Copy command" reads straight off
     * that property regardless of what is actually on screen. Without an
     * explicit clear here, switching to a decoder (or anything else with no
     * command of its own) would still copy whatever the last previewable
     * tool's was: not a display bug, a silently wrong answer.
     */
    if (current === 'curl') {
      syncCurlPreview();
    } else {
      curlPreview.textContent = '';
    }
    /*
     * Not when running from a host: the command this would build is the
     * local equivalent, and showing it while the real run goes over an SSH
     * session to somewhere else — same reasoning as curl's own preview,
     * which skips it for the same case — would be a command that is not
     * what is actually about to happen.
     */
    if (PREVIEWABLE_TOOLS.includes(current) && !runOn) {
      optionsRow.append(cmdPreviewBlock);
      syncGenericPreview();
    } else {
      cmdPreview.textContent = '';
      cmdPreviewNote.textContent = '';
      cmdPreviewNote.hidden = true;
    }
  };

  // A serial port is a path on this machine, not somewhere on the network.
  const needsTarget = () => !['local', 'serial', 'sockets'].includes(current) && !isPaste(current);

  const runTool = async () => {
    if (running) return;
    const target = targetIn.value.trim();
    if (needsTarget() && !target) return toast(current === 'cidr' ? 'Give a subnet' : 'Give a host', 'error');
    if (isPaste(current) && !pasteIn.value.trim()) return toast('Paste something to decode', 'error');

    running = true;
    clear(body);
    body.append(el('div', { class: 'sb-empty', text: `Running ${labelFor(current)}…` }));
    status(`${labelFor(current)} ${target}…`, 0);

    let ok = true;
    let summary = '';
    try {
      const { node, raw, text, note, command } = await dispatch(current, target, {
        count: countIn.value,
        ports: portsIn.value.trim(),
        method: methodSel.value,
        curl: current === 'curl' ? curlOpts() : null,
        // Empty runs it here; a connection id runs it on that host.
        on: runOn,
        onLabel: runOn ? (state.getConnection(runOn)?.label || 'that host') : '',
        telnetPort: telnetPortIn.value,
        ipVersion: ipVersionSel.value,
        server: dnsServerIn.value.trim(),
        starttls: starttlsSel.value,
        headers: httpHeadersIn.value,
        insecure: httpInsecureIn.input.checked,
        // The two tools that end in a session hand the result a way to open one.
        openTelnet: () => openTelnet(),
        openSerial: (p) => openSerial(p),
        saveSerial: (p) => saveSerial(p),
        pickSerial: (p) => { serialPathIn.value = p; },
        hasTelnet: !runOn || !caps || !!caps.tools?.telnet,
        input: pasteIn.value,
        file: pasteFile,
        check: cidrCheckIn.value.trim(),
      });
      clear(body);
      body.append(raw ? withRawToggle(node, raw) : node);
      lastText = text || body.innerText.trim();
      summary = note || '';
      lastRunCommand = command || '';
      lastRunCommandTool = current;
    } catch (e) {
      ok = false;
      summary = e.message;
      clear(body);
      body.append(el('div', { class: 'sb-empty', style: 'color:var(--red)', text: e.message }));
      lastText = e.message;
      lastRunCommand = '';
      lastRunCommandTool = '';
    } finally {
      running = false;
      status('');
      // Remembered whatever the outcome: a run that failed is one of the ones
      // most worth repeating after a change. Not the serial list, though —
      // "looked at which cables are plugged in" is not a run worth repeating
      // from a chip, and it would push out ones that are.
      if (current !== 'serial' && !isPaste(current)) window.api.net.recentAdd({
        tool: current,
        target,
        opts: current === 'curl'
          ? curlOpts()
          : { count: countIn.value, ports: portsIn.value.trim(), method: methodSel.value, port: telnetPortIn.value },
        // Where it ran, by host rather than by connection id: an id is gone
        // by tomorrow, and "that check, from that server" is the thing worth
        // repeating.
        on: runOn ? hostRefFor(runOn) : null,
        ok,
        summary,
      }).then(() => drawRecents()).catch(() => {});
      if (current === 'curl' && savedId) {
        window.api.net.requestSave({
          id: savedId, name: undefined, tool: 'curl', target, opts: curlOpts(), lastRunAt: Date.now(),
        }).catch(() => {});
      }
    }
  };

  toolSel.addEventListener('change', () => {
    swapPaste(toolSel.value);
    current = toolSel.value;
    syncOptions();
    clear(body);
    body.append(helpFor(current));
    targetIn.disabled = !needsTarget();
  });
  for (const f of [curlMethod, curlHeaders, curlBody, curlType, curlBearer, curlUser, curlTimeout, targetIn,
    curlResolve, curlCaCert, curlClientCert, curlClientKey]) {
    f.addEventListener('input', () => syncCurlPreview());
  }
  // The generic preview reads from the same target box, plus whichever of
  // these a tool happens to show in `optionsRow` — harmless to listen on
  // all of them even when the current tool's own options hide one.
  for (const f of [targetIn, portsIn, countIn, telnetPortIn, dnsServerIn, httpHeadersIn]) {
    f.addEventListener('input', () => syncGenericPreview());
  }
  methodSel.addEventListener('change', () => syncGenericPreview());
  for (const s of [ipVersionSel, starttlsSel]) s.addEventListener('change', () => syncGenericPreview());
  httpInsecureIn.input.addEventListener('change', () => syncGenericPreview());
  curlMethod.addEventListener('change', () => syncCurlPreview());
  curlType.addEventListener('change', () => syncCurlPreview());
  for (const c of [curlInsecure, curlFollow]) c.input.addEventListener('change', () => syncCurlPreview());
  targetIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runTool(); } });

  await modal({
    title: 'Network and certificate tools',
    width: 'min(780px, 95vw)',
    // Lived in while debugging, and the useful size depends on what is being
    // read — a traceroute is tall, a response body is wide.
    resize: 'nettools',
    render: (b, { close } = {}) => {
      closeWindow = close;
      b.append(
        el('div', { class: 'nt-head' },
          el('div', { class: 'nt-target' },
            el('label', { text: 'Target' }),
            targetIn),
          el('div', { class: 'nt-tool' },
            el('label', { text: 'Tool' }),
            toolSel),
          el('div', { class: 'nt-tool' },
            el('label', { text: 'Run on' }),
            runOnSel)),
        capsLine,
        optionsRow,
        curlBlock,
        el('div', { class: 'nt-strips' }, recentWrap, savedWrap),
        el('div', { class: 'nt-body' }));
      body = b.querySelector('.nt-body');
      syncRunOnOptions();
      // Opened from a session's own header: start pointed at that host.
      if (runOnWanted) {
        const match = [...runOnSel.options].find((o) => o.value === runOnWanted);
        if (match) { runOnSel.value = runOnWanted; runOn = runOnWanted; }
      }
      loadCaps();
      syncOptions();
      targetIn.disabled = !needsTarget();
      body.append(helpFor(current));
      drawRecents();
      drawSaved();
      setTimeout(() => targetIn.focus(), 0);
      // Opened against a specific host — the caller already said what to ask.
      if (host) runTool();
      // Opened from a selection to decode: the same.
      else if (input && isPaste(current)) runTool();
    },
    buttons: [
      { label: 'Close', value: null },
      {
        label: 'Copy command',
        title: 'Copy the command this would run, or just ran, locally — without ServerLife touching the target at all',
        onClick: () => {
          // Three sources, in priority order: curl's own live preview, the
          // generic live preview for anything else previewable, and —
          // for a decoder or "This machine", which have no live preview at
          // all — whatever the last actual run produced, but only if that
          // run was *for the tool currently selected*.
          const text = current === 'curl' ? curlPreview.textContent.trim()
            : PREVIEWABLE_TOOLS.includes(current) && !runOn ? cmdPreview.textContent.trim()
              : current === lastRunCommandTool ? lastRunCommand.trim()
                : '';
          if (!text) return status('Nothing to run locally for this tool');
          window.api.clipboard.write(text);
          status('Command copied');
        },
      },
      {
        label: 'Copy output',
        onClick: () => {
          const text = body?.innerText?.trim();
          if (!text) return status('Nothing to copy');
          window.api.clipboard.write(text);
          status('Output copied');
        },
      },
      {
        label: 'Examples…',
        title: 'Typical things to run with the selected tool',
        onClick: () => examplesBtn.click(),
      },
      {
        label: 'Save output…',
        onClick: async () => {
          const text = lastText || body?.innerText?.trim();
          if (!text) return status('Nothing to save yet');
          try {
            const r = await window.api.dialog.saveText({
              text, title: 'Save output', defaultPath: undefined,
            });
            if (r) { status(`Saved to ${r.path}`); toast('Output saved', 'success'); }
          } catch (e) { toast(e.message, 'error'); }
        },
      },
      { label: 'Run', class: 'primary-btn', onClick: () => runTool() },
    ],
  });
}

function labelFor(id) { return TOOLS.find((t) => t.id === id)?.label || id; }

/**
 * The help panel a tool opens with: what it tells you, and the two or three
 * things people typically run it for.
 */
function helpFor(id) {
  const typical = ({
    ping: [
      'Five packets at a host, to see loss and round-trip time',
      'Twenty at one that drops out, to catch loss that comes and goes',
      'The default gateway, to rule out the local network first',
      'Forced onto IPv6, when a dual-stack host is flaky over one family',
    ],
    traceroute: [
      'Find the hop where a route stops — usually the answer',
      'Compare the path to a known-good address like 1.1.1.1',
    ],
    dns: [
      'Everything a name resolves to, in one pass',
      'A PTR for an address, to see which name claims it',
      'An SRV record, for how clients discover a service',
      'Against 1.1.1.1 directly, to tell propagation from a stale local resolver',
    ],
    ports: [
      'The Teleport set — 443, 3023, 3024, 3025, 3080',
      'Just 22, when ssh hangs rather than refuses',
      'The local end of a port forward, to prove the tunnel is up',
    ],
    sockets: [
      'What is actually bound to a port, and by which process',
      'Confirming a service you just started is really listening',
      'Spotting a port already taken before your own process fails to bind it',
    ],
    telnet: [
      'A switch, PDU or terminal server that only answers on 23',
      'What a port says when it is connected to — SSH, SMTP and friends name themselves',
      'Which address a name resolves to today, the way telnet always told you',
    ],
    serial: [
      'Which USB serial adapters this machine can see right now',
      'A console at 115200 8N1 — or 9600, for older network gear',
      'Keep one you go back to as a saved connection',
    ],
    tls: [
      'How many days are left on a certificate',
      'Which names it actually covers (its SANs)',
      'What a non-standard port is presenting',
      'A mail server on 587/143/110, with STARTTLS asked for first',
    ],
    http: [
      'Whether a URL answers, and how quickly',
      'Where a redirect chain ends up',
      'Headers only, with a HEAD request',
      'For a method beyond GET/HEAD, a body, or bearer/basic auth — HTTP request (curl) below does those',
    ],
    curl: [
      'GET a JSON API and read it back formatted',
      'POST a JSON body, with a bearer token if it needs one',
      'Fire a webhook, and keep the call to fire again later',
      'For per-hop timing across a redirect chain, the plain HTTP check above shows that; this does not',
    ],
    whois: [
      'Who a domain belongs to, and when it expires',
      'Which network an address belongs to',
    ],
    teleport: [
      'A cluster\u2019s version and edition, without logging in',
      'Which auth connector is in play, and whether it is passwordless',
      'Every listener, including Kubernetes and database addresses',
    ],
    local: [
      'This machine\u2019s addresses, when the problem may be here',
      'Which resolvers it is using',
    ],
    cidr: [
      'The usable range of a VPC or security-group rule',
      'Whether an address falls inside an allow-list entry',
      'A netmask turned into a prefix: 10.0.0.0 255.255.240.0',
    ],
    url: [
      'Read an encoded redirect or callback URL',
      'Encode a value before putting it in a query string',
    ],
    sshcert: [
      'Which principals (logins) your Teleport certificate allows',
      'When it expires, and which roles it carries',
      'Which CA signed it — to match against TrustedUserCAKeys',
    ],
    jwt: [
      'The claims in a Teleport application token',
      'Whether a token has expired, and when it was issued',
      'The subject of a JWT-SVID',
    ],
    svid: [
      'The SPIFFE ID a workload was issued',
      'Whether the SVID keeps the SPIFFE rules',
      'When it expires, and whether the chain pasted with it lines up',
    ],
  })[id] || [];

  const wrap = el('div', { class: 'sb-empty', style: 'text-align:left' });
  wrap.append(el('div', { style: 'opacity:.9', text: hintFor(id) }));
  if (typical.length) {
    wrap.append(el('div', {
      style: 'margin-top:9px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.55',
      text: 'Typical things to run',
    }));
    const ul = el('ul', { style: 'margin:5px 0 0;padding-left:16px;opacity:.8;line-height:1.6' });
    for (const t of typical) ul.append(el('li', { text: t }));
    wrap.append(ul);
  }
  wrap.append(el('div', { style: 'margin-top:9px;opacity:.7' },
    'Examples\u2026 fills any of these in for you.'));
  return wrap;
}

function hintFor(id) {
  return ({
    ping: 'Round-trip time and packet loss.',
    traceroute: 'The path packets take, hop by hop.',
    dns: 'A, AAAA, CNAME, MX, TXT, NS and SRV records, plus PTR for an address.',
    ports: 'Whether a TCP port accepts a connection. A target written host:port checks that port.',
    sockets: 'Every listening and connected socket, with its process — ss/netstat/lsof -i, read and laid out.',
    telnet: 'Run connects and listens for a few seconds — what answered, and what it said. '
      + 'Open session starts a real telnet session; from a host, that host’s own telnet in a terminal there.',
    serial: 'The serial ports on this machine — USB adapters, console cables. Run lists them; '
      + 'open one at the settings above. Hardware flow control on a cable with no CTS wire looks '
      + 'exactly like a dead port, so leave it off unless the device asks for it.',
    tls: 'The certificate a server presents, valid or not.',
    http: 'Status, headers, timing and the redirect chain.',
    curl: 'A full HTTP request through curl itself — method, headers, body, auth — with the command shown as it will run.',
    whois: 'Registration for a domain or address.',
    teleport: 'A proxy’s /webapi/ping — version, edition, auth and listeners. No login needed.',
    local: 'Interfaces and resolvers on this machine.',
    cidr: 'Network, mask, usable range and size of a subnet — IPv4 or IPv6. Worked out here; nothing is sent.',
    url: 'Text encoded and decoded both ways, and a URL taken apart with its query decoded.',
    sshcert: 'An OpenSSH certificate as ssh-keygen -L shows it — principals, validity, extensions and the signing CA. '
      + 'Decoded here; the signature is not checked against a CA.',
    jwt: 'A JWT\u2019s header and claims, with its times in words. The signature is not verified — that needs the issuer\u2019s key.',
    svid: 'An X.509-SVID: its SPIFFE ID, validity and issuer, checked against the SPIFFE rules, and any chain pasted after it.',
  })[id] || 'Press Run.';
}

/** Default to a logged-in proxy, since that is usually what is being debugged. */
function suggestTarget() {
  const p = state.teleportProfiles?.find((x) => !x.expired) || state.teleportProfiles?.[0];
  return p?.proxy || '';
}

/** A control with no label of its own, sat on the same baseline as the fields beside it. */
function bare(node) {
  return el('div', { class: 'nt-opt', style: 'justify-content:flex-end' }, node);
}

function smallField(label, input, hint) {
  return el('div', { class: 'nt-opt' },
    el('label', { text: label }),
    input,
    hint ? el('span', { class: 'nt-opt-hint', text: hint }) : null);
}

/**
 * Run one tool and hand back what to show, what to save, and one line for the
 * recent list — the three things every tool has to produce.
 */
async function dispatch(tool, target, opts) {
  const plain = (r, name) => ({ node: renderText(r), text: r.text || '', name, note: firstLine(r.text) });

  /*
   * Run on a host rather than here. Only the tools that can be: the list
   * disables the others, so arriving here with one of them means something is
   * out of step.
   */
  if (opts.on) {
    switch (tool) {
      case 'ping': {
        const r = await window.api.net.hostPing(opts.on, { host: target, count: opts.count });
        return {
          node: renderRemoteText(r, opts.onLabel),
          text: r.text || '',
          name: `ping-from-${safeName(opts.onLabel)}-to-${safeName(target)}.txt`,
          note: pingNote(r) || `from ${opts.onLabel}`,
        };
      }
      case 'traceroute': {
        const r = await window.api.net.hostTrace(opts.on, { host: target });
        return {
          node: renderRemoteText(r, opts.onLabel),
          text: r.text || '',
          name: `traceroute-from-${safeName(opts.onLabel)}-to-${safeName(target)}.txt`,
          note: r.missing ? `no traceroute on ${opts.onLabel}` : `${r.tool} · from ${opts.onLabel}`,
        };
      }
      case 'ports': {
        const r = await window.api.net.hostPorts(opts.on, { host: target, ports: opts.ports });
        const open = r.results.filter((x) => x.open).length;
        return {
          node: renderRemotePorts(r, opts.onLabel),
          text: JSON.stringify(r, null, 2),
          name: `ports-from-${safeName(opts.onLabel)}-to-${safeName(target)}.json`,
          note: `${open} of ${r.results.length} open from ${opts.onLabel}`,
        };
      }
      case 'telnet': {
        /*
         * From a host, the question splits in two. "Is anything listening" is
         * the port check, asked of the host exactly as that tool asks it; the
         * conversation itself is the host's own telnet, in a terminal there,
         * which is what the button in the result opens.
         */
        const t = telnetTarget(target, opts.telnetPort);
        const r = await window.api.net.hostPorts(opts.on, { host: t.host, ports: String(t.port) });
        const p = r.results[0] || {};
        return {
          node: renderRemoteTelnet(r, t, opts),
          text: JSON.stringify(r, null, 2),
          name: `telnet-from-${safeName(opts.onLabel)}-to-${safeName(t.host)}-${t.port}.json`,
          note: `${portState(p).label} from ${opts.onLabel}`,
        };
      }
      case 'curl': {
        const r = await window.api.net.hostCurl(opts.on, opts.curl);
        return {
          node: renderCurl(r, { from: opts.onLabel }),
          text: r.body || '',
          name: `response-from-${safeName(opts.onLabel)}${bodyExt(r.contentType)}`,
          note: `${r.status} ${r.statusText} · ${fmtBytes(r.bytes)} · ${fmtDuration(r.ms)} · from ${opts.onLabel}`,
        };
      }
      case 'local': {
        const f = await window.api.net.hostFacts(opts.on);
        return {
          node: renderHostFacts(f, opts.onLabel),
          text: [f.hostname, '', f.addresses, '', f.routes, '', f.resolvers].join('\n'),
          name: `${safeName(opts.onLabel)}-network.txt`,
          note: f.hostname,
        };
      }
      case 'sockets': {
        const r = await window.api.net.hostSockets(opts.on);
        return {
          node: renderSockets(r, opts.onLabel),
          raw: r.text || '',
          text: r.text || '',
          name: `sockets-${safeName(opts.onLabel)}.txt`,
          note: r.missing ? `no ${r.missing} on ${opts.onLabel}` : `${r.rows.length} socket${r.rows.length === 1 ? '' : 's'} on ${opts.onLabel}`,
        };
      }
      default:
        throw new Error(`${labelFor(tool)} runs from this machine only for now.`);
    }
  }

  switch (tool) {
    case 'ping': {
      const r = await window.api.net.ping({ host: target, count: opts.count, ipVersion: opts.ipVersion });
      return plain(r, `ping-${safeName(target)}.txt`);
    }
    case 'traceroute': {
      const r = await window.api.net.traceroute({ host: target, ipVersion: opts.ipVersion });
      return plain(r, `traceroute-${safeName(target)}.txt`);
    }
    case 'dns': {
      const r = await window.api.net.lookup({ host: target, server: opts.server || undefined });
      return { node: renderDns(r), text: JSON.stringify(r, null, 2), name: `dns-${safeName(target)}.json`,
        note: Object.keys(r.records || {}).filter((k) => (r.records[k] || []).length).join(', ') };
    }
    case 'ports': {
      const r = await window.api.net.portCheck({ host: target, ports: opts.ports, ipVersion: opts.ipVersion });
      const open = (r.results || []).filter((x) => x.open).map((x) => x.port);
      return { node: renderPorts(r), text: JSON.stringify(r, null, 2), name: `ports-${safeName(target)}.json`,
        note: open.length ? `open: ${open.join(', ')}` : 'nothing open' };
    }
    case 'telnet': {
      const t = telnetTarget(target, opts.telnetPort);
      const r = await window.api.net.telnetProbe({ host: t.host, port: t.port });
      return {
        node: renderTelnet(r, opts),
        text: r.text || '',
        name: `telnet-${safeName(t.host)}-${t.port}.txt`,
        note: r.state === 'open'
          ? (r.guess || (r.text ? firstLine(r.text).slice(0, 80) : 'open, said nothing'))
          : portState({ state: r.state }).label,
      };
    }
    case 'serial': {
      const ports = await window.api.device.ports();
      return {
        node: renderSerialPorts(ports, opts),
        text: ports.map((p) => [p.path, p.label].filter(Boolean).join('  ')).join('\n'),
        name: 'serial-ports.txt',
        note: `${ports.length} port${ports.length === 1 ? '' : 's'}`,
      };
    }
    case 'tls': {
      const r = await window.api.net.tlsInfo({ host: target, starttls: opts.starttls || undefined });
      return { node: renderTls(r), text: JSON.stringify(r, null, 2), name: `tls-${safeName(target)}.json`,
        note: r.subject?.CN ? `${r.subject.CN}, ${r.daysLeft} days left` : '' };
    }
    case 'http': {
      const r = await window.api.net.httpCheck({ url: target, method: opts.method, headers: opts.headers, insecure: opts.insecure });
      return { node: renderHttp(r), text: JSON.stringify(r, null, 2), name: `http-${safeName(target)}.json`,
        note: `${r.status || ''} ${r.statusText || ''}`.trim() };
    }
    case 'curl': {
      const r = await window.api.net.curl(opts.curl);
      return {
        node: renderCurl(r),
        // The body is what anyone wants on disk; the rest is on screen.
        text: r.body || '',
        name: `response-${safeName(target)}${bodyExt(r.contentType)}`,
        note: `${r.status} ${r.statusText} · ${fmtBytes(r.bytes)} · ${fmtDuration(r.ms)}`,
      };
    }
    case 'whois': {
      const r = await window.api.net.whois({ host: target });
      return plain(r, `whois-${safeName(target)}.txt`);
    }
    case 'teleport': {
      const r = await window.api.teleport.webapiPing({ proxy: target });
      return { node: renderTeleportPing(r), text: JSON.stringify(r, null, 2), name: `webapi-ping-${safeName(target)}.json`,
        note: r.server_version ? `v${r.server_version}` : '' };
    }
    case 'cidr': {
      const r = await window.api.decode.run({ kind: 'cidr', input: target, opts: { check: opts.check || undefined } });
      return { node: renderCidr(r), raw: rawFor('cidr', r), text: JSON.stringify(r, null, 2), name: `subnet-${safeName(r.cidr)}.json`,
        note: `${r.cidr} · ${r.usable} usable${r.check ? ` · ${r.check.address} ${r.check.inside ? 'inside' : 'outside'}` : ''}` };
    }
    case 'url': {
      const r = await window.api.decode.run({ kind: 'url', input: opts.input });
      return { node: withFile(renderUrl(r), opts.file), raw: rawFor('url', r), text: r.decoded ?? r.encoded, name: 'url.txt', note: '' };
    }
    case 'sshcert': {
      const r = await window.api.decode.run({ kind: 'sshcert', input: opts.input });
      // Where it came from when that is known; otherwise matched on the key
      // data, so a pasted copy of one of tsh's own files finds it too — even
      // one that wrapped in a terminal or picked up a comment on the way.
      let file = opts.file;
      if (!file) {
        const certs = await window.api.decode.tshCerts().catch(() => []);
        file = certs.find((c) => sameCert(opts.input, c.text))?.file;
      }
      return {
        node: renderSshCert(r, file), raw: rawFor('sshcert', r), text: r.raw,
        name: `ssh-cert-${safeName(r.keyId)}.txt`, note: '',
        ...sshCertCommand(file),
      };
    }
    case 'jwt': {
      const r = await window.api.decode.run({ kind: 'jwt', input: opts.input });
      return {
        node: withFile(renderJwt(r), opts.file), raw: rawFor('jwt', r),
        text: JSON.stringify({ header: r.header, payload: r.payload }, null, 2), name: 'jwt.json', note: '',
        ...jwtCommand(r),
      };
    }
    case 'svid': {
      const r = await window.api.decode.run({ kind: 'svid', input: opts.input });
      return {
        node: withFile(renderSvid(r), opts.file), raw: rawFor('svid', r), text: rawFor('svid', r),
        name: 'svid.txt', note: '',
        ...svidCommand(r),
      };
    }
    case 'local': {
      const r = await window.api.net.localInfo();
      return {
        node: renderLocal(r), text: JSON.stringify(r, null, 2), name: 'this-machine.json', note: r.hostname,
        ...localMachineCommand(),
      };
    }
    case 'sockets': {
      const r = await window.api.net.sockets();
      return {
        node: renderSockets(r),
        raw: r.text || '',
        text: r.text || '',
        name: 'sockets.txt',
        note: r.missing ? `${r.missing} is not installed` : `${r.rows.length} socket${r.rows.length === 1 ? '' : 's'}`,
        command: r.command,
      };
    }
    default: throw new Error('Unknown tool');
  }
}

function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
}

function safeName(s) {
  return String(s || 'output').replace(/^[a-z]+:\/\//i, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'output';
}

function shortUrl(u) {
  try { const p = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u); return p.host + p.pathname.replace(/\/$/, ''); }
  catch { return u; }
}

function bodyExt(type) {
  const t = String(type || '');
  if (/json/.test(t)) return '.json';
  if (/html/.test(t)) return '.html';
  if (/xml/.test(t)) return '.xml';
  if (/csv/.test(t)) return '.csv';
  return '.txt';
}

/* ------------------------------------------------------------------ */
/* Renderers                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Telnet and serial                                                   */
/* ------------------------------------------------------------------ */

/** What Return sends — the same three choices a saved console offers. */
function newlineSelect(initial) {
  return select([
    { value: 'cr', label: 'CR — most network gear' },
    { value: 'lf', label: 'LF — most Unix consoles' },
    { value: 'crlf', label: 'CRLF — telnet default' },
  ], initial);
}

/**
 * The target, as telnet wants it: a host and a port.
 *
 * Takes what the shared target field holds — a bare name, `host:port`,
 * `telnet://host:23`, even a URL left over from the last tool — and keeps
 * only the address. Validated as tightly as the main process validates,
 * because from a host this ends up on a command line.
 */
export function telnetTarget(value, portField) {
  let v = String(value || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
  v = v.replace(/^[^@]*@/, '');
  let host = v;
  let port = null;
  const bracket = v.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) { host = bracket[1]; port = bracket[2] ? Number(bracket[2]) : null; }
  else if ((v.match(/:/g) || []).length === 1) {
    const [h, p] = v.split(':');
    host = h;
    port = p ? Number(p) : null;
  }
  if (!host) throw new Error('Give a host');
  if (!/^[A-Za-z0-9._:-]+$/.test(host) || host.length > 253) {
    throw new Error('Host names may only contain letters, digits, dot, dash, underscore and colon.');
  }
  const n = port || Number(portField) || 23;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Ports run from 1 to 65535.');
  return { host, port: n };
}

/**
 * What a port said when connected to, as telnet would have shown it.
 *
 * The verdict first, in the port check's words so the two read alike; then
 * what answered, if it said; then the words themselves. Silence is reported
 * as silence with the likeliest reason, because "connected, and nothing" is
 * the answer that most often gets mistaken for a fault.
 */
function renderTelnet(r, opts) {
  const s = portState({ state: r.state });
  const wrap = el('div', {});
  wrap.append(commandBlock(r.command, r.commandNote));
  wrap.append(el('div', { class: 'nt-cmd', text: [
    r.address && r.address !== r.host ? `→ ${r.address}` : '',
    r.connectMs !== null ? `connected in ${r.connectMs}ms` : '',
  ].filter(Boolean).join('  ·  ') }));

  wrap.append(el('div', { class: 'nt-badges' },
    badge(s.label, r.state === 'open' ? 'ok' : 'warn'),
    r.telnet ? badge('speaks telnet', 'ok') : null,
    r.guess && !r.telnet ? badge(r.guess, 'name') : null,
    r.closedByPeer && r.state === 'open' ? badge('closed by the far end', 'warn') : null));

  if (r.state !== 'open') {
    wrap.append(el('div', { class: 'sb-empty', style: 'text-align:left' },
      el('div', { text: r.error || s.why }),
      el('div', { style: 'margin-top:6px;opacity:.75', text: s.why })));
    return wrap;
  }

  wrap.append(el('div', { class: 'nt-sub', text: 'What it said' }));
  if (r.text) {
    wrap.append(el('pre', { class: 'nt-pre', text: r.text }));
  } else {
    wrap.append(el('div', { class: 'hint', text:
      `Nothing, in ${Math.round((r.listenedMs || 0) / 100) / 10}s. That is normal for a service that waits `
      + 'to be spoken to — HTTP, TLS and most databases do — and is still a yes: something accepted the connection.' }));
  }

  wrap.append(el('div', { style: 'margin-top:10px;display:flex;gap:6px;flex-wrap:wrap' },
    el('button', { class: 'ghost-btn sm', text: 'Open a telnet session', onClick: () => opts.openTelnet() })));
  return wrap;
}

/**
 * The same question asked from a host: the verdict is the port check's, the
 * session is that host's telnet. What it said only comes back when the check
 * went through `ssh -W`, which is the one route that hears anything.
 */
function renderRemoteTelnet(r, t, opts) {
  const p = r.results[0] || {};
  const s = portState(p);
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'nt-cmd', text: `${opts.onLabel} → ${t.host}:${t.port}`
    + (r.how ? `  ·  asked with ${r.how}` : '') }));
  wrap.append(el('div', { class: 'nt-badges' },
    badge(s.label, p.open === true ? 'ok' : 'warn'),
    p.ms !== undefined ? badge(`${p.ms}ms`) : null));
  wrap.append(el('div', { class: 'hint', text: p.error && p.open !== true ? p.error : s.why }));
  if (p.banner) {
    wrap.append(el('div', { class: 'nt-sub', text: 'What it said' }));
    wrap.append(el('pre', { class: 'nt-pre', text: p.banner }));
  }
  wrap.append(el('div', { style: 'margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center' },
    el('button', {
      class: 'ghost-btn sm', text: `Open telnet on ${opts.onLabel}`,
      disabled: !opts.hasTelnet,
      onClick: () => opts.openTelnet(),
    }),
    opts.hasTelnet ? null : el('span', { class: 'nt-opt-hint', style: 'color:var(--amber)',
      text: 'That host has no telnet client — install the telnet package there, or run this from this machine.' })));
  return wrap;
}

/**
 * The serial ports this machine can see, each with a way in.
 *
 * Listed fresh on every run, because the list is the thing that changes —
 * an adapter plugged in a moment ago is the one wanted. An empty list says
 * what usually explains it, since "no ports" is more often a missing driver
 * than a missing cable.
 */
function renderSerialPorts(ports, opts) {
  const wrap = el('div', {});
  if (!ports.length) {
    wrap.append(el('div', { class: 'sb-empty', style: 'text-align:left' },
      el('div', { text: 'No serial ports on this machine right now.' }),
      el('div', { style: 'margin-top:6px;opacity:.75', text:
        'Plug the adapter in and press Run again. If it still does not appear, it usually wants a driver '
        + '(CP210x, FTDI or Prolific, depending on the chip) — or, on Linux, a udev rule. A path typed into '
        + 'Port above can be opened whether or not it is listed.' })));
    return wrap;
  }
  const rows = el('div', { class: 'nt-rows' });
  for (const p of ports) {
    rows.append(el('div', { class: 'nt-row', style: 'gap:8px;align-items:center;padding:3px 0;margin-bottom:2px' },
      el('span', { class: 'nt-mono', style: 'font-weight:600', text: p.path }),
      el('span', { class: 'nt-meta', style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
        title: [p.label, p.serialNumber && `serial ${p.serialNumber}`,
          p.vendorId && `${p.vendorId}:${p.productId}`].filter(Boolean).join('\n'),
        text: p.label || '' }),
      el('button', { class: 'ghost-btn sm', text: 'Use', title: 'Put this port in the Port field',
        onClick: () => { opts.pickSerial(p.path); status(`Port: ${p.path}`); } }),
      el('button', { class: 'ghost-btn sm', text: 'Save…', title: 'Keep it as a saved serial connection, at these settings',
        onClick: () => opts.saveSerial(p.path) }),
      el('button', { class: 'ghost-btn sm', text: 'Open console', title: 'Open a serial console on it, at the settings above',
        onClick: () => opts.openSerial(p.path) })));
  }
  wrap.append(rows);
  return wrap;
}

/**
 * A response: what came back, then the headers, then the body.
 *
 * The body is pretty-printed when it is JSON, because an API's error message
 * is usually in there and a single line of minified JSON hides it.
 */
function renderCurl(r, { from } = {}) {
  const wrap = el('div', {});
  const good = r.status && r.status < 400;
  if (from) {
    wrap.append(el('div', { class: 'hint', style: 'margin-bottom:8px' },
      `Sent from ${from}, through a SOCKS proxy over that session — the name was resolved `
      + 'there too, so this is what that host sees.'));
  } else {
    // Only here, not from a host: a copy of this command run on this
    // machine is not what just happened over there, through a proxy that
    // resolved the name on the far end.
    wrap.append(commandBlock(r.command));
  }
  wrap.append(el('div', { class: 'nt-row' },
    el('span', {
      class: 'nt-badge',
      style: `background:${good ? 'var(--green)' : 'var(--red)'};color:#0d1117`,
      text: String(r.status || 'no status'),
    }),
    el('span', { text: r.statusText || '' }),
    el('span', { style: 'flex:1' }),
    el('span', { class: 'nt-meta', text: [
      r.httpVersion ? 'HTTP/' + r.httpVersion : '',
      r.contentType ? r.contentType.split(';')[0] : '',
      fmtBytes(r.bytes),
      fmtDuration(r.ms),
    ].filter(Boolean).join('  ·  ') })));

  if (r.hops?.length) {
    wrap.append(el('div', { class: 'nt-sub', text: 'Redirects' }));
    for (const h of r.hops.slice(0, -1)) {
      wrap.append(el('div', { class: 'nt-kv' },
        el('span', { class: 'k', text: String(h.status) }),
        el('span', { class: 'v', text: h.headers.Location || h.headers.location || h.statusText })));
    }
  }

  wrap.append(el('div', { class: 'nt-sub', text: 'Headers' }));
  const keys = Object.keys(r.headers || {}).sort();
  if (!keys.length) wrap.append(el('div', { class: 'nt-kv' }, el('span', { class: 'v', text: '(none)' })));
  for (const k of keys) {
    wrap.append(el('div', { class: 'nt-kv' },
      el('span', { class: 'k', text: k }),
      el('span', { class: 'v', text: r.headers[k] })));
  }

  wrap.append(el('div', { class: 'nt-sub', text: 'Body' }));
  let bodyText = r.body || '';
  if (/json/i.test(r.contentType || '') && bodyText.trim()) {
    try { bodyText = JSON.stringify(JSON.parse(bodyText), null, 2); } catch { /* leave it as it came */ }
  }
  wrap.append(el('pre', { class: 'nt-pre', text: bodyText || '(empty)' }));

  if (r.stderr) {
    wrap.append(el('div', { class: 'nt-sub', text: 'curl said' }));
    wrap.append(el('pre', { class: 'nt-pre', style: 'color:var(--amber)', text: r.stderr }));
  }

  wrap.append(el('div', { style: 'margin-top:9px;display:flex;gap:6px;flex-wrap:wrap' },
    el('button', {
      class: 'ghost-btn sm', text: 'Copy as curl',
      onClick: () => { window.api.clipboard.write(r.command); status('Copied the curl command'); },
    }),
    el('button', {
      class: 'ghost-btn sm', text: 'Copy body',
      onClick: () => { window.api.clipboard.write(r.body || ''); status('Body copied'); },
    })));
  wrap.append(el('div', { class: 'nt-cmd', style: 'margin-top:7px;white-space:pre-wrap;word-break:break-all', text: r.command }));
  return wrap;
}

/**
 * The runnable form of whatever a tool just did, with a Copy button — the
 * whole reason to have this panel at all is so the same check can be run
 * without it, in a terminal, over a ticket, on a box this app has no
 * session on yet. `note` is a platform caveat (no telnet client, no whois
 * client, openssl not on PATH) rather than part of the command, so it is
 * never copied along with it.
 */
function commandBlock(command, note) {
  // Never `null`: several call sites append this straight onto a plain DOM
  // node with the native `.append()`, which stringifies `null` into the
  // literal text "null" rather than dropping it — unlike `el()`'s own
  // children, which do filter it out. An empty node is harmless either way.
  if (!command) return el('div', {});
  return el('div', { class: 'nt-cmdblock' },
    // `.row`'s `display:flex` in this app is scoped to `.pane-overlay .row`
    // — nothing here is one, so it has to be set again right here, same as
    // every other `class: 'row'` outside an overlay already has to.
    el('div', { class: 'row', style: 'display:flex;align-items:flex-start;gap:8px' },
      el('div', { class: 'nt-cmd', style: 'flex:1', text: command }),
      el('button', {
        class: 'ghost-btn sm', text: 'Copy',
        title: 'Copy this command to run it yourself, outside ServerLife',
        onClick: () => {
          window.api.clipboard.write(command);
          status('Command copied');
        },
      })),
    note ? el('div', { class: 'nt-cmd-note', text: note }) : null);
}

/*
 * The four tools below have no live, before-you-run preview — a decoder
 * runs on whatever was just pasted, and "this machine" needs no target at
 * all — so their command only exists once a result has come back. Pulled
 * out as pure functions (not built inline in each `render*`) so `dispatch`
 * can hand the same values to `runTool`, which is the only thing that can
 * get them into the footer's "Copy command" button: that button lives in
 * `openNetTools`'s own closure, nowhere near these renderer functions.
 */
function sshCertCommand(file) {
  if (!file) return { command: null };
  return {
    command: `ssh-keygen -L -f '${file}'`,
    commandNote: IS_WIN
      ? 'ssh-keygen ships as a Windows optional feature (Settings → Apps → Optional features → '
        + 'OpenSSH Client) — on if you can already run `ssh` from a terminal, off otherwise.'
      : null,
  };
}

function jwtCommand(r) {
  return {
    command: `python3 -c "import base64,json; p='${r.raw.payload}'; p+='='*(-len(p)%4); `
      + 'print(json.dumps(json.loads(base64.urlsafe_b64decode(p)), indent=2))"',
    commandNote: 'Needs python3 on PATH — on by default on macOS and most Linux, not guaranteed on Windows.',
  };
}

function svidCommand(r) {
  return {
    command: `openssl x509 -noout -text <<'EOF'\n${r.pem}\nEOF`,
    commandNote: IS_WIN
      ? 'A `<<` heredoc is a bash/zsh thing — paste this into Git Bash or WSL, or save the PEM to a '
        + '.pem file and run: openssl x509 -in file.pem -noout -text'
      : null,
  };
}

function localMachineCommand() {
  return {
    command: IS_WIN ? 'ipconfig /all\nroute print'
      : IS_MAC ? 'ifconfig\nnetstat -rn\nscutil --dns'
        : 'ip addr\nip route\ncat /etc/resolv.conf',
    commandNote: null,
  };
}

function renderText(r) {
  const wrap = el('div', {});
  wrap.append(commandBlock(r.command, r.commandNote));
  wrap.append(el('pre', { class: 'nt-pre', text: r.text || '(no output)' }));
  if (r.timedOut) wrap.append(el('div', { class: 'hint', style: 'color:var(--amber)', text: 'Timed out before finishing.' }));
  return wrap;
}

function renderDns(r) {
  const wrap = el('div', {});
  wrap.append(commandBlock(r.command, r.commandNote));
  const types = Object.keys(r.records || {});
  if (!types.length && !r.reverse) {
    wrap.append(el('div', { class: 'sb-empty', text: `Nothing resolves for ${r.host}.` }));
  }
  for (const type of types) {
    const ttl = r.ttls?.[type];
    wrap.append(el('div', { class: 'nt-group' },
      el('div', { class: 'nt-group-head', text: type + (ttl != null ? `  ·  TTL ${ttl}s` : '') }),
      el('div', { class: 'nt-rows' },
        ...r.records[type].map((v) => el('div', { class: 'nt-mono', text: formatRecord(v) })))));
  }
  if (r.reverse?.length) {
    wrap.append(el('div', { class: 'nt-group' },
      el('div', { class: 'nt-group-head', text: 'PTR' }),
      el('div', { class: 'nt-rows' }, ...r.reverse.map((v) => el('div', { class: 'nt-mono', text: v })))));
  }
  if (r.servers?.length) {
    wrap.append(el('div', { class: 'hint', style: 'margin-top:10px',
      text: (r.usingCustomServer ? 'Queried via: ' : 'Resolvers: ') + r.servers.join(', ') }));
  }
  return wrap;
}

function formatRecord(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join('');
  if (v && typeof v === 'object') {
    return Object.entries(v).map(([k, x]) => `${k}=${x}`).join(' ');
  }
  return String(v);
}

/**
 * The host a connection is on, in the form a saved request can keep.
 *
 * A connection id is gone by tomorrow; the host is what "run that again, from
 * there" means, so that is what is stored.
 */
function hostRefFor(connId) {
  const conn = state.getConnection(connId);
  if (!conn) return null;
  return { hostId: conn.hostId || null, label: conn.label || '', type: conn.type || 'ssh' };
}

/** A connection to that host, if one is open. */
function connForHostRef(ref) {
  if (!ref) return null;
  for (const c of state.connections.values()) {
    if (c.state !== 'connected') continue;
    if (ref.hostId && c.hostId === ref.hostId) return c;
    if (!ref.hostId && c.label === ref.label) return c;
  }
  return null;
}

/*
 * How each outcome reads, and what it means.
 *
 * "closed" was two answers wearing one word. A refusal is a host that
 * answered — something is there, nothing is listening on that port — while
 * silence is a firewall or a wrong address, and only the first is something
 * you can fix on the far end.
 */
const PORT_STATES = {
  open: { cls: 'open', label: 'open', why: 'the connection was accepted' },
  closed: { cls: 'closed', label: 'refused', why: 'the host answered — nothing is listening on that port' },
  filtered: { cls: 'unknown', label: 'no answer', why: 'nothing came back before the timeout — dropped, most likely by a firewall' },
  dns: { cls: 'unknown', label: 'unknown name', why: 'the name could not be resolved from there' },
  error: { cls: 'unknown', label: 'error', why: 'the connection could not be attempted' },
  unknown: { cls: 'unknown', label: 'unknown', why: 'the check could not be completed' },
};

function portState(p) {
  // `state` carries the verdict; a result saved before it existed has only
  // open/closed to go on.
  return PORT_STATES[p.state] || PORT_STATES[p.open === true ? 'open' : p.open === false ? 'closed' : 'unknown'];
}

/**
 * A port check made by a host. Says how it was asked, because the routes
 * answer slightly different questions: `ssh -W` is the host's own network
 * stack, while `nc` is whatever that tool does.
 */
function renderRemotePorts(r, fromLabel) {
  const grid = el('div', { class: 'nt-ports' });
  for (const p of r.results) {
    const s = portState(p);
    grid.append(el('div', { class: 'nt-port ' + s.cls, title: s.why },
      el('span', { class: 'nt-port-num', text: String(p.port) }),
      el('span', { class: 'nt-port-state', text: s.label }),
      el('span', { class: 'nt-port-ms', text: `${p.ms}ms` }),
      // A banner is free evidence of *what* answered, not just that something did.
      p.banner ? el('span', { class: 'nt-port-detail', text: p.banner }) : null,
      p.error && p.open !== true ? el('span', { class: 'nt-port-detail', text: p.error }) : null));
  }
  const open = r.results.filter((p) => p.open === true).length;
  return el('div', {},
    el('div', { class: 'nt-cmd', text: `${fromLabel || r.from} → ${r.host} — ${open} of ${r.results.length} open`
      + (r.how ? `  ·  asked with ${r.how}` : '') }),
    grid,
    el('div', { class: 'hint', style: 'margin-top:8px' },
      r.how === 'ssh -W'
        ? 'The server was asked to open each connection over the session that is already '
          + 'authenticated, so the answer is its own network stack and nothing had to be '
          + 'installed. The verdict is whether that succeeded: accepted is open, a refusal '
          + 'means the host is there with nothing listening, and silence means the packet '
          + 'was dropped.'
        : 'Answered by a tool on the host, since this session cannot forward.'));
}

/**
 * Output a host printed, as it printed it.
 *
 * A ping or a traceroute is read, not parsed — the summary line, the hop that
 * stops answering — and reformatting it per distribution would lose more than
 * it tidied. The one thing added is the command, so it can be run by hand.
 */
function renderRemoteText(r, fromLabel) {
  if (r.missing) {
    return el('div', {},
      el('div', { class: 'sb-empty', style: 'color:var(--amber)',
        text: `${fromLabel || r.from || 'That host'} has no ${r.missing}.` }),
      r.hint
        ? el('div', { class: 'nt-group' },
            el('div', { class: 'nt-group-head', text: 'to install it' }),
            el('pre', { class: 'nt-pre', text: r.hint }),
            el('div', { class: 'hint', text: 'Then press Re-check beside the host, and the tool becomes available.' }))
        : el('div', { class: 'hint', text: 'Its package manager was not recognised, so there is no command to suggest.' }));
  }
  return el('div', {},
    el('div', { class: 'nt-cmd', text: `${fromLabel || r.from} → ${r.host}`
      + (r.tool && r.tool !== 'traceroute' ? `  ·  ${r.tool}, since traceroute is not installed there` : '') }),
    el('pre', { class: 'nt-pre', text: r.text || '(no output)' }),
    el('div', { class: 'hint', style: 'margin-top:8px', text: `Run on the host as: ${r.command}` }));
}

/** The line of ping's summary worth putting in the recent list. */
function pingNote(r) {
  if (r.missing) return `no ping on that host`;
  const loss = String(r.text || '').match(/([\d.]+)% packet loss/);
  const rtt = String(r.text || '').match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/);
  return [loss ? `${loss[1]}% loss` : '', rtt ? `${rtt[2]}ms avg` : ''].filter(Boolean).join(' · ');
}

/** What a host's own network looks like from inside it. */
function renderHostFacts(f, label) {
  const block = (name, text, mono = true) => (text ? el('div', { class: 'nt-group' },
    el('div', { class: 'nt-group-head', text: name }),
    el('pre', { class: 'nt-pre', style: mono ? '' : 'font-family:inherit', text }),
  ) : null);
  return el('div', {},
    el('div', { class: 'nt-row' },
      el('span', { class: 'nt-badge name', text: f.hostname || label || 'host' }),
      el('span', { class: 'nt-meta', text: 'as the host sees itself' })),
    block('addresses', f.addresses),
    block('routes', f.routes),
    block('resolvers', f.resolvers));
}

function renderPorts(r) {
  const grid = el('div', { class: 'nt-ports' });
  for (const p of r.results) {
    // The same words as the check run on a host, so the two read alike.
    const s = portState(p);
    grid.append(el('div', { class: 'nt-port ' + s.cls, title: s.why },
      el('span', { class: 'nt-port-num', text: String(p.port) }),
      el('span', { class: 'nt-port-state', text: s.label }),
      el('span', { class: 'nt-port-ms', text: `${p.ms}ms` }),
      p.detail ? el('span', { class: 'nt-port-detail', text: p.detail }) : null));
  }
  const open = r.results.filter((p) => p.state === 'open').length;
  return el('div', {},
    el('div', { class: 'nt-cmd', text: `${r.host} — ${open} of ${r.results.length} open` }),
    commandBlock(r.command),
    grid);
}

/** host:port, or just the port when there is no address worth repeating. */
function sockAddr(addr, port) {
  if (port == null) return addr || '*';
  return `${addr && addr !== '0.0.0.0' && addr !== '::' && addr !== '*' ? addr : '*'}:${port}`;
}

/**
 * What is listening, and what is connected — `ss`/`netstat`/`lsof -i`,
 * whichever one answered, grouped the way anyone reading this by hand
 * would group it: listening sockets first (what could be reached), then
 * active connections (what is actually talking to what).
 */
function renderSockets(r, fromLabel) {
  if (r.missing) {
    return el('div', {},
      el('div', { class: 'sb-empty', style: 'color:var(--amber)',
        text: `${fromLabel ? `${fromLabel} has` : 'This machine has'} no ${r.missing}.` }),
      r.hint
        ? el('div', { class: 'nt-group' },
            el('div', { class: 'nt-group-head', text: 'to install it' }),
            el('pre', { class: 'nt-pre', text: r.hint }),
            fromLabel ? el('div', { class: 'hint', text: 'Then press Re-check beside the host, and the tool becomes available.' }) : null)
        : null);
  }
  const rows = r.rows || [];
  const listening = rows.filter((x) => /^(listen|unconn)/i.test(x.state) || (!x.state && x.remotePort == null));
  const connected = rows.filter((x) => !listening.includes(x));

  const table = (list) => {
    const grid = el('div', { class: 'nt-sock-grid' });
    grid.append(
      el('div', { class: 'nt-sock-head', text: 'Proto' }),
      el('div', { class: 'nt-sock-head', text: 'Local' }),
      el('div', { class: 'nt-sock-head', text: 'State' }),
      el('div', { class: 'nt-sock-head', text: 'Remote' }),
      el('div', { class: 'nt-sock-head', text: 'Process' }));
    for (const x of list) {
      const cls = /^listen|^unconn/i.test(x.state) || !x.remotePort ? 'listen' : /^estab/i.test(x.state) ? 'estab' : '';
      grid.append(el('div', { class: `nt-sock-row ${cls}`, style: 'display:contents' },
        el('div', { text: x.proto }),
        el('div', { title: sockAddr(x.localAddr, x.localPort), text: sockAddr(x.localAddr, x.localPort) }),
        el('div', { class: 'nt-sock-state', text: x.state || '' }),
        el('div', { title: x.remotePort ? sockAddr(x.remoteAddr, x.remotePort) : '', text: x.remotePort ? sockAddr(x.remoteAddr, x.remotePort) : '' }),
        el('div', { title: x.process || '', text: x.pid ? `${x.process || '?'} (${x.pid})` : (x.process || '') })));
    }
    return grid;
  };

  const wrap = el('div', {},
    el('div', { class: 'nt-cmd', text: `${fromLabel ? `${fromLabel} — ` : ''}${rows.length} socket${rows.length === 1 ? '' : 's'}`
      + (r.tool ? `  ·  ${r.tool}` : '') }),
    commandBlock(r.command));
  if (!rows.length) {
    wrap.append(el('div', { class: 'sb-empty', text: 'Nothing parsed from the output — see the raw text below.' }));
    return wrap;
  }
  if (listening.length) {
    wrap.append(el('div', { class: 'nt-group' },
      el('div', { class: 'nt-group-head', text: `Listening (${listening.length})` }),
      table(listening)));
  }
  if (connected.length) {
    wrap.append(el('div', { class: 'nt-group', style: 'margin-top:10px' },
      el('div', { class: 'nt-group-head', text: `Connected (${connected.length})` }),
      table(connected)));
  }
  if (rows.some((x) => !x.pid) && state.appInfo?.platform !== 'win32') {
    wrap.append(el('div', { class: 'hint', style: 'margin-top:10px',
      text: 'Some rows have no process name — that usually means it belongs to another user, which needs more than this app runs with to see.' }));
  }
  return wrap;
}

function renderTls(r) {
  if (!r.ok) {
    return el('div', {},
      commandBlock(r.command, r.commandNote),
      el('div', { class: 'sb-empty', style: 'color:var(--red)', text: r.error }));
  }
  const rows = [
    ['Verified', r.authorized ? 'yes' : `no — ${r.authorizationError || 'untrusted'}`],
    ['Protocol', r.protocol],
    ['Cipher', r.cipher ? `${r.cipher.name} (${r.cipher.version})` : null],
    ['ALPN', r.alpn],
    ['Subject', dn(r.subject)],
    ['Issuer', dn(r.issuer)],
    ['Valid from', r.validFrom],
    ['Valid to', r.validTo ? `${r.validTo}${r.daysLeft !== null ? ` — ${r.daysLeft} days left` : ''}` : null],
    ['Serial', r.serialNumber],
    ['SHA-256', r.fingerprint256],
    ['Names', r.san ? r.san.replace(/DNS:/g, '').replace(/,\s*/g, ', ') : null],
  ];
  const wrap = el('div', {},
    el('div', { class: 'nt-cmd', text: `${r.host}:${r.port}` }),
    commandBlock(r.command, r.commandNote),
    kvTable(rows));
  /*
   * The rest of the chain the server sent — intermediates, then the root —
   * not just the leaf singled out above. `chain[0]` is that same leaf, so
   * only what follows it is worth a second look.
   */
  const rest = (r.chain || []).slice(1);
  if (rest.length) {
    const chainBlock = el('div', { class: 'nt-group' },
      el('div', { class: 'nt-group-head', text: `Rest of the chain (${rest.length})` }));
    rest.forEach((c, i) => {
      chainBlock.append(section(i === rest.length - 1 ? 'Root' : `Intermediate ${i + 1}`, [
        ['Subject', dn(c.subject)],
        ['Issuer', dn(c.issuer)],
        ['Valid to', c.validTo],
        ['SHA-256', c.fingerprint256],
      ]));
    });
    wrap.append(chainBlock);
  } else if (r.chainComplete === false) {
    wrap.append(el('div', { class: 'hint', style: 'margin-top:10px', text:
      'The server sent only the leaf certificate — no intermediates. That is fine when the client already '
      + 'trusts the issuer directly, and a likely cause of "works in a browser, fails from curl/a script" when it does not.' }));
  }
  if (r.daysLeft !== null && r.daysLeft < 21) {
    wrap.append(el('div', {
      class: 'hint',
      style: `margin-top:10px;color:var(${r.daysLeft < 0 ? '--red' : '--amber'})`,
      text: r.daysLeft < 0 ? 'This certificate has expired.' : 'This certificate expires soon.',
    }));
  }
  return wrap;
}

function dn(o) {
  if (!o) return null;
  return o.CN || Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ');
}

function renderHttp(r) {
  const wrap = el('div', {});
  wrap.append(commandBlock(r.command));
  const f = r.final || {};
  wrap.append(el('div', { class: 'nt-badges' },
    badge(`${f.status} ${f.statusMessage || ''}`.trim(), statusKind(f.status)),
    badge(`${f.ms}ms`),
    f.bytes ? badge(fmtBytes(f.bytes)) : null,
    r.redirects ? badge(`${r.redirects} redirect${r.redirects === 1 ? '' : 's'}`, 'warn') : null));

  if (r.chain.length > 1) {
    wrap.append(el('div', { class: 'nt-group' },
      el('div', { class: 'nt-group-head', text: 'Redirect chain' }),
      el('div', { class: 'nt-rows' },
        ...r.chain.map((h) => el('div', { class: 'nt-mono' },
          el('span', { class: 'nt-badge ' + statusKind(h.status), text: String(h.status) }),
          el('span', { text: ' ' + h.url }))))));
  }

  const headers = Object.entries(f.headers || {})
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]);
  if (headers.length) {
    wrap.append(el('div', { class: 'nt-group' },
      el('div', { class: 'nt-group-head', text: 'Response headers' }),
      kvTable(headers)));
  }

  if (f.preview) {
    wrap.append(el('details', { class: 'nt-raw' },
      el('summary', {}, el('span', { text: 'First 2 KB of body' })),
      el('pre', { class: 'nt-pre', text: f.preview })));
  }
  return wrap;
}

function statusKind(code) {
  if (!code) return 'warn';
  if (code < 300) return 'ok';
  if (code < 400) return 'warn';
  return 'warn';
}

/* ------------------------------------------------------------------ */
/* Teleport /webapi/ping                                               */
/* ------------------------------------------------------------------ */

/**
 * The proxy's own description of itself. Laid out rather than dumped: the
 * things people actually ask — what version, which edition, how do I log in,
 * is TLS routing on — first, with the raw document underneath for the rest.
 */
function renderTeleportPing(r) {
  const p = r.ping || {};
  const auth = p.auth || {};
  const proxy = p.proxy || {};
  const wrap = el('div', {});

  wrap.append(el('div', { class: 'nt-cmd', text: `${r.url} — ${r.ms}ms` }));
  wrap.append(commandBlock(r.command));

  wrap.append(el('div', { class: 'nt-badges' },
    badge(p.cluster_name || 'unknown cluster', 'name'),
    badge(`v${p.server_version || '?'}`, 'ver'),
    p.edition ? badge(editionLabel(p.edition), 'ed') : null,
    p.fips ? badge('FIPS', 'warn') : null,
    proxy.tls_routing_enabled ? badge('TLS routing', 'ok') : badge('separate listeners', 'warn')));

  wrap.append(section('Cluster', [
    ['Name', p.cluster_name],
    ['Server version', p.server_version],
    ['Minimum client', p.min_client_version],
    ['Edition', editionLabel(p.edition)],
    ['FIPS mode', typeof p.fips === 'boolean' ? yn(p.fips) : null],
    ['Automatic upgrades', typeof p.automatic_upgrades === 'boolean' ? yn(p.automatic_upgrades) : null],
  ]));

  const au = p.auto_update || {};
  if (Object.keys(au).length) {
    wrap.append(section('Managed updates', [
      ['Tools version', au.tools_version],
      ['Tools auto-update', typeof au.tools_auto_update === 'boolean' ? yn(au.tools_auto_update) : null],
      ['Agent version', au.agent_version],
      ['Agent auto-update', typeof au.agent_auto_update === 'boolean' ? yn(au.agent_auto_update) : null],
      ['Agent jitter', au.agent_update_jitter_seconds ? `${au.agent_update_jitter_seconds}s` : null],
    ]));
  }

  wrap.append(section('Authentication', [
    ['Connector type', connectorLabel(auth)],
    ['Second factor', auth.second_factor],
    ['Preferred local MFA', auth.preferred_local_mfa],
    ['Passwordless', typeof auth.allow_passwordless === 'boolean' ? yn(auth.allow_passwordless) : null],
    ['Headless', typeof auth.allow_headless === 'boolean' ? yn(auth.allow_headless) : null],
    ['Default session TTL', auth.default_session_ttl],
    ['Private key policy', auth.private_key_policy],
    ['PIV slot', auth.piv_slot || null],
    ['Signature suite', auth.signature_algorithm_suite],
    ['Message of the day', typeof auth.has_motd === 'boolean' ? yn(auth.has_motd) : null],
    ['Device trust', auth.device_trust && Object.keys(auth.device_trust).length
      ? JSON.stringify(auth.device_trust) : null],
    ['WebAuthn RP ID', auth.webauthn?.rp_id],
  ]));

  // The connector block is named differently per type; show whichever is there.
  for (const kind of ['saml', 'oidc', 'github', 'local']) {
    const c = auth[kind];
    if (!c || typeof c !== 'object') continue;
    wrap.append(section(`${kind.toUpperCase()} connector`, Object.entries(c).map(([k, v]) => [k, stringify(v)])));
  }

  wrap.append(section('Proxy listeners', [
    ['SSH public address', proxy.ssh?.public_addr],
    ['SSH listener', proxy.ssh?.listen_addr],
    ['Reverse tunnel', proxy.ssh?.tunnel_listen_addr],
    ['Web listener', proxy.ssh?.web_listen_addr],
    ['Dial timeout', proxy.ssh?.dial_timeout ? `${Math.round(proxy.ssh.dial_timeout / 1e9)}s` : null],
    ['Kubernetes', proxy.kube?.enabled ? (proxy.kube.public_addr || proxy.kube.listen_addr || 'enabled') : 'disabled'],
    ['PostgreSQL', proxy.db?.postgres_public_addr || proxy.db?.postgres_listen_addr],
    ['MySQL', proxy.db?.mysql_public_addr || proxy.db?.mysql_listen_addr],
    ['MongoDB', proxy.db?.mongo_public_addr || proxy.db?.mongo_listen_addr],
    ['TLS routing', typeof proxy.tls_routing_enabled === 'boolean' ? yn(proxy.tls_routing_enabled) : null],
  ]));

  if (Array.isArray(p.license_warnings) && p.license_warnings.length) {
    wrap.append(el('div', { class: 'nt-group' },
      el('div', { class: 'nt-group-head', text: 'License warnings' }),
      el('div', { class: 'nt-rows' },
        ...p.license_warnings.map((w) => el('div', { style: 'color:var(--amber)', text: w })))));
  }

  // Everything, including fields this build has never heard of.
  const raw = el('details', { class: 'nt-raw' },
    el('summary', {}, el('span', { text: 'Raw JSON' })),
    el('pre', { class: 'nt-pre', text: JSON.stringify(p, null, 2) }));
  wrap.append(raw);
  return wrap;
}

function editionLabel(ed) {
  if (!ed) return null;
  return ({ oss: 'Community', ent: 'Enterprise', team: 'Team', cloud: 'Cloud' })[ed] || ed;
}

function connectorLabel(auth) {
  if (!auth.type) return null;
  const c = auth[auth.type];
  const name = c && (c.display || c.name);
  return name ? `${auth.type} — ${name}` : auth.type;
}

function stringify(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function yn(v) { return v ? 'yes' : 'no'; }

function badge(text, kind) {
  return el('span', { class: 'nt-badge ' + (kind || ''), text });
}

function section(title, rows) {
  const kept = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!kept.length) return null;
  return el('div', { class: 'nt-group' },
    el('div', { class: 'nt-group-head', text: title }),
    kvTable(kept));
}

function kvTable(rows) {
  const t = el('div', { class: 'nt-kv' });
  for (const [k, v] of rows) {
    if (v === null || v === undefined || v === '') continue;
    t.append(
      el('div', { class: 'nt-k', text: k }),
      el('div', { class: 'nt-v', text: String(v) }));
  }
  return t;
}

function renderLocal(r) {
  const wrap = el('div', {},
    section('This machine', [
      ['Host name', r.hostname],
      ['Platform', r.platform],
      ['Resolvers', (r.dnsServers || []).join(', ')],
    ]));
  // The same three facts, the way each platform's own tools show them —
  // interfaces, routes, resolvers, in that order on all three.
  wrap.append(commandBlock(localMachineCommand().command));
  if (r.addresses?.length) {
    wrap.append(el('div', { class: 'nt-group' },
      el('div', { class: 'nt-group-head', text: 'Interfaces' }),
      kvTable(r.addresses.map((a) => [`${a.name} (${a.family})`, a.cidr || a.address]))));
  }
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Subnet, URL and the decoders                                        */
/* ------------------------------------------------------------------ */

/** Seconds as the largest unit or two that say it: "3h 12m", "41d". */
function inWords(sec) {
  if (sec === null || sec === undefined) return '';
  const past = sec < 0;
  let s = Math.abs(sec);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  const txt = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
  return past ? `${txt} ago` : `in ${txt}`;
}

function group(title, ...nodes) {
  return el('div', { class: 'nt-group' }, el('div', { class: 'nt-group-head', text: title }), ...nodes.filter(Boolean));
}

function renderCidr(r) {
  const n = (v) => Number(v).toLocaleString();
  const big = (v) => (v.length > 15 ? `2^${Math.round(Math.log2(Number(v)))}` : n(v));
  return el('div', {},
    r.check ? el('div', { style: 'margin-bottom:10px' },
      badge(r.check.inside ? 'inside' : 'outside', r.check.inside ? 'ok' : 'bad'),
      el('span', { text: ` ${r.check.address} is ${r.check.inside ? '' : 'not '}in ${r.cidr}` })) : null,
    r.hostBitsSet ? el('div', { class: 'hint', style: 'margin-bottom:8px',
      text: `${r.input} has host bits set; the network it belongs to is ${r.cidr}.` }) : null,
    section(`IPv${r.family} subnet`, [
      ['CIDR', r.cidr],
      ['Network', r.network],
      ['Netmask', r.netmask],
      ['Wildcard (ACL) mask', r.wildcard],
      ['Broadcast', r.broadcast],
      ['Usable range', `${r.first} – ${r.last}`],
      ['Last address', r.lastAddress],
      ['Addresses', big(r.total)],
      ['Usable hosts', big(r.usable)],
      ['Kind', r.kind],
    ]));
}

function renderUrl(r) {
  const copyable = (label, v) => (v ? el('div', { class: 'nt-group' },
    el('div', { class: 'nt-group-head' }, el('span', { text: label + ' ' }),
      el('button', { class: 'ghost-btn sm', text: 'Copy', onClick: () => { window.api.clipboard.write(v); status(`${label} copied`); } })),
    el('pre', { class: 'nt-pre', style: 'white-space:pre-wrap;word-break:break-all;margin:0', text: v })) : null);
  return el('div', {},
    copyable('Decoded', r.decoded),
    copyable('Encoded (a value in a query string)', r.encoded),
    copyable('Encoded (a whole URL)', r.encodedUrl !== r.encoded ? r.encodedUrl : null),
    r.parts ? section('URL', [
      ['Scheme', r.parts.protocol], ['User', r.parts.username], ['Host', r.parts.host],
      ['Port', r.parts.port], ['Path', r.parts.path], ['Fragment', r.parts.fragment],
    ]) : null,
    r.query?.length ? group('Query', kvTable(r.query.map((q) => [q.key, q.value]))) : null);
}

/* ---- pieces the decoders share ---- */

/** A local date and time, short enough to read at a glance. */
function when(iso) {
  if (!iso || iso === 'forever') return iso || '';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** "Mon 12 Oct 2026, 3:20 PM" with how far off it is beside it. */
function whenNode(iso, now = Date.now()) {
  if (!iso || iso === 'forever') return el('span', { text: iso === 'forever' ? 'never' : '' });
  const sec = Math.round((Date.parse(iso) - now) / 1000);
  return el('span', {},
    el('span', { text: when(iso) }),
    el('span', { class: 'nt-dim', text: '  ' + inWords(sec) }));
}

/**
 * Values as tags, and a long list cut short: the first `max`, then a
 * "+N more" that shows the rest. Seventy-five group names at once is the
 * wall of text this is here to avoid.
 */
function tags(values, { max = 12, kind = '' } = {}) {
  const wrap = el('div', { class: 'nt-tags' });
  const draw = (all) => {
    clear(wrap);
    const shown = all ? values : values.slice(0, max);
    for (const v of shown) wrap.append(el('span', { class: 'nt-tag ' + kind, text: v, title: v }));
    if (values.length > max) {
      wrap.append(el('button', {
        class: 'nt-more', text: all ? 'show fewer' : `+${values.length - max} more`,
        onClick: () => draw(!all),
      }));
    }
  };
  if (!values.length) wrap.append(el('span', { class: 'nt-dim', text: 'none' }));
  else draw(false);
  return wrap;
}

/** Rows whose values can be nodes rather than only text. */
function rows(list) {
  const t = el('div', { class: 'nt-kv' });
  for (const [k, v] of list) {
    if (v === null || v === undefined || v === '') continue;
    t.append(el('div', { class: 'nt-k', text: k }),
      v instanceof Node ? el('div', { class: 'nt-v nt-v-node' }, v) : el('div', { class: 'nt-v', text: String(v) }));
  }
  return t.children.length ? t : null;
}

function card(title, ...nodes) {
  const kept = nodes.filter(Boolean);
  if (!kept.length) return null;
  return el('div', { class: 'nt-card' }, title ? el('div', { class: 'nt-group-head', text: title }) : null, ...kept);
}

/** Traits as a table of name → tags, the busiest last. */
function traitRows(traits) {
  if (!traits.length) return null;
  const sorted = [...traits].sort((a, b) => a.values.length - b.values.length || a.name.localeCompare(b.name));
  return rows(sorted.map((t) => [t.name, tags(t.values, { max: 8 })]));
}

/** The line that says what this is before any detail does. */
function headline(text, ...badges) {
  return el('div', { class: 'nt-headline' },
    el('div', { class: 'nt-headline-text', text }),
    el('div', { class: 'nt-tags' }, ...badges.filter(Boolean)));
}

function stateTag(state, expiresIn) {
  const ok = state === 'valid';
  const label = ok
    ? (expiresIn === null || expiresIn === undefined ? 'valid, never expires' : `valid — expires ${inWords(expiresIn)}`)
    : state === 'expired' && expiresIn !== null && expiresIn !== undefined ? `expired ${inWords(expiresIn)}` : state;
  return badge(label, ok ? 'ok' : 'bad');
}

/* ---- SSH certificate ---- */

/** "Show in Finder", in the words of the file manager this machine has. */
const IS_MAC = navigator.platform.startsWith('Mac');
const IS_WIN = navigator.platform.startsWith('Win');
const REVEAL_LABEL = IS_MAC ? 'Show in Finder' : IS_WIN ? 'Show in Explorer' : 'Show in folder';

/**
 * Whether pasted text holds the same certificate as a -cert.pub file: the
 * file's base64 appears in it once all whitespace is gone, so a line that
 * wrapped in a terminal, or carries a different comment, still counts.
 */
function sameCert(pasted, fileText) {
  const key = String(fileText || '').trim().split(/\s+/)[1];
  return !!key && String(pasted || '').replace(/\s+/g, '').includes(key);
}

/** A decoded result with the File card under its headline, when it came from one. */
function withFile(node, file) {
  const c = fileCard(file);
  if (!c || !node) return node;
  const first = node.firstElementChild;
  node.insertBefore(c, first?.classList.contains('nt-headline') ? first.nextSibling : first);
  return node;
}

/**
 * Where a decoded file lives, with a way to go and look.
 *
 * Finder and Explorer open the folder with the file selected. On Linux that
 * depends on the file manager answering the freedesktop call, and where none
 * does the reveal can come to nothing — so Linux also gets *Open folder*,
 * which only needs xdg-open.
 */
function fileCard(file) {
  if (!file) return null;
  const dir = file.replace(/[\\/][^\\/]*$/, '');
  return card('File', el('div', { class: 'nt-file' },
    el('code', { class: 'nt-file-path', text: file, title: file }),
    el('button', {
      class: 'ghost-btn sm', text: REVEAL_LABEL,
      title: 'Open the folder it is in, with the file selected',
      onClick: () => window.api.local.reveal(file).catch((e) => toast(e.message, 'error')),
    }),
    IS_MAC || IS_WIN ? null : el('button', {
      class: 'ghost-btn sm', text: 'Open folder', title: dir,
      onClick: () => window.api.local.open(dir).catch((e) => toast(e.message, 'error')),
    })));
}

function renderSshCert(r, file) {
  const x = r.readable || {};
  const cluster = (x.teleport || []).find((t) => t.name === 'Cluster')?.value;
  const internal = (p) => p.startsWith('-teleport');
  const logins = r.principals.filter((p) => !internal(p));
  const hidden = r.principals.filter(internal);
  const who = r.type === 'host'
    ? `Host certificate for ${logins.join(', ') || r.keyId}`
    : `User certificate for ${r.keyId || 'an unnamed key'}${cluster ? ` on ${cluster}` : ''}`;
  const { command: sshCmd, commandNote: sshCmdNote } = sshCertCommand(file);
  return el('div', { class: 'nt-decoded' },
    headline(who, stateTag(r.state, r.expiresIn), r.teleport ? badge('Teleport', 'name') : null),
    fileCard(file),
    commandBlock(sshCmd, sshCmdNote),
    card(r.type === 'host' ? 'Names it is valid for' : 'Logins it allows',
      r.principals.length ? tags(logins, { max: 16 }) : el('div', { text: 'Any login — the certificate names none' }),
      hidden.length ? el('div', { class: 'nt-dim', style: 'margin-top:4px',
        text: `Also ${hidden.join(', ')} — Teleport's own, not a login` }) : null),
    card('Validity', rows([
      ['From', whenNode(r.validAfter)],
      ['Until', whenNode(r.validBefore)],
    ])),
    x.roles?.length ? card(`Roles (${x.roles.length})`, tags(x.roles, { max: 16, kind: 'role' })) : null,
    x.traits?.length ? card('Traits', traitRows(x.traits)) : null,
    card('Allowed', x.permissions?.length ? tags(x.permissions, { kind: 'perm' }) : el('div', { class: 'nt-dim', text: 'Nothing — no permit-* extensions' }),
      x.restrictions?.length ? rows(x.restrictions.map((o) => [o.name, o.value])) : null),
    x.teleport?.length ? card('Teleport', rows(x.teleport.filter((t) => t.name !== 'Cluster').map((t) => [t.name, t.value]))) : null,
    x.device?.length ? card('Trusted device', rows(x.device.map((d) => [d.name, d.value]))) : null,
    x.other?.length ? card('Other extensions', rows(x.other.map((o) => [o.name, o.value || '(set)']))) : null,
    card('Key and signer', rows([
      ['Key ID', r.keyId],
      ['Key', `${r.keyType}  ${r.keyFingerprint}`],
      ['Signed by CA', `${r.ca.type}  ${r.ca.fingerprint}`],
      ['Serial', r.serial],
      ['Comment', r.comment],
    ])));
}

/* ---- JWT ---- */

function renderJwt(r) {
  const c = r.claims || { fields: [], roles: [], traits: [] };
  const sub = c.fields.find((f) => f.key === 'sub' || f.key === 'username');
  const iss = c.fields.find((f) => f.key === 'iss');
  const text = [r.kind || 'JWT', sub ? `for ${sub.value || sub.list?.join(', ')}` : '', iss ? `from ${iss.value}` : '']
    .filter(Boolean).join(' ');
  const wrap = el('div', { class: 'nt-decoded' },
    headline(text, stateTag(r.state, r.expiresIn), badge(r.signature.alg || 'no algorithm'), badge('signature not checked', 'warn')));
  const { command: jwtCmd, commandNote: jwtCmdNote } = jwtCommand(r);
  wrap.append(commandBlock(jwtCmd, jwtCmdNote));
  wrap.append(
    card('Claims', rows(c.fields.map((f) => [
      f.name === f.key ? f.key : `${f.name}`,
      f.time ? whenNode(f.time) : f.list ? tags(f.list, { max: 10 }) : f.value,
    ]))),
    c.roles.length ? card(`Roles (${c.roles.length})`, tags(c.roles, { max: 16, kind: 'role' })) : null,
    c.traits.length ? card('Traits', traitRows(c.traits)) : null,
    card('Header', rows(Object.entries(r.header).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]))));
  return wrap;
}

/* ---- SPIFFE SVID ---- */

function renderSvid(r) {
  const leaf = r.certificates[0];
  const wrap = el('div', { class: 'nt-decoded' },
    headline(leaf.spiffeId || 'No SPIFFE ID in this certificate',
      stateTag(leaf.state, leaf.expiresIn),
      badge(r.ok ? 'keeps the SPIFFE rules' : 'breaks the SPIFFE rules', r.ok ? 'ok' : 'bad')));
  // The PEM this was decoded from is right there, re-serialized clean —
  // no file needed, unlike the SSH certificate case, so this always has a
  // command rather than only when one happens to be known. A heredoc, not a
  // single-line pipe, because a certificate has real newlines in it and
  // disturbing those is how you get "unable to load certificate".
  const { command: svidCmd, commandNote: svidCmdNote } = svidCommand(r);
  wrap.append(commandBlock(svidCmd, svidCmdNote));
  if (leaf.problems.length) {
    wrap.append(card('Problems', ...leaf.problems.map((p) => el('div', { class: 'nt-problem', text: p }))));
  }
  const m = leaf.spiffeId?.match(/^spiffe:\/\/([^/]+)(\/.*)?$/);
  r.certificates.forEach((c, i) => {
    wrap.append(card(i === 0 ? 'The SVID' : `Chain certificate ${i}`, rows([
      i === 0 && m ? ['Trust domain', m[1]] : null,
      i === 0 && m ? ['Workload path', m[2] || '/'] : null,
      ['Subject', c.subject],
      ['Issuer', c.issuer],
      ['Valid from', whenNode(c.validFrom)],
      ['Valid until', whenNode(c.validTo)],
      ['Certificate authority', c.ca ? 'yes' : 'no'],
      ['Key', c.publicKey],
      ['Key usage', c.keyUsage.length ? tags(c.keyUsage) : null],
      ['Other names', c.sans.filter((x) => x !== 'URI:' + c.spiffeId).length
        ? tags(c.sans.filter((x) => x !== 'URI:' + c.spiffeId)) : null],
      ['Signed by the next one', c.signedByNext === null ? null : (c.signedByNext ? 'yes' : 'no — the chain does not line up here')],
      ['Serial', c.serial],
      ['SHA-256', c.fingerprint256],
    ].filter(Boolean))));
  });
  return wrap;
}

/* ---- the Raw view ---- */

/** What Raw shows for each decoder: the thing as tools print it. */
function rawFor(tool, r) {
  switch (tool) {
    case 'sshcert': return r.raw;
    case 'jwt':
      return [
        '// header', JSON.stringify(r.header, null, 2), '',
        '// claims', JSON.stringify(r.payload, null, 2), '',
        '// encoded parts (header . payload . signature)',
        r.raw.header, r.raw.payload, r.raw.signature,
      ].join('\n');
    case 'svid': {
      const fields = r.certificates.map(({ problems, ...c }) => ({ ...c, problems }));
      return r.pem + '\n\n' + JSON.stringify(fields, null, 2);
    }
    default: return JSON.stringify(r, null, 2);
  }
}

/**
 * "Decode" as a submenu, for the right-click menus that offer it.
 *
 * `input` is what to decode — a terminal's selection, say — and opens the
 * decoder already run against it. With a Teleport `profile` and nothing
 * selected, the SSH certificate entry decodes that cluster's own certificate,
 * which is the one people want to read.
 */
export function decodeMenu({ input = '', profile = null } = {}) {
  const text = String(input || '').trim();
  return DECODE_TOOLS.map((t) => ({
    label: t.label + (text ? ' — the selection' : '…'),
    onClick: async () => {
      let given = text;
      let file = '';
      if (!given && profile && t.id === 'sshcert') {
        const certs = await window.api.decode.tshCerts().catch(() => []);
        const host = String(profile.proxy || '').replace(/:\d+$/, '');
        const mine = certs.find((c) => c.cluster === profile.cluster && c.proxy === host)
          || certs.find((c) => c.proxy === host);
        if (mine) { given = mine.text.trim(); file = mine.file; }
        else status(`No tsh certificate found for ${profile.cluster || host} — paste one`, 6000);
      }
      openNetTools({ tool: t.id, input: given, file });
    },
  }));
}

/**
 * Readable and Raw, for a decoded result. The choice is remembered, so
 * someone who wants the ssh-keygen layout every time gets it every time.
 */
function withRawToggle(node, raw) {
  const rawNode = el('div', { class: 'nt-rawview' },
    el('pre', { class: 'nt-pre', text: raw }));
  const view = el('div', {});
  const buttons = {};
  const show = (mode) => {
    clear(view);
    view.append(mode === 'raw' ? rawNode : node);
    for (const [k, b] of Object.entries(buttons)) b.classList.toggle('active', k === mode);
  };
  const pick = (mode) => {
    show(mode);
    state.settings = { ...state.settings, decoderView: mode };
    window.api.settings.set({ decoderView: mode }).catch(() => {});
  };
  buttons.readable = el('button', { class: 'nt-seg-btn', text: 'Readable', onClick: () => pick('readable') });
  buttons.raw = el('button', { class: 'nt-seg-btn', text: 'Raw', onClick: () => pick('raw') });
  const bar = el('div', { class: 'nt-viewbar' },
    el('div', { class: 'nt-seg' }, buttons.readable, buttons.raw),
    el('button', {
      class: 'ghost-btn sm', text: 'Copy raw',
      onClick: () => { window.api.clipboard.write(raw); status('Raw output copied'); },
    }));
  show(state.settings?.decoderView === 'raw' ? 'raw' : 'readable');
  return el('div', {}, bar, view);
}
