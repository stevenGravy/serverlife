'use strict';
/**
 * Teleport (tsh) integration: profile/cluster discovery, node inventory, and
 * generation of the ssh_config that lets plain OpenSSH reach cluster nodes
 * through `tsh proxy ssh`.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const livesessions = require('./livesessions');

const WINDOWS = process.platform === 'win32';

/**
 * Where `tsh` is, per platform.
 *
 * On Windows almost nothing that installs tsh puts it on PATH: Teleport Connect
 * keeps it inside its own resources directory, and the standalone package lands
 * in Program Files. A bare `tsh` therefore resolves to nothing, every command
 * fails the same way, and the app looks as though no cluster were logged in —
 * so the install locations are searched explicitly, and `where` is asked as
 * well in case the user put it somewhere of their own.
 */
function candidateTshPaths() {
  const env = process.env;
  if (WINDOWS) {
    const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const programs = env.ProgramFiles || 'C:\\Program Files';
    const programsX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const programData = env.ProgramData || 'C:\\ProgramData';
    return [
      env.TSH_PATH,
      // Teleport Connect, per-user install (the common case).
      path.join(local, 'Programs', 'teleport-connect', 'resources', 'bin', 'tsh.exe'),
      path.join(programs, 'Teleport Connect', 'resources', 'bin', 'tsh.exe'),
      // Standalone tsh / teleport package.
      path.join(programs, 'Teleport', 'tsh.exe'),
      path.join(programsX86, 'Teleport', 'tsh.exe'),
      path.join(local, 'Teleport', 'tsh.exe'),
      // Package managers.
      path.join(programData, 'chocolatey', 'bin', 'tsh.exe'),
      path.join(os.homedir(), 'scoop', 'shims', 'tsh.exe'),
      'tsh.exe',
    ].filter(Boolean);
  }
  return [
    env.TSH_PATH,
    '/usr/local/bin/tsh',
    '/opt/homebrew/bin/tsh',
    '/Applications/Teleport Connect.app/Contents/Resources/bin/tsh',
    '/usr/bin/tsh',
    'tsh',
  ].filter(Boolean);
}

/** Directories worth adding to PATH for a spawned tsh, per platform. */
function extraPathDirs() {
  if (!WINDOWS) return ['/usr/local/bin', '/opt/homebrew/bin'];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programs = process.env.ProgramFiles || 'C:\\Program Files';
  return [
    path.join(local, 'Programs', 'teleport-connect', 'resources', 'bin'),
    path.join(programs, 'Teleport'),
  ];
}

let tshPathCache = null;
let tshSearched = [];
let tshPathOverride = null;

/** An explicit path from preferences always wins over the search. */
function setTshPath(p) {
  tshPathOverride = String(p || '').trim() || null;
  tshPathCache = null;
  return tshPathOverride;
}

/** Ask the OS where tsh is, as a last resort before giving up. */
function whichTsh() {
  try {
    const cmd = WINDOWS ? 'where' : 'which';
    const out = require('child_process').execFileSync(cmd, ['tsh'], {
      timeout: 5000,
      encoding: 'utf8',
      env: tshEnv(null),
      windowsHide: true,
    });
    const first = String(out || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
    return first && fs.existsSync(first) ? first : null;
  } catch { return null; }
}

/**
 * What the search found, for the UI to report honestly: "tsh not found, here is
 * where I looked" beats "not logged in", which sends people to run a login that
 * was never the problem.
 */
function tshStatus() {
  const resolved = findTsh();
  const bare = resolved === 'tsh' || resolved === 'tsh.exe';
  // A path only counts as found if something is actually there — an override
  // typed with a typo must not report itself as working.
  let found = false;
  if (bare) found = !!whichTsh();
  else { try { found = fs.existsSync(resolved); } catch { found = false; } }
  return {
    path: resolved,
    found,
    override: tshPathOverride,
    searched: tshSearched,
    home: DEFAULT_HOME,
    homeExists: (() => { try { return fs.existsSync(DEFAULT_HOME); } catch { return false; } })(),
  };
}

/* ------------------------------------------------------------------ */
/* tsh homes                                                           */
/* ------------------------------------------------------------------ */

/**
 * Several tsh profile directories at once.
 *
 * `tsh` keeps everything about who you are — certificates, the active profile,
 * known hosts — under one directory, `TELEPORT_HOME` (`~/.tsh` by default).
 * One directory means one identity per cluster, which is why anyone holding
 * two logins to the same cluster, or keeping work and home clusters apart,
 * ends up juggling the variable by hand.
 *
 * So the app holds a list of homes instead. Profiles are read from every one of
 * them, and each profile remembers where it came from; from then on every tsh
 * command for that cluster runs with that home in its environment. A command is
 * matched to its home by the `--proxy` it carries, which is the one thing every
 * profile-specific invocation already names — so a new call site gets this for
 * free rather than having to remember to pass it.
 */
const DEFAULT_HOME = process.env.TELEPORT_HOME || path.join(os.homedir(), '.tsh');

let homes = [];                   // configured directories, in order
const homeByProxy = new Map();    // proxy -> home that holds it

/**
 * A home as written in Settings, made a real path: `~`, and `$NAME` or
 * `${NAME}` from the app's environment — `$TELEPORT_HOME`, `${WORK}/.tsh` —
 * read each time, so a variable that changes moves the home with it. One that
 * names an unset variable is no path at all ('') rather than wherever the
 * leftover text happens to resolve.
 */
function expandHome(p) {
  let raw = String(p || '').trim();
  if (!raw) return '';
  let missing = false;
  raw = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
    const v = process.env[a || b];
    if (v === undefined || v === '') missing = true;
    return v || '';
  });
  if (missing) return '';
  raw = raw.trim();
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

/** Replace the configured list. An empty list means "just the default". */
function setHomes(list) {
  const seen = new Set();
  homes = (Array.isArray(list) ? list : [])
    .map(expandHome)
    .filter((p) => p && !seen.has(p) && (seen.add(p), true));
  homeByProxy.clear();
  return homes;
}

function listHomes() { return [...homes]; }

/** The homes to read profiles from: what is configured, or the default one. */
function activeHomes() {
  return homes.length ? homes : [DEFAULT_HOME];
}

/** A short name for a home, for badges and menus. */
function homeName(home) {
  const h = expandHome(home);
  if (!h || h === DEFAULT_HOME) return '';
  const base = path.basename(h);
  // `~/.tsh-work` reads better as "work". A directory literally called `.tsh`
  // has no name of its own, so it borrows its parent's — except in the home
  // directory, where that would just be the username.
  if (/^\.?tsh$/i.test(base)) {
    const parent = path.dirname(h);
    return parent === os.homedir() ? 'tsh' : path.basename(parent);
  }
  return base.replace(/^\.?tsh[-_.]?/i, '') || base;
}

function isDefaultHome(home) {
  return !home || expandHome(home) === DEFAULT_HOME;
}

/** Which home holds a proxy, as learnt from the last status sweep. */
function homeForProxy(proxy) {
  if (!proxy) return null;
  return homeByProxy.get(proxy)
    || homeByProxy.get(String(proxy).replace(/:443$/, ''))
    || homeByProxy.get(String(proxy) + ':443')
    || null;
}

/**
 * The environment a tsh invocation needs. TELEPORT_HOME is set only when a home
 * is actually in play, so with no homes configured the process environment is
 * left exactly as it was.
 */
/* ---------------- variables for tsh ---------------- */

/*
 * Environment variables to run tsh with, set in Settings: for every cluster,
 * and per cluster on top of that. TELEPORT_TOOLS_VERSION is the reason — one
 * cluster wants its tsh fetched at a particular version, the others do not —
 * but any variable tsh reads can be set this way.
 */
let envGlobal = {};
let envByCluster = {};          // bare proxy -> { NAME: value }
let envByHome = {};             // expanded tsh home -> { NAME: value }
let envInShells = false;

/** `corp.example.com:443`, `https://corp.example.com/web` → `corp.example.com`. */
const bareProxy = (p) => String(p || '').trim().toLowerCase()
  .replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '').replace(/:443$/, '');

/**
 * `NAME=value` lines — `export NAME="value"` pasted from a shell profile too.
 * Blank lines and # comments are skipped; anything else that is not a valid
 * assignment is reported by line rather than half-applied.
 */
function parseEnvText(text) {
  const vars = {};
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) { errors.push(`line ${i + 1}: not NAME=value — ${line.slice(0, 60)}`); return; }
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    vars[m[1]] = v;
  });
  return { vars, errors };
}

/** From settings: `tshEnvText`, `clusterTshEnv` (proxy → text), `tshHomeEnv` (home → text) and `tshEnvInShells`. */
function setEnvSettings({ global = '', clusters = {}, homesEnv = {}, inShells = false } = {}) {
  envGlobal = parseEnvText(global).vars;
  envByHome = {};
  // Keyed by the path as written; matched by where it points now.
  for (const [home, text] of Object.entries(homesEnv || {})) {
    const vars = parseEnvText(text).vars;
    const h = expandHome(home);
    if (h && Object.keys(vars).length) envByHome[h] = vars;
  }
  envByCluster = {};
  for (const [proxy, text] of Object.entries(clusters || {})) {
    const vars = parseEnvText(text).vars;
    if (Object.keys(vars).length) envByCluster[bareProxy(proxy)] = vars;
  }
  envInShells = !!inShells;
}

/** The variables a tsh for this cluster runs with: everyone's, then the cluster's own. */
function envFor(proxy) {
  return { ...envGlobal, ...(proxy ? envByCluster[bareProxy(proxy)] || {} : {}) };
}
const envForShells = () => (envInShells ? { ...envGlobal } : {});

function tshEnv(home, proxy = null) {
  // PATH separators and install directories are both platform-specific; gluing
  // POSIX ones onto a Windows PATH corrupts its last entry.
  const dirs = extraPathDirs().filter((d) => {
    try { return fs.existsSync(d); } catch { return false; }
  });
  const current = process.env.PATH || process.env.Path || '';
  const env = {
    ...process.env,
    PATH: [current, ...dirs].filter(Boolean).join(path.delimiter),
  };
  const h = expandHome(home);
  if (h) env.TELEPORT_HOME = h;
  else if (homes.length) env.TELEPORT_HOME = homes[0];
  /*
   * A tsh that was chosen — Path to tsh in Settings, or TSH_PATH — is the
   * tsh that runs.
   *
   * Client-tools managed updates otherwise hand the command to whichever
   * version they have installed for the cluster: another version's build called `tsh`
   * reported itself as 18.11.7 and behaved as it, so picking it changed
   * nothing — Phases never appeared — with no sign why. Only for a chosen
   * binary: one the app found on its own keeps the updates, and anyone who
   * sets TELEPORT_TOOLS_VERSION themselves keeps their own value.
   */
  // The variables set in Settings: for every cluster, then this home's, then this cluster's.
  Object.assign(env, envGlobal, envByHome[env.TELEPORT_HOME || DEFAULT_HOME] || {}, proxy ? envByCluster[bareProxy(proxy)] || {} : {});
  // A chosen tsh runs as itself — unless a tools version was asked for, by
  // the person's environment or by the variables above, which then decides.
  if (chosenTsh() && env.TELEPORT_TOOLS_VERSION === undefined) env.TELEPORT_TOOLS_VERSION = 'off';
  return env;
}

/** The tsh named by Settings or TSH_PATH, if one was — not one found by searching. */
function chosenTsh() {
  return tshPathOverride || (process.env.TSH_PATH ? String(process.env.TSH_PATH).trim() : '') || null;
}

/** The `--proxy=` a set of arguments carries, if any. */
/**
 * The home in force for the current call.
 *
 * Most functions here take a `{proxy}` and nothing else, and the proxy is
 * usually enough to find the home. It stops being enough when two homes hold
 * the *same* proxy — the case multiple homes exist for — so a caller that knows
 * which one it means wraps the call in `withHome`. Async-local rather than a
 * module variable, so two clusters being read at once cannot swap homes.
 */
const homeScope = new AsyncLocalStorage();

function withHome(home, fn) {
  const h = expandHome(home);
  return h ? homeScope.run({ home: h }, fn) : fn();
}

/** tsh colours its errors; the UI shows them as text. */
function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

/**
 * What a failed tsh run should be shown as: no colour codes, no ERROR:
 * prefix, and a fallback when it said nothing at all.
 */
function tshError(r, fallback) {
  const text = plain(r?.stderr || r?.stdout || '');
  return text.replace(/^ERROR:\s*/i, '').trim() || fallback;
}

function proxyInArgs(args) {
  for (const a of args || []) {
    const m = /^--proxy[=\s](.+)$/.exec(String(a));
    if (m) return m[1];
  }
  return null;
}

function findTsh() {
  if (tshPathCache) return tshPathCache;
  if (tshPathOverride) {
    tshPathCache = tshPathOverride;
    return tshPathCache;
  }
  const bare = WINDOWS ? 'tsh.exe' : 'tsh';
  tshSearched = candidateTshPaths();
  for (const p of tshSearched) {
    try {
      if (p === bare) continue;              // tried last, through PATH
      if (fs.existsSync(p)) { tshPathCache = p; return tshPathCache; }
    } catch { /* unreadable path: not a candidate */ }
  }
  // Nothing at a known location: fall back to PATH, asking the OS first so a
  // custom install is found rather than every command failing silently.
  tshPathCache = whichTsh() || bare;
  return tshPathCache;
}

let tctlPathCache = null;

/**
 * `tctl` — beside `tsh` first, the layout the standard Teleport package (not
 * Teleport Connect, which is tsh-only) actually installs, then PATH. Used
 * only for generating a join token for the install wizards (an SSH host or
 * a Kubernetes cluster lacking Teleport) — everything else here is `tsh`.
 */
function findTctl() {
  if (tctlPathCache) return tctlPathCache;
  const bare = WINDOWS ? 'tctl.exe' : 'tctl';
  try {
    const beside = path.join(path.dirname(findTsh()), bare);
    if (fs.existsSync(beside)) { tctlPathCache = beside; return tctlPathCache; }
  } catch { /* unreadable path: try PATH instead */ }
  try {
    const cmd = WINDOWS ? 'where' : 'which';
    const out = require('child_process').execFileSync(cmd, ['tctl'], {
      timeout: 5000, encoding: 'utf8', env: tshEnv(null), windowsHide: true,
    });
    const first = String(out || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) { tctlPathCache = first; return tctlPathCache; }
  } catch { /* not on PATH either: the bare name is the last resort */ }
  tctlPathCache = bare;
  return tctlPathCache;
}

/**
 * A join token for a new agent — `tctl tokens add --type=<type> --ttl=<ttl>`.
 *
 * Which cluster it is made on is said outright: `--auth-server=<proxy>`
 * makes tctl use that proxy's own tsh login. Without it tctl took the
 * *current* tsh profile, whatever that was — a token for the cluster picked
 * in the wizard was minted on another one, and the agent was then told
 * "token expired or not found" by the cluster it actually joined.
 * TELEPORT_PROXY is dropped for the same reason: a value from the person's
 * own shell must not be what decides.
 *
 * And checked before anything is created: `tctl status` names the cluster
 * that answered, and a token is only made when that is the one asked for
 * (`cluster`, the profile's own cluster name — not always the proxy's host).
 * The cluster that issued it comes back with the token, so the wizard can say.
 */
function tctlRun(args, { proxy, home, timeout = 30000 } = {}) {
  const h = home !== undefined && home !== null ? home : homeForProxy(proxy);
  const env = tshEnv(h, proxy);
  delete env.TELEPORT_PROXY;
  const target = proxy ? ['--auth-server=' + (/:\d+$/.test(proxy) ? proxy : proxy + ':443')] : [];
  return new Promise((resolve) => {
    execFile(findTctl(), [...target, ...args], { timeout, env }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: plain(stdout), stderr: plain(stderr) });
    });
  });
}

/*
 * The commands that put an SSH host behind Teleport, for the cluster picked:
 *
 *   1. https://<proxy>/scripts/install.sh — the cluster's own installer, with
 *      that cluster's exact version and edition written into it, which
 *      installs Teleport through teleport-update (managed updates included);
 *   2. `teleport node configure` — the documented flags for the config:
 *      --proxy, --token, --node-name and --labels (key=value,…);
 *   3. starting the service.
 *
 * Not the per-token install-node.sh join script: that may go away, and it
 * ignores both the token's labels and any node name. Labels and the name are
 * checked to be plain characters first, so nothing in them can break the
 * command.
 */
const NODE_LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,62}$/;
const NODE_LABEL_VALUE = /^[A-Za-z0-9_.:/@-]{0,63}$/;
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;
function nodeInstallCommand({ proxy, token, labels = {}, nodeName = '' } = {}) {
  if (!proxy) return { ok: false, error: 'Pick the Teleport cluster to join.' };
  const host = String(proxy).replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:443$/, '');
  const proxyAddr = /:\d+$/.test(host) ? host : `${host}:443`;
  const errors = [];
  const pairs = Object.entries(labels || {}).filter(([k]) => k);
  for (const [k, v] of pairs) {
    if (!NODE_LABEL_KEY.test(k)) errors.push(`Label key "${k}": letters, digits, "_", ".", "/" and "-" only`);
    if (!NODE_LABEL_VALUE.test(String(v))) errors.push(`Label "${k}" value "${v}": letters, digits and _ . : / @ - only`);
  }
  const name = String(nodeName || '').trim();
  if (name && !NODE_NAME.test(name)) errors.push(`Node name "${name}": letters, digits, "_", "." and "-" only`);
  if (errors.length) return { ok: false, error: errors.join('\n') };
  const configure = [
    'sudo teleport node configure', '--output=file:///etc/teleport.yaml',
    `--proxy=${proxyAddr}`, `--token=${token || '<join-token>'}`,
    ...(name ? [`--node-name=${name}`] : []),
    ...(pairs.length ? [`--labels=${pairs.map(([k, v]) => `${k}=${v}`).join(',')}`] : []),
  ].join(' ');
  const lines = [
    `curl -fsSL https://${host}/scripts/install.sh | sudo sh`,
    configure,
    'sudo systemctl enable --now teleport',
  ];
  return { ok: true, command: lines.join('\n'), oneLine: lines.join(' && ') };
}

async function createJoinToken({ type, ttl = '1h', proxy, home, cluster } = {}) {
  if (!proxy) return { ok: false, error: 'No Teleport proxy given to make the token on.' };
  const st = await tctlRun(['status'], { proxy, home });
  if (!st.ok) return { ok: false, error: st.stderr || st.stdout || 'tctl status failed' };
  const answered = (/^Cluster:\s*(\S+)/m.exec(st.stdout) || [])[1] || '';
  if (cluster && answered && answered !== cluster) {
    return { ok: false, error: `tctl reached cluster "${answered}", not "${cluster}" — no token was made.` };
  }
  const r = await tctlRun(['tokens', 'add', '--type=' + type, '--ttl=' + ttl, '--format=text'], { proxy, home });
  if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'tctl tokens add failed' };
  // tctl's text format is a short paragraph of instructions ending in the
  // token itself — the last non-blank line, not the whole paragraph.
  const token = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return token ? { ok: true, token, cluster: answered } : { ok: false, error: 'tctl printed no token' };
}

function runTsh(args, opts = {}) {
  // An explicit home wins; otherwise the proxy in the arguments says which
  // home this command belongs to.
  const home = opts.home !== undefined && opts.home !== null
    ? opts.home
    : (homeScope.getStore()?.home || homeForProxy(proxyInArgs(args)));
  return new Promise((resolve) => {
    execFile(findTsh(), args, {
      timeout: opts.timeout || 25000,
      maxBuffer: 32 * 1024 * 1024,
      env: tshEnv(home, proxyInArgs(args)),
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

/**
 * The plain name every function in this module (and a few outside it) uses.
 * Kept separate from `runTsh` so `statusIn` can shadow it with a home-bound
 * version without every other call site having to know.
 */
const run = (args, opts) => runTsh(args, opts);

async function version() {
  const r = await run(['version', '--client']);
  if (!r.ok && !r.stdout) return null;
  const m = r.stdout.match(/Teleport\s+v([0-9.]+)/);
  return m ? m[1] : (r.stdout.trim().split('\n')[0] || null);
}

/* ---------------- client and cluster versions ---------------- */

function majorOf(v) {
  const m = String(v || '').match(/^v?(\d+)\./);
  return m ? Number(m[1]) : null;
}

/**
 * Whether this tsh is one the cluster supports, in Teleport's own terms.
 *
 * A cluster supports clients of its own major version and of the one before
 * it — nothing newer, nothing older. tsh only says so once, as a warning
 * during `tsh login`, and then carries on; every later command is silent. A
 * client a major ahead works today but tsh announces that future versions
 * will refuse, and one two majors ahead already cannot log in (seen: 18
 * against 16 fails with "ssh: no key found", which says nothing about
 * versions). So the verdict has to be worked out here, where it can be shown.
 *
 * `level`: 'ok' | 'warn' (works, unsupported) | 'error' (expected to fail),
 * or 'unknown' when either version could not be read.
 */
function compatibility(client, server) {
  const c = majorOf(client);
  const s = majorOf(server);
  if (c === null || s === null) return { level: 'unknown', client, server, message: null };
  const base = { client, server };
  if (c === s || c === s - 1) return { ...base, level: 'ok', message: null };
  const fix = `Install tsh ${s}.x, or turn on managed client updates for the cluster.`;
  if (c === s + 1) {
    return {
      ...base,
      level: 'warn',
      message: `tsh ${client} is newer than this cluster (Teleport ${server}), which supports clients up to ${s}.x. `
        + `It works for now, but tsh warns that future versions will refuse. ${fix}`,
    };
  }
  return {
    ...base,
    level: 'error',
    message: c > s
      ? `tsh ${client} is ${c - s} major versions ahead of this cluster (Teleport ${server}); logins and sessions are expected to fail. ${fix}`
      : `tsh ${client} is too old for this cluster (Teleport ${server}), which needs ${s - 1}.x or newer. ${fix}`,
  };
}

/**
 * The incompatibility warning tsh prints during login, if it printed one.
 *
 * Kept alongside `compatibility` rather than instead of it: this is tsh's own
 * word, so it is shown as tsh said it, and the integration tests check that
 * the two agree — the day Teleport changes its policy, they stop agreeing.
 */
function parseVersionWarning(text) {
  const t = plain(text);
  if (!/incompatible client and server versions/i.test(t)) return null;
  const max = t.match(/Maximum client version supported by the server is (\S+) but you are using (\S+?)\.?\s/i);
  const min = t.match(/Minimum client version supported by the server is (\S+) but you are using (\S+?)\.?\s/i);
  const m = max || min;
  return {
    direction: max ? 'client-newer' : min ? 'client-older' : 'unknown',
    serverLimit: m ? m[1] : null,
    client: m ? m[2] : null,
    text: t.slice(t.search(/Detected potentially incompatible/i)).split(/\n\s*\n/)[0].trim(),
  };
}

/**
 * Both sides of it for one profile: `tsh version` reports the proxy's version
 * alongside its own when it can reach one, through the same TLS trust and
 * profile as every other tsh call — no separate request to get wrong.
 */
async function versionInfo({ proxy, home } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('version', '--format=json');
  // Short: this is asked on the way to reporting a failure, and an
  // unreachable proxy must not hold that failure up for long.
  const r = await run(args, { timeout: 8000, home });
  try {
    const j = JSON.parse(r.stdout || '{}');
    return { client: j.version || null, server: j.proxyVersion || null };
  } catch {
    return { client: null, server: null };
  }
}

/**
 * `compatibility` for a profile, remembered for a while.
 *
 * Asked again on every failed connection, so it is cached per proxy and home:
 * the cluster's version changes on upgrade day, not between two clicks.
 */
const compatCache = new Map();
const COMPAT_TTL_MS = 10 * 60 * 1000;

async function compatFor({ proxy, home, refresh = false } = {}) {
  const key = `${home || ''}|${proxy || ''}`;
  const hit = compatCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < COMPAT_TTL_MS) return hit.value;
  const { client, server } = await versionInfo({ proxy, home });
  const value = compatibility(client, server);
  // An unreadable server version is not cached: it is usually "not logged in
  // yet", which the next call after a login should not be stuck with.
  if (value.level !== 'unknown') compatCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Profiles from every configured home, merged.
 *
 * Each profile is tagged with the home it came from, and the proxy→home map is
 * rebuilt here — which is what lets every later command find its own home. Two
 * homes holding the same cluster are two profiles, not one: that is the case
 * multiple homes exist for.
 */
/**
 * `tsh status` as it prints it.
 *
 * The app already has the parsed version — that is what the sidebar and the
 * Teleport tab are drawn from — but the printed form is what people compare
 * against a terminal, paste into a ticket and read the extensions out of. So
 * this is the text, not a re-rendering of it.
 */
async function statusText({ proxy, home } = {}) {
  const r = await run(['status'], { home });
  const text = (r.stdout || '').trim() || (r.stderr || '').trim();
  /*
   * Which cluster tsh put first.
   *
   * `tsh status` leads with the active profile and lists the others after it,
   * so a caller asking about one cluster has to be told when the top of the
   * block is about a different one.
   */
  const first = text.match(/^\s*Cluster:\s*(\S+)/m);
  const activeCluster = first ? first[1] : '';
  return {
    ok: !!text,
    text: text || 'tsh printed nothing.',
    // Which home it was read from, since the same cluster can be in two.
    home: home || DEFAULT_HOME,
    proxy: proxy || '',
    activeCluster,
    activeMatches: !!activeCluster && !!proxy
      ? text.split('\n').slice(0, 6).some((l) => l.includes(proxy))
      : true,
  };
}

async function status() {
  const dirs = activeHomes();
  const results = await Promise.all(dirs.map((home) => statusIn(home)));

  const profiles = [];
  const errors = [];
  homeByProxy.clear();

  results.forEach((r, i) => {
    const home = dirs[i];
    const name = homeName(home);
    if (r.error && !r.profiles.length) errors.push({ home, name, error: r.error, missing: !!r.missing });
    for (const p of r.profiles) {
      // First home to claim a proxy owns it. Ordering is the user's, so the
      // list in preferences is also a precedence list.
      if (p.proxy && !homeByProxy.has(p.proxy)) homeByProxy.set(p.proxy, home);
      profiles.push({
        ...p,
        home: isDefaultHome(home) ? null : home,
        homeDir: home,
        homeName: name,
      });
    }
  });

  return {
    loggedIn: profiles.length > 0,
    profiles,
    // Whether tsh was found travels with every status read, so the UI can tell
    // "no tsh" from "no login" without asking separately — and can tell the
    // difference again after the path is corrected.
    tsh: tshStatus(),
    homes: dirs.map((h) => ({ path: h, name: homeName(h), default: isDefaultHome(h) })),
    error: profiles.length ? null : (errors[0]?.error || null),
    homeErrors: errors,
  };
}

/**
 * Parse `tsh status` for one home. The JSON form is the most reliable across
 * versions; fall back to text scraping if it is unavailable.
 */
async function statusIn(home) {
  const run = (args, opts = {}) => runTsh(args, { ...opts, home });
  const j = await run(['status', '--format=json']);
  if (j.ok && j.stdout.trim().startsWith('{')) {
    try {
      const data = JSON.parse(j.stdout);
      const profiles = [];
      const toProfile = (p, active) => p && ({
        proxy: p.profile_url ? String(p.profile_url).replace(/^https?:\/\//, '') : p.proxy,
        cluster: p.cluster,
        username: p.username,
        logins: p.logins || [],
        roles: p.roles || [],
        activeRequests: p.active_requests || [],
        // Each entry is `{ id: { cluster, kind, name } }`; older tsh put the
        // fields at the top level. Read either, or every narrowed certificate
        // looks like `undefined/undefined` — still non-empty, but useless.
        allowedResources: (p.allowed_resources || []).map((r) => {
          const id = r.id || r;
          return `${id.kind}/${id.name}`;
        }),
        validUntil: p.valid_until,
        // What Kubernetes sees this login as, per the role — the identity
        // the kube browser's "My access" falls back to when the cluster
        // itself will not answer `kubectl auth whoami` through Teleport.
        kubeUsers: p.kubernetes_users || [],
        kubeGroups: p.kubernetes_groups || [],
        active: !!active,
        // A profile with no certificate behind it (logged out, or a login
        // that never finished) still lists, with no roles and a valid_until
        // of the moment tsh was asked — "expired" only by milliseconds, so
        // say it outright: anything run against it is a relogin, MFA and all.
        expired: !(p.roles || []).length
          || (p.valid_until ? new Date(p.valid_until).getTime() < Date.now() : false),
      });
      if (data.active) profiles.push(toProfile(data.active, true));
      for (const p of data.profiles || []) {
        const conv = toProfile(p, false);
        if (conv && !profiles.some((x) => x.proxy === conv.proxy && x.cluster === conv.cluster)) {
          profiles.push(conv);
        }
      }
      return { profiles };
    } catch { /* unparseable status falls back to the text output */ }
  }

  const t = await run(['status']);
  if (!t.stdout.includes('Profile URL')) {
    const message = plain(t.stderr || t.stdout);
    if (message) return { profiles: [], error: message };
    // No output at all means the binary never ran: a missing tsh, not a
    // missing login, and the difference is the whole fix.
    return {
      profiles: [],
      error: `Could not run tsh (${findTsh()}). ${t.err?.code === 'ENOENT'
        ? 'The file is not there — set its path in Settings → Locate tsh.'
        : 'It exited without output.'}`,
      missing: t.err?.code === 'ENOENT',
    };
  }
  const profiles = [];
  let cur = null;
  for (const line of t.stdout.split('\n')) {
    const m = line.match(/^\s*(?:>\s*)?Profile URL:\s*(.+)$/);
    if (m) {
      if (cur) profiles.push(cur);
      cur = {
        proxy: m[1].trim().replace(/^https?:\/\//, ''),
        active: line.includes('>'),
        logins: [], roles: [],
      };
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^\s{2,}([A-Za-z ]+):\s*(.*)$/);
    if (!kv) continue;
    const k = kv[1].trim().toLowerCase();
    const v = kv[2].trim();
    if (k === 'cluster') cur.cluster = v;
    else if (k === 'logged in as') cur.username = v;
    else if (k === 'logins') cur.logins = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === 'roles') cur.roles = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === 'valid until') {
      cur.validUntil = v.replace(/\s*\[.*$/, '');
      cur.expired = /EXPIRED/i.test(v);
    }
  }
  if (cur) profiles.push(cur);
  return { profiles };
}

/**
 * `tsh recordings ls` takes dates, not timestamps: the documented format is
 * `2006-01-02`. Anything else is rejected outright, so normalise whatever the
 * caller passes — Date, ISO string, or an already-correct date.
 */
function toRecordingDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Root and leaf clusters reachable through a proxy.
 *
 * A trusted (leaf) cluster is not a profile of its own: `tsh status` names only
 * the one cluster the certificate currently points at, so a leaf stays
 * invisible until something asks for it separately. `tsh clusters` is that
 * question, and its answer carries the root alongside every leaf, with
 * `selected` marking where the login stands right now — which is exactly what
 * switching to a leaf moves.
 *
 * JSON only, deliberately: the table form truncates long cluster names with an
 * ellipsis, and a truncated name is not something anyone can switch to. An
 * older tsh that cannot produce JSON reports a failure rather than half a name.
 */
async function listClusters({ proxy, home } = {}) {
  const args = ['clusters', '--format=json'];
  if (proxy) args.push('--proxy=' + proxy);
  /*
   * Short, same reasoning as `clusterSshConfigText`'s own timeout: once a
   * cluster is logged in this is a local, near-instant answer, and the
   * only way it is ever slow is one that is not — which `create` calls
   * this to check (`isLeafCluster`) on every single Teleport host it
   * opens, before the renderer's own relogin ever gets a turn. 30 seconds
   * here, on top of the config check's own wait, was most of why nothing
   * appeared to happen for a long time after double-clicking a host on an
   * expired cluster — not stuck, just queued behind two long timeouts in
   * a row before the login prompt this was actually waiting to show.
   */
  const r = await run(args, { timeout: 6000, home });
  const at = r.stdout.indexOf('[');
  if (at >= 0) {
    try {
      const data = JSON.parse(r.stdout.slice(at));
      if (Array.isArray(data)) {
        const clusters = data.map(toCluster).filter((c) => c.name);
        leafNames.set(
          leafKey(proxy, home),
          new Set(clusters.filter((c) => c.leaf).map((c) => c.name)),
        );
        return { ok: true, clusters };
      }
    } catch { /* output that is not JSON falls through to the error */ }
  }
  return {
    ok: false,
    error: plain(r.stderr || r.stdout) || 'tsh clusters returned nothing to read',
    clusters: [],
  };
}

function toCluster(c) {
  return {
    name: String(c?.cluster_name || '').trim(),
    // Anything that is not spelled "leaf" is the cluster you logged into.
    leaf: String(c?.cluster_type || '').toLowerCase() === 'leaf',
    status: String(c?.status || '').trim(),
    selected: !!c?.selected,
    labels: c?.labels || null,
  };
}

/**
 * Which cluster names behind a proxy are leaves, as last read.
 *
 * Kept so "is this node in a leaf?" — asked on the way into every connection —
 * does not cost a tsh call each time. The selected cluster is not part of it:
 * a leaf stays a leaf whether or not the certificate currently points there,
 * and a root node opened while a leaf is selected is still a root node.
 */
const leafNames = new Map();   // [home, proxy] -> Set of leaf cluster names

function leafKey(proxy, home) {
  return JSON.stringify([expandHome(home) || '', proxy || '']);
}

/**
 * Whether a node's cluster is a trusted leaf rather than a root.
 *
 * This decides the transport: a leaf node is dialled with `tsh ssh` and not
 * with OpenSSH over the generated ssh_config. Not because ssh cannot get in —
 * `tsh config` writes a block per leaf and the leaf trusts the root's user CA,
 * so it does — but because that route presents the *root* cluster's
 * certificate, which is the one `tsh config` names for every block. `tsh ssh`
 * has tsh issue a certificate for the leaf itself, so the leaf's own role
 * mapping, principals and MFA rules are the ones that apply, and the session
 * is attributed to the leaf rather than arriving on borrowed trust.
 *
 * A cold cache costs one `tsh clusters`; if even that cannot be read the
 * answer is "no", leaving the caller's own choice of transport alone rather
 * than forcing one on a guess.
 */
async function isLeafCluster({ proxy, cluster, home } = {}) {
  if (!cluster) return false;
  const key = leafKey(proxy, home);
  if (!leafNames.has(key)) await listClusters({ proxy, home });
  return !!leafNames.get(key)?.has(cluster);
}

/**
 * An RFC3339 expiry as epoch milliseconds, or null.
 *
 * Teleport writes the zero time (`0001-01-01T00:00:00Z`) for a resource that
 * does not expire, and that parses perfectly well into a date a couple of
 * millennia ago — which would read as "expired long since" to anything doing
 * arithmetic on it. Anything before 2000 is that sentinel, not a timestamp.
 */
function parseExpiry(s) {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) && t > 946684800000 ? t : null;
}

/** Node inventory for a cluster/proxy. */
async function listNodes({ proxy, cluster, home } = {}) {
  const args = ['ls', '--format=json'];
  if (cluster) args.push('--cluster=' + cluster);
  if (proxy) args.push('--proxy=' + proxy);
  const r = await run(args, { timeout: 45000, home });
  if (!r.ok) {
    /*
     * `plain`, because tsh colours its errors and those escape codes end up
     * drawn literally wherever the message is shown — "\u001b[31mERROR:" in
     * the middle of a dialog. The leading ERROR: goes too; the surrounding
     * text already says something failed.
     */
    return { ok: false, error: tshError(r, 'tsh ls failed'), nodes: [] };
  }
  let raw;
  try { raw = JSON.parse(r.stdout || '[]'); } catch { return { ok: false, error: 'unparseable tsh ls output', nodes: [] }; }

  const nodes = (raw || []).map((n) => {
    const meta = n.metadata || {};
    const spec = n.spec || {};
    const hostname = spec.hostname || meta.name;
    const labels = { ...(meta.labels || {}) };
    for (const [k, v] of Object.entries(spec.cmd_labels || {})) {
      labels[k] = typeof v === 'object' ? v.result : v;
    }
    return {
      /*
       * Ids reach settings — hidden hosts, remembered logins, the MFA list — so
       * a host in the default home keeps the id it has always had. A host read
       * from another home is genuinely a different thing to open (different
       * identity, possibly a different node of the same name), so its home is
       * part of its id.
       */
      id: isDefaultHome(home)
        ? `tsh:${cluster || ''}:${meta.name}`
        : `tsh:${homeName(home) || home}:${cluster || ''}:${meta.name}`,
      type: 'teleport',
      name: hostname,
      hostname,
      uuid: meta.name,
      addr: spec.addr || (spec.use_tunnel ? 'tunnel' : ''),
      tunnel: !!spec.use_tunnel || !spec.addr,
      subKind: n.sub_kind || 'teleport',
      /*
       * When the cluster will forget this node, which is the only thing it
       * will tell us about its heartbeat.
       *
       * An agent announces itself with a TTL and then keeps re-announcing;
       * each announcement pushes this forward by the full TTL again. So the
       * expiry is not a fact about the future so much as a record of the
       * past — how long ago the agent last said anything is the TTL minus
       * what is left. There is no "last seen" field to read instead, and
       * once the expiry passes the node simply disappears from `tsh ls`, so
       * this is the whole of the window in which a dying agent can be seen
       * dying. Nodes that never expire (agentless OpenSSH hosts, anything
       * registered without a TTL) carry a zero date; those have no heartbeat
       * to be late and are recorded as having no expiry at all.
       */
      expires: parseExpiry(meta.expires),
      cluster,
      proxy,
      home: isDefaultHome(home) ? null : home,
      homeName: homeName(home),
      labels,
    };
  });
  // Case-insensitively and numerically: `node-2` before `node-10`, and a
  // capital letter is not a sort key. The renderer's compareNames is the
  // same rule; this process cannot import it, so it is spelled out.
  nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));

  /*
   * A hostname is not unique within a cluster.
   *
   * Two machines can announce the same one — an image baked with a fixed
   * hostname, an autoscaling group, a rebuild that came back alongside the
   * host it was replacing — and `tsh ssh user@name` then has nothing to go on
   * and refuses rather than picking one. The UUID is the only name that means
   * exactly one node, so the ones sharing a hostname are marked here, where
   * the whole cluster's list is in hand and a duplicate can actually be seen.
   *
   * Per cluster, because that is the scope tsh resolves a name in: the same
   * hostname in a leaf and its root is two different questions, each answered
   * by its own --cluster.
   */
  markAmbiguous(nodes);

  return { ok: true, nodes };
}

/**
 * Mark the nodes whose hostname is shared with another in the same list.
 *
 * Its own function so it can be tested: everything downstream of a
 * duplicate — the transport it is forced onto, the name it is dialled by,
 * the label on its tab, the mark on its row — hangs off this one boolean,
 * and getting it wrong is silent in both directions. A false positive
 * dials a perfectly ordinary node by UUID; a false negative hands tsh a
 * name that means two machines, and tsh refuses.
 */
function markAmbiguous(nodes) {
  const byHostname = new Map();
  for (const n of nodes) byHostname.set(n.hostname, (byHostname.get(n.hostname) || 0) + 1);
  for (const n of nodes) n.ambiguous = (byHostname.get(n.hostname) || 0) > 1;
  return nodes;
}

/**
 * Write an ssh_config for a cluster so OpenSSH can dial nodes via
 * `tsh proxy ssh`. Returns the config path.
 */
/**
 * The ssh_config block `tsh config` writes for a cluster.
 *
 * A short timeout on purpose, well under `run`'s own 25-second default:
 * once a cluster is actually logged in this reads the local profile and
 * answers at once, no network round trip involved. The only way it is
 * ever slow is a cluster that is not logged in yet trying to validate or
 * refresh against a proxy it cannot reach — and that case should fail
 * fast, not make whoever is waiting on it (a brand new connection, about
 * to find out it needs a relogin) sit through the full 25 seconds first
 * to learn what a few hundred milliseconds already would have said.
 */
async function clusterSshConfigText({ proxy, home }) {
  // `tsh config` takes --proxy only, and only as a global-position flag.
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('config');
  const r = await run(args, { home, timeout: 6000 });
  if (!r.ok || !r.stdout.includes('Host')) {
    throw new Error('tsh config failed: ' + (r.stderr || r.stdout || 'unknown').trim());
  }
  return r.stdout;
}

async function writeClusterSshConfig(dir, { proxy, cluster, home }) {
  const stdout = await clusterSshConfigText({ proxy, home });
  await fsp.mkdir(dir, { recursive: true });
  const tag = [homeName(home), cluster || proxy || 'default'].filter(Boolean).join('-');
  const file = path.join(dir, `tsh-${tag.replace(/[^\w.-]/g, '_')}.conf`);
  // Keep host-key checking strict but non-interactive: tsh maintains its own
  // known_hosts, referenced by the generated config.
  const body = stdout + '\nHost *\n    StrictHostKeyChecking accept-new\n';
  await fsp.writeFile(file, body, { mode: 0o600 });
  return file;
}

/**
 * Teleport hosts are addressed as `<node>.<cluster>` by the generated config.
 */
/**
 * The host part of the command that dials a node.
 *
 * By hostname, except when another node in the cluster answers to the same
 * one — see `listNodes`. Then the name is not an address at all and the UUID
 * is used, which is unique by construction.
 */
function teleportSshTarget(node, login) {
  const name = (node.ambiguous && node.uuid) ? node.uuid : (node.hostname || node.uuid);
  const host = `${name}.${node.cluster}`;
  return login ? `${login}@${host}` : host;
}

/**
 * Access requests for a profile. `tsh request ls` reports the requests that
 * belong to the logged-in user, including ones already assumed.
 */
async function listRequests({ proxy, resolveNames = true, refresh = false } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('request', 'ls', '--format=json');
  const r = await run(args, { timeout: 30000 });
  if (!r.ok) return { ok: false, error: tshError(r, ''), requests: [] };
  let raw;
  try { raw = JSON.parse(r.stdout || '[]'); } catch { return { ok: false, error: 'unparseable request list', requests: [] }; }

  const requests = (Array.isArray(raw) ? raw : []).map((x) => {
    const spec = x.spec || {};
    const meta = x.metadata || {};
    const stateNum = spec.state;
    const state = typeof stateNum === 'string'
      ? stateNum
      : ({ 0: 'NONE', 1: 'PENDING', 2: 'APPROVED', 3: 'DENIED', 4: 'PROMOTED' })[stateNum] || 'UNKNOWN';
    const resources = (spec.resource_ids || []).map((r2) => {
      const sub = r2.sub_resource_name || '';
      return {
        kind: r2.kind,
        // For a node this is the UUID; `name` stays raw and `label` carries
        // whatever a human would recognise once it has been resolved.
        name: r2.name,
        sub,
        cluster: r2.cluster || '',
        id: `/${r2.cluster || ''}/${r2.kind}/${r2.name}` + (sub ? '/' + sub : ''),
        label: null,
      };
    });
    return {
      id: meta.name || spec.id,
      user: spec.user,
      roles: spec.roles || [],
      resources,
      state,
      reason: spec.request_reason || '',
      created: spec.created,
      /*
       * All four are absolute timestamps, not the durations they were created
       * with, and all four live on the spec — `metadata.expires` is simply
       * absent, so reading it there meant the expiry never showed at all.
       *
       *   expires          the request stops accepting review
       *   assumeStartTime  the roles cannot be assumed before this
       *   maxDuration      access ends here, however often it is assumed
       *   sessionTtl       the elevated certificate itself expires
       */
      expires: spec.expires || meta.expires || null,
      assumeStartTime: spec.assume_start_time || null,
      maxDuration: spec.max_duration || null,
      sessionTtl: spec.session_ttl || null,
      reviewers: spec.suggested_reviewers || [],
      proxy,
    };
  });

  if (resolveNames) await attachResourceNames(requests, { proxy, refresh });
  return { ok: true, requests };
}

/**
 * Turn `node/56a7402c-7a2c-…` into `node/bms-app-service`.
 *
 * A request names resources by id, and for nodes that id is a UUID — unusable
 * for deciding whether to approve something. The names live in
 * `tsh request search`, which (unlike `tsh ls`) also covers resources the user
 * cannot currently reach, which is exactly what an unapproved request holds.
 *
 * Best-effort throughout: an unresolved resource keeps its raw id rather than
 * failing the listing.
 */
const nameCache = new Map();   // `${proxy}|${kind}` -> { at, names: Map(name -> label) }
const NAME_TTL_MS = 120000;

async function resourceNamesFor(proxy, kind, refresh) {
  const key = `${proxy || ''}|${kind}`;
  const hit = nameCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < NAME_TTL_MS) return hit.names;

  const names = new Map();
  const res = await searchRequestable({ proxy, kind });
  if (res.ok) {
    for (const r of res.resources) {
      if (r.uuid && r.name) names.set(r.uuid, r.name);
    }
  }
  // Nodes the user can already reach are in the inventory even when the search
  // above comes back empty — a request that has been approved and assumed.
  if (kind === 'node') {
    const inv = await listNodes({ proxy });
    if (inv.ok) {
      for (const n of inv.nodes) {
        if (n.uuid && n.name && !names.has(n.uuid)) names.set(n.uuid, n.name);
      }
    }
  }
  nameCache.set(key, { at: Date.now(), names });
  return names;
}

async function attachResourceNames(requests, { proxy, refresh } = {}) {
  const kinds = new Set();
  for (const req of requests) {
    for (const r of req.resources) if (r.kind) kinds.add(r.kind);
  }
  if (!kinds.size) return;

  const byKind = new Map();
  await Promise.all([...kinds].map(async (kind) => {
    try { byKind.set(kind, await resourceNamesFor(proxy, kind, refresh)); }
    catch { byKind.set(kind, new Map()); }
  }));

  for (const req of requests) {
    for (const r of req.resources) {
      const label = byKind.get(r.kind)?.get(r.name);
      // Apps and databases are already named by their id; only flag a label as
      // "resolved" when it actually differs from what we started with.
      if (label && label !== r.name) r.label = label;
    }
  }
}

/**
 * Resource kinds `tsh request search --kind=` accepts, in order of
 * usefulness. `kube_resource` is a namespace or a pod *inside* an
 * already-requestable kube_cluster, not a resource of its own — see
 * searchRequestable()'s own kubeKind/namespace handling below, which
 * is where that distinction actually matters.
 */
const REQUEST_KINDS = [
  'node', 'app', 'db', 'kube_cluster', 'kube_resource', 'windows_desktop', 'linux_desktop',
  'user_group', 'saml_idp_service_provider', 'git_server',
  'aws_ic_account', 'aws_ic_account_assignment',
];

/**
 * `tsh request search` reports labels as one comma-joined `k=v` string, and
 * values may themselves contain commas — `uptime=up 1 day, 22 hours`. Split on
 * commas, then fold any fragment that does not open a new `key=` back onto the
 * value it was torn from.
 */
function parseLabelString(s) {
  const out = {};
  let lastKey = null;
  for (const piece of String(s || '').split(',')) {
    const eq = piece.indexOf('=');
    // A key never contains whitespace, so a fragment like " 22 hours" is a
    // continuation even when a later `=` appears inside the value.
    if (eq > 0 && !/\s/.test(piece.slice(0, eq))) {
      lastKey = piece.slice(0, eq);
      out[lastKey] = piece.slice(eq + 1);
    } else if (lastKey) {
      out[lastKey] += ',' + piece;
    }
  }
  return out;
}

/**
 * What this user could ask for. Distinct from `listNodes`: the whole point of
 * an access request is a resource you cannot see yet, so the node inventory
 * does not contain it — on one of these clusters `tsh ls` returns 3 nodes and
 * this returns 13.
 *
 * For nodes `Name` is the UUID and `Hostname` is what a human calls it; for
 * apps and databases `Name` is already the friendly name and `Hostname` is
 * empty. `ResourceID` is the string `tsh request create --resource=` wants.
 */
async function searchRequestable({
  proxy, kind = 'node', search, labels, query, kubeCluster,
  kubeKind, namespace, allNamespaces,
} = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('request', 'search', '--kind=' + kind, '--format=json');
  if (search) args.push('--search=' + search);
  if (labels) args.push('--labels=' + labels);
  if (query) args.push('--query=' + query);
  if (kubeCluster) args.push('--kube-cluster=' + kubeCluster);
  // kind: 'kube_resource' only — which sub-resource to search for, and
  // (for pods) which namespace. `--kube-kind` wants the plural CLI form
  // ("namespaces", "pods"), distinct from the singular form Teleport
  // roles use for `kubernetes_resources`.
  if (kubeKind) args.push('--kube-kind=' + kubeKind);
  if (allNamespaces) args.push('--all-kube-namespaces');
  else if (namespace) args.push('--namespace=' + namespace);

  const r = await run(args, { timeout: 60000 });
  if (!r.ok) {
    // eslint-disable-next-line no-control-regex
    const msg = (r.stderr || r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
    return { ok: false, error: msg || `tsh request search --kind=${kind} failed`, kind, resources: [] };
  }
  let raw;
  try { raw = JSON.parse(r.stdout || '[]'); } catch { return { ok: false, error: 'unparseable search output', kind, resources: [] }; }

  const resources = (Array.isArray(raw) ? raw : []).map((x) => {
    const id = x.ResourceID || '';
    // "/cluster/kind/name" — the cluster is the only part not already in hand.
    const cluster = id.startsWith('/') ? id.split('/')[1] : '';
    return {
      id,
      kind,
      name: x.Hostname || x.Name || '',
      uuid: x.Name || '',
      cluster,
      proxy,
      labels: parseLabelString(x.Labels),
    };
  }).filter((x) => x.id);
  resources.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  return { ok: true, kind, resources };
}

/**
 * The id a requestable node will carry once it is granted and shows up in
 * `listNodes`'s inventory (same formula as the `id:` above) — worked out
 * ahead of the grant from the cluster + uuid a search result already
 * carries, so a node can be marked "needs MFA" before access even exists.
 * Keyed by the search result's own `id` (its ResourceID) so the caller can
 * match answers back up to rows without relying on array order.
 */
function inventoryNodeIds({ items = [], home } = {}) {
  const out = {};
  for (const it of items || []) {
    if (!it || !it.id || !it.uuid) continue;
    out[it.id] = isDefaultHome(home)
      ? `tsh:${it.cluster || ''}:${it.uuid}`
      : `tsh:${homeName(home) || home}:${it.cluster || ''}:${it.uuid}`;
  }
  return out;
}

/**
 * The id a requestable kube cluster will carry once granted, parallel to
 * inventoryNodeIds — but keyed by name, not uuid, because a kube_cluster
 * resource (like an app or a database) has no uuid at all. Two kube clusters
 * cannot share a name within one Teleport cluster, so the name is the stable
 * key. A distinct `tsh-kube:` prefix (rather than `tsh:`) means this can
 * never collide with a node id even if some future cluster named a kube
 * resource the same as a node's uuid-shaped string.
 */
function inventoryKubeIds({ items = [], home } = {}) {
  const out = {};
  for (const it of items || []) {
    if (!it || !it.id || !it.name) continue;
    out[it.id] = isDefaultHome(home)
      ? `tsh-kube:${it.cluster || ''}:${it.name}`
      : `tsh-kube:${homeName(home) || home}:${it.cluster || ''}:${it.name}`;
  }
  return out;
}

/** Roles this user may request, via `tsh request search --roles`. */
async function searchRequestableRoles({ proxy } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('request', 'search', '--roles', '--format=json');
  const r = await run(args, { timeout: 45000 });
  if (!r.ok) {
    // eslint-disable-next-line no-control-regex
    const msg = (r.stderr || r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
    return { ok: false, error: msg || 'tsh request search --roles failed', roles: [] };
  }
  let raw;
  try { raw = JSON.parse(r.stdout || '[]'); } catch { return { ok: false, error: 'unparseable role list', roles: [] }; }
  const detailed = parseRequestableRoles(raw);
  // `roles` stays a list of names for everything that already reads it; the
  // descriptions ride alongside for anything that can show them.
  return { ok: true, roles: detailed.map((r) => r.name), details: detailed };
}

/**
 * What `tsh request search --roles` actually returns.
 *
 * `{ "Role": "staging-access", "Description": "SSH to staging RHEL hosts…" }`
 * — capitalised, and `Role` rather than `Name`, which the resource search a
 * few lines above spells differently again. Reading `Name` returned nothing
 * at all, so clusters that offer requestable roles looked like clusters
 * that offer none, and the dialog said "resources only" to someone staring
 * at two perfectly good roles.
 *
 * The description is kept because it is the part that makes a role pickable
 * by someone who did not write the cluster's RBAC: "AWS console access to
 * account 123456789012" says what `aws-access` is for.
 */
function parseRequestableRoles(raw) {
  const out = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    if (typeof x === 'string') { out.push({ name: x, description: '' }); continue; }
    const name = x.Role || x.role || x.Name || x.name || '';
    if (!name) continue;
    out.push({ name, description: x.Description || x.description || '' });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function showRequest(id, { proxy } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('request', 'show', id);
  const r = await run(args);
  return { ok: r.ok, text: (r.stdout || r.stderr).trim() };
}

/** Assume an approved request by re-logging in with it attached. */
async function assumeRequest(id, { proxy } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('login', '--request-id=' + id);
  const r = await run(args, { timeout: 120000 });
  return { ok: r.ok, output: (r.stdout + r.stderr).trim() };
}

/** Drop assumed roles from the current identity. */
async function dropRequest(ids, { proxy } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('request', 'drop', ...(Array.isArray(ids) ? ids : [ids]));
  const r = await run(args, { timeout: 60000 });
  return { ok: r.ok, output: (r.stdout + r.stderr).trim() };
}

/**
 * The argv for a request, built in one place so the dialog can show the user
 * exactly what it is about to run — and let them copy it — rather than
 * describing the command in one place and running it from another.
 */
function createRequestArgs({
  proxy, roles, resources, reason, requestTtl, sessionTtl, maxDuration, assumeStartTime, reviewers, nowait = true,
}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('request', 'create');
  // `--roles` takes one comma-separated list; `--resource` is declared
  // "RESOURCE ..." and accumulates, so a comma-joined list arrives as a single
  // malformed id ("a,b is not a valid ResourceID string") and the request
  // fails. Repeat the flag instead.
  if (roles?.length) args.push('--roles=' + roles.join(','));
  for (const id of resources || []) args.push('--resource=' + id);
  if (reason) args.push('--reason=' + reason);
  if (reviewers?.length) args.push('--reviewers=' + reviewers.join(','));
  if (requestTtl) args.push('--request-ttl=' + requestTtl);
  if (sessionTtl) args.push('--session-ttl=' + sessionTtl);
  if (maxDuration) args.push('--max-duration=' + maxDuration);
  if (assumeStartTime) args.push('--assume-start-time=' + assumeStartTime);
  if (nowait) args.push('--nowait');
  return args;
}

/**
 * Raise an access request.
 *
 * `--nowait` matters: without it tsh blocks until a reviewer resolves the
 * request, so the dialog would sit there until the timeout and then report a
 * failure for a request that was in fact created. Returning straight away lets
 * the list show it as PENDING, which is the truth.
 */
/**
 * The roles these resources have been granted through before, out of your
 * own request history.
 *
 * The only source that can name the whole set. Teleport will not enumerate
 * the roles that apply to a resource request — there is no dry run, the
 * resource search carries no roles, and `request search --roles` lists role
 * requests rather than the search_as_roles a resource request resolves
 * through — and the one way to make it say them is to raise a request,
 * which is not something a dialog may do to find out what to put in a
 * dialog. A past request, though, carries both its resource ids and the
 * roles it was raised with, and reading that costs nothing.
 */
function rolesForResources(requests, resourceIds) {
  const want = new Set((resourceIds || []).filter(Boolean));
  if (!want.size) return [];
  const out = new Set();
  for (const req of requests || []) {
    const ids = (req.resources || []).map((r) => r.id).filter(Boolean);
    if (!ids.some((id) => want.has(id))) continue;
    for (const role of req.roles || []) out.add(role);
  }
  return [...out];
}

/*
 * A role name no cluster can have, used to make a probe harmless.
 *
 * `tsh request create` validates before it creates, and an unrequestable
 * role fails that validation — so a probe carrying this one cannot raise a
 * request however far it gets. Verified against a live cluster: the request
 * count is the same before and after.
 */
const PROBE_ROLE = '__serverlife_probe__';

/**
 * What this cluster will want for a request on these resources, asked
 * before anybody types anything.
 *
 * There is no supported way to ask: this `tsh` has no dry run, and neither
 * the JSON nor the table of `request search` carries the roles that would
 * grant a resource — Teleport Connect gets them from the API it embeds. So
 * the question is put as a request that cannot succeed, and the refusal is
 * read.
 *
 * The order tsh validates in is what makes it useful. The reason is checked
 * first, and the message names the role the requirement comes from —
 * "request reason must be specified (required for role \"access\")" — along
 * with the cluster's own wording for *why*, which is worth far more than a
 * placeholder we invented. Only after that does it reject the probe role.
 * Either way nothing is created.
 */
async function probeRequest({ proxy, home, resources = [] } = {}) {
  if (!resources.length) return { ok: false, roles: [], reasonRequired: false, prompt: '' };
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('request', 'create', '--roles=' + PROBE_ROLE, '--nowait');
  for (const id of resources) args.push('--resource=' + id);

  const r = await run(args, { timeout: 45000, home });
  const out = plain((r.stdout || '') + '\n' + (r.stderr || ''));
  return { ok: true, ...readProbe(out) };
}

/** Everything the refusal tells us, separated from how it is phrased. */
function readProbe(output) {
  const text = String(output || '');
  const roles = new Set();
  // "required for role "access"" — one per role that wants a reason.
  for (const m of text.matchAll(/required for role\s+"([^"]+)"/gi)) roles.add(m[1]);
  for (const m of text.matchAll(/role\s+"([^"]+)"\s+requires? a reason/gi)) roles.add(m[1]);
  roles.delete(PROBE_ROLE);

  const reasonRequired = /reason must be specified|reason is required|requires? a reason/i.test(text);
  /*
   * The cluster's own prompt, which a role sets as `request_prompt`. tsh
   * prints it on the line after the refusal, and it is the one piece of
   * this that was written for the person reading it — "Include a ticket or
   * case reference" is worth more than any wording of ours.
   */
  let prompt = '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const at = lines.findIndex((l) => /reason must be specified|reason is required/i.test(l));
  if (at >= 0) {
    const next = lines[at + 1] || '';
    if (next && !/^(ERROR|Hint:|Creating request)/i.test(next) && !/^tsh /.test(next)) prompt = next;
  }
  return { roles: [...roles], reasonRequired, prompt };
}

async function createRequest(opts) {
  const args = createRequestArgs(opts);
  const r = await run(args, { timeout: 120000 });
  const output = (r.stdout + r.stderr).trim();
  // tsh prints the new id as "Request ID: <uuid>"; hand it back so the caller
  // can point at the request it just made.
  const m = output.match(/Request ID:\s*(\S+)/i);
  return {
    ok: r.ok,
    output,
    requestId: m ? m[1] : null,
    // When several roles could satisfy the request, tsh stops and asks which
    // — a question a spawned process cannot answer. The names it listed come
    // back so the caller can ask the person instead.
    roleChoices: r.ok ? [] : roleChoicesFrom(output),
    needsReason: !r.ok && /reason/i.test(output) && /required|must be/i.test(output),
  };
}

/**
 * The roles tsh was about to make you choose between.
 *
 * `tsh request create` for a resource works out which of your
 * search_as_roles could grant it. With more than one it stops and asks,
 * which from a spawned process means "failed reading prompt response: EOF"
 * and no request — the most confusing way for this to fail, because
 * everything in the dialog was right and nothing in the error says what to
 * do about it.
 *
 * The listing it prints before the prompt is the whole answer, so it is
 * read back out: a numbered list, or the bracketed set some versions print.
 * Tolerant on purpose — a missed parse costs the old error message, and a
 * wrong one would put nonsense in front of the user as roles.
 */
function roleChoicesFrom(output) {
  const text = String(output || '');
  if (!/prompt response|choose (a )?role|select (a )?role|available roles/i.test(text)) return [];
  const out = [];
  for (const line of text.split('\n')) {
    // "  1. dev-access" or "  [2] dev-access"
    const m = line.match(/^\s*(?:\[\d+\]|\d+[.)])\s+([A-Za-z0-9_.@/-]{2,})\s*$/);
    if (m) out.push(m[1]);
  }
  if (!out.length) {
    // "Choose roles to request [access, dev-access]:"
    const m = text.match(/roles?[^[\n]*\[([^\]]+)\]/i);
    if (m && m[1].includes(',')) {
      for (const bit of m[1].split(',')) {
        const v = bit.trim();
        if (/^[A-Za-z0-9_.@/-]{2,}$/.test(v)) out.push(v);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Recorded sessions for a cluster. `tsh recordings ls` returns session.end
 * audit events, which carry everything needed to identify and replay a
 * recording.
 */
async function listRecordings({ proxy, fromUtc, toUtc, limit } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('recordings', 'ls', '--format=json');
  // Without a range tsh only lists the last 24 hours, which silently hides
  // everything older — so always send one.
  const from = toRecordingDate(fromUtc);
  const to = toRecordingDate(toUtc);
  if (from) args.push('--from-utc=' + from);
  if (to) args.push('--to-utc=' + to);
  if (limit) args.push('--limit=' + limit);

  const r = await run(args, { timeout: 60000 });
  // eslint-disable-next-line no-control-regex
  const errText = (r.stderr || r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  // tsh exits 0 on a rejected range, so the message has to be read.
  if (/too large/i.test(errText)) {
    return {
      ok: false,
      error: 'That date range is larger than the cluster allows — try 180 days or less.',
      recordings: [],
    };
  }
  if (!r.ok || /^ERROR:/i.test(errText)) {
    return { ok: false, error: errText || 'tsh recordings ls failed', recordings: [] };
  }

  let raw;
  try { raw = JSON.parse(r.stdout || '[]'); } catch { return { ok: false, error: 'unparseable recordings output', recordings: [] }; }

  // A non-ssh session (app, db, kube) emits its own differently-shaped
  // events rather than one session.end — a real `app` session on a shared
  // cluster came back as three `app.session.chunk` events sharing one sid,
  // none of them carrying server_hostname/interactive/session_start. Keep
  // the last event seen per sid: for a multi-event session that is the one
  // most likely to be the summary event with the fullest fields.
  // `tsh recordings ls` also surfaces audit events that are not a recording
  // at all — a real `beam.destroyed` event came back alongside genuine
  // session.end/session.chunk ones, sharing the same `sid` field (the
  // beam's own id) but none of a recording's substance (no proto, no
  // playable stream). Every genuine recording event, ssh/app/db/kube
  // alike, always carries `proto`; that's the one field reliably absent
  // from this kind of noise, so it's the filter.
  const bySid = new Map();
  for (const e of Array.isArray(raw) ? raw : []) {
    if (e && e.sid && e.proto) bySid.set(e.sid, e);
  }

  const recordings = [...bySid.values()].map((e) => {
    const start = e.session_start ? new Date(e.session_start).getTime() : null;
    const stop = e.session_stop ? new Date(e.session_stop).getTime() : null;
    // A real kube session.end event carries BOTH `server_hostname` (the
    // underlying kube_service node's own registration — an internal
    // detail, not what anyone searches by; confirmed against a real
    // cluster to equal the Teleport cluster's own domain here, not the
    // kube cluster at all) and the field that actually matters,
    // `kubernetes_cluster` — checked first for exactly that reason. ssh
    // carries no `kubernetes_cluster` at all, so this falls through to
    // `server_hostname` for it exactly as before.
    const name = e.kubernetes_cluster || e.server_hostname
      || e.app_name || e.db_service_name || e.db_name
      || e.server_id || (e.sid ? e.sid.slice(0, 8) : '');
    return {
      sid: e.sid,
      cluster: e.cluster_name,
      proxy,
      user: e.user,
      login: e.login,
      node: name,
      nodeId: e.server_id,
      addr: e.server_addr,
      proto: e.proto || 'ssh',
      // Absent (not explicitly false) shouldn't hide a recording that
      // otherwise has no way to say whether it was interactive — a non-ssh
      // session simply doesn't carry this field at all.
      interactive: e.interactive !== false,
      participants: e.participants || [],
      recordingMode: e.session_recording,
      labels: e.server_labels || {},
      startedAt: start,
      endedAt: stop,
      durationMs: start && stop ? stop - start : null,
      // A session recorded with mode "off" has no playable stream.
      playable: e.session_recording !== 'off',
    };
  }).filter((x) => x.sid);

  recordings.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return { ok: true, recordings };
}

/** Argv for replaying a recording in a local PTY. */
/**
 * `tsh latency ssh [user@]host` — the round trip from here to the proxy and
 * from the proxy to the node, updating live.
 *
 * It draws a TUI and opens /dev/tty itself, so it cannot be captured and
 * summarised: it has to be given a real terminal. The app therefore runs it in
 * a tab, the same way a session recording is replayed.
 */
function latencyArgs({ proxy, cluster, node, login } = {}) {
  if (!node) throw new Error('Which node? A hostname is needed.');
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('latency', 'ssh');
  if (cluster) args.push('--cluster=' + cluster);
  args.push(login ? `${login}@${node}` : node);
  return args;
}

function playArgs(sid, { proxy, cluster, speed, skipIdle } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('play');
  if (cluster) args.push('--cluster=' + cluster);
  if (speed) args.push('--speed=' + speed);
  if (skipIdle) args.push('--skip-idle-time');
  args.push(sid);
  return args;
}

/**
 * Sessions going on right now — see livesessions.js for the shapes.
 *
 * The proxy picks the tsh home, so a second logged-in cluster is asked about
 * its own sessions and not the active profile's.
 */
async function listActiveSessions({ proxy, home } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('sessions', 'ls', '--format=json');
  const r = await run(args, { home, timeout: 30000 });
  if (r.ok) {
    try { return { ok: true, sessions: livesessions.parseSessionList(r.stdout) }; } catch { /* not JSON: reported below */ }
  }
  // eslint-disable-next-line no-control-regex
  const msg = (r.stderr || r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  return { ok: false, error: msg || 'tsh sessions ls failed', sessions: [] };
}

/** Plain-text transcript of a recording. */
async function playText(sid, { proxy, cluster } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('play', '--format=text');
  if (cluster) args.push('--cluster=' + cluster);
  args.push(sid);
  const r = await run(args, { timeout: 120000 });
  const text = r.stdout || '';
  // tsh exits 0 even when a recording is missing, so detect it in the output.
  if (/was not found/i.test(r.stderr) || (!text.trim() && /not found/i.test(r.stderr))) {
    return { ok: false, error: 'no stored recording', text: '' };
  }
  if (!r.ok && !text) return { ok: false, error: (r.stderr || 'tsh play failed').trim(), text: '' };
  return { ok: true, text };
}

/**
 * Search the transcripts of recorded sessions.
 *
 * Each transcript is a separate `tsh play`, so this is deliberately bounded:
 * a time range, a cap on how many sessions to open, and a small amount of
 * concurrency. Progress is reported as it goes because a wide range is slow.
 */
async function searchRecordings({
  proxy, cluster, fromUtc, toUtc, query,
  caseSensitive = false, useRegex = false,
  limit = 200, concurrency = 4, contextLines = 1,
  // Non-interactive exec sessions carry no transcript, so searching them is
  // just wasted round trips. Opt in if you want them counted anyway.
  interactiveOnly = true,
  saveDir = null, onProgress = null, shouldStop = null,
} = {}) {
  if (!query || !String(query).trim()) throw new Error('Enter something to search for');

  const listed = await listRecordings({ proxy, fromUtc, toUtc });
  if (!listed.ok) return { ok: false, error: listed.error, results: [] };

  const eligible = listed.recordings.filter((r) => r.playable && (!interactiveOnly || r.interactive));
  const skippedNonInteractive = listed.recordings.length - eligible.length;
  const candidates = eligible.slice(0, limit);
  let matcher;
  if (useRegex) {
    try { matcher = new RegExp(query, caseSensitive ? 'g' : 'gi'); }
    catch (e) { throw new Error('Invalid regular expression: ' + e.message, { cause: e }); }
  }
  const needle = caseSensitive ? String(query) : String(query).toLowerCase();

  const results = [];
  let scanned = 0;
  let failed = 0;

  if (saveDir) await fsp.mkdir(saveDir, { recursive: true });

  const worker = async () => {
    for (;;) {
      if (shouldStop?.()) return;
      const rec = candidates.shift();
      if (!rec) return;

      let got;
      try { got = await playText(rec.sid, { proxy, cluster: rec.cluster || cluster }); }
      catch (e) { got = { ok: false, error: e.message, text: '' }; }

      scanned++;
      if (!got.ok) {
        failed++;
        onProgress?.({ scanned, total: scanned + candidates.length, matches: results.length, current: rec.node });
        continue;
      }

      if (saveDir) {
        const name = `${new Date(rec.startedAt || Date.now()).toISOString().slice(0, 19).replace(/[:]/g, '-')}_${rec.node || 'node'}_${rec.sid.slice(0, 8)}.txt`;
        await fsp.writeFile(path.join(saveDir, name), got.text, 'utf8').catch(() => {});
      }

      const lines = got.text.replace(/\r/g, '').split('\n');
      const hits = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let found = false;
        if (matcher) { matcher.lastIndex = 0; found = matcher.test(line); }
        else found = (caseSensitive ? line : line.toLowerCase()).includes(needle);
        if (!found) continue;
        hits.push({
          line: i + 1,
          text: line.slice(0, 400),
          before: lines.slice(Math.max(0, i - contextLines), i).map((l) => l.slice(0, 400)),
          after: lines.slice(i + 1, i + 1 + contextLines).map((l) => l.slice(0, 400)),
        });
        if (hits.length >= 50) break;   // enough to judge relevance
      }

      if (hits.length) results.push({ ...rec, matchCount: hits.length, hits, bytes: got.text.length });
      onProgress?.({ scanned, total: scanned + candidates.length, matches: results.length, current: rec.node });
    }
  };

  const total = candidates.length;
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));

  results.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return {
    ok: true,
    results,
    scanned,
    failed,
    total,
    skippedNonInteractive,
    listed: listed.recordings.length,
    savedTo: saveDir,
    stopped: !!shouldStop?.(),
  };
}

/** Deep link to a recording in the Teleport web UI. */
function webSessionUrl({ proxy, cluster, sid }) {
  if (!proxy || !sid) return null;
  const host = String(proxy).replace(/^https?:\/\//, '');
  return `https://${host}/web/cluster/${encodeURIComponent(cluster || '')}/session/${encodeURIComponent(sid)}`;
}

/**
 * Link to a cluster in the Teleport web UI.
 *
 * The proxy address carries a port more often than not — `example.com:3080`, or
 * `:443` spelled out — and that is part of the host, so it is kept. Anything a
 * profile might have stored in front of it (`https://`) or behind it (a path)
 * is not.
 *
 * `section` picks the page: the default lands on the node list, which is what
 * "open this cluster" means in an app whose whole subject is servers. A cluster
 * name is always included, and for a root cluster that is simply itself — the
 * web UI uses the same `/web/cluster/<name>/` shape either way, so no root and
 * leaf distinction is needed here.
 */
function webClusterUrl({ proxy, cluster, section = 'resources' } = {}) {
  if (!proxy) return null;
  const host = String(proxy).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host) return null;
  const name = String(cluster || '').trim();
  // Without a cluster name, the web UI's own landing page resolves the
  // caller's default cluster, which is better than guessing at one.
  if (!name) return `https://${host}/web`;
  const path = { resources: 'resources', nodes: 'resources', audit: 'audit/events', sessions: 'session-recordings' }[section]
    || 'resources';
  return `https://${host}/web/cluster/${encodeURIComponent(name)}/${path}`;
}

/**
 * Make a profile the active one, or point it at another cluster in its trust
 * web (re-auth only if the certificate has expired).
 *
 * The cluster is `tsh login`'s positional argument and only that: `--cluster`
 * is a flag on most tsh commands but not on `login`, which rejects it outright
 * with "unknown long flag". `loginArgs` already spells this correctly, so the
 * form lives in one place.
 */
async function switchProfile({
  proxy, cluster, user, authConnector, ttl, mfaMode, extraArgs, home,
} = {}) {
  /*
   * The whole saved command, not just the proxy.
   *
   * A cluster with an auth connector, a TTL or extra flags needs them here as
   * much as it did the first time: `tsh login --proxy=…` without the
   * connector either picks a different one or falls back to local auth, and
   * what comes back is a certificate for someone other than the person the
   * list is showing. Everything is optional, so a cluster with none of it
   * produces exactly the command this used to build.
   */
  const args = loginArgs({ proxy, cluster, user, authConnector, ttl, mfaMode, extraArgs });
  const r = await run(args, { timeout: 180000, home });
  if (r.ok) markCurrentProfile(proxy, home);
  return { ok: r.ok, output: plain(`${r.stdout}\n${r.stderr}`) };
}

/**
 * Make a profile the one plain `tsh` uses, in the home that holds it.
 *
 * `tsh login` against a certificate that is still valid re-issues nothing and
 * prints the status with the requested profile marked active — and, in tsh 18
 * at least, does not record the switch: `current-profile` keeps naming the
 * old cluster, and the next plain `tsh` command goes there. So switching
 * "worked" in its own output and nowhere else. The file is a profile name —
 * the proxy's host — and a newline, the same thing tsh writes; it is only
 * written when that home really has a profile by that name, so a typo cannot
 * point tsh at nothing.
 */
function markCurrentProfile(proxy, home) {
  const name = proxyAddress(proxy).replace(/:\d+$/, '');
  if (!name) return false;
  const dir = expandHome(home)
    || expandHome(homeScope.getStore()?.home)
    || expandHome(homeForProxy(proxy))
    || DEFAULT_HOME;
  try {
    if (!fs.existsSync(path.join(dir, `${name}.yaml`))) return false;
    fs.writeFileSync(path.join(dir, 'current-profile'), name + '\n', { mode: 0o640 });
    return true;
  } catch {
    return false;
  }
}

/**
 * A proxy address as `tsh --proxy` wants it: host and port, nothing else.
 *
 * The address people have is the one in their browser, so it arrives as
 * `https://example.teleport.sh/web` — and `tsh login --proxy=https://…`
 * fails, or worse, logs in and then stores a profile under a name that
 * nothing else in the app matches. The scheme and anything after the host are
 * dropped; the port is part of the host and is kept.
 *
 * Done here rather than in the form so it holds for a cluster saved before
 * this, for one imported from somewhere else, and for every command built from
 * it — not just for what was typed today.
 */
function proxyAddress(value) {
  return String(value || '').trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')   // https://, http://, anything else
    .replace(/^[^/@]*@/, '')                   // a user pasted along with it
    .replace(/\/.*$/, '')                      // /web, /web/cluster/…
    .trim();
}

/**
 * `tsh login`. The cluster is a positional argument, not a flag, and extra
 * flags are passed through verbatim for anything this form does not cover.
 */
function loginArgs({ proxy, cluster, user, authConnector, ttl, mfaMode, extraArgs } = {}) {
  const args = ['login'];
  const addr = proxyAddress(proxy);
  if (addr) args.push('--proxy=' + addr);
  if (user) args.push('--user=' + user);
  if (authConnector) args.push('--auth=' + authConnector);
  if (ttl) args.push('--ttl=' + ttl);
  if (mfaMode) args.push('--mfa-mode=' + mfaMode);
  if (Array.isArray(extraArgs)) args.push(...extraArgs.filter(Boolean));
  if (cluster) args.push(cluster);
  return args;
}

async function login(opts = {}) {
  // SSO opens a browser and waits for the callback, so allow a long timeout.
  const r = await run(loginArgs(opts), { timeout: 300000, home: opts.home });
  /*
   * tsh's version warning goes to the terminal and nowhere else, and a
   * login run here has no terminal — so it was being discarded along with
   * the rest of the output, and a successful login said "Logged in" over a
   * client the cluster does not support. Both the warning and the verdict
   * travel with the result; on a failed login the verdict is the likeliest
   * explanation the caller has.
   */
  const versionWarning = parseVersionWarning(`${r.stdout}\n${r.stderr}`);
  const compat = await compatFor({ proxy: opts.proxy, home: opts.home, refresh: true }).catch(() => null);
  return { ...r, versionWarning, compat };
}

/**
 * The same login as a line to paste into a terminal.
 *
 * Worth having for its own sake — a login that will not go through in the app
 * (a hardware key that wants a real TTY, an SSO flow that needs the browser's
 * own session) is something you finish by hand. With several tsh homes it
 * matters more: the same command against the wrong home writes the certificate
 * where nothing will look for it, so the variable is part of the line.
 */
function loginCommand(opts = {}) {
  const home = expandHome(opts.home);
  const parts = [];
  if (home && home !== DEFAULT_HOME) parts.push(`TELEPORT_HOME=${shellQuote(home)}`);
  parts.push('tsh', ...loginArgs(opts).map(shellQuote));
  return parts.join(' ');
}

/** Quote only what a shell would otherwise mangle. */
function shellQuote(value) {
  const v = String(value);
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Drop a certificate. With no proxy this is every profile in the home; with one
 * it is that cluster alone, which is what a list of clusters wants to offer.
 */
async function logout({ proxy, user, home } = {}) {
  const args = ['logout'];
  if (proxy) args.push('--proxy=' + proxy);
  if (user) args.push('--user=' + user);
  const r = await run(args, { timeout: 60000, home });
  return { ok: r.ok, output: plain(r.stderr || r.stdout) };
}

/**
 * What `tsh status` would list for a profile, on disk.
 *
 * A profile is a `<proxy>.yaml` beside a `keys/<proxy>` directory in the
 * home. The yaml is what makes tsh list the cluster at all; the keys are the
 * certificate material, and on an expired profile they are usually already
 * gone — which is exactly the state that leaves a cluster listed forever
 * with empty roles and [EXPIRED] against it.
 */
function profilePaths(proxy, home) {
  const dir = expandHome(home) || DEFAULT_HOME;
  /*
   * A proxy is a host and a port, and nothing else. It arrives from the
   * renderer, and it is about to be turned into a path to delete — so it is
   * checked rather than trusted, and anything with a separator or a dot
   * segment in it is refused outright.
   */
  const proxyName = String(proxy || '').trim();
  if (!proxyName || !/^[A-Za-z0-9._-]+(:\d+)?$/.test(proxyName) || proxyName.includes('..')) return null;

  /*
   * A profile is named after the proxy *host*, and the address carries a
   * port: `training-1.teleport.sh:443` is stored as
   * `training-1.teleport.sh.yaml`. Both spellings are tried rather than
   * assumed, because a proxy on a non-standard port is stored under the
   * name tsh chose, and guessing wrong here means reporting "nothing to
   * delete" over a file that is plainly there.
   */
  const host = proxyName.split(':')[0];
  const candidates = [...new Set([proxyName, host])];
  const yaml = candidates.map((n) => path.join(dir, n + '.yaml')).find((f) => fs.existsSync(f))
    || path.join(dir, host + '.yaml');
  const keys = candidates.map((n) => path.join(dir, 'keys', n)).find((f) => fs.existsSync(f))
    || path.join(dir, 'keys', host);

  return {
    dir,
    yaml,
    keys,
    current: path.join(dir, 'current-profile'),
    // What `current-profile` holds, which is the same name the file uses.
    name: path.basename(yaml, '.yaml'),
    names: candidates,
  };
}

/**
 * Remove a profile from the tsh home: the files, not a `tsh logout`.
 *
 * `tsh logout` is the polite way and the right one for a live cluster. It is
 * the wrong one here: this exists for a profile whose certificate has
 * expired — a lab that was torn down, a demo cluster that no longer resolves
 * — and logging out of a proxy that is not answering can sit there until it
 * times out. Deleting the profile always works, and it is precisely what
 * logout would leave behind.
 *
 * Reported rather than assumed: the caller is told which paths actually went,
 * so a dialog can say so instead of claiming success over a no-op.
 */
async function removeProfile({ proxy, home } = {}) {
  const paths = profilePaths(proxy, home);
  if (!paths) return { ok: false, error: 'That does not look like a proxy address.' };

  const removed = [];
  try {
    await fsp.rm(paths.yaml, { force: true });
    if (fs.existsSync(paths.yaml)) return { ok: false, error: 'The profile file is still there.' };
    removed.push(paths.yaml);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // Key material for the same proxy, when any survived the expiry.
  try {
    if (fs.existsSync(paths.keys)) {
      await fsp.rm(paths.keys, { recursive: true, force: true });
      removed.push(paths.keys);
    }
  } catch { /* the profile is gone either way; orphaned keys are inert */ }

  /*
   * `current-profile` holds one proxy name. Left pointing at a profile that
   * no longer exists, tsh complains on every command — so if it named this
   * one, it goes too, which is the state tsh is in before any login.
   */
  try {
    if (fs.existsSync(paths.current)) {
      const cur = (await fsp.readFile(paths.current, 'utf8')).trim();
      if (cur === paths.name || paths.names.includes(cur)) {
        await fsp.rm(paths.current, { force: true });
        removed.push(paths.current);
      }
    }
  } catch { /* nothing readable there is nothing to correct */ }

  for (const n of paths.names) homeByProxy.delete(n);
  return { ok: true, removed };
}

/** What removing a profile would delete, for a dialog to show first. */
function profileFiles({ proxy, home } = {}) {
  const paths = profilePaths(proxy, home);
  if (!paths) return [];
  return [paths.yaml, paths.keys].filter((f) => fs.existsSync(f));
}

module.exports = {
  markCurrentProfile, expandHome, tctlRun,
  findTsh, version, compatibility, parseVersionWarning, versionInfo, compatFor,
  status, statusText, listNodes, listClusters, isLeafCluster, writeClusterSshConfig,
  removeProfile, profileFiles,
  clusterSshConfigText,
  setHomes, listHomes, activeHomes, homeForProxy, homeName, isDefaultHome, tshEnv, withHome,
  setTshPath, tshStatus, chosenTsh, parseEnvText, setEnvSettings, envFor, envForShells, proxyInArgs, bareProxy,
  DEFAULT_HOME,
  teleportSshTarget, markAmbiguous, roleChoicesFrom, probeRequest, readProbe, rolesForResources,
  parseRequestableRoles, login, loginArgs, loginCommand, logout, run, proxyAddress,
  listRequests, showRequest, assumeRequest, dropRequest, createRequest, switchProfile,
  searchRequestable, searchRequestableRoles, REQUEST_KINDS, createRequestArgs, inventoryNodeIds, inventoryKubeIds,
  listRecordings, listActiveSessions, playArgs, latencyArgs, webSessionUrl, webClusterUrl, playText, searchRecordings,
  toRecordingDate,
  findTctl, createJoinToken, nodeInstallCommand,
};
