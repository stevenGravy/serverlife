'use strict';
/**
 * Things pasted in and taken apart: a subnet, a URL, and the three
 * credentials a Teleport user meets — the SSH certificate tsh issues, an
 * application JWT, and a SPIFFE X.509-SVID.
 *
 * None of it touches the network, and nothing here verifies a signature
 * against a trusted key: these answer "what does this say", which is the
 * question when a login is refused, and say so rather than implying more.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const path = require('path');

/* ------------------------------------------------------------------ */
/* CIDR                                                                */
/* ------------------------------------------------------------------ */

function v4ToBig(s) {
  return s.split('.').reduce((acc, o) => (acc << 8n) + BigInt(Number(o)), 0n);
}

function bigToV4(n) {
  return [24n, 16n, 8n, 0n].map((sh) => String((n >> sh) & 255n)).join('.');
}

function v6ToBig(s) {
  // An embedded dotted quad (::ffff:10.0.0.1) becomes its two hex groups.
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const q = v4ToBig(dotted[1]);
    s = s.slice(0, -dotted[1].length) + ((q >> 16n).toString(16)) + ':' + ((q & 0xffffn).toString(16));
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}

function bigToV6(n) {
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  // The longest run of two or more zero groups becomes `::` (RFC 5952).
  let best = { at: -1, len: 1 };
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  if (best.at < 0) return groups.join(':');
  return groups.slice(0, best.at).join(':') + '::' + groups.slice(best.at + best.len).join(':');
}

function parseAddr(s) {
  const v = String(s || '').trim();
  if (net.isIPv4(v)) return { family: 4, bits: 32, n: v4ToBig(v) };
  if (net.isIPv6(v)) return { family: 6, bits: 128, n: v6ToBig(v) };
  return null;
}

function fmt(family, n) { return family === 4 ? bigToV4(n) : bigToV6(n); }

/** A prefix length from a dotted netmask, or null if the mask has holes. */
function maskToPrefix(mask) {
  if (!net.isIPv4(mask)) return null;
  const n = v4ToBig(mask);
  let len = 0;
  while (len < 32 && ((n >> BigInt(31 - len)) & 1n)) len++;
  const back = len ? ((1n << BigInt(len)) - 1n) << BigInt(32 - len) : 0n;
  return back === n ? len : null;
}

/**
 * Everything about a subnet, from `10.0.0.0/16`, `10.0.0.5/24` (host bits
 * set: the network is worked out and that is said), `10.0.0.0 255.255.0.0`,
 * or a bare address (a /32 or /128). A second address — after a space, or as
 * `check` — is tested for membership.
 */
function cidr(input, { check } = {}) {
  const parts = String(input || '').trim().split(/[\s,]+/).filter(Boolean);
  if (!parts.length) throw new Error('Give a subnet, such as 10.0.0.0/16.');
  let [addr, len] = parts[0].split('/');
  let rest = parts.slice(1);
  if (len === undefined && rest[0] && maskToPrefix(rest[0]) !== null && net.isIPv4(addr)) {
    len = String(maskToPrefix(rest[0]));
    rest = rest.slice(1);
  }
  const a = parseAddr(addr);
  if (!a) throw new Error(`"${addr}" is not an IPv4 or IPv6 address.`);
  const prefix = len === undefined ? a.bits : Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > a.bits) {
    throw new Error(`The prefix must be 0–${a.bits} for IPv${a.family}.`);
  }
  const all = (1n << BigInt(a.bits)) - 1n;
  const hostMask = (1n << BigInt(a.bits - prefix)) - 1n;
  const netMask = all ^ hostMask;
  const network = a.n & netMask;
  const last = network | hostMask;
  const total = hostMask + 1n;

  // IPv4 keeps its network and broadcast out of the usable range, except for
  // the point-to-point /31 and the single-host /32 (RFC 3021).
  let first = network;
  let lastUsable = last;
  let usable = total;
  if (a.family === 4 && prefix <= 30) { first = network + 1n; lastUsable = last - 1n; usable = total - 2n; }

  const out = {
    family: a.family,
    input: parts[0],
    cidr: `${fmt(a.family, network)}/${prefix}`,
    prefix,
    network: fmt(a.family, network),
    hostBitsSet: a.n !== network,
    first: fmt(a.family, first),
    last: fmt(a.family, lastUsable),
    total: total.toString(),
    usable: usable.toString(),
  };
  if (a.family === 4) {
    out.netmask = bigToV4(netMask);
    out.wildcard = bigToV4(hostMask);
    out.broadcast = prefix <= 30 ? bigToV4(last) : null;
    out.kind = v4Kind(network, prefix);
  } else {
    out.lastAddress = fmt(6, last);
  }

  const probe = check || rest[0];
  if (probe) {
    const p = parseAddr(probe);
    if (!p) throw new Error(`"${probe}" is not an address to check.`);
    out.check = { address: probe, inside: p.family === a.family && (p.n & netMask) === network };
  }
  return out;
}

function v4Kind(n, prefix) {
  const inside = (base, len) => prefix >= len && (n >> BigInt(32 - len)) === (v4ToBig(base) >> BigInt(32 - len));
  if (inside('10.0.0.0', 8) || inside('172.16.0.0', 12) || inside('192.168.0.0', 16)) return 'private (RFC 1918)';
  if (inside('100.64.0.0', 10)) return 'carrier-grade NAT (RFC 6598)';
  if (inside('127.0.0.0', 8)) return 'loopback';
  if (inside('169.254.0.0', 16)) return 'link-local';
  if (inside('224.0.0.0', 4)) return 'multicast';
  return prefix >= 8 ? 'public' : '';
}

/* ------------------------------------------------------------------ */
/* URL                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Both directions at once, so there is nothing to choose: what the text is
 * encoded, what it is decoded (when it decodes), and — for a whole URL — its
 * parts with the query taken apart.
 */
function url(input) {
  const text = String(input ?? '');
  if (!text) throw new Error('Paste some text or a URL.');
  let decoded = null;
  try {
    const d = decodeURIComponent(text.replace(/\+/g, ' '));
    if (d !== text) decoded = d;
  } catch { /* a stray % is simply not encoded text */ }
  const out = {
    encoded: encodeURIComponent(text),
    encodedUrl: encodeURI(text),
    decoded,
  };
  try {
    const u = new URL(text.trim());
    out.parts = {
      protocol: u.protocol.replace(/:$/, ''),
      username: u.username ? decodeURIComponent(u.username) : null,
      host: u.hostname,
      port: u.port || null,
      path: decodeURIComponent(u.pathname),
      fragment: u.hash ? decodeURIComponent(u.hash.slice(1)) : null,
    };
    out.query = [...u.searchParams.entries()].map(([k, v]) => ({ key: k, value: v }));
  } catch { /* not a URL: the encodings are the answer */ }
  return out;
}

/* ------------------------------------------------------------------ */
/* JWT                                                                 */
/* ------------------------------------------------------------------ */

function b64urlJson(part, what) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new Error(`The ${what} is not base64url-encoded JSON.`);
  }
}

const TIME_CLAIMS = ['exp', 'nbf', 'iat', 'auth_time'];

/**
 * A JWT's header and claims, its times in words, and what it looks like it
 * is. The signature is reported, not verified: that needs the issuer's key,
 * which a pasted token does not come with.
 */
function jwt(input, { now = Date.now() } = {}) {
  const token = String(input || '').trim().replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length === 5) throw new Error('That is an encrypted JWT (JWE) — it cannot be read without the key.');
  if (parts.length !== 3) throw new Error('A JWT has three parts separated by dots.');
  const header = b64urlJson(parts[0], 'header');
  const payload = b64urlJson(parts[1], 'payload');
  const times = {};
  for (const k of TIME_CLAIMS) {
    if (typeof payload[k] === 'number') times[k] = new Date(payload[k] * 1000).toISOString();
  }
  let state = 'valid';
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= now) state = 'expired';
  else if (typeof payload.nbf === 'number' && payload.nbf * 1000 > now) state = 'not yet valid';
  const sub = String(payload.sub || '');
  const kind = sub.startsWith('spiffe://') ? 'JWT-SVID (SPIFFE)'
    : (payload.roles || payload.traits) && payload.username ? 'Teleport application token'
      : '';
  return {
    header, payload, times, state, kind,
    claims: readableClaims(payload),
    raw: { header: parts[0], payload: parts[1], signature: parts[2] },
    expiresIn: typeof payload.exp === 'number' ? Math.round(payload.exp - now / 1000) : null,
    signature: { alg: header.alg || null, bytes: Buffer.from(parts[2], 'base64url').length, verified: false },
  };
}

/** Registered claim names, spelled out. */
const CLAIM_NAMES = {
  iss: 'Issuer', sub: 'Subject', aud: 'Audience', exp: 'Expires', nbf: 'Not before',
  iat: 'Issued', jti: 'Token ID', azp: 'Authorised party', auth_time: 'Authenticated',
  username: 'User', email: 'Email', name: 'Name', scope: 'Scope', scp: 'Scope',
};

/**
 * The claims in reading order — who issued it and to whom first, then times,
 * then everything else. Lists stay lists; roles and traits, which Teleport
 * puts in its application tokens, come out separately as they do for an SSH
 * certificate.
 */
function readableClaims(payload) {
  const order = ['iss', 'sub', 'aud', 'username', 'email', 'name', 'iat', 'nbf', 'exp', 'auth_time', 'jti'];
  const keys = [...order.filter((k) => k in payload), ...Object.keys(payload).filter((k) => !order.includes(k)).sort()];
  const out = { fields: [], roles: [], traits: [] };
  for (const k of keys) {
    const v = payload[k];
    if (k === 'roles' && Array.isArray(v)) { out.roles = v.map(String); continue; }
    if (k === 'traits' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.traits = Object.entries(v).map(([n, vals]) => ({
        name: n, values: (Array.isArray(vals) ? vals : [vals]).filter((x) => x !== '' && x !== null).map(String),
      })).sort((a, b) => a.name.localeCompare(b.name));
      continue;
    }
    out.fields.push({
      key: k,
      name: CLAIM_NAMES[k] || k,
      time: TIME_CLAIMS.includes(k) && typeof v === 'number' ? new Date(v * 1000).toISOString() : null,
      list: Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))) : null,
      value: Array.isArray(v) ? null : (v && typeof v === 'object' ? JSON.stringify(v) : String(v)),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* SSH certificate                                                     */
/* ------------------------------------------------------------------ */

function reader(buf) {
  let o = 0;
  const need = (n) => { if (o + n > buf.length) throw new Error('The certificate is cut short.'); };
  return {
    u32() { need(4); const v = buf.readUInt32BE(o); o += 4; return v; },
    u64() { need(8); const v = buf.readBigUInt64BE(o); o += 8; return v; },
    bytes() { const n = this.u32(); need(n); const v = buf.subarray(o, o + n); o += n; return v; },
    str() { return this.bytes().toString('utf8'); },
    done() { return o >= buf.length; },
  };
}

/** The name/value pairs of critical options or extensions. */
function optionList(blob) {
  const r = reader(blob);
  const out = [];
  while (!r.done()) {
    const name = r.str();
    const data = r.bytes();
    // A value is itself wrapped in a string; most extensions carry none.
    let value = '';
    if (data.length >= 4 && data.readUInt32BE(0) === data.length - 4) value = data.subarray(4).toString('utf8');
    else if (data.length) value = data.toString('utf8');
    out.push({ name, value });
  }
  return out;
}

const KEY_FIELDS = {
  'ssh-rsa': ['e', 'n'],
  'ssh-dss': ['p', 'q', 'g', 'y'],
  'ecdsa-sha2-nistp256': ['curve', 'q'],
  'ecdsa-sha2-nistp384': ['curve', 'q'],
  'ecdsa-sha2-nistp521': ['curve', 'q'],
  'ssh-ed25519': ['pk'],
  'sk-ecdsa-sha2-nistp256@openssh.com': ['curve', 'q', 'application'],
  'sk-ssh-ed25519@openssh.com': ['pk', 'application'],
};

const FOREVER = 0xffffffffffffffffn;

function fingerprint(blob) {
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

/**
 * An OpenSSH certificate, as `ssh-keygen -L` would print it, from the
 * `...-cert.pub` line or just its base64. Teleport's own extensions (roles,
 * traits, the route to the cluster) come through as they are.
 */
function sshCert(input, { now = Date.now() } = {}) {
  const text = String(input || '').trim();
  const fields = text.split(/\s+/);
  const b64 = fields.find((f) => /^AAAA[0-9A-Za-z+/=]+$/.test(f));
  if (!b64) throw new Error('Paste the certificate line from a -cert.pub file.');
  const blob = Buffer.from(b64, 'base64');
  const r = reader(blob);
  const certType = r.str();
  const m = certType.match(/^(.*)-cert-v01@openssh\.com$/);
  if (!m) throw new Error(`"${certType}" is a plain key, not a certificate.`);
  const keyType = m[1];
  const spec = KEY_FIELDS[keyType];
  if (!spec) throw new Error(`Unknown certificate key type ${keyType}.`);
  r.bytes(); // nonce
  // The certified public key, re-wrapped as a plain key to fingerprint it.
  const keyParts = spec.map(() => r.bytes());
  const plain = Buffer.concat([keyType, ...keyParts].map((p) => {
    const b = Buffer.isBuffer(p) ? p : Buffer.from(p);
    const len = Buffer.alloc(4); len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  }));
  const serial = r.u64();
  const type = r.u32();
  const keyId = r.str();
  const pr = reader(r.bytes());
  const principals = [];
  while (!pr.done()) principals.push(pr.str());
  const after = r.u64();
  const before = r.u64();
  const critical = optionList(r.bytes());
  const extensions = optionList(r.bytes());
  r.bytes(); // reserved
  const caBlob = r.bytes();
  const caType = reader(caBlob).str();
  let sigAlg = '';
  try { sigAlg = reader(r.bytes()).str(); } catch { /* a cut-short signature still decodes the rest */ }

  const t = (v) => (v === FOREVER ? 'forever' : new Date(Number(v) * 1000).toISOString());
  const nowS = BigInt(Math.floor(now / 1000));
  const state = nowS < after ? 'not yet valid' : (before !== FOREVER && nowS >= before ? 'expired' : 'valid');
  const teleport = extensions.filter((e) => /teleport|^login@/.test(e.name));
  const typeName = type === 1 ? 'user' : type === 2 ? 'host' : `unknown (${type})`;
  const out = {
    type: typeName,
    keyType,
    keyFingerprint: fingerprint(plain),
    serial: serial.toString(),
    keyId,
    principals,
    validAfter: t(after),
    validBefore: t(before),
    state,
    expiresIn: before === FOREVER ? null : Number(before - nowS),
    critical,
    extensions,
    teleport: teleport.length > 0,
    ca: { type: caType, fingerprint: fingerprint(caBlob), signatureAlgorithm: sigAlg },
    comment: fields.length > 2 ? fields.slice(2).join(' ') : '',
    readable: readableExtensions(extensions, critical),
  };
  out.raw = keygenListing(certType, out, { after, before });
  return out;
}

/** What each `permit-*` extension lets the holder do, in words. */
const PERMITS = {
  'permit-pty': 'Interactive terminal',
  'permit-port-forwarding': 'Port forwarding',
  'permit-agent-forwarding': 'Agent forwarding',
  'permit-X11-forwarding': 'X11 forwarding',
  'permit-user-rc': 'Run ~/.ssh/rc',
  'no-touch-required': 'No security-key touch',
  'verify-required': 'Security-key PIN',
};

/** Teleport's extensions, with names a person would use. */
const TELEPORT_NAMES = {
  'teleport-route-to-cluster': 'Cluster',
  'login-ip': 'Login IP',
  'private-key-policy': 'Private key policy',
  'teleport-active-requests': 'Active access requests',
  'teleport-allowed-resources': 'Allowed resources',
  'teleport-previous-identity-expires': 'Previous identity expires',
  'teleport-disallow-reissue': 'Reissue',
  'teleport-renewable': 'Renewable',
  'teleport-generation': 'Generation',
  'teleport-impersonator': 'Impersonated by',
  'teleport-bot': 'Machine ID bot',
  'teleport-bot-instance-id': 'Bot instance',
  'teleport-join-token': 'Join token',
  'teleport-pin-ip': 'Pinned to IP',
  'teleport-mfa-verified': 'MFA verified',
  'teleport-connection-diagnostic-id': 'Connection diagnostic',
  'teleport-request-reason': 'Request reason',
};

function parseJson(v) {
  try { return JSON.parse(v); } catch { return null; }
}

/**
 * The extensions sorted into what a reader asks about: what the certificate
 * lets you do, which roles and traits Teleport put in it, the device it is
 * bound to, and anything else. Values that are JSON are parsed; names lose
 * their `@domain` and `teleport-` noise.
 */
function readableExtensions(extensions, critical) {
  const out = { permissions: [], roles: [], traits: [], device: [], teleport: [], other: [], restrictions: [] };
  for (const { name, value } of extensions) {
    const bare = name.replace(/@[^@]+$/, '');
    if (PERMITS[bare]) { out.permissions.push(PERMITS[bare]); continue; }
    if (bare === 'teleport-roles') {
      const j = parseJson(value);
      out.roles = Array.isArray(j?.roles) ? j.roles : (value ? [value] : []);
      continue;
    }
    if (bare === 'teleport-traits') {
      const j = parseJson(value) || {};
      out.traits = Object.entries(j)
        .map(([k, v]) => ({ name: k, values: (Array.isArray(v) ? v : [v]).filter((x) => x !== '' && x !== null).map(String) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      continue;
    }
    if (bare.startsWith('teleport-device-')) {
      const label = { 'teleport-device-id': 'Device ID', 'teleport-device-asset-tag': 'Asset tag',
        'teleport-device-credential-id': 'Credential ID' }[bare] || bare.replace('teleport-device-', '');
      out.device.push({ name: label, value });
      continue;
    }
    if (TELEPORT_NAMES[bare] || bare.startsWith('teleport-')) {
      const j = value && /^[[{]/.test(value) ? parseJson(value) : null;
      const label = TELEPORT_NAMES[bare] || bare.replace(/^teleport-/, '').replace(/-/g, ' ');
      out.teleport.push({ name: label[0].toUpperCase() + label.slice(1), value: j ? JSON.stringify(j) : (value || 'yes') });
      continue;
    }
    out.other.push({ name, value });
  }
  for (const { name, value } of critical) {
    const label = { 'force-command': 'Only runs', 'source-address': 'Only from' }[name] || name;
    out.restrictions.push({ name: label, value: value || '(set)' });
  }
  return out;
}

/** The way `ssh-keygen -L` lays a certificate out, for the Raw view. */
function keygenListing(certType, c, { after, before }) {
  const algo = (t) => ({
    'ssh-ed25519': 'ED25519', 'ssh-rsa': 'RSA', 'ssh-dss': 'DSA',
    'sk-ssh-ed25519@openssh.com': 'ED25519-SK', 'sk-ecdsa-sha2-nistp256@openssh.com': 'ECDSA-SK',
  })[t] || (t.startsWith('ecdsa-') ? 'ECDSA' : t.toUpperCase());
  // Local time without a zone, as ssh-keygen prints it.
  const ts = (v) => {
    if (v === FOREVER) return 'forever';
    const d = new Date(Number(v) * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const list = (items) => (items.length ? '\n' + items.map((x) => '                ' + x).join('\n') : ' (none)');
  return [
    `Type: ${certType} ${c.type} certificate`,
    `Public key: ${algo(c.keyType)}-CERT ${c.keyFingerprint}`,
    `Signing CA: ${algo(c.ca.type)} ${c.ca.fingerprint}${c.ca.signatureAlgorithm ? ` (using ${c.ca.signatureAlgorithm})` : ''}`,
    `Key ID: "${c.keyId}"`,
    `Serial: ${c.serial}`,
    `Valid: ${after === 0n && before === FOREVER ? 'forever' : `from ${ts(after)} to ${ts(before)}`}`,
    `Principals:${list(c.principals)}`,
    `Critical Options:${list(c.critical.map((o) => `${o.name} ${o.value}`.trim()))}`,
    `Extensions:${list(c.extensions.map((o) => `${o.name} ${o.value}`.trim()))}`,
  ].map((l) => '        ' + l).join('\n');
}

/**
 * The SSH certificates tsh has issued, under each Teleport home, so the
 * decoder can offer "mine" rather than asking for a paste.
 * Laid out as `<home>/keys/<proxy>/<user>-ssh/<cluster>-cert.pub`.
 */
async function tshCertificates(homes = []) {
  const out = [];
  for (const home of homes) {
    const keys = path.join(home, 'keys');
    let proxies = [];
    try { proxies = await fsp.readdir(keys); } catch { continue; }
    for (const proxy of proxies) {
      let dirs = [];
      try { dirs = await fsp.readdir(path.join(keys, proxy)); } catch { continue; }
      for (const d of dirs.filter((x) => x.endsWith('-ssh'))) {
        let files = [];
        try { files = await fsp.readdir(path.join(keys, proxy, d)); } catch { continue; }
        for (const f of files.filter((x) => x.endsWith('-cert.pub'))) {
          const file = path.join(keys, proxy, d, f);
          out.push({
            proxy, user: d.replace(/-ssh$/, ''), cluster: f.replace(/-cert\.pub$/, ''), home, file,
            mtime: fs.statSync(file).mtimeMs,
          });
        }
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/* ------------------------------------------------------------------ */
/* SPIFFE X.509-SVID                                                   */
/* ------------------------------------------------------------------ */

function pemBlocks(text) {
  const blocks = String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (blocks) return blocks;
  // Bare base64 DER, as some tools print it.
  const b64 = String(text).replace(/\s+/g, '');
  if (/^MI[0-9A-Za-z+/=]+$/.test(b64)) return [Buffer.from(b64, 'base64')];
  return [];
}

/**
 * An X.509-SVID and any chain pasted with it: who it names, who issued it,
 * when it is good for, and whether it keeps the SPIFFE rules — one URI SAN
 * that is a spiffe:// ID, a leaf that is not a CA. Each certificate is also
 * checked against the next one in the paste, which is as far as a chain can
 * be followed without the trust bundle.
 */
function svid(input, { now = Date.now() } = {}) {
  const blocks = pemBlocks(input);
  if (!blocks.length) {
    if (/^ey/.test(String(input).trim())) throw new Error('That is a JWT — use the JWT decoder for a JWT-SVID.');
    throw new Error('Paste a PEM certificate (-----BEGIN CERTIFICATE-----).');
  }
  const certs = blocks.map((b) => new crypto.X509Certificate(b));
  const pem = certs.map((c) => c.toString().trim()).join('\n');
  const described = certs.map((c, i) => {
    const sans = (c.subjectAltName || '').split(/,\s*/).filter(Boolean);
    const uris = sans.filter((s) => s.startsWith('URI:')).map((s) => s.slice(4));
    const spiffe = uris.filter((u) => u.startsWith('spiffe://'));
    const from = Date.parse(c.validFrom);
    const to = Date.parse(c.validTo);
    const problems = [];
    if (i === 0) {
      if (!spiffe.length) problems.push('No spiffe:// URI in the subject alternative names.');
      if (uris.length > 1) problems.push('An SVID carries exactly one URI SAN; this has ' + uris.length + '.');
      if (c.ca) problems.push('A leaf SVID must not be a CA certificate.');
      for (const id of spiffe) {
        const mm = id.match(/^spiffe:\/\/([^/]+)(\/.*)?$/);
        if (!mm) problems.push(`${id} is not a well-formed SPIFFE ID.`);
        else {
          if (mm[1] !== mm[1].toLowerCase()) problems.push('The trust domain must be lower case.');
          if (!mm[2] || mm[2] === '/') problems.push('A workload SVID needs a path after the trust domain.');
        }
      }
    }
    const next = certs[i + 1];
    return {
      subject: c.subject.replace(/\n/g, ', '),
      issuer: c.issuer.replace(/\n/g, ', '),
      spiffeId: spiffe[0] || null,
      sans,
      serial: c.serialNumber,
      validFrom: new Date(from).toISOString(),
      validTo: new Date(to).toISOString(),
      state: now < from ? 'not yet valid' : now >= to ? 'expired' : 'valid',
      expiresIn: Math.round((to - now) / 1000),
      ca: c.ca,
      keyUsage: c.keyUsage || [],
      publicKey: c.publicKey.asymmetricKeyType + (c.publicKey.asymmetricKeyDetails?.namedCurve
        ? ' ' + c.publicKey.asymmetricKeyDetails.namedCurve
        : c.publicKey.asymmetricKeyDetails?.modulusLength ? ' ' + c.publicKey.asymmetricKeyDetails.modulusLength : ''),
      fingerprint256: c.fingerprint256,
      signedByNext: next ? c.checkIssued(next) && c.verify(next.publicKey) : null,
      problems,
    };
  });
  return { certificates: described, spiffeId: described[0].spiffeId, ok: !described[0].problems.length, pem };
}

module.exports = { cidr, url, jwt, sshCert, svid, tshCertificates, maskToPrefix, bigToV6, v6ToBig };
