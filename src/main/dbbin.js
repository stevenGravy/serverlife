'use strict';
/**
 * Finding database CLI clients — `psql`, `mysql`, `mongosh`, `redis-cli`,
 * `cqlsh`, `sqlcmd` — on this machine.
 *
 * Unlike kubectl's sibling tools (kubebin.js), these aren't bundled by one
 * installer: each is its own package, and two of them are routinely
 * installed *keg-only* by Homebrew — `psql` (via the `libpq` formula) and
 * `mysql` (via `mysql-client`) — because they conflict with the full
 * `postgresql`/`mysql` server formulae, so they never land on PATH even
 * when installed. Confirmed directly on a real dev machine, not assumed.
 *
 * This is informational only — a status row ("your installed clients") —
 * the query runner talks to databases with Node drivers directly, never by
 * shelling out to these, so a missing tool never hides a feature.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const WINDOWS = process.platform === 'win32';

/** Per-tool extra places to look, beyond PATH — keg-only Homebrew installs mostly. */
const EXTRA_CANDIDATES = {
  psql: [
    '/opt/homebrew/opt/libpq/bin/psql', // Homebrew, Apple Silicon (keg-only)
    '/usr/local/opt/libpq/bin/psql', // Homebrew, Intel (keg-only)
    '/opt/homebrew/opt/postgresql/bin/psql',
    '/usr/local/opt/postgresql/bin/psql',
  ],
  mysql: [
    '/opt/homebrew/opt/mysql-client/bin/mysql', // Homebrew, Apple Silicon (keg-only)
    '/usr/local/opt/mysql-client/bin/mysql', // Homebrew, Intel (keg-only)
  ],
  cqlsh: [
    path.join(os.homedir(), '.local', 'bin', 'cqlsh'), // pipx
  ],
};

const ECOSYSTEM_TOOLS = ['psql', 'mysql', 'mongosh', 'redis-cli', 'cqlsh', 'sqlcmd'];

let cache = new Map();

function exeName(name) {
  return WINDOWS ? `${name}.exe` : name;
}

function findTool(name) {
  if (cache.has(name)) return cache.get(name);
  const exe = exeName(name);
  for (const p of (EXTRA_CANDIDATES[name] || [])) {
    try { if (fs.existsSync(p)) { cache.set(name, p); return p; } } catch { /* unreadable path: not a candidate */ }
  }
  try {
    const out = execFileSync(WINDOWS ? 'where' : 'which', [name], {
      timeout: 5000, encoding: 'utf8', windowsHide: true,
    });
    const first = String(out || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) { cache.set(name, first); return first; }
  } catch { /* not on PATH: the bare name is the last resort */ }
  cache.set(name, exe);
  return exe;
}

/**
 * Is that tool really here? Distinguishing "missing" from "failed" is the
 * whole point, same reasoning as sshbin.js's/kubebin.js's toolAvailable().
 */
function toolAvailable(name) {
  const resolved = findTool(name);
  const exe = exeName(name);
  if (resolved === exe) return false; // nothing but the bare name to go on
  try { return fs.existsSync(resolved); } catch { return false; }
}

/** Every DB CLI tool's status in one call, for a status row in the Databases pane. */
function ecosystemStatus() {
  const out = {};
  for (const name of ECOSYSTEM_TOOLS) out[name] = { path: findTool(name), found: toolAvailable(name) };
  return out;
}

function clearCache() { cache = new Map(); }

module.exports = { ECOSYSTEM_TOOLS, findTool, toolAvailable, ecosystemStatus, clearCache };
