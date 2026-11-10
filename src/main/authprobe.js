'use strict';
/**
 * Why an SSH login was refused, read out of `ssh -vv`.
 *
 * "Too many authentication failures" is the message people lose the most time
 * to, because it says nothing about the actual problem: the server closed the
 * connection after too many *attempts*, and the key that would have worked was
 * either further down the queue or never offered. sshd's `MaxAuthTries`
 * defaults to 6, and an agent with six keys in it spends the whole budget
 * before ssh gets to the `-i` you meant.
 *
 * So rather than reporting the server's sentence, this reproduces the attempt
 * verbosely and reports what was offered, in order, and what the server said to
 * each — which is the evidence needed to pick the one key to offer instead.
 *
 * It never authenticates: `-o BatchMode=yes` and no password, so the probe can
 * only ever get as far as the failure it is explaining.
 */

const { execFile } = require('child_process');
const sshbin = require('./sshbin');

/** Lines like `Offering public key: ED25519 SHA256:… agent` or `... /path/key`. */
const OFFER = /^debug\d*:\s+Offering (?:public key|RSA public key|host key)[:\s]+(.*)$/i;
const SEND = /^debug\d*:\s+Authentications that can continue:\s*(.*)$/i;
const TRYING = /^debug\d*:\s+Trying private key:\s*(.*)$/i;
const WILL_SEND = /^debug\d*:\s+Will attempt key:\s*(.*)$/i;
const ACCEPTED = /^debug\d*:\s+Server accepts key:\s*(.*)$/i;
const NEXT_METHOD = /^debug\d*:\s+Next authentication method:\s*(.*)$/i;

/**
 * Run one verbose, non-interactive attempt and summarise it.
 *
 * @param target  `user@host` or `host`
 * @param opts    { port, identityFile, proxyJump, identitiesOnly, extraOptions }
 */
function authProbe(target, opts = {}) {
  const args = ['-vv', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (opts.port && Number(opts.port) !== 22) args.push('-p', String(opts.port));
  if (opts.identityFile) {
    args.push('-i', opts.identityFile);
    // The point of the exercise, when a key has been named.
    if (opts.identitiesOnly !== false) args.push('-o', 'IdentitiesOnly=yes');
  }
  if (opts.proxyJump) args.push('-J', opts.proxyJump);
  for (const o of String(opts.extraOptions || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    args.push('-o', o.replace(/^-o\s*/, ''));
  }
  args.push(target, 'true');

  return new Promise((resolve) => {
    execFile(sshbin.findSsh(), args, {
      timeout: opts.timeout || 30000,
      maxBuffer: 4 * 1024 * 1024,
      env: sshbin.sshEnv ? sshbin.sshEnv() : process.env,
    }, (err, stdout, stderr) => {
      const text = String(stderr || '') + String(stdout || '');
      resolve({
        ok: !err,
        command: ['ssh', ...args].join(' '),
        transcript: text,
        ...summarise(text),
      });
    });
  });
}

/** The few facts worth reading out of a -vv transcript. */
function summarise(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const offered = [];
  const considered = [];
  let accepted = null;
  let methods = null;
  const methodsTried = [];

  for (const line of lines) {
    let m;
    if ((m = OFFER.exec(line))) { offered.push(m[1].trim()); continue; }
    if ((m = ACCEPTED.exec(line))) { accepted = m[1].trim(); continue; }
    if ((m = SEND.exec(line))) { methods = m[1].trim(); continue; }
    if ((m = TRYING.exec(line)) || (m = WILL_SEND.exec(line))) { considered.push(m[1].trim()); continue; }
    if ((m = NEXT_METHOD.exec(line))) { methodsTried.push(m[1].trim()); continue; }
  }

  const tooMany = /too many authentication failures/i.test(text);
  const denied = /permission denied/i.test(text);
  /*
   * Only a *named* identity file that ssh could not read. The transcript is
   * full of "could not open" for default paths that simply do not exist
   * (`~/.ssh/id_dsa` on a machine that never had one), and reporting those as
   * a problem sends people looking for a file they never wanted.
   */
  const missingIdentity = /identity file (.+?) not accessible/i.exec(text);

  return {
    offered,
    considered,
    accepted,
    methods,
    methodsTried,
    tooMany,
    denied,
    missingIdentity: missingIdentity ? missingIdentity[1].trim() : null,
    /*
     * sshd's MaxAuthTries defaults to 6 and counts every offer. More offers
     * than that with nothing accepted means the later ones were never
     * assessed — the single most useful thing this probe can report, and true
     * whether the server said "too many failures" or just "denied".
     */
    pastLimit: !accepted && offered.length > 6,
    // The server's own last word, which is what the user has already seen.
    finalError: lines.filter((l) => l && !/^debug\d*:/.test(l)).slice(-4).join('\n'),
  };
}

module.exports = { authProbe, summarise };
