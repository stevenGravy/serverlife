'use strict';
/**
 * Teleport Application Access — generic app listing, login, and the
 * ephemeral local-proxy pattern `awsproxy.js` already proves for AWS,
 * generalized to Azure and GCP cloud CLI apps and to plain HTTP/TCP apps.
 *
 * AWS keeps using `awsproxy.js` untouched (its credential/role flow is AWS-
 * specific); this module adds the generic `apps ls` listing every app kind
 * needs, and the Azure/GCP equivalent of `awsproxy.js`'s `ensure()` for
 * "Open CLI shell".
 *
 * `--app`/`--format=unix` are confirmed against `tsh proxy azure --help`/
 * `tsh proxy gcloud --help` on a live cluster (an earlier `--tunnel` guess
 * was wrong and failed outright). GCP was confirmed working end to end
 * against a real app (`tsh apps login` then `tsh proxy gcloud --format=unix`
 * printed real `CLOUDSDK_*`/`HTTPS_PROXY` exports). Azure apps backed by a
 * Managed Identity (confirmed against two separate real apps, on two
 * separate clusters, both failing identically) cannot log in from any
 * machine that isn't the actual Azure VM the identity belongs to — not an
 * ServerLife bug, and not fixable by installing `az` locally; see
 * AZURE_IDENTITY_FAIL_RE below for how that specific failure is recognized
 * and explained rather than surfaced as a bare "exit status 1". The scan
 * below is deliberately generic (captures every `export VAR="value"` line
 * rather than a fixed whitelist) so it does not depend on guessing exact
 * variable names per cloud.
 */

const { spawn } = require('child_process');
const teleport = require('./teleport');
const awsproxy = require('./awsproxy');

const EXPORT_RE = /export\s+([A-Z_][A-Z0-9_]*)="([^"]*)"/g;

/** cloud app -> { child, env, startedAt } for Azure/GCP; AWS stays in awsproxy.js's own map. */
const running = new Map();

// eslint-disable-next-line no-control-regex
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

/**
 * Azure apps backed by a Managed Identity fail identically from any machine
 * that isn't the Azure VM the identity is attached to — confirmed against
 * two real apps on two different clusters, both ending in the same
 * "exit status 1" with the actual reason one line above it. Recognized here
 * so that reason is what gets shown, not the bare exit code — installing
 * the Azure CLI does not fix this; the identity itself cannot be assumed
 * from off-Azure.
 */
const AZURE_IDENTITY_FAIL_RE = /failed to automatically login with `az login` using identity "([^"]+)"/;

/**
 * The GCP equivalent of the Azure identity failure above — caught live
 * against a real app: the token-minting call itself succeeds in starting
 * (unlike Azure, which fails before a tunnel ever opens), but every actual
 * `gcloud` call then 500s with this. Unlike Azure's, this one is fixable —
 * it is a missing `roles/iam.serviceAccountTokenCreator` grant on whichever
 * principal the Teleport App Service runs as, not a hard platform limit.
 */
// The real text HTML-encodes its quotes (`&#39;`), not literal `'` —
// caught live failing to match until this stopped assuming which.
const GCP_TOKEN_FAIL_RE = /Permission (?:'|&#39;)iam\.serviceAccounts\.getAccessToken(?:'|&#39;) denied/;

/**
 * A second, distinct GCP failure caught live on the *other* service account
 * of the same app — "permission denied" above means the account exists but
 * can't be impersonated; "Gaia id not found" means Google has no such
 * identity at all anymore (deleted, or never real) even though Teleport's
 * own app config still lists it as an option.
 */
const GCP_NOT_FOUND_RE = /Gaia id not found for email ([\w.-]+@[\w.-]+\.iam\.gserviceaccount\.com)/;

/**
 * The line worth showing from a failed tsh/gcloud/az command's combined
 * output. `exec.Cmd`-wrapped failures often end in a bare "exit status N"
 * with the actual reason on the line before it — a plain "last non-blank
 * line" picks the code, not the reason, which is what a bare "exit status 1"
 * with zero context came from.
 */
function bestErrorLine(text) {
  const plain = stripAnsi(text);
  const lines = plain.split('\n').map((l) => l.trim()).filter(Boolean);
  const identity = lines.map((l) => AZURE_IDENTITY_FAIL_RE.exec(l)).find(Boolean);
  if (identity) {
    return `This app's Azure identity (${identity[1].split('/').pop()}) is a Managed Identity — `
      + 'it can only log in from the actual Azure VM it belongs to, not from this machine. '
      + 'Ask whoever set up this app about a different auth method.';
  }
  if (GCP_TOKEN_FAIL_RE.test(plain)) {
    return 'The Teleport App Service running this app can’t mint a token for its service '
      + 'account — it’s missing the "Service Account Token Creator" IAM role on that '
      + 'service account. This is a one-time GCP IAM grant, not something fixable from here.';
  }
  const notFound = GCP_NOT_FOUND_RE.exec(plain);
  if (notFound) {
    return `This GCP service account (${notFound[1]}) doesn’t exist in Google’s identity system `
      + 'anymore, even though this app still offers it — ask whoever manages this Teleport app '
      + 'to remove it or replace it with a real one.';
  }
  const meaningful = lines.filter((l) => !/^exit status \d+$/.test(l));
  return meaningful.pop() || lines.pop() || '';
}

/** Every Teleport app visible to this proxy, normalized and unfiltered. */
async function listApps({ proxy, home } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('apps', 'ls', '--format=json');
  const r = await teleport.run(args, { timeout: 30000, home });
  if (!r.ok) throw new Error(stripAnsi(r.stderr || r.stdout).trim() || 'tsh apps ls failed');
  let raw;
  try { raw = JSON.parse(r.stdout || '[]'); } catch { throw new Error('Unreadable app list from tsh.'); }
  return (raw || []).map((a) => {
    const spec = a.spec || {};
    const uri = spec.uri || '';
    const scheme = (uri.match(/^([a-z][a-z0-9+.-]*):\/\//i) || [])[1] || '';
    return {
      name: a.metadata?.name,
      description: a.metadata?.description || '',
      labels: a.metadata?.labels || {},
      publicAddr: spec.public_addr || '',
      uri,
      cloud: spec.cloud || null,              // 'AWS' | 'Azure' | 'GCP' | null
      integration: spec.integration || null,
      subKind: a.sub_kind || null,            // e.g. 'mcp'
      // MCP apps (sub_kind: 'mcp', uri scheme mcp+stdio/http/https://) are
      // Teleport's own relayed MCP protocol, not plain HTTP — checked first
      // so one never gets misread as a web app. 'cloud' apps (uri scheme
      // cloud://) and plain https/http apps both drive the Log in / Launch
      // in Web UI pair; tcp:// is the VNet case.
      transport: a.sub_kind === 'mcp' ? 'mcp' : spec.cloud ? 'cloud' : (scheme === 'tcp' ? 'tcp' : 'http'),
    };
  });
}

/** Just the apps a cloud-CLI picker cares about — AWS, Azure, and GCP. */
async function listCloudApps(opts = {}) {
  return (await listApps(opts)).filter((a) => a.cloud);
}

/**
 * Open shell in Web UI / log in — the two actions every HTTP app row gets.
 * No AWS role here: an AWS app may offer several IAM roles, and `tsh apps
 * login` refuses ambiguously without `--aws-role` — see listAwsRoles()/
 * loginCloud() below for the cloud-app path, which resolves one first.
 */
async function login(appName, { proxy, home } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('apps', 'login', appName);
  const r = await teleport.run(args, { timeout: 120000, home });
  const text = stripAnsi(`${r.stdout}\n${r.stderr}`).trim();
  if (!r.ok) throw new Error(bestErrorLine(text) || 'tsh apps login failed');
  return { ok: true, output: text };
}

/** The IAM roles an AWS app offers — delegates to awsproxy.js, which already knows the shape. */
async function listAwsRoles(appName, opts = {}) {
  return awsproxy.listAwsRoles(appName, opts);
}

/**
 * The GCP service accounts an app offers when ambiguous — confirmed live
 * against a real app (`google-cloud-cli` on a real cluster, two accounts):
 * `tsh apps login` prints a plain list of `name@project.iam.gserviceaccount.com`
 * lines and refuses with "multiple GCP service accounts available, choose
 * one with --gcp-service-account flag", the exact GCP equivalent of AWS's
 * multi-role refusal. Not finding a list here doesn't mean there is only
 * one — it means this app answered directly instead of asking, same as a
 * single-role AWS app.
 */
const GCP_ACCOUNT_RE = /^[\w.-]+@[\w.-]+\.iam\.gserviceaccount\.com$/;

async function listGcpServiceAccounts(appName, { proxy, home } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  // Caught live: a session already logged in to this app — even from this
  // same picker's own previous run — answers `apps login` immediately
  // with whichever account it already has, instead of refusing with the
  // list. Logging out first guarantees the refusal (and the list that
  // comes with it) every time, not just the first.
  await teleport.run([...args, 'apps', 'logout', appName], { timeout: 15000, home }).catch(() => {});
  const r = await teleport.run([...args, 'apps', 'login', appName], { timeout: 30000, home });
  const text = stripAnsi(`${r.stdout}\n${r.stderr}`);
  return text.split('\n').map((l) => l.trim()).filter((l) => GCP_ACCOUNT_RE.test(l));
}

/**
 * Log in to a cloud app with the identity it needs before opening a CLI
 * shell for it. AWS apps commonly offer several IAM roles, GCP apps several
 * service accounts — both resolved by the caller via `listAwsRoles()`/
 * `listGcpServiceAccounts()` first; this is the one place that actually
 * sends `--aws-role`/`--gcp-service-account`, so which identity gets
 * assumed is never left implicit. Azure has no equivalent multi-identity
 * picker confirmed (it fails before ever reaching one); it logs in plainly.
 */
// A successful single-role AWS login names the role it used even though
// nothing was asked — picked up here so the caller can still say which one,
// not just when listAwsRoles() found more than one to choose between.
const LOGGED_IN_ROLE_RE = /Your IAM role:\s*\n\s*arn:aws:iam::\d+:role\/(\S+)/;
const LOGGED_IN_GCP_ACCOUNT_RE = /Your service account:\s*([\w.-]+@[\w.-]+\.iam\.gserviceaccount\.com)/;

async function loginCloud(appName, cloud, identity, opts = {}) {
  if (cloud === 'AWS') {
    // A proxy already running for this app was started with whatever role
    // was chosen last time — stopped here so a different role picked now
    // doesn't silently keep serving the old one from cache.
    awsproxy.stop(appName);
    const r = await awsproxy.login(appName, identity, opts);
    const resolvedRole = identity || (LOGGED_IN_ROLE_RE.exec(r.output || '') || [])[1] || null;
    return { ...r, role: resolvedRole };
  }
  if (cloud === 'GCP') {
    stop(appName); // same reasoning as the AWS branch above, for a changed service account
    const args = [];
    if (opts.proxy) args.push('--proxy=' + opts.proxy);
    args.push('apps', 'login', appName);
    if (identity) args.push('--gcp-service-account=' + identity);
    const r = await teleport.run(args, { timeout: 120000, home: opts.home });
    const text = stripAnsi(`${r.stdout}\n${r.stderr}`).trim();
    if (!r.ok) throw new Error(bestErrorLine(text) || 'tsh apps login failed');
    const resolvedAccount = identity || (LOGGED_IN_GCP_ACCOUNT_RE.exec(text) || [])[1] || null;
    return { ok: true, output: text, role: resolvedAccount };
  }
  return login(appName, opts);
}

async function logout(appName, { proxy, home } = {}) {
  stop(appName);
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('apps', 'logout', appName);
  const r = await teleport.run(args, { timeout: 30000, home });
  return { ok: r.ok, output: stripAnsi(`${r.stdout}\n${r.stderr}`).trim() };
}

/**
 * The generalized version of `awsproxy.js`'s `ensure()`: start (or reuse) a
 * local CLI proxy for one cloud app. AWS is left to `awsproxy.ensure()`
 * itself — this only handles Azure and GCP.
 */
/**
 * `awsproxy.ensure()`'s own return shape (`accessKeyId`/`secretAccessKey`/
 * `caBundle`/`httpsProxy`) is camelCase JS, built for `tunnelAgent()`'s own
 * in-process request signing — not real environment variable names. Spread
 * directly into a spawned shell's env (as this module did until caught
 * live), none of it means anything to the `aws` CLI, which then silently
 * fell back to whatever ambient AWS credentials were already on the
 * machine — the exact ambient-vs-explicit confusion
 * KUBELIFE_ROADMAP.md already flagged for `awscreds.js`, reached here by a
 * different path. Mapped to the real `AWS_*` names before this hands
 * anything to a shell.
 */
function awsEnvVars(env) {
  return {
    AWS_ACCESS_KEY_ID: env.accessKeyId,
    AWS_SECRET_ACCESS_KEY: env.secretAccessKey,
    HTTPS_PROXY: env.httpsProxy,
    ...(env.caBundle ? { AWS_CA_BUNDLE: env.caBundle } : {}),
  };
}

/**
 * A quick preflight for GCP only — caught live: the proxy itself starts
 * fine and prints real-looking credentials even when the App Service's own
 * identity can't actually mint a token, so every command in the shell that
 * opens next would fail the same way with no warning first. `gcloud auth
 * print-access-token` exercises exactly that path without doing anything
 * else. If `gcloud` isn't installed locally there is nothing to preflight
 * with — proceed and let the shell show whatever happens, same as before
 * this existed.
 */
function verifyCloudCli(cloud, env) {
  if (cloud !== 'GCP') return Promise.resolve({ ok: true });
  if (!env.CLOUDSDK_CORE_PROJECT) return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      // `auth print-access-token` alone does not actually call Google —
      // caught live returning a token string even while the real failure
      // (the App Service's own identity can't mint one) was happening.
      // `projects describe` forces the real round trip through the proxy.
      child = spawn('gcloud', ['projects', 'describe', env.CLOUDSDK_CORE_PROJECT], { env: { ...process.env, ...env } });
    } catch {
      resolve({ ok: true });
      return;
    }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => resolve({ ok: true }));
    // gcloud retries a 500 with backoff for well over 15s before giving up
    // — caught live timing out past that and letting a real failure
    // through as "ok" by default. 45s covers its own retry budget.
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } resolve({ ok: true }); }, 45000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: bestErrorLine(out) || 'gcloud could not get an access token for this app.' });
    });
  });
}

function ensureCloudCli(appName, cloud, { proxy } = {}) {
  if (cloud === 'AWS') return awsproxy.ensure(appName, { proxy }).then(awsEnvVars);
  if (cloud !== 'Azure' && cloud !== 'GCP') {
    return Promise.reject(new Error(`"${cloud}" is not a cloud CLI app.`));
  }

  const existing = running.get(appName);
  if (existing && !existing.child.killed) return Promise.resolve(existing.env);

  const sub = cloud === 'Azure' ? 'azure' : 'gcloud';
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  // Confirmed against `tsh proxy azure --help`/`tsh proxy gcloud --help` on a
  // live cluster: both take --app and --format=unix (same shape as AWS's own
  // proxy command below), but neither has a --tunnel flag — an earlier,
  // unverified guess that failed with "unknown long flag '--tunnel'".
  args.push('proxy', sub, '--app=' + appName, '--format=unix');

  return new Promise((resolve, reject) => {
    const child = spawn(teleport.findTsh(), args, {
      env: teleport.tshEnv(teleport.homeForProxy(proxy), proxy),
    });

    let out = '';
    let settled = false;
    const done = (err, env) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { try { child.kill(); } catch { /* already gone */ } reject(err); }
      else resolve(env);
    };

    const timer = setTimeout(() => {
      done(new Error(`Timed out waiting for "tsh proxy ${sub} --app ${appName}".`));
    }, 30000);

    const scan = (chunk) => {
      out += chunk;
      const found = {};
      EXPORT_RE.lastIndex = 0;
      let m;
      while ((m = EXPORT_RE.exec(out))) found[m[1]] = m[2];
      // HTTPS_PROXY is the one variable every `tsh proxy <cloud>` tunnel
      // sets regardless of which cloud it fronts — the rest of `found` is
      // passed through as-is for the caller to feed into a spawned shell.
      if (found.HTTPS_PROXY) {
        const env = {
          ...found,
          // Caught live: `gcloud`'s very first run on a machine prompts
          // interactively (usage-reporting opt-in, Python checks) — fine in
          // a real pty, but there is no reason a credentialed CLI shell
          // should ever need to answer that prompt at all. `az` has no
          // equivalent env var; this is harmless to always set regardless.
          ...(cloud === 'GCP' ? { CLOUDSDK_CORE_DISABLE_PROMPTS: '1' } : {}),
          app: appName, cloud,
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
      if (/not logged|please login|app.*not found/i.test(text)) {
        done(new Error(`Not logged in to the ${cloud} app "${appName}". Run: tsh apps login ${appName}`));
      } else {
        done(new Error(bestErrorLine(text) || `tsh proxy ${sub} exited with code ${code}`));
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Discovering K8s clusters and databases in an already-logged-in     */
/* cloud account — what the account holds beyond what Teleport has    */
/* already registered. `tsh kube ls` (KubeLife) already covers        */
/* anything Teleport fronts; this is for what it doesn't.             */
/* ------------------------------------------------------------------ */

function runCli(cmd, args, env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env: { ...process.env, ...env } });
    } catch (e) {
      resolve({ ok: false, out: '', err: e.message });
      return;
    }
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, out, err: e.message }));
    child.on('exit', (code) => resolve({ ok: code === 0, out, err }));
  });
}

/** EKS clusters and RDS instances — region-scoped, same as the AWS CLI itself requires. */
async function discoverAws(env, region) {
  if (!region) throw new Error('Pick an AWS region first.');
  const withRegion = { ...env, AWS_REGION: region, AWS_DEFAULT_REGION: region };
  const [clustersR, dbsR] = await Promise.all([
    runCli('aws', ['eks', 'list-clusters', '--output', 'json'], withRegion),
    runCli('aws', ['rds', 'describe-db-instances', '--output', 'json'], withRegion),
  ]);
  const clusters = [];
  if (clustersR.ok) {
    try { for (const name of JSON.parse(clustersR.out).clusters || []) clusters.push({ name, region }); } catch { /* unreadable */ }
  }
  const databases = [];
  if (dbsR.ok) {
    try {
      for (const d of JSON.parse(dbsR.out).DBInstances || []) {
        databases.push({
          name: d.DBInstanceIdentifier, engine: d.Engine, status: d.DBInstanceStatus,
          endpoint: d.Endpoint ? `${d.Endpoint.Address}:${d.Endpoint.Port}` : null,
        });
      }
    } catch { /* unreadable */ }
  }
  return {
    clusters, databases,
    clusterError: clustersR.ok ? null : (bestErrorLine(stripAnsi(clustersR.err || clustersR.out)) || 'aws eks list-clusters failed'),
    dbError: dbsR.ok ? null : (bestErrorLine(stripAnsi(dbsR.err || dbsR.out)) || 'aws rds describe-db-instances failed'),
  };
}

/** GKE clusters and Cloud SQL instances — project-wide, no region to ask for (set by the proxy's own CLOUDSDK_CORE_PROJECT). */
async function discoverGcp(env) {
  const [clustersR, dbsR] = await Promise.all([
    runCli('gcloud', ['container', 'clusters', 'list', '--format=json'], env),
    runCli('gcloud', ['sql', 'instances', 'list', '--format=json'], env),
  ]);
  const clusters = [];
  if (clustersR.ok) {
    try {
      for (const c of JSON.parse(clustersR.out) || []) {
        clusters.push({ name: c.name, location: c.location || c.zone, locationType: c.location && !c.zone ? 'region' : 'zone' });
      }
    } catch { /* unreadable */ }
  }
  const databases = [];
  if (dbsR.ok) {
    try {
      for (const d of JSON.parse(dbsR.out) || []) {
        databases.push({ name: d.name, engine: d.databaseVersion, status: d.state, endpoint: d.ipAddresses?.[0]?.ipAddress || null });
      }
    } catch { /* unreadable */ }
  }
  return {
    clusters, databases,
    clusterError: clustersR.ok ? null : (bestErrorLine(stripAnsi(clustersR.err || clustersR.out)) || 'gcloud container clusters list failed'),
    dbError: dbsR.ok ? null : (bestErrorLine(stripAnsi(dbsR.err || dbsR.out)) || 'gcloud sql instances list failed'),
  };
}

/**
 * AKS clusters only — databases are not wired. Enumerating every Azure
 * database type needs a resource-group-scoped query per engine, and the
 * Managed Identity limitation already documented above
 * (AZURE_IDENTITY_FAIL_RE) means most Azure apps here can't even reach
 * this far to begin with.
 */
async function discoverAzure(env) {
  const clustersR = await runCli('az', ['aks', 'list', '-o', 'json'], env);
  const clusters = [];
  if (clustersR.ok) {
    try {
      for (const c of JSON.parse(clustersR.out) || []) clusters.push({ name: c.name, resourceGroup: c.resourceGroup });
    } catch { /* unreadable */ }
  }
  return {
    clusters, databases: [],
    clusterError: clustersR.ok ? null : (bestErrorLine(stripAnsi(clustersR.err || clustersR.out)) || 'az aks list failed'),
    dbError: null,
  };
}

async function discoverCloud(cloud, env, { region } = {}) {
  if (cloud === 'AWS') return discoverAws(env, region);
  if (cloud === 'GCP') return discoverGcp(env);
  if (cloud === 'Azure') return discoverAzure(env);
  throw new Error(`"${cloud}" has no discovery support.`);
}

/**
 * Writes a kubeconfig for one discovered cluster so KubeLife can pick it up
 * the same way it already picks up any other extra kubeconfig path (see
 * settings.kubeconfigPaths) — each cloud's own "get-credentials" command,
 * pointed at a file of its own rather than the shared ~/.kube/config.
 */
async function writeClusterKubeconfig(cloud, env, cluster, kubeconfigPath) {
  const withKubeconfig = { ...env, KUBECONFIG: kubeconfigPath };
  let r;
  if (cloud === 'AWS') {
    r = await runCli('aws', ['eks', 'update-kubeconfig', '--name', cluster.name, '--region', cluster.region, '--kubeconfig', kubeconfigPath], withKubeconfig);
  } else if (cloud === 'GCP') {
    const locFlag = cluster.locationType === 'region' ? '--region' : '--zone';
    r = await runCli('gcloud', ['container', 'clusters', 'get-credentials', cluster.name, locFlag, cluster.location], withKubeconfig);
  } else if (cloud === 'Azure') {
    r = await runCli('az', ['aks', 'get-credentials', '--name', cluster.name, '--resource-group', cluster.resourceGroup, '--file', kubeconfigPath, '--overwrite-existing'], withKubeconfig);
  } else {
    throw new Error(`"${cloud}" has no discovery support.`);
  }
  if (!r.ok) throw new Error(bestErrorLine(stripAnsi(r.err || r.out)) || `Could not write a kubeconfig for ${cluster.name}.`);
  return { ok: true };
}

function stop(appName) {
  const r = running.get(appName);
  if (!r) return false;
  try { r.child.kill(); } catch { /* already gone */ }
  running.delete(appName);
  return true;
}

function stopAll() {
  for (const name of [...running.keys()]) stop(name);
}

function status() {
  return [...running.entries()].map(([app, r]) => ({
    app, startedAt: r.startedAt, cloud: r.env.cloud, proxy: r.env.HTTPS_PROXY,
  }));
}

/**
 * Every cloud CLI proxy currently running, AWS included — AWS keeps its own
 * `running` map in `awsproxy.js` (untouched, see the top of this file), so
 * this is the one place that reads both and gives a caller a single list
 * rather than two calls to make and merge itself. The shape for a "Cloud
 * sessions" panel: which app, which cloud, and how long it has been up.
 */
function allCloudSessions() {
  const aws = awsproxy.status().map((s) => ({ ...s, cloud: 'AWS' }));
  return [...aws, ...status()];
}

/** Stop a session from the "Cloud sessions" panel, whichever module is actually running it. */
function stopCloudSession(appName, cloud) {
  return (cloud === 'AWS' ? awsproxy.stop(appName) : stop(appName));
}

/**
 * Whether a TCP app is reachable by name right now — i.e. whether VNet is
 * `running` for the cluster it lives in. Takes the live status list from
 * `VnetManager.status()` (see vnet.js) rather than importing it directly, to
 * avoid a circular dependency between this module and main.js's wiring.
 */
function tcpReachability(appProxy, vnetStatusList) {
  const { profileName } = require('./vnet');
  const cluster = profileName(appProxy);
  const rec = (vnetStatusList || []).find((v) => v.cluster === cluster);
  if (!rec) return { reachable: false, reason: 'VNet is off for this cluster.' };
  if (rec.state === 'running') return { reachable: true, reason: null };
  if (rec.state === 'starting') return { reachable: false, reason: 'VNet is starting…' };
  if (rec.state === 'stopping') return { reachable: false, reason: 'VNet is stopping…' };
  if (rec.state === 'error') return { reachable: false, reason: `VNet error: ${rec.error || 'tsh vnet exited'}` };
  return { reachable: false, reason: 'VNet is off for this cluster.' };
}

/**
 * Whether `tsh apps login <name>` has actually been run for each app, read
 * straight off the certificate `tsh` itself writes on login — no extra tsh
 * call, so a pane full of apps can ask this for all of them at once without
 * a round trip per row. `username`/`cluster` come from the renderer's own
 * `state.teleportProfiles` (already read off `tsh status`), so this module
 * never has to re-resolve them.
 */
function loginStatuses({ proxy, home, username, cluster, names = [] } = {}) {
  const out = {};
  if (!username || !cluster) return out;
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const bareHost = String(proxy || '').replace(/^\w+:\/\//, '').replace(/:\d+$/, '');
  const base = home || teleport.homeForProxy(proxy) || path.join(os.homedir(), '.tsh');
  const dir = path.join(base, 'keys', bareHost, `${username}-app`, cluster);
  for (const name of names) {
    try {
      const pem = fs.readFileSync(path.join(dir, `${name}.crt`), 'utf8');
      let validUntil = null;
      try {
        const { X509Certificate } = require('crypto');
        validUntil = new X509Certificate(pem).validTo;
      } catch { /* best-effort — a cert this module can't parse still means "found" */ }
      const expired = validUntil ? new Date(validUntil).getTime() < Date.now() : false;
      out[name] = { loggedIn: !expired, validUntil };
    } catch {
      out[name] = { loggedIn: false, validUntil: null };
    }
  }
  return out;
}

module.exports = {
  listApps, listCloudApps, login, logout,
  listAwsRoles, listGcpServiceAccounts, loginCloud,
  ensureCloudCli, verifyCloudCli, stop, stopAll, status, allCloudSessions, stopCloudSession,
  tcpReachability, loginStatuses, discoverCloud, writeClusterKubeconfig,
};
