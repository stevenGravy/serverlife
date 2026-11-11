'use strict';
/**
 * KubeLife: Kubernetes clusters, reached directly with `kubectl` or through
 * Teleport's own kube proxy.
 *
 * The capability probe here is the same shape as beams.js's: `tsh kube ls`
 * either answers or it says the cluster does not run kube access at all, and
 * that answer is worth caching per proxy because it does not change between
 * two clicks.
 *
 * The thing that makes "use tsh, or use plain kubectl, whichever you meant"
 * possible with one code path everywhere else: `tsh kube login <cluster>`
 * writes a per-cluster kubeconfig into the tsh home, and pointing a spawned
 * process's KUBECONFIG at that file means an ordinary `kubectl` invocation
 * just works, through Teleport's proxy, with no `tsh kubectl` wrapper to
 * special-case. kubectlArgsFor() is the one place that distinguishes a direct
 * kubeconfig from a Teleport one — the terminal, exec, and file-browser code
 * everywhere else only ever calls it, never branches on `source` itself.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const teleport = require('./teleport');
const kubebin = require('./kubebin');

/** Global tsh flags that have to precede the subcommand. */
function base({ proxy, jumphost } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  if (jumphost) args.push('--jumphost=' + jumphost);
  return args;
}

/** `tsh … kube <sub> …`, with the flags tsh insists come first. */
function argsFor(sub, rest = [], opts = {}) {
  return [...base(opts), 'kube', sub, ...rest];
}

function run(args, opts = {}) {
  return teleport.run(args, { timeout: opts.timeout || 60000, home: opts.home });
}

/** tsh colours its errors, and the UI shows them as text. */
function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

/**
 * Does this cluster have Kubernetes access at all?
 *
 * The cheapest real call rather than a version check, same reasoning as
 * beams.js's supported(): the service either answers or it does not.
 */
async function supported({ proxy, home } = {}) {
  const r = await run(argsFor('ls', ['--format=json'], { proxy }), { home, timeout: 45000 });
  const out = plain(r.stdout);
  if (r.ok && (out.startsWith('[') || out === 'null' || out.startsWith('{'))) return { ok: true };
  const error = plain(r.stderr) || out || 'tsh kube ls said nothing';
  return {
    ok: false,
    error,
    // The signature of a cluster that simply has no kube_service registered,
    // as opposed to one that refused for a reason worth showing.
    unsupported: /no kubernetes clusters|not implement this feature|unknown command/i.test(error),
  };
}

/**
 * One Teleport-registered kube cluster, as this app talks about it. Named,
 * not uuid'd — like an app or a database, and unlike an ssh node.
 */
function toKubeCluster(c, { proxy, home } = {}) {
  const kp = require('./kubeprovider');
  const name = c?.kube_cluster_name || c?.cluster_name || '';
  return {
    // Which cloud, from what Teleport says about it (kubeprovider.js).
    provider: kp.combine(kp.fromLabels(c?.labels || {}), kp.fromName(name)),
    id: `kube:tsh:${proxy || ''}${home ? ':' + home : ''}:${c?.cluster_name || c?.kube_cluster_name || ''}`,
    kind: 'kube',
    source: 'teleport',
    name: c?.kube_cluster_name || c?.cluster_name || '',
    cluster: c?.cluster_name || '',
    proxy: proxy || '',
    home: home || null,
    labels: c?.labels || {},
    requestable: true,
  };
}

async function listKubeClusters({ proxy, home } = {}) {
  const r = await run(argsFor('ls', ['--format=json'], { proxy }), { home, timeout: 45000 });
  const out = plain(r.stdout);
  if (out === 'null' || out === '[]') return { ok: true, clusters: [] };
  const at = out.indexOf('[');
  if (at >= 0) {
    try {
      const data = JSON.parse(out.slice(at));
      if (Array.isArray(data)) return { ok: true, clusters: data.map((c) => toKubeCluster(c, { proxy, home })) };
    } catch { /* output that is not JSON falls through to the error */ }
  }
  return { ok: false, error: plain(r.stderr) || out || 'Could not read the Kubernetes cluster list', clusters: [] };
}

/**
 * `$KUBECONFIG` (already a PATH-style list, same as kubectl itself reads it)
 * if set, else the default `~/.kube/config` — the files a plain `kubectl`
 * on this machine would already be using, with nothing added by hand.
 */
function defaultKubeconfigPaths() {
  const env = process.env.KUBECONFIG;
  if (env && env.trim()) return env.split(path.delimiter).map((p) => p.trim()).filter(Boolean);
  return [path.join(os.homedir(), '.kube', 'config')];
}

/**
 * A context's own `tsh kube login` already wrote a kubeconfig user entry
 * whose exec plugin is `tsh kube credentials --kube-cluster=… --proxy=…
 * --teleport-cluster=…` — those three flags are the ground truth for which
 * Teleport cluster and which kube_cluster this context actually is, read
 * back out rather than guessed from the context's name (names are free text
 * and not guaranteed to follow any pattern).
 */
function teleportOriginOf(user) {
  const args = user?.exec?.args;
  const cmd = user?.exec?.command;
  if (!Array.isArray(args) || !cmd || !/tsh(\.exe)?$/i.test(cmd)) return null;
  if (args[0] !== 'kube' || args[1] !== 'credentials') return null;
  const flag = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : '';
  };
  const kubeCluster = flag('kube-cluster');
  const cluster = flag('teleport-cluster');
  const proxy = flag('proxy');
  if (!kubeCluster || !cluster) return null;
  return { kubeCluster, cluster, proxy: proxy || cluster };
}

/**
 * What "kubectl" means on this machine. A real kubectl when there is one;
 * otherwise `tsh kubectl`, the full kubectl tsh carries inside it — so a
 * machine with only tsh installed can still reach its Teleport clusters,
 * whose kubeconfig entries already exec tsh for credentials anyway.
 * `missing` only when neither is there.
 */
function kubectlCommand() {
  if (kubebin.kubectlAvailable()) return { bin: kubebin.findKubectl(), prefix: [], missing: false };
  const tsh = teleport.tshStatus();
  if (tsh.found) return { bin: tsh.path, prefix: ['kubectl'], missing: false, viaTsh: true };
  return { bin: kubebin.findKubectl(), prefix: [], missing: true };
}

function execBin(bin, args, { env, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, env: env || process.env },
      (err, stdout, stderr) => resolve(kubebin.explainMissing({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err })));
  });
}

function execKubectl(args, opts = {}) {
  const { bin, prefix } = kubectlCommand();
  return execBin(bin, [...prefix, ...args], opts);
}

/**
 * Every context in the default kubeconfig location plus any extra files
 * added in Settings (settings.kubeconfigPaths) — one `kubectl config view`,
 * letting kubectl itself do the merging exactly as it would for any other
 * command. Missing files are dropped rather than failing the whole read: a
 * stale path left in Settings should not take the default config down with
 * it.
 */
async function listContexts({ extraPaths = [] } = {}) {
  const paths = [...defaultKubeconfigPaths(), ...extraPaths]
    .filter((p) => { try { return p && fs.existsSync(p); } catch { return false; } });
  if (!paths.length) return { ok: true, contexts: [], paths: [] };
  // The first kube read of all — said plainly here, the sidebar's error line
  // is the first place someone without kubectl would look.
  if (kubectlCommand().missing) return { ok: false, error: kubebin.kubectlMissingMessage(), contexts: [], paths };
  const env = kubebin.kubectlEnv({ KUBECONFIG: paths.join(path.delimiter) });
  const r = await execKubectl(['config', 'view', '-o', 'json'], { env });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'kubectl config view failed', contexts: [], paths };
  let data;
  try { data = JSON.parse(r.stdout); } catch { return { ok: false, error: 'Could not read the kubeconfig as JSON', contexts: [], paths }; }
  const usersByName = new Map((data.users || []).map((u) => [u.name, u.user]));
  const clustersByName = new Map((data.clusters || []).map((cl) => [cl.name, cl.cluster || {}]));
  const kp = require('./kubeprovider');
  const contexts = (data.contexts || []).map((c) => {
    const user = usersByName.get(c.context?.user);
    const teleport_ = teleportOriginOf(user);
    // Which cloud, from the kubeconfig itself — the endpoint, the names, the credential plugin.
    const provider = kp.combine(
      kp.fromKubeconfig({ contextName: c.name, clusterName: c.context?.cluster || '', server: clustersByName.get(c.context?.cluster)?.server || '', exec: user?.exec || null }),
      kp.fromName(teleport_?.kubeCluster || c.name),
    );
    return {
      provider,
      id: teleport_ ? `kube:tsh:${teleport_.proxy}:${teleport_.cluster}:${teleport_.kubeCluster}` : `kube:direct:${c.name}`,
      kind: 'kube',
      // A context tsh itself created (its user entry execs `tsh kube
      // credentials`) belongs with the Teleport cluster it came from, the
      // same way a beam does — not in a flat list that looks unrelated to
      // the cluster it is actually reached through.
      source: teleport_ ? 'teleport' : 'direct',
      name: c.name,
      contextName: c.name,
      cluster: c.context?.cluster || '',
      namespace: c.context?.namespace || '',
      kubeconfigPaths: paths,
      current: data['current-context'] === c.name,
      requestable: false,
      teleportProxy: teleport_?.proxy || null,
      teleportCluster: teleport_?.cluster || null,
      kubeClusterName: teleport_?.kubeCluster || null,
    };
  });
  return { ok: true, contexts, paths };
}

/**
 * `kubectl config use-context` — makes one context kubectl's own default
 * outside this app, for a user who also runs `kubectl`/`tsh kubectl` in a
 * plain terminal. Nothing inside KubeLife itself depends on this: every
 * call already goes through kubectlArgsFor()'s explicit `--context=`, so
 * this is purely "right-click a cluster → make it the one a bare `kubectl`
 * elsewhere would hit," the same thing `tsh kube login` does as a side
 * effect of logging in — just without the login round-trip, for a context
 * already logged into.
 */
async function useContext({ contextName, kubeconfigPaths = [] } = {}) {
  if (!contextName) return { ok: false, error: 'No context given' };
  const env = kubebin.kubectlEnv({ KUBECONFIG: kubeconfigPaths.length ? kubeconfigPaths.join(path.delimiter) : '' });
  const r = await execKubectl(['config', 'use-context', contextName], { env });
  return r.ok ? { ok: true } : { ok: false, error: plain(r.stderr) || 'kubectl config use-context failed' };
}

/**
 * Takes one context out of the kubeconfig — `kubectl config delete-context`,
 * plus the user and cluster entries it pointed at, but only where no other
 * context still points at them too. kubectl writes each removal back to the
 * file the entry came from, so a merged KUBECONFIG list is fine. A context
 * that was current leaves current-context unset rather than dangling.
 * `dryRun` answers "what would go" for the confirm, touching nothing.
 */
async function deleteContext({ contextName, kubeconfigPaths = [], dryRun = false } = {}) {
  if (!contextName) return { ok: false, error: 'No context given' };
  const env = kubebin.kubectlEnv({ KUBECONFIG: kubeconfigPaths.length ? kubeconfigPaths.join(path.delimiter) : '' });
  const view = await execKubectl(['config', 'view', '-o', 'json'], { env });
  if (!view.ok) return { ok: false, error: plain(view.stderr) || 'kubectl config view failed' };
  let data;
  try { data = JSON.parse(view.stdout); } catch { return { ok: false, error: 'Could not read the kubeconfig as JSON' }; }
  const ctx = (data.contexts || []).find((c) => c.name === contextName);
  if (!ctx) return { ok: false, error: `No context "${contextName}" in the kubeconfig` };
  const others = (data.contexts || []).filter((c) => c.name !== contextName);
  const user = ctx.context?.user && !others.some((c) => c.context?.user === ctx.context.user) ? ctx.context.user : null;
  const cluster = ctx.context?.cluster && !others.some((c) => c.context?.cluster === ctx.context.cluster) ? ctx.context.cluster : null;
  const wasCurrent = data['current-context'] === contextName;
  const plan = { context: contextName, user, cluster, wasCurrent };
  if (dryRun) return { ok: true, ...plan };

  const del = await execKubectl(['config', 'delete-context', contextName], { env });
  if (!del.ok) return { ok: false, error: plain(del.stderr) || 'kubectl config delete-context failed' };
  // The context itself is gone either way; a leftover user or cluster entry
  // is untidy, not broken, so those are reported rather than failing.
  const warnings = [];
  if (user) {
    const r = await execKubectl(['config', 'delete-user', user], { env });
    if (!r.ok) warnings.push(plain(r.stderr) || `Could not remove user ${user}`);
  }
  if (cluster) {
    const r = await execKubectl(['config', 'delete-cluster', cluster], { env });
    if (!r.ok) warnings.push(plain(r.stderr) || `Could not remove cluster ${cluster}`);
  }
  if (wasCurrent) await execKubectl(['config', 'unset', 'current-context'], { env });
  return { ok: true, ...plan, warnings };
}

/**
 * "Edit…" on a context: its default namespace (`set-context --namespace`,
 * empty clears it) and its name (`rename-context`). Namespace first, while
 * the old name still finds it. A tsh-written context renamed here keeps
 * working — its credentials live in its user entry, not its name — though a
 * later `tsh kube login` writes the original name back alongside it.
 */
async function editContext({ contextName, kubeconfigPaths = [], newName, namespace } = {}) {
  if (!contextName) return { ok: false, error: 'No context given' };
  const env = kubebin.kubectlEnv({ KUBECONFIG: kubeconfigPaths.length ? kubeconfigPaths.join(path.delimiter) : '' });
  if (typeof namespace === 'string') {
    const r = await execKubectl(['config', 'set-context', contextName, '--namespace=' + namespace.trim()], { env });
    if (!r.ok) return { ok: false, error: plain(r.stderr) || 'kubectl config set-context failed' };
  }
  const name = (newName || '').trim();
  if (name && name !== contextName) {
    const r = await execKubectl(['config', 'rename-context', contextName, name], { env });
    if (!r.ok) return { ok: false, error: plain(r.stderr) || 'kubectl config rename-context failed' };
  }
  return { ok: true };
}

/**
 * The argv + env for a `kubectl` call against one kube spec — the one place
 * every caller (terminal, exec, file browser) comes through, rather than
 * each reaching into `spec.kubeconfigPaths` its own way.
 *
 * Every context listContexts() returns already has working credentials,
 * Teleport-sourced or not — `tsh kube login` wrote tsh's own exec plugin
 * into the context the same way `aws eks` or `gke-gcloud-auth-plugin` wrote
 * theirs, and kubectl neither knows nor needs to know the difference. So
 * this never branches on `spec.source`: it is just KUBECONFIG + --context,
 * the way any kubectl user would point at a specific cluster.
 */
function kubectlArgsFor(spec = {}) {
  const env = kubebin.kubectlEnv({
    KUBECONFIG: (spec.kubeconfigPaths && spec.kubeconfigPaths.length) ? spec.kubeconfigPaths.join(path.delimiter) : '',
  });
  // `tsh kubectl …` when there is no kubectl of its own (kubectlCommand()):
  // the leading "kubectl" rides in baseArgs, so every caller spreading
  // `[...baseArgs, …]` after `bin` gets it for free.
  const { bin, prefix } = kubectlCommand();
  const args = [...prefix];
  if (spec.contextName) args.push('--context=' + spec.contextName);
  if (spec.namespace) args.push('-n', spec.namespace);
  return { bin, baseArgs: args, env };
}

/**
 * Just the KUBECONFIG env — for an ecosystem-tool launcher (k9s, or a plain
 * shell with kubectl/helm ready) that needs the right environment but isn't
 * a `kubectlArgsFor()` call itself. Joining `kubeconfigPaths` with the
 * platform's own delimiter belongs on this side, not reimplemented in the
 * renderer which has no `path.delimiter` to reach for.
 */
function kubeconfigEnvFor(spec = {}) {
  return kubectlArgsFor(spec).env;
}

/** Namespaces in one context — `kubectl get namespaces -o json`. */
async function listNamespaces(spec = {}) {
  const { bin, baseArgs, env } = kubectlArgsFor({ ...spec, namespace: null });
  const r = await execBin(bin, [...baseArgs, 'get', 'namespaces', '-o', 'json'], { env, timeout: 15000 });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'kubectl get namespaces failed', namespaces: [] };
  let data;
  try { data = JSON.parse(r.stdout); } catch { return { ok: false, error: 'Unexpected output from kubectl', namespaces: [] }; }
  return { ok: true, namespaces: (data.items || []).map((i) => i.metadata?.name).filter(Boolean) };
}

/** Pods in one namespace (or every namespace) of one context — `kubectl get pods -o json`. */
async function listPods(spec = {}) {
  // -A/--all-namespaces is a flag of `get`, not a global one like --context
  // or -n — it has to come after the subcommand, or kubectl's own plugin
  // resolution misreads it as a stray flag with no command yet to attach to.
  const { bin, baseArgs, env } = kubectlArgsFor(spec.namespace ? spec : { ...spec, namespace: null });
  const scope = spec.namespace ? [] : ['-A'];
  const r = await execBin(bin, [...baseArgs, 'get', 'pods', ...scope, '-o', 'json'], { env, timeout: 15000 });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'kubectl get pods failed', pods: [] };
  let data;
  try { data = JSON.parse(r.stdout); } catch { return { ok: false, error: 'Unexpected output from kubectl', pods: [] }; }
  const pods = (data.items || []).map((i) => ({
    name: i.metadata?.name || '',
    namespace: i.metadata?.namespace || spec.namespace || '',
    phase: i.status?.phase || 'Unknown',
    ready: (i.status?.containerStatuses || []).filter((c) => c.ready).length,
    total: (i.status?.containerStatuses || []).length,
    restarts: (i.status?.containerStatuses || []).reduce((n, c) => n + (c.restartCount || 0), 0),
    containers: (i.spec?.containers || []).map((c) => c.name),
    node: i.spec?.nodeName || '',
    // What a Service's or Deployment's selector is matched against — the 3D
    // view draws its relationship arrows from exactly that (kubescan.js).
    labels: i.metadata?.labels || {},
  }));
  return { ok: true, pods };
}

/**
 * The command/args/env for a `kubectl exec -it` into one pod, shaped for
 * KubeLife's localTerm-based exec session (see sidebar.js/kubepanel.js) —
 * not a Connection transport. A plain `kubectl exec` PTY has no
 * ControlMaster, no SFTP subsystem and no multiplexing to share, so it is
 * shaped exactly like a local shell with a different program to run, and
 * rides the same IPC a local shell already uses rather than a new one.
 */
function execSpec(spec = {}) {
  const { bin, baseArgs, env } = kubectlArgsFor(spec);
  const args = [...baseArgs, 'exec', '-it', spec.podName];
  if (spec.containerName) args.push('-c', spec.containerName);
  args.push('--', spec.shell || '/bin/sh');
  return { command: bin, args, env };
}

/**
 * `kubectl attach -i`, for a container whose own entrypoint is already the
 * process worth seeing (a REPL, a long-lived CLI) rather than a fresh shell
 * beside it — the one thing exec cannot do. Deliberately `-i`, not `-it`:
 * `-t` asks kubectl to allocate a TTY, which it flatly refuses on a
 * container that was not itself started with one ("did not allocate
 * one") — `-i` alone streams stdout/stderr and passes stdin through
 * either way, interactive or not, which is what every container can
 * actually honour.
 */
function attachSpec(spec = {}) {
  const { bin, baseArgs, env } = kubectlArgsFor(spec);
  const args = [...baseArgs, 'attach', spec.podName];
  if (spec.containerName) args.push('-c', spec.containerName);
  args.push('-i');
  return { command: bin, args, env };
}

/**
 * `kubectl debug -it --image=... --target=...`, an ephemeral debug
 * container dropped beside an already-running one — for a pod built
 * without a shell, or whose own image has nothing worth execing into, the
 * gap a plain exec session cannot close at all.
 */
function debugSpec(spec = {}) {
  if (!spec.podName) throw new Error('No pod to debug.');
  if (!spec.image) throw new Error('No debug image given.');
  const { bin, baseArgs, env } = kubectlArgsFor(spec);
  const args = [...baseArgs, 'debug', '-it', spec.podName, '--image=' + spec.image];
  if (spec.containerName) args.push('--target=' + spec.containerName);
  args.push('--', spec.shell || '/bin/sh');
  return { command: bin, args, env };
}

/**
 * `kubectl debug node/NAME -it --image=...` — a privileged debug pod
 * scheduled onto the node itself, its root filesystem mounted at /host
 * (kubectl's own default, not something layered on top here). The gap
 * every comparable tool treats as table stakes and nothing in KubeLife
 * could reach at all: a node has no "exec" the way a pod does.
 */
function nodeDebugSpec(spec = {}) {
  if (!spec.nodeName) throw new Error('No node to debug.');
  if (!spec.image) throw new Error('No debug image given.');
  const { bin, baseArgs, env } = kubectlArgsFor(spec);
  const args = [...baseArgs, 'debug', 'node/' + spec.nodeName, '-it', '--image=' + spec.image, '--', spec.shell || '/bin/sh'];
  return { command: bin, args, env };
}

/**
 * The argv for `kubectl logs`, shared by logSpec() below (a PTY pane) and
 * kubelogs.js (a plain spawned process feeding a searchable log viewer) —
 * one place building it so the two can't quietly drift apart.
 *
 * Exactly one of `podName`/`selector` is expected: a single pod's logs, or
 * — kubectl's own multi-pod tailing, no extra binary required — every pod
 * matching a label selector, each line prefixed with its pod/container so
 * several pods read as one stream (`kubectl logs`'s own `-l`/`--prefix`,
 * supported since kubectl ~1.14).
 */
function logArgs(spec = {}, { follow = true, previous = false, tail = 200, allContainers = false } = {}) {
  if (!spec.podName && !spec.selector) throw new Error('No pod or label selector to read logs from.');
  if (spec.podName && spec.selector) throw new Error('A pod name and a label selector cannot both be given.');
  const { bin, baseArgs, env } = kubectlArgsFor(spec);
  const args = [...baseArgs, 'logs'];
  if (spec.selector) {
    args.push('-l', spec.selector, '--all-containers=true', '--prefix');
  } else {
    args.push(spec.podName);
    if (spec.containerName) args.push('-c', spec.containerName);
    if (allContainers) args.push('--all-containers=true', '--prefix');
  }
  if (follow) args.push('-f');
  if (previous) args.push('-p');
  if (tail !== null && tail !== undefined) args.push('--tail=' + tail);
  // Timestamps are the one thing worth turning on unconditionally: a log
  // with no clock in it is hard to correlate with anything else, and
  // kubectl does not print one by default.
  args.push('--timestamps');
  return { bin, args, env };
}

/**
 * `kubectl logs`, shaped exactly like execSpec() above — a program with a
 * PTY, not a shell, opened the same way a pod exec session already is
 * (openLocalShell/splitActivePane, see kubepanel.js's openPodLogs). The one
 * capability KubeLife was missing that every comparable tool treats as
 * table stakes: a container that has already crashed can still be read,
 * where an exec session into it cannot.
 */
function logSpec(spec = {}, opts = {}) {
  const { bin, args, env } = logArgs(spec, opts);
  return { command: bin, args, env };
}

function runBin(bin, args, { env, timeout = 60000, stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, env },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err }));
    // `-f -`: values arrive on stdin. A child that never started leaves
    // nothing reading it; the callback above already says so.
    if (stdin !== null) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
  });
}

/**
 * Helm's own `--kube-context`, not kubectl's `--context=` — found live,
 * against a real cluster, the hard way — derived from the same
 * kubectlArgsFor() every kubectl caller already uses, so every Helm caller
 * (installTeleportAgent below, kubehelm.js) shares one translation rather
 * than each re-deriving it.
 */
/** One argv word, quoted for a POSIX shell only where it has to be — so the preview reads like a command someone would type. */
function shellQuote(word) {
  const w = String(word);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

/**
 * The commands an install is about to run, as text to read and copy: the
 * same argv the app passes to execFile, quoted, with the KUBECONFIG it runs
 * under spelled out (only when it is not the default the user's own shell
 * already has). `stdin`, when given, is fed through a quoted heredoc, the
 * way `-f -` reads it.
 */
function commandPreview(steps, env = {}) {
  const prefix = env.KUBECONFIG ? `KUBECONFIG=${shellQuote(env.KUBECONFIG)} ` : '';
  return steps.map(({ args, stdin }) => {
    const cmd = prefix + ['helm', ...args].map(shellQuote).join(' ');
    return stdin ? `${cmd} <<'VALUES'\n${String(stdin).replace(/\n?$/, '\n')}VALUES` : cmd;
  }).join('\n');
}

function helmArgsFor(spec = {}) {
  const { env, baseArgs } = kubectlArgsFor(spec);
  const contextArgs = baseArgs
    .filter((a) => a.startsWith('--context='))
    .map((a) => '--kube-context=' + a.slice('--context='.length));
  return { env, contextArgs };
}

/**
 * `teleport-kube-agent` via Helm — Teleport's own documented way to put an
 * existing cluster behind Teleport (see
 * goteleport.com/docs/enroll-resources/kubernetes-access/getting-started),
 * for a direct (non-Teleport) kubeconfig context a user wants brought under
 * Teleport properly rather than reached by a raw kubeconfig only this
 * machine has. The join token comes from teleport.js's createJoinToken()
 * (`type: 'kube'`) — generated just before this runs, not reused, since a
 * token is one-shot.
 */
/** The agent's services: kube always makes sense here; app and discovery find and publish what runs in the cluster. */
const AGENT_ROLES = ['kube', 'app', 'discovery'];

/**
 * The same install as a values.yaml, for someone keeping it in Git or
 * running helm themselves: everything the wizard would `--set`, as the
 * chart's own keys, with the command that uses it in a comment on top.
 * No token is minted for it — a join token is a secret and a change on the
 * cluster — so without one the key holds a placeholder and the comment says
 * how to make one.
 */
function teleportAgentValues({ proxy, token, clusterName, roles = ['kube'], labels = {}, releaseName = 'teleport-agent', namespace = 'teleport-agent', header = true, autoUpdate = true } = {}) {
  const yaml = require('js-yaml');
  const picked = AGENT_ROLES.filter((r) => (roles || []).includes(r));
  const values = {
    roles: picked.join(',') || 'kube',
    proxyAddr: proxy || '<proxy-address:443>',
    authToken: token || '<join-token>',
    kubeClusterName: clusterName || '<cluster-name>',
  };
  const cleanLabels = Object.fromEntries(Object.entries(labels || {}).filter(([k]) => k));
  if (Object.keys(cleanLabels).length) values.labels = cleanLabels;
  // The chart's own agent updater: keeps the agent on the version the
  // cluster's managed updates say, rather than wherever it was installed.
  // On unless turned off.
  if (autoUpdate) values.updater = { enabled: true };
  const body = yaml.dump(values, { lineWidth: -1 });
  if (!header) return body;
  const head = [
    '# teleport-kube-agent values — written by ServerLife',
    '#',
    '#   helm repo add teleport https://charts.releases.teleport.dev && helm repo update teleport',
    `#   helm install ${releaseName} teleport/teleport-kube-agent --create-namespace --namespace ${namespace} -f values.yaml`,
  ];
  if (!token) head.push('#', `# authToken is a placeholder. Make one (valid 1h) with:`, `#   tctl tokens add --type=${values.roles} --ttl=1h`);
  else head.push('#', '# authToken is a real join token: treat this file as a secret until it expires.');
  return head.join('\n') + '\n\n' + body;
}

// What Helm and Kubernetes accept as a release / namespace name (DNS-1123 label).
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

async function installTeleportAgent(spec = {}, {
  proxy, token, clusterName, dryRun = false, preview = false, roles = ['kube'], labels = {},
  releaseName = 'teleport-agent', namespace = 'teleport-agent', autoUpdate = true,
} = {}) {
  if (!proxy || !token || !clusterName) return { ok: false, error: 'Missing proxy, token or cluster name.' };
  if (!DNS_LABEL.test(releaseName || '')) return { ok: false, error: `"${releaseName}" is not a valid release name — lowercase letters, digits and "-", up to 63.` };
  if (!DNS_LABEL.test(namespace || '')) return { ok: false, error: `"${namespace}" is not a valid namespace — lowercase letters, digits and "-", up to 63.` };
  const picked = AGENT_ROLES.filter((r) => (roles || []).includes(r));
  if (!picked.length) return { ok: false, error: 'Pick at least one role.' };
  const { env, contextArgs } = helmArgsFor(spec);
  // Values as a YAML file fed on stdin (`-f -`), not a row of --set flags:
  // the same file "Export values.yaml" writes, so what is run, what is
  // shown and what is kept in Git are one thing. It also keeps the join
  // token out of the process list, and needs none of --set's escaping.
  const valuesYaml = teleportAgentValues({ proxy, token, clusterName, roles: picked, labels, header: false, autoUpdate });
  const installArgs = [
    'install', releaseName, 'teleport/teleport-kube-agent',
    // No --kubeconfig flag: unlike kubectl's, it takes one path, not a
    // merged list — `env`'s KUBECONFIG above is already the join, and helm
    // (client-go, same as kubectl) reads and merges it the same way.
    ...contextArgs,
    '--create-namespace', '--namespace', namespace,
    '-f', '-',
    ...(dryRun ? ['--dry-run'] : []),
  ];
  // Shown before anything runs, and copyable — helm or not on this machine,
  // the person can run it themselves.
  if (preview) {
    return {
      ok: true,
      command: commandPreview([
        { args: ['repo', 'add', 'teleport', 'https://charts.releases.teleport.dev'] },
        { args: ['repo', 'update', 'teleport'] },
        { args: installArgs, stdin: valuesYaml },
      ], env),
    };
  }
  if (!kubebin.toolAvailable('helm')) {
    return { ok: false, error: 'helm was not found on this machine. Install it first (e.g. "brew install helm"), then try again.' };
  }
  const helm = kubebin.findTool('helm');

  // Idempotent: a repo already added just answers "already exists," which
  // is not a failure here.
  const addRepo = await runBin(helm, ['repo', 'add', 'teleport', 'https://charts.releases.teleport.dev'], { env, timeout: 20000 });
  if (!addRepo.ok && !/already exists/i.test(addRepo.stderr)) {
    return { ok: false, error: plain(addRepo.stderr) || 'helm repo add failed' };
  }
  await runBin(helm, ['repo', 'update', 'teleport'], { env, timeout: 30000 });

  const r = await runBin(helm, installArgs, { env, timeout: 90000, stdin: valuesYaml });
  return r.ok ? { ok: true, output: plain(r.stdout) } : { ok: false, error: plain(r.stderr) || 'helm install failed' };
}

/** `tsh kube login <cluster>`: writes the per-cluster kubeconfig kubectlArgsFor() points at. */
async function loginKubeCluster({ proxy, home, cluster } = {}) {
  const r = await run(argsFor('login', [cluster], { proxy }), { home, timeout: 60000 });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || plain(r.stdout) || 'tsh kube login failed' };
  return { ok: true };
}

module.exports = {
  supported, listKubeClusters, kubectlArgsFor, loginKubeCluster, toKubeCluster,
  defaultKubeconfigPaths, listContexts, teleportOriginOf, useContext, deleteContext, editContext,
  listNamespaces, listPods, execSpec, attachSpec, debugSpec, nodeDebugSpec, logArgs, logSpec, kubeconfigEnvFor, installTeleportAgent, commandPreview, shellQuote, AGENT_ROLES, teleportAgentValues, helmArgsFor,
};
