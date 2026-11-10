'use strict';
/**
 * "Does this Role actually work?" — for a ServiceAccount subject, tested
 * from inside the cluster, as that ServiceAccount, with no Teleport
 * involved in the test request at all: a short-lived pod asks
 * `SelfSubjectAccessReview` against `kubernetes.default.svc` using its
 * own mounted token. A live, real answer — not `--as` impersonation,
 * which (confirmed against a real cluster while building this) needs the
 * *Teleport* role to separately permit impersonating that identity, a
 * gate independent of Kubernetes RBAC and not something to rely on as a
 * default test path. `nicolaka/netshoot` — the same default debug image
 * the ephemeral-debug-container feature already uses — has `curl`, so
 * nothing extra is required inside the pod, not even `kubectl`.
 */

const { execFile } = require('child_process');
const kube = require('./kube');

function run(bin, args, { env, timeout = 20000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer, env },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

function runWithStdin(bin, args, input, { env, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout, env },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    child.stdin.on('error', () => {});
    child.stdin.write(input == null ? '' : input);
    child.stdin.end();
  });
}

function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

/** A POSIX single-quoted shell literal, safe for any content (verb/resource/namespace are expected to be plain identifiers, but this holds even if they are not). */
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * The pod's own script — one `curl` per check, each preceded by a
 * `CHECK verb resource` marker line so the raw JSON responses (which
 * carry no identifying information of their own) can be matched back up.
 */
function buildSelfCheckScript(checks) {
  const lines = (checks || []).map(({ verb, resource, namespace }) => {
    const body = JSON.stringify({
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectAccessReview',
      spec: { resourceAttributes: { verb, resource, namespace: namespace || '' } },
    });
    return [
      `echo ${shQuote('CHECK ' + verb + ' ' + resource)}`,
      `curl -sk --cacert "$CACERT" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" `
        + `-X POST "$API/apis/authorization.k8s.io/v1/selfsubjectaccessreviews" -d ${shQuote(body)}`,
      'echo',
    ].join('\n');
  });
  return [
    'TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)',
    'CACERT=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    'API=https://kubernetes.default.svc',
    ...lines,
  ].join('\n');
}

/** The script's own stdout back into one result per check — matches each CHECK marker to the "allowed" field in the response line(s) after it. */
function parseCheckResults(output, checks) {
  const results = (checks || []).map((c) => ({ verb: c.verb, resource: c.resource, allowed: null, error: null }));
  let current = null;
  for (const line of String(output || '').split('\n')) {
    const marker = line.match(/^CHECK (\S+) (\S+)$/);
    if (marker) {
      current = results.find((r) => r.allowed === null && r.verb === marker[1] && r.resource === marker[2]) || null;
      continue;
    }
    if (!current) continue;
    const allowedMatch = line.match(/"allowed"\s*:\s*(true|false)/);
    if (allowedMatch) { current.allowed = allowedMatch[1] === 'true'; continue; }
    const reasonMatch = line.match(/"message"\s*:\s*"([^"]*)"/);
    if (reasonMatch && current.allowed === null) current.error = reasonMatch[1];
  }
  return results;
}

/**
 * Runs the checks for real, as the given ServiceAccount, then always
 * deletes the pod — a timeout or a thrown error still cleans up, the
 * same discipline every other "spin up, use once, tear down" flow here
 * follows (kubeforward.js's own forwards, kubewatch.js's own watches).
 */
async function testServiceAccountAccess(spec = {}, { namespace, serviceAccountName, checks = [] } = {}) {
  if (!namespace || !serviceAccountName) return { ok: false, error: 'No ServiceAccount to test.' };
  if (!checks.length) return { ok: false, error: 'Nothing to check — this Role has no rules to sample.' };
  const { bin, baseArgs, env } = kube.kubectlArgsFor({ ...spec, namespace });
  const name = 'klife-rbac-test-' + Math.random().toString(36).slice(2, 10);
  const doc = {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'serverlife-rbac-test' } },
    spec: {
      serviceAccountName, restartPolicy: 'Never',
      containers: [{ name: 'test', image: 'nicolaka/netshoot:latest', command: ['/bin/sh', '-c', buildSelfCheckScript(checks)] }],
    },
  };
  const applyR = await runWithStdin(bin, [...baseArgs, 'apply', '-f', '-'], JSON.stringify(doc), { env, timeout: 20000 });
  if (!applyR.ok) return { ok: false, error: plain(applyR.stderr) || 'Could not create the test pod.' };

  try {
    const deadline = Date.now() + 30000;
    let phase = '';
    while (Date.now() < deadline) {
      const r = await run(bin, [...baseArgs, 'get', 'pod', name, '-o', 'jsonpath={.status.phase}'], { env, timeout: 5000 });
      phase = r.stdout.trim();
      if (phase === 'Succeeded' || phase === 'Failed') break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const logsR = await run(bin, [...baseArgs, 'logs', name], { env, timeout: 10000 });
    if (phase !== 'Succeeded' && phase !== 'Failed') {
      return { ok: false, error: `The test pod never finished (last seen: ${phase || 'not scheduled yet'}).`, output: logsR.stdout };
    }
    return { ok: true, phase, checks: parseCheckResults(logsR.stdout, checks), output: logsR.stdout };
  } finally {
    // Awaited, even with `--wait=false`: the pod's own termination can
    // happen in the background, but the delete request itself has to be
    // confirmed sent before this function hands back control — found by
    // testing against a real cluster, where a fire-and-forget version
    // could leave a stray pod if the caller moved on quickly.
    await run(bin, [...baseArgs, 'delete', 'pod', name, '--ignore-not-found', '--wait=false'], { env, timeout: 15000 }).catch(() => {});
  }
}

module.exports = { buildSelfCheckScript, parseCheckResults, testServiceAccountAccess };
