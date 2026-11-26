'use strict';
/**
 * Database connections from Teleport.
 *
 * `tsh proxy db --tunnel` starts a local, unauthenticated TCP listener that
 * only that process answers — no DB password, ever, because Teleport's own
 * mTLS cert already proved who is connecting and as which database user
 * ("Started authenticated tunnel ... on 127.0.0.1:<port>", confirmed
 * directly against a real cluster). Everything downstream — the query
 * runner, a schema browser, an exported DBeaver/pgAdmin/DataGrip
 * connection — just points at `localhost:<port>`.
 *
 * One proxy is kept alive per (resource, db user, db name) combination —
 * tsh ties those to the tunnel at start time, so a different combination
 * needs its own process — and torn down with the app, the same shape
 * `awsproxy.js` already uses for AWS.
 */

const { spawn } = require('child_process');
const teleport = require('./teleport');

/** key -> { child, port, startedAt, resourceName, dbUser, dbNameParam, proxy } */
const running = new Map();

function keyFor(resourceName, dbUser, dbNameParam, proxy) {
  return `${proxy || ''}\u0001${resourceName}\u0001${dbUser || ''}\u0001${dbNameParam || ''}`;
}

// eslint-disable-next-line no-control-regex
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

// "Started authenticated tunnel for the PostgreSQL database "x" in cluster "y" on 127.0.0.1:64449."
const LISTENING_RE = /Started authenticated tunnel[^\n]*? on [^\s:]+:(\d+)\./i;

/**
 * Start (or reuse) a local tunnel for one database. Resolves once tsh has
 * printed the port it bound.
 */
function ensure(resourceName, { proxy, dbUser, dbNameParam, dbRoles, cluster } = {}) {
  if (!resourceName) throw new Error('No database to connect to.');
  if (!dbUser) throw new Error('No database user to connect as.');
  const key = keyFor(resourceName, dbUser, dbNameParam, proxy);
  const existing = running.get(key);
  if (existing && !existing.child.killed) return Promise.resolve({ port: existing.port });

  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('proxy', 'db', '--tunnel', '--port=0', '--db-user=' + dbUser);
  if (dbNameParam) args.push('--db-name=' + dbNameParam);
  if (dbRoles) args.push('--db-roles=' + dbRoles);
  if (cluster) args.push('--cluster=' + cluster);
  args.push(resourceName);

  return new Promise((resolve, reject) => {
    const child = spawn(teleport.findTsh(), args, {
      env: teleport.tshEnv(teleport.homeForProxy(proxy), proxy),
    });

    let out = '';
    let settled = false;
    const done = (err, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { child.kill(); } catch { /* the process may already have exited */ }
        reject(err);
      } else {
        running.set(key, { child, port, startedAt: Date.now(), resourceName, dbUser, dbNameParam, proxy });
        resolve({ port });
      }
    };

    const timer = setTimeout(() => {
      done(new Error(`Timed out waiting for "tsh proxy db --tunnel ${resourceName}".`));
    }, 30000);

    const scan = (chunk) => {
      out += chunk;
      const m = LISTENING_RE.exec(stripAnsi(out));
      if (m) done(null, Number(m[1]));
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);

    child.on('error', (e) => done(new Error(`Could not run tsh: ${e.message}`)));
    child.on('exit', (code) => {
      running.delete(key);
      if (settled) return;
      const text = stripAnsi(out).trim();
      // The usual causes, named instead of left as a bare exit code.
      if (/not logged|please login|certificate has expired/i.test(text)) {
        done(new Error(`Not logged in. Run: tsh login${proxy ? ' --proxy=' + proxy : ''}`));
      } else if (/please provide the database name/i.test(text)) {
        done(new Error(text.split('\n').filter(Boolean).pop()));
      } else {
        done(new Error(text.split('\n').filter(Boolean).pop() || `tsh proxy db exited with code ${code}`));
      }
    });
  });
}

function stop(resourceName, { dbUser, dbNameParam, proxy } = {}) {
  const key = keyFor(resourceName, dbUser, dbNameParam, proxy);
  const r = running.get(key);
  if (!r) return false;
  try { r.child.kill(); } catch { /* the process may already have exited */ }
  running.delete(key);
  return true;
}

function stopAll() {
  for (const r of running.values()) {
    try { r.child.kill(); } catch { /* the process may already have exited */ }
  }
  running.clear();
}

function status() {
  return [...running.values()].map((r) => ({
    resourceName: r.resourceName, dbUser: r.dbUser, dbNameParam: r.dbNameParam, proxy: r.proxy,
    port: r.port, startedAt: r.startedAt,
  }));
}

/** Every Teleport database this profile can see — `tsh db ls --format json`. */
async function listDatabases({ proxy } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('db', 'ls', '--format=json');
  const r = await teleport.run(args, { timeout: 15000 });
  if (!r.ok) throw new Error(stripAnsi(r.stderr || r.stdout || 'tsh db ls failed').trim().split('\n').pop());
  let raw;
  try { raw = JSON.parse(r.stdout || '[]'); } catch { throw new Error('Unreadable database list from tsh.'); }
  return (raw || []).map((d) => ({
    name: d.metadata?.name,
    description: d.metadata?.description || '',
    protocol: d.spec?.protocol || '',
    uri: d.spec?.uri || '',
    labels: d.metadata?.labels || {},
    allowedUsers: d.users?.allowed || [],
  }));
}

module.exports = { ensure, stop, stopAll, status, listDatabases };
