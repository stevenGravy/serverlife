'use strict';
/**
 * Finding `kubectl` — and the rest of the Kubernetes toolbelt beside it.
 *
 * Unlike `ssh`, `kubectl` is never part of the OS: it is always a separate
 * install, in one of a handful of well-known places depending on how it got
 * there (a package manager, a manual download, a vendor's installer). So the
 * same search-known-locations-then-ask-the-OS approach `sshbin.js` uses for
 * ssh applies here too, and is kept in its own module for the same reason —
 * this is local-machine binary discovery, not anything Kubernetes-specific
 * about how a cluster is reached.
 *
 * Every other ecosystem tool KubeLife can launch (helm, k9s, stern, kubectx,
 * kubens, kind, k3d, minikube, kustomize) is a *sibling* tool in exactly the
 * sense sshbin.js's findTool()/toolAvailable() already means: look next to
 * kubectl first (installers that bundle one often bundle the others, e.g. a
 * cloud SDK's bin directory), then ask the OS, then give up cleanly. None of
 * these are required — KubeLife reports what is missing with an install
 * hint rather than hiding the feature.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const WINDOWS = process.platform === 'win32';

function candidates() {
  const env = process.env;
  if (WINDOWS) {
    const programs = env.ProgramFiles || 'C:\\Program Files';
    return [
      env.KUBECTL_PATH,
      path.join(programs, 'Kubernetes', 'kubectl.exe'),
      path.join(programs, 'Docker', 'Docker', 'resources', 'bin', 'kubectl.exe'),
      path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'Microsoft', 'WinGet', 'Links', 'kubectl.exe'),
      'kubectl.exe',
    ].filter(Boolean);
  }
  return [
    env.KUBECTL_PATH,
    '/usr/local/bin/kubectl',
    '/opt/homebrew/bin/kubectl',
    '/opt/local/bin/kubectl', // MacPorts
    path.join(os.homedir(), '.nix-profile', 'bin', 'kubectl'), // per-user Nix profile
    '/nix/var/nix/profiles/default/bin/kubectl', // system-wide Nix profile
    '/home/linuxbrew/.linuxbrew/bin/kubectl', // Linuxbrew
    '/snap/bin/kubectl', // Snap, on Linux
    '/usr/bin/kubectl',
    'kubectl',
  ].filter(Boolean);
}

let cache = null;
let searched = [];
let override = null;
let versionCache = null;

function setKubectlPath(p) {
  override = String(p || '').trim() || null;
  cache = null;
  versionCache = null;
  return override;
}

/** Ask the OS, for an install in a place worth not hard-coding. */
function whichKubectl() {
  try {
    const out = execFileSync(WINDOWS ? 'where' : 'which', ['kubectl'], {
      timeout: 5000, encoding: 'utf8', windowsHide: true,
    });
    const first = String(out || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
    return first && fs.existsSync(first) ? first : null;
  } catch { return null; }
}

/** The kubectl to spawn. Always returns something runnable-looking. */
function findKubectl() {
  if (cache) return cache;
  if (override) { cache = override; return cache; }
  const bare = WINDOWS ? 'kubectl.exe' : 'kubectl';
  searched = candidates();
  for (const p of searched) {
    if (p === bare) continue;
    try { if (fs.existsSync(p)) { cache = p; return cache; } } catch { /* unreadable path: not a candidate */ }
  }
  cache = whichKubectl() || bare;
  return cache;
}

/** Is there really a kubectl here? */
function kubectlAvailable() {
  const resolved = findKubectl();
  if (resolved === 'kubectl' || resolved === 'kubectl.exe') return !!whichKubectl();
  try { return fs.existsSync(resolved); } catch { return false; }
}

function kubectlStatus() {
  return {
    path: findKubectl(),
    found: kubectlAvailable(),
    override,
    searched,
    version: kubectlVersion(),
  };
}

/**
 * `kubectl version --client` as plain text ("Client Version: v1.34.1"),
 * parsed into a comparable {major, minor, patch}. Run with `--client` so this
 * never tries to reach a cluster; `spawnSync` rather than `execFileSync`
 * because a broken kubeconfig can still make kubectl exit non-zero even with
 * `--client`, and the version line is on stdout either way.
 */
function parseKubectlVersion(text) {
  const raw = String(text || '').trim();
  const m = raw.match(/Client Version:\s*v?(\d+)\.(\d+)\.(\d+)/i) || raw.match(/v(\d+)\.(\d+)\.(\d+)/);
  if (!m) return { raw, major: null, minor: null, patch: null };
  return { raw, major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function kubectlVersion() {
  const resolved = findKubectl();
  if (versionCache && versionCache.path === resolved) return versionCache.info;
  let info = null;
  try {
    const res = spawnSync(resolved, ['version', '--client'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
    const text = (res && (res.stdout || res.stderr)) || '';
    info = text.trim() ? parseKubectlVersion(text) : null;
  } catch { info = null; }
  versionCache = { path: resolved, info };
  return info;
}

/**
 * The broader k8s ecosystem: never required, always nice to have found.
 * Looked for beside kubectl first (an installer that bundles kubectl often
 * bundles these too), then on PATH, same shape as sshbin.js's findTool().
 */
// popeye and kube-bench: detection only. Popeye gets a real run-and-parse
// action (kubelint.js); kube-bench runs as a Job inside the cluster
// against node-local files, not something reachable from here the same
// way — knowing it's installed is as far as this goes.
const ECOSYSTEM_TOOLS = ['helm', 'k9s', 'stern', 'kubectx', 'kubens', 'kind', 'k3d', 'minikube', 'kustomize', 'popeye', 'kube-bench'];

/*
 * Where a package manager puts things, for tools that are not beside
 * kubectl. Not left to PATH: an app opened from the Dock gets launchd's
 * PATH (/usr/bin:/bin:/usr/sbin:/sbin), so Homebrew's helm in
 * /opt/homebrew/bin was never found whenever kubectl resolved to
 * /usr/local/bin — kubectl only works because it has its own list.
 * Built from that same list, so the two cannot drift apart.
 */
function toolDirs() {
  const dirs = candidates().filter((p) => p.includes(path.sep)).map((p) => path.dirname(p));
  if (!WINDOWS) dirs.push(path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), 'bin'));
  return [...new Set(dirs)];
}

function findTool(name) {
  const exe = WINDOWS ? `${name}.exe` : name;
  const beside = path.join(path.dirname(findKubectl()), exe);
  try { if (fs.existsSync(beside)) return beside; } catch { /* unreadable path: try the usual places */ }
  for (const dir of toolDirs()) {
    const p = path.join(dir, exe);
    try { if (fs.existsSync(p)) return p; } catch { /* unreadable path: not a candidate */ }
  }
  try {
    const out = execFileSync(WINDOWS ? 'where' : 'which', [name], {
      timeout: 5000, encoding: 'utf8', windowsHide: true,
    });
    const first = String(out || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch { /* not on PATH: the bare name is the last resort */ }
  return exe;
}

/**
 * Is that tool really here? Distinguishing "missing" from "failed" is the
 * whole point, same reasoning as sshbin.js's toolAvailable().
 */
function toolAvailable(name) {
  const resolved = findTool(name);
  const exe = WINDOWS ? `${name}.exe` : name;
  if (resolved === exe) return false; // nothing but the bare name to go on
  try { return fs.existsSync(resolved); } catch { return false; }
}

/** Every ecosystem tool's status in one call, for a Settings/status row. */
function ecosystemStatus() {
  const out = {};
  for (const name of ECOSYSTEM_TOOLS) out[name] = { path: findTool(name), found: toolAvailable(name) };
  return out;
}

/** Environment for a spawned kubectl (or a sibling tool): the binary's own directory has to be findable. */
function kubectlEnv(extra) {
  const resolved = findKubectl();
  const dir = path.dirname(resolved);
  const current = process.env.PATH || process.env.Path || '';
  const env = { ...process.env, ...(extra || {}) };
  if (dir && dir !== '.' && !current.split(path.delimiter).includes(dir)) {
    env.PATH = [current, dir].filter(Boolean).join(path.delimiter);
  }
  return env;
}

/**
 * What to say when there is no kubectl. Spawning a missing binary fails
 * with ENOENT and an empty stderr, which every caller then reported as its
 * own vague "kubectl … failed" — this names the actual problem instead.
 */
function kubectlMissingMessage() {
  return `kubectl was not found (looked for ${findKubectl()}). Install it — brew install kubectl — and reopen ServerLife.`;
}

/*
 * kubectl's failures, said in a sentence instead of shown raw. Through
 * Teleport, a cluster you can see but not yet use answers discovery with an
 * empty "unknown" — and `kubectl api-resources` then panics outright, a Go
 * stack trace that reached the screen as the error. Every kubectl run in the
 * app comes through explainMissing() below, so this is the one place that
 * turns that (and klog's `E1109 … memcache.go:265]` lines, and the other
 * usual failures) into something a person can act on.
 */
const NO_ACCESS = "This cluster isn't letting you in yet — you may need to request access to it, or log in to its Teleport cluster again.";
const KLOG_LINE = /^[EWIF]\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\S+:\d+\]\s*/;

function humanizeKubectlError(text) {
  // eslint-disable-next-line no-control-regex
  const raw = String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
  if (!raw.trim()) return raw;
  // Teleport's "no access yet": discovery answered with nothing, a bare
  // Forbidden with no reason, or kubectl crashing on the empty answer.
  if (/server API group list: unknown|Error from server \(Forbidden\): unknown\b|^panic: |\bgoroutine \d+ \[|the server has asked for the client to provide credentials|\bUnauthorized\b/m.test(raw)) {
    return NO_ACCESS;
  }
  if (/certificate (has )?expired|x509: certificate|relogin|tsh login|ssh: cert has expired/i.test(raw)) {
    return 'Your login to this cluster has expired — log in to its Teleport cluster again.';
  }
  // A specific refusal names what was refused: keep that, minus kubectl's wording.
  const refused = /cannot (\w+) resource "([^"]+)"(?: in API group "([^"]*)")?(?: in the namespace "([^"]+)"| at the cluster scope)?/.exec(raw);
  if (refused) {
    const [, verb, resource, , ns] = refused;
    return `Not allowed: your role can't ${verb} ${resource}${ns ? ` in ${ns}` : ''}.`;
  }
  if (/Unable to connect to the server|connection refused|no such host|i\/o timeout|context deadline exceeded|TLS handshake timeout/i.test(raw)) {
    const why = (/(dial tcp [^:]*:\d+: [^\n]+|no such host|i\/o timeout|connection refused|TLS handshake timeout)/i.exec(raw) || [])[1];
    return `Can't reach the cluster${why ? ` (${why.trim()})` : ''}.`;
  }
  // Otherwise: kubectl's own message, without the log prefixes, the stack
  // and the "error:" in front of it — the first couple of lines of substance.
  const lines = [];
  for (const line of raw.split('\n')) {
    if (/^panic: |^goroutine \d+|^\s+\S+\.go:\d+|^\S+\(0x[0-9a-f]+/.test(line)) break;
    const cleaned = line.replace(KLOG_LINE, '').replace(/^error: /i, '').replace(/^Error from server \((\w+)\): /, '$1: ').trim();
    if (cleaned && !/^Unhandled Error/.test(cleaned)) lines.push(cleaned);
    if (lines.length >= 2) break;
  }
  return lines.join('\n') || raw.trim().split('\n')[0];
}

/** A finished kubectl run's result: a missing binary spelled out, and any other failure said plainly (humanizeKubectlError). */
function explainMissing(result) {
  if (result && !result.ok && result.err?.code === 'ENOENT') return { ...result, stderr: kubectlMissingMessage() };
  if (result && !result.ok && result.stderr) {
    const said = humanizeKubectlError(result.stderr);
    return { ...result, stderr: said, rawStderr: result.stderr, noAccess: said === NO_ACCESS };
  }
  return result;
}

module.exports = {
  findKubectl, kubectlAvailable, kubectlStatus, setKubectlPath, kubectlEnv,
  kubectlVersion, parseKubectlVersion, findTool, toolAvailable, ecosystemStatus,
  kubectlMissingMessage, explainMissing, humanizeKubectlError, NO_ACCESS,
  ECOSYSTEM_TOOLS,
};
