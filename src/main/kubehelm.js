'use strict';
/**
 * Helm release management, surfaced directly in the full cluster browser —
 * the only thing Helm itself was ever used for here before now was installing teleport-kube-agent
 * (see kube.js's installTeleportAgent()). Same `run()`/explainMissing idiom
 * kuberesources.js already uses for kubectl, pointed at `helm` instead, with
 * context translated through kube.js's helmArgsFor() (Helm's own
 * `--kube-context`, not kubectl's `--context=`).
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const kube = require('./kube');
const kubebin = require('./kubebin');

function run(args, { env, timeout = 20000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  if (!kubebin.toolAvailable('helm')) {
    return Promise.resolve({ ok: false, stdout: '', stderr: 'helm was not found on this machine. Install it first (e.g. "brew install helm"), then try again.' });
  }
  const helm = kubebin.findTool('helm');
  return new Promise((resolve) => {
    execFile(helm, args, { timeout, maxBuffer, env },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err }));
  });
}

/** Same as run(), with text fed over stdin — `helm install -f -` reads values from there, not a flag. */
function runWithStdin(args, input, { env, timeout = 60000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  if (!kubebin.toolAvailable('helm')) {
    return Promise.resolve({ ok: false, stdout: '', stderr: 'helm was not found on this machine. Install it first (e.g. "brew install helm"), then try again.' });
  }
  const helm = kubebin.findTool('helm');
  return new Promise((resolve) => {
    const child = execFile(helm, args, { timeout, maxBuffer, env },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err }));
    child.stdin.on('error', () => {});
    child.stdin.write(input == null ? '' : input);
    child.stdin.end();
  });
}

function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

function nsArgs(namespace) {
  return namespace ? ['-n', namespace] : ['-A'];
}

/** `helm list [-n ns | -A] -o json` — every release this context can see. */
async function listReleases(spec = {}, { namespace } = {}) {
  const { env, contextArgs } = kube.helmArgsFor(spec);
  const r = await run([...contextArgs, 'list', ...nsArgs(namespace), '-o', 'json'], { env });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'helm list failed', releases: [] };
  let data;
  try { data = JSON.parse(r.stdout || '[]'); } catch { return { ok: false, error: 'Unexpected output from helm', releases: [] }; }
  const releases = data.map((x) => ({
    name: x.name, namespace: x.namespace, chart: x.chart, appVersion: x.app_version,
    revision: Number(x.revision) || 0, status: x.status, updated: x.updated,
  }));
  return { ok: true, releases };
}

/** `helm history <release> -n ns -o json` — every revision, for a rollback target. */
async function history(spec = {}, { release, namespace } = {}) {
  const { env, contextArgs } = kube.helmArgsFor(spec);
  const r = await run([...contextArgs, 'history', release, '-n', namespace, '-o', 'json'], { env });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'helm history failed', revisions: [] };
  let data;
  try { data = JSON.parse(r.stdout || '[]'); } catch { return { ok: false, error: 'Unexpected output from helm', revisions: [] }; }
  return { ok: true, revisions: data.map((x) => ({ revision: x.revision, updated: x.updated, status: x.status, chart: x.chart, description: x.description })) };
}

/** `helm get values <release> -n ns -o yaml [--all] [--revision N]` — user-supplied values (every computed value with `all`), pinned to an earlier revision for a diff against the current one. */
async function getValues(spec = {}, { release, namespace, all = false, revision } = {}) {
  const { env, contextArgs } = kube.helmArgsFor(spec);
  const args = [...contextArgs, 'get', 'values', release, '-n', namespace, '-o', 'yaml'];
  if (all) args.push('--all');
  if (revision) args.push('--revision', String(revision));
  const r = await run(args, { env });
  return r.ok ? { ok: true, yaml: r.stdout } : { ok: false, error: plain(r.stderr) || 'helm get values failed' };
}

/** `helm get manifest <release> -n ns` — every object the release actually rendered and applied. */
async function getManifest(spec = {}, { release, namespace } = {}) {
  const { env, contextArgs } = kube.helmArgsFor(spec);
  const r = await run([...contextArgs, 'get', 'manifest', release, '-n', namespace], { env });
  return r.ok ? { ok: true, yaml: r.stdout } : { ok: false, error: plain(r.stderr) || 'helm get manifest failed' };
}

/** `helm rollback <release> <revision> -n ns` — back to an earlier revision from history(). */
async function rollback(spec = {}, { release, namespace, revision } = {}) {
  const { env, contextArgs } = kube.helmArgsFor(spec);
  const r = await run([...contextArgs, 'rollback', release, String(revision), '-n', namespace], { env, timeout: 60000 });
  return r.ok ? { ok: true, output: plain(r.stdout) } : { ok: false, error: plain(r.stderr) || 'helm rollback failed' };
}

/** `helm uninstall <release> -n ns` — removes the release and everything it owns. */
async function uninstall(spec = {}, { release, namespace } = {}) {
  const { env, contextArgs } = kube.helmArgsFor(spec);
  const r = await run([...contextArgs, 'uninstall', release, '-n', namespace], { env, timeout: 60000 });
  return r.ok ? { ok: true, output: plain(r.stdout) } : { ok: false, error: plain(r.stderr) || 'helm uninstall failed' };
}

/**
 * `helm repo add <name> <url>` + `repo update` — only needed for a repo-chart
 * install, not a local chart path (`install()` below takes either form as
 * `chartRef` with no branching of its own). Idempotent the same way
 * `kube.js`'s `installTeleportAgent` already treats "already exists" as
 * success, not a failure to report.
 */
async function addRepo(spec = {}, { name, url } = {}) {
  const { env, contextArgs } = kube.helmArgsFor(spec);
  const add = await run([...contextArgs, 'repo', 'add', name, url], { env, timeout: 20000 });
  if (!add.ok && !/already exists/i.test(add.stderr)) return { ok: false, error: plain(add.stderr) || 'helm repo add failed' };
  const update = await run([...contextArgs, 'repo', 'update', name], { env, timeout: 30000 });
  return update.ok ? { ok: true } : { ok: false, error: plain(update.stderr) || 'helm repo update failed' };
}

/**
 * `helm install <release> <chartRef> -n ns [--create-namespace] [-f -] [--dry-run]`
 * — `chartRef` is either `<repoName>/<chartName>` (after addRepo() above) or
 * a bare filesystem path to a chart directory/.tgz; helm resolves both the
 * same way, so this never branches on which one it got.
 */
async function install(spec = {}, { release, namespace, chartRef, valuesYaml, createNamespace = false, dryRun = false, preview = false, repo = null } = {}) {
  const { env, contextArgs } = kube.helmArgsFor(spec);
  const args = [...contextArgs, 'install', release, chartRef, '-n', namespace];
  if (createNamespace) args.push('--create-namespace');
  if (dryRun) args.push('--dry-run');
  const hasValues = valuesYaml && valuesYaml.trim();
  if (hasValues) args.push('-f', '-');
  // The exact command, values and all, to read before it runs — or to copy
  // and run by hand.
  // `repo` ({name, url}) only shapes the preview: the wizard adds the repo
  // itself first (addRepo), and the copied command should do the same.
  if (preview) {
    const steps = repo?.name && repo?.url
      ? [{ args: [...contextArgs, 'repo', 'add', repo.name, repo.url] }, { args: [...contextArgs, 'repo', 'update', repo.name] }]
      : [];
    return { ok: true, command: kube.commandPreview([...steps, { args, stdin: hasValues ? valuesYaml : null }], env) };
  }
  const r = hasValues ? await runWithStdin(args, valuesYaml, { env, timeout: 90000 }) : await run(args, { env, timeout: 90000 });
  return r.ok ? { ok: true, output: plain(r.stdout) } : { ok: false, error: plain(r.stderr) || 'helm install failed' };
}

/**
 * A release's `chart` from `helm list` is `<name>-<version>` — the repo it
 * came from is not recorded anywhere. Split back into the two, so an
 * upgrade can look the name up in the local repos.
 */
function splitChart(chart) {
  const m = /^(.*)-(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)$/.exec(String(chart || ''));
  return m ? { name: m[1], version: m[2] } : { name: String(chart || ''), version: '' };
}

/**
 * Where a chart can be upgraded from: `helm search repo` across the repos
 * this machine has added, matched on the chart's own name (the part after
 * `repo/`). `versions` lists every version of one exact `repo/chart`.
 * Local only — `helm repo update` first if the list is stale (`refresh`).
 */
async function searchCharts(spec = {}, { name, versionsOf, refresh = false } = {}) {
  const { env } = kube.helmArgsFor(spec);
  if (refresh) await run(['repo', 'update'], { env, timeout: 60000 });
  const args = versionsOf ? ['search', 'repo', versionsOf, '--versions', '-o', 'json'] : ['search', 'repo', name || '', '-o', 'json'];
  const r = await run(args, { env, timeout: 30000 });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'helm search repo failed', charts: [] };
  let data;
  try { data = JSON.parse(r.stdout || '[]'); } catch { return { ok: false, error: 'Unexpected output from helm', charts: [] }; }
  let charts = data.map((c) => ({ ref: c.name, version: c.version, appVersion: c.app_version, description: c.description }));
  if (versionsOf) charts = charts.filter((c) => c.ref === versionsOf);
  else if (name) charts = charts.filter((c) => c.ref.split('/').pop() === name);
  return { ok: true, charts };
}

/**
 * `helm upgrade <release> <chart> -n ns -f -` — values as YAML on stdin, the
 * same way install takes them. `version` pins the chart version (empty:
 * the newest the repo has). `preview` returns the commands instead of
 * running them, for the wizard to show and copy.
 */
async function upgrade(spec = {}, { release, namespace, chartRef, version, valuesYaml, dryRun = false, preview = false, resetValues = true } = {}) {
  const { env, contextArgs } = kube.helmArgsFor(spec);
  const args = [...contextArgs, 'upgrade', release, chartRef, '-n', namespace];
  if (version) args.push('--version', version);
  // The values given are the whole answer — what was there before is in
  // them already (the wizard starts from `helm get values`), so a key taken
  // out is meant to be gone, not quietly kept by --reuse-values.
  if (resetValues) args.push('--reset-values');
  if (dryRun) args.push('--dry-run');
  const hasValues = valuesYaml && valuesYaml.trim() && valuesYaml.trim() !== 'null';
  if (hasValues) args.push('-f', '-');
  if (preview) return { ok: true, command: kube.commandPreview([{ args, stdin: hasValues ? valuesYaml : null }], env) };
  const r = hasValues ? await runWithStdin(args, valuesYaml, { env, timeout: 120000 }) : await run(args, { env, timeout: 120000 });
  return r.ok ? { ok: true, output: plain(r.stdout) } : { ok: false, error: plain(r.stderr) || 'helm upgrade failed' };
}

/** `helm show readme <chartRef>` — a repo ref or a local path, same as every other `chartRef` here. */
async function showReadme(spec = {}, { chartRef } = {}) {
  const { env } = kube.helmArgsFor(spec);
  const r = await run(['show', 'readme', chartRef], { env, timeout: 30000 });
  return r.ok ? { ok: true, text: r.stdout } : { ok: false, error: plain(r.stderr) || 'helm show readme failed' };
}

/**
 * A chart's own `values.schema.json`, for the install/upgrade wizard's
 * values form — most charts don't have one (confirmed against a few
 * real public ones while planning this), which is `{ ok: true, schema:
 * null }`, not an error. `helm show` has no subcommand for this file
 * specifically, so a repo ref needs a real `helm pull --untar` into a
 * scratch directory, always removed afterward whether or not a schema
 * was found; a local chart path already has the file sitting right
 * there, no pull needed.
 */
async function getValuesSchema(spec = {}, { chartRef, local = false } = {}) {
  if (local) {
    try { return { ok: true, schema: JSON.parse(fs.readFileSync(path.join(chartRef, 'values.schema.json'), 'utf8')) }; }
    catch { return { ok: true, schema: null }; }
  }
  const { env } = kube.helmArgsFor(spec);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serverlife-helm-schema-'));
  try {
    const r = await run(['pull', chartRef, '--untar', '-d', tmp], { env, timeout: 30000 });
    if (!r.ok) return { ok: false, error: plain(r.stderr) || 'helm pull failed' };
    const chartDir = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((p) => fs.statSync(p).isDirectory());
    if (!chartDir) return { ok: true, schema: null };
    try { return { ok: true, schema: JSON.parse(fs.readFileSync(path.join(chartDir, 'values.schema.json'), 'utf8')) }; }
    catch { return { ok: true, schema: null }; }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The schema's own nested `properties` (standard JSON Schema — a
 * chart's own non-standard form-hint extensions like `form`/`hidden`/
 * `render` are simply ignored, not part of it) flattened into one entry
 * per scalar leaf field. `array` fields are listed but not descended
 * into — a good form for "a list of objects" is a different, harder
 * problem than this one asks for.
 */
function fieldsFromSchema(schema, maxDepth = 4) {
  const fields = [];
  const walk = (props, prefix, depth) => {
    for (const [key, def] of Object.entries(props || {})) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (def.type === 'object' && depth < maxDepth) { walk(def.properties, p, depth + 1); continue; }
      fields.push({ path: p, type: def.type || 'string', title: def.title || '', description: def.description || '', default: def.default, enum: def.enum || null });
    }
  };
  walk(schema?.properties, '', 1);
  return fields;
}

/** `helm test <release> -n ns [--logs]` — runs the chart's own tests against an already-deployed release. */
async function test(spec = {}, { release, namespace, logs = true } = {}) {
  const { env, contextArgs } = kube.helmArgsFor(spec);
  const args = [...contextArgs, 'test', release, '-n', namespace];
  if (logs) args.push('--logs');
  const r = await run(args, { env, timeout: 120000 });
  return { ok: r.ok, output: plain(r.ok ? r.stdout : r.stderr) || (r.ok ? '' : 'helm test failed') };
}

/**
 * `helm template <name> <chartRef> [-f -]` — renders locally, same as
 * `kubekustomize.build()`: nothing here touches the cluster, confirmed
 * against the real `helm template --help` while planning this.
 */
async function renderTemplate(spec = {}, { name, chartRef, valuesYaml } = {}) {
  const { env, contextArgs } = kube.helmArgsFor(spec);
  const args = [...contextArgs, 'template', name, chartRef];
  const hasValues = valuesYaml && valuesYaml.trim();
  if (hasValues) args.push('-f', '-');
  const r = hasValues ? await runWithStdin(args, valuesYaml, { env, timeout: 30000 }) : await run(args, { env, timeout: 30000 });
  return r.ok ? { ok: true, yaml: r.stdout } : { ok: false, error: plain(r.stderr) || 'helm template failed' };
}

module.exports = {
  listReleases, history, getValues, getManifest, rollback, uninstall, addRepo, install, upgrade, searchCharts, splitChart,
  showReadme, getValuesSchema, fieldsFromSchema, test, renderTemplate,
};
