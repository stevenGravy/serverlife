'use strict';
/**
 * AWS credentials from Teleport.
 *
 * `tsh proxy aws` does not hand back real AWS keys. It starts a local forward
 * proxy, prints throwaway credentials that only that proxy accepts, and a CA
 * bundle for the certificate it presents. Requests are signed with the
 * throwaway keys, tunnelled through the proxy, and re-signed by Teleport with
 * whatever the user's IAM role actually is — so nothing long-lived is ever
 * stored, and every call lands in the cluster's audit log.
 *
 * That means a proxy has to be running for as long as a bucket is in use, so
 * one is kept per app and shut down with the app.
 */

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const teleport = require('./teleport');

/** app name -> { child, env, startedAt } */
const running = new Map();

const EXPORT_RE = /export\s+([A-Z_]+)="([^"]*)"/g;

/**
 * Start (or reuse) a proxy for one AWS app. Resolves once tsh has printed the
 * four values it needs to hand over.
 */
function ensure(appName, { proxy } = {}) {
  if (!appName) throw new Error('No AWS application chosen.');
  const existing = running.get(appName);
  if (existing && !existing.child.killed) return Promise.resolve(existing.env);

  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('proxy', 'aws', '--app=' + appName, '--format=unix');

  return new Promise((resolve, reject) => {
    const child = spawn(teleport.findTsh(), args, {
      // The app lives in whichever tsh home holds this proxy's profile.
      env: teleport.tshEnv(teleport.homeForProxy(proxy), proxy),
    });

    let out = '';
    let settled = false;
    const done = (err, env) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { try { child.kill(); } catch { /* the process may already have exited */ } reject(err); }
      else resolve(env);
    };

    const timer = setTimeout(() => {
      done(new Error(`Timed out waiting for "tsh proxy aws --app ${appName}".`));
    }, 30000);

    const scan = (chunk) => {
      out += chunk;
      const found = {};
      EXPORT_RE.lastIndex = 0;
      let m;
      while ((m = EXPORT_RE.exec(out))) found[m[1]] = m[2];
      if (found.AWS_ACCESS_KEY_ID && found.AWS_SECRET_ACCESS_KEY && found.HTTPS_PROXY) {
        const env = {
          accessKeyId: found.AWS_ACCESS_KEY_ID,
          secretAccessKey: found.AWS_SECRET_ACCESS_KEY,
          caBundle: found.AWS_CA_BUNDLE || null,
          httpsProxy: found.HTTPS_PROXY,
          app: appName,
        };
        running.set(appName, { child, env, startedAt: Date.now() });
        done(null, env);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);

    child.on('error', (e) => done(new Error(`Could not run tsh: ${e.message}`)));
    child.on('exit', (code) => {
      running.delete(appName);
      if (settled) return;
      const text = stripAnsi(out).trim();
      // The usual cause by a wide margin, and the fix is one command.
      if (/not logged|please login|app.*not found/i.test(text)) {
        done(new Error(`Not logged in to the AWS app "${appName}". Run: tsh apps login ${appName} --aws-role <role>`));
      } else {
        done(new Error(text.split('\n').filter(Boolean).pop() || `tsh proxy aws exited with code ${code}`));
      }
    });
  });
}

// eslint-disable-next-line no-control-regex
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

function stop(appName) {
  const r = running.get(appName);
  if (!r) return false;
  try { r.child.kill(); } catch { /* the process may already have exited */ }
  running.delete(appName);
  return true;
}

function stopAll() {
  for (const name of [...running.keys()]) stop(name);
}

function status() {
  return [...running.entries()].map(([app, r]) => ({
    app, startedAt: r.startedAt, proxy: r.env.httpsProxy,
  }));
}

/* ------------------------------------------------------------------ */
/* Tunnelling                                                          */
/* ------------------------------------------------------------------ */

/**
 * An https agent that reaches the target through a CONNECT tunnel and trusts
 * the proxy's own CA. Node has no notion of HTTPS_PROXY on its own, so the
 * tunnel is built by hand.
 */
function tunnelAgent({ httpsProxy, caBundle }) {
  const u = new URL(httpsProxy);
  const ca = caBundle && fs.existsSync(caBundle) ? fs.readFileSync(caBundle) : undefined;

  // An https.Agent, not an http one: Node matches agent.protocol against the
  // request's, and an http agent is refused outright by https.request.
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (opts, cb) => {
    const req = http.request({
      host: u.hostname,
      port: Number(u.port || 80),
      method: 'CONNECT',
      path: `${opts.host}:${opts.port || 443}`,
      headers: { host: `${opts.host}:${opts.port || 443}` },
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        cb(new Error(`Local AWS proxy refused the tunnel: HTTP ${res.statusCode}`));
        return;
      }
      const secure = tls.connect({
        socket,
        servername: opts.host,
        ca,
        // The proxy presents its own certificate for the AWS host; the CA
        // bundle above is exactly what makes that verifiable.
        rejectUnauthorized: !!ca,
      }, () => cb(null, secure));
      secure.once('error', (e) => cb(e));
    });
    req.once('error', (e) => cb(new Error(`Local AWS proxy is not answering: ${e.message}`)));
    req.end();
    return undefined;
  };
  return agent;
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

/** AWS console apps the user can see, which is where these credentials live. */
async function listAwsApps({ proxy } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('apps', 'ls', '--format=json');
  const r = await teleport.run(args, { timeout: 30000 });
  if (!r.ok) throw new Error(stripAnsi(r.stderr || r.stdout).trim() || 'tsh apps ls failed');
  let raw;
  try { raw = JSON.parse(r.stdout || '[]'); } catch { throw new Error('Unreadable app list from tsh.'); }
  return (raw || [])
    .filter((a) => (a.spec || {}).cloud === 'AWS')
    .map((a) => ({
      name: a.metadata?.name,
      description: a.metadata?.description || '',
      accountId: a.metadata?.labels?.aws_account_id || null,
      publicAddr: a.spec?.public_addr || '',
      labels: a.metadata?.labels || {},
    }));
}

/**
 * The IAM roles an app offers. `tsh apps login` prints them and then refuses
 * without `--aws-role`, which is the only way to ask — so the refusal is the
 * answer, and nothing is logged in by running it.
 */
async function listAwsRoles(appName, { proxy } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('apps', 'login', appName);
  const r = await teleport.run(args, { timeout: 30000 });
  const text = stripAnsi(`${r.stdout}\n${r.stderr}`);
  const roles = [];
  for (const line of text.split('\n')) {
    const m = /^(\S+)\s+(arn:aws:iam::\d+:role\/\S+)\s*$/.exec(line.trim());
    if (m) roles.push({ name: m[1], arn: m[2] });
  }
  if (!roles.length && /already logged|Logged into/i.test(text)) return [];
  return roles;
}

async function login(appName, role, { proxy } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('apps', 'login', appName);
  if (role) args.push('--aws-role=' + role);
  const r = await teleport.run(args, { timeout: 120000 });
  const text = stripAnsi(`${r.stdout}\n${r.stderr}`).trim();
  if (!r.ok) throw new Error(text.split('\n').filter(Boolean).pop() || 'tsh apps login failed');
  return { ok: true, output: text };
}

async function logout(appName, { proxy } = {}) {
  stop(appName);
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('apps', 'logout', appName);
  const r = await teleport.run(args, { timeout: 30000 });
  return { ok: r.ok, output: stripAnsi(`${r.stdout}\n${r.stderr}`).trim() };
}

module.exports = { ensure, stop, stopAll, status, tunnelAgent, listAwsApps, listAwsRoles, login, logout };
