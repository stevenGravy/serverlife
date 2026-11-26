'use strict';
/**
 * Putting an existing database behind Teleport — the Database Service
 * equivalent of kube.js's installTeleportAgent()/teleportAgentValues().
 *
 * Unlike an SSH node or a Kubernetes agent, there is nothing to install ON
 * the database itself: Teleport's db_service is a separate process that
 * reaches the database as a client, over mutual TLS, so two things are
 * needed instead of one —
 *
 *   1. the database server has to trust Teleport's CA — teleport.js's
 *      signDbCert() is the exact "ssl = on / ssl_cert_file = .../
 *      ssl_ca_file = ..." snippet `tctl auth sign --format=db` already
 *      prints, pasted into postgresql.conf/pg_hba.conf or mysql.cnf;
 *   2. a db_service agent, configured with a join token and the database's
 *      address, running *somewhere that can reach it* — which does not
 *      have to be the database's own host. A direct connection already
 *      proves this machine can reach it, so the agent can simply run here.
 *
 * `start()` spawns that agent the same way awsproxy.js/dbproxy.js spawn
 * `tsh` — a child process, kept alive, torn down with the app. Verified
 * directly: this is the same recipe used by hand to stand up two real test
 * databases on a real cluster before any of this code existed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const yaml = require('js-yaml');
const teleport = require('./teleport');

const DATA_DIR = path.join(os.tmpdir(), 'serverlife-db-agent');

/**
 * The db_service config as YAML, with a header comment — same shape as
 * kube.js's teleportAgentValues(). No token is minted here: a join token is
 * a secret and a one-shot change on the cluster, so the caller mints it
 * right before use and this only fills in a placeholder when none exists
 * yet, for the "what will run" preview.
 */
function dbAgentConfig({
  proxy, token, caPin, resourceName, protocol, uri, labels = {}, dataDir = DATA_DIR,
} = {}) {
  const cleanLabels = Object.fromEntries(Object.entries(labels || {}).filter(([k]) => k));
  const config = {
    version: 'v3',
    teleport: {
      nodename: `serverlife-db-${resourceName || 'agent'}`,
      data_dir: dataDir,
      auth_token: token || '<join-token>',
      ...(caPin ? { ca_pin: caPin } : {}),
      proxy_server: proxy ? (/:\d+$/.test(proxy) ? proxy : proxy + ':443') : '<proxy-address:443>',
    },
    auth_service: { enabled: false },
    ssh_service: { enabled: false },
    proxy_service: { enabled: false },
    db_service: {
      enabled: true,
      databases: [{
        name: resourceName || '<database-name>',
        protocol: protocol || '<protocol>',
        uri: uri || '<host:port>',
        ...(Object.keys(cleanLabels).length ? { static_labels: cleanLabels } : {}),
      }],
    },
  };
  const body = yaml.dump(config, { lineWidth: -1 });
  const head = ['# Teleport Database Service config — written by ServerLife', '#'];
  if (!token) head.push('# auth_token is a placeholder. Make one (valid 1h) with:', '#   tctl tokens add --type=db --ttl=1h', '#');
  else head.push('# auth_token is a real join token: treat this file as a secret until it expires.', '#');
  head.push('#   teleport start -c <this file>');
  return head.join('\n') + '\n\n' + body;
}

// eslint-disable-next-line no-control-regex
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

/** configPath -> { child, startedAt } */
const running = new Map();

/** Write the config and start the agent, resolving once it reports healthy. */
function start({ configPath, configYaml } = {}) {
  if (!configPath || !configYaml) return Promise.resolve({ ok: false, error: 'No config to start the agent with.' });
  const existing = running.get(configPath);
  if (existing && !existing.child.killed) return Promise.resolve({ ok: true, pid: existing.child.pid, alreadyRunning: true });

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, configYaml, { mode: 0o600 });

  return new Promise((resolve) => {
    const child = spawn(teleport.findTeleport(), ['start', '-c', configPath]);

    let out = '';
    let settled = false;
    const done = (ok, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) running.set(configPath, { child, startedAt: Date.now() });
      resolve({ ok, ...extra });
    };

    // No clean "it's up" signal to wait on forever — a healthy agent keeps
    // logging, it never exits — so this times out into "probably fine,
    // check the pane" rather than hanging.
    const timer = setTimeout(() => done(true, {
      pid: child.pid, note: 'Still starting — give it a few seconds, then check the database list for "healthy".',
    }), 10000);

    const scan = (chunk) => {
      out += chunk;
      if (/Database service has successfully started/i.test(stripAnsi(out))) done(true, { pid: child.pid });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);

    child.on('error', (e) => done(false, { error: `Could not run teleport: ${e.message}` }));
    child.on('exit', (code) => {
      running.delete(configPath);
      if (settled) return;
      const text = stripAnsi(out).trim();
      done(false, { error: text.split('\n').filter(Boolean).pop() || `teleport exited with code ${code}` });
    });
  });
}

function stop(configPath) {
  const r = running.get(configPath);
  if (!r) return false;
  try { r.child.kill(); } catch { /* the process may already have exited */ }
  running.delete(configPath);
  return true;
}

function stopAll() {
  for (const r of running.values()) {
    try { r.child.kill(); } catch { /* the process may already have exited */ }
  }
  running.clear();
}

function status() {
  return [...running.entries()].map(([configPath, r]) => ({ configPath, pid: r.child.pid, startedAt: r.startedAt }));
}

module.exports = { dbAgentConfig, start, stop, stopAll, status, DATA_DIR };
