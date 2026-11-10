/**
 * Teleport VNet, started and stopped from the app.
 *
 * `tsh vnet` is a long-running foreground process: while it runs, TCP apps
 * (and SSH, where the cluster enables it) in the logged-in clusters answer by
 * name, with no `tsh proxy` per app. It serves every cluster logged in from
 * its tsh home, not one cluster — so there is one VNet per home here, and a
 * cluster's menu starts or stops the one for the home that cluster lives in.
 *
 * Stopping is Ctrl-C (SIGINT), which is how tsh is meant to be stopped: it
 * takes down the virtual interface and the DNS configuration it added. Only if
 * it is still there after a few seconds is it terminated outright.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** The profile name tsh files a proxy under: its host, without the port. */
function profileName(proxy) {
  return String(proxy || '').trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

/*
 * A tsh home holding one cluster and nothing else.
 *
 * `tsh vnet` serves every profile in its home whatever --proxy says, and
 * touching an expired one makes it log in again — it opened browser logins
 * for clusters nobody asked about. Pointed at this home instead, it can see
 * only the cluster it was started for. The profile and its keys are links to
 * the real ones, so a certificate renewed anywhere is the one VNet uses, and
 * VNet's own files (its SSH key and known hosts) are shared the same way.
 */
const SHARED = ['known_hosts', 'id_vnet', 'id_vnet.pub', 'vnet_known_hosts', 'config', 'bin'];

function scopedHome(realHome, proxy, root = path.join(os.tmpdir(), 'serverlife-vnet')) {
  const name = profileName(proxy);
  const real = realHome || process.env.TELEPORT_HOME || path.join(os.homedir(), '.tsh');
  if (!name || !fs.existsSync(path.join(real, `${name}.yaml`))) return null;
  const dir = path.join(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'keys'), { recursive: true, mode: 0o700 });
  const link = (from, to) => { if (fs.existsSync(from)) fs.symlinkSync(from, to); };
  link(path.join(real, `${name}.yaml`), path.join(dir, `${name}.yaml`));
  link(path.join(real, 'keys', name), path.join(dir, 'keys', name));
  for (const f of SHARED) link(path.join(real, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'current-profile'), name + '\n', { mode: 0o640 });
  return dir;
}

const TAIL = 60;                 // lines of output kept for the log view
const READY = /\b(vnet (is )?(running|ready|started)|ready|listening)\b/i;

class VnetManager extends EventEmitter {
  constructor({ findTsh, tshEnv }) {
    super();
    this.findTsh = findTsh;
    this.tshEnv = tshEnv;
    this.byHome = new Map();     // home key -> record
  }

  key(proxy) { return profileName(proxy); }

  view(rec) {
    return {
      cluster: profileName(rec.proxy),
      home: rec.home || null,
      proxy: rec.proxy || null,
      state: rec.state,
      startedAt: rec.startedAt,
      error: rec.error || null,
      log: rec.log.slice(-TAIL),
    };
  }

  status() { return [...this.byHome.values()].map((r) => this.view(r)); }

  _emit(rec) { this.emit('state', this.view(rec)); }

  /*
   * One VNet at a time, for one cluster. A second `tsh vnet` would fight the
   * first over the same virtual interface and resolver, so starting while
   * another is up is refused with the name of the one that is.
   */
  start({ home = null, proxy = null } = {}) {
    if (!proxy) throw new Error('No cluster to start VNet for');
    const k = this.key(proxy);
    const existing = this.byHome.get(k);
    if (existing && ['starting', 'running', 'stopping'].includes(existing.state)) return this.view(existing);
    const other = [...this.byHome.values()].find((r) => r !== existing && ['starting', 'running', 'stopping'].includes(r.state));
    if (other) throw new Error(`VNet is already running for ${profileName(other.proxy)} \u2014 stop it there first`);

    const rec = { home, proxy, state: 'starting', startedAt: Date.now(), error: null, log: [], child: null };
    this.byHome.set(k, rec);
    let scoped = null;
    try { scoped = scopedHome(home, proxy, this.scopeRoot); } catch (e) { rec.log.push(`Could not prepare a tsh home for this cluster alone: ${e.message}`); }
    if (!scoped) {
      rec.state = 'error';
      rec.error = `No tsh profile for ${profileName(proxy)} in ${home || 'the tsh home'} \u2014 log in to it first`;
      this._emit(rec);
      return this.view(rec);
    }
    rec.scopedHome = scoped;
    const args = ['--proxy=' + proxy, 'vnet'];

    let child;
    try {
      child = spawn(this.findTsh(), args, { env: this.tshEnv(scoped, proxy), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      rec.state = 'error';
      rec.error = e.message;
      this._emit(rec);
      return this.view(rec);
    }
    rec.child = child;

    const onText = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue;
        rec.log.push(line);
        if (rec.log.length > TAIL * 2) rec.log.splice(0, rec.log.length - TAIL);
        if (rec.state === 'starting' && READY.test(line)) { rec.state = 'running'; }
      }
      this._emit(rec);
    };
    child.stdout.on('data', onText);
    child.stderr.on('data', onText);

    /*
     * tsh does not promise to print anything when it is up, so a process
     * that is still alive a few seconds in — past authentication, past the
     * admin prompt it may raise — is taken as running.
     */
    rec.readyTimer = setTimeout(() => {
      if (rec.state === 'starting' && rec.child && rec.child.exitCode === null) {
        rec.state = 'running';
        this._emit(rec);
      }
    }, 4000);

    child.on('error', (e) => {
      rec.state = 'error';
      rec.error = e.message;
      this._emit(rec);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(rec.readyTimer);
      clearTimeout(rec.killTimer);
      rec.child = null;
      if (rec.stopping || code === 0 || signal === 'SIGINT') {
        rec.state = 'stopped';
      } else {
        rec.state = 'error';
        const last = rec.log.filter((l) => /error|fail|denied|not supported|requires/i.test(l)).pop()
          || rec.log[rec.log.length - 1];
        rec.error = last || `tsh vnet exited (${signal || code})`;
      }
      this._emit(rec);
    });

    this._emit(rec);
    return this.view(rec);
  }

  stop(proxy = null) {
    const rec = this.byHome.get(this.key(proxy));
    if (!rec || !rec.child) return rec ? this.view(rec) : null;
    rec.stopping = true;
    rec.state = 'stopping';
    this._emit(rec);
    try { rec.child.kill(process.platform === 'win32' ? undefined : 'SIGINT'); } catch { /* already gone */ }
    rec.killTimer = setTimeout(() => {
      try { rec.child?.kill('SIGTERM'); } catch { /* already gone */ }
    }, 6000);
    return this.view(rec);
  }

  stopAll() {
    for (const rec of this.byHome.values()) {
      if (!rec.child) continue;
      rec.stopping = true;
      try { rec.child.kill(process.platform === 'win32' ? undefined : 'SIGINT'); } catch { /* quitting anyway */ }
    }
  }
}

module.exports = { VnetManager, READY, scopedHome, profileName };
