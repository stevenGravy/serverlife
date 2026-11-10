import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kube.js'));
const H = require_(path.join(__PROJECT_ROOT__, 'src/main/kubehelm.js'));

/** The command a Helm install shows before running — what someone copies to run by hand. Preview never runs helm. */
const spec = { kubeconfigPaths: ['/tmp/a config'], contextName: 'minikube' };

test('agent preview: repo add, update, then the install with its values as YAML on stdin, not --set', async () => {
  const r = await K.installTeleportAgent(spec, {
    proxy: 'teleport.example.com:443', token: '<join-token>', clusterName: 'minikube', preview: true,
    roles: ['discovery', 'kube', 'app'], labels: { env: 'dev', 'team.example.com/owner': 'se,ops' },
  });
  const lines = r.command.split('\n');
  assert.equal(lines[0], "KUBECONFIG='/tmp/a config' helm repo add teleport https://charts.releases.teleport.dev");
  assert.equal(lines[1], "KUBECONFIG='/tmp/a config' helm repo update teleport");
  assert.equal(lines[2], "KUBECONFIG='/tmp/a config' helm install teleport-agent teleport/teleport-kube-agent --kube-context=minikube --create-namespace --namespace teleport-agent -f - <<'VALUES'");
  assert.ok(!r.command.includes('--set'), 'nothing is passed as --set');
  assert.deepEqual(lines.slice(3), [
    'roles: kube,app,discovery',
    'proxyAddr: teleport.example.com:443',
    'authToken: <join-token>',
    'kubeClusterName: minikube',
    'labels:',
    '  env: dev',
    '  team.example.com/owner: se,ops',
    'updater:',
    '  enabled: true',
    'VALUES',
  ]);
});

test('the values.yaml export is the same values, with the command and the token note on top', () => {
  const opts = { proxy: 'p:443', clusterName: 'c', roles: ['kube', 'app'], labels: { env: 'dev' }, namespace: 'tp' };
  const file = K.teleportAgentValues(opts);
  assert.ok(file.endsWith(K.teleportAgentValues({ ...opts, header: false })));
  assert.match(file, /helm install teleport-agent teleport\/teleport-kube-agent --create-namespace --namespace tp -f values\.yaml/);
  assert.match(file, /tctl tokens add --type=kube,app --ttl=1h/);
  assert.match(K.teleportAgentValues({ ...opts, token: 'abc' }), /treat this file as a secret/);
  // Automatic agent updates are on unless asked off.
  assert.match(file, /\nupdater:\n {2}enabled: true\n/);
  assert.ok(!/updater/.test(K.teleportAgentValues({ ...opts, autoUpdate: false })));
});

test('agent preview refuses no roles at all, and an unknown role is dropped', async () => {
  const none = await K.installTeleportAgent(spec, { proxy: 'p', token: 't', clusterName: 'c', preview: true, roles: [] });
  assert.equal(none.ok, false);
  const odd = await K.installTeleportAgent(spec, { proxy: 'p', token: 't', clusterName: 'c', preview: true, roles: ['kube', 'db'] });
  assert.match(odd.command, /\nroles: kube\n/);
});

test('release preview: values go in through a quoted heredoc, names with spaces are quoted', async () => {
  const r = await H.install(spec, {
    release: 'my web', namespace: 'apps', chartRef: 'bitnami/nginx', createNamespace: true, preview: true,
    valuesYaml: "replicaCount: 2\nname: it's $HOME\n", repo: { name: 'bitnami', url: 'https://charts.bitnami.com/bitnami' },
  });
  const lines = r.command.split('\n');
  assert.match(lines[0], /helm --kube-context=minikube repo add bitnami https:\/\/charts\.bitnami\.com\/bitnami$/);
  assert.match(lines[2], /helm --kube-context=minikube install 'my web' bitnami\/nginx -n apps --create-namespace -f - <<'VALUES'$/);
  assert.deepEqual(lines.slice(3), ['replicaCount: 2', "name: it's $HOME", 'VALUES']);
});

test('shellQuote leaves plain words alone and survives a single quote', () => {
  assert.equal(K.shellQuote('--namespace'), '--namespace');
  assert.equal(K.shellQuote("it's"), "'it'\\''s'");
});

test('splitChart: helm list’s "name-version" back into the chart to search for and the version it is on', () => {
  assert.deepEqual(H.splitChart('teleport-kube-agent-18.11.8'), { name: 'teleport-kube-agent', version: '18.11.8' });
  assert.deepEqual(H.splitChart('nginx-15.1.0-rc.1'), { name: 'nginx', version: '15.1.0-rc.1' });
  assert.deepEqual(H.splitChart('my-chart-v2.0.0'), { name: 'my-chart', version: 'v2.0.0' });
  assert.deepEqual(H.splitChart('noversion'), { name: 'noversion', version: '' });
});

test('upgrade preview: --version and --reset-values, values on stdin; a "null" values answer sends none', async () => {
  const r = await H.upgrade(spec, { release: 'web', namespace: 'apps', chartRef: 'bitnami/nginx', version: '15.2.0', valuesYaml: 'replicaCount: 3\n', dryRun: true, preview: true });
  assert.match(r.command, /helm --kube-context=minikube upgrade web bitnami\/nginx -n apps --version 15\.2\.0 --reset-values --dry-run -f - <<'VALUES'\nreplicaCount: 3\nVALUES$/);
  const none = await H.upgrade(spec, { release: 'web', namespace: 'apps', chartRef: 'bitnami/nginx', valuesYaml: 'null\n', preview: true });
  assert.ok(!none.command.includes('-f -'));
});
