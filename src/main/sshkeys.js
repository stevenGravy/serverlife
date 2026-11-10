'use strict';
/**
 * SSH key and known_hosts management.
 *
 * Covers the three things a client is normally asked for and that otherwise
 * send you back to a terminal: seeing which keys you have, installing a public
 * key on a server, and clearing a stale host key after a rebuild.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const pty = require('node-pty');
const sshbin = require('./sshbin');

const SSH_DIR = path.join(os.homedir(), '.ssh');
const KNOWN_HOSTS = path.join(SSH_DIR, 'known_hosts');

/**
 * Run an OpenSSH tool.
 *
 * The name is resolved through the same search that finds `ssh`, and the
 * binary's directory is put on PATH, because on Windows none of these are
 * reachable from a GUI process by name alone. A missing binary comes back as
 * `{ ok: false, missing: true }` rather than as a rejection: every caller here
 * has something sensible to say about "there is no ssh client", and nothing
 * sensible to say about an ENOENT from a child process.
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(sshbin.findTool(cmd), args, {
      timeout: opts.timeout || 20000,
      maxBuffer: 8 * 1024 * 1024,
      env: sshbin.sshEnv(),
      windowsHide: true,
    }, (err, stdout, stderr) => resolve({
      ok: !err,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
      code: err?.code ?? 0,
      missing: err?.code === 'ENOENT',
    }));
  });
}

/** Read the fingerprint and comment of a key file. */
async function describeKey(pubPath) {
  const r = await run('ssh-keygen', ['-l', '-f', pubPath]);
  if (!r.ok) return null;
  // Format: "<bits> <hash> <comment> (<TYPE>)"
  const m = r.stdout.trim().match(/^(\d+)\s+(\S+)\s+(.*?)\s+\(([^)]+)\)$/);
  if (!m) return { fingerprint: r.stdout.trim() };
  return { bits: Number(m[1]), fingerprint: m[2], comment: m[3], type: m[4] };
}

/**
 * Whether an OpenSSH-v1 private key ("-----BEGIN OPENSSH PRIVATE KEY-----")
 * needs a passphrase, read from the length-prefixed cipher-name field right
 * after the format's magic bytes, rather than by scanning the decoded header
 * for the substring "none". A plain substring search can't tell "none" apart
 * from a cipher name that happens to contain it, and — more realistically —
 * can be fooled by a key's own `-C` comment further down the same decoded
 * bytes (nothing stops someone naming a key "none-prod-bastion").
 * Returns null when the header isn't (yet) enough to tell, not a guess.
 */
function opensshKeyEncrypted(headerText) {
  const b64 = headerText.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
  let raw;
  try { raw = Buffer.from(b64, 'base64'); } catch { return null; }
  const MAGIC = Buffer.from('openssh-key-v1\0', 'latin1');
  if (raw.length < MAGIC.length + 4 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const len = raw.readUInt32BE(MAGIC.length);
  const start = MAGIC.length + 4;
  // A real cipher name is short ("none", "aes256-ctr", …); anything longer
  // than this means the header this ran on didn't include the whole field.
  if (len > 64 || start + len > raw.length) return null;
  return raw.subarray(start, start + len).toString('latin1') !== 'none';
}

/**
 * Every keypair in ~/.ssh, identified by the presence of a .pub file whose
 * private counterpart also exists.
 */
async function listKeys() {
  let names;
  try { names = await fsp.readdir(SSH_DIR); } catch { return []; }

  const out = [];
  for (const name of names) {
    if (!name.endsWith('.pub')) continue;
    const pub = path.join(SSH_DIR, name);
    const priv = pub.slice(0, -4);
    let hasPrivate = false;
    let privMode = null;
    try {
      const st = await fsp.stat(priv);
      hasPrivate = st.isFile();
      privMode = st.mode & 0o777;
    } catch { /* no private key beside it */ }

    const info = await describeKey(pub);
    let publicKey = '';
    try { publicKey = (await fsp.readFile(pub, 'utf8')).trim(); } catch { /* no public key beside it */ }

    /*
     * Whether the private key is passphrase-protected, read from its own
     * header rather than by asking ssh-keygen. `ssh-keygen -y -P ''` would be
     * authoritative, but it is a subprocess per key, and for an encrypted
     * OpenSSH key it is also indistinguishable from a dozen other failures.
     * The header says it plainly:
     *   - OpenSSH format: the cipher-name field after the magic bytes.
     *   - Old PEM format: a `Proc-Type: 4,ENCRYPTED` line.
     */
    let encrypted = null;
    if (hasPrivate) {
      try {
        const head = (await fsp.readFile(priv)).subarray(0, 1024);
        const text = head.toString('latin1');
        encrypted = text.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')
          ? opensshKeyEncrypted(text)
          : /Proc-Type:\s*4,ENCRYPTED/i.test(text);
      } catch { encrypted = null; }
    }

    let mtime = null;
    try { mtime = (await fsp.stat(pub)).mtimeMs; } catch { /* no public key beside it */ }

    out.push({
      name: path.basename(priv),
      publicPath: pub,
      privatePath: hasPrivate ? priv : null,
      hasPrivate,
      privMode,
      encrypted,
      mtime,
      // 0600 is what sshd insists on; anything looser is silently ignored.
      permissionsOk: privMode === null || privMode === 0o600 || privMode === 0o400,
      publicKey,
      ...(info || {}),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Keys currently loaded into the agent. */
async function agentKeys() {
  // A wedged agent socket should not stall the dialog.
  const r = await run('ssh-add', ['-l'], { timeout: 6000 });
  if (!r.ok) {
    // No ssh-add at all is a different problem from an agent that is not
    // answering, and only one of them is fixed by starting an agent.
    if (r.missing) {
      return {
        running: false, keys: [], missing: true,
        error: 'ssh-add was not found on this machine',
      };
    }
    const text = (r.stdout + r.stderr).toLowerCase();
    if (text.includes('no identities')) return { running: true, keys: [] };
    return { running: false, keys: [], error: (r.stderr || r.stdout).trim() };
  }
  const keys = r.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^(\d+)\s+(\S+)\s+(.*?)\s+\(([^)]+)\)$/);
    return m
      ? { bits: Number(m[1]), fingerprint: m[2], comment: m[3], type: m[4] }
      : { fingerprint: line };
  });
  return { running: true, keys };
}

/** Does this key need a passphrase? */
async function isEncrypted(privatePath) {
  const r = await run('ssh-keygen', ['-y', '-P', '', '-f', privatePath], { timeout: 8000 });
  return !r.ok;
}

/**
 * Add a key to the agent, or load every identity off a PKCS#11 token.
 *
 * `ssh-add` asks for a passphrase (or, for a token, its PIN) on its
 * controlling terminal; spawned from a GUI app there is none, so it falls
 * back to SSH_ASKPASS and either launches something unexpected or fails with
 * a confusing message — and with no askpass at all it simply blocks. Running
 * it under a PTY with askpass disabled keeps the prompt where we can answer
 * it.
 *
 * @param privatePath a key file, or null for the default identities —
 *   ignored when `pkcs11Provider` is given, since `-s` names the token instead
 */
function addToAgent(privatePath, { passphrase = null, timeout = 30000, keychain = false, pkcs11Provider = null } = {}) {
  return new Promise((resolve) => {
    /*
     * `pty.spawn` of a binary that is not there throws, synchronously, out of
     * this executor — so check first and answer in the shape every caller
     * already handles. On Windows the OpenSSH client is an optional feature and
     * this is a normal state, not a broken install.
     */
    if (!sshbin.toolAvailable('ssh-add')) {
      return resolve({
        ok: false,
        missing: true,
        output: process.platform === 'win32'
          ? 'ssh-add was not found. The OpenSSH client is an optional Windows '
            + 'feature — install it, or set the ssh path in Settings.'
          : 'ssh-add was not found on this machine.',
      });
    }

    /*
     * No path means plain `ssh-add`, which loads the default identities
     * (~/.ssh/id_ed25519, id_rsa and friends) — the command people actually
     * type when a host starts refusing them. `-s <provider>` is the other
     * shape entirely: every identity a PKCS#11 token (a YubiKey's PIV applet,
     * a smart card) holds, loaded through its provider library rather than
     * from a file.
     *
     * `--apple-use-keychain` additionally stores the passphrase in the login
     * keychain so the key survives a reboot. It exists only on Apple's fork,
     * so it is opt-in and the caller decides.
     */
    const args = [];
    if (keychain && process.platform === 'darwin') args.push('--apple-use-keychain');
    if (pkcs11Provider) args.push('-s', pkcs11Provider);
    else if (privatePath) args.push(privatePath);

    let term;
    try {
      term = pty.spawn(sshbin.findTool('ssh-add'), args, {
        name: 'xterm-256color', cols: 80, rows: 24,
        // sshEnv puts the binary's own directory on PATH, which is what lets
        // ssh-add find the agent helpers beside it on Windows.
        env: sshbin.sshEnv({
          // Force the TTY path rather than an askpass helper.
          SSH_ASKPASS_REQUIRE: 'never',
          SSH_ASKPASS: '',
          DISPLAY: '',
        }),
      });
    } catch (e) {
      // The check above should have caught this, but a binary can vanish
      // between the two, and a throw here would escape as an IPC rejection.
      return resolve({ ok: false, missing: true, output: `Could not run ssh-add: ${e.message}` });
    }

    // A token's PIN prompt reads "Enter PIN for 'token label':" rather than
    // ssh-add's usual "Enter passphrase for …:" — same ceremony, different
    // word, so the prompt this run is actually waiting for depends on which
    // kind of identity it is.
    const promptRe = pkcs11Provider ? /enter pin/i : /passphrase/i;
    const wrongRe = pkcs11Provider ? /incorrect pin|wrong pin/i : /bad passphrase|incorrect passphrase/i;

    let out = '';
    // How much of `out` has already been examined for a prompt. Plain `ssh-add`
    // walks every default identity and prompts for each encrypted one, so a
    // single "have I answered?" flag would answer the first and then sit there
    // until the timeout with the second prompt unanswered.
    let seen = 0;
    const finish = (ok, extra) => {
      clearTimeout(timer);
      try { term.kill(); } catch { /* the process may already have exited */ }
      // eslint-disable-next-line no-control-regex
      const text = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim();
      resolve({ ok, output: extra || text, needsPassphrase: !ok && promptRe.test(text) && !passphrase });
    };

    const timer = setTimeout(() => finish(false, 'ssh-add did not finish in time'), timeout);

    term.onData((d) => {
      out += d;
      const fresh = out.slice(seen);
      if (promptRe.test(fresh)) {
        seen = out.length;
        if (passphrase === null) {
          // Nothing to type; stop rather than leaving it waiting.
          return finish(false, pkcs11Provider
            ? 'This PKCS#11 token needs its PIN'
            : (privatePath
              ? 'This key is protected by a passphrase'
              : 'One of the default keys is protected by a passphrase — add it on its own to enter it'));
        }
        term.write(passphrase + '\r');
      }
      if (wrongRe.test(out)) finish(false, pkcs11Provider ? 'Incorrect PIN' : 'Incorrect passphrase');
    });

    term.onExit(({ exitCode }) => finish(exitCode === 0));
  });
}

const SECURITY_KEY_TYPES = ['ed25519-sk', 'ecdsa-sk'];

/**
 * Generate a FIDO2/security-key-backed keypair.
 *
 * `-sk` types are not a file ssh-keygen just writes: it talks to the token
 * itself, by way of the platform's FIDO2 middleware. That normally means a
 * "touch your security key" wait and, for a token with a PIN set, a PIN
 * prompt on ssh-keygen's own controlling terminal — neither of which is a
 * flag it takes, so this runs under a PTY and answers the PIN prompt the
 * same way `addToAgent` answers ssh-add's passphrase prompt.
 */
function generateSecurityKey(args, pin) {
  return new Promise((resolve) => {
    if (!sshbin.toolAvailable('ssh-keygen')) {
      return resolve({ ok: false, missing: true, output: 'ssh-keygen was not found on this machine.' });
    }
    let term;
    try {
      term = pty.spawn(sshbin.findTool('ssh-keygen'), args, {
        name: 'xterm-256color', cols: 80, rows: 24, env: sshbin.sshEnv(),
      });
    } catch (e) {
      return resolve({ ok: false, output: `Could not run ssh-keygen: ${e.message}` });
    }

    let out = '';
    let seen = 0;
    let pinSent = false;
    const finish = (ok, extra) => {
      clearTimeout(timer);
      try { term.kill(); } catch { /* the process may already have exited */ }
      // eslint-disable-next-line no-control-regex
      const text = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim();
      resolve({ ok, output: extra || text, needsPin: !ok && pin === null && /pin/i.test(text) });
    };
    // Generous: a real touch can wait on someone walking over to their key.
    const timer = setTimeout(() => finish(false, 'Timed out waiting on the security key'), 120000);

    term.onData((d) => {
      out += d;
      const fresh = out.slice(seen);
      if (!pinSent && /enter pin/i.test(fresh)) {
        seen = out.length;
        if (pin === null) return finish(false, 'This security key needs its PIN');
        pinSent = true;
        term.write(pin + '\r');
      }
      if (/incorrect pin|wrong pin/i.test(fresh)) finish(false, 'Incorrect PIN');
    });

    term.onExit(({ exitCode }) => finish(exitCode === 0));
  });
}

/**
 * Create a new keypair.
 *
 * `resident`/`verifyRequired`/`pin` only mean anything for a `-sk` type —
 * see generateSecurityKey() for why those need a PTY rather than a flag.
 */
async function generateKey({
  name, type = 'ed25519', bits, comment, passphrase = '',
  resident = false, verifyRequired = false, pin = null,
} = {}) {
  if (!name || /[/\\]/.test(name)) throw new Error('Give the key a simple file name');
  await fsp.mkdir(SSH_DIR, { recursive: true, mode: 0o700 });
  const target = path.join(SSH_DIR, name);
  if (fs.existsSync(target) || fs.existsSync(target + '.pub')) {
    throw new Error(`${name} already exists`);
  }

  const securityKey = SECURITY_KEY_TYPES.includes(type);
  if (securityKey && !sshbin.supportsFeature('securityKeyIdentities')) {
    const v = sshbin.sshVersion();
    throw new Error(`This machine's ssh-keygen${v?.raw ? ` (${v.raw})` : ''} is too old for FIDO2 security-key `
      + 'keys — OpenSSH 8.2 or later is needed.');
  }

  const args = ['-t', type, '-f', target, '-N', passphrase, '-C', comment || `${os.userInfo().username}@${os.hostname()}`];
  if (type === 'rsa') args.push('-b', String(bits || 4096));
  if (securityKey) {
    if (resident) args.push('-O', 'resident');
    if (verifyRequired) args.push('-O', 'verify-required');
  }
  // ssh-keygen is interactive unless -N is supplied, which it is above — the
  // one exception being a security key's own PIN/touch ceremony, handled
  // separately since it is interactive regardless.
  const r = securityKey
    ? await generateSecurityKey(args, pin)
    : await run('ssh-keygen', args, { timeout: 120000 });
  if (!r.ok) throw new Error((r.stderr || r.stdout || r.output || 'ssh-keygen failed').trim());

  await fsp.chmod(target, 0o600).catch(() => {});
  const info = await describeKey(target + '.pub');
  const publicKey = (await fsp.readFile(target + '.pub', 'utf8')).trim();
  return { name, privatePath: target, publicPath: target + '.pub', publicKey, securityKey, ...(info || {}) };
}

/**
 * Install a public key in a server's authorized_keys, the way ssh-copy-id
 * does, but over an existing connection so it needs no extra authentication.
 *
 * @param exec a function running a command on the target and resolving stdout
 */
async function installPublicKey(exec, publicKey) {
  const key = String(publicKey).trim();
  if (!/^(ssh|ecdsa|sk-)\S+\s+\S+/.test(key)) throw new Error('That does not look like a public key');

  // Append only if absent, and fix up the permissions sshd requires.
  const script = [
    'set -e',
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    'chmod 600 ~/.ssh/authorized_keys',
    `if grep -qF ${shellQuote(key)} ~/.ssh/authorized_keys 2>/dev/null; then`,
    '  echo already-present',
    'else',
    `  printf '%s\\n' ${shellQuote(key)} >> ~/.ssh/authorized_keys`,
    '  echo installed',
    'fi',
  ].join('\n');

  const out = await exec(script);
  const result = out.trim().split('\n').pop();
  return { installed: result === 'installed', alreadyPresent: result === 'already-present' };
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

/**
 * Host keys recorded for a hostname.
 *
 * Checked against `files`, defaulting to the one and only ~/.ssh/known_hosts
 * — but a host whose ssh_config entry sets its own `UserKnownHostsFile`
 * keeps its accepted key somewhere else entirely, and looking only in the
 * default file there would just say "nothing recorded" for a host that is
 * in fact pinned, leaving "forget the host key" with nothing to remove.
 */
async function knownHostEntries(host, files = [KNOWN_HOSTS]) {
  const targets = files && files.length ? files : [KNOWN_HOSTS];
  const out = [];
  for (const file of targets) {
    const r = await run('ssh-keygen', ['-F', host, '-f', file]);
    if (!r.ok || !r.stdout.trim()) continue;
    for (const line of r.stdout.trim().split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(/\s+/);
      out.push({ line, type: parts[1], key: (parts[2] || '').slice(0, 24) + '…', file });
    }
  }
  return out;
}

/**
 * Remove a host's key from known_hosts — the fix for "REMOTE HOST
 * IDENTIFICATION HAS CHANGED" after a server is rebuilt.
 *
 * Removes from every file in `files` that actually has an entry, so a host
 * pinned via a per-host `UserKnownHostsFile` is cleared there too, not left
 * behind while the default file is edited for nothing.
 */
async function forgetHost(host, files = [KNOWN_HOSTS]) {
  const before = await knownHostEntries(host, files);
  if (!before.length) return { removed: 0, host };
  const touched = [...new Set(before.map((e) => e.file))];
  let removed = 0;
  for (const file of touched) {
    const r = await run('ssh-keygen', ['-R', host, '-f', file], { timeout: 30000 });
    if (r.ok) removed += before.filter((e) => e.file === file).length;
  }
  return { removed, host, files: touched };
}

module.exports = {
  listKeys, agentKeys, addToAgent, isEncrypted, generateKey, installPublicKey,
  knownHostEntries, forgetHost, describeKey, SSH_DIR, KNOWN_HOSTS, opensshKeyEncrypted,
};
