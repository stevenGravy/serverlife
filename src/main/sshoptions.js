/**
 * SSH options kept per host: the flags beyond "open a shell" that people
 * reach for — X11, forwards in both directions, a SOCKS proxy, a jump host —
 * and Teleport's own: a reason for the session, people invited to it, and
 * asking for access automatically when it is not there yet.
 *
 * Kept as data and turned into flags here, for both ways a session is dialled:
 * OpenSSH (the ControlMaster, which is where forwards and X11 are negotiated)
 * and `tsh ssh`. Pure, so the flag building can be tested without a host.
 */

const X11 = ['off', 'untrusted', 'trusted'];
const REQUEST_MODES = ['', 'off', 'resource', 'role'];

/*
 * A forward as ssh writes it. Local and remote have four shapes:
 *   [bind:]port:host:hostport            a classic network forward
 *   [bind:]port:local_socket             a port bridged to a Unix-domain socket
 *   local_socket:host:hostport           a Unix-domain socket bridged to a network target
 *   local_socket:remote_socket           socket to socket
 * `bind` may be a literal host/IP, `*` for every interface, or omitted (a
 * leading bare `:` also means "every interface" — ssh treats an empty bind
 * address the same as `*`). Dynamic (SOCKS) forwards are just `[bind:]port`.
 */
const PORT = '[0-9]{1,5}';
const HOST = '(?:\\[[0-9a-fA-F:.]+\\]|[A-Za-z0-9._-]+)';
// '*' for every interface, a literal host/IP, or nothing at all — a bare
// leading ':' (an explicit empty bind address) is how that last one is
// spelled out loud, so it has to match zero characters, not just be optional
// one level up, or ":9000:host:port" is rejected for having "nothing" where
// ssh itself is happy to see it.
const BIND = `(?:\\*|${HOST})?`;
// A Unix-domain socket path: absolute, no colon or whitespace (ssh itself
// has no escaping for a colon in one of these paths either).
const SOCK = '(?:/[^:\\s]+)';

const FWD_FORMS = [
  new RegExp(`^(?:${BIND}:)?(${PORT}):${HOST}:(${PORT})$`),   // [bind:]port:host:hostport
  new RegExp(`^(?:${BIND}:)?(${PORT}):${SOCK}$`),             // [bind:]port:socket
  new RegExp(`^${SOCK}:${HOST}:(${PORT})$`),                  // socket:host:hostport
  new RegExp(`^${SOCK}:${SOCK}$`),                            // socket:socket
];
const DYN_RE = new RegExp(`^(?:${BIND}:)?(${PORT})$`);
// One -J hop: [user@]host[:port]. A chain is these, comma-separated.
const JUMP_HOP_RE = new RegExp(`^(?:[^@,\\s]+@)?(?:\\[[0-9a-fA-F:.]+\\]|[^,:\\s]+)(?::${PORT})?$`);

const portOk = (p) => Number(p) >= 1 && Number(p) <= 65535;

function checkForward(spec, kind) {
  const s = String(spec || '').trim();
  if (!s) return null;
  if (kind === 'dynamic') {
    const m = s.match(DYN_RE);
    if (!m) return `"${s}" is not a SOCKS port — write 1080, 127.0.0.1:1080, or *:1080 for every interface`;
    return portOk(m[1]) ? null : `"${s}": port must be 1-65535`;
  }
  for (const re of FWD_FORMS) {
    const m = s.match(re);
    if (!m) continue;
    const ports = m.slice(1).filter(Boolean);
    return ports.every(portOk) ? null : `"${s}": port must be 1-65535`;
  }
  return `"${s}" is not a forward — write port:host:port (8080:localhost:80), *:port:host:port to bind every interface, or a path for a Unix-domain socket`;
}

/** One hop or a comma-separated chain, as OpenSSH's -J accepts. */
function checkJumpHost(spec) {
  const s = String(spec || '').trim();
  if (!s) return null;
  const hops = s.split(',').map((h) => h.trim());
  if (hops.some((h) => !h)) return 'Jump host: remove the empty hop — check for a stray comma';
  if (hops.some((h) => !JUMP_HOP_RE.test(h))) {
    return 'Jump host: one or more hops as user@host[:port] — comma-separated for a chain, e.g. bastion1,user@bastion2:2222';
  }
  return null;
}

/**
 * ssh_config directive names a `-o Name=value` extra option might carry.
 * Not exhaustive forever — OpenSSH adds a handful every so often — so an
 * unrecognized name is a warning, not a blocking error: it still gets saved,
 * it just gets flagged in case it is a typo rather than a newer directive.
 */
const KNOWN_SSH_OPTIONS = new Set([
  'addkeystoagent', 'addressfamily', 'batchmode', 'bindaddress', 'bindinterface',
  'canonicaldomains', 'canonicalizefallbacklocal', 'canonicalizehostname',
  'canonicalizemaxdots', 'canonicalizepermittedcnames', 'casignaturealgorithms',
  'certificatefile', 'channeltimeout', 'checkhostip', 'ciphers', 'clearallforwardings',
  'compression', 'connectionattempts', 'connecttimeout', 'controlmaster', 'controlpath',
  'controlpersist', 'dynamicforward', 'enableescapecommandline', 'enablesshkeysign',
  'escapechar', 'exitonforwardfailure', 'fingerprinthash', 'forkafterauthentication',
  'forwardagent', 'forwardx11', 'forwardx11timeout', 'forwardx11trusted', 'gatewayports',
  'globalknownhostsfile', 'gssapiauthentication', 'gssapidelegatecredentials',
  'hashknownhosts', 'hostbasedacceptedalgorithms', 'hostbasedauthentication',
  'hostkeyalgorithms', 'hostkeyalias', 'hostname', 'identitiesonly', 'identityagent',
  'identityfile', 'ignoreunknown', 'include', 'ipqos', 'kbdinteractiveauthentication',
  'kbdinteractivedevices', 'kexalgorithms', 'knownhostscommand', 'localcommand',
  'localforward', 'loglevel', 'logverbose', 'macs', 'match', 'nohostauthenticationforlocalhost',
  'numberofpasswordprompts', 'obscurekeystroketiming', 'passwordauthentication',
  'permitlocalcommand', 'permitremoteopen', 'pkcs11provider', 'port',
  'preferredauthentications', 'proxycommand', 'proxyjump', 'proxyusefdpass',
  'pubkeyacceptedalgorithms', 'pubkeyacceptedkeytypes', 'pubkeyauthentication',
  'rekeylimit', 'remotecommand', 'remoteforward', 'requesttty', 'requiredrsasize',
  'revokedhostkeys', 'securitykeyprovider', 'sendenv', 'serveralivecountmax',
  'serveraliveinterval', 'sessiontype', 'setenv', 'stdinnull', 'streamlocalbindmask',
  'streamlocalbindunlink', 'stricthostkeychecking', 'syslogfacility', 'tcpkeepalive',
  'tunnel', 'tunneldevice', 'updatehostkeys', 'user', 'userknownhostsfile',
  'verifyhostkeydns', 'visualhostkey', 'xauthlocation',
]);

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/))
  .map((x) => String(x).trim()).filter(Boolean);

/**
 * Options as stored: every field present, every value checked. Returns the
 * cleaned options and anything that was wrong, so a dialog can say what.
 */
function normalize(raw = {}) {
  const errors = [];
  const warnings = [];
  const o = {
    x11: X11.includes(raw.x11) ? raw.x11 : 'off',
    localForwards: list(raw.localForwards),
    remoteForwards: list(raw.remoteForwards),
    dynamicForwards: list(raw.dynamicForwards),
    jumpHost: String(raw.jumpHost || '').trim(),
    reason: String(raw.reason || '').trim(),
    invite: list(raw.invite),
    requestMode: REQUEST_MODES.includes(raw.requestMode) ? raw.requestMode : '',
    requestReason: String(raw.requestReason || '').trim(),
    noResume: !!raw.noResume,
    // -N: forwards only, no shell — a tunnel rather than a session.
    noShell: !!raw.noShell,
    extraOptions: list(raw.extraOptions),
  };
  for (const f of o.localForwards) { const e = checkForward(f, 'local'); if (e) errors.push(`Local forward: ${e}`); }
  for (const f of o.remoteForwards) { const e = checkForward(f, 'remote'); if (e) errors.push(`Remote forward: ${e}`); }
  for (const f of o.dynamicForwards) { const e = checkForward(f, 'dynamic'); if (e) errors.push(`SOCKS proxy: ${e}`); }
  const jumpError = checkJumpHost(o.jumpHost);
  if (jumpError) errors.push(jumpError);
  for (const x of o.extraOptions) {
    const m = x.match(/^([A-Za-z][A-Za-z0-9]*)\s*[= ]\s*(\S.*)$/);
    if (!m) { errors.push(`Option "${x}": write Name=value, for example ServerAliveInterval=30`); continue; }
    if (!KNOWN_SSH_OPTIONS.has(m[1].toLowerCase())) {
      warnings.push(`Option "${m[1]}" is not a recognized ssh_config directive — check for a typo`);
    }
  }
  for (const u of o.invite) {
    if (/\s/.test(u)) errors.push(`Invite "${u}": one Teleport user per entry`);
  }
  return { options: o, errors, warnings };
}

/** Whether anything differs from a plain session. */
function isEmpty(o) {
  const n = normalize(o).options;
  return n.x11 === 'off' && !n.localForwards.length && !n.remoteForwards.length && !n.dynamicForwards.length
    && !n.jumpHost && !n.reason && !n.invite.length && !n.requestMode && !n.requestReason
    && !n.noResume && !n.noShell && !n.extraOptions.length;
}

/**
 * Options only `tsh ssh` understands. A Teleport host with any of these is
 * opened over tsh, since OpenSSH has no flag that carries them.
 */
function needsTsh(o) {
  const n = normalize(o).options;
  return !!(n.reason || n.invite.length || n.requestMode || n.requestReason || n.noResume);
}

/** The forward and connection flags both clients spell the same way. */
function commonArgs(n) {
  const args = [];
  for (const f of n.localForwards) args.push('-L', f);
  for (const f of n.remoteForwards) args.push('-R', f);
  for (const f of n.dynamicForwards) args.push('-D', f);
  if (n.jumpHost) args.push('-J', n.jumpHost);
  for (const x of n.extraOptions) args.push('-o', x.replace(/\s*[= ]\s*/, '='));
  return args;
}

/** Flags for the OpenSSH master. X11 is added by the connection itself. */
function opensshArgs(o) {
  return commonArgs(normalize(o).options);
}

/** Flags for `tsh ssh`, before the target. X11 is added by the connection. */
function tshArgs(o) {
  const n = normalize(o).options;
  const args = commonArgs(n);
  if (n.reason) args.push('--reason=' + n.reason);
  if (n.invite.length) args.push('--invite=' + n.invite.join(','));
  if (n.requestMode) args.push('--request-mode=' + n.requestMode);
  if (n.requestReason) args.push('--request-reason=' + n.requestReason);
  if (n.noResume) args.push('--no-resume');
  return args;
}

/** Short lines saying what is set, for a menu. */
function summary(o) {
  const n = normalize(o).options;
  const out = [];
  if (n.x11 !== 'off') out.push(`X11 ${n.x11}`);
  for (const f of n.localForwards) out.push(`-L ${f}`);
  for (const f of n.remoteForwards) out.push(`-R ${f}`);
  for (const f of n.dynamicForwards) out.push(`SOCKS ${f}`);
  if (n.jumpHost) out.push(`via ${n.jumpHost}`);
  if (n.reason) out.push(`reason: ${n.reason}`);
  if (n.invite.length) out.push(`invites ${n.invite.join(', ')}`);
  if (n.requestMode) out.push(`auto request: ${n.requestMode}`);
  if (n.noResume) out.push('no resume');
  if (n.noShell) out.push('no shell (-N)');
  for (const x of n.extraOptions) out.push(`-o ${x}`);
  return out;
}

/** One argument for a POSIX shell, quoted only when it needs it. */
function shq(a) {
  const v = String(a);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command a person would type for this host with these options, to copy.
 *
 * A Teleport host is given as `tsh ssh`, which works on its own anywhere tsh
 * is logged in — the OpenSSH route the app uses needs its generated config.
 * A plain host is `ssh`, naming the config file when the alias came from one
 * other than ~/.ssh/config. X11 is included, as the connection would add it.
 */
function commandLine({ host = {}, login = null, options = {} } = {}) {
  const n = normalize(options).options;
  const x11 = n.x11 === 'trusted' ? ['-Y'] : n.x11 === 'untrusted' ? ['-X'] : [];
  if (host.type === 'teleport') {
    const target = (login ? `${login}@` : '') + (host.hostname || host.name);
    const args = ['tsh'];
    if (host.proxy) args.push('--proxy=' + host.proxy);
    args.push('ssh');
    if (host.cluster) args.push('--cluster=' + host.cluster);
    args.push(...x11, ...tshArgs(n), ...(n.noShell ? ['-N'] : []), target);
    return args.map(shq).join(' ');
  }
  const args = ['ssh'];
  if (host.configFile) args.push('-F', host.configFile);
  args.push(...x11, ...opensshArgs(n), ...(n.noShell ? ['-N'] : []));
  const name = host.alias || host.direct?.hostname || host.name;
  args.push((login ? `${login}@` : '') + name);
  return args.map(shq).join(' ');
}

module.exports = { normalize, isEmpty, needsTsh, opensshArgs, tshArgs, summary, commandLine, X11, REQUEST_MODES, KNOWN_SSH_OPTIONS };
